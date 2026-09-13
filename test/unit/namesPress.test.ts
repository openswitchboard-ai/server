/**
 * A PRESS THAT LANDED MUST LOOK LIKE ONE.
 *
 * Run 8 (13 September 2026), the worst thing seen all day: a human pressed
 * their own names link, the switchboard recorded it exactly as designed (a
 * consent_tokens row, kind stage3-optin, recorded_via counter, the approval
 * link marked approved) — and their assistant's next sweep came back word for
 * word the same as the sweep before it. `nextAction` went straight from "both
 * sides are interested" to `details_unlocked` and never looked at the opt-in
 * at all, because stage only moves to 3 once BOTH humans have pressed. So the
 * assistant asked the human whether they had really pressed confirm or whether
 * it had errored, and offered them a fresh link. They had done everything
 * right and were told they had failed.
 *
 * What is held shut here:
 *   - the word: `awaiting_their_go_ahead`, on this side and this side only;
 *   - the sentence: it confirms their press landed, says what is waited on,
 *     and asks them for nothing;
 *   - the cost: the sweep reads the opt-in in the ONE query it already ran, so
 *     fifty introductions never become fifty reads;
 *   - the other mouths that speak about this state — the express_interest
 *     reply, the respond(opt_in) reply, the names step's refusal — none of
 *     which may contradict it by asking for a press that is already recorded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../../src/db.js';
import {
  awaitingTheirGoAheadSentence,
  bothInSentence,
  checkMatches,
  expressInterestSentence,
  getStagePayload,
  nextAction,
  refuseAgentOptIn,
  type MatchRow,
} from '../../src/domain/matches.js';
import { OsbError } from '../../src/protocol.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side (looking for)
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side (offering)
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

/** The nouns no sentence a human hears may contain (the house register). */
const BANNED = /\b(cards?|channels?|match(es)?|stages?|connections?|scores?)\b/i;
/** The wire's own two words, which stay in the database and the matcher. The
 *  check is deliberately case-sensitive: "they have not" is ordinary English,
 *  and a HAVE is the thing this must never call itself. */
const WIRE_WORDS = /\b(WANT|HAVE)\b/;

const row = (over: Partial<MatchRow> = {}): MatchRow =>
  ({
    id: MATCH,
    card_want: CARD_W,
    card_have: CARD_H,
    account_want: ANA,
    account_have: BEPPE,
    score: 0.8,
    category: 'goods.bicycle.mountain',
    stage: 1,
    interest_want: false,
    interest_have: false,
    state: 'open',
    channel_id: null,
    opened_at: null,
    live: true,
    ...over,
  }) as MatchRow;

interface World {
  stage: number;
  /** How many introductions the sweep returns. */
  introductions: number;
  /** Whether the CALLER's own press is recorded (what the sweep query reads). */
  myOptin: boolean;
  /** Opt-ins on record, for the reads that go looking one match at a time. */
  optins: { n: number; mine: boolean };
}
let world: World;
let sql: string[];

function fakePool() {
  return {
    query: async (q: string, params: any[] = []) => {
      sql.push(q);
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/SELECT m\.\*[^;]*FROM matches m/.test(q)) {
        return rows(
          Array.from({ length: world.introductions }, (_, i) =>
            row({
              id: `aaaaaaaa-1111-4111-8111-aaaaaaaaaaa${i.toString(16)}`,
              stage: world.stage,
              interest_want: true,
              interest_have: true,
              my_optin: world.myOptin,
            }),
          ),
        );
      }
      if (/^\s*SELECT \* FROM matches WHERE id/.test(q)) {
        return rows([
          row({ stage: world.stage, interest_want: true, interest_have: true }),
        ]);
      }
      // The line behind this one, on the caller's own want or have.
      if (/count\(\*\)::int AS n FROM matches m/.test(q)) return rows([{ n: 0 }]);
      if (/count\(DISTINCT account_id\)::int AS n,/.test(q)) {
        return rows([{ n: world.optins.n, mine: world.optins.mine ? 1 : 0 }]);
      }
      if (/^\s*SELECT \* FROM cards WHERE id/.test(q)) {
        const mine = params[0] === CARD_W;
        return rows([
          {
            id: params[0],
            type: mine ? 'WANT' : 'HAVE',
            category: 'goods.bicycle.mountain',
            attributes: { frame: 'medium' },
            ask: null,
            lifecycle_state: 'PUBLISHED',
            account_id: mine ? ANA : BEPPE,
          },
        ]);
      }
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  world = { stage: 2, introductions: 1, myOptin: false, optins: { n: 0, mine: false } };
  sql = [];
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

// ---------------------------------------------------------------------------
describe('nextAction: the five states, and the one it was blind to', () => {
  it('a fresh signal, with nobody keen yet', () => {
    expect(nextAction(row(), ANA)).toBe('show_interest');
  });

  it('this side keen, the other side not', () => {
    expect(nextAction(row({ interest_want: true }), ANA)).toBe('awaiting_other_side');
    // And it is the other side's turn to say anything at all.
    expect(nextAction(row({ interest_want: true }), BEPPE)).toBe('show_interest');
  });

  it('both keen: the details are open and neither has pressed', () => {
    const m = row({ stage: 2, interest_want: true, interest_have: true });
    expect(nextAction(m, ANA)).toBe('details_unlocked');
    expect(nextAction(m, BEPPE)).toBe('details_unlocked');
  });

  it('THIS side has pressed and the other has not — the state that did not exist', () => {
    const m = row({ stage: 2, interest_want: true, interest_have: true });
    // Ana pressed. Stage cannot move until Beppe does, so the row looks the
    // same; the difference is the opt-in, and it is what the word turns on.
    expect(nextAction(m, ANA, true)).toBe('awaiting_their_go_ahead');
    // Beppe has pressed nothing, so for him it is unchanged.
    expect(nextAction(m, BEPPE, false)).toBe('details_unlocked');
    // The row may carry it instead of the caller passing it; same answer.
    expect(nextAction({ ...m, my_optin: true }, ANA)).toBe('awaiting_their_go_ahead');
  });

  it('both have pressed: there is nothing left to wait for', () => {
    const m = row({ stage: 3, interest_want: true, interest_have: true, my_optin: true });
    expect(nextAction(m, ANA)).toBe('ready_to_talk');
    expect(nextAction(m, BEPPE)).toBe('ready_to_talk');
  });

  it('a row read without the opt-in falls back to what it always said', () => {
    // No flag, no column: the answer is the pre-existing one, never a state
    // claimed on a fact nobody read.
    expect(nextAction(row({ stage: 2, interest_want: true, interest_have: true }), ANA)).toBe(
      'details_unlocked',
    );
  });
});

// ---------------------------------------------------------------------------
describe('the sweep says it, on whichever side pressed', () => {
  it('tells the side that pressed that their yes is in, and asks nothing of them', async () => {
    world.myOptin = true;
    const [entry]: any = await checkMatches(cfg, ANA);
    expect(entry.next).toBe('awaiting_their_go_ahead');
    const text: string = entry.note.text;
    expect(entry.note.provenance).toBe('switchboard-system');
    // (a) their own press landed, (b) what is waited on, (c) nothing to press.
    expect(text).toMatch(/your yes is in/i);
    expect(text).toMatch(/they have not given theirs yet/i);
    expect(text).not.toMatch(/link|press|confirm|button|page|again/i);
    // And it names the thing the way its own side would say it.
    expect(text).toMatch(/the mountain bike you are after/);
  });

  it('names the thing from the offering side too', async () => {
    world.myOptin = true;
    const [entry]: any = await checkMatches(cfg, BEPPE);
    expect(entry.next).toBe('awaiting_their_go_ahead');
    expect(entry.note.text).toMatch(/your mountain bike/);
  });

  it('says the arrival sentence to the side that has not pressed', async () => {
    world.myOptin = false;
    const [entry]: any = await checkMatches(cfg, ANA);
    expect(entry.next).toBe('details_unlocked');
    // The details are open from the start now, so the sentence before the
    // press is the one a new introduction arrives with: here is what they
    // have, and the go-ahead is the next step.
    expect(entry.note.text).toMatch(/Here is what they have/);
    expect(entry.note.text).toMatch(/first name and rough area/);
  });

  it('and the sweep is not the same as the one before the press', async () => {
    world.myOptin = false;
    const [before]: any = await checkMatches(cfg, ANA);
    world.myOptin = true;
    const [after]: any = await checkMatches(cfg, ANA);
    expect(after.next).not.toBe(before.next);
    expect(after.note.text).not.toBe(before.note.text);
  });
});

// ---------------------------------------------------------------------------
describe('it costs the sweep nothing', () => {
  it('reads the opt-in in the one query the sweep already ran, for any number of introductions', async () => {
    world.introductions = 12;
    world.myOptin = true;
    const out = await checkMatches(cfg, ANA);
    expect(out).toHaveLength(12);
    expect(out.every((e: any) => e.next === 'awaiting_their_go_ahead')).toBe(true);
    // ONE sweep query, and the opt-in rides on it.
    const sweepQueries = sql.filter((q) => /SELECT m\.\*[^;]*FROM matches m/.test(q));
    expect(sweepQueries).toHaveLength(1);
    expect(sweepQueries[0]).toMatch(/consent_tokens/);
    // NOT ONE read of consent_tokens standing on its own — per introduction
    // or at all. The only place the word appears is inside that one sweep.
    expect(sql.filter((q) => /consent_tokens/.test(q) && !/FROM matches m/.test(q))).toEqual([]);
    // And a twelfth introduction costs exactly what the first one did.
    const perIntro = sql.length;
    sql.length = 0;
    world.introductions = 1;
    await checkMatches(cfg, ANA);
    expect(perIntro - sql.length).toBe(11 * (sql.length - 1));
  });
});

// ---------------------------------------------------------------------------
describe('nothing else may contradict it', () => {
  it('respond(opt_in) answers the recorded press instead of handing over another link', async () => {
    world.optins = { n: 1, mine: true };
    const r = await refuseAgentOptIn(cfg, MATCH, ANA);
    expect(r.next).toBe('awaiting_their_go_ahead');
    expect(r.intro_id).toBe(MATCH);
    expect(r.note.text).toMatch(/your yes is in/i);
    // The refusal's link is what used to come back here. It must not.
    expect(JSON.stringify(r)).not.toMatch(/\/a\/|link/i);
  });

  it('respond(opt_in) still refuses, with the link, when the press has not happened', async () => {
    world.optins = { n: 0, mine: false };
    const e = await refuseAgentOptIn(cfg, MATCH, ANA).catch((x) => x);
    expect(e).toBeInstanceOf(OsbError);
    expect(e.payload.code).toBe('CONSENT_REQUIRED');
  });

  it('the names step refuses a pressed side without telling them to press', async () => {
    world.optins = { n: 1, mine: true };
    const e = await getStagePayload(cfg, ANA, MATCH, 3).catch((x) => x);
    expect(e).toBeInstanceOf(OsbError);
    expect(e.payload.code).toBe('NOT_UNLOCKED_YET');
    expect(e.payload.human_action).toMatch(/it is recorded/i);
    expect(e.payload.human_action).not.toMatch(/Ask your human to give the go-ahead/);
  });

  it('the names step still sends an unpressed side to their page', async () => {
    world.optins = { n: 0, mine: false };
    const e = await getStagePayload(cfg, ANA, MATCH, 3).catch((x) => x);
    expect(e.payload.human_action).toMatch(/Ask your human to give the go-ahead/);
  });

  it('the express_interest reply does not ask again for a go-ahead already given', () => {
    const m = row({ stage: 2, interest_want: true, interest_have: true, my_optin: true });
    const said = expressInterestSentence(m, ANA);
    expect(said).toMatch(/your yes is in/i);
    expect(said).not.toMatch(/give me the go-ahead/);
  });

  it('and still asks for it where it has not been given', () => {
    const m = row({ stage: 2, interest_want: true, interest_have: true });
    expect(expressInterestSentence(m, ANA)).toMatch(/give me the go-ahead/);
  });
});

// ---------------------------------------------------------------------------
describe('the copy is in the house register', () => {
  const lines = [
    awaitingTheirGoAheadSentence(row({ stage: 2 }), ANA),
    awaitingTheirGoAheadSentence(row({ stage: 2 }), BEPPE),
    bothInSentence(row({ stage: 3 }), ANA),
    bothInSentence(row({ stage: 3 }), BEPPE),
  ];

  it('names no machinery and runs no antithesis', () => {
    for (const line of lines) {
      expect(lintHumanCopy(line), line).toEqual([]);
      expect(BANNED.test(line), line).toBe(false);
      expect(WIRE_WORDS.test(line), line).toBe(false);
    }
  });

  it('says a whole thing, in plain words', () => {
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(40);
      expect(line).not.toMatch(/stage|opt.?in|consent|token|next|unlock/i);
    }
  });
});
