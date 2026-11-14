/**
 * THE SELLER IS TOLD, ONCE, THAT THE NUMBERS ARE READY (14 November 2026).
 *
 * When a best-offer window closes, the numbers go onto the seller's sweep, and
 * a seller whose assistant only wakes when spoken to had nobody telling them
 * to look. So the sweep that closes the window (domain/sequencer.ts,
 * closeDueGatherings) hands the ordinary notice a job on the ops queue, and
 * the notice (email/digestEngine.ts, notifyBestOfferClosed) sends the one
 * fixed notice email. The guard against sending it twice is held twice:
 *
 *  - the sweep's UPDATE stamps gather_closed_at and returns the card only to
 *    the sweep that stamped it, so a second sweep, or two at once, hand over
 *    no second job;
 *  - the mail's dedupe key is the card, so a job the queue redelivers, or a
 *    second job however it got there, finds the key spent.
 *
 * And it is the notice like any other: only to somebody who hears by email,
 * never to an account with match mail off, nothing at all when nobody put a
 * number in, and never a figure, a name or a count in it.
 *
 * The suite runs the real pipeline: the sweep enqueues, the job is handed to
 * notifyBestOfferClosed as the ops worker hands it, and the mail is whatever
 * sendEmail would have given SES.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v.toString('utf8').replace(/^enc:/, '')]),
    ),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

const sesSend = vi.fn(async (_cmd: any): Promise<any> => ({ MessageId: 'ses-1' }));
const sqsSend = vi.fn(async (_cmd: any): Promise<any> => ({}));
vi.mock('../../src/aws.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sesv2: { send: (cmd: any) => sesSend(cmd) },
  sqs: { send: (cmd: any) => sqsSend(cmd) },
}));

import * as db from '../../src/db.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { closeDueGatherings } from '../../src/domain/sequencer.js';
import { notifyBestOfferClosed } from '../../src/email/digestEngine.js';
import {
  NEWS_NOTICE_SUBJECT,
  NOTICE_TEMPLATES,
  renderBestOfferClosed,
} from '../../src/email/templates.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  sesFrom: 'switchboard@test',
  sesReplyTo: 'switchboard@test',
  sesConfigurationSet: 'cs',
  opsQueueUrl: 'https://sqs.test/ops',
} as unknown as Config;

const SELLER = 'cccccccc-3333-4333-8333-cccccccccccc';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const INTRO_1 = 'aaaaaaaa-1111-4111-8111-000000000001';
const INTRO_2 = 'aaaaaaaa-1111-4111-8111-000000000002';
const addressOf = (accountId: string) => `${accountId}@example.test`;

interface World {
  hearsVia: 'email' | 'assistant';
  freqMatches: string;
  blind: boolean;
  gatherUntil: Date | null;
  gatherClosedAt: Date | null;
  intros: { id: string; state: string; archived_via?: string }[];
  /** Numbers on the have's introductions, by state. */
  offers: { match_id: string; amount: string; state: string }[];
  /** email_sends, keyed as the table is: one row per dedupe key. */
  sends: Map<string, { template: string; status: string }>;
}
let world: World;

function fakePool() {
  const query = async (sql: string, params: any[] = []) => {
    const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
    // --- the send ledger: the INSERT is the lock, and a 'failed' row is
    //     reclaimed by the next attempt (email/send.ts, recordSend) ---
    if (/INSERT INTO email_sends/.test(sql)) {
      const had = world.sends.get(params[0]);
      if (had && had.status !== 'failed') return rows([]);
      world.sends.set(params[0], { template: params[3], status: params[6] });
      return rows([{ id: 'send' }]);
    }
    if (/UPDATE email_sends/.test(sql)) {
      const row = world.sends.get(params[0]);
      if (row) row.status = params[1];
      return rows([]);
    }
    if (/FROM email_suppressions/.test(sql)) return rows([]);
    if (/SELECT email_unreachable_at/.test(sql)) {
      return rows([{ email_unreachable_at: null, email_complaint_suppressed_at: null, status: 'active' }]);
    }
    if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: world.hearsVia }]);
    if (/SELECT blind_mode/.test(sql)) {
      return rows([
        {
          blind_mode: world.blind,
          email_freq_matches: world.freqMatches,
          email_freq_digests: 'weekly',
          email_unreachable_at: null,
          email_complaint_suppressed_at: null,
        },
      ]);
    }
    if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
      return rows([
        {
          id: params[0],
          status: 'active',
          data_key_enc: Buffer.from('wrapped'),
          email_enc: Buffer.from(`enc:${addressOf(params[0])}`),
        },
      ]);
    }
    // --- the close sweep: the stamp is the claim, one sweep wins it ---
    if (/UPDATE cards SET gather_closed_at = now\(\)/.test(sql)) {
      if (!world.gatherUntil || world.gatherUntil > new Date() || world.gatherClosedAt) return rows([]);
      world.gatherClosedAt = new Date();
      return rows([{ id: CARD_H }]);
    }
    // Whoever put no number in is filed away (the ending closes nothing: they
    // have no figure on the table).
    if (/archived_via = 'lapsed'/.test(sql) && /card_have = \$1/.test(sql)) {
      const gone = world.intros.filter(
        (i) => i.state === 'open' && !world.offers.some((o) => o.match_id === i.id && o.state !== 'withdrawn'),
      );
      for (const i of gone) {
        i.state = 'archived';
        i.archived_via = 'lapsed';
      }
      return rows(gone.map((i) => ({ id: i.id })));
    }
    // --- the count behind the notice (offers.ts, bestOfferNumbersIn) ---
    if (/SELECT c\.account_id AS seller/.test(sql)) {
      if (params[0] !== CARD_H || !world.gatherUntil || world.gatherUntil > new Date()) return rows([]);
      const numbers = world.offers.filter((o) =>
        ['proposed', 'awaiting-human', 'accepted-by-human'].includes(o.state),
      ).length;
      return rows([{ seller: SELLER, category: 'goods.bicycle.mountain', kind: 'mountain bike', numbers }]);
    }
    return rows([]);
  };
  return { query, connect: async () => ({ query, release: () => {} }) } as any;
}

beforeAll(async () => {
  // The pipeline paces SES at one send a second; here that would only make
  // the suite wait (as noticeGate.test.ts does).
  vi.stubGlobal('setTimeout', ((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
});

beforeEach(() => {
  world = {
    hearsVia: 'email',
    freqMatches: 'immediate',
    blind: false,
    gatherUntil: new Date(Date.now() - 1000),
    gatherClosedAt: null,
    intros: [
      { id: INTRO_1, state: 'open' },
      { id: INTRO_2, state: 'open' },
    ],
    offers: [{ match_id: INTRO_1, amount: '415', state: 'proposed' }],
    sends: new Map(),
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sesSend.mockClear();
  sqsSend.mockClear();
});

/** Every job on the ops queue, as the worker would read it. */
const jobs = () => sqsSend.mock.calls.map(([cmd]: any[]) => JSON.parse(cmd.input.MessageBody));

/** Hand each job to the notice exactly as workers/opsWorker.ts does. */
async function deliver() {
  for (const body of jobs()) {
    expect(body.op).toBe('best-offer-closed-notify');
    await notifyBestOfferClosed(cfg, String(body.card_id ?? ''));
  }
}

const mails = () =>
  sesSend.mock.calls.map(([cmd]: any[]) => ({
    to: cmd.input.Destination.ToAddresses[0] as string,
    subject: cmd.input.Content.Simple.Subject.Data as string,
    text: cmd.input.Content.Simple.Body.Text.Data as string,
    html: cmd.input.Content.Simple.Body.Html.Data as string,
  }));

// ---------------------------------------------------------------------------
describe('the sweep hands over one job per window', () => {
  it('enqueues one job when the window closes, carrying the card and nothing else', async () => {
    const out = await closeDueGatherings(cfg);
    expect(out).toEqual({ closed: 1, lapsed: 1 });
    expect(jobs()).toEqual([{ op: 'best-offer-closed-notify', card_id: CARD_H }]);
  });

  it('a second sweep finds the window already closed and hands over nothing', async () => {
    await closeDueGatherings(cfg);
    await closeDueGatherings(cfg);
    expect(jobs()).toHaveLength(1);
  });

  it('two sweeps at once hand over one job between them', async () => {
    const [a, b] = await Promise.all([closeDueGatherings(cfg), closeDueGatherings(cfg)]);
    expect(a.closed + b.closed).toBe(1);
    expect(jobs()).toHaveLength(1);
  });

  it('hands over nothing while the window is still open', async () => {
    world.gatherUntil = new Date(Date.now() + 60_000);
    await closeDueGatherings(cfg);
    expect(jobs()).toHaveLength(0);
  });

  it('enqueues nothing where no queue is wired, and the window still closes', async () => {
    const out = await closeDueGatherings({ ...cfg, opsQueueUrl: '' } as Config);
    expect(out.closed).toBe(1);
    expect(world.gatherClosedAt).not.toBeNull();
    expect(jobs()).toHaveLength(0);
  });

  it('a queue that will not take the job costs the close nothing', async () => {
    sqsSend.mockRejectedValueOnce(new Error('SQS down'));
    const out = await closeDueGatherings(cfg);
    expect(out.closed).toBe(1);
    expect(world.gatherClosedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the job sends the seller one notice', () => {
  it('sends the one fixed notice to the seller, under the window\'s own key', async () => {
    await closeDueGatherings(cfg);
    await deliver();
    expect(mails()).toHaveLength(1);
    expect(mails()[0].to).toBe(addressOf(SELLER));
    expect(mails()[0].subject).toBe(NEWS_NOTICE_SUBJECT);
    expect([...world.sends.entries()]).toEqual([
      [`best-offer-closed:${CARD_H}`, { template: 'best-offer-closed', status: 'sent' }],
    ]);
    expect(NOTICE_TEMPLATES.has('best-offer-closed')).toBe(true);
  });

  it('a job delivered twice sends one mail', async () => {
    await closeDueGatherings(cfg);
    await deliver();
    await deliver();
    await notifyBestOfferClosed(cfg, CARD_H);
    expect(mails()).toHaveLength(1);
    expect(world.sends.size).toBe(1);
  });

  it('carries no figure, no count and nothing about anybody', async () => {
    world.offers.push({ match_id: INTRO_2, amount: '987', state: 'proposed' });
    await closeDueGatherings(cfg);
    await deliver();
    const sent = JSON.stringify(mails());
    expect(sent).not.toMatch(/415|987|\b2 people\b|two people/);
    expect(JSON.stringify(jobs())).not.toMatch(/415|987/);
  });

  it('sends nothing at all when nobody put a number in', async () => {
    world.offers = [];
    await closeDueGatherings(cfg);
    await deliver();
    expect(mails()).toHaveLength(0);
    expect(world.sends.size).toBe(0);
  });

  it('counts a number closed with its introduction as no number', async () => {
    world.offers = [{ match_id: INTRO_1, amount: '415', state: 'withdrawn' }];
    await closeDueGatherings(cfg);
    await deliver();
    expect(mails()).toHaveLength(0);
  });

  it('is held back, and written down once, for a seller whose assistant brings the news', async () => {
    world.hearsVia = 'assistant';
    await closeDueGatherings(cfg);
    await deliver();
    await deliver();
    expect(mails()).toHaveLength(0);
    expect([...world.sends.values()]).toEqual([{ template: 'best-offer-closed', status: 'suppressed' }]);
  });

  it('sends nothing to a seller who has turned match mail off', async () => {
    world.freqMatches = 'off';
    await closeDueGatherings(cfg);
    await deliver();
    expect(mails()).toHaveLength(0);
    expect(world.sends.size).toBe(0);
  });

  it('sends nothing for a window that is still open, whatever asks', async () => {
    world.gatherUntil = new Date(Date.now() + 60_000);
    await notifyBestOfferClosed(cfg, CARD_H);
    expect(mails()).toHaveLength(0);
  });

  it('ignores a job that does not name a card', async () => {
    await notifyBestOfferClosed(cfg, 'not-a-card');
    await notifyBestOfferClosed(cfg, '');
    expect(mails()).toHaveLength(0);
  });

  it('a send that fails throws, so the queue redelivers, and the retry goes through once', async () => {
    await closeDueGatherings(cfg);
    sesSend.mockRejectedValueOnce(Object.assign(new Error('Service unavailable'), { name: 'ServiceUnavailable' }));
    await expect(deliver()).rejects.toThrow();
    expect(world.sends.get(`best-offer-closed:${CARD_H}`)?.status).toBe('failed');
    await deliver();
    await deliver();
    expect(world.sends.get(`best-offer-closed:${CARD_H}`)?.status).toBe('sent');
    expect(sesSend).toHaveBeenCalledTimes(2); // the failed try and the one that went
  });
});

// ---------------------------------------------------------------------------
describe('what the notice is rendered from', () => {
  it('says the numbers are ready and sends them to their assistant, and lints clean', () => {
    for (const blind of [false, true]) {
      const c = renderBestOfferClosed(
        { categoryLabel: 'Mountain bike', blind },
        { settingsUrl: 'https://my.test/settings' },
      );
      if (!blind) expect(c.text).toMatch(/numbers .* ready/);
      expect(c.text).toContain('Ask your assistant.');
      expect(c.text).not.toMatch(/\d/);
      if (blind) expect(c.text).not.toMatch(/mountain/i);
      expect(lintHumanCopy(c.text)).toEqual([]);
      expect(lintHumanCopy(c.html)).toEqual([]);
    }
  });
});
