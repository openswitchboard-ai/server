/**
 * Trades between two lists (migration 075, domain/trades.ts), against a LIVE
 * deployment (default dev). Run:
 *   AWS_PROFILE=openswitchboard npm run test:integration -- test/integration/trades.test.ts
 *
 * Written on 14 November 2026 and NOT YET RUN: it needs a deployment with
 * migration 075 applied. The unit suite (test/unit/trades.test.ts) holds the
 * rules against a board in memory; this holds what only a real database (the
 * one-open index, the supersede statement, the guarded quantity updates, the
 * checks in 075), the real pages and the real ceremony show. Two people, two
 * lists each, every list for trading:
 *
 *   Ana   offering  trade  brake lever set x2
 *   Ana   wanting   trade  chain tool
 *   Beppe wanting   trade  brake lever set
 *   Beppe offering  trade  chain tool x1
 *
 * The suite:
 *  (a) Ana's assistant drafts 2-for-1 (both lever sets for the chain tool):
 *      the answer is a page, and nothing is open until Ana presses Send on it
 *      with her PIN;
 *  (b) Beppe's assistant sees it on his pairing entry, and counters 1-for-1
 *      (the chain tool for one lever set); Beppe presses Send, and Ana's is
 *      superseded in the same statement;
 *  (c) Ana's assistant fetches her accept page, which lists both sides and
 *      what comes off her list; she accepts with her PIN;
 *  (d) the levers go from 2 to 1 and stay up; the chain tool goes to none and
 *      comes off Beppe's list as traded;
 *  (e) both are sent the same record, its fingerprint on the trade.
 *
 * Each run uses its own geo bucket and identifiers. The lists come down at
 * the end.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_TTL_DAYS, TestActor, bootstrapActor, counterFetch, dbExec, mcpCall, poll } from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

const runTag = randomBytes(3).toString('hex');
const BUCKET = `tr_${runTag}`;
const LEVERS = `TR-${runTag.toUpperCase()}-1`;
const TOOL = `TR-${runTag.toUpperCase()}-2`;
const SHELF = 'goods.bicycle.parts';

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

const shared = (side: 'offering' | 'looking_for') => ({
  side,
  category: SHELF,
  geo: { bucket: BUCKET, reach: 'country' },
  deal: 'trade',
  ttl_days: FIXTURE_TTL_DAYS,
});

let ana: TestActor;
let beppe: TestActor;
const lists: { token: string; id: string }[] = [];
const items: Record<string, string> = {};
let pairingId: string;
let first: string;
let counter: string;

async function postList(token: string, args: Record<string, unknown>): Promise<{ listId: string; ids: string[] }> {
  const r = await mcpCall(token, 'publish_list', args, { confirmedFigure: true });
  expect(r.isError, JSON.stringify(r.result)).toBe(false);
  lists.push({ token, id: r.result.list_id });
  return { listId: r.result.list_id, ids: r.result.items.map((i: any) => i.intent_id) };
}

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

/** Open a one-question page from its link, check what it asks, and press yes with the PIN. */
async function pressPage(actor: TestActor, link: string, asks: RegExp): Promise<{ page: string; done: string }> {
  const view = await counterFetch(actor.jar, link);
  const page = await view.text();
  expect(view.status, page.slice(0, 300)).toBe(200);
  expect(page).toMatch(asks);
  const pressed = await counterFetch(actor.jar, link, form({ decision: 'yes', pin: actor.pin }));
  const done = await pressed.text();
  expect(pressed.status, done.slice(0, 400)).toBe(200);
  return { page, done };
}

async function entryOn(actor: TestActor): Promise<any> {
  const r = await mcpCall(actor.accessToken, 'check_in', {});
  expect(r.isError, JSON.stringify(r.result)).toBe(false);
  const mine = (r.result.introductions ?? []).filter((e: any) => e.kind === 'pairing' && e.pairing_id === pairingId);
  expect(mine).toHaveLength(1);
  return mine[0];
}

const proposal = async (id: string) => {
  const [row] = await dbExec(
    `SELECT state, receipt_sha256, terms_sha256, supersedes::text FROM trade_proposals WHERE id = :t::uuid`,
    [{ name: 't', value: id }],
  );
  return { state: row[0], receipt: row[1], terms: row[2], supersedes: row[3] };
};

d('trades between two lists: draft, send, counter, accept', () => {
  beforeAll(async () => {
    [ana, beppe] = await Promise.all([bootstrapActor('Ana', 'Holt'), bootstrapActor('Beppe', 'Bruce')]);
    const a1 = await postList(ana.accessToken, {
      shared: shared('offering'),
      items: [{ name: 'brake lever set', identifiers: [{ kind: 'model number', value: LEVERS }], quantity: 2, details: { condition: 'used' } }],
    });
    const a2 = await postList(ana.accessToken, {
      shared: shared('looking_for'),
      items: [{ name: 'chain tool', identifiers: [{ kind: 'model number', value: TOOL }] }],
    });
    const b1 = await postList(beppe.accessToken, {
      shared: shared('looking_for'),
      items: [{ name: 'brake lever set', identifiers: [{ kind: 'model number', value: LEVERS }] }],
    });
    const b2 = await postList(beppe.accessToken, {
      shared: shared('offering'),
      items: [{ name: 'chain tool', identifiers: [{ kind: 'model number', value: TOOL }], quantity: 1 }],
    });
    [items.anaLevers] = a1.ids;
    [items.beppeTool] = b2.ids;
    void a2;
    void b1;
    await Promise.all(lists.map((l) => waitForListScreened(l.token, l.id)));
    pairingId = await poll(async () => {
      const rows = await dbExec(
        `SELECT p.id::text FROM pairings p
          WHERE p.state = 'open' AND p.live AND p.trade_to_lo AND p.trade_to_hi
            AND p.account_lo = LEAST(:a::uuid, :b::uuid) AND p.account_hi = GREATEST(:a::uuid, :b::uuid)`,
        [
          { name: 'a', value: ana.accountId },
          { name: 'b', value: beppe.accountId },
        ],
      );
      return rows[0] ? String(rows[0][0]) : undefined;
    }, 'the pairing to be live with a trade both ways', 300_000);
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

  it('(a) drafts 2-for-1 as a page, and sends it only on Ana’s own press', async () => {
    const entry = await entryOn(ana);
    expect(entry.trade_possible).toBe(true);
    expect(entry.trade_note.text).toMatch(/You can put a trade to them/);
    const tool = entry.they_have.items.find((i: any) => i.their_words?.text === 'chain tool');
    expect(tool.item_id).toBe(items.beppeTool);
    const r = await mcpCall(ana.accessToken, 'propose_trade', {
      pairing_id: pairingId,
      give: [{ item_id: items.anaLevers, quantity: 2 }],
      get: [{ item_id: items.beppeTool, quantity: 1 }],
      note: 'both sets work',
    });
    expect(r.isError, JSON.stringify(r.result)).toBe(false);
    expect(r.result.say).toMatch(/^Here is your page — it asks whether to send your trade, 2 things of yours for 1 thing of theirs/);
    expect(r.result.press_id).toMatch(/^[0-9a-f-]{36}$/);
    first = r.result.trade_id;
    expect((await proposal(first)).state).toBe('awaiting-send');
    // Nothing reaches Beppe before the press.
    expect((await entryOn(beppe)).trade).toBeUndefined();
    const { page } = await pressPage(ana, r.result.link, /Send this trade\?/);
    expect(page).toContain('You give');
    expect(page).toContain('If they accept, these come off your list');
    const sent = await proposal(first);
    expect(sent.state).toBe('open');
    expect(sent.terms).toMatch(/^[0-9a-f]{64}$/);
    const wait = await mcpCall(ana.accessToken, 'wait_for_press', { press_id: r.result.press_id });
    expect(wait.result.pressed, JSON.stringify(wait.result)).toBe(true);
  });

  it('(b) Beppe sees it, and counters 1-for-1, superseding Ana’s in the same statement', async () => {
    const entry = await entryOn(beppe);
    expect(entry.trade).toMatchObject({ trade_id: first, from: 'them', state: 'open' });
    expect(entry.next).toBe('awaiting_your_human');
    expect(entry.note.text.startsWith('They have put a trade to you')).toBe(true);
    expect(entry.trade.their_note).toEqual({ text: 'both sets work', provenance: 'counterparty-untrusted' });
    const r = await mcpCall(beppe.accessToken, 'propose_trade', {
      pairing_id: pairingId,
      give: [{ item_id: items.beppeTool, quantity: 1 }],
      get: [{ item_id: items.anaLevers, quantity: 1 }],
    });
    expect(r.isError, JSON.stringify(r.result)).toBe(false);
    counter = r.result.trade_id;
    await pressPage(beppe, r.result.link, /Send this trade\?/);
    expect((await proposal(first)).state).toBe('superseded');
    const c = await proposal(counter);
    expect(c.state).toBe('open');
    expect(c.supersedes).toBe(first);
    const open = await dbExec(`SELECT count(*)::int FROM trade_proposals WHERE pairing_id = :p::uuid AND state = 'open'`, [
      { name: 'p', value: pairingId },
    ]);
    expect(Number(open[0][0])).toBe(1);
  });

  it('(c) Ana accepts on her own page, which lists both sides and what comes off her list', async () => {
    const entry = await entryOn(ana);
    expect(entry.trade).toMatchObject({ trade_id: counter, from: 'them' });
    // Her own side cannot accept her own trade, and Beppe cannot accept his.
    const own = await mcpCall(beppe.accessToken, 'answer_trade', { trade_id: counter, action: 'request_accept' });
    expect(own.result.nothing_happened).toBe(true);
    const r = await mcpCall(ana.accessToken, 'answer_trade', { trade_id: counter, action: 'request_accept' });
    expect(r.isError, JSON.stringify(r.result)).toBe(false);
    expect(r.result.say).toMatch(/it asks whether to accept their trade, 1 thing of theirs for 1 thing of yours, and saying yes takes your passkey or PIN/);
    const { page, done } = await pressPage(ana, r.result.link, /Accept this trade\?/);
    expect(page).toContain('These come off your list');
    expect(page).toContain('1 left on your list after this');
    expect(done).toContain('The trade is agreed');
  });

  it('(d) the levers go from 2 to 1 and stay up; the chain tool comes off as traded', async () => {
    const rows = await dbExec(
      `SELECT id::text, quantity_gone, lifecycle_state, withdrawn_because FROM cards WHERE id = ANY(string_to_array(:ids, ',')::uuid[])`,
      [{ name: 'ids', value: `${items.anaLevers},${items.beppeTool}` }],
    );
    const by = Object.fromEntries(rows.map((r: any[]) => [r[0], { gone: Number(r[1]), state: r[2], because: r[3] }]));
    expect(by[items.anaLevers]).toEqual({ gone: 1, state: 'PUBLISHED', because: null });
    expect(by[items.beppeTool]).toEqual({ gone: 1, state: 'WITHDRAWN', because: 'traded' });
    const read = await mcpCall(beppe.accessToken, 'read_lists', { list_id: lists[3].id });
    const tool = read.result.list_items.find((i: any) => i.intent_id === items.beppeTool);
    expect(tool.note.text).toMatch(/went in an accepted trade/);
  });

  it('(e) both are sent the same record, its fingerprint on the trade', async () => {
    const c = await proposal(counter);
    expect(c.state).toBe('accepted');
    expect(c.receipt).toMatch(/^[0-9a-f]{64}$/);
    const sends = await poll(async () => {
      const rows = await dbExec(
        `SELECT account_id::text, status FROM email_sends WHERE template = 'receipt' AND dedupe_key LIKE :k`,
        [{ name: 'k', value: `receipt:${counter}:%` }],
      );
      return rows.length >= 2 ? rows : undefined;
    }, 'both receipts to be sent');
    expect(sends.map((r: any[]) => r[0]).sort()).toEqual([ana.accountId, beppe.accountId].sort());
    // A trade, once agreed, is not open to anything more.
    const again = await mcpCall(beppe.accessToken, 'answer_trade', { trade_id: counter, action: 'withdraw' });
    expect(again.result.nothing_happened).toBe(true);
    const later = await entryOn(beppe);
    expect(later.last_trade?.note?.text ?? later.note.text).toMatch(/The trade between you is agreed/);
  });
});
