/**
 * THE POSTING IS THE STATEMENT OF INTEREST (Lachlan, 13 September 2026).
 *
 * Until today an introduction was made below the details step, and each side's
 * agent had to call respond(express_interest) before what the other person has
 * would open. At that moment the human knew the category and which side the
 * other person was on, and nothing else, so the only sane answer was always
 * yes: a gate everybody always passes is a step, not a gate. It cost a round
 * trip to a human on each side and told nobody anything.
 *
 * Two gates now, not three:
 *   - the details are open to BOTH sides the moment two things are put
 *     together, with no step in between;
 *   - sharing a first name and a suburb is still the human's own press,
 *     every single time;
 *   - talking is still behind that;
 *   - decline is still how somebody says no, and still the only way an agent
 *     closes an introduction.
 *
 * What is asserted here:
 *   - a new introduction is written keen on both sides with the details open;
 *   - the first sweep, on both sides, says what the other person has and that
 *     the go-ahead is the next step — and names no machinery;
 *   - express_interest writes nothing, from either chair, twice in a row, and
 *     never moves an introduction that is further along backwards;
 *   - the names step is untouched: still a press, even though the details are
 *     open from the start;
 *   - what migration 031 intends, said as behaviour: an open introduction that
 *     was below the details step reads as details_unlocked once it is moved up,
 *     and a declined one is left exactly where it was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

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
import {
  buildAttributes,
  checkMatches,
  createMatch,
  declineMatch,
  expressInterest,
  expressInterestSentence,
  nextAction,
  refuseAgentOptIn,
  type MatchRow,
} from '../../src/domain/matches.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the want side
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the have side
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const STRANGER = 'ffffffff-6666-4666-8666-ffffffffffff';

/** The words no sentence written for a human may ever carry. */
const BANNED = ['card', 'channel', 'match', 'stage', 'WANT', 'HAVE', 'connection', 'score'];

interface World {
  stage: number;
  interestWant: boolean;
  interestHave: boolean;
  state: 'open' | 'declined' | 'closed' | 'archived';
  channelId: string | null;
  myOptin: boolean;
  /** Every statement the code put to the database, for the no-op assertions. */
  sql: { sql: string; params: unknown[] }[];
}
let world: World;

const theMatch = () => ({
  id: MATCH,
  card_want: CARD_W,
  card_have: CARD_H,
  account_want: ANA,
  account_have: BEPPE,
  score: 0.8,
  category: 'goods.bicycle.mountain',
  stage: world.stage,
  interest_want: world.interestWant,
  interest_have: world.interestHave,
  state: world.state,
  channel_id: world.channelId,
  opened_at: null,
  live: true,
  my_optin: world.myOptin,
});

function fakePool() {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      world.sql.push({ sql, params });
      const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });
      if (/read_calls|write_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
      if (/SELECT arrangement FROM accounts/.test(sql)) return rows([{ arrangement: null }]);
      if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: 'email' }]);
      if (/SELECT timezone FROM accounts/.test(sql)) return rows([{ timezone: 'Australia/Perth' }]);
      if (/INSERT INTO matches/.test(sql)) return rows([{ id: MATCH }]);
      if (/^\s*SELECT m\.\*/.test(sql) && /FROM matches m/.test(sql)) return rows([theMatch()]);
      if (/^\s*SELECT \* FROM matches WHERE id/.test(sql)) return rows([theMatch()]);
      if (/SELECT card_want, card_have FROM matches/.test(sql)) {
        return rows([{ card_want: CARD_W, card_have: CARD_H }]);
      }
      if (/UPDATE matches SET state = 'declined'/.test(sql)) {
        world.state = 'declined';
        return rows([{ id: MATCH }]);
      }
      if (/count\(\*\)::int AS n FROM matches m/.test(sql)) return rows([{ n: 0 }]);
      if (/count\(DISTINCT account_id\)/.test(sql)) {
        return rows([{ n: world.myOptin ? 1 : 0, mine: world.myOptin ? 1 : 0 }]);
      }
      if (/FROM cards c/.test(sql)) return rows([]);
      if (/^\s*SELECT \* FROM cards WHERE id/.test(sql)) {
        const id = params[0] as string;
        return rows([
          {
            id,
            account_id: id === CARD_W ? ANA : BEPPE,
            type: id === CARD_W ? 'WANT' : 'HAVE',
            category: 'goods.bicycle.mountain',
            attributes: { frame: 'medium' },
            ask: id === CARD_H ? { amount: 420, ccy: 'AUD' } : null,
            lifecycle_state: 'PUBLISHED',
          },
        ]);
      }
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  world = {
    stage: 2,
    interestWant: true,
    interestHave: true,
    state: 'open',
    channelId: null,
    myOptin: false,
    sql: [],
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

const row = (over: Partial<MatchRow> = {}): MatchRow =>
  ({ ...theMatch(), ...over }) as unknown as MatchRow;

/** The one introduction, as the given chair's sweep hands it back. */
async function sweep(who: string): Promise<any> {
  const [entry] = (await checkMatches(cfg, who)) as any[];
  return entry;
}

// ---------------------------------------------------------------------------
describe('a new introduction is born keen on both sides', () => {
  it('is written at the details step with both interest columns true', async () => {
    await createMatch(CARD_W, CARD_H, 0.8);
    const insert = world.sql.find((q) => /INSERT INTO matches/.test(q.sql))!;
    expect(insert).toBeTruthy();
    // The columns stay and keep their meaning; what changed is when they are
    // true — at the introduction, not at a second asking.
    expect(insert.sql).toMatch(/stage, interest_want, interest_have/);
    expect(insert.sql.replace(/\s+/g, ' ')).toContain('2,true,true');
  });

  it('reads as details_unlocked to both sides at once', () => {
    expect(nextAction(row(), ANA)).toBe('details_unlocked');
    expect(nextAction(row(), BEPPE)).toBe('details_unlocked');
  });

  it('hands the details over on the very first sweep, to both sides', async () => {
    const forAna = await sweep(ANA);
    const forBeppe = await sweep(BEPPE);
    expect(forAna.next).toBe('details_unlocked');
    expect(forBeppe.next).toBe('details_unlocked');
    expect(forAna.attributes.attributes).toEqual({ frame: 'medium' });
    expect(forBeppe.attributes.attributes).toEqual({ frame: 'medium' });
    // The seller's asking price is part of what a buyer can see; the seller is
    // shown the buyer's attributes and no figure of any kind.
    expect(forAna.attributes.ask).toEqual({ amount: 420, ccy: 'AUD' });
    expect(forBeppe.attributes.ask).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('the first sweep sentence, on each side', () => {
  it('tells the buyer what the other person has and asks for the go-ahead', async () => {
    const note: string = (await sweep(ANA)).note.text;
    expect(note).toMatch(/Someone nearby has a mountain bike going/);
    expect(note).toMatch(/Here is what they have/);
    expect(note).toMatch(/share your first name and suburb/);
    // Nothing is asked of the human about being keen, because nothing is owed.
    expect(note).not.toMatch(/let them know you're keen|tell them you are keen|if they're keen/i);
  });

  it('tells the seller what the other person is after, in their own words', async () => {
    const note: string = (await sweep(BEPPE)).note.text;
    expect(note).toMatch(/Someone nearby is looking for a mountain bike like yours/);
    expect(note).toMatch(/Here is what they're after/);
    expect(note).toMatch(/share your first name and suburb/);
  });

  it('names no machinery on either side', async () => {
    for (const who of [ANA, BEPPE]) {
      const note: string = (await sweep(who)).note.text;
      for (const word of BANNED) {
        expect(new RegExp(`\\b${word}s?\\b`, word === word.toUpperCase() ? '' : 'i').test(note)).toBe(
          false,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('express_interest is kept and does nothing', () => {
  const wroteToMatches = () =>
    world.sql.filter((q) => /^\s*UPDATE matches/i.test(q.sql)).map((q) => q.sql);

  it('writes nothing, from either chair', async () => {
    await expressInterest(cfg, MATCH, ANA);
    await expressInterest(cfg, MATCH, BEPPE);
    expect(wroteToMatches()).toEqual([]);
  });

  it('answers the same thing twice in a row', async () => {
    const first = await expressInterest(cfg, MATCH, ANA);
    const again = await expressInterest(cfg, MATCH, ANA);
    expect(nextAction(again, ANA)).toBe(nextAction(first, ANA));
    expect(expressInterestSentence(again, ANA)).toBe(expressInterestSentence(first, ANA));
    expect(wroteToMatches()).toEqual([]);
  });

  it('says what is already true and never that the human has just done something', () => {
    const said = expressInterestSentence(row(), ANA);
    expect(said).toMatch(/already down as keen/);
    expect(said).not.toMatch(/passed that on|I have told them|I have let them know/i);
    expect(said).toMatch(/give me the go-ahead/);
  });

  it('moves nothing backwards for an introduction already past the details', async () => {
    world.stage = 3;
    world.myOptin = true;
    const m = await expressInterest(cfg, MATCH, ANA);
    expect(m.stage).toBe(3);
    expect(nextAction(m, ANA)).toBe('ready_to_talk');
    expect(expressInterestSentence(m, ANA)).toMatch(/You have both said yes/);
    expect(wroteToMatches()).toEqual([]);
  });

  it('moves nothing backwards once the two of them are talking', async () => {
    world.stage = 4;
    world.channelId = 'ch_1';
    world.myOptin = true;
    const m = await expressInterest(cfg, MATCH, BEPPE);
    expect(m.stage).toBe(4);
    expect(m.channel_id).toBe('ch_1');
    expect(nextAction(m, BEPPE)).toBe('ready_to_talk');
    expect(wroteToMatches()).toEqual([]);
  });

  it('still refuses somebody who is not a party to it', async () => {
    await expect(expressInterest(cfg, MATCH, STRANGER)).rejects.toMatchObject({ notFound: true });
  });

  it('still refuses an introduction that is closed', async () => {
    world.state = 'declined';
    await expect(expressInterest(cfg, MATCH, ANA)).rejects.toBeInstanceOf(OsbError);
  });
});

// ---------------------------------------------------------------------------
describe('the two gates that are left', () => {
  it('the names step is still the human’s own press, details or no details', async () => {
    const e = await refuseAgentOptIn(cfg, MATCH, ANA).catch((x) => x);
    expect(e).toBeInstanceOf(OsbError);
    expect(e.payload.code).toBe('CONSENT_REQUIRED');
  });

  it('and it says so again on the next asking, once the press is recorded', async () => {
    world.myOptin = true;
    const r: any = await refuseAgentOptIn(cfg, MATCH, ANA);
    expect(r.next).toBe('awaiting_their_go_ahead');
    expect(r.note.text).toMatch(/your yes is in/i);
  });

  it('decline still closes it, and the line still moves up behind it', async () => {
    const promoted = await declineMatch(MATCH, ANA, cfg);
    expect(world.state).toBe('declined');
    expect(Array.isArray(promoted)).toBe(true);
    // Resequencing both sides is what frees the slot for whoever is next.
    expect(world.sql.some((q) => /SELECT card_want, card_have FROM matches/.test(q.sql))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Migration 031, said as behaviour rather than as SQL: every OPEN introduction
// below the details step moves up to it with both interest columns true, and
// a declined, archived or closed one is left exactly as it is.
// ---------------------------------------------------------------------------
describe('what migration 031 intends', () => {
  it('an open introduction that was below the details step reads as open once moved up', async () => {
    // Before: a row made yesterday, one side keen, details shut.
    const before = row({ stage: 1, interest_want: true, interest_have: false });
    expect(nextAction(before, ANA)).toBe('awaiting_other_side');
    await expect(buildAttributes(before, ANA)).rejects.toBeInstanceOf(OsbError);
    // After the migration has moved it up, it is an ordinary introduction.
    const after = row({ stage: 2, interest_want: true, interest_have: true });
    expect(nextAction(after, ANA)).toBe('details_unlocked');
    expect(nextAction(after, BEPPE)).toBe('details_unlocked');
    expect((await buildAttributes(after, ANA)).attributes).toEqual({ frame: 'medium' });
  });

  it('a declined one stays exactly where it was and discloses nothing', async () => {
    const declined = row({ state: 'declined', stage: 1, interest_want: true, interest_have: false });
    await expect(buildAttributes(declined, ANA)).rejects.toBeInstanceOf(OsbError);
  });

  it('and the migration itself touches only the open ones', () => {
    const sql = readFileSync(
      new URL('../../migrations/031_posting_is_interest.sql', import.meta.url),
      'utf8',
    );
    const update = sql.slice(sql.indexOf('UPDATE matches'));
    expect(update).toMatch(/WHERE state = 'open' AND stage < 2;/);
    expect(update).toMatch(/interest_want = true, interest_have = true/);
    // Nothing finished is rewritten.
    expect(update).not.toMatch(/declined|archived|closed/);
  });
});
