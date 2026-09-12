/**
 * The notice that goes out when the details open.
 *
 * The defect this suite exists to hold shut, from the 2026-09-12 rehearsal:
 * one human said they were keen, and then nothing. Days later the other side
 * said the same back, which opened the details for both — and the first human
 * heard nothing about it, because their assistant only wakes when they speak
 * to it and the switchboard only spoke at the later, names step.
 *
 * The rule underneath: the side that spoke FIRST is told, once, when the
 * second side makes it mutual. The second side needs no notice at all, since
 * its own assistant is right there and already holds the answer.
 *
 * What is asserted here:
 *  - the second interest enqueues one notice, to the side that spoke first;
 *  - a first interest, with nobody keen back yet, enqueues nothing;
 *  - a human whose own agent brings them the news is left alone;
 *  - a queue that is down never fails the step itself;
 *  - the notice reads as a notice: one sentence, nothing to press, ending
 *    "Ask your assistant.", and it carries its own dedupe key so it can never
 *    eat the later names notice.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sesSend = vi.fn(async () => ({ MessageId: 'ses-1' }));
const sqsSend = vi.fn(async () => ({}));
vi.mock('../../src/aws.js', () => ({
  sesv2: { send: (...a: unknown[]) => sesSend(...(a as [])) },
  sqs: { send: (...a: unknown[]) => sqsSend(...(a as [])) },
}));

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

import * as db from '../../src/db.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { expressInterest } from '../../src/domain/matches.js';
import { notifyYourMove } from '../../src/email/digestEngine.js';
import { renderYourMove, type FooterLinks } from '../../src/email/templates.js';
import { lintEmailCopy, noticeLinkHits } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
  opsQueueUrl: 'https://ops.test/queue',
  sesFrom: 'switchboard@test',
  sesReplyTo: 'switchboard@test',
  sesConfigurationSet: 'cs',
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side, keen first
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side, keen second

interface World {
  stage: number;
  interestWant: boolean;
  interestHave: boolean;
  hearsVia: Record<string, 'email' | 'assistant'>;
  dedupeKeys: string[];
}
let world: World;

const theMatch = () => ({
  id: MATCH,
  card_want: 'card-w',
  card_have: 'card-h',
  account_want: ANA,
  account_have: BEPPE,
  score: 0.8,
  category: 'goods.bicycle.mountain',
  stage: world.stage,
  interest_want: world.interestWant,
  interest_have: world.interestHave,
  state: 'open' as const,
  channel_id: null,
  opened_at: null,
});

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/UPDATE matches SET interest_want/.test(sql)) {
        world.interestWant = true;
        return rows([theMatch()]);
      }
      if (/UPDATE matches SET interest_have/.test(sql)) {
        world.interestHave = true;
        return rows([theMatch()]);
      }
      if (/UPDATE matches SET stage = 2/.test(sql)) {
        world.stage = 2;
        return rows([theMatch()]);
      }
      if (/FROM matches/.test(sql) && /^\s*SELECT/.test(sql)) return rows([theMatch()]);
      if (/SELECT hears_via FROM accounts/.test(sql)) {
        return rows([{ hears_via: world.hearsVia[params[0]] ?? 'email' }]);
      }
      if (/SELECT blind_mode, email_freq_matches/.test(sql)) {
        return rows([
          {
            blind_mode: false,
            email_freq_matches: 'immediate',
            email_freq_digests: 'weekly',
            email_unreachable_at: null,
            email_complaint_suppressed_at: null,
          },
        ]);
      }
      if (/SELECT email_unreachable_at/.test(sql)) {
        return rows([{ email_unreachable_at: null, email_complaint_suppressed_at: null }]);
      }
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
        return rows([
          {
            id: params[0],
            status: 'active',
            data_key_enc: Buffer.from('wrapped'),
            email_enc: Buffer.from(`enc:${params[0]}@example.test`),
          },
        ]);
      }
      if (/INSERT INTO email_sends/.test(sql)) {
        world.dedupeKeys.push(params[0]);
        return rows([{ id: 'send-1' }]);
      }
      return rows([]);
    },
  } as any;
}

beforeAll(async () => {
  // The send pipeline paces SES at one a second; that pacing is covered in its
  // own suite and here it would only make this one wait.
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
    stage: 1,
    interestWant: true, // Ana spoke first
    interestHave: false,
    hearsVia: {},
    dedupeKeys: [],
  };
  sqsSend.mockReset().mockResolvedValue({} as any);
  sesSend.mockClear();
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

/** The "your move" ops messages enqueued so far. */
const notices = () =>
  sqsSend.mock.calls
    .map((c: any[]) => {
      try {
        return JSON.parse(c[0].input.MessageBody);
      } catch {
        return {};
      }
    })
    .filter((b: any) => b.op === 'your-move-notify');

// ---------------------------------------------------------------------------
describe('the side that spoke first hears when the details open', () => {
  it('tells that side, once, when the second side says it is keen too', async () => {
    const m = await expressInterest(cfg, MATCH, BEPPE);
    expect(m.stage).toBe(2); // the details are open for both now
    const sent = notices();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ match_id: MATCH, account_id: ANA, step: 'details' });
  });

  it('says nothing on the first interest, when nobody is keen back yet', async () => {
    world.interestWant = false;
    await expressInterest(cfg, MATCH, ANA);
    expect(notices()).toHaveLength(0);
  });

  it('says nothing a second time when the same side speaks again', async () => {
    await expressInterest(cfg, MATCH, BEPPE);
    sqsSend.mockClear();
    await expressInterest(cfg, MATCH, BEPPE);
    expect(notices()).toHaveLength(0);
  });

  it('leaves alone a human whose own agent brings them the news', async () => {
    world.hearsVia[ANA] = 'assistant';
    await expressInterest(cfg, MATCH, BEPPE);
    expect(notices()).toHaveLength(0);
  });

  it('never fails the step itself when the queue is down', async () => {
    sqsSend.mockRejectedValueOnce(new Error('sqs down'));
    const m = await expressInterest(cfg, MATCH, BEPPE);
    expect(m.stage).toBe(2); // the interest itself still went through
  });
});

// ---------------------------------------------------------------------------
describe('the notice itself', () => {
  const links: FooterLinks = {
    settingsUrl: 'https://my.test/settings',
    unsubUrl: 'https://my.test/email/unsub?t=x',
  } as FooterLinks;

  it('says they are keen too, names the thing as a person would, and stops', () => {
    const c = renderYourMove(
      { categoryLabel: 'Mountain bikes', blind: false, step: 'details' },
      links,
    );
    expect(c.text).toContain('is keen too');
    expect(c.text).toContain('about the mountain bike');
    expect(c.text).not.toContain('Mountain bikes');
    expect(c.text.trimEnd()).toContain('Ask your assistant.');
  });

  it('carries nothing to press and no marketing voice', () => {
    const c = renderYourMove(
      { categoryLabel: 'Mountain bikes', blind: false, step: 'details' },
      links,
    );
    expect(
      noticeLinkHits(c, ['https://my.test/settings', 'https://my.test/email/unsub']),
    ).toEqual([]);
    expect(lintEmailCopy(c.subject + c.text + c.html)).toEqual([]);
  });

  it('names no thing at all when the person is in blind mode', () => {
    const c = renderYourMove({ categoryLabel: 'Mountain bikes', blind: true, step: 'details' }, links);
    expect(c.text).not.toContain('mountain bike');
    expect(c.text).toContain('is keen too');
  });

  it('leaves the names-step wording exactly as it was', () => {
    const c = renderYourMove({ categoryLabel: 'Mountain bikes', blind: false }, links);
    expect(c.subject).toBe('It is your turn');
    expect(c.text).toContain('is keen and ready to talk');
  });
});

// ---------------------------------------------------------------------------
describe('the two steps keep their own dedupe keys', () => {
  it('a details notice can never eat the later names notice', async () => {
    await notifyYourMove(cfg, MATCH, ANA, 'details');
    await notifyYourMove(cfg, MATCH, ANA, 'names');
    expect(world.dedupeKeys).toEqual([
      `your-move:${MATCH}:${ANA}:details`,
      `your-move:${MATCH}:${ANA}`,
    ]);
  });

  it('is quiet for a human whose agent brings them the news', async () => {
    world.hearsVia[ANA] = 'assistant';
    await notifyYourMove(cfg, MATCH, ANA, 'details');
    expect(sesSend).not.toHaveBeenCalled();
  });
});
