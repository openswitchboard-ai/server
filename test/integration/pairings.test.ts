/**
 * One entry per person for lists (migration 074, domain/pairings.ts), against
 * a LIVE deployment (default dev). Run:
 *   AWS_PROFILE=openswitchboard npm run test:integration -- test/integration/pairings.test.ts
 *
 * Written on 14 November 2026 and NOT YET RUN: it needs a deployment with
 * migration 074 applied. The unit suite (test/unit/pairings.test.ts) holds the
 * rules against a board in memory; this holds what only a real database, the
 * real screen and the real matcher show. Two people, two lists each:
 *
 *   Ana   offering  sale_or_trade  brake lever set x2, asking 10 AUD
 *   Ana   wanting   trade          chain tool
 *   Beppe wanting   sale_or_trade  brake lever set
 *   Beppe offering  trade          chain tool
 *
 * So the levers can go to Beppe as a sale or in a trade, and the chain tool
 * can go to Ana only in a trade. The suite checks:
 *
 *  (a) every item introduction between the two of them lands on ONE pairing;
 *  (b) the directions: a sale only towards Beppe, a trade both ways;
 *  (c) check_in carries one pairing entry each, with the things both ways;
 *  (d) a figure on the chain tool (trade lists both) is refused in words;
 *  (e) Beppe's figure on the levers, accepted by Ana on her own page, takes
 *      the levers from 2 to 1, and they stay up.
 *
 * Each run uses its own geo bucket and its own identifiers, so leftovers in
 * the shared dev database cannot reach these assertions. The lists are taken
 * down at the end.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_TTL_DAYS,
  TestActor,
  bootstrapActor,
  counterFetch,
  dbExec,
  humanOffer,
  mcpCall,
  poll,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

const runTag = randomBytes(3).toString('hex');
const BUCKET = `pr_${runTag}`;
const LEVERS = `PR-${runTag.toUpperCase()}-1`;
const TOOL = `PR-${runTag.toUpperCase()}-2`;
const SHELF = 'goods.bicycle.parts';

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

const shared = (side: 'offering' | 'looking_for', deal: string, over: Record<string, unknown> = {}) => ({
  side,
  category: SHELF,
  geo: { bucket: BUCKET, reach: 'country' },
  deal,
  ttl_days: FIXTURE_TTL_DAYS,
  ...over,
});

let ana: TestActor;
let beppe: TestActor;
const lists: { token: string; id: string }[] = [];
const items: Record<string, string> = {};
let pairingId: string;

/** Post a list, confirming its figures once where it carries any. */
async function postList(token: string, args: Record<string, unknown>): Promise<{ listId: string; ids: string[] }> {
  let r = await mcpCall(token, 'publish_list', args, { confirmedFigure: true });
  if (r.result?.what_happened === 'confirm_figure') {
    r = await mcpCall(token, 'publish_list', { ...args, reference: r.result.reference }, { confirmedFigure: true });
  }
  expect(r.isError, JSON.stringify(r.result)).toBe(false);
  lists.push({ token, id: r.result.list_id });
  return { listId: r.result.list_id, ids: r.result.items.map((i: any) => i.intent_id) };
}

/** Poll read_lists until every item on the list has left the screen. */
async function waitForListScreened(token: string, listId: string): Promise<void> {
  await poll(
    async () => {
      const r = await mcpCall(token, 'read_lists', { list_id: listId });
      if (r.isError || !r.result?.list_items) throw new Error(JSON.stringify(r.result).slice(0, 300));
      const states = r.result.list_items.map((i: any) => i.state);
      if (states.some((s: string) => s === 'PENDING_SCREENING')) return undefined;
      expect(states.every((s: string) => s === 'PUBLISHED'), JSON.stringify(states)).toBe(true);
      return true;
    },
    `list ${listId} to leave the screen`,
    240_000,
    10_000,
  );
}

async function introBetween(want: string, have: string): Promise<string> {
  return poll(async () => {
    const rows = await dbExec(
      'SELECT id::text FROM matches WHERE card_want = :w::uuid AND card_have = :h::uuid',
      [
        { name: 'w', value: want },
        { name: 'h', value: have },
      ],
    );
    return rows[0] ? String(rows[0][0]) : undefined;
  }, 'the item introduction to appear', 240_000);
}

/** The pairing entry for the other person on this actor's sweep. */
async function entryOn(actor: TestActor): Promise<any> {
  const r = await mcpCall(actor.accessToken, 'check_in', {});
  expect(r.isError, JSON.stringify(r.result)).toBe(false);
  const mine = (r.result.introductions ?? []).filter((e: any) => e.kind === 'pairing' && e.pairing_id === pairingId);
  expect(mine).toHaveLength(1);
  return mine[0];
}

d('lists meeting lists: one entry per person', () => {
  beforeAll(async () => {
    [ana, beppe] = await Promise.all([bootstrapActor('Ana', 'Holt'), bootstrapActor('Beppe', 'Bruce')]);
    const a1 = await postList(ana.accessToken, {
      shared: shared('offering', 'sale_or_trade', { currency: 'AUD' }),
      items: [{ name: 'brake lever set', identifiers: [{ kind: 'model number', value: LEVERS }], quantity: 2, price: 10 }],
    });
    const a2 = await postList(ana.accessToken, {
      shared: shared('looking_for', 'trade'),
      items: [{ name: 'chain tool', identifiers: [{ kind: 'model number', value: TOOL }] }],
    });
    const b1 = await postList(beppe.accessToken, {
      shared: shared('looking_for', 'sale_or_trade'),
      items: [{ name: 'brake lever set', identifiers: [{ kind: 'model number', value: LEVERS }] }],
    });
    const b2 = await postList(beppe.accessToken, {
      shared: shared('offering', 'trade'),
      items: [{ name: 'chain tool', identifiers: [{ kind: 'model number', value: TOOL }] }],
    });
    [items.anaLevers] = a1.ids;
    [items.anaWantsTool] = a2.ids;
    [items.beppeWantsLevers] = b1.ids;
    [items.beppeTool] = b2.ids;
    await Promise.all([
      waitForListScreened(ana.accessToken, a1.listId),
      waitForListScreened(ana.accessToken, a2.listId),
      waitForListScreened(beppe.accessToken, b1.listId),
      waitForListScreened(beppe.accessToken, b2.listId),
    ]);
    items.leversIntro = await introBetween(items.beppeWantsLevers, items.anaLevers);
    items.toolIntro = await introBetween(items.anaWantsTool, items.beppeTool);
  }, 900_000);

  afterAll(async () => {
    for (const l of lists) {
      try {
        await mcpCall(l.token, 'withdraw_list', { list_id: l.id });
      } catch {
        /* best effort */
      }
    }
  });

  it('(a) puts every item introduction between the two of them on one pairing', async () => {
    const rows = await dbExec(
      `SELECT DISTINCT pairing_id::text FROM matches WHERE id = ANY(string_to_array(:ids, ',')::uuid[])`,
      [{ name: 'ids', value: `${items.leversIntro},${items.toolIntro}` }],
    );
    expect(rows).toHaveLength(1);
    pairingId = String(rows[0][0]);
    expect(pairingId).toMatch(/^[0-9a-f-]{36}$/);
    const open = await dbExec(
      `SELECT count(*) FROM pairings
        WHERE state = 'open'
          AND account_lo = LEAST(:a::uuid, :b::uuid) AND account_hi = GREATEST(:a::uuid, :b::uuid)`,
      [
        { name: 'a', value: ana.accountId },
        { name: 'b', value: beppe.accountId },
      ],
    );
    expect(Number(open[0][0])).toBe(1);
  });

  it('(b) works out the directions from the two lists: a sale only towards Beppe, a trade both ways', async () => {
    const [[anaIsLo]] = await dbExec(`SELECT :a::uuid < :b::uuid`, [
      { name: 'a', value: ana.accountId },
      { name: 'b', value: beppe.accountId },
    ]);
    const [row] = await dbExec(
      `SELECT sale_to_lo, sale_to_hi, trade_to_lo, trade_to_hi, lo_gets_sure + lo_gets_maybe, hi_gets_sure + hi_gets_maybe
         FROM pairings WHERE id = :p::uuid`,
      [{ name: 'p', value: pairingId }],
    );
    const [saleLo, saleHi, tradeLo, tradeHi, loGets, hiGets] = row;
    const saleToAna = anaIsLo ? saleLo : saleHi;
    const saleToBeppe = anaIsLo ? saleHi : saleLo;
    expect(saleToAna).toBe(false);
    expect(saleToBeppe).toBe(true);
    expect(tradeLo).toBe(true);
    expect(tradeHi).toBe(true);
    expect(Number(loGets)).toBe(1);
    expect(Number(hiGets)).toBe(1);
  });

  it('(c) carries one pairing entry each on check_in, with the things both ways', async () => {
    const live = await poll(async () => {
      const [[l]] = await dbExec('SELECT live FROM pairings WHERE id = :p::uuid', [{ name: 'p', value: pairingId }]);
      return l === true ? true : undefined;
    }, 'the pairing to go live');
    expect(live).toBe(true);
    const a = await entryOn(ana);
    expect(a.state).toBe('open');
    expect(a.trade_possible).toBe(true);
    expect(a.can_sell).toBe(true);
    expect(a.can_buy).toBe(false);
    expect(a.they_have.items.map((i: any) => i.deal)).toEqual([['trade']]);
    expect(a.they_want.items.map((i: any) => i.deal)).toEqual([['sale', 'trade']]);
    expect(a.note.text).toMatch(/Someone whose list meets yours/);
    const b = await entryOn(beppe);
    expect(b.can_buy).toBe(true);
    expect(b.they_have.items[0].quantity).toBe(2);
    expect(b.they_have.items[0].asking_price).toEqual({ amount: 10, ccy: 'AUD' });
    // No identifier ever crosses, either way.
    expect(JSON.stringify(a) + JSON.stringify(b)).not.toContain(runTag.toUpperCase());
    // Neither item introduction is an entry of its own.
    const sweep = await mcpCall(ana.accessToken, 'check_in', {});
    const ids = (sweep.result.introductions ?? []).map((e: any) => e.intro_id);
    expect(ids.filter((id: string) => id === items.leversIntro || id === items.toolIntro).length).toBeLessThanOrEqual(1);
    // read_pairings has the same person, in full.
    const full = await mcpCall(beppe.accessToken, 'read_pairings', { pairing_id: pairingId });
    expect(full.isError, JSON.stringify(full.result)).toBe(false);
    expect(full.result.they_have_items).toHaveLength(1);
  });

  it('(d) refuses a figure on the chain tool, where both lists are for trading', async () => {
    const r = await mcpCall(ana.accessToken, 'respond', {
      intro_id: items.toolIntro,
      action: 'propose_offer',
      offer: { amount: 5, ccy: 'AUD', expiry: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(r.result.nothing_happened, JSON.stringify(r.result)).toBe(true);
    expect(r.result.human_action).toMatch(/for trading/);
    const n = await dbExec('SELECT count(*) FROM offers WHERE match_id = :m::uuid', [{ name: 'm', value: items.toolIntro }]);
    expect(Number(n[0][0])).toBe(0);
  });

  it('(e) a sale of the levers, accepted on Ana\'s own page, takes them from 2 to 1', async () => {
    const sent = await humanOffer(beppe.jar, items.leversIntro, { amount: 10, pin: beppe.pin });
    expect(sent.status, (await sent.text()).slice(0, 300)).toBe(200);
    const [[offerId]] = await poll(async () => {
      const rows = await dbExec(
        `SELECT id::text FROM offers WHERE match_id = :m::uuid AND state IN ('proposed', 'awaiting-human')`,
        [{ name: 'm', value: items.leversIntro }],
      );
      return rows.length ? rows : undefined;
    }, 'Beppe\'s figure to be on the table');
    const res = await counterFetch(
      ana.jar,
      '/approve',
      form({ action: 'offer-accept', ref_id: String(offerId), decision: 'approve', pin: ana.pin }),
    );
    expect(res.status, (await res.text()).slice(0, 300)).toBe(200);
    const [[state, gone, lifecycle]] = await dbExec(
      `SELECT o.state, c.quantity_gone, c.lifecycle_state
         FROM offers o JOIN matches m ON m.id = o.match_id JOIN cards c ON c.id = m.card_have
        WHERE o.id = :o::uuid`,
      [{ name: 'o', value: String(offerId) }],
    );
    expect(state).toBe('accepted-by-human');
    expect(Number(gone)).toBe(1);
    expect(lifecycle).toBe('PUBLISHED');
    const read = await mcpCall(ana.accessToken, 'read_lists', { list_id: lists[0].id });
    const levers = read.result.list_items.find((i: any) => i.intent_id === items.anaLevers);
    expect(levers.quantity).toBe(1);
    expect(levers.gone).toBe(1);
  });
});
