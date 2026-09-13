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
  CAME_FORWARD_SENTENCE,
  DECLINE_SENTENCE,
  expressInterestSentence,
  verdictSentence,
  withCameForward,
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
    // How an introduction is born since 13 September 2026: both sides keen
    // from the posting, details open to both.
    stage: 2,
    interest_want: true,
    interest_have: true,
    state: 'open',
    live: true,
    ...over,
  } as unknown as MatchRow;
}

interface World {
  /** Kept so the older cases below still read; both sides are keen from the
   *  start now, so nothing turns on it any more. */
  theirInterest: boolean;
  offerState: string;
  offerProposer: string;
  /** Is somebody waiting behind this one, on each side's own thing? */
  inLine: boolean;
}
let world: World;

/** The person waiting behind Ana on what she is after, and behind Beppe's. */
const NEXT_FOR_ANA = '11111111-7777-4777-8777-111111111111';
const NEXT_FOR_BEPPE = '22222222-8888-4888-8888-222222222222';
const nextOn = (cardId: string) => (cardId === CARD_W ? NEXT_FOR_ANA : NEXT_FOR_BEPPE);
/** Who is a party to each of those: the filter that keeps the line private. */
const partiesOf: Record<string, string[]> = {
  [NEXT_FOR_ANA]: [ANA],
  [NEXT_FOR_BEPPE]: [BEPPE],
};

function fakePool() {
  const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
  return {
    query: async (sql: string, params: any[] = []) => {
      if (/^\s*SELECT \* FROM matches WHERE id/.test(sql)) {
        return rows([row()]);
      }
      // The express_interest path writes nothing at all now; it reads this
      // side's own names press for the sentence and hands the row back.
      if (/FROM consent_tokens/.test(sql)) return rows([{ n: 0, mine: 0 }]);
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
      // ---- the line behind this one, as the sequencer reads it ----
      // Everyone still waiting on one want or have (lineOf). One person each,
      // when the world says somebody is waiting.
      if (/FROM matches m\s+JOIN cards own/.test(sql)) {
        if (!world.inLine) return rows([]);
        const card = String(params[0]);
        return rows([
          {
            id: nextOn(card),
            live: false,
            limits_overlap: true,
            created_at: new Date(),
            other_card: card === CARD_W ? CARD_H : CARD_W,
            own_urgency: null,
            own_slots: 1,
            own_sale: null,
            own_gather_open: false,
            other_urgency: null,
            own_lat: null,
            own_lon: null,
            other_lat: null,
            other_lon: null,
            reliability: 0.5,
          },
        ]);
      }
      // Room on the far side of that waiting one (freeSlots).
      if (/FROM cards c WHERE c\.id/.test(sql)) {
        return rows([{ slots: 1, sale: null, gather_open: false, live_now: 0 }]);
      }
      // The promotion itself: it goes live in this same request.
      if (/UPDATE matches SET live = true/.test(sql)) return rows([{ id: params[0] }]);
      // Which of the promoted ones this human is a party to. The other side's
      // line advancing is the other human's business, and never crosses.
      if (/SELECT id FROM matches\s+WHERE id = ANY/.test(sql)) {
        const ids = params[0] as string[];
        return rows(ids.filter((id) => partiesOf[id]?.includes(String(params[1]))).map((id) => ({ id })));
      }
      void params;
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  world = { theirInterest: false, offerState: 'proposed', offerProposer: BEPPE, inLine: false };
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
describe('express_interest, kept as an answer and doing nothing', () => {
  it('says the details are already open and asks for nothing but the go-ahead', async () => {
    const r = await respond({ action: 'express_interest' });
    expect(r.next).toBe('details_unlocked');
    expect(isNote(r.note)).toBe(true);
    expect(r.note.text).toContain('already down as keen');
    // It must never imply the human has just done something, and never say
    // the far side has still to decide.
    expect(r.note.text).not.toMatch(/passed that on|I have told them|have not said yes/i);
    expect(r.note.text).toContain('first name and rough area');
  });

  it('says the same thing from the other chair, and twice in a row', async () => {
    const first = await respond({ action: 'express_interest' }, BEPPE);
    const again = await respond({ action: 'express_interest' }, BEPPE);
    expect(first.next).toBe('details_unlocked');
    expect(again).toEqual(first);
    expect(again.note.text).toContain('already down as keen');
  });

  it('names the thing the way this side holds it', async () => {
    const forTheBuyer = expressInterestSentence(row(), ANA);
    const forTheSeller = expressInterestSentence(row(), BEPPE);
    expect(forTheBuyer).toContain('the mountain bike you are after');
    expect(forTheSeller).toContain('your mountain bike');
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
// Freeing a slot: what happened next, in the same breath
// ---------------------------------------------------------------------------
/**
 * The defect, from the same 13 September 2026 rehearsal: a seller told their
 * assistant to close off the person they were talking to. The switchboard
 * promoted the next person in line in that same request and summoned them —
 * and the reply said only `state: 'declined'`, so the assistant told its human
 * "the next person should surface on your listing when you check in again".
 * They were already there.
 *
 * The rule: every action that frees a slot hands back what filled it — the id,
 * and the sentence that says somebody has come forward. Nothing else about
 * them: the sweep already answers that, in the words the sweep answers it in.
 */
describe('what happened next, when closing one off freed the place it held', () => {
  it('a decline names the person who came forward and says they are here', async () => {
    world.inLine = true;
    const r = await respond({ action: 'decline' });
    expect(r.state).toBe('declined');
    expect(r.now_live_intro_id).toBe(NEXT_FOR_ANA);
    expect(r.note.text).toBe(`${DECLINE_SENTENCE} ${CAME_FORWARD_SENTENCE}`);
    expect(r.note.text).toContain('no reason went with it');
    expect(r.note.text).toMatch(/with you already/);
  });

  it('a decline with nobody waiting says exactly what it always said', async () => {
    const r = await respond({ action: 'decline' });
    expect(r.note.text).toBe(DECLINE_SENTENCE);
    expect(r.now_live_intro_id).toBeUndefined();
  });

  it('an archive says it too', async () => {
    world.inLine = true;
    const r = await respond({ action: 'archive' });
    expect(r.state).toBe('archived');
    expect(r.now_live_intro_id).toBe(NEXT_FOR_ANA);
    expect(r.note.text).toBe(`${ARCHIVE_SENTENCE} ${CAME_FORWARD_SENTENCE}`);
  });

  it('an archive with nobody waiting is unchanged', async () => {
    const r = await respond({ action: 'archive' });
    expect(r.note.text).toBe(ARCHIVE_SENTENCE);
    expect(r.now_live_intro_id).toBeUndefined();
  });

  it('a bad verdict frees the place too, and says who took it', async () => {
    world.inLine = true;
    const r = await respond({ action: 'verdict', verdict: 'bad' });
    expect(r.verdict).toBe('bad');
    expect(r.now_live_intro_id).toBe(NEXT_FOR_ANA);
    expect(r.note.text).toBe(`${verdictSentence('bad')} ${CAME_FORWARD_SENTENCE}`);
  });

  it('a bad verdict with nobody waiting is unchanged', async () => {
    const r = await respond({ action: 'verdict', verdict: 'bad' });
    expect(r.note.text).toBe(verdictSentence('bad'));
    expect(r.now_live_intro_id).toBeUndefined();
  });

  it('good and fine close nothing, so they never say anybody came forward', async () => {
    world.inLine = true;
    for (const said of ['good', 'fine'] as const) {
      const r = await respond({ action: 'verdict', verdict: said });
      expect(r.note.text, said).toBe(verdictSentence(said));
      expect(r.now_live_intro_id, said).toBeUndefined();
    }
  });

  it('works from either chair, and names only this human’s own side', async () => {
    world.inLine = true;
    const seller = await respond({ action: 'decline' }, BEPPE);
    // Beppe hears about the person waiting on HIS have, and never about the
    // one who just went live on Ana's side. The line is nobody else's.
    expect(seller.now_live_intro_id).toBe(NEXT_FOR_BEPPE);
    expect(JSON.stringify(seller)).not.toContain(NEXT_FOR_ANA);
    const buyer = await respond({ action: 'decline' }, ANA);
    expect(buyer.now_live_intro_id).toBe(NEXT_FOR_ANA);
    expect(JSON.stringify(buyer)).not.toContain(NEXT_FOR_BEPPE);
  });

  it('never sends the human away to look for somebody who is already there', () => {
    expect(CAME_FORWARD_SENTENCE).not.toMatch(/check|later|next time|surface|should/i);
    expect(withCameForward(DECLINE_SENTENCE, [])).toBe(DECLINE_SENTENCE);
    expect(withCameForward(DECLINE_SENTENCE, [NEXT_FOR_ANA])).toContain(CAME_FORWARD_SENTENCE);
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
    ['express_interest', expressInterestSentence(row(), ANA)],
    ['express_interest (other side)', expressInterestSentence(row(), BEPPE)],
    ['express_interest (go-ahead already given)', expressInterestSentence(row({ my_optin: true }), ANA)],
    ['decline', DECLINE_SENTENCE],
    ['archive', ARCHIVE_SENTENCE],
    ['someone came forward', CAME_FORWARD_SENTENCE],
    ['decline + came forward', withCameForward(DECLINE_SENTENCE, [NEXT_FOR_ANA])],
    ['archive + came forward', withCameForward(ARCHIVE_SENTENCE, [NEXT_FOR_ANA])],
    ['verdict bad + came forward', withCameForward(verdictSentence('bad'), [NEXT_FOR_ANA])],
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
