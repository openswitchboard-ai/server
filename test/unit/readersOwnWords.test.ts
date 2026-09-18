/**
 * THE THING IS NAMED FROM THE READER'S OWN POSTING.
 *
 * In the 19 September rehearsal a person whose want was a "Fanatec brake
 * performance kit", filed under goods.electronics, was emailed "Someone has
 * come forward with an electronic." Two faults met there:
 *
 *  - the sender named the thing off the `matches` row, which carries a
 *    category and no words at all, so the poster's own `kind` never reached
 *    the sentence and the node's heading stood in for it; and
 *  - the heading "Electronics" went through the mechanical singularising rule
 *    and came out "an electronic".
 *
 * So: every notice names the thing from the RECIPIENT'S OWN card — their
 * category and their own words — and a bare heading is said as it stands,
 * with no article in front of it. Nothing the other side typed goes into an
 * email at all.
 *
 * readersOwnThingLabel is the one helper all of it runs through, in
 * digestEngine (summons, waiting message, your move) and in offers
 * (offer-on-the-table, deal-agreed).
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
import { readersOwnThingLabel } from '../../src/domain/matches.js';
import {
  categoryPhrase,
  categoryPhraseIsCountable,
  categoryPhraseWithArticle,
} from '../../src/domain/matchRules.js';
import {
  notifyMatchCreated,
  notifyYourMove,
  sendChannelWaitingNudge,
} from '../../src/email/digestEngine.js';
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
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side
const CARD_WANT = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_HAVE = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

/** The two postings from the rehearsal: the same object, filed on two
 *  different shelves, and each side wrote their own words for it. */
const CARDS: Record<string, { category: string; kind: string | null }> = {
  [CARD_WANT]: { category: 'goods.electronics', kind: 'Fanatec brake performance kit' },
  [CARD_HAVE]: { category: 'goods.gaming', kind: 'sim racing pedal set' },
};

/** The match row the pair sits on: one category for the two of them. */
const theMatch = () => ({
  id: MATCH,
  card_want: CARD_WANT,
  card_have: CARD_HAVE,
  account_want: ANA,
  account_have: BEPPE,
  category: 'goods.electronics',
  created_at: new Date('2026-09-19T00:00:00.000Z'),
  stage: 2,
  interest_want: true,
  interest_have: true,
  state: 'open' as const,
  channel_id: null,
  opened_at: null,
  live: true,
});

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/SELECT count\(\*\)::int AS n FROM matches/.test(sql)) return rows([{ n: 1 }]);
      if (/FROM matches/.test(sql) && /^\s*SELECT/.test(sql)) return rows([theMatch()]);
      if (/SELECT category, kind FROM cards WHERE id/.test(sql)) {
        const c = CARDS[params[0] as string];
        return rows(c ? [c] : []);
      }
      if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: 'email' }]);
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
      if (/INSERT INTO email_sends/.test(sql)) return rows([{ id: 'send-1' }]);
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
      return rows([]);
    },
  } as any;
}

/** Every body text sent so far. */
const bodies = () =>
  sesSend.mock.calls.map(
    (c: any[]) => (c[0] as any).input.Content.Simple.Body.Text.Data as string,
  );

beforeAll(async () => {
  vi.stubGlobal('setTimeout', ((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
});

beforeEach(() => {
  sqsSend.mockReset().mockResolvedValue({} as any);
  sesSend.mockClear();
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

// ---------------------------------------------------------------------------
describe('the helper reads each reader their own card', () => {
  it('gives each side its own words', async () => {
    expect(await readersOwnThingLabel(theMatch(), ANA)).toBe('Fanatec brake performance kit');
    expect(await readersOwnThingLabel(theMatch(), BEPPE)).toBe('sim racing pedal set');
  });

  it('falls back to the pairing’s own category where the card has gone', async () => {
    const m = { ...theMatch(), card_want: 'ffffffff-6666-4666-8666-ffffffffffff' };
    expect(await readersOwnThingLabel(m, ANA)).toBe('Electronics');
  });
});

// ---------------------------------------------------------------------------
describe('the notices name the thing the reader named', () => {
  it('summons both sides in their own words', async () => {
    await notifyMatchCreated(cfg, MATCH);
    const [ana, beppe] = bodies();
    expect(ana).toContain('come forward with a fanatec brake performance kit');
    expect(ana).not.toContain('sim racing');
    expect(ana).not.toContain('electronic.');
    expect(beppe).toContain('come forward about your sim racing pedal set');
    expect(beppe).not.toContain('fanatec');
  });

  it('says your move in the reader’s own words', async () => {
    await notifyYourMove(cfg, MATCH, ANA, 'names');
    expect(bodies().at(-1)).toContain('the fanatec brake performance kit you are after');
    await notifyYourMove(cfg, MATCH, BEPPE, 'names');
    expect(bodies().at(-1)).toContain('your sim racing pedal set');
  });

  it('says a message is waiting in the reader’s own words', async () => {
    await sendChannelWaitingNudge(cfg, {
      matchId: MATCH,
      channelId: 'ch-1',
      recipientAccount: ANA,
      notifiedAt: '2026-09-19T01:00:00.000Z',
    });
    expect(bodies().at(-1)).toContain('the fanatec brake performance kit you are after');
    expect(bodies().at(-1)).not.toContain('sim racing');
  });
});

// ---------------------------------------------------------------------------
describe('a bare heading is said as a heading', () => {
  it('never turns Electronics into "an electronic"', () => {
    expect(categoryPhrase('goods.electronics')).toBe('electronics');
    expect(categoryPhrase('Electronics')).toBe('electronics');
    expect(categoryPhraseIsCountable('goods.electronics')).toBe(false);
    expect(categoryPhraseWithArticle('goods.electronics')).toBe('electronics');
    expect(categoryPhraseWithArticle('Electronics')).toBe('electronics');
  });

  it('reads as English in the sentence it broke', () => {
    expect(`Someone has come forward with ${categoryPhraseWithArticle('goods.electronics')}.`).toBe(
      'Someone has come forward with electronics.',
    );
    expect(`Someone has come forward about your ${categoryPhrase('goods.electronics')}.`).toBe(
      'Someone has come forward about your electronics.',
    );
  });

  it('still lets the poster’s own words win over the heading', () => {
    expect(categoryPhraseWithArticle('goods.electronics', 'Fanatec brake kit')).toBe(
      'a fanatec brake kit',
    );
  });
});
