/**
 * Lists (migration 068), against a LIVE deployment (default dev). Run:
 *   AWS_PROFILE=openswitchboard npm run test:integration -- test/integration/lists.test.ts
 *
 * Written on 18 October 2026 and NOT YET RUN: it needs a deployment with
 * migration 068 applied, the dev database and AWS credentials. The unit suite
 * (test/unit/lists.test.ts) holds every rule against a board in memory; this
 * holds the parts only a real database, a real queue and a real screen show:
 *
 *  (a) the door: good items go up, a thin one comes back with its number and
 *      nothing is asked of it; every item is a posting linked to its list and
 *      its owner;
 *  (b) the screen: the items pass the real batched screen and are published,
 *      and list_intents leaves them out and names the list beside the postings;
 *  (c) the figures: a sale list is read back once as a summary, then goes up
 *      sent again with the reference;
 *  (d) matching: a single want meets a list item that shares its identifier,
 *      and no two of one person's items ever meet;
 *  (e) a list sent again: added, changed, unchanged and taken down, matched
 *      by identifier and by name;
 *  (f) taking the list down takes every item down.
 *
 * Each run uses its own geo bucket and its own identifiers, so leftovers in
 * the shared dev database cannot reach these assertions. The lists are taken
 * down at the end, and every item has the shortest expiry the protocol allows.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_TTL_DAYS,
  SCHEMA_VERSION,
  TestActor,
  bootstrapActor,
  dbExec,
  mcpCall,
  poll,
  waitForCardState,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

const runTag = randomBytes(3).toString('hex');
const BUCKET = `ls_${runTag}`;
const CODE = (n: number) => `LS-${runTag.toUpperCase()}-${n}`;
const SHELF = 'goods.bicycle.parts';

const shared = (over: Record<string, unknown> = {}) => ({
  side: 'offering',
  category: SHELF,
  geo: { bucket: BUCKET, reach: 'country' },
  deal: 'trade',
  ttl_days: FIXTURE_TTL_DAYS,
  ...over,
});

/** Poll read_lists until every item on the list has left the screen. */
async function waitForListScreened(token: string, listId: string): Promise<any> {
  return poll(
    async () => {
      const r = await mcpCall(token, 'read_lists', { list_id: listId });
      if (r.isError || !r.result?.list_items) {
        throw new Error(`read_lists failed while waiting: ${JSON.stringify(r.result).slice(0, 300)}`);
      }
      return r.result.list_items.some((i: any) => i.state === 'PENDING_SCREENING') ? undefined : r.result;
    },
    `list ${listId} to leave the screen`,
    240_000,
    10_000,
  );
}

d('lists', () => {
  let ana: TestActor;
  let beppe: TestActor;
  const lists: { token: string; id: string }[] = [];
  let tradeList: string;

  beforeAll(async () => {
    [ana, beppe] = await Promise.all([bootstrapActor('Ana', 'Holt'), bootstrapActor('Beppe', 'Bruce')]);
  }, 600_000);

  afterAll(async () => {
    for (const l of lists) {
      try {
        await mcpCall(l.token, 'withdraw_list', { list_id: l.id });
      } catch {
        /* best effort */
      }
    }
  });

  it('(a) posts the good items, and turns back a thin one with its number', async () => {
    const r = await mcpCall(ana.accessToken, 'publish_list', {
      shared: shared(),
      items: [
        { name: 'hydraulic brake levers', identifiers: [{ kind: 'model number', value: CODE(1) }], details: { condition: 'good' } },
        { name: 'touring saddle', details: { condition: 'worn', colour: 'brown' } },
        { name: '' },
        { name: 'chain checker tool', quantity: 2 },
      ],
    });
    expect(r.isError, JSON.stringify(r.result)).toBe(false);
    expect(r.result.added).toBe(3);
    expect(r.result.refused_items).toEqual([expect.objectContaining({ index: 2, reason: 'name' })]);
    tradeList = r.result.list_id;
    lists.push({ token: ana.accessToken, id: tradeList });

    const rows = await dbExec(
      `SELECT count(*), count(DISTINCT account_id), bool_and(attributes->>'trade' = 'true')
         FROM cards WHERE list_id = :l::uuid`,
      [{ name: 'l', value: tradeList }],
    );
    expect(Number(rows[0][0])).toBe(3);
    expect(Number(rows[0][1])).toBe(1);
    expect(rows[0][2]).toBe(true);
    const qty = await dbExec(
      `SELECT attributes->>'quantity', slots FROM cards WHERE list_id = :l::uuid AND kind = 'chain checker tool'`,
      [{ name: 'l', value: tradeList }],
    );
    // A quantity is a detail; slots stay at one.
    expect(qty[0]).toEqual(['2', 1]);
  });

  it('(b) puts every item through the real screen, and keeps them out of list_intents', async () => {
    const read = await waitForListScreened(ana.accessToken, tradeList);
    expect(read.list_items.map((i: any) => i.state)).toEqual(['PUBLISHED', 'PUBLISHED', 'PUBLISHED']);
    expect(read.items.up).toBe(3);
    const rows = await dbExec(
      `SELECT count(*) FROM cards WHERE list_id = :l::uuid AND embedding IS NOT NULL AND screened_content IS NOT NULL`,
      [{ name: 'l', value: tradeList }],
    );
    expect(Number(rows[0][0])).toBe(3);
    const mine = await mcpCall(ana.accessToken, 'list_intents', {});
    expect(mine.result.intents.filter((i: any) => i.intent_id && read.list_items.some((x: any) => x.intent_id === i.intent_id))).toEqual([]);
    expect(mine.result.lists.map((l: any) => l.list_id)).toContain(tradeList);
  });

  it('(c) reads a sale list\'s figures back once as a summary, then posts it with the reference', async () => {
    const args = {
      shared: shared({ deal: 'sale', currency: 'AUD' }),
      items: [
        { name: 'flat pedals', price: 25 },
        { name: 'seat post clamp', price: 8 },
        { name: 'bar tape', open_to_offers: true },
      ],
    };
    const first = await mcpCall(ana.accessToken, 'publish_list', args, { confirmedFigure: true });
    expect(first.result.what_happened, JSON.stringify(first.result)).toBe('confirm_figure');
    expect(first.result.figures).toEqual([
      { what: 'lowest asking price on the list', amount: 8, currency: 'AUD' },
      { what: 'highest asking price on the list', amount: 25, currency: 'AUD' },
    ]);
    const second = await mcpCall(ana.accessToken, 'publish_list', { ...args, reference: first.result.reference }, { confirmedFigure: true });
    expect(second.isError, JSON.stringify(second.result)).toBe(false);
    expect(second.result.added).toBe(3);
    expect(second.result.list_id).toBe(first.result.reference);
    lists.push({ token: ana.accessToken, id: second.result.list_id });
  });

  it('(d) a single want meets the list item with its identifier, and no two of one person\'s items meet', async () => {
    const want = await mcpCall(beppe.accessToken, 'publish_intent', {
      listing: {
        schema_version: SCHEMA_VERSION,
        type: 'looking_for',
        category: SHELF,
        kind: 'hydraulic brake levers',
        attributes: { brand: 'Generic' },
        geo: { bucket: BUCKET, reach: 'country' },
        ttl_days: FIXTURE_TTL_DAYS,
      },
      identifiers: [{ kind: 'model number', value: CODE(1).replace(/-/g, ' ') }],
    });
    expect(want.isError, JSON.stringify(want.result)).toBe(false);
    expect(await waitForCardState(beppe.accessToken, want.result.intent_id, ['PUBLISHED', 'SCREENING_REJECTED'])).toBe('PUBLISHED');
    const match = await poll(async () => {
      const rows = await dbExec(
        `SELECT m.id FROM matches m JOIN cards h ON h.id = m.card_have
          WHERE m.card_want = :w::uuid AND h.list_id = :l::uuid`,
        [
          { name: 'w', value: want.result.intent_id },
          { name: 'l', value: tradeList },
        ],
      );
      return rows[0];
    }, 'the introduction between the want and the list item', 180_000);
    expect(match[0]).toBeDefined();
    // Introduced to one item, the want records no near miss against any of
    // that person's other postings, on this list or any other
    // (domain/nearMisses.ts, found in the lists rehearsal).
    const near = await dbExec(
      `SELECT count(*) FROM near_misses nm JOIN cards h ON h.id = nm.card_have
        WHERE nm.card_want = :w::uuid AND h.account_id = :a::uuid`,
      [
        { name: 'w', value: want.result.intent_id },
        { name: 'a', value: ana.accountId },
      ],
    );
    expect(Number(near[0][0])).toBe(0);
    const own = await dbExec(
      `SELECT count(*) FROM matches WHERE account_want = account_have AND account_want = :a::uuid`,
      [{ name: 'a', value: ana.accountId }],
    );
    expect(Number(own[0][0])).toBe(0);
  });

  it('(e) sent again: adds, changes, leaves alone and takes down', async () => {
    const r = await mcpCall(ana.accessToken, 'publish_list', {
      list_id: tradeList,
      replace: true,
      items: [
        // unchanged, matched by identifier
        { name: 'hydraulic brake levers', identifiers: [{ kind: 'model number', value: CODE(1) }], details: { condition: 'good' } },
        // changed, matched by name and details: now three
        { name: 'chain checker tool', quantity: 3 },
        // new
        { name: 'tyre levers' },
        // the touring saddle is no longer on it
      ],
    });
    expect(r.isError, JSON.stringify(r.result)).toBe(false);
    expect([r.result.added, r.result.changed, r.result.unchanged, r.result.withdrawn]).toEqual([1, 1, 1, 1]);
    const states = await dbExec(
      `SELECT kind, lifecycle_state FROM cards WHERE list_id = :l::uuid ORDER BY kind`,
      [{ name: 'l', value: tradeList }],
    );
    const byKind = Object.fromEntries(states.map((row) => [row[0], row[1]]));
    expect(byKind['touring saddle']).toBe('WITHDRAWN');
    expect(byKind['hydraulic brake levers']).toBe('PUBLISHED');
    const read = await waitForListScreened(ana.accessToken, tradeList);
    expect(read.list_items.find((i: any) => i.name === 'chain checker tool').quantity).toBe(3);
  });

  it('(f) taking the list down takes every item down', async () => {
    const r = await mcpCall(ana.accessToken, 'withdraw_list', { list_id: tradeList });
    expect(r.isError, JSON.stringify(r.result)).toBe(false);
    expect(r.result.state).toBe('WITHDRAWN');
    const live = await dbExec(
      `SELECT count(*) FROM cards WHERE list_id = :l::uuid AND lifecycle_state IN ('PENDING_SCREENING','PUBLISHED')`,
      [{ name: 'l', value: tradeList }],
    );
    expect(Number(live[0][0])).toBe(0);
  });
});
