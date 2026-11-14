/**
 * TRADES BETWEEN TWO LISTS (14 November 2026; migration 075;
 * src/domain/trades.ts, the trades design phase P2).
 *
 * Held here, on the pure rules and against a board in memory faked at the
 * pool:
 *
 *  - the shape of a call: one to ten things each side, ids, quantities;
 *  - ownership: your side is only your own things on a list that trades;
 *  - their side is only their things that met one of your wants here;
 *  - quantities never more than is left, and no shotgunning across trades;
 *  - the caps: three a side a pairing a day, ten open, the hour of offers;
 *  - the note: the offer-note rule and the money-figure refusal;
 *  - expiry: seven days at most;
 *  - the agent drafts, the human sends: propose_trade answers with a page;
 *  - send supersedes the open one; withdraw and decline, each by its side;
 *  - accept re-checks everything under the lock, then quantities come off
 *    both sides, a thing at none left comes down as traded, and anything
 *    that can no longer be met closes;
 *  - lines both ways on a pairing;
 *  - the record: its canonical form, its fingerprint, on the trade and on
 *    both presses, emailed to both;
 *  - and the copy: every sentence held to the house register.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const consentEvents: any[] = [];
vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeConsentEvent: vi.fn(async (e: any) => {
    consentEvents.push(e);
    return 'consent-events/x';
  }),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

const intakeCalls: any[] = [];
vi.mock('../../src/intake/pipe.js', () => ({
  runIntake: vi.fn(async (_cfg: any, req: any) => {
    intakeCalls.push(req);
    return { outcome: 'pass' };
  }),
}));

let linkN = 0;
const links: any[] = [];
vi.mock('../../src/counter/links.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createApprovalLink: vi.fn(async (input: any) => {
    linkN++;
    const id = `99999999-0000-4000-8000-${String(linkN).padStart(12, '0')}`;
    links.push({ ...input, id });
    return { token: `${id}.sig`, id };
  }),
}));

const receipts: any[] = [];
vi.mock('../../src/counter/email.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendReceiptEmail: vi.fn(async (_cfg: any, to: string, accountId: string, input: any) => {
    receipts.push({ to, accountId, ...input });
    return { sent: true };
  }),
}));

vi.mock('../../src/domain/counterOps.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  accountEmail: vi.fn(async (accountId: string) => `${accountId.slice(0, 4)}@example.test`),
}));

vi.mock('../../src/domain/sequencer.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  noteMovement: vi.fn(async () => {}),
}));

const sqsJobs: any[] = [];
vi.mock('../../src/aws.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sqs: { send: vi.fn(async (cmd: any) => { sqsJobs.push(JSON.parse(cmd.input.MessageBody)); return {}; }) },
}));

const takenDown: any[] = [];
vi.mock('../../src/domain/quantities.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  takeDownNoneLeft: vi.fn(async (cardId: string, keep: string, _cfg: any, because: string) => {
    takenDown.push({ cardId, keep, because });
    const c = world.cards.get(cardId);
    if (c) {
      c.lifecycle_state = 'WITHDRAWN';
      c.withdrawn_because = because;
    }
    return 0;
  }),
}));

import * as db from '../../src/db.js';
// Loaded here, once, so the two receipts sent side by side both find the
// stood-in senders rather than racing the first load of the module.
import '../../src/counter/email.js';
import '../../src/domain/counterOps.js';
import * as trades from '../../src/domain/trades.js';
import * as receipt from '../../src/domain/receipt.js';
import * as confirmLines from '../../src/domain/confirmLines.js';
import { confirmedForSale } from '../../src/domain/offers.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import { OsbError } from '../../src/protocol.js';
import { TOOLS, TOOL_ANNOTATIONS, argumentComplaint } from '../../src/mcp/tools.js';
import { FRESH_CEREMONY_ACTIONS, isTradeAction } from '../../src/counter/credentials.js';
import { ONE_QUESTION_ACTIONS } from '../../src/counter/links.js';
import { fetchAgainFor } from '../../src/domain/humanLinks.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
  quotas: { maxOffersPerHour: 20 },
} as unknown as Config;

const ANA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BEPPE = 'bbbbbbbb-0000-4000-8000-000000000002';
const CARLA = 'cccccccc-0000-4000-8000-000000000003';
const uid = (p: string, n: number) => `${p}${String(n).padStart(6, '0')}-1111-4111-8111-111111111111`;

// ---------------------------------------------------------------------------
// The board in memory.
// ---------------------------------------------------------------------------

interface Card {
  id: string;
  account_id: string;
  type: 'WANT' | 'HAVE';
  list_id: string;
  lifecycle_state: string;
  attributes: Record<string, unknown>;
  quantity_gone: number;
  kind: string;
  category: string;
  screened_content: any;
  withdrawn_because?: string | null;
}
interface World {
  cards: Map<string, Card>;
  lists: Map<string, { id: string; deal: string; state: string }>;
  matches: any[];
  pairings: any[];
  proposals: any[];
  items: any[];
  lines: any[];
  offersThisHour: number;
}
let world: World;
const sql_log: string[] = [];
let failOpenOnce = false;

const L = {
  anaTrade: uid('1a', 1),
  anaSale: uid('1a', 2),
  anaWants: uid('1a', 3),
  beppeTrade: uid('1b', 1),
  beppeWants: uid('1b', 2),
  carlaWants: uid('1c', 1),
  carlaTrade: uid('1c', 2),
};
const C = {
  levers: uid('2a', 1), // Ana's, 2 of them, on a sale_or_trade list
  tape: uid('2a', 2), // Ana's, 1, sale_or_trade
  saleOnly: uid('2a', 3), // Ana's, on a sale list
  anaWantsTool: uid('2a', 4),
  anaWantsTyre: uid('2a', 5),
  anaWantsPump: uid('2a', 6),
  tool: uid('2b', 1), // Beppe's, 1
  tyre: uid('2b', 2), // Beppe's, 3
  unmatched: uid('2b', 3), // Beppe's, met nothing of Ana's
  beppeWantsLevers: uid('2b', 4),
  carlaWantsLevers: uid('2c', 1),
  pump: uid('2c', 2), // Carla's
};
const M = { anchor: uid('3a', 1), tool: uid('3a', 2), tyre: uid('3a', 3), carlaAnchor: uid('3c', 1), pump: uid('3c', 2) };
const P = { ab: uid('4a', 1), ac: uid('4c', 1) };

function card(id: string, account: string, type: 'WANT' | 'HAVE', list: string, kind: string, quantity = 1, extra: Record<string, unknown> = {}): Card {
  return {
    id,
    account_id: account,
    type,
    list_id: list,
    lifecycle_state: 'PUBLISHED',
    attributes: { quantity, ...extra },
    quantity_gone: 0,
    kind,
    category: 'goods.bicycle.parts',
    screened_content: { version: 1, at: '', kind, attributes: { quantity, ...extra } },
  };
}

function freshWorld(): World {
  const w: World = {
    cards: new Map(),
    lists: new Map(),
    matches: [],
    pairings: [],
    proposals: [],
    items: [],
    lines: [],
    offersThisHour: 0,
  };
  for (const [id, deal] of [
    [L.anaTrade, 'sale_or_trade'],
    [L.anaSale, 'sale'],
    [L.anaWants, 'trade'],
    [L.beppeTrade, 'trade'],
    [L.beppeWants, 'sale_or_trade'],
    [L.carlaWants, 'trade'],
    [L.carlaTrade, 'trade'],
  ]) {
    w.lists.set(id, { id, deal, state: 'open' });
  }
  for (const c of [
    card(C.levers, ANA, 'HAVE', L.anaTrade, 'brake lever set', 2, { condition: 'used' }),
    card(C.tape, ANA, 'HAVE', L.anaTrade, 'bar tape', 1),
    card(C.saleOnly, ANA, 'HAVE', L.anaSale, 'bottle cage', 1),
    card(C.anaWantsTool, ANA, 'WANT', L.anaWants, 'chain tool'),
    card(C.anaWantsTyre, ANA, 'WANT', L.anaWants, 'tyre lever'),
    card(C.anaWantsPump, ANA, 'WANT', L.anaWants, 'floor pump'),
    card(C.tool, BEPPE, 'HAVE', L.beppeTrade, 'chain tool', 1),
    card(C.tyre, BEPPE, 'HAVE', L.beppeTrade, 'tyre lever', 3),
    card(C.unmatched, BEPPE, 'HAVE', L.beppeTrade, 'spoke key', 1),
    card(C.beppeWantsLevers, BEPPE, 'WANT', L.beppeWants, 'brake lever set'),
    card(C.carlaWantsLevers, CARLA, 'WANT', L.carlaWants, 'brake lever set'),
    card(C.pump, CARLA, 'HAVE', L.carlaTrade, 'floor pump', 1),
  ]) {
    w.cards.set(c.id, c);
  }
  const match = (id: string, pairing: string, want: string, have: string) => ({
    id,
    pairing_id: pairing,
    card_want: want,
    card_have: have,
    account_want: w.cards.get(want)!.account_id,
    account_have: w.cards.get(have)!.account_id,
    state: 'open',
    stage: 2,
    item_set_aside_at: null,
    category: 'goods.bicycle.parts',
  });
  w.matches.push(
    match(M.anchor, P.ab, C.beppeWantsLevers, C.levers),
    match(M.tool, P.ab, C.anaWantsTool, C.tool),
    match(M.tyre, P.ab, C.anaWantsTyre, C.tyre),
    match(M.carlaAnchor, P.ac, C.carlaWantsLevers, C.levers),
    match(M.pump, P.ac, C.anaWantsPump, C.pump),
  );
  const pairing = (id: string, a: string, b: string, anchor: string) => ({
    id,
    account_lo: a < b ? a : b,
    account_hi: a < b ? b : a,
    state: 'open',
    live: true,
    anchor_match_id: anchor,
    lo_gets_sure: 1,
    hi_gets_sure: 1,
    lo_gets_maybe: 0,
    hi_gets_maybe: 0,
    trade_to_lo: true,
    trade_to_hi: true,
    sale_to_lo: false,
    sale_to_hi: true,
    free_to_lo: false,
    free_to_hi: false,
    created_at: new Date(),
  });
  w.pairings.push(pairing(P.ab, ANA, BEPPE, M.anchor), pairing(P.ac, ANA, CARLA, M.carlaAnchor));
  return w;
}

const leftOfCard = (c: Card) => Math.max(0, Number(c.attributes.quantity ?? 1) - c.quantity_gone);
const res = (rows: any[]) => ({ rows, rowCount: rows.length });
let pid = 0;

async function run(sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s) || s.includes('pg_advisory_xact_lock')) return res([]);
  if (s.startsWith('SELECT * FROM pairings WHERE id = $1')) return res(world.pairings.filter((p) => p.id === params[0]));
  if (s.startsWith('SELECT anchor_match_id FROM pairings WHERE id')) {
    return res(world.pairings.filter((p) => p.id === params[0]));
  }
  if (s.startsWith('SELECT * FROM matches WHERE id = $1')) return res(world.matches.filter((m) => m.id === params[0]));
  if (s.startsWith('SELECT p.anchor_match_id FROM matches m JOIN pairings p')) {
    const m = world.matches.find((x) => x.id === params[0]);
    const p = m && world.pairings.find((x) => x.id === m.pairing_id);
    return res(p ? [{ anchor_match_id: p.anchor_match_id }] : []);
  }
  if (s.includes('lw.deal AS want_deal, lh.deal AS have_deal') && s.includes('m.account_want = $2')) {
    const rows = world.matches
      .filter((m) => m.pairing_id === params[0] && m.account_want === params[1] && m.state === 'open' && !m.item_set_aside_at)
      .map((m) => ({
        id: m.id,
        card_have: m.card_have,
        want_deal: world.lists.get(world.cards.get(m.card_want)!.list_id)!.deal,
        have_deal: world.lists.get(world.cards.get(m.card_have)!.list_id)!.deal,
      }));
    return res(rows);
  }
  if (s.startsWith('SELECT id, card_have FROM matches WHERE pairing_id = $1 AND account_have = $2')) {
    return res(world.matches.filter((m) => m.pairing_id === params[0] && m.account_have === params[1] && m.state === 'open'));
  }
  if (s.includes('FROM cards c LEFT JOIN lists l ON l.id = c.list_id')) {
    const rows = (params[0] as string[])
      .map((id) => world.cards.get(id))
      .filter(Boolean)
      .map((c) => ({ ...c, list_deal: world.lists.get(c!.list_id)?.deal, list_state: world.lists.get(c!.list_id)?.state }));
    return res(rows.map((r) => structuredClone(r)));
  }
  if (s.startsWith('SELECT id FROM trade_proposals WHERE pairing_id = $1 AND proposer_account = $2 AND state = \'open\'')) {
    return res(world.proposals.filter((p) => p.pairing_id === params[0] && p.proposer_account === params[1] && p.state === 'open'));
  }
  if (s.includes('FROM trade_proposal_items i JOIN trade_proposals p ON p.id = i.proposal_id') && s.includes('GROUP BY i.card_id')) {
    const [proposer, cardIds, leaveOut] = params as [string, string[], string[]];
    const sums = new Map<string, number>();
    for (const i of world.items) {
      const p = world.proposals.find((x) => x.id === i.proposal_id)!;
      if (p.proposer_account !== proposer || i.giver_account !== proposer) continue;
      if (p.state !== 'open' || new Date(p.expiry) <= new Date()) continue;
      if (!cardIds.includes(i.card_id) || leaveOut.includes(p.id)) continue;
      sums.set(i.card_id, (sums.get(i.card_id) ?? 0) + i.quantity);
    }
    return res([...sums].map(([card_id, units]) => ({ card_id, units })));
  }
  if (s.startsWith("SELECT id, note FROM trade_proposals WHERE pairing_id = $1 AND proposer_account = $2 AND state = 'awaiting-send'")) {
    return res(
      world.proposals
        .filter((p) => p.pairing_id === params[0] && p.proposer_account === params[1] && p.state === 'awaiting-send' && new Date(p.expiry) > new Date())
        .reverse(),
    );
  }
  if (s.startsWith('SELECT card_id, giver_account, quantity FROM trade_proposal_items WHERE proposal_id = $1')) {
    return res(world.items.filter((i) => i.proposal_id === params[0]));
  }
  if (s.startsWith('SELECT (SELECT count(*) FROM trade_proposals WHERE pairing_id = $1')) {
    const dayAgo = Date.now() - 86_400_000;
    const today = world.proposals.filter((p) => p.pairing_id === params[0] && p.proposer_account === params[1] && p.created_at.getTime() > dayAgo).length;
    const open = world.proposals.filter((p) => p.proposer_account === params[1] && p.state === 'open' && new Date(p.expiry) > new Date()).length;
    return res([{ today, open_out: open }]);
  }
  if (s.startsWith('SELECT count(*)::int AS n FROM offers')) return res([{ n: world.offersThisHour }]);
  if (s.startsWith('SELECT count(*)::int AS n FROM trade_proposals WHERE proposer_account = $1 AND created_at')) {
    const hourAgo = Date.now() - 3_600_000;
    return res([{ n: world.proposals.filter((p) => p.proposer_account === params[0] && p.created_at.getTime() > hourAgo).length }]);
  }
  if (s.startsWith('INSERT INTO trade_proposals')) {
    const [pairing, proposer, recipient, note, expiry, cap] = params;
    const dayAgo = Date.now() - 86_400_000;
    const n = world.proposals.filter((p) => p.pairing_id === pairing && p.proposer_account === proposer && p.created_at.getTime() > dayAgo).length;
    if (n >= cap) return res([]);
    pid++;
    const row = {
      id: uid('5d', pid),
      pairing_id: pairing,
      proposer_account: proposer,
      recipient_account: recipient,
      state: 'awaiting-send',
      note: note ? JSON.parse(note) : null,
      expiry: new Date(expiry),
      created_at: new Date(Date.now() + pid),
      updated_at: new Date(),
      cash_amount: null,
    };
    world.proposals.push(row);
    return res([{ id: row.id }]);
  }
  if (s.startsWith('INSERT INTO trade_proposal_items')) {
    world.items.push({ proposal_id: params[0], card_id: params[1], giver_account: params[2], quantity: params[3] });
    return res([]);
  }
  if (s.startsWith('SELECT * FROM trade_proposals WHERE id = $1')) return res(world.proposals.filter((p) => p.id === params[0]));
  if (s.startsWith("SELECT id, proposer_account FROM trade_proposals WHERE pairing_id = $1 AND state = 'open'")) {
    return res(world.proposals.filter((p) => p.pairing_id === params[0] && p.state === 'open'));
  }
  if (s.startsWith("SELECT count(*)::int AS n FROM trade_proposals WHERE proposer_account = $1 AND state = 'open'")) {
    return res([
      { n: world.proposals.filter((p) => p.proposer_account === params[0] && p.state === 'open' && !params[1].includes(p.id)).length },
    ]);
  }
  if (s.startsWith("UPDATE trade_proposals SET state = CASE WHEN expiry <= now() THEN 'expired' ELSE 'superseded' END")) {
    const [id, pairing] = params;
    const moved: any[] = [];
    for (const p of world.proposals) {
      if (p.pairing_id === pairing && p.state === 'open' && p.id !== id) {
        p.state = new Date(p.expiry) <= new Date() ? 'expired' : 'superseded';
        p.updated_at = new Date();
        moved.push({ id: p.id });
      }
    }
    sql_log.push('supersede');
    return res(moved);
  }
  if (s.startsWith("UPDATE trade_proposals SET state = 'open', sent_at = now()")) {
    const [id, via, terms, supersedes] = params;
    const me = world.proposals.find((p) => p.id === id);
    if (!me || me.state !== 'awaiting-send') return res([]);
    if (failOpenOnce) {
      failOpenOnce = false;
      throw new Error('the connection dropped');
    }
    // The one-open index, as Postgres holds it: a second open row is refused.
    if (world.proposals.some((p) => p.pairing_id === me.pairing_id && p.state === 'open')) {
      throw Object.assign(new Error('duplicate key value violates unique constraint "trade_proposals_one_open_idx"'), { code: '23505' });
    }
    Object.assign(me, { state: 'open', sent_at: new Date(), sent_via: via, terms_sha256: terms, supersedes, updated_at: new Date() });
    sql_log.push('open');
    return res([{ id, supersedes }]);
  }
  if (s.startsWith("UPDATE trade_proposals SET state = 'declined'")) {
    const p = world.proposals.find((x) => x.id === params[0] && x.state === 'open');
    if (p) p.state = 'declined';
    return res(p ? [{ id: p.id }] : []);
  }
  if (s.startsWith("UPDATE trade_proposals SET state = 'withdrawn'")) {
    const p = world.proposals.find((x) => x.id === params[0] && (x.state === 'open' || x.state === 'awaiting-send'));
    if (p) p.state = 'withdrawn';
    return res(p ? [{ id: p.id }] : []);
  }
  if (s.startsWith("UPDATE trade_proposals SET state = 'accepted'")) {
    const p = world.proposals.find((x) => x.id === params[0] && x.state === 'open');
    if (p) Object.assign(p, { state: 'accepted', accepted_at: new Date(), accepted_by: params[1], accepted_via: params[2], receipt_sha256: params[3] });
    return res(p ? [{ id: p.id }] : []);
  }
  if (s.startsWith('UPDATE cards SET quantity_gone = quantity_gone + $2')) {
    const c = world.cards.get(params[0]);
    if (!c || c.lifecycle_state !== 'PUBLISHED' || c.quantity_gone + params[1] > Number(c.attributes.quantity ?? 1)) return res([]);
    c.quantity_gone += params[1];
    return res([{ attributes: c.attributes, quantity_gone: c.quantity_gone }]);
  }
  if (s.startsWith("UPDATE trade_proposals p SET state = 'closed', updated_at = now(), closed_because")) {
    const ids = params[0] as string[];
    const closed: any[] = [];
    for (const p of world.proposals) {
      if (p.state !== 'open' && p.state !== 'awaiting-send') continue;
      const mine = world.items.filter((i) => i.proposal_id === p.id && ids.includes(i.card_id));
      const bad = mine.find((i) => {
        const c = world.cards.get(i.card_id)!;
        return c.lifecycle_state !== 'PUBLISHED' || leftOfCard(c) < i.quantity;
      });
      if (bad) {
        p.state = 'closed';
        p.closed_because = world.cards.get(bad.card_id)!.lifecycle_state !== 'PUBLISHED' ? 'taken_down' : 'none_left';
        closed.push({ id: p.id });
      }
    }
    return res(closed);
  }
  if (s.startsWith("UPDATE trade_proposals SET state = 'expired'")) {
    for (const p of world.proposals) if (p.pairing_id === params[0] && p.state === 'open' && new Date(p.expiry) <= new Date()) p.state = 'expired';
    return res([]);
  }
  if (s.startsWith('SELECT * FROM trade_proposals WHERE pairing_id = $1 AND (state')) {
    const rows = world.proposals
      .filter((p) => p.pairing_id === params[0] && (p.state === 'open' || (p.state === 'awaiting-send' && p.proposer_account === params[1])))
      .sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || b.created_at - a.created_at);
    return res(rows.slice(0, 1));
  }
  if (s.startsWith('SELECT * FROM trade_proposals WHERE pairing_id = $1 AND state NOT IN')) {
    const rows = world.proposals
      .filter((p) => p.pairing_id === params[0] && !['open', 'awaiting-send', 'superseded'].includes(p.state) && !(p.state === 'withdrawn' && !p.sent_at))
      .sort((a, b) => b.created_at - a.created_at);
    return res(rows.slice(0, 1));
  }
  if (s.includes("WHERE m.id = $1 AND c.sale = 'best-offer'")) return res([]);
  if (s.startsWith('SELECT category, kind FROM cards WHERE id = $1')) return res([world.cards.get(params[0])].filter(Boolean));
  // Written lines.
  if (s.startsWith('SELECT id, match_id, asked_by, line, state, created_at, answered_at FROM confirm_lines WHERE match_id = $1 AND state <> \'withdrawn\'')) {
    return res(world.lines.filter((l) => l.match_id === params[0] && l.state !== 'withdrawn'));
  }
  if (s.startsWith("SELECT id, state FROM confirm_lines WHERE match_id = $1 AND state = 'asked' AND asked_by <> $2")) {
    return res(world.lines.filter((l) => l.match_id === params[0] && l.state === 'asked' && l.asked_by !== params[1]));
  }
  if (s.startsWith('UPDATE confirm_lines SET state = \'confirmed\'')) {
    for (const l of world.lines) if (l.match_id === params[0] && params[4].includes(l.id) && l.state === 'asked') l.state = 'confirmed';
    return res([]);
  }
  throw new Error(`fake pool: no answer for ${s.slice(0, 160)}`);
}

/** A pool whose transactions roll back: BEGIN snapshots the board, ROLLBACK restores it. */
function fakePool() {
  let snapshot: string | undefined;
  const client = {
    query: async (sql: string, params?: any[]) => {
      const s = sql.trim();
      if (s === 'BEGIN') snapshot = JSON.stringify({ ...world, cards: [...world.cards] , lists: [...world.lists] });
      if (s === 'ROLLBACK' && snapshot) {
        const o = JSON.parse(snapshot, (_k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v));
        world = { ...o, cards: new Map(o.cards), lists: new Map(o.lists) };
        snapshot = undefined;
      }
      return run(sql, params);
    },
    release: () => {},
  };
  return { query: run, connect: async () => client } as any;
}

beforeEach(() => {
  world = freshWorld();
  consentEvents.length = 0;
  intakeCalls.length = 0;
  links.length = 0;
  receipts.length = 0;
  takenDown.length = 0;
  sqsJobs.length = 0;
  sql_log.length = 0;
  failOpenOnce = false;
  pid = 0;
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

const refusedWith = async (p: Promise<unknown>, words: string | RegExp) => {
  try {
    await p;
  } catch (e: any) {
    const said = e instanceof OsbError ? String(e.payload.human_action ?? '') : String(e?.message ?? '');
    if (typeof words === 'string') expect(said).toBe(words);
    else expect(said).toMatch(words);
    return e;
  }
  throw new Error('expected a refusal');
};

const propose = (who: string, pairing: string, give: [string, number][], get: [string, number][], extra: Record<string, unknown> = {}) =>
  trades.proposeTrade(cfg, who, {
    pairing_id: pairing,
    give: give.map(([item_id, quantity]) => ({ item_id, quantity })),
    get: get.map(([item_id, quantity]) => ({ item_id, quantity })),
    ...extra,
  });

// ---------------------------------------------------------------------------
describe('the shape of a call', () => {
  it('takes one to ten things a side, each an id with a whole quantity, one where none is given', () => {
    expect(trades.readTradeLines([{ item_id: C.levers }])).toEqual([{ item_id: C.levers, quantity: 1 }]);
    expect(trades.readTradeLines([{ item_id: C.levers, quantity: 2 }])).toEqual([{ item_id: C.levers, quantity: 2 }]);
    for (const bad of [
      [],
      Array.from({ length: 11 }, (_, i) => ({ item_id: uid('9e', i) })),
      [{ item_id: 'not-an-id' }],
      [{ item_id: C.levers, quantity: 0 }],
      [{ item_id: C.levers, quantity: 1.5 }],
      [{ item_id: C.levers }, { item_id: C.levers }],
      'levers',
    ]) {
      expect(() => trades.readTradeLines(bad)).toThrow(trades.TRADE_ITEMS_WORDS);
    }
    expect(trades.readTradeLines(Array.from({ length: 10 }, (_, i) => ({ item_id: uid('9e', i) })))).toHaveLength(10);
  });

  it('stands seven days by default and at most', () => {
    const now = Date.UTC(2026, 10, 14);
    expect(trades.tradeExpiry(undefined, now).getTime()).toBe(now + 7 * 86_400_000);
    expect(trades.tradeExpiry(new Date(now + 3 * 86_400_000).toISOString(), now).getTime()).toBe(now + 3 * 86_400_000);
    expect(() => trades.tradeExpiry(new Date(now - 1000).toISOString(), now)).toThrow(trades.TRADE_EXPIRY_WORDS);
    expect(() => trades.tradeExpiry(new Date(now + 8 * 86_400_000).toISOString(), now)).toThrow(trades.TRADE_EXPIRY_WORDS);
    expect(() => trades.tradeExpiry('soon', now)).toThrow(trades.TRADE_EXPIRY_WORDS);
  });

  it('the tool takes exactly that shape, and names nothing a client may not send', () => {
    expect(argumentComplaint('propose_trade', { pairing_id: P.ab, give: [{ item_id: C.levers, quantity: 2 }], get: [{ item_id: C.tool }] })).toBeUndefined();
    expect(argumentComplaint('propose_trade', { pairing_id: P.ab, give: [], get: [{ item_id: C.tool }] })).toBeDefined();
    expect(argumentComplaint('propose_trade', { pairing_id: P.ab, give: [{ item_id: C.levers }], get: [{ item_id: C.tool }], cash: 5 })).toMatch(/takes no 'cash'/);
    expect(argumentComplaint('answer_trade', { trade_id: 'x', action: 'decline' })).toMatch(/trade_id is not an id/);
    expect(argumentComplaint('answer_trade', { trade_id: uid('5d', 1), action: 'accept' })).toBeDefined();
    expect(argumentComplaint('answer_trade', { trade_id: uid('5d', 1), action: 'request_accept' })).toBeUndefined();
  });

  it('describes both tools with annotations, inside the budget, without a word about any one kind of thing', () => {
    for (const name of ['propose_trade', 'answer_trade']) {
      const t = TOOLS.find((x) => x.name === name)!;
      expect(t, name).toBeDefined();
      expect(t.annotations).toEqual(TOOL_ANNOTATIONS[name]);
      expect(t.description.length).toBeLessThanOrEqual(1400);
      expect(t.description).not.toMatch(/pok[eé]mon|\bcards?\b/i);
      expect(lintHumanCopy(t.description)).toEqual([]);
    }
    expect(TOOL_ANNOTATIONS.propose_trade.readOnlyHint).toBe(false);
    expect(TOOL_ANNOTATIONS.answer_trade.destructiveHint).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the rules, pure', () => {
  const item = (over: Partial<trades.ItemFact> & { id: string; account_id: string }): trades.ItemFact => ({
    type: 'HAVE',
    lifecycle_state: 'PUBLISHED',
    list_id: 'l',
    list_deal: 'trade',
    list_state: 'open',
    attributes: { quantity: 2 },
    quantity_gone: 0,
    ...over,
  });
  const base = () => ({
    proposer: ANA,
    recipient: BEPPE,
    give: [{ item_id: 'g', quantity: 1 }],
    get: [{ item_id: 'h', quantity: 1 }],
    items: new Map([
      ['g', item({ id: 'g', account_id: ANA })],
      ['h', item({ id: 'h', account_id: BEPPE })],
    ]),
    askable: new Set(['h']),
    committed: new Map<string, number>(),
  });

  it('passes a trade that keeps every rule', () => {
    expect(trades.tradeRefusal(base())).toBeUndefined();
  });

  it('gives only the proposer’s own things, up, on a list that trades', () => {
    for (const bad of [
      { account_id: BEPPE },
      { type: 'WANT' },
      { lifecycle_state: 'WITHDRAWN' },
      { list_deal: 'sale' },
      { list_deal: 'free' },
      { list_id: null },
      { list_state: 'withdrawn' },
    ]) {
      const f = base();
      f.items.set('g', item({ id: 'g', account_id: ANA, ...(bad as any) }));
      expect(trades.tradeRefusal(f), JSON.stringify(bad)).toBe(trades.GIVE_NOT_YOURS_WORDS);
    }
    const f = base();
    f.items.set('g', item({ id: 'g', account_id: ANA, list_deal: 'sale_or_trade' }));
    expect(trades.tradeRefusal(f)).toBeUndefined();
  });

  it('asks only for their things that met one of the proposer’s wants here', () => {
    const f = base();
    f.askable = new Set();
    expect(trades.tradeRefusal(f)).toBe(trades.GET_NOT_MATCHED_WORDS);
    const g = base();
    g.items.set('h', item({ id: 'h', account_id: BEPPE, lifecycle_state: 'WITHDRAWN' }));
    expect(trades.tradeRefusal(g)).toBe(trades.GET_NOT_MATCHED_WORDS);
  });

  it('asks no more of anything than is left', () => {
    const f = base();
    f.get = [{ item_id: 'h', quantity: 3 }];
    expect(trades.tradeRefusal(f)).toBe(trades.NOT_ENOUGH_LEFT_TO_ASK_WORDS);
    const g = base();
    g.items.set('g', item({ id: 'g', account_id: ANA, quantity_gone: 2 }));
    expect(trades.tradeRefusal(g)).toBe(trades.NOT_ENOUGH_LEFT_TO_ASK_WORDS);
  });

  it('never gives across open trades more than the proposer holds', () => {
    const f = base();
    f.committed = new Map([['g', 1]]);
    expect(trades.tradeRefusal(f)).toBeUndefined();
    f.give = [{ item_id: 'g', quantity: 2 }];
    expect(trades.tradeRefusal(f)).toBe(trades.ALREADY_PROMISED_WORDS);
  });

  it('holds the caps', () => {
    expect(trades.tradeCapRefusal({ thisPairingToday: 2, openOutgoing: 9 })).toBeUndefined();
    expect(trades.tradeCapRefusal({ thisPairingToday: 3, openOutgoing: 0 })).toBe(trades.TRADES_PER_DAY_WORDS);
    expect(trades.tradeCapRefusal({ thisPairingToday: 0, openOutgoing: 10 })).toBe(trades.OPEN_TRADES_FULL_WORDS);
  });

  it('keys a trade’s things the same in any order, and knows its clock', () => {
    const a = [
      { card_id: 'x', giver_account: ANA, quantity: 1 },
      { card_id: 'y', giver_account: BEPPE, quantity: 2 },
    ];
    expect(trades.tradeItemsKey(a)).toBe(trades.tradeItemsKey([...a].reverse()));
    expect(trades.tradeHasExpired({ expiry: new Date(Date.now() - 1) })).toBe(true);
    expect(trades.tradeHasExpired({ expiry: new Date(Date.now() + 60_000) })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('drafting: the assistant drafts and the human sends', () => {
  it('answers with a page, always, and holds the trade as a draft until the press', async () => {
    const r = await propose(ANA, P.ab, [[C.levers, 2]], [[C.tool, 1]], { note: 'happy to post' });
    expect(r.say).toMatch(/^Here is your page — it asks whether to send your trade, 2 things of yours for 1 thing of theirs/);
    expect(r.say.endsWith(r.link)).toBe(true);
    expect(r.press_id).toBe(links[0].id);
    expect(links[0]).toMatchObject({ action: 'trade-send', refId: r.trade_id, counterpartyAccount: BEPPE, accountId: ANA });
    const p = world.proposals.find((x) => x.id === r.trade_id);
    expect(p.state).toBe('awaiting-send');
    expect(p.note).toEqual({ text: 'happy to post', provenance: 'counterparty-untrusted' });
    expect(world.items.filter((i) => i.proposal_id === r.trade_id)).toEqual([
      { proposal_id: r.trade_id, card_id: C.levers, giver_account: ANA, quantity: 2 },
      { proposal_id: r.trade_id, card_id: C.tool, giver_account: BEPPE, quantity: 1 },
    ]);
    // The note went through the offer-words door, on the anchor.
    expect(intakeCalls).toEqual([
      expect.objectContaining({ door: 'offer_words', sender_account: ANA, recipient_account: BEPPE, match_id: M.anchor }),
    ]);
    // Nothing reaches the other side, and nothing is pressed.
    expect(consentEvents).toHaveLength(0);
  });

  it('takes an intro id where a thing’s own id belongs', async () => {
    const r = await propose(ANA, P.ab, [[M.anchor, 1]], [[M.tool, 1]]);
    expect(world.items.filter((i) => i.proposal_id === r.trade_id).map((i) => i.card_id)).toEqual([C.levers, C.tool]);
  });

  it('the same trade again finds its draft and hands a fresh page', async () => {
    const a = await propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]);
    const b = await propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]);
    expect(b.trade_id).toBe(a.trade_id);
    expect(b.press_id).not.toBe(a.press_id);
    expect(world.proposals).toHaveLength(1);
  });

  it('refuses the proposer’s side where it is not theirs or not on a trade list', async () => {
    await refusedWith(propose(ANA, P.ab, [[C.tyre, 1]], [[C.tool, 1]]), trades.GIVE_NOT_YOURS_WORDS);
    await refusedWith(propose(ANA, P.ab, [[C.saleOnly, 1]], [[C.tool, 1]]), trades.GIVE_NOT_YOURS_WORDS);
    expect(world.proposals).toHaveLength(0);
  });

  it('refuses their side where it met none of the proposer’s wants here', async () => {
    await refusedWith(propose(ANA, P.ab, [[C.levers, 1]], [[C.unmatched, 1]]), trades.GET_NOT_MATCHED_WORDS);
    // A thing of Carla's is not Beppe's to give, on this pairing.
    await refusedWith(propose(ANA, P.ab, [[C.levers, 1]], [[C.pump, 1]]), trades.GET_NOT_MATCHED_WORDS);
  });

  it('refuses more than is left', async () => {
    await refusedWith(propose(ANA, P.ab, [[C.levers, 3]], [[C.tool, 1]]), trades.NOT_ENOUGH_LEFT_TO_ASK_WORDS);
    await refusedWith(propose(ANA, P.ab, [[C.levers, 1]], [[C.tyre, 4]]), trades.NOT_ENOUGH_LEFT_TO_ASK_WORDS);
  });

  it('refuses shotgunning across pairings, and lets a revision on the same pairing through', async () => {
    const first = await propose(ANA, P.ab, [[C.levers, 2]], [[C.tool, 1]]);
    await trades.sendTradeByHuman(first.trade_id, ANA, 'counter', cfg);
    await refusedWith(propose(ANA, P.ac, [[C.levers, 1]], [[C.pump, 1]]), trades.ALREADY_PROMISED_WORDS);
    // The same pairing: sending this one would replace the first.
    const revised = await propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]);
    expect(revised.trade_id).not.toBe(first.trade_id);
    // And the shotgun rule is held again at the press, under the lock.
    const other = world.proposals.find((p) => p.id === revised.trade_id);
    other.state = 'withdrawn';
    const carla = await propose(ANA, P.ac, [[C.tape, 1]], [[C.pump, 1]]);
    world.items.find((i) => i.proposal_id === carla.trade_id && i.card_id === C.tape).card_id = C.levers;
    await refusedWith(trades.sendTradeByHuman(carla.trade_id, ANA, 'counter', cfg), trades.ALREADY_PROMISED_WORDS);
    expect(world.proposals.find((p) => p.id === carla.trade_id).state).toBe('awaiting-send');
  });

  it('holds three a side a pairing a day', async () => {
    await propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]);
    await propose(ANA, P.ab, [[C.levers, 2]], [[C.tool, 1]]);
    await propose(ANA, P.ab, [[C.tape, 1]], [[C.tool, 1]]);
    const e = await refusedWith(propose(ANA, P.ab, [[C.tape, 1]], [[C.tyre, 1]]), trades.TRADES_PER_DAY_WORDS);
    expect(e.payload.code).toBe('RATE_LIMITED_OFFERS');
    // The other side has a day of their own.
    await propose(BEPPE, P.ab, [[C.tool, 1]], [[C.levers, 1]]);
  });

  it('holds ten open from any one account', async () => {
    for (let i = 0; i < 10; i++) {
      world.proposals.push({ id: uid('6f', i), pairing_id: uid('4f', i), proposer_account: ANA, recipient_account: CARLA, state: 'open', expiry: new Date(Date.now() + 86_400_000), created_at: new Date(Date.now() - 2 * 86_400_000) });
    }
    await refusedWith(propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]), trades.OPEN_TRADES_FULL_WORDS);
  });

  it('counts against the hour a figure does', async () => {
    world.offersThisHour = 19;
    await propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]);
    const e = await refusedWith(propose(ANA, P.ab, [[C.tape, 1]], [[C.tool, 1]]), /Offers are paced/);
    expect(e.payload.code).toBe('RATE_LIMITED_OFFERS');
  });

  it('screens the note: the offer-note rule, and no sum of money', async () => {
    const e = await refusedWith(propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]], { note: 'plus $20 from me' }), trades.FIGURE_IN_TRADE_NOTE_WORDS);
    expect(e.payload.code).toBe('CONSENT_REQUIRED');
    await refusedWith(propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]], { note: 'mail me at a@b.com' }), /email, phone number or web address/);
    await refusedWith(propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]], { note: 'x'.repeat(201) }), /runs past 200/);
    expect(intakeCalls).toHaveLength(0);
    expect(world.proposals).toHaveLength(0);
  });

  it('refuses a pairing that is not theirs, has ended, waits its turn, or allows no trade', async () => {
    const e = await refusedWith(propose(CARLA, P.ab, [[C.pump, 1]], [[C.levers, 1]]), trades.TRADE_NOT_PAIRING_WORDS);
    expect(e.notFound).toBe(true);
    world.pairings[0].trade_to_lo = false;
    await refusedWith(propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]), trades.TRADE_NOT_POSSIBLE_WORDS);
    world.pairings[0].state = 'archived';
    await refusedWith(propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]), trades.TRADE_PAIRING_ENDED_WORDS);
  });
});

// ---------------------------------------------------------------------------
describe('sending, withdrawing, declining', () => {
  it('sends only by the proposer’s own press, and writes it down with the terms’ fingerprint', async () => {
    const r = await propose(ANA, P.ab, [[C.levers, 2]], [[C.tool, 1]]);
    await expect(trades.sendTradeByHuman(r.trade_id, ANA, 'internal-ops' as any, cfg)).rejects.toThrow(/human's own press/);
    await expect(trades.sendTradeByHuman(r.trade_id, BEPPE, 'counter', cfg)).rejects.toThrow(trades.NOT_YOUR_TRADE);
    await trades.sendTradeByHuman(r.trade_id, ANA, 'counter', cfg);
    const p = world.proposals.find((x) => x.id === r.trade_id);
    expect(p).toMatchObject({ state: 'open', sent_via: 'counter' });
    expect(p.terms_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(consentEvents).toEqual([
      expect.objectContaining({ event: 'trade-sent-by-human', trade_id: r.trade_id, account_id: ANA, recorded_via: 'counter', match_id: M.anchor, terms_sha256: p.terms_sha256 }),
    ]);
    await refusedWith(trades.sendTradeByHuman(r.trade_id, ANA, 'counter', cfg), trades.TRADE_SENT_ALREADY_WORDS);
  });

  it('a counter supersedes the open one, and only one is ever open', async () => {
    const a = await propose(ANA, P.ab, [[C.levers, 2]], [[C.tool, 1]]);
    await trades.sendTradeByHuman(a.trade_id, ANA, 'counter', cfg);
    const b = await propose(BEPPE, P.ab, [[C.tool, 1]], [[C.levers, 1]]);
    const sent = await trades.sendTradeByHuman(b.trade_id, BEPPE, 'counter', cfg);
    expect(sent.superseded).toBe(a.trade_id);
    expect(world.proposals.find((x) => x.id === a.trade_id).state).toBe('superseded');
    expect(world.proposals.find((x) => x.id === b.trade_id)).toMatchObject({ state: 'open', supersedes: a.trade_id });
    // Two statements in the one locked transaction: the open one moves aside
    // first, then this one opens, so the one-open index never sees two.
    expect(sql_log).toEqual(['supersede', 'open', 'supersede', 'open']);
  });

  it('a send that cannot open rolls the supersede back with it', async () => {
    const a = await propose(ANA, P.ab, [[C.levers, 2]], [[C.tool, 1]]);
    await trades.sendTradeByHuman(a.trade_id, ANA, 'counter', cfg);
    const b = await propose(BEPPE, P.ab, [[C.tool, 1]], [[C.levers, 1]]);
    failOpenOnce = true;
    await expect(trades.sendTradeByHuman(b.trade_id, BEPPE, 'counter', cfg)).rejects.toThrow('the connection dropped');
    expect(world.proposals.find((x) => x.id === a.trade_id).state).toBe('open');
    expect(world.proposals.find((x) => x.id === b.trade_id).state).toBe('awaiting-send');
    // And pressed again, it goes.
    await trades.sendTradeByHuman(b.trade_id, BEPPE, 'counter', cfg);
    expect(world.proposals.find((x) => x.id === a.trade_id).state).toBe('superseded');
    expect(trades.SUPERSEDE_SQL).not.toMatch(/WITH /);
  });

  it('withdraws only by the proposer, before acceptance, drafts included', async () => {
    const r = await propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]);
    await refusedWith(trades.answerTrade(cfg, BEPPE, r.trade_id, 'withdraw'), trades.TRADE_NOT_THEIRS_TO_WITHDRAW_WORDS);
    const out = await trades.answerTrade(cfg, ANA, r.trade_id, 'withdraw');
    expect(out).toMatchObject({ state: 'withdrawn', note: { text: trades.TRADE_WITHDRAWN_SENTENCE } });
    await refusedWith(trades.answerTrade(cfg, ANA, r.trade_id, 'withdraw'), trades.TRADE_NO_LONGER_OPEN_WORDS);
    await refusedWith(trades.sendTradeByHuman(r.trade_id, ANA, 'counter', cfg), trades.TRADE_NO_LONGER_OPEN_WORDS);
  });

  it('declines only by the other side, on an open trade, with no reason', async () => {
    const r = await propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]);
    await refusedWith(trades.answerTrade(cfg, BEPPE, r.trade_id, 'decline'), trades.TRADE_NO_LONGER_OPEN_WORDS);
    await trades.sendTradeByHuman(r.trade_id, ANA, 'counter', cfg);
    await refusedWith(trades.answerTrade(cfg, ANA, r.trade_id, 'decline'), trades.TRADE_OWN_SIDE_WORDS);
    const out = await trades.answerTrade(cfg, BEPPE, r.trade_id, 'decline');
    expect(out).toEqual({ trade_id: r.trade_id, state: 'declined', note: { text: trades.TRADE_DECLINED_SENTENCE, provenance: 'switchboard-system' } });
    await expect(trades.answerTrade(cfg, CARLA, r.trade_id, 'decline')).rejects.toThrow(trades.NOT_YOUR_TRADE);
  });

  it('mints the accept page only for the other side, on an open trade still in time', async () => {
    const r = await propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]);
    await refusedWith(trades.answerTrade(cfg, BEPPE, r.trade_id, 'request_accept'), trades.TRADE_NO_LONGER_OPEN_WORDS);
    await trades.sendTradeByHuman(r.trade_id, ANA, 'counter', cfg);
    await refusedWith(trades.answerTrade(cfg, ANA, r.trade_id, 'request_accept'), trades.TRADE_OWN_SIDE_WORDS);
    const page = await trades.answerTrade(cfg, BEPPE, r.trade_id, 'request_accept');
    expect(page.say).toMatch(/^Here is your page — it asks whether to accept their trade, 1 thing of theirs for 1 thing of yours, and saying yes takes your passkey or PIN/);
    expect(links.at(-1)).toMatchObject({ action: 'trade-accept', refId: r.trade_id, accountId: BEPPE, counterpartyAccount: ANA });
    world.proposals.find((x) => x.id === r.trade_id).expiry = new Date(Date.now() - 1000);
    await refusedWith(trades.answerTrade(cfg, BEPPE, r.trade_id, 'request_accept'), trades.TRADE_EXPIRED_WORDS);
  });
});

// ---------------------------------------------------------------------------
describe('accepting: everything again under the lock, then the things come off', () => {
  async function openTrade(give: [string, number][], get: [string, number][], who = ANA) {
    const r = await propose(who, P.ab, give, get, { note: 'both in good order' });
    await trades.sendTradeByHuman(r.trade_id, who, 'counter', cfg);
    consentEvents.length = 0;
    return r.trade_id;
  }

  it('2-for-1, countered 1-for-1, accepted: quantities drop both sides, the last of one comes down, both get the record', async () => {
    const first = await openTrade([[C.levers, 2]], [[C.tool, 1]]);
    const counter = await openTrade([[C.tool, 1]], [[C.levers, 1]], BEPPE);
    expect(world.proposals.find((p) => p.id === first).state).toBe('superseded');
    // A draft of Ana's that needs the chain tool, still waiting for her press.
    const draft = await propose(ANA, P.ab, [[C.tape, 1]], [[C.tool, 1]]);
    const out = await trades.acceptTradeByHuman(counter, ANA, 'counter', cfg);
    expect(world.cards.get(C.levers)!.quantity_gone).toBe(1);
    expect(world.cards.get(C.tool)!.quantity_gone).toBe(1);
    expect(out.left).toEqual({ [C.tool]: 0, [C.levers]: 1 });
    // The last chain tool comes down, as traded; the levers stay up.
    expect(takenDown).toEqual([{ cardId: C.tool, keep: M.anchor, because: 'traded' }]);
    expect(world.cards.get(C.levers)!.lifecycle_state).toBe('PUBLISHED');
    // What can no longer be met closes.
    expect(world.proposals.find((p) => p.id === draft.trade_id)).toMatchObject({ state: 'closed', closed_because: 'taken_down' });
    const p = world.proposals.find((x) => x.id === counter);
    expect(p).toMatchObject({ state: 'accepted', accepted_by: ANA, accepted_via: 'counter' });
    expect(p.receipt_sha256).toBe(out.receipt.sha256);
    // The press, written down with both fingerprints.
    expect(consentEvents).toEqual([
      expect.objectContaining({ event: 'trade-accepted-by-human', trade_id: counter, account_id: ANA, recorded_via: 'counter', receipt_sha256: out.receipt.sha256, terms_sha256: p.terms_sha256 }),
    ]);
    // The record: each giver's words, the quantities, the note, no money.
    expect(out.receipt.block.split('\n')).toEqual([
      expect.stringMatching(/^Trade agreed: \d+ \w+ \d{4}, \d\d:\d\d UTC$/),
      'From the person who proposed it: chain tool, quantity 1.',
      'From the person who accepted it: brake lever set, quantity 1. As they posted it: Used.',
      receipt.TRADE_RECEIPT_NO_MONEY,
      'Note the person who proposed it sent with the trade: "both in good order"',
      'Proposed by one of the two, and accepted by the other, each with their own press.',
      receipt.TRADE_RECEIPT_POSTAGE,
    ]);
    expect(out.receipt.sha256).toBe(receipt.receiptFingerprint(out.receipt.block));
    // The terms the proposer pressed are the middle of the record.
    const terms = receipt.tradeTermsFrom({
      fromProposer: [{ thing: 'chain tool', quantity: 1 }],
      fromAccepter: [{ thing: 'brake lever set', details: 'Used.', quantity: 1 }],
      note: 'both in good order',
    });
    expect(terms.sha256).toBe(p.terms_sha256);
    expect(out.receipt.block).toContain(terms.block);
    // Emailed to both, the same record.
    expect(receipts.map((x) => x.accountId).sort()).toEqual([ANA, BEPPE]);
    for (const m of receipts) expect(m).toMatchObject({ offerId: counter, block: out.receipt.block, fingerprint: out.receipt.sha256 });
  });

  it('only the other side accepts, by their own press, once', async () => {
    const t = await openTrade([[C.levers, 1]], [[C.tool, 1]]);
    await expect(trades.acceptTradeByHuman(t, BEPPE, 'ops' as any, cfg)).rejects.toThrow(/human's own press/);
    await refusedWith(trades.acceptTradeByHuman(t, ANA, 'counter', cfg), trades.TRADE_OWN_SIDE_WORDS);
    await trades.acceptTradeByHuman(t, BEPPE, 'counter', cfg);
    await refusedWith(trades.acceptTradeByHuman(t, BEPPE, 'counter', cfg), trades.TRADE_NO_LONGER_OPEN_WORDS);
  });

  it('re-reads every thing under the lock: one taken down since the send refuses it and writes nothing', async () => {
    const t = await openTrade([[C.levers, 2]], [[C.tool, 1]]);
    world.cards.get(C.tool)!.lifecycle_state = 'WITHDRAWN';
    await refusedWith(trades.acceptTradeByHuman(t, BEPPE, 'counter', cfg), /can no longer be taken as it stands/);
    expect(world.cards.get(C.levers)!.quantity_gone).toBe(0);
    expect(world.proposals.find((p) => p.id === t).state).toBe('open');
    expect(consentEvents).toHaveLength(0);
    expect(receipts).toHaveLength(0);
  });

  it('re-reads what is left: fewer than it asks refuses it and writes nothing', async () => {
    const t = await openTrade([[C.levers, 2]], [[C.tool, 1]]);
    world.cards.get(C.levers)!.quantity_gone = 1; // one went in a sale
    await refusedWith(trades.acceptTradeByHuman(t, BEPPE, 'counter', cfg), /fewer left than it asks/);
    expect(world.cards.get(C.tool)!.quantity_gone).toBe(0);
    expect(consentEvents).toHaveLength(0);
  });

  it('re-reads the pairing and the clock', async () => {
    const t = await openTrade([[C.levers, 1]], [[C.tool, 1]]);
    world.proposals.find((p) => p.id === t).expiry = new Date(Date.now() - 1000);
    await refusedWith(trades.acceptTradeByHuman(t, BEPPE, 'counter', cfg), trades.TRADE_EXPIRED_WORDS);
    world.proposals.find((p) => p.id === t).expiry = new Date(Date.now() + 86_400_000);
    world.pairings[0].state = 'declined';
    await refusedWith(trades.acceptTradeByHuman(t, BEPPE, 'counter', cfg), trades.TRADE_PAIRING_ENDED_WORDS);
  });

  it('a thing that met no want any more is refused at the accept', async () => {
    const t = await openTrade([[C.levers, 1]], [[C.tool, 1]]);
    world.matches.find((m) => m.id === M.tool).state = 'declined';
    await refusedWith(trades.acceptTradeByHuman(t, BEPPE, 'counter', cfg), /come off its list or out of this pairing/);
  });

  describe('lines both ways', () => {
    const line = (id: string, askedBy: string, text: string, state = 'asked') =>
      world.lines.push({ id, match_id: M.anchor, asked_by: askedBy, line: { text, provenance: 'counterparty-untrusted' }, state, created_at: new Date(Date.now() + world.lines.length) });
    const L1 = uid('7a', 1);
    const L2 = uid('7a', 2);

    it('the accepter’s press confirms what waits on them; one they asked, still waiting, holds it up', async () => {
      const t = await openTrade([[C.levers, 1]], [[C.tool, 1]]);
      line(L1, ANA, 'the levers are both the same model', 'confirmed');
      line(L2, BEPPE, 'the chain tool has its pin');
      await refusedWith(trades.acceptTradeByHuman(t, BEPPE, 'counter', cfg), confirmLines.LINES_BLOCKED_PAIRING_WORDS);
      // Ana confirms what Beppe asked, on her own page.
      await confirmLines.confirmLinesByHuman(M.anchor, ANA, 'counter', { shown: [L2], on: 'lines-confirm' });
      expect(world.lines.find((l) => l.id === L2).state).toBe('confirmed');
      const out = await trades.acceptTradeByHuman(t, BEPPE, 'counter', cfg);
      expect(out.receipt.block).toContain('Asked by the person who proposed it, confirmed by the person who accepted it: "the levers are both the same model"');
      expect(out.receipt.block).toContain('Asked by the person who accepted it, confirmed by the person who proposed it: "the chain tool has its pin"');
    });

    it('the accept press confirms the lines its page listed, and refuses one it did not list', async () => {
      const t = await openTrade([[C.levers, 1]], [[C.tool, 1]]);
      line(L1, ANA, 'both levers work');
      await refusedWith(trades.acceptTradeByHuman(t, BEPPE, 'counter', cfg, { lines: { shown: [], on: 'trade-accept' } }), confirmLines.LINES_CHANGED_WORDS);
      expect(world.cards.get(C.levers)!.quantity_gone).toBe(0);
      await trades.acceptTradeByHuman(t, BEPPE, 'counter', cfg, { lines: { shown: [L1], on: 'trade-accept' } });
      expect(world.lines.find((l) => l.id === L1).state).toBe('confirmed');
    });

    it('a person never confirms their own line', async () => {
      line(L1, ANA, 'both levers work');
      const done = await confirmLines.confirmLinesByHuman(M.anchor, ANA, 'counter', { shown: [L1], on: 'lines-confirm' });
      expect(done.confirmed).toEqual([]);
      expect(world.lines.find((l) => l.id === L1).state).toBe('asked');
    });

    it('says to each side what waits on whom', () => {
      const lines = [{ state: 'asked', asked_by: BEPPE }] as any[];
      expect(confirmLines.pairingLinesNoteFor(ANA, lines).text).toBe(confirmLines.LINES_NOTE_PAIRING_WAITING_ON_YOU);
      expect(confirmLines.pairingLinesNoteFor(ANA, lines).lead).toBe(confirmLines.LINES_LEAD_PAIRING);
      expect(confirmLines.pairingLinesNoteFor(BEPPE, lines).text).toBe(confirmLines.LINES_NOTE_PAIRING_WAITING_ON_THEM);
      expect(confirmLines.pairingLinesNoteFor(BEPPE, [{ state: 'confirmed', asked_by: BEPPE }] as any).text).toBe(confirmLines.LINES_NOTE_PAIRING_CONFIRMED);
      expect(confirmLines.waitingOn([{ state: 'asked', asked_by: BEPPE }, { state: 'asked', asked_by: ANA }], ANA)).toHaveLength(1);
      expect(confirmLines.waitingOnOther([{ state: 'asked', asked_by: BEPPE }, { state: 'asked', asked_by: ANA }], ANA)).toHaveLength(1);
    });

    it('a sale between two lists says which way each line went; an ordinary one is as it always was', () => {
      const rows = [
        { id: 'a', state: 'confirmed', asked_by: BEPPE, line: { text: 'one' } },
        { id: 'b', state: 'confirmed', asked_by: ANA, line: { text: 'two' } },
        { id: 'c', state: 'withdrawn', asked_by: ANA, line: { text: 'gone' } },
      ] as any[];
      expect(confirmedForSale({ account_want: BEPPE, pairing_id: P.ab }, rows)).toEqual([
        { text: 'one', askedBy: 'buyer' },
        { text: 'two', askedBy: 'seller' },
      ]);
      expect(confirmedForSale({ account_want: BEPPE, pairing_id: null }, rows)).toEqual(['one', 'two']);
      const block = receipt.receiptBlock({ at: new Date(0), thing: 'x', amount: 5, ccy: 'AUD', offeredBy: 'buyer', confirmed: [{ text: 'two', askedBy: 'seller' }, 'one'] });
      expect(block).toContain('Asked by the seller, confirmed by the buyer: "two"');
      expect(block).toContain('Asked by the buyer, confirmed by the seller: "one"');
    });
  });
});

// ---------------------------------------------------------------------------
describe('the record of a trade', () => {
  const facts = {
    at: new Date(Date.UTC(2026, 10, 14, 3, 14)),
    fromProposer: [
      { thing: 'brake\nlever set', details: 'Used.', quantity: 2 },
      { thing: 'bar tape', quantity: 1 },
    ],
    fromAccepter: [{ thing: 'chain tool', quantity: 1 }],
    note: 'happy to post\r\nboth',
    confirmed: [
      { text: 'works', askedBy: 'accepter' as const },
      { text: 'same model', askedBy: 'proposer' as const },
    ],
  };

  it('is one fact a line, canonical, the same whoever reads it, with a reproducible fingerprint', () => {
    const r = receipt.tradeReceiptFrom(facts);
    expect(r.block).toBe(receipt.canonicalReceipt(r.block));
    expect(r.block.split('\n')).toEqual([
      'Trade agreed: 14 November 2026, 03:14 UTC',
      'From the person who proposed it: brake lever set, quantity 2. As they posted it: Used.',
      'From the person who proposed it: bar tape, quantity 1.',
      'From the person who accepted it: chain tool, quantity 1.',
      'No money is part of this trade.',
      'Note the person who proposed it sent with the trade: "happy to post both"',
      'Proposed by one of the two, and accepted by the other, each with their own press.',
      'Asked by the person who accepted it, confirmed by the person who proposed it: "works"',
      'Asked by the person who proposed it, confirmed by the person who accepted it: "same model"',
      receipt.TRADE_RECEIPT_POSTAGE,
    ]);
    expect(r.sha256).toBe(receipt.receiptFingerprint(r.block));
    expect(receipt.tradeReceiptFrom(facts).sha256).toBe(r.sha256);
    expect(receipt.tradeReceiptFrom({ ...facts, note: 'other' }).sha256).not.toBe(r.sha256);
    expect(lintHumanCopy(r.block)).toEqual([]);
  });

  it('names the two only where both have shared, by what each did', () => {
    const r = receipt.tradeReceiptFrom({ ...facts, people: { proposer: { firstName: 'Ana', locality: 'Holt' }, accepter: { firstName: 'Beppe', locality: 'Bruce' } } });
    expect(r.block.split('\n').slice(-2)).toEqual(['The person who proposed it: Ana, Holt', 'The person who accepted it: Beppe, Bruce']);
  });
});

// ---------------------------------------------------------------------------
describe('what each assistant and each page sees', () => {
  it('the pairing entry leads with a trade put to this reader, and says what to do', async () => {
    const r = await propose(ANA, P.ab, [[C.levers, 2]], [[C.tool, 1]], { note: 'hello' });
    const draft = await trades.tradeForEntry(world.pairings[0], ANA, true);
    expect(draft.lead).toBe(trades.TRADE_DRAFT_SENTENCE);
    expect((draft.fields.trade as any).what_to_do).toBe(trades.TRADE_WHAT_TO_DO_DRAFT);
    // A draft is the proposer's alone.
    const none = await trades.tradeForEntry(world.pairings[0], BEPPE, true);
    expect(none.lead).toBe(trades.TRADE_HOW_SENTENCE);
    expect(none.fields.trade).toBeUndefined();
    await trades.sendTradeByHuman(r.trade_id, ANA, 'counter', cfg);
    const theirs = await trades.tradeForEntry(world.pairings[0], BEPPE, true);
    expect(theirs.lead).toBe(trades.TRADE_FROM_THEM_SENTENCE);
    expect(theirs.fields.trade_waiting_on_you).toBe(true);
    const t = theirs.fields.trade as any;
    expect(t).toMatchObject({ trade_id: r.trade_id, from: 'them', state: 'open', what_to_do: trades.TRADE_WHAT_TO_DO_THEIRS });
    expect(t.you_get).toEqual([
      { item_id: C.levers, their_words: { text: 'brake lever set', provenance: 'counterparty-untrusted' }, details: { condition: 'used' }, quantity: 2 },
    ]);
    expect(t.you_give).toEqual([{ item_id: C.tool, your_item: 'chain tool', quantity: 1, left_now: 1 }]);
    expect(t.their_note).toEqual({ text: 'hello', provenance: 'counterparty-untrusted' });
    const mine = await trades.tradeForEntry(world.pairings[0], ANA, true);
    expect(mine.lead).toBe(trades.TRADE_FROM_YOU_SENTENCE);
    expect((mine.fields.trade as any).your_note).toEqual({ text: 'hello', provenance: 'counterparty-untrusted' });
    // Once declined, each side is told in its own words.
    await trades.answerTrade(cfg, BEPPE, r.trade_id, 'decline');
    expect((await trades.tradeForEntry(world.pairings[0], ANA, true)).lead).toBe(trades.LAST_TRADE_DECLINED_TO_PROPOSER);
    expect((await trades.tradeForEntry(world.pairings[0], BEPPE, true)).lead).toBe(trades.LAST_TRADE_DECLINED_TO_RECIPIENT);
  });

  it('the accept page lists both sides, the note as theirs, and what comes off the list, before the press', async () => {
    const r = await propose(ANA, P.ab, [[C.levers, 2]], [[C.tyre, 3]], { note: 'hello' });
    await trades.sendTradeByHuman(r.trade_id, ANA, 'counter', cfg);
    const v: any = await trades.tradePageView(BEPPE, r.trade_id, 'accept');
    expect(v.question).toBe('Accept this trade?');
    expect(v.sections).toEqual([
      { heading: trades.TRADE_YOU_GIVE_HEADING, rows: ['tyre lever, quantity 3.'] },
      { heading: trades.TRADE_YOU_GET_HEADING, rows: ['“brake lever set”, quantity 2. Used.'] },
      { heading: trades.TRADE_COMES_OFF_HEADING, rows: ['tyre lever: 3 of it, the last of it, so it comes off your list.'] },
    ]);
    expect(v.detail).toEqual(['Their note, in their own words: “hello”.', trades.TRADE_POSTAGE_LINE, trades.TRADE_ACCEPT_ELSEWHERE_LINE]);
    expect(v.yesLabel).toBe('Accept this trade');
    expect(await trades.tradePageView(ANA, r.trade_id, 'accept')).toEqual({ error: trades.TRADE_OWN_SIDE_WORDS });
    const send: any = await trades.tradePageView(ANA, (await propose(ANA, P.ab, [[C.levers, 1]], [[C.tyre, 1]])).trade_id, 'send');
    expect(send.question).toBe('Send this trade?');
    expect(send.sections.at(-1)).toEqual({ heading: trades.TRADE_COMES_OFF_IF_HEADING, rows: ['brake lever set: 1 of it, and 1 left on your list after this.'] });
  });

  it('the two pages are one-question pages that take the PIN or passkey every time', () => {
    for (const a of ['trade-send', 'trade-accept']) {
      expect(ONE_QUESTION_ACTIONS).toContain(a);
      expect(FRESH_CEREMONY_ACTIONS.has(a)).toBe(true);
      expect(isTradeAction(a)).toBe(true);
    }
    expect(fetchAgainFor({ action: 'trade-accept', ref_id: 'x' })).toEqual({ tool: 'answer_trade', action: 'request_accept', trade_id: 'x' });
    expect(fetchAgainFor({ action: 'trade-send', ref_id: 'x' })).toEqual({ tool: 'propose_trade' });
  });
});

// ---------------------------------------------------------------------------
describe('the seams', () => {
  const src = (f: string) => readFileSync(join(__dirname, '..', '..', 'src', f), 'utf8');

  it('ending a pairing closes its trades in the ending’s own transaction', () => {
    const s = src('domain/pairings.ts');
    const end = s.slice(s.indexOf('export async function endPairing'));
    const close = end.indexOf('client.query(CLOSE_ON_PAIRING_END_SQL');
    expect(close).toBeGreaterThan(end.indexOf('memberEndingSql(end)'));
    expect(close).toBeLessThan(end.indexOf("await client.query('COMMIT');\n  } catch"));
    expect(trades.CLOSE_ON_PAIRING_END_SQL).toMatch(/state IN \('open', 'awaiting-send'\)/);
  });

  it('no money in a trade: the database refuses it, and nothing writes it', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'migrations', '075_trade_proposals.sql'), 'utf8');
    expect(sql).toMatch(/trade_proposals_no_cash_yet CHECK \(cash_amount IS NULL AND cash_ccy IS NULL AND cash_from IS NULL\)/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS trade_proposals_one_open_idx\s+ON trade_proposals \(pairing_id\) WHERE state = 'open'/);
    expect(sql).toMatch(/accepted_via = 'counter'/);
    expect(src('domain/trades.ts')).not.toMatch(/cash_amount\s*=|SET cash_/);
  });

  it('a sale or a trade that leaves fewer closes the trades that counted on more', () => {
    expect(src('domain/offers.ts')).toContain('closeUnmeetableTrades([m.card_have])');
    expect(src('domain/quantities.ts')).toContain('closeUnmeetableTrades([cardId])');
    expect(src('domain/pairings.ts')).toContain('closeUnaskableTrades(ids)');
  });

  it('nothing on the tool surface accepts or sends a trade', () => {
    const tools = src('mcp/tools.ts');
    expect(tools).not.toMatch(/acceptTradeByHuman|sendTradeByHuman/);
    expect(src('workers/opsWorker.ts')).not.toMatch(/acceptTradeByHuman|sendTradeByHuman/);
  });

  it('every sentence a person or an assistant reads keeps the house register, and names no kind of thing', () => {
    const words = Object.entries(trades).filter(([k, v]) => typeof v === 'string' && /^[A-Z_]+$/.test(k) && !k.endsWith('_SQL'));
    expect(words.length).toBeGreaterThan(40);
    for (const [k, v] of words) {
      expect(lintHumanCopy(v as string), k).toEqual([]);
      expect(v as string, k).not.toMatch(/pok[eé]mon|\bcards?\b|\bfair\b(?! or)/i);
    }
    for (const s of [
      confirmLines.LINES_NOTE_PAIRING_WAITING_ON_YOU,
      confirmLines.LINES_NOTE_PAIRING_WAITING_ON_THEM,
      confirmLines.LINES_NOTE_PAIRING_CONFIRMED,
      confirmLines.LINES_LEAD_PAIRING,
      confirmLines.LINES_BLOCKED_PAIRING_WORDS,
      receipt.TRADE_RECEIPT_POSTAGE,
      receipt.TRADE_RECEIPT_NO_MONEY,
    ]) {
      expect(lintHumanCopy(s)).toEqual([]);
    }
  });
});


describe('the page itself', () => {
  it('prints each list under its heading, escaped, with the other side’s words in quotation marks', async () => {
    const { oneQuestionPage } = await import('../../src/counter/pages.js');
    const html = oneQuestionPage({
      token: 'tok',
      question: 'Accept this trade?',
      detail: [trades.TRADE_POSTAGE_LINE],
      sections: [
        { heading: trades.TRADE_YOU_GIVE_HEADING, rows: ['tyre lever, quantity 3.'] },
        { heading: trades.TRADE_YOU_GET_HEADING, rows: ['“<b>brake</b> lever set”, quantity 2.'] },
        { heading: 'Empty', rows: [] },
      ],
      yesLabel: 'Accept this trade',
      noLabel: 'Not now',
      needsPin: true,
      hasPin: true,
      hasPasskey: false,
      elevated: false,
      fresh: true,
    });
    expect(html).toContain('<h2>You give</h2>');
    expect(html).toContain('&lt;b&gt;brake&lt;/b&gt;');
    expect(html).not.toContain('<h2>Empty</h2>');
    expect(html.indexOf('<h2>You give</h2>')).toBeLessThan(html.indexOf('<form'));
    expect(lintHumanCopy(html)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('a human who hears by email is told', () => {
  const withQueue = { ...cfg, opsQueueUrl: 'https://sqs.test/ops' } as unknown as Config;

  it('the person a trade is put to, when it is sent; the proposer, when it is accepted or turned down', async () => {
    const a = await propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]);
    expect(sqsJobs).toEqual([]);
    await trades.sendTradeByHuman(a.trade_id, ANA, 'counter', withQueue);
    expect(sqsJobs).toEqual([{ op: 'trade-notify', trade_id: a.trade_id, moment: 'arrived' }]);
    await trades.answerTrade(withQueue, BEPPE, a.trade_id, 'decline');
    expect(sqsJobs.at(-1)).toEqual({ op: 'trade-notify', trade_id: a.trade_id, moment: 'declined' });
    const b = await propose(BEPPE, P.ab, [[C.tool, 1]], [[C.levers, 1]]);
    await trades.sendTradeByHuman(b.trade_id, BEPPE, 'counter', withQueue);
    await trades.acceptTradeByHuman(b.trade_id, ANA, 'counter', withQueue);
    expect(sqsJobs.slice(-2)).toEqual([
      { op: 'trade-notify', trade_id: b.trade_id, moment: 'arrived' },
      { op: 'trade-notify', trade_id: b.trade_id, moment: 'accepted' },
    ]);
  });

  it('nothing for a withdrawal or a draft, and nothing where no queue is wired', async () => {
    const a = await propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]);
    await trades.answerTrade(withQueue, ANA, a.trade_id, 'withdraw');
    const b = await propose(ANA, P.ab, [[C.tape, 1]], [[C.tool, 1]]);
    await trades.sendTradeByHuman(b.trade_id, ANA, 'counter', cfg);
    expect(sqsJobs).toEqual([]);
  });

  it('a queue that will not take the job costs the trade nothing', async () => {
    const { sqs } = await import('../../src/aws.js');
    (sqs.send as any).mockRejectedValueOnce(new Error('SQS down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await propose(ANA, P.ab, [[C.levers, 1]], [[C.tool, 1]]);
    await trades.sendTradeByHuman(a.trade_id, ANA, 'counter', withQueue);
    expect(world.proposals.find((x) => x.id === a.trade_id).state).toBe('open');
  });
});

// ---------------------------------------------------------------------------
describe('a trade holds the pairing’s clock', () => {
  const SLOT = 24 * 60 * 60_000;
  const now = Date.now();
  /** The clause, as the test reads it: the model the SQL below is held to. */
  const holds = (t: any, link?: { used: boolean; expiresAt: number }) =>
    t.state === 'accepted' ||
    (t.state === 'open' && t.expiry > now - SLOT) ||
    (['declined', 'withdrawn', 'closed', 'expired', 'superseded'].includes(t.state) && t.updated_at > now - SLOT) ||
    (t.state === 'awaiting-send' && !!link && !link.used && link.expiresAt > now);

  it('holds while a trade is open, through its whole seven days, and for a slot after it ran out', () => {
    expect(holds({ state: 'open', expiry: now + 6.9 * SLOT })).toBe(true);
    expect(holds({ state: 'open', expiry: now - SLOT / 2 })).toBe(true);
    expect(holds({ state: 'open', expiry: now - 2 * SLOT })).toBe(false);
  });

  it('starts the ordinary clock again from the moment a trade ends', () => {
    for (const state of ['declined', 'withdrawn', 'closed', 'expired', 'superseded']) {
      expect(holds({ state, updated_at: now - 1000 }), state).toBe(true);
      expect(holds({ state, updated_at: now - SLOT - 1000 }), state).toBe(false);
    }
    expect(holds({ state: 'accepted', updated_at: now - 30 * SLOT })).toBe(true);
  });

  it('holds for a draft only while its page to send it is still good', () => {
    expect(holds({ state: 'awaiting-send' }, { used: false, expiresAt: now + 60_000 })).toBe(true);
    expect(holds({ state: 'awaiting-send' }, { used: false, expiresAt: now - 1 })).toBe(false);
    expect(holds({ state: 'awaiting-send' }, { used: true, expiresAt: now + 60_000 })).toBe(false);
    expect(holds({ state: 'awaiting-send' })).toBe(false);
  });

  it('the lapse reads exactly that clause, against the pairing’s slot', async () => {
    const { LAPSE_DUE_SQL, TRADE_HOLDS_CLOCK_SQL, PAIRING_SLOT_MINUTES, lapseDuePairings } = await import('../../src/domain/pairings.js');
    const sql = LAPSE_DUE_SQL(200).replace(/\s+/g, ' ');
    expect(sql).toContain(`AND NOT ${TRADE_HOLDS_CLOCK_SQL}`.replace(/\s+/g, ' '));
    const clause = TRADE_HOLDS_CLOCK_SQL.replace(/\s+/g, ' ');
    expect(clause).toContain("t.state = 'accepted'");
    expect(clause).toContain("(t.state = 'open' AND t.expiry > now() - make_interval(mins => $1::int))");
    expect(clause).toContain("t.state IN ('declined', 'withdrawn', 'closed', 'expired', 'superseded') AND t.updated_at > now() - make_interval(mins => $1::int)");
    expect(clause).toContain("a.action = 'trade-send' AND a.ref_id = t.id AND a.used_at IS NULL AND a.expires_at > now()");
    // And the lapse runs it with the slot.
    const seen: any[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({ query: async (q: string, p: any[]) => (seen.push([q, p]), { rows: [], rowCount: 0 }) } as any);
    expect(await lapseDuePairings(cfg)).toEqual({ lapsed: 0, promoted: 0 });
    expect(seen[0][0]).toBe(LAPSE_DUE_SQL(200));
    expect(seen[0][1]).toEqual([PAIRING_SLOT_MINUTES]);
  });
});

// ---------------------------------------------------------------------------
describe('a figure’s page on one thing between two lists reads the lines between them', () => {
  it('says the page lists what the other side asked, read off the anchor, for either side', async () => {
    const { sendNumberLink } = await import('../../src/domain/humanLinks.js');
    // Ana is the buying side on the chain tool's own introduction; the line
    // Beppe asked rides the anchor and waits on her.
    world.lines.push({ id: uid('7b', 1), match_id: M.anchor, asked_by: BEPPE, line: { text: 'pin included' }, state: 'asked', created_at: new Date() });
    const page = await sendNumberLink(cfg, ANA, M.tool, { amount: 5, ccy: 'AUD' });
    expect(page.say).toContain('It also lists what the other side has asked you to confirm in writing');
    expect(page.what_it_does).toContain('what the other side asked them to confirm');
    // Beppe has nothing waiting on him: his page says nothing of lines.
    const his = await sendNumberLink(cfg, BEPPE, M.tool, { amount: 5, ccy: 'AUD' });
    expect(his.say).not.toContain('confirm in writing');
  });
});
