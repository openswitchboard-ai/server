/**
 * 0.E integration gates against LIVE dev:
 *  (b) frequency matrix — daily tick sends nothing to a weekly account, the
 *      weekly tick delivers, 'off' delivers nothing, transactional still
 *      sends;
 *  (c) bounce path — bounce@simulator.amazonses.com => unreachable flag +
 *      counter banner; complaint@simulator.amazonses.com => complaint
 *      suppression withholds bulk mail;
 *  (d) idempotency — a duplicated digest tick produces exactly one send;
 *  (e) renewal — a card expiring inside 7 days triggers the renewal email,
 *      and the renew-all link extends every open card with a WORM
 *      consent-log entry.
 *
 * Sends go to SES mailbox-simulator addresses (verified in the sandbox), so
 * every send is REAL and lands/bounces/complains for real. Evidence is read
 * from the send log, the accounts table, email_events and the consent-log
 * bucket via the dev observability path (RDS Data API / S3).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  COUNTER_URL,
  ENV_NAME,
  Jar,
  counterFetch,
  counterLogin,
  dbExec,
  ensurePin,
  poll,
  sendOp,
  sha256hex,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

const region = process.env.AWS_REGION ?? 'us-east-1';
const secrets = new SecretsManagerClient({ region });
const s3 = new S3Client({ region });
const CONSENT_BUCKET = `osb-${ENV_NAME}-consent-log-173291123487`;

const runId = randomBytes(4).toString('hex');
const CATEGORY = `intg-email.${runId}`;
const GEO = JSON.stringify({ bucket: `intg-email-${runId}` });

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

const simEmail = (tag: string) => `success+0e-${tag}-${runId}@simulator.amazonses.com`;

async function createAccount(email: string): Promise<string> {
  const salt = randomBytes(16);
  await sendOp({
    op: 'create-account',
    email,
    first_name: 'Test',
    locality: 'Sydney',
    login_code_hash: `scrypt$${salt.toString('hex')}$${'00'.repeat(32)}`,
  });
  return poll(async () => {
    const rows = await dbExec('SELECT id FROM accounts WHERE email_hash = :h', [
      { name: 'h', value: sha256hex(email.trim().toLowerCase()) },
    ]);
    return rows[0]?.[0] as string | undefined;
  }, `account ${email}`);
}

async function insertCard(
  accountId: string,
  type: 'WANT' | 'HAVE',
  expiresDays = 60,
  attributes: Record<string, unknown> = {},
): Promise<string> {
  const rows = await dbExec(
    `INSERT INTO cards (account_id, schema_version, type, category, geo, attributes,
                        urgency, lifecycle_state, ttl_days, expires_at)
     VALUES (:a::uuid, '0.1', :t, :c, :g::jsonb, :attrs::jsonb, 'none', 'PUBLISHED', 60,
             now() + make_interval(days => :d::int))
     RETURNING id`,
    [
      { name: 'a', value: accountId },
      { name: 't', value: type },
      { name: 'c', value: CATEGORY },
      { name: 'g', value: GEO },
      { name: 'attrs', value: JSON.stringify(attributes) },
      { name: 'd', value: expiresDays },
    ],
  );
  return rows[0][0] as string;
}

async function insertNearMiss(cardWant: string, cardHave: string): Promise<void> {
  await dbExec(
    `INSERT INTO near_misses (card_want, card_have, score, category)
     VALUES (:w::uuid, :h::uuid, 0.7, :c) ON CONFLICT DO NOTHING`,
    [
      { name: 'w', value: cardWant },
      { name: 'h', value: cardHave },
      { name: 'c', value: CATEGORY },
    ],
  );
}

async function sendsFor(accountId: string, template: string): Promise<any[][]> {
  return dbExec(
    `SELECT dedupe_key, status, ses_message_id FROM email_sends
     WHERE account_id = :a::uuid AND template = :t ORDER BY created_at`,
    [
      { name: 'a', value: accountId },
      { name: 't', value: template },
    ],
  );
}

d('0.E email daemon (live dev)', () => {
  // A: the matrix account (weekly -> off). B: partner cards. E: daily sentinel.
  let accountA: string, accountB: string, accountE: string;
  let emailA: string;
  let wantA1: string, wantA2: string, haveB: string, wantE: string;
  const jarA = new Jar();

  beforeAll(async () => {
    emailA = simEmail('a');
    [accountA, accountB, accountE] = await Promise.all([
      createAccount(emailA),
      createAccount(simEmail('b')),
      createAccount(simEmail('e')),
    ]);
    [wantA1, wantA2, haveB, wantE] = await Promise.all([
      insertCard(accountA, 'WANT'),
      insertCard(accountA, 'WANT'),
      insertCard(accountB, 'HAVE'),
      insertCard(accountE, 'WANT'),
    ]);
    await counterLogin(jarA, emailA);
  }, 180_000);

  it('(b) frequency controls save through the counter and log consent', async () => {
    const res = await counterFetch(jarA, '/settings/frequency',
      form({ freq_matches: 'off', freq_digests: 'weekly' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Saved. Effective immediately.');
    const row = await dbExec(
      `SELECT email_freq_matches, email_freq_digests FROM accounts WHERE id = :a::uuid`,
      [{ name: 'a', value: accountA }],
    );
    expect(row[0]).toEqual(['off', 'weekly']);
    // E becomes the daily sentinel; B stays on the weekly default.
    await dbExec(`UPDATE accounts SET email_freq_digests = 'daily' WHERE id = :a::uuid`, [
      { name: 'a', value: accountE },
    ]);
  });

  it('(b)+(d) frequency matrix + duplicated digest tick -> one send', async () => {
    // Real activity for A (weekly), B (weekly) and E (daily).
    await insertNearMiss(wantA1, haveB);
    await insertNearMiss(wantE, haveB);

    // Daily tick: only the daily account gets a digest.
    await sendOp({ op: 'email-digest-tick', cadence: 'daily' });
    await poll(async () => {
      const rows = await sendsFor(accountE, 'digest');
      return rows.length ? rows : undefined;
    }, 'daily digest for E');
    expect((await sendsFor(accountA, 'digest')).length).toBe(0);
    expect((await sendsFor(accountB, 'digest')).length).toBe(0);

    // Weekly tick, sent TWICE (the forced duplicate job): exactly one send.
    await sendOp({ op: 'email-digest-tick', cadence: 'weekly' });
    await sendOp({ op: 'email-digest-tick', cadence: 'weekly' });
    const rowsA = await poll(async () => {
      const rows = await sendsFor(accountA, 'digest');
      // Wait past the in-flight 'sending' marker so the status assert below
      // reads the terminal outcome.
      return rows.length && rows[0][1] !== 'sending' && rows[0][1] !== 'failed' ? rows : undefined;
    }, 'weekly digest for A');
    expect(rowsA.length).toBe(1);
    expect(String(rowsA[0][0])).toContain('digest:weekly:');
    expect(rowsA[0][1]).toBe('sent'); // simulator address: SES accepted it
    await new Promise((r) => setTimeout(r, 10_000)); // let the duplicate tick drain
    expect((await sendsFor(accountA, 'digest')).length).toBe(1);
    expect((await sendsFor(accountB, 'digest')).length).toBe(1);
  }, 180_000);

  it("(b) 'off' delivers nothing; transactional still sends", async () => {
    const res = await counterFetch(jarA, '/settings/frequency',
      form({ freq_matches: 'off', freq_digests: 'off' }));
    expect(res.status).toBe(200);
    // Fresh real activity for A, plus a FRESH daily sentinel account (E's
    // daily period key is already spent — one digest per day is by design).
    await insertNearMiss(wantA2, haveB);
    const accountS = await createAccount(simEmail('s'));
    await dbExec(`UPDATE accounts SET email_freq_digests = 'daily' WHERE id = :a::uuid`, [
      { name: 'a', value: accountS },
    ]);
    const wantS = await insertCard(accountS, 'WANT');
    await insertNearMiss(wantS, haveB);
    await sendOp({ op: 'email-digest-tick', cadence: 'daily' });
    await sendOp({ op: 'email-digest-tick', cadence: 'weekly' });
    await poll(async () => {
      const rows = await sendsFor(accountS, 'digest');
      return rows.length ? rows : undefined; // sentinel: ticks drained
    }, 'daily digest for sentinel S');
    expect((await sendsFor(accountA, 'digest')).length).toBe(1); // still just the weekly one

    // Transactional verification sends regardless of 'off'.
    const before = (await sendsFor(accountA, 'verification')).length;
    const login = await counterFetch(new Jar(), '/login', form({ email: emailA }));
    expect(login.status).toBe(200);
    const vRows = await poll(async () => {
      const rows = await sendsFor(accountA, 'verification');
      // Wait for the new row AND its terminal status (not in-flight 'sending').
      return rows.length > before && rows[rows.length - 1][1] === 'sent' ? rows : undefined;
    }, 'verification send for A');
    expect(vRows[vRows.length - 1][1]).toBe('sent');
  }, 180_000);

  it('(c) hard bounce -> unreachable flag + counter banner, inside 2 minutes', async () => {
    const email = `bounce@simulator.amazonses.com`;
    const accountId = await createAccount(email);
    // The simulator account persists across runs: clear any stale flag so
    // this run proves fresh detection.
    await dbExec(`UPDATE accounts SET email_unreachable_at = NULL WHERE id = :a::uuid`, [
      { name: 'a', value: accountId },
    ]);
    // A real transactional send to the bouncing address.
    const res = await counterFetch(new Jar(), '/login', form({ email }));
    expect(res.status).toBe(200);
    const sentAt = Date.now();
    await poll(
      async () => {
        const rows = await dbExec(
          `SELECT email_unreachable_at FROM accounts WHERE id = :a::uuid`,
          [{ name: 'a', value: accountId }],
        );
        return rows[0]?.[0] ? rows : undefined;
      },
      'unreachable flag after simulator bounce',
      150_000,
      3_000,
    );
    expect(Date.now() - sentAt).toBeLessThan(150_000);
    const events = await dbExec(
      `SELECT id FROM email_events WHERE account_id = :a::uuid AND event_type = 'bounce'`,
      [{ name: 'a', value: accountId }],
    );
    expect(events.length).toBeGreaterThan(0);
    // Counter banner (verification mail stays allowed, so login still works).
    const jar = new Jar();
    await counterLogin(jar, email);
    await ensurePin(jar);
    const dash = await counterFetch(jar, '/');
    expect(dash.status).toBe(200);
    expect(await dash.text()).toContain('Email to you is bouncing');
  }, 300_000);

  it('(c) complaint -> all non-transactional mail suppressed until re-enabled', async () => {
    const email = `complaint@simulator.amazonses.com`;
    const accountId = await createAccount(email);
    await dbExec(
      `UPDATE accounts SET email_complaint_suppressed_at = NULL WHERE id = :a::uuid`,
      [{ name: 'a', value: accountId }],
    );
    const res = await counterFetch(new Jar(), '/login', form({ email }));
    expect(res.status).toBe(200);
    await poll(
      async () => {
        const rows = await dbExec(
          `SELECT email_complaint_suppressed_at FROM accounts WHERE id = :a::uuid`,
          [{ name: 'a', value: accountId }],
        );
        return rows[0]?.[0] ? rows : undefined;
      },
      'complaint suppression flag',
      150_000,
      3_000,
    );
    // Bulk mail for this account is now withheld: give it daily digests plus
    // real activity, tick, and watch the send log record the suppression.
    await dbExec(`UPDATE accounts SET email_freq_digests = 'daily' WHERE id = :a::uuid`, [
      { name: 'a', value: accountId },
    ]);
    const want = await insertCard(accountId, 'WANT');
    await insertNearMiss(want, haveB);
    await sendOp({ op: 'email-digest-tick', cadence: 'daily' });
    const rows = await poll(async () => {
      const r = await sendsFor(accountId, 'digest');
      return r.length ? r : undefined;
    }, 'suppressed digest row');
    expect(rows[0][1]).toBe('suppressed');
  }, 300_000);

  it('(e) renewal: expiring card -> renewal email; renew-all extends with consent', async () => {
    const email = simEmail('g');
    const accountId = await createAccount(email);
    const cardId = await insertCard(accountId, 'HAVE', 3, { colour: `teal-${runId}` }); // lapses in 3 days
    await sendOp({ op: 'email-renewal-tick' });
    // Poll until the send-log row reaches a TERMINAL success ('sending' is
    // the in-flight pre-SES marker; 'failed' is terminal for the attempt but
    // reclaimed and retried on redelivery, so keep waiting through it).
    const rows = await poll(async () => {
      const r = await sendsFor(accountId, 'renewal');
      return r.length && r[0][1] !== 'sending' && r[0][1] !== 'failed' ? r : undefined;
    }, 'renewal email send (terminal status)');
    expect(rows[0][1]).toBe('sent');
    const stamped = await dbExec(
      `SELECT renewal_notified_at FROM cards WHERE id = :c::uuid`,
      [{ name: 'c', value: cardId }],
    );
    expect(stamped[0][0]).toBeTruthy();

    // Sign the renew-all token exactly as the daemon does (dev observability:
    // the counter keys secret is readable by the harness).
    const sec = await secrets.send(
      // The counter keys secret (core-stack.ts): osb/<env>/counter/keys.
      new GetSecretValueCommand({ SecretId: `osb/${ENV_NAME}/counter/keys` }),
    );
    const key = Buffer.from(JSON.parse(sec.SecretString!).link_hmac_key, 'hex');
    const payload = `${accountId}|renew-all|${Math.floor(Date.now() / 1000) + 3600}`;
    const token = `osb_em_${Buffer.from(payload).toString('base64url')}.${createHmac('sha256', key)
      .update(`email-token|${payload}`)
      .digest('base64url')}`;

    const page = await counterFetch(new Jar(), `/renew?t=${encodeURIComponent(token)}`);
    expect(page.status).toBe(200);
    // 0.H copy cull: the page shows the category's human leaf label (this
    // synthetic category is not in the taxonomy, so the leaf segment renders)
    // plus the card's own attributes as the distinguishing detail line —
    // and the raw slug appears nowhere.
    const renewHtml = await page.text();
    expect(renewHtml).toContain(runId); // leaf label of intg-email.<runId>
    expect(renewHtml).toContain(`colour: teal-${runId}`);
    expect(renewHtml).not.toContain(CATEGORY);
    const renew = await counterFetch(new Jar(), '/renew', form({ t: token }));
    expect(renew.status).toBe(200);
    expect(await renew.text()).toContain('renewed');

    const after = await dbExec(
      `SELECT (expires_at > now() + interval '50 days') FROM cards WHERE id = :c::uuid`,
      [{ name: 'c', value: cardId }],
    );
    expect(after[0][0]).toBe(true);

    // WORM consent-log entry (cards-renewed) for this account.
    const found = await poll(
      async () => {
        const today = new Date().toISOString().slice(0, 10);
        const list = await s3.send(
          new ListObjectsV2Command({
            Bucket: CONSENT_BUCKET,
            Prefix: `consent-events/${ENV_NAME}/${today}/`,
          }),
        );
        for (const obj of (list.Contents ?? []).slice(-50)) {
          const body = await s3.send(
            new GetObjectCommand({ Bucket: CONSENT_BUCKET, Key: obj.Key! }),
          );
          const j = JSON.parse(await body.Body!.transformToString());
          if (j.event === 'cards-renewed' && j.account_id === accountId) return obj.Key;
        }
        return undefined;
      },
      'cards-renewed consent event',
      60_000,
      5_000,
    );
    expect(found).toBeTruthy();
  }, 300_000);
});
