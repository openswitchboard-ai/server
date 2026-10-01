/**
 * Nobody who hears by email is left waiting in silence over a written line
 * (2 October 2026; domain/confirmLines.ts).
 *
 * A seller whose assistant only wakes when spoken to has to be told the buyer
 * asked them to confirm something, and such a buyer has to be told a line was
 * left unconfirmed. Both ride the EXISTING your-move notice
 * (email/digestEngine.ts, notifyYourMove) through the ops queue, the way the
 * names step does, so every rule of that notice holds here unchanged:
 *
 *  - it goes only to somebody who hears by email, and never to an account
 *    that has turned match mail off;
 *  - it is the one fixed notice, with nothing in it of what was asked;
 *  - one mail per dedupe key. The key carries the occasion: the oldest line
 *    still unanswered for the seller, so a burst of lines is one mail; the
 *    first line a press left unconfirmed for the buyer, so a press is one mail.
 *
 * The suite runs the real pipeline end to end: the ask or the press enqueues,
 * the job is handed to notifyYourMove as the ops worker hands it, and the mail
 * is whatever sendEmail would have given SES.
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

const sesSend = vi.fn(async (_cmd: any) => ({ MessageId: 'ses-1' }));
const sqsSend = vi.fn(async (_cmd: any) => ({}));
vi.mock('../../src/aws.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sesv2: { send: (cmd: any) => sesSend(cmd) },
  sqs: { send: (cmd: any) => sqsSend(cmd) },
}));

vi.mock('../../src/intake/pipe.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runIntake: async () => ({ outcome: 'pass', checks: [] }),
}));

import * as db from '../../src/db.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import * as lines from '../../src/domain/confirmLines.js';
import * as offers from '../../src/domain/offers.js';
import { notifyYourMove } from '../../src/email/digestEngine.js';
import { NEWS_NOTICE_SUBJECT, NOTICE_TEMPLATES, renderYourMove } from '../../src/email/templates.js';
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

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the buyer
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the seller
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const OFFER = '0f0f0f0f-0000-4000-8000-000000000001'; // the buyer's figure
const addressOf = (accountId: string) => `${accountId}@example.test`;

let seq = 0;
const lineId = () => `11111111-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

interface World {
  hearsVia: Record<string, 'email' | 'assistant'>;
  freqMatches: Record<string, string>;
  lines: any[];
  offers: any[];
  /** email_sends, keyed as the table is: one row per dedupe key. */
  sends: Map<string, { template: string; status: string }>;
}
let world: World;

const theMatch = () => ({
  id: MATCH,
  card_want: CARD_W,
  card_have: CARD_H,
  account_want: ANA,
  account_have: BEPPE,
  category: 'goods.bicycle.mountain',
  stage: 2,
  state: 'open',
  live: true,
  swap: false,
});

function fakePool() {
  const query = async (sql: string, params: any[] = []) => {
    const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
    // --- the send ledger: the INSERT is the lock, one row per key ---
    if (/INSERT INTO email_sends/.test(sql)) {
      if (world.sends.has(params[0])) return rows([]);
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
    if (/SELECT hears_via FROM accounts/.test(sql)) {
      return rows([{ hears_via: world.hearsVia[params[0]] ?? 'email' }]);
    }
    if (/SELECT blind_mode/.test(sql)) {
      return rows([
        {
          blind_mode: false,
          email_freq_matches: world.freqMatches[params[0]] ?? 'immediate',
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
    // --- the introduction and its lines ---
    if (/FROM matches WHERE id/.test(sql)) return rows(params[0] === MATCH ? [theMatch()] : []);
    if (/FROM cards WHERE id/.test(sql)) {
      return rows([{ id: params[0], category: 'goods.bicycle.mountain', kind: 'mountain bike', lifecycle_state: 'PUBLISHED', type: params[0] === CARD_H ? 'HAVE' : 'WANT' }]);
    }
    if (/INSERT INTO confirm_lines/.test(sql)) {
      const row = {
        id: lineId(),
        match_id: params[0],
        asked_by: params[1],
        line: JSON.parse(params[2]),
        state: 'asked',
        created_at: new Date(Date.now() + seq),
      };
      world.lines.push(row);
      return rows([row]);
    }
    if (/FROM confirm_lines\s+WHERE match_id = \$1 AND state <> 'withdrawn'/.test(sql)) {
      return rows(world.lines.filter((l) => l.state !== 'withdrawn'));
    }
    if (/SELECT id, state FROM confirm_lines/.test(sql)) {
      return rows(world.lines.filter((l) => l.state === 'asked' || l.state === 'declined'));
    }
    if (/UPDATE confirm_lines\s+SET state = \$2/.test(sql)) {
      const from = /state IN \('asked', 'declined'\)/.test(sql) ? ['asked', 'declined'] : ['asked'];
      for (const l of world.lines) {
        if (params[5].includes(l.id) && from.includes(l.state)) l.state = params[1];
      }
      return rows([]);
    }
    if (/SELECT \* FROM offers WHERE id/.test(sql)) return rows(world.offers.filter((o) => o.id === params[0]));
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
  seq = 0;
  world = {
    hearsVia: {},
    freqMatches: {},
    lines: [],
    offers: [
      {
        id: OFFER,
        match_id: MATCH,
        proposer_account: ANA,
        amount: '415',
        ccy: 'AUD',
        expiry: new Date(Date.now() + 86_400_000),
        state: 'proposed',
        message: null,
      },
    ],
    sends: new Map(),
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  sesSend.mockClear();
  sqsSend.mockClear();
});

/** Every job on the ops queue, as the worker would read it. */
const jobs = () => sqsSend.mock.calls.map(([cmd]: any[]) => JSON.parse(cmd.input.MessageBody));

/** Hand each job to the notice exactly as workers/opsWorker.ts does. */
async function deliver() {
  for (const body of jobs()) {
    expect(body.op).toBe('your-move-notify');
    await notifyYourMove(
      cfg,
      body.match_id,
      body.account_id,
      body.step === 'details' ? 'details' : body.step === 'written' ? 'written' : 'names',
      typeof body.occasion === 'string' ? body.occasion : undefined,
    );
  }
}

const mails = () =>
  sesSend.mock.calls.map(([cmd]: any[]) => ({
    to: cmd.input.Destination.ToAddresses[0] as string,
    subject: cmd.input.Content.Simple.Subject.Data as string,
    text: cmd.input.Content.Simple.Body.Text.Data as string,
    html: cmd.input.Content.Simple.Body.Html.Data as string,
  }));

const SECRET = 'Comes with the zebra-striped saddle';

// ---------------------------------------------------------------------------
describe('the seller is told a line is waiting on them', () => {
  it('gets the one fixed notice when email is how they hear', async () => {
    await lines.askLine(cfg, ANA, MATCH, SECRET);
    await deliver();
    expect(mails()).toHaveLength(1);
    expect(mails()[0].to).toBe(addressOf(BEPPE));
    expect(mails()[0].subject).toBe(NEWS_NOTICE_SUBJECT);
    // An ordinary notice under the notice rule: the existing template, no
    // new one and no new exemption.
    expect([...world.sends.values()]).toEqual([{ template: 'your-move', status: 'sent' }]);
    expect(NOTICE_TEMPLATES.has('your-move')).toBe(true);
  });

  it('carries nothing of what was asked, on the queue or in the mail', async () => {
    await lines.askLine(cfg, ANA, MATCH, SECRET);
    const queued = JSON.stringify(jobs());
    expect(queued).not.toMatch(/zebra|saddle/i);
    expect(Object.keys(jobs()[0]).sort()).toEqual(['account_id', 'match_id', 'occasion', 'op', 'step']);
    await deliver();
    const sent = JSON.stringify(mails());
    expect(sent).not.toMatch(/zebra|saddle|confirm/i);
    expect([...world.sends.keys()].join(' ')).not.toMatch(/zebra|saddle/i);
  });

  it('gets none when their assistant brings them the news', async () => {
    world.hearsVia[BEPPE] = 'assistant';
    await lines.askLine(cfg, ANA, MATCH, SECRET);
    await deliver();
    expect(mails()).toHaveLength(0);
    expect([...world.sends.values()]).toEqual([{ template: 'your-move', status: 'suppressed' }]);
  });

  it('gets none where they have turned match mail off', async () => {
    world.freqMatches[BEPPE] = 'off';
    await lines.askLine(cfg, ANA, MATCH, SECRET);
    await deliver();
    expect(mails()).toHaveLength(0);
    expect(world.sends.size).toBe(0);
  });

  it('a burst of lines is one notice', async () => {
    for (const text of ['Comes with both keys', 'Brakes were serviced this year', 'Has never been crashed']) {
      await lines.askLine(cfg, ANA, MATCH, text);
    }
    expect(jobs()).toHaveLength(3);
    // Every job names the same occasion: the oldest line still unanswered.
    expect(new Set(jobs().map((j) => j.occasion))).toEqual(new Set([`asked:${world.lines[0].id}`]));
    await deliver();
    await deliver(); // and a redelivered job changes nothing
    expect(mails()).toHaveLength(1);
    expect(world.sends.size).toBe(1);
  });

  it('is told again once they have answered and something new is asked', async () => {
    await lines.askLine(cfg, ANA, MATCH, 'Comes with both keys');
    await lines.answerLinesByHuman(MATCH, BEPPE, 'counter', {
      shown: [world.lines[0].id],
      ticked: [world.lines[0].id],
      on: 'lines-confirm',
    }, cfg);
    await lines.askLine(cfg, ANA, MATCH, 'Has never been crashed');
    await deliver();
    expect(mails().map((m) => m.to)).toEqual([addressOf(BEPPE), addressOf(BEPPE)]);
  });

  it('is not swallowed by the names-step notice that went before it', async () => {
    await notifyYourMove(cfg, MATCH, BEPPE, 'names');
    await lines.askLine(cfg, ANA, MATCH, SECRET);
    await deliver();
    expect(mails()).toHaveLength(2);
    // And the names step keeps the key and the one-ever rule it always had.
    await notifyYourMove(cfg, MATCH, BEPPE, 'names');
    expect(mails()).toHaveLength(2);
    expect([...world.sends.keys()]).toContain(`your-move:${MATCH}:${BEPPE}`);
  });

  it('sends nothing without an occasion, and nothing where no queue is wired', async () => {
    await notifyYourMove(cfg, MATCH, BEPPE, 'written');
    await notifyYourMove(cfg, MATCH, BEPPE, 'written', 'anything else');
    expect(mails()).toHaveLength(0);
    await lines.askLine({ ...cfg, opsQueueUrl: '' } as Config, ANA, MATCH, SECRET);
    expect(jobs()).toHaveLength(0);
    expect(world.lines).toHaveLength(1); // the line is asked all the same
  });

  it('a queue that will not take the job costs the line nothing', async () => {
    sqsSend.mockRejectedValueOnce(new Error('SQS down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await lines.askLine(cfg, ANA, MATCH, SECRET);
    expect(world.lines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('the buyer is told a line was left unconfirmed', () => {
  const ask = async (...texts: string[]) => {
    for (const t of texts) await lines.askLine(cfg, ANA, MATCH, t);
    sqsSend.mockClear();
    sesSend.mockClear();
    world.sends.clear();
    return world.lines.map((l) => l.id as string);
  };

  it('once per press, on the page of its own', async () => {
    const [a, b, c] = await ask('Comes with both keys', SECRET, 'Has never been crashed');
    await lines.answerLinesByHuman(MATCH, BEPPE, 'counter', { shown: [a, b, c], ticked: [a], on: 'lines-confirm' }, cfg);
    // Two lines left unconfirmed, one job, one mail.
    expect(jobs()).toEqual([
      { op: 'your-move-notify', match_id: MATCH, account_id: ANA, step: 'written', occasion: `declined:${b}` },
    ]);
    await deliver();
    await deliver();
    expect(mails()).toHaveLength(1);
    expect(mails()[0].to).toBe(addressOf(ANA));
    expect(mails()[0].subject).toBe(NEWS_NOTICE_SUBJECT);
    expect(JSON.stringify(mails())).not.toMatch(/zebra|saddle/i);
  });

  it('and when the seller pressed Accept with one left unticked', async () => {
    const [a, b] = await ask('Comes with both keys', SECRET);
    await expect(
      offers.acceptOfferByHuman(OFFER, BEPPE, 'counter', cfg, {
        lines: { shown: [a, b], ticked: [a], on: 'offer-accept' },
      }),
    ).rejects.toMatchObject({ linesNotConfirmed: true });
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ account_id: ANA, occasion: `declined:${b}` });
    await deliver();
    expect(mails().map((m) => m.to)).toEqual([addressOf(ANA)]);
  });

  it('gets none when their assistant brings them the news', async () => {
    world.hearsVia[ANA] = 'assistant';
    const [a] = await ask(SECRET);
    await lines.answerLinesByHuman(MATCH, BEPPE, 'counter', { shown: [a], ticked: [], on: 'lines-confirm' }, cfg);
    await deliver();
    expect(mails()).toHaveLength(0);
    expect([...world.sends.values()]).toEqual([{ template: 'your-move', status: 'suppressed' }]);
  });

  it('nothing is sent for a press that confirmed everything, or changed nothing', async () => {
    const [a] = await ask('Comes with both keys');
    await lines.answerLinesByHuman(MATCH, BEPPE, 'counter', { shown: [a], ticked: [a], on: 'lines-confirm' }, cfg);
    expect(jobs()).toHaveLength(0);
    // A line already answered no is not declined a second time by a later press.
    world.lines[0].state = 'declined';
    await lines.answerLinesByHuman(MATCH, BEPPE, 'counter', { shown: [a], ticked: [], on: 'lines-confirm' }, cfg);
    expect(jobs()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('what the notice is rendered from', () => {
  it('says only that something is waiting, and lints clean', () => {
    for (const blind of [false, true]) {
      const c = renderYourMove(
        { categoryLabel: 'Mountain bike', blind, step: 'written', side: 'have' },
        { settingsUrl: 'https://my.test/settings' },
      );
      expect(c.text).toMatch(/waiting on you/);
      expect(c.text).not.toMatch(/first names/);
      expect(lintHumanCopy(c.text)).toEqual([]);
      expect(lintHumanCopy(c.html)).toEqual([]);
    }
  });
});
