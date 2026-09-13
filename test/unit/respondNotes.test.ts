/**
 * Every action reply carries the sentence to say.
 *
 * The defect this suite holds shut, from the 13 September 2026 rehearsal: an
 * assistant told its human "I've told them you're keen… They still need to say
 * yes too before we get any further" when the other side had already said yes
 * and the details were open to both. The reply it read that from was
 * `{ intro_id, next: 'details_unlocked' }` — a state word and no words for it,
 * so the agent narrated from its own guess.
 *
 * The rule everywhere else in the sweep is that every field which changes what
 * the agent should say carries a switchboard-authored sentence beside it (see
 * sweepNotes.test.ts). These are the same rule, applied to the replies the
 * `respond` tool hands back after it has done something.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

import * as db from '../../src/db.js';
import {
  ARCHIVE_SENTENCE,
  DECLINE_SENTENCE,
  expressInterestSentence,
  verdictSentence,
  type MatchRow,
} from '../../src/domain/matches.js';
import { offerActionSentence } from '../../src/domain/offers.js';
import { dispatchTool, TOOLS } from '../../src/mcp/tools.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
  quotas: { readsPerMinute: 1000, offersPerDay: 100 },
} as unknown as Config;

const INTRO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the side that wants
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the side that has
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const OFFER = 'ffffffff-6666-4666-8666-ffffffffffff';

/** A row as the two sides' interest actually stands. */
function row(over: Partial<MatchRow> = {}): MatchRow {
  return {
    id: INTRO,
    card_want: CARD_W,
    card_have: CARD_H,
    account_want: ANA,
    account_have: BEPPE,
    category: 'goods.bicycle.mountain',
    stage: 1,
    interest_want: false,
    interest_have: false,
    state: 'open',
    live: true,
    ...over,
  } as unknown as MatchRow;
}

interface World {
  /** Has the OTHER side already said they are keen? */
  theirInterest: boolean;
  offerState: string;
  offerProposer: string;
}
let world: World;

function fakePool() {
  const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
  return {
    query: async (sql: string, params: any[] = []) => {
      if (/^\s*SELECT \* FROM matches WHERE id/.test(sql)) {
        return rows([row({ interest_have: world.theirInterest })]);
      }
      // Interest is recorded for the caller's own side; the row comes back as
      // it now stands, which is what decides which sentence is owed.
      if (/UPDATE matches SET interest_/.test(sql)) {
        return rows([
          row({
            interest_want: true,
            interest_have: world.theirInterest,
            stage: world.theirInterest ? 1 : 1,
          }),
        ]);
      }
      if (/UPDATE matches SET stage = 2/.test(sql)) {
        return rows([row({ interest_want: true, interest_have: true, stage: 2 })]);
      }
      if (/UPDATE matches\s+SET state = 'archived'/.test(sql)) return rows([{ id: INTRO }]);
      if (/SELECT card_want, card_have FROM matches/.test(sql)) {
        return rows([{ card_want: CARD_W, card_have: CARD_H }]);
      }
      if (/^\s*SELECT \* FROM offers WHERE id/.test(sql)) {
        return rows([
          {
            id: OFFER,
            match_id: INTRO,
            proposer_account: world.offerProposer,
            amount: '415',
            ccy: 'AUD',
            expiry: new Date(Date.now() + 3600_000),
            state: world.offerState,
            message: null,
            authored_by: 'agent',
          },
        ]);
      }
      if (/UPDATE offers SET state/.test(sql)) {
        return rows([
          {
            id: OFFER,
            match_id: INTRO,
            proposer_account: world.offerProposer,
            amount: '415',
            ccy: 'AUD',
            expiry: new Date(Date.now() + 3600_000),
            state: /withdrawn/.test(sql)
              ? 'withdrawn'
              : /declined/.test(sql)
                ? 'declined'
                : 'awaiting-human',
            message: null,
            authored_by: 'agent',
          },
        ]);
      }
      if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: 'assistant' }]);
      void params;
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  world = { theirInterest: false, offerState: 'proposed', offerProposer: BEPPE };
  vi.spyOn(db, 'getPool').mockImplementation(() => fakePool());
});

/** The shape every one of these sentences arrives in. */
const isNote = (n: any) =>
  !!n && typeof n.text === 'string' && n.text.length > 0 && n.provenance === 'switchboard-system';

const respond = async (args: Record<string, unknown>, who = ANA): Promise<any> =>
  (await dispatchTool(cfg, who, 'respond', { intro_id: INTRO, ...args })).structuredContent;

// ---------------------------------------------------------------------------
// express_interest — the reply the rehearsal was narrated from
// ---------------------------------------------------------------------------
describe('telling the other side your human is keen', () => {
  it('says they are keen too and the details are open, when it just became mutual', async () => {
    world.theirInterest = true;
    const r = await respond({ action: 'express_interest' });
    expect(r.next).toBe('details_unlocked');
    expect(isNote(r.note)).toBe(true);
    expect(r.note.text).toContain('they are keen too');
    expect(r.note.text).toContain('open to both sides now');
    // The whole defect: the sentence must never say the far side has still to
    // decide, and the only step left is the human's own go-ahead.
    expect(r.note.text).not.toMatch(/still|waiting on them|have not said yes/i);
    expect(r.note.text).toContain('first name and rough area');
  });

  it('names the thing the way this side holds it', async () => {
    world.theirInterest = true;
    const forTheBuyer = expressInterestSentence(
      row({ interest_want: true, interest_have: true, stage: 2 }),
      ANA,
    );
    const forTheSeller = expressInterestSentence(
      row({ interest_want: true, interest_have: true, stage: 2 }),
      BEPPE,
    );
    expect(forTheBuyer).toContain('the mountain bike you are after');
    expect(forTheSeller).toContain('your mountain bike');
  });

  it('says it has been passed on and they have not said yes yet, when it is not mutual', async () => {
    const r = await respond({ action: 'express_interest' });
    expect(r.next).toBe('awaiting_other_side');
    expect(isNote(r.note)).toBe(true);
    expect(r.note.text).toContain('passed that on');
    expect(r.note.text).toContain('have not said yes yet');
    expect(r.note.text).toMatch(/tell you the moment they do/);
  });
});

// ---------------------------------------------------------------------------
// The other three that change what the human is living through
// ---------------------------------------------------------------------------
describe('closing, filing away, and saying how it went', () => {
  it('a decline says it is closed and that no reason travelled', async () => {
    const r = await respond({ action: 'decline' });
    expect(r.state).toBe('declined');
    expect(isNote(r.note)).toBe(true);
    expect(r.note.text).toBe(DECLINE_SENTENCE);
    expect(r.note.text).toContain('closed off');
    expect(r.note.text).toContain('no reason went with it');
  });

  it('an archive says it is filed away and still retrievable', async () => {
    const r = await respond({ action: 'archive' });
    expect(r.state).toBe('archived');
    expect(isNote(r.note)).toBe(true);
    expect(r.note.text).toBe(ARCHIVE_SENTENCE);
    expect(r.note.text).toMatch(/filed away/i);
    expect(r.note.text).toMatch(/bring it back/);
  });

  it('each verdict is acknowledged in its own words', async () => {
    const good = await respond({ action: 'verdict', verdict: 'good' });
    expect(good.note.text).toBe(verdictSentence('good'));
    expect(good.note.text).toMatch(/went well/);
    expect(good.note.text).toMatch(/more like it/);

    const fine = await respond({ action: 'verdict', verdict: 'fine' });
    expect(fine.note.text).toBe(verdictSentence('fine'));
    expect(fine.note.text).toMatch(/nothing else changes/i);

    const bad = await respond({ action: 'verdict', verdict: 'bad' });
    expect(bad.note.text).toBe(verdictSentence('bad'));
    // The two things `bad` actually does: closed off, and that person muted.
    expect(bad.note.text).toMatch(/closed it off/);
    expect(bad.note.text).toMatch(/will not hear from that person again/);
    for (const r of [good, fine, bad]) expect(isNote(r.note)).toBe(true);
  });

  it('the old verdict words still get their sentence', async () => {
    const r = await respond({ action: 'verdict', verdict: 'not-for-me' });
    expect(r.verdict).toBe('bad');
    expect(r.note.text).toBe(verdictSentence('bad'));
  });
});

// ---------------------------------------------------------------------------
// The offer actions
// ---------------------------------------------------------------------------
describe('the offer actions answer with words too', () => {
  it('brings a figure to the human with what that means', async () => {
    const r = await respond({ action: 'send_to_human', offer_id: OFFER });
    expect(isNote(r.note)).toBe(true);
    expect(r.note.text).toBe(offerActionSentence('send_to_human'));
    expect(r.note.text).toMatch(/nothing is agreed until you say yes/i);
  });

  it('a declined figure says no reason travelled', async () => {
    const r = await respond({ action: 'decline_offer', offer_id: OFFER });
    expect(r.state).toBe('declined');
    expect(r.note.text).toBe(offerActionSentence('decline_offer'));
    expect(r.note.text).toContain('no reason went with it');
  });

  it('a withdrawn figure says it is off the table', async () => {
    world.offerProposer = ANA;
    const r = await respond({ action: 'withdraw_offer', offer_id: OFFER });
    expect(r.state).toBe('withdrawn');
    expect(r.note.text).toBe(offerActionSentence('withdraw_offer'));
    expect(r.note.text).toMatch(/off the table/);
  });

  it('a figure sent says it is on the table and their answer will be brought over', () => {
    expect(offerActionSentence('propose_offer')).toMatch(/on the table/);
    expect(offerActionSentence('propose_offer')).toMatch(/bring their answer/);
  });
});

// ---------------------------------------------------------------------------
// The house rules on anything a person reads
// ---------------------------------------------------------------------------
/** Every word the switchboard puts in front of a model (manual.test.ts). */
const BANNED = [
  { label: 'card', re: /\b(index\s+)?cards?\b/i },
  { label: 'channel', re: /\bchannels?\b/i },
  { label: 'match', re: /\bmatch(es)?\b/i },
  { label: 'stage', re: /\bstages?\b/i },
  { label: 'WANT', re: /\bWANT\b/ },
  { label: 'HAVE', re: /\bHAVE\b/ },
  { label: 'connection', re: /\bconnections?\b/i },
  { label: 'score', re: /\bscores?\b/i },
];

describe('the copy rules, applied to every sentence shipped here', () => {
  const ALL: [string, string][] = [
    ['express_interest (mutual)', expressInterestSentence(row({ interest_want: true, interest_have: true, stage: 2 }), ANA)],
    ['express_interest (mutual, other side)', expressInterestSentence(row({ interest_want: true, interest_have: true, stage: 2 }), BEPPE)],
    ['express_interest (waiting)', expressInterestSentence(row({ interest_want: true }), ANA)],
    ['decline', DECLINE_SENTENCE],
    ['archive', ARCHIVE_SENTENCE],
    ['verdict good', verdictSentence('good')],
    ['verdict fine', verdictSentence('fine')],
    ['verdict bad', verdictSentence('bad')],
    ['propose_offer', offerActionSentence('propose_offer')],
    ['send_to_human', offerActionSentence('send_to_human')],
    ['decline_offer', offerActionSentence('decline_offer')],
    ['withdraw_offer', offerActionSentence('withdraw_offer')],
  ];

  it('no antithesis and no retired vocabulary', () => {
    for (const [name, text] of ALL) expect(lintHumanCopy(text), name).toEqual([]);
  });

  it('names none of the machinery', () => {
    for (const [name, text] of ALL) {
      for (const { label, re } of BANNED) {
        expect(re.test(text), `${label} in ${name}`).toBe(false);
      }
    }
  });

  it('reads as a sentence: a capital, an end stop, and no field names', () => {
    for (const [name, text] of ALL) {
      expect(text[0], name).toBe(text[0].toUpperCase());
      expect(text.trim().endsWith('.'), name).toBe(true);
      expect(/_[a-z]/.test(text), name).toBe(false);
    }
  });
});

describe('the tool tells an agent the words are there', () => {
  it('the respond description says every action answers with the sentence to say', () => {
    const respondTool = TOOLS.find((t) => t.name === 'respond')!;
    expect(respondTool.description).toContain('sentence to say');
  });
});
