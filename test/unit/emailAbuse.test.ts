/**
 * What a stranger can make the switchboard's mail do.
 *
 * Four holes, all of them on the far side of the account: the switchboard's
 * suppressions, limits and checks were about accounts, and the sending door
 * that costs the most needs no account at all.
 *
 *   - the queue in front of SES had no end. A digest tick over a large board,
 *     or a burst at the sign-in door, put thousands of sends on a promise chain
 *     with a 1.1-second link: the last one waited an hour, every one of them
 *     held its whole closure the entire time, and the process ran out of memory
 *     long before SES ran out of quota;
 *   - a hard bounce or a complaint from an address with no account was logged
 *     and forgotten, so the same address was mailed again on the next attempt —
 *     and the bounce rate that decides whether the switchboard can send mail at
 *     all is counted per sending domain, not per account;
 *   - anything that could reach the event queue could name any address and any
 *     event, and have that address suppressed;
 *   - every limiter on the verification door was per IP, and a botnet is a
 *     thousand IPs of which none did anything wrong.
 *
 * WHAT IS PROVED HERE, with no database, no AWS and no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from '../../src/db.js';
import { isSnsCertUrl, verifySnsSignature } from '../../src/email/snsSignature.js';
import {
  ACCOUNTLESS_VERIFICATIONS_PER_HOUR,
  accountlessVerificationCeiling,
} from '../../src/abuseLimit.js';
import { verificationRateLimited, VERIFICATIONS_PER_DAY } from '../../src/counter/verification.js';
import { processSesEvent } from '../../src/workers/emailEventsWorker.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, '..', '..', 'src', p), 'utf8');

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('the queue in front of SES has an end', () => {
  it('counts what is waiting and refuses past the ceiling', () => {
    const src = read('email/send.ts');
    expect(src).toContain('export const SES_MAX_QUEUED = 200');
    // Counted on the way in and released when the turn comes, so the number is
    // of sends waiting rather than of sends ever made.
    expect(src).toContain('sesWaiting += 1');
    expect(src).toContain('sesWaiting -= 1');
    // Asked before anything is written down: a send that cannot be made must
    // not consume its dedupe key or leave a row saying it was tried.
    const fn = src.slice(src.indexOf('export async function sendEmail'));
    expect(fn.indexOf('sesWaiting >= SES_MAX_QUEUED')).toBeLessThan(fn.indexOf('recordSend('));
    // And the refusal says how many are waiting, so the log line is the
    // diagnosis rather than a puzzle.
    expect(src).toContain('sends waiting, ceiling');
  });

  it('gives callers one way to tell this refusal from any other', () => {
    const src = read('email/send.ts');
    expect(src).toContain('export class EmailQueueFull');
    expect(src).toContain('readonly queueFull = true');
    expect(src).toContain('export const isEmailQueueFull');
    // The code and sign-in doors turn it into a sentence; the best-effort
    // notifiers swallow it like any other send failure.
    const routes = read('counter/routes.ts');
    expect(routes).toContain('isEmailQueueFull(err)');
    expect(routes).toContain('Try again in a minute.');
  });
});

// ---------------------------------------------------------------------------
describe('the suppression list is about the address', () => {
  /** A pool that records every statement and answers the few that matter. */
  function pool(answers: (sql: string, params: any[]) => any[] = () => []) {
    const seen: { sql: string; params: any[] }[] = [];
    return {
      seen,
      pool: {
        query: async (sql: string, params: any[] = []) => {
          seen.push({ sql, params });
          const rows = answers(sql, params);
          return { rows, rowCount: rows.length };
        },
      } as any,
    };
  }

  const bounce = (email: string) =>
    JSON.stringify({
      eventType: 'Bounce',
      mail: { messageId: 'ses-1', destination: [email] },
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: email }] },
    });

  it('writes a row for an address with no account behind it', async () => {
    const { seen, pool: p } = pool((sql) => {
      if (/FROM email_sends WHERE ses_message_id/.test(sql)) return [{ '?column?': 1 }];
      return []; // no account answers to this address
    });
    vi.spyOn(db, 'getPool').mockReturnValue(p);
    const logged: string[] = [];
    await processSesEvent(bounce('nobody@example.test'), (m) => logged.push(m));
    const suppression = seen.find((s) => /INSERT INTO email_suppressions/.test(s.sql));
    expect(suppression).toBeTruthy();
    expect(suppression!.params[1]).toBe('bounce');
    // Never overwritten: the first thing that went wrong is the one on record.
    expect(suppression!.sql).toContain('ON CONFLICT (email_hash) DO NOTHING');
    // No addresses in the table, only the hash the rest of the schema uses.
    expect(String(suppression!.params[0])).not.toContain('@');
    expect(logged.join(' ')).toContain('no account');
  });

  it('writes one for a complaint too, and still marks the account when there is one', async () => {
    const { seen, pool: p } = pool((sql) => {
      if (/FROM email_sends WHERE ses_message_id/.test(sql)) return [{ '?column?': 1 }];
      if (/SELECT id FROM accounts WHERE email_hash/.test(sql)) return [{ id: 'acct-1' }];
      return [];
    });
    vi.spyOn(db, 'getPool').mockReturnValue(p);
    await processSesEvent(
      JSON.stringify({
        eventType: 'Complaint',
        mail: { messageId: 'ses-2', destination: ['someone@example.test'] },
        complaint: { complainedRecipients: [{ emailAddress: 'someone@example.test' }] },
      }),
      () => {},
    );
    expect(seen.some((s) => /INSERT INTO email_suppressions/.test(s.sql))).toBe(true);
    expect(seen.some((s) => /email_complaint_suppressed_at = now\(\)/.test(s.sql))).toBe(true);
  });

  it('is asked before the account gates, so an accountless send is suppressed too', () => {
    const src = read('email/send.ts');
    const fn = src.slice(src.indexOf('export async function sendEmail'));
    expect(fn.indexOf('FROM email_suppressions')).toBeGreaterThan(-1);
    expect(fn.indexOf('FROM email_suppressions')).toBeLessThan(fn.indexOf('if (input.accountId) {'));
    // Re-verification is the one send that still goes: it is the only way back
    // off the list.
    expect(fn).toContain("input.template !== 'verification'");
  });
});

// ---------------------------------------------------------------------------
describe('an event is about a message the switchboard sent', () => {
  function pool(ourMessage: boolean) {
    const seen: string[] = [];
    return {
      seen,
      pool: {
        query: async (sql: string) => {
          seen.push(sql);
          if (/FROM email_sends WHERE ses_message_id/.test(sql)) {
            return ourMessage ? { rows: [{ ok: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        },
      } as any,
    };
  }

  it('drops a bounce for a message id it never sent, with a warn', async () => {
    const { seen, pool: p } = pool(false);
    vi.spyOn(db, 'getPool').mockReturnValue(p);
    const logged: string[] = [];
    await processSesEvent(
      JSON.stringify({
        eventType: 'Bounce',
        mail: { messageId: 'not-ours', destination: ['victim@example.test'] },
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'victim@example.test' }] },
      }),
      (m) => logged.push(m),
    );
    expect(logged.join(' ')).toContain('did not send');
    // Nothing was written at all: not the event log, not the suppression.
    expect(seen.some((s) => /INSERT INTO email_suppressions/.test(s))).toBe(false);
    expect(seen.some((s) => /INSERT INTO email_events/.test(s))).toBe(false);
  });

  it('drops a complaint with no message id at all', async () => {
    const { seen, pool: p } = pool(true);
    vi.spyOn(db, 'getPool').mockReturnValue(p);
    const logged: string[] = [];
    await processSesEvent(
      JSON.stringify({
        eventType: 'Complaint',
        mail: { destination: ['victim@example.test'] },
        complaint: { complainedRecipients: [{ emailAddress: 'victim@example.test' }] },
      }),
      (m) => logged.push(m),
    );
    expect(logged.join(' ')).toContain('did not send');
    expect(seen.some((s) => /INSERT INTO email_suppressions/.test(s))).toBe(false);
  });

  it('leaves the events that change nothing exactly as they were', async () => {
    const { seen, pool: p } = pool(false);
    vi.spyOn(db, 'getPool').mockReturnValue(p);
    await processSesEvent(
      JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'x', destination: ['a@b.test'] } }),
      () => {},
    );
    // A delivery suppresses nobody, so it is logged without the check.
    expect(seen.some((s) => /INSERT INTO email_events/.test(s))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('an SNS envelope is checked before it is believed', () => {
  it('takes a certificate only from an SNS host over https', () => {
    expect(isSnsCertUrl('https://sns.us-west-2.amazonaws.com/x.pem')).toBe(true);
    expect(isSnsCertUrl('https://sns.cn-north-1.amazonaws.com.cn/x.pem')).toBe(true);
    // The two shapes a careless pattern lets through.
    expect(isSnsCertUrl('https://sns.us-west-2.amazonaws.com.evil.test/x.pem')).toBe(false);
    expect(isSnsCertUrl('https://evil.test/sns.us-west-2.amazonaws.com/x.pem')).toBe(false);
    expect(isSnsCertUrl('http://sns.us-west-2.amazonaws.com/x.pem')).toBe(false);
    expect(isSnsCertUrl('https://s3.amazonaws.com/x.pem')).toBe(false);
    expect(isSnsCertUrl(undefined)).toBe(false);
  });

  it('refuses an envelope with no signature, or one pointing anywhere else', async () => {
    expect(await verifySnsSignature({ Type: 'Notification', Message: '{}' })).toBe(false);
    expect(
      await verifySnsSignature({
        Type: 'Notification',
        Message: '{}',
        Signature: 'AAAA',
        SigningCertURL: 'https://evil.test/x.pem',
      }),
    ).toBe(false);
    // And an unknown message type has no canonical form, so it verifies as
    // nothing rather than as anything.
    expect(
      await verifySnsSignature({
        Type: 'SomethingElse',
        Signature: 'AAAA',
        SigningCertURL: 'https://sns.us-west-2.amazonaws.com/x.pem',
      }),
    ).toBe(false);
  });

  it('drops an unwrapped envelope the worker cannot verify', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async () => ({ rows: [], rowCount: 0 }),
    } as any);
    const logged: string[] = [];
    await processSesEvent(
      JSON.stringify({
        Type: 'Notification',
        MessageId: 'sns-1',
        Message: JSON.stringify({
          eventType: 'Bounce',
          mail: { messageId: 'ses-1', destination: ['victim@example.test'] },
          bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'victim@example.test' }] },
        }),
        Signature: 'not-a-signature',
        SigningCertURL: 'https://evil.test/x.pem',
      }),
      (m) => logged.push(m),
    );
    expect(logged.join(' ')).toContain('signature did not check out');
  });
});

// ---------------------------------------------------------------------------
describe('the ceilings over the verification door', () => {
  it('caps accountless sends across the whole process, not per connection', () => {
    expect(ACCOUNTLESS_VERIFICATIONS_PER_HOUR).toBe(200);
    // It takes no argument, which is the point: it cannot be keyed on anything
    // a caller controls.
    let refusedAt = 0;
    for (let i = 1; i <= ACCOUNTLESS_VERIFICATIONS_PER_HOUR + 5; i++) {
      if (accountlessVerificationCeiling.limited()) {
        refusedAt = i;
        break;
      }
    }
    expect(refusedAt).toBe(ACCOUNTLESS_VERIFICATIONS_PER_HOUR + 1);
  });

  it('says the same non-enumerating thing on both doors', () => {
    const routes = read('counter/routes.ts');
    expect([...routes.matchAll(/Too many codes requested just now\. Try again in a minute\./g)])
      .toHaveLength(2);
    // Both doors log the depth beside the refusal.
    expect([...routes.matchAll(/accountless verification ceiling hit/g)]).toHaveLength(2);
  });

  it('caps one address at three in a quarter hour and ten in a day', async () => {
    expect(VERIFICATIONS_PER_DAY).toBe(10);
    const counts: { recent: number; day: number }[] = [
      { recent: 0, day: 0 },
      { recent: 3, day: 3 },
      { recent: 1, day: 10 },
      { recent: 2, day: 9 },
    ];
    let next = 0;
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async () => ({ rows: [counts[next++]], rowCount: 1 }),
    } as any);
    expect(await verificationRateLimited('a@b.test')).toBe(false); // nothing yet
    expect(await verificationRateLimited('a@b.test')).toBe(true); // the short window
    expect(await verificationRateLimited('a@b.test')).toBe(true); // the day
    expect(await verificationRateLimited('a@b.test')).toBe(false); // inside both
  });

  it('counts both windows in one statement over one address', () => {
    const src = read('counter/verification.ts');
    const fn = src.slice(src.indexOf('export async function verificationRateLimited'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain("interval '15 minutes'");
    expect(body).toContain("interval '24 hours'");
    // One address, and it is the hash that names it.
    expect(body).toContain('emailHash(email)');
  });
});
