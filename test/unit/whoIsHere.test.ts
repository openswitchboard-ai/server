/**
 * "Is there a match yet?" answered from the wrong list.
 *
 * The defect, from the rehearsal of 2026-09-13: a human asked their assistant
 * whether anybody had turned up. The assistant listed their human's own wants
 * and haves, saw one was published, and said no. Somebody had been live on it
 * for thirteen minutes and a second person was waiting behind them. The list
 * carried no sign of either, so the confident wrong answer was the easy one.
 *
 * What is asserted here: every want and have that is still up comes back
 * saying how many people are with it and how many are waiting their turn, plus
 * one sentence a human can hear as-is — and the counting of all of them costs
 * exactly one extra statement however long the list is. Something withdrawn,
 * expired or turned away at screening is left alone: none of those can have
 * anybody on them, and "nothing yet" about them would be a small lie.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../../src/db.js';
import { listIntents } from '../../src/domain/cards.js';
import { lintHumanCopy } from '../../src/email/lint.js';

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BIKE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const OTHER = 'cccccccc-3333-4333-8333-cccccccccccc';
const SLUG = 'goods.bicycle.mountain';

/**
 * Words no sentence written for a human may carry. The everyday verbs "want"
 * and "have" are ordinary English and stay; only the shouted protocol
 * spellings are banned, so those two are matched case-sensitively.
 */
const BANNED = [
  /\b(cards?|channels?|match(es)?|stages?|connections?|scores?)\b/i,
  /\bWANT\b/,
  /\bHAVE\b/,
];
const saysMachinery = (text: string) => BANNED.some((re) => re.test(text));

interface Intro {
  card: string;
  live: boolean;
  state: 'open' | 'declined' | 'closed' | 'archived';
}

interface World {
  cards: Record<string, any>[];
  intros: Intro[];
  /** Every statement the call made, so the extra work can be counted. */
  sql: string[];
}

let world: World;

const card = (over: Record<string, any> = {}) => ({
  id: BIKE,
  schema_version: '0.14.0',
  type: 'HAVE',
  category: SLUG,
  geo: { place: 'Fremantle', radius_km: 20 },
  attributes: {},
  ask: null,
  urgency: 'none',
  visibility: 'public',
  protocol_status: 'active',
  lifecycle_state: 'PUBLISHED',
  ttl_days: 60,
  expires_at: new Date('2026-11-01T00:00:00Z'),
  created_at: new Date('2026-09-01T00:00:00Z'),
  updated_at: new Date('2026-09-01T00:00:00Z'),
  screening: null,
  slots: 1,
  sale: 'straight',
  ...over,
});

const intro = (over: Partial<Intro> = {}): Intro => ({
  card: BIKE,
  live: false,
  state: 'open',
  ...over,
});

/** Enough PostgreSQL for listIntents: the rows, the zone, and the count. */
function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      world.sql.push(s);
      if (s.startsWith('SELECT timezone FROM accounts')) {
        return { rows: [{ timezone: null }], rowCount: 0 };
      }
      if (s.startsWith('SELECT id, schema_version, type, category')) {
        return { rows: world.cards, rowCount: world.cards.length };
      }
      if (s.startsWith('SELECT t.cid,')) {
        const ids: string[] = params[0] ?? [];
        const rows = ids
          .map((id) => {
            const mine = world.intros.filter((m) => m.card === id && m.state === 'open');
            return {
              cid: id,
              here: mine.filter((m) => m.live).length,
              waiting: mine.filter((m) => !m.live).length,
            };
          })
          .filter((r) => r.here + r.waiting > 0);
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

beforeEach(() => {
  world = { cards: [card()], intros: [], sql: [] };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

/** The one entry, and the sentence a human would actually hear. */
const only = async () => (await listIntents(ACCOUNT))[0];

// ---------------------------------------------------------------------------
// The counts
// ---------------------------------------------------------------------------
describe('who is with a want or a have, on the list of them', () => {
  it('says nobody is there when nobody is', async () => {
    const e = await only();
    expect(e.people_here).toBe(0);
    expect(e.in_line).toBe(0);
  });

  it('counts the person who is live and the people waiting their turn', async () => {
    world.intros = [intro({ live: true }), intro(), intro()];
    const e = await only();
    expect(e.people_here).toBe(1);
    expect(e.in_line).toBe(2);
  });

  it('counts nobody from an introduction that is declined, closed or filed away', async () => {
    world.intros = [
      intro({ live: true, state: 'archived' }),
      intro({ state: 'declined' }),
      intro({ state: 'closed' }),
    ];
    const e = await only();
    expect(e.people_here).toBe(0);
    expect(e.in_line).toBe(0);
  });

  it('counts the whole list in ONE extra statement, however long the list is', async () => {
    world.cards = [card(), card({ id: OTHER, type: 'WANT' })];
    world.intros = [intro({ live: true }), intro({ card: OTHER, live: true })];
    const out = await listIntents(ACCOUNT);
    expect(out.map((e) => e.people_here)).toEqual([1, 1]);
    expect(world.sql.filter((s) => s.startsWith('SELECT t.cid,'))).toHaveLength(1);
  });

  it('asks for nothing at all when the human has nothing up to ask about', async () => {
    world.cards = [];
    expect(await listIntents(ACCOUNT)).toEqual([]);
    expect(world.sql.filter((s) => s.startsWith('SELECT t.cid,'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------
describe('the one sentence the agent leads with', () => {
  const clean = (text: string) => {
    expect(saysMachinery(text), text).toBe(false);
    expect(lintHumanCopy(text)).toEqual([]);
  };

  it('nobody: says so plainly and promises to speak up', async () => {
    const e = await only();
    expect(e.note.text).toBe(
      "Nothing yet on your mountain bike. I'll say the moment somebody comes forward.",
    );
    expect(e.note.provenance).toBe('switchboard-system');
    clean(e.note.text);
  });

  it('one person, nobody waiting: one person has come forward', async () => {
    world.intros = [intro({ live: true })];
    const e = await only();
    expect(e.note.text).toBe(
      'One person has come forward about your mountain bike. Check in for what to do next.',
    );
    clean(e.note.text);
  });

  it('one person with one behind them: pluralises the one waiting', async () => {
    world.intros = [intro({ live: true }), intro()];
    const e = await only();
    expect(e.note.text).toBe(
      'One person has come forward about your mountain bike, and one more person is waiting their turn behind them. Check in for what to do next.',
    );
    clean(e.note.text);
  });

  it('one person with several behind them: pluralises the ones waiting', async () => {
    world.intros = [intro({ live: true }), intro(), intro(), intro()];
    const e = await only();
    expect(e.note.text).toBe(
      'One person has come forward about your mountain bike, and 3 more people are waiting their turn behind them. Check in for what to do next.',
    );
    clean(e.note.text);
  });

  it('several at once, where the human asked for several: phrases it for the count', async () => {
    world.cards = [card({ slots: 3 })];
    world.intros = [intro({ live: true }), intro({ live: true }), intro()];
    const e = await only();
    expect(e.note.text).toBe(
      '2 people have come forward about your mountain bike, and one more person is waiting their turn behind that. Check in for what to do next.',
    );
    clean(e.note.text);
  });

  it('names the thing the way the person looking would say it', async () => {
    world.cards = [card({ type: 'WANT' })];
    world.intros = [intro({ live: true })];
    const e = await only();
    expect(e.note.text).toBe(
      'One person has come forward about the mountain bike you are after. Check in for what to do next.',
    );
    clean(e.note.text);
  });

  it('says who is waiting even in the moment when nobody is live', async () => {
    world.intros = [intro(), intro()];
    const e = await only();
    expect(e.note.text).toBe(
      '2 people are waiting their turn on your mountain bike. Check in for what to do next.',
    );
    clean(e.note.text);
  });
});

// ---------------------------------------------------------------------------
// Where it does NOT belong
// ---------------------------------------------------------------------------
describe('something that is no longer up', () => {
  for (const state of ['WITHDRAWN', 'EXPIRED', 'SCREENING_REJECTED', 'PENDING_SCREENING']) {
    it(`says nothing at all about people on a ${state} one`, async () => {
      world.cards = [card({ lifecycle_state: state })];
      const e = await only();
      expect(e.state).toBe(state);
      expect(e.people_here).toBeUndefined();
      expect(e.in_line).toBeUndefined();
      expect(e.note).toBeUndefined();
    });
  }

  it('still counts the ones beside it that ARE up', async () => {
    world.cards = [card({ id: OTHER, lifecycle_state: 'WITHDRAWN' }), card()];
    world.intros = [intro({ live: true })];
    const out = await listIntents(ACCOUNT);
    expect(out[0].note).toBeUndefined();
    expect(out[1].people_here).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// What the agent is told about the list itself
// ---------------------------------------------------------------------------
describe('the words handed to the model', () => {
  it('sends an agent asking about those people to the sweep instead', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const d = TOOLS.find((t) => t.name === 'list_intents')!.description;
    expect(d).toContain('how many people have come forward');
    expect(d).toContain('waiting their turn');
    expect(d).toContain('check_in');
    expect(saysMachinery(d), d).toBe(false);
  });
});
