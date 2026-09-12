/**
 * The fit sequencer: the line, the slots, the clock, and the two ways to sell.
 *
 * What this suite is holding shut, defect by defect.
 *
 *  1. THE CROWD. The collection window introduced everybody at once and then
 *     froze the holder for six hours. The rules asserted here are the opposite
 *     shape: one live introduction at a time unless the human said otherwise,
 *     the rest in line, and nothing blocking anybody.
 *  2. SILENCE. The people who came second were told nothing at all. A person
 *     in line now gets one sentence saying their turn will come.
 *  3. SCARCITY THEATRE. Every count, position and hint about the line is a
 *     leak. The holder's own count of their own line is the ONLY number that
 *     crosses, and it never crosses to the other side.
 *  4. THE BIDDING RACE. A best offer takes one sealed number from each buyer.
 *     A buyer's agent must not be able to learn one thing about anybody else's
 *     number by any road, and the seller must not see any of them until the
 *     window closes. Asserted by walking every read an agent has.
 *  5. THE PRIVATE BAND. The underpricing note reads five people's sealed
 *     ceilings and says one sentence with no figure and no count in it. Below
 *     five it says nothing at all, because below five it would be about one or
 *     two people rather than about the market.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

import * as db from '../../src/db.js';
import * as matches from '../../src/domain/matches.js';
import * as offers from '../../src/domain/offers.js';
import * as sequencer from '../../src/domain/sequencer.js';
import { clearsAskWithRoom, limitsOverlap } from '../../src/domain/matchRules.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
  quotas: { maxOffersPerHour: 50, maxCardsPerDay: 50 },
} as unknown as Config;

const SELLER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const HAVE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const buyer = (n: number) => `cccccccc-3333-4333-8333-${String(n).padStart(12, '0')}`;
const wantCard = (n: number) => `dddddddd-4444-4444-8444-${String(n).padStart(12, '0')}`;
const introId = (n: number) => `eeeeeeee-5555-4555-8555-${String(n).padStart(12, '0')}`;

/** Words no sentence written for a human may carry. */
const BANNED = /\b(cards?|channels?|match(es)?|stages?|connections?|scores?)\b|\bWANT\b|\bHAVE\b/i;

// ---------------------------------------------------------------------------
// A small board: one have, N wants, one introduction each.
// ---------------------------------------------------------------------------
interface Intro {
  id: string;
  n: number;
  live: boolean;
  state: string;
  limits_overlap: boolean;
  clears_ask_25: boolean;
  created_at: Date;
  archived_via?: string | null;
  last_movement_at: Date;
}

interface World {
  slots: number;
  sale: 'straight' | 'best-offer';
  ask: { amount: number; ccy: string } | null;
  gatherUntil: Date | null;
  gatherClosedAt: Date | null;
  priceNoteAt: Date | null;
  urgency: string;
  intros: Intro[];
  offers: {
    id: string;
    match_id: string;
    proposer_account: string;
    amount: string;
    ccy: string;
    state: string;
    message: any;
    authored_by: string;
    created_at: Date;
  }[];
  /** Reliability per buyer, for the ranking. */
  reliability: Record<string, number>;
  /** Distance per buyer, expressed as a longitude offset from the have. */
  away: Record<string, number>;
  summoned: string[];
}
let world: World;

const intro = (n: number, over: Partial<Intro> = {}): Intro => ({
  id: introId(n),
  n,
  live: false,
  state: 'open',
  limits_overlap: true,
  clears_ask_25: false,
  created_at: new Date(Date.UTC(2026, 8, 12, 9, n)),
  last_movement_at: new Date(Date.UTC(2026, 8, 12, 9, n)),
  ...over,
});

const rowOf = (i: Intro) => ({
  id: i.id,
  card_want: wantCard(i.n),
  card_have: HAVE,
  account_want: buyer(i.n),
  account_have: SELLER,
  score: 0.8,
  category: 'goods.bicycle.mountain',
  stage: 2,
  interest_want: true,
  interest_have: true,
  state: i.state,
  channel_id: null,
  opened_at: null,
  live: i.live,
  last_movement_at: i.last_movement_at,
  created_at: i.created_at,
  limits_overlap: i.limits_overlap,
  clears_ask_25: i.clears_ask_25,
  archived_via: i.archived_via ?? null,
  archived_at: i.state === 'archived' ? new Date() : null,
});

const gatherOpen = () =>
  world.sale === 'best-offer' &&
  !!world.gatherUntil &&
  world.gatherUntil > new Date() &&
  !world.gatherClosedAt;

function fakePool() {
  const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
  return {
    query: async (sql: string, params: any[] = []) => {
      // --- read ceiling / account odds and ends -----------------------------
      if (/read_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
      if (/SELECT arrangement FROM accounts/.test(sql)) return rows([{ arrangement: null }]);
      if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: 'email' }]);
      if (/SELECT timezone FROM accounts/.test(sql)) return rows([{ timezone: null }]);
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) return rows([]);

      // --- the line, as the sequencer reads it ------------------------------
      if (/JOIN cards own ON own\.id/.test(sql)) {
        if (params[0] !== HAVE) {
          // A buyer's own want: one introduction, one slot.
          const i = world.intros.find((x) => wantCard(x.n) === params[0]);
          if (!i || i.state !== 'open') return rows([]);
          return rows([
            {
              id: i.id,
              live: i.live,
              limits_overlap: i.limits_overlap,
              created_at: i.created_at,
              other_card: HAVE,
              own_urgency: 'none',
              own_slots: 1,
              own_sale: 'straight',
              own_gather_open: false,
              own_lat: 0,
              own_lon: world.away[buyer(i.n)] ?? 0,
              other_urgency: world.urgency,
              other_lat: 0,
              other_lon: 0,
              reliability: 0.5,
            },
          ]);
        }
        return rows(
          world.intros
            .filter((i) => i.state === 'open')
            .map((i) => ({
              id: i.id,
              live: i.live,
              limits_overlap: i.limits_overlap,
              created_at: i.created_at,
              other_card: wantCard(i.n),
              own_urgency: world.urgency,
              own_slots: world.slots,
              own_sale: world.sale,
              own_gather_open: gatherOpen(),
              own_lat: 0,
              own_lon: 0,
              other_urgency: 'none',
              other_lat: 0,
              other_lon: world.away[buyer(i.n)] ?? 0,
              reliability: world.reliability[buyer(i.n)] ?? 0.5,
            })),
        );
      }

      // --- how many slots a want or have has free ---------------------------
      if (/SELECT c\.slots, c\.sale/.test(sql)) {
        const isHave = params[0] === HAVE;
        const live = world.intros.filter(
          (i) =>
            i.state === 'open' &&
            i.live &&
            (isHave ? true : wantCard(i.n) === params[0]),
        ).length;
        return rows([
          {
            slots: isHave ? world.slots : 1,
            sale: isHave ? world.sale : 'straight',
            gather_open: isHave && gatherOpen(),
            live_now: live,
          },
        ]);
      }

      // --- promotion --------------------------------------------------------
      if (/UPDATE matches SET live = true/.test(sql)) {
        const i = world.intros.find((x) => x.id === params[0]);
        if (!i || i.live || i.state !== 'open') return rows([]);
        i.live = true;
        i.last_movement_at = new Date();
        return rows([{ id: i.id }]);
      }
      if (/UPDATE matches SET last_movement_at/.test(sql)) {
        const i = world.intros.find((x) => x.id === params[0]);
        if (i) i.last_movement_at = new Date();
        return rows([]);
      }

      // --- the lapse sweep ---------------------------------------------------
      if (/m\.last_movement_at < now\(\)/.test(sql)) {
        const cut = world.urgency === 'today' ? 120 : 24 * 60;
        return rows(
          world.intros
            .filter(
              (i) =>
                i.state === 'open' &&
                i.live &&
                !gatherOpen() &&
                Date.now() - +i.last_movement_at > cut * 60_000,
            )
            .map((i) => ({ id: i.id })),
        );
      }
      if (/archived_via = 'lapsed'/.test(sql) && /WHERE id = \$1/.test(sql)) {
        const i = world.intros.find((x) => x.id === params[0]);
        if (!i || i.state !== 'open' || !i.live) return rows([]);
        i.state = 'archived';
        i.archived_via = 'lapsed';
        i.live = false;
        return rows([{ id: i.id }]);
      }
      if (/archived_via = 'lapsed'/.test(sql)) {
        // the gathering-window sweep: everyone who put no number in
        const gone = world.intros.filter(
          (i) => i.state === 'open' && !world.offers.some((o) => o.match_id === i.id),
        );
        for (const i of gone) {
          i.state = 'archived';
          i.archived_via = 'lapsed';
          i.live = false;
        }
        return rows(gone.map((i) => ({ id: i.id })));
      }
      if (/archived_via = 'not-chosen'/.test(sql)) {
        const gone = world.intros.filter((i) => i.state === 'open' && i.id !== params[1]);
        for (const i of gone) {
          i.state = 'archived';
          i.archived_via = 'not-chosen';
          i.live = false;
        }
        return rows(gone.map((i) => ({ id: i.id })));
      }
      if (/UPDATE offers o SET state = 'declined'/.test(sql)) {
        for (const o of world.offers) if (o.id !== params[1]) o.state = 'declined';
        return rows([]);
      }

      // --- the gathering window ---------------------------------------------
      if (/UPDATE cards c\s+SET gather_until/.test(sql)) {
        if (params[0] !== HAVE || world.sale !== 'best-offer') return rows([]);
        if (world.gatherUntil || world.gatherClosedAt) return rows([]);
        if (!world.intros.some((i) => i.state === 'open')) return rows([]);
        world.gatherUntil = new Date(Date.now() + 60_000);
        return rows([{ id: HAVE }]);
      }
      if (/SET gather_closed_at = now\(\)/.test(sql)) {
        if (!world.gatherUntil || world.gatherUntil > new Date() || world.gatherClosedAt) {
          return rows([]);
        }
        world.gatherClosedAt = new Date();
        return rows([{ id: HAVE }]);
      }

      // --- how many are in line (the holder's own count) ---------------------
      if (/count\(\*\)::int AS n FROM matches m/.test(sql)) {
        const isHave = params[0] === HAVE;
        return rows([
          {
            n: world.intros.filter(
              (i) =>
                i.state === 'open' && !i.live && (isHave ? true : wantCard(i.n) === params[0]),
            ).length,
          },
        ]);
      }

      // --- the sweep ---------------------------------------------------------
      if (/SELECT m\.\* FROM matches m/.test(sql)) {
        const me = params[0];
        return rows(
          world.intros
            .filter((i) => me === SELLER || buyer(i.n) === me)
            .map(rowOf)
            .reverse(),
        );
      }
      if (/^\s*SELECT \* FROM matches WHERE id/.test(sql)) {
        const i = world.intros.find((x) => x.id === params[0]);
        return rows(i ? [rowOf(i)] : []);
      }
      if (/SELECT c\.id FROM matches m JOIN cards c/.test(sql)) {
        return rows(world.sale === 'best-offer' ? [{ id: HAVE }] : []);
      }
      if (/SELECT card_want, card_have FROM matches/.test(sql)) {
        const i = world.intros.find((x) => x.id === params[0]);
        return rows(i ? [{ card_want: wantCard(i.n), card_have: HAVE }] : []);
      }

      // --- cards -------------------------------------------------------------
      if (/SELECT c\.id AS card_id, c\.sale/.test(sql)) {
        return rows([
          {
            card_id: HAVE,
            sale: world.sale,
            ask: world.ask,
            gather_until: world.gatherUntil,
            gather_closed_at: world.gatherClosedAt,
            open: gatherOpen(),
          },
        ]);
      }
      if (/SELECT id, account_id, sale, category/.test(sql)) {
        return rows([
          {
            id: HAVE,
            account_id: SELLER,
            sale: world.sale,
            category: 'goods.bicycle.mountain',
            geo_lat: 0,
            geo_lon: 0,
            gather_until: world.gatherUntil,
            gather_closed_at: world.gatherClosedAt,
          },
        ]);
      }
      if (/^\s*SELECT \* FROM cards WHERE id/.test(sql)) {
        const isHave = params[0] === HAVE;
        return rows([
          {
            id: params[0],
            account_id: isHave ? SELLER : buyer(Number(String(params[0]).slice(-1))),
            type: isHave ? 'HAVE' : 'WANT',
            category: 'goods.bicycle.mountain',
            attributes: {},
            ask: isHave ? world.ask : null,
            lifecycle_state: 'PUBLISHED',
            slots: isHave ? world.slots : 1,
            sale: isHave ? world.sale : 'straight',
          },
        ]);
      }

      // --- the underpricing note --------------------------------------------
      if (/AS fitting/.test(sql)) {
        if (world.sale !== 'straight' || !world.ask || world.priceNoteAt) return rows([]);
        if (params[1] !== SELLER || params[0] !== HAVE) return rows([]);
        const open = world.intros.filter((i) => i.state === 'open');
        return rows([
          {
            id: HAVE,
            fitting: open.length,
            with_room: open.filter((i) => i.clears_ask_25).length,
          },
        ]);
      }
      if (/SET price_note_at = now\(\)/.test(sql)) {
        if (world.priceNoteAt) return rows([]);
        world.priceNoteAt = new Date();
        return rows([{ id: HAVE }]);
      }

      // --- offers ------------------------------------------------------------
      if (/SELECT 1 FROM offers/.test(sql)) {
        return rows(
          world.offers.filter((o) => o.match_id === params[0] && o.proposer_account === params[1]),
        );
      }
      if (/SELECT amount, ccy, message FROM offers/.test(sql)) {
        return rows(
          world.offers.filter(
            (o) => o.match_id === params[0] && o.proposer_account !== params[1],
          ),
        );
      }
      if (/SELECT id, proposer_account, amount, ccy, state, message, authored_by/.test(sql)) {
        return rows(world.offers.filter((o) => o.match_id === params[0]));
      }
      if (/SELECT o\.id, o\.match_id, o\.amount/.test(sql)) {
        return rows(
          [...world.offers]
            .sort((a, b) => Number(b.amount) - Number(a.amount))
            .map((o) => ({
              id: o.id,
              match_id: o.match_id,
              amount: o.amount,
              ccy: o.ccy,
              message: o.message,
              want_urgency: 'none',
              want_lat: 0,
              want_lon: world.away[o.proposer_account] ?? 0,
              reliability: world.reliability[o.proposer_account] ?? 0.5,
            })),
        );
      }
      if (/SELECT \* FROM offers WHERE match_id/.test(sql)) {
        return rows(world.offers.filter((o) => o.match_id === params[0]));
      }
      if (/SELECT \* FROM offers WHERE id/.test(sql)) {
        return rows(world.offers.filter((o) => o.id === params[0]));
      }
      if (/UPDATE offers SET state='accepted-by-human'/.test(sql)) {
        const o = world.offers.find((x) => x.id === params[0]);
        if (o) o.state = 'accepted-by-human';
        return rows(o ? [o] : []);
      }
      if (/INSERT INTO consent_tokens/.test(sql)) return rows([]);
      if (/INSERT INTO offers/.test(sql)) {
        const row = {
          id: `0f0f0f0f-0000-4000-8000-${String(world.offers.length + 1).padStart(12, '0')}`,
          match_id: params[0],
          proposer_account: params[1],
          amount: String(params[2]),
          ccy: params[3],
          state: 'proposed',
          message: params[5] ? JSON.parse(params[5]) : null,
          authored_by: params[6],
          created_at: new Date(),
          expiry: new Date(Date.now() + 86_400_000),
        };
        world.offers.push(row);
        return rows([row]);
      }
      if (/SELECT amount FROM offers/.test(sql)) return rows([]);
      // The two offer quotas: nothing sent recently in any of these worlds.
      if (/count\(\*\)::int AS n[\s\S]*?FROM offers/.test(sql)) {
        return rows([{ n: 0, oldest: null }]);
      }
      if (/UPDATE matches SET state = 'declined'/.test(sql)) {
        const i = world.intros.find((x) => x.id === params[0]);
        if (i) {
          i.state = 'declined';
          i.live = false;
        }
        return rows([]);
      }
      if (/publish_events|reputation|probing_flags|offer_drafts/.test(sql)) {
        return rows([]);
      }
      if (/UPDATE channel_messages/.test(sql)) return rows([]);
      if (/negotiation|mandate/.test(sql)) return rows([{ negotiation_mode: 'relay' }]);
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  world = {
    slots: 1,
    sale: 'straight',
    ask: null,
    gatherUntil: null,
    gatherClosedAt: null,
    priceNoteAt: null,
    urgency: 'none',
    intros: [],
    offers: [],
    reliability: {},
    away: {},
    summoned: [],
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

// ---------------------------------------------------------------------------
describe('the order of the line', () => {
  const fact = (over: Partial<sequencer.FitFacts>): sequencer.FitFacts => ({
    matchId: 'x',
    limitsOverlap: false,
    distanceKm: 10,
    urgencyMatch: false,
    reliability: 0.5,
    arrivedAt: 0,
    ...over,
  });

  it('puts a known limit overlap first, and never says by how much', () => {
    const order = sequencer.rankByFit([
      fact({ matchId: 'no', limitsOverlap: false, distanceKm: 1 }),
      fact({ matchId: 'yes', limitsOverlap: true, distanceKm: 500 }),
    ]);
    expect(order.map((f) => f.matchId)).toEqual(['yes', 'no']);
    // The fact itself is a boolean, so there is no amount to rank on even in
    // principle: a private band cannot be read back out of the order.
    expect(typeof order[0].limitsOverlap).toBe('boolean');
  });

  it('then distance, then agreeing urgency, then reliability, then arrival', () => {
    const near = fact({ matchId: 'near', limitsOverlap: true, distanceKm: 2 });
    const far = fact({ matchId: 'far', limitsOverlap: true, distanceKm: 40 });
    expect(sequencer.rankByFit([far, near])[0].matchId).toBe('near');

    const today = fact({ matchId: 'today', limitsOverlap: true, urgencyMatch: true });
    const someday = fact({ matchId: 'someday', limitsOverlap: true, urgencyMatch: false });
    expect(sequencer.rankByFit([someday, today])[0].matchId).toBe('today');

    const solid = fact({ matchId: 'solid', limitsOverlap: true, reliability: 0.9 });
    const new_ = fact({ matchId: 'new', limitsOverlap: true, reliability: 0.2 });
    expect(sequencer.rankByFit([new_, solid])[0].matchId).toBe('solid');

    const first = fact({ matchId: 'first', limitsOverlap: true, arrivedAt: 1 });
    const second = fact({ matchId: 'second', limitsOverlap: true, arrivedAt: 2 });
    expect(sequencer.rankByFit([second, first])[0].matchId).toBe('first');
  });

  it('sorts a pair that meets on reach alone behind the ones with a distance', () => {
    const placed = fact({ matchId: 'placed', limitsOverlap: true, distanceKm: 400 });
    const reach = fact({ matchId: 'reach', limitsOverlap: true, distanceKm: null });
    expect(sequencer.rankByFit([reach, placed]).map((f) => f.matchId)).toEqual([
      'placed',
      'reach',
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('limits and headroom leave the engine as booleans', () => {
  const band = (max?: number, min?: number) => ({ band: { max, min }, ccy: 'AUD' });

  it('reads the ask first, the reserve floor second, and silence as no', () => {
    expect(limitsOverlap(band(500), band(undefined, 300), { amount: 420, ccy: 'AUD' })).toBe(true);
    expect(limitsOverlap(band(400), band(undefined, 300), { amount: 420, ccy: 'AUD' })).toBe(false);
    expect(limitsOverlap(band(500), band(undefined, 300))).toBe(true);
    expect(limitsOverlap(band(200), band(undefined, 300))).toBe(false);
    expect(limitsOverlap(undefined, band(undefined, 300))).toBe(false);
    expect(limitsOverlap(band(500), undefined)).toBe(false);
    // No currency conversion, ever.
    expect(
      limitsOverlap({ band: { max: 500 }, ccy: 'USD' }, undefined, { amount: 420, ccy: 'AUD' }),
    ).toBe(false);
  });

  it('says whether a ceiling clears the ask by a quarter, and nothing else', () => {
    expect(clearsAskWithRoom(band(525), { amount: 420, ccy: 'AUD' })).toBe(true);
    expect(clearsAskWithRoom(band(524), { amount: 420, ccy: 'AUD' })).toBe(false);
    expect(clearsAskWithRoom(band(525), null)).toBe(false);
    expect(clearsAskWithRoom(undefined, { amount: 420, ccy: 'AUD' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('slots, and who goes live', () => {
  it('fills one slot with the best fit and leaves the rest in line', async () => {
    world.intros = [intro(1), intro(2, { limits_overlap: false })];
    world.away = { [buyer(1)]: 1, [buyer(2)]: 0 };
    const promoted = await sequencer.resequenceCard(HAVE);
    // Buyer 2 is closer, but their limits are not known to meet, and that is
    // the first thing the line is ordered on.
    expect(promoted).toEqual([introId(1)]);
    expect(world.intros.map((i) => i.live)).toEqual([true, false]);
  });

  it('takes the headcount the human set, and stops there', async () => {
    world.slots = 4;
    world.intros = [intro(1), intro(2), intro(3), intro(4), intro(5)];
    await sequencer.resequenceCard(HAVE);
    expect(world.intros.filter((i) => i.live)).toHaveLength(4);
  });

  it('never displaces somebody already live, however well a latecomer fits', async () => {
    world.intros = [intro(1, { live: true, limits_overlap: false })];
    world.away = { [buyer(1)]: 5 };
    world.intros.push(intro(2, { limits_overlap: true }));
    world.away[buyer(2)] = 0;
    const promoted = await sequencer.resequenceCard(HAVE);
    expect(promoted).toEqual([]);
    expect(world.intros[0].live).toBe(true);
    expect(world.intros[1].live).toBe(false);
  });

  it('promotes the better-fitting latecomer ahead of the people still waiting', async () => {
    world.intros = [intro(1, { limits_overlap: false }), intro(2, { limits_overlap: true })];
    await sequencer.resequenceCard(HAVE);
    expect(world.intros[1].live).toBe(true);
    expect(world.intros[0].live).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the slot clock', () => {
  it('lapses a live introduction that went quiet, and the next one goes live', async () => {
    world.intros = [
      intro(1, { live: true, last_movement_at: new Date(Date.now() - 40 * 3600_000) }),
      intro(2),
    ];
    const out = await sequencer.lapseDueSlots();
    expect(out.lapsed).toBe(1);
    expect(world.intros[0].state).toBe('archived');
    expect(world.intros[0].archived_via).toBe('lapsed');
    expect(world.intros[1].live).toBe(true);
  });

  it('leaves a live introduction that moved recently exactly where it is', async () => {
    world.intros = [intro(1, { live: true, last_movement_at: new Date() }), intro(2)];
    expect((await sequencer.lapseDueSlots()).lapsed).toBe(0);
    expect(world.intros[0].state).toBe('open');
    expect(world.intros[1].live).toBe(false);
  });

  it('gives something wanted today two hours rather than a day', async () => {
    world.urgency = 'today';
    world.intros = [intro(1, { live: true, last_movement_at: new Date(Date.now() - 3 * 3600_000) })];
    expect((await sequencer.lapseDueSlots()).lapsed).toBe(1);
  });

  it('tells both sides in a sentence, with no machinery in it', async () => {
    world.intros = [intro(1, { state: 'archived', archived_via: 'lapsed' })];
    const mine = await matches.checkMatches(cfg, SELLER);
    const theirs = await matches.checkMatches(cfg, buyer(1));
    for (const sweep of [mine, theirs]) {
      expect(sweep[0].state).toBe('archived');
      expect(sweep[0].note.text).toContain('went quiet and has been filed away');
      expect(BANNED.test(sweep[0].note.text)).toBe(false);
      expect(lintHumanCopy(sweep[0].note.text)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
describe('in line: what each side is shown', () => {
  beforeEach(() => {
    world.intros = [intro(1, { live: true }), intro(2), intro(3)];
  });

  it('shows the holder nothing of the people in line, and counts them once', async () => {
    const sweep = await matches.checkMatches(cfg, SELLER);
    expect(sweep).toHaveLength(1);
    expect(sweep[0].intro_id).toBe(introId(1));
    expect(sweep[0].line).toEqual({
      in_line: 2,
      note: {
        text: '2 more people are in line for this; they come to you one at a time as this one settles.',
        provenance: 'switchboard-system',
      },
    });
    expect(lintHumanCopy(sweep[0].line.note.text)).toEqual([]);
  });

  it('gives the person waiting one sentence and nothing else at all', async () => {
    const sweep = await matches.checkMatches(cfg, buyer(2));
    expect(sweep).toHaveLength(1);
    expect(Object.keys(sweep[0]).sort()).toEqual(['intro_id', 'note', 'state']);
    expect(sweep[0].state).toBe('in_line');
    expect(sweep[0].note.text).toBe(matches.IN_LINE_SENTENCE);
    // No count, no position, no category, no signal: nothing to read a rival
    // out of, which is the whole rule.
    expect(JSON.stringify(sweep[0])).not.toMatch(/\b(2|3|first|second|ahead|behind|others)\b/i);
    expect(BANNED.test(sweep[0].note.text)).toBe(false);
  });

  it('refuses to advance an introduction that is still in line, saying only that', async () => {
    await expect(matches.expressInterest(cfg, introId(2), buyer(2))).rejects.toMatchObject({
      payload: { code: 'NOT_UNLOCKED_YET', human_action: matches.IN_LINE_SENTENCE },
    });
  });

  it('lets somebody in line drop out, which frees the slot for the next', async () => {
    await matches.declineMatch(introId(2), buyer(2));
    expect(world.intros[1].state).toBe('declined');
  });
});

// ---------------------------------------------------------------------------
describe('best offer: one sealed number each', () => {
  beforeEach(() => {
    world.sale = 'best-offer';
    world.ask = { amount: 420, ccy: 'AUD' };
    world.intros = [intro(1, { live: true }), intro(2, { live: true })];
    world.gatherUntil = new Date(Date.now() + 60_000);
  });

  const send = (n: number, amount: number) =>
    offers.proposeOffer(
      cfg,
      buyer(n),
      {
        match_id: introId(n),
        amount,
        ccy: 'AUD',
        expiry: new Date(Date.now() + 86_400_000).toISOString(),
      },
      { author: 'human' },
    );

  it('opens the window at the first candidate, and everyone who fits is live', async () => {
    world.gatherUntil = null;
    world.slots = 1;
    world.intros = [intro(1), intro(2), intro(3)];
    await sequencer.resequenceCard(HAVE);
    expect(world.gatherUntil).not.toBeNull();
    expect(world.intros.filter((i) => i.live)).toHaveLength(3);
  });

  it('refuses a number under the ask, to the buyer and to nobody else', async () => {
    await expect(send(1, 400)).rejects.toMatchObject({
      payload: { code: 'NOT_UNLOCKED_YET' },
    });
    await expect(send(1, 400)).rejects.toMatchObject({
      payload: { human_action: expect.stringContaining('below the floor') },
    });
    expect(world.offers).toHaveLength(0);
  });

  it('takes exactly one number from each buyer', async () => {
    await send(1, 500);
    await expect(send(1, 600)).rejects.toMatchObject({
      payload: { human_action: expect.stringContaining('one number each') },
    });
    expect(world.offers).toHaveLength(1);
  });

  it('refuses a number after the window has closed', async () => {
    world.gatherUntil = new Date(Date.now() - 60_000);
    await expect(send(1, 500)).rejects.toMatchObject({
      payload: { human_action: 'The window on this has closed.' },
    });
  });

  it('refuses the seller a number of their own while it is running', async () => {
    await expect(
      offers.proposeOffer(
        cfg,
        SELLER,
        {
          match_id: introId(1),
          amount: 500,
          ccy: 'AUD',
          expiry: new Date(Date.now() + 86_400_000).toISOString(),
        },
        { author: 'human' },
      ),
    ).rejects.toMatchObject({ payload: { code: 'NOT_UNLOCKED_YET' } });
  });

  it('shows the seller nothing at all until it closes, by any road they have', async () => {
    await send(1, 500);
    await send(2, 600);
    expect(await offers.offerTable(SELLER, introId(1))).toEqual([]);
    expect(await offers.listOffers(SELLER, introId(1))).toEqual([]);
    const sweep = await matches.checkMatches(cfg, SELLER);
    const said = JSON.stringify(sweep);
    expect(said).not.toContain('500');
    expect(said).not.toContain('600');
    expect(sweep.every((e: any) => !e.offer && !e.offers && !e.best_offers)).toBe(true);
  });

  it('shows a buyer their own number and no trace of anybody else', async () => {
    await send(1, 500);
    await send(2, 600);
    const table = await offers.offerTable(buyer(1), introId(1));
    expect(table.map((l) => l.amount)).toEqual([500]);
    const sweep = await matches.checkMatches(cfg, buyer(1));
    const said = JSON.stringify(sweep);
    expect(said).toContain('500');
    expect(said).not.toContain('600');
    expect(said).not.toMatch(/highest|leading|outbid|rank|others|position/i);
  });

  it('closes on its clock, files away whoever put no number in, and then shows them all', async () => {
    await send(1, 500);
    world.gatherUntil = new Date(Date.now() - 1000);
    const out = await sequencer.closeDueGatherings();
    expect(out.closed).toBe(1);
    expect(out.lapsed).toBe(1); // buyer 2 never put one in
    expect(world.intros[1].archived_via).toBe('lapsed');
    const result = await offers.bestOfferResult(HAVE, SELLER);
    expect(result!.offers.map((o) => o.amount)).toEqual([500]);
    expect(result!.note).toContain('put a number on your');
    expect(BANNED.test(result!.note)).toBe(false);
    expect(lintHumanCopy(result!.note)).toEqual([]);
  });

  it('ranks them best first with fit facts and no private input beside them', async () => {
    await send(1, 500);
    await send(2, 700);
    world.away = { [buyer(2)]: 3 }; // roughly 330 km east
    world.gatherUntil = new Date(Date.now() - 1000);
    await sequencer.closeDueGatherings();
    const result = await offers.bestOfferResult(HAVE, SELLER);
    expect(result!.offers.map((o) => o.amount)).toEqual([700, 500]);
    expect(result!.offers[0].distance).toBe('further afield');
    expect(result!.offers[1].distance).toBe('nearby');
    for (const o of result!.offers) {
      expect(['today', 'within days', 'no rush']).toContain(o.timing);
      expect(['well established', 'getting started']).toContain(o.reliability);
    }
  });

  it('answers a buyer who asks for the result with nothing', async () => {
    await send(1, 500);
    world.gatherUntil = new Date(Date.now() - 1000);
    await sequencer.closeDueGatherings();
    expect(await offers.bestOfferResult(HAVE, buyer(1))).toBeUndefined();
  });

  it('accepting one declines the rest, who are told only that it went elsewhere', async () => {
    await send(1, 500);
    await send(2, 700);
    world.gatherUntil = new Date(Date.now() - 1000);
    await sequencer.closeDueGatherings();
    const winner = world.offers.find((o) => o.amount === '700')!;
    await offers.acceptOfferByHuman(winner.id, SELLER, 'counter');
    expect(world.offers.find((o) => o.amount === '500')!.state).toBe('declined');
    expect(world.intros[0].archived_via).toBe('not-chosen');
    const loser = await matches.checkMatches(cfg, buyer(1));
    expect(loser[0].note.text).toBe(
      'The seller went with someone else on this one. Say the word and I will keep an ear out for another.',
    );
    // No figure, no count, nothing about the winner.
    expect(JSON.stringify(loser)).not.toContain('700');
    expect(BANNED.test(loser[0].note.text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the underpricing note', () => {
  const fitting = (n: number, room: number) => {
    world.ask = { amount: 420, ccy: 'AUD' };
    world.intros = Array.from({ length: n }, (_, i) =>
      intro(i + 1, { live: i === 0, clears_ask_25: i < room }),
    );
  };

  it('says nothing below five people, however much room they all have', async () => {
    fitting(4, 4);
    const sweep = await matches.checkMatches(cfg, SELLER);
    expect(sweep[0].price_note).toBeUndefined();
  });

  it('says nothing when one of the five does not clear the ask with room', async () => {
    fitting(5, 4);
    const sweep = await matches.checkMatches(cfg, SELLER);
    expect(sweep[0].price_note).toBeUndefined();
  });

  it('speaks at five, once, with no figure and no count in it', async () => {
    fitting(5, 5);
    const sweep = await matches.checkMatches(cfg, SELLER);
    expect(sweep[0].price_note.text).toBe(offers.UNDERPRICED_NOTE);
    expect(sweep[0].price_note.text).not.toMatch(/\d/);
    expect(BANNED.test(sweep[0].price_note.text)).toBe(false);
    expect(lintHumanCopy(sweep[0].price_note.text)).toEqual([]);
    // Once per want or have: the second sweep is silent.
    const again = await matches.checkMatches(cfg, SELLER);
    expect(again[0].price_note).toBeUndefined();
  });

  it('never reaches the other side', async () => {
    fitting(5, 5);
    const theirs = await matches.checkMatches(cfg, buyer(1));
    expect(JSON.stringify(theirs)).not.toContain('asking too little');
  });

  it('stays quiet on a best offer, where the numbers speak for themselves', async () => {
    fitting(5, 5);
    world.sale = 'best-offer';
    const sweep = await matches.checkMatches(cfg, SELLER);
    expect(sweep[0].price_note).toBeUndefined();
  });
});
