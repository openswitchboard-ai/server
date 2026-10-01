/**
 * Written lines the seller's human confirms (2 October 2026).
 *
 * The switchboard introduces people and keeps records; it never referees. A
 * claim made in conversation leaves nothing behind, because a conversation is
 * carried and then let go. So what matters goes on the deal as a short
 * written line: the buying side's assistant asks it, the SELLER'S HUMAN
 * confirms it with their own press, and the record lists the confirmed ones.
 *
 * What this suite holds shut:
 *  - asking: the buying side only, never on a swap, never after an accept,
 *    inside the limit, and through every gate an offer note passes (length,
 *    plain text, no way of reaching anybody, no figure, the intake pipe);
 *  - taking one off: only the side that asked, and never after an accept;
 *  - THE RULE: an offer is accepted only with every asked line confirmed. A
 *    seller who leaves one unticked agrees nothing and their answers are
 *    saved; a buyer is refused while one is unanswered or answered no, and is
 *    let through once it is taken off; sending a figure is never held up;
 *  - only a press on the human's own page answers a line: no tool, no agent
 *    key and no queue message can;
 *  - every answer is written to the locked log, naming the introduction and
 *    the line and never the words;
 *  - the record lists the confirmed lines, in the order asked, inside the
 *    fingerprinted block, and no others;
 *  - on a best offer one buyer's lines hold up that buyer's number alone;
 *  - where no line was ever asked, nothing at all is different.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const intake = vi.fn(async (_cfg: unknown, _item: any) => ({ outcome: 'pass', checks: [] }) as any);
vi.mock('../../src/intake/pipe.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runIntake: (cfg: unknown, item: any) => intake(cfg, item),
}));

import { writeConsentEvent } from '../../src/crypto.js';
import * as db from '../../src/db.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import * as lines from '../../src/domain/confirmLines.js';
import * as offers from '../../src/domain/offers.js';
import { DEAL_AGREED_RECORD_SENT, DEAL_AGREED_WHAT_TO_DO, checkMatches } from '../../src/domain/matches.js';
import { buildReceipt, receiptBlock, receiptFingerprint } from '../../src/domain/receipt.js';
import { compactCandidate } from '../../src/domain/leanSweep.js';
import { TOOLS, argumentComplaint, dispatchTool, toolsFor } from '../../src/mcp/tools.js';
import { MANUAL, MANUAL_CHANGELOG, manualSection } from '../../src/mcp/instructions.js';
import { FRESH_CEREMONY_ACTIONS, LINES_CONFIRM_ACTION } from '../../src/counter/credentials.js';
import * as pages from '../../src/counter/pages.js';
import * as home from '../../src/counter/pagesHome.js';
import { CONFIRM_WAITING_LABEL, CONFIRM_WAITING_STEP, groupWaitingByMatch } from '../../src/counter/matchStory.js';
import { lintEmailCopy, lintHumanCopy } from '../../src/email/lint.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6, maxWritesPerHour: 300 },
  docsBase: 'https://openswitchboard.ai/docs',
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_MATCH = 'aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side (buyer)
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side (seller)
const CARLA = 'cccccccc-3333-4333-8333-dddddddddddd'; // another buyer on the same have
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const ANAS_OFFER = '0f0f0f0f-0000-4000-8000-000000000001'; // the buyer's figure
const BEPPES_OFFER = '0f0f0f0f-0000-4000-8000-000000000002'; // the seller's figure
const CARLAS_OFFER = '0f0f0f0f-0000-4000-8000-000000000003';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
let seq = 0;
const lineId = () => `11111111-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

interface LineRow {
  id: string;
  match_id: string;
  asked_by: string;
  line: any;
  state: string;
  created_at: Date;
  answered_at: Date | null;
  answered_by: string | null;
  answered_via: string | null;
  answered_on: string | null;
}

interface World {
  swap: boolean;
  bestOffer: boolean;
  matchState: string;
  offers: any[];
  lines: LineRow[];
  /** Every statement, in order, so a test can see what ran inside the lock. */
  log: string[];
}
let world: World;

const matchRow = (id: string) => ({
  id,
  card_want: CARD_W,
  card_have: CARD_H,
  account_want: id === MATCH ? ANA : CARLA,
  account_have: BEPPE,
  score: 0.8,
  category: 'goods.bicycle.mountain',
  stage: 2,
  interest_want: true,
  interest_have: true,
  state: world.matchState,
  live: true,
  channel_id: null,
  opened_at: null,
  swap: world.swap,
});

const haveCard = () => ({
  id: CARD_H,
  account_id: BEPPE,
  type: 'HAVE',
  category: 'goods.bicycle.mountain',
  kind: 'mountain bike',
  lifecycle_state: 'PUBLISHED',
  attributes: {},
  sale: world.bestOffer ? 'best-offer' : 'straight',
  screened_content: {
    version: 1,
    at: '2026-10-01T00:00:00.000Z',
    kind: 'Trek Marlin 5 mountain bike',
    also_called: null,
    not_these: null,
    attributes: { frame_size: 'Medium frame' },
    ask: null,
  },
});

const anOffer = (id: string, proposer: string, matchId = MATCH, over: Record<string, unknown> = {}) => ({
  id,
  match_id: matchId,
  proposer_account: proposer,
  amount: '415',
  ccy: 'AUD',
  expiry: new Date(Date.now() + 7 * 86_400_000),
  state: 'proposed',
  message: null,
  authored_by: 'human',
  created_at: new Date(),
  receipt_sha256: null,
  ...over,
});

/** Put a line straight into the world, as if it had been asked earlier. */
const seed = (text: string, state = 'asked', matchId = MATCH, askedBy = ANA): LineRow => {
  const row: LineRow = {
    id: lineId(),
    match_id: matchId,
    asked_by: askedBy,
    line: { text, provenance: 'counterparty-untrusted' },
    state,
    created_at: new Date(Date.now() + seq),
    answered_at: state === 'asked' ? null : new Date(),
    answered_by: state === 'asked' ? null : BEPPE,
    answered_via: state === 'asked' ? null : 'counter',
    answered_on: null,
  };
  world.lines.push(row);
  return row;
};

function fakePool() {
  const query = async (sql: string, params: any[] = []) => {
    const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
    world.log.push(sql.replace(/\s+/g, ' ').trim().slice(0, 140));

    // --- the written lines ---
    if (/INSERT INTO confirm_lines/.test(sql)) {
      const [matchId, askedBy, stored, max, ever] = params;
      const here = world.lines.filter((l) => l.match_id === matchId);
      if (here.filter((l) => l.state !== 'withdrawn').length >= max || here.length >= ever) {
        return rows([]);
      }
      const row: LineRow = {
        id: lineId(),
        match_id: matchId,
        asked_by: askedBy,
        line: JSON.parse(stored),
        state: 'asked',
        created_at: new Date(Date.now() + seq),
        answered_at: null,
        answered_by: null,
        answered_via: null,
        answered_on: null,
      };
      world.lines.push(row);
      return rows([row]);
    }
    if (/FROM confirm_lines\s+WHERE match_id = \$1 AND state <> 'withdrawn'/.test(sql)) {
      return rows(world.lines.filter((l) => l.match_id === params[0] && l.state !== 'withdrawn'));
    }
    if (/FROM confirm_lines WHERE id = \$1 AND match_id = \$2/.test(sql)) {
      return rows(world.lines.filter((l) => l.id === params[0] && l.match_id === params[1]));
    }
    if (/UPDATE confirm_lines SET state = 'withdrawn'/.test(sql)) {
      const l = world.lines.find((x) => x.id === params[0]);
      if (l) l.state = 'withdrawn';
      return rows([]);
    }
    if (/SELECT id, state FROM confirm_lines/.test(sql)) {
      return rows(
        world.lines.filter(
          (l) => l.match_id === params[0] && (l.state === 'asked' || l.state === 'declined'),
        ),
      );
    }
    if (/UPDATE confirm_lines\s+SET state = \$2/.test(sql)) {
      const [matchId, state, by, via, on, ids] = params;
      const from = /state IN \('asked', 'declined'\)/.test(sql) ? ['asked', 'declined'] : ['asked'];
      for (const l of world.lines) {
        if (l.match_id === matchId && ids.includes(l.id) && from.includes(l.state)) {
          Object.assign(l, { state, answered_at: new Date(), answered_by: by, answered_via: via, answered_on: on });
        }
      }
      return rows([]);
    }

    // --- the figures ---
    if (/SELECT (1|receipt_sha256) FROM offers WHERE match_id = \$1 AND state = 'accepted-by-human'/.test(sql)) {
      return rows(
        world.offers
          .filter((o) => o.match_id === params[0] && o.state === 'accepted-by-human')
          .map((o) => ({ receipt_sha256: o.receipt_sha256 })),
      );
    }
    if (/SELECT \* FROM offers WHERE id/.test(sql)) {
      return rows(world.offers.filter((o) => o.id === params[0]));
    }
    if (/FROM offers\s+WHERE match_id = \$1 AND state IN \('proposed', 'awaiting-human', 'accepted-by-human'\)/.test(sql)) {
      return rows(world.offers.filter((o) => o.match_id === params[0] && o.state !== 'declined'));
    }
    if (/SELECT \* FROM offers WHERE match_id/.test(sql)) {
      return rows(world.offers.filter((o) => o.match_id === params[0]));
    }
    if (/UPDATE offers SET state='accepted-by-human'/.test(sql)) {
      const o = world.offers.find((x) => x.id === params[0]);
      if (o) Object.assign(o, { state: 'accepted-by-human', receipt_sha256: params[1] ?? null });
      return rows(o ? [o] : []);
    }
    if (/UPDATE offers o SET state = 'declined'/.test(sql)) {
      for (const o of world.offers) {
        if (o.id !== params[1] && ['proposed', 'awaiting-human'].includes(o.state)) o.state = 'declined';
      }
      return rows([]);
    }
    if (/SELECT c\.id FROM matches m JOIN cards c/.test(sql)) {
      return rows(world.bestOffer ? [{ id: CARD_H }] : []);
    }
    if (/FROM matches m JOIN cards c ON c\.id = m\.card_have/.test(sql)) {
      return rows([{ card_id: CARD_H, sale: world.bestOffer ? 'best-offer' : 'straight', open: false }]);
    }
    if (/INSERT INTO offers/.test(sql)) {
      const row = anOffer(lineId(), params[1], params[0], { amount: params[2], ccy: params[3] });
      world.offers.push(row);
      return rows([row]);
    }
    if (/SELECT count\(\*\)::int AS n,\s*min\(created_at\)/.test(sql)) return rows([{ n: 0, oldest: new Date() }]);
    if (/read_calls|write_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
    if (/count\(\*\)::int AS n/.test(sql)) return rows([{ n: 0 }]);

    // --- the introduction, the posting, the people ---
    if (/^\s*SELECT \* FROM matches WHERE id/.test(sql)) {
      return rows([MATCH, OTHER_MATCH].includes(params[0]) ? [matchRow(params[0])] : []);
    }
    if (/^\s*SELECT m\.\*[^;]*FROM matches m/.test(sql)) return rows([matchRow(MATCH)]);
    if (/count\(\*\)::int AS n FROM matches m/.test(sql)) return rows([{ n: 0 }]);
    if (/INSERT INTO approval_links/.test(sql)) return rows([{ id: lineId() }]);
    if (/SELECT \* FROM cards WHERE id/.test(sql)) {
      return rows(
        params[0] === CARD_H
          ? [haveCard()]
          : [{ id: CARD_W, account_id: ANA, type: 'WANT', category: 'goods.bicycle.mountain', lifecycle_state: 'PUBLISHED' }],
      );
    }
    if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
      return rows([{ id: params[0], status: 'active', data_key_enc: Buffer.from('wrapped') }]);
    }
    if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: 'assistant' }]);
    return rows([]);
  };
  return { query, connect: async () => ({ query, release: () => {} }) } as any;
}

beforeAll(async () => {
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
});

beforeEach(() => {
  seq = 0;
  world = {
    swap: false,
    bestOffer: false,
    matchState: 'open',
    offers: [anOffer(ANAS_OFFER, ANA), anOffer(BEPPES_OFFER, BEPPE, MATCH, { amount: '450' })],
    lines: [],
    log: [],
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(writeConsentEvent).mockClear();
  intake.mockReset().mockResolvedValue({ outcome: 'pass', checks: [] });
});

const events = () => vi.mocked(writeConsentEvent).mock.calls.map(([e]) => e as Record<string, any>);
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e: any) {
    if (e instanceof OsbError) return String(e.payload.human_action ?? e.payload.code);
    return String(e?.message);
  }
  throw new Error('expected a refusal');
};
const press = (shown: LineRow[], ticked: LineRow[], on: lines.AnsweredOn = 'offer-accept') => ({
  shown: shown.map((l) => l.id),
  ticked: ticked.map((l) => l.id),
  on,
});

// ---------------------------------------------------------------------------
describe('asking a line', () => {
  it('stores it the way an offer note is stored, and says what happens next', async () => {
    const asked: any = await lines.askLine(cfg, ANA, MATCH, '  Comes with both keys  ');
    expect(asked).toMatchObject({
      intro_id: MATCH,
      state: 'asked',
      line: { text: 'Comes with both keys', provenance: 'counterparty-untrusted' },
    });
    expect(world.lines).toHaveLength(1);
    expect(world.lines[0]).toMatchObject({ match_id: MATCH, asked_by: ANA, state: 'asked' });
    expect(world.lines[0].line).toEqual({ text: 'Comes with both keys', provenance: 'counterparty-untrusted' });
  });

  it('goes through the offer_words door, on the same terms as an offer note', async () => {
    await lines.askLine(cfg, ANA, MATCH, 'Comes with both keys');
    expect(intake).toHaveBeenCalledTimes(1);
    expect(intake.mock.calls[0][1]).toMatchObject({
      door: 'offer_words',
      sender_account: ANA,
      recipient_account: BEPPE,
      match_id: MATCH,
      text: 'Comes with both keys',
    });
  });

  it('refuses what the intake pipe refuses, and asks nothing', async () => {
    intake.mockResolvedValue({ outcome: 'refuse', reason_code: 'x', plain_words: 'Those words will not go.', checks: [] });
    expect(await refusal(lines.askLine(cfg, ANA, MATCH, 'Comes with both keys'))).toBe('Those words will not go.');
    intake.mockResolvedValue({ outcome: 'refuse', reason_code: 'SUSPENDED', plain_words: 'This account is stopped.', checks: [] });
    await expect(lines.askLine(cfg, ANA, MATCH, 'Comes with both keys')).rejects.toMatchObject({
      payload: { code: 'SUSPENDED', human_action: 'This account is stopped.' },
    });
    expect(world.lines).toHaveLength(0);
  });

  it('a hold still asks, as a held note still rides', async () => {
    intake.mockResolvedValue({ outcome: 'hold', checks: [] });
    await lines.askLine(cfg, ANA, MATCH, 'Comes with both keys');
    expect(world.lines).toHaveLength(1);
  });

  it('holds the words to the note rule before any model is asked', async () => {
    for (const [bad, why] of [
      ['', /needs some words/],
      ['   ', /needs some words/],
      ['x'.repeat(lines.CONFIRM_LINE_MAX_CHARS + 1), /too long/],
      ['Has a <b>new</b> chain', /Plain text only/],
      ['Email me at sam@example.com to check', /ways of reaching anybody/],
      ['See www.example.com/bike for the photos', /ways of reaching anybody/],
    ] as const) {
      await expect(lines.askLine(cfg, ANA, MATCH, bad), bad.slice(0, 20)).rejects.toMatchObject({
        validation: ['line'],
        message: expect.stringMatching(why),
      });
    }
    await expect(lines.askLine(cfg, ANA, MATCH, 42)).rejects.toMatchObject({ validation: ['line'] });
    expect('x'.repeat(lines.CONFIRM_LINE_MAX_CHARS)).toHaveLength(200);
    expect(lines.validateConfirmLine('x'.repeat(200)).ok).toBe(true);
    expect(intake).not.toHaveBeenCalled();
    expect(world.lines).toHaveLength(0);
  });

  it('refuses a sum of money in the words', async () => {
    for (const bad of ['Includes the $50 lock', 'Worth four hundred dollars new']) {
      expect(await refusal(lines.askLine(cfg, ANA, MATCH, bad)), bad).toBe(lines.LINE_HAS_FIGURE);
    }
    // A size or a count is not a figure, and travels.
    await lines.askLine(cfg, ANA, MATCH, 'Has 29 inch wheels and two spare tubes');
    expect(world.lines).toHaveLength(1);
  });

  it('takes as many as the limit and no more, and the limit is the deployment’s', async () => {
    expect(lines.maxLinesFor(cfg)).toBe(10);
    expect(lines.maxLinesFor({ maxConfirmLines: 3 })).toBe(3);
    for (let i = 0; i < 10; i++) await lines.askLine(cfg, ANA, MATCH, `Thing number ${i} is as described`);
    expect(await refusal(lines.askLine(cfg, ANA, MATCH, 'One more thing is as described'))).toBe(lines.LINES_FULL);
    expect(world.lines).toHaveLength(10);
    // Taking one off makes room for one.
    await lines.withdrawLine(ANA, MATCH, world.lines[0].id);
    await lines.askLine(cfg, ANA, MATCH, 'One more thing is as described');
    expect(world.lines.filter((l) => l.state !== 'withdrawn')).toHaveLength(10);
  });

  it('holds the limit in the write itself, under the lock', async () => {
    const small = { ...cfg, maxConfirmLines: 2 } as Config;
    await lines.askLine(small, ANA, MATCH, 'First thing is as described');
    await lines.askLine(small, ANA, MATCH, 'Second thing is as described');
    world.log = [];
    expect(await refusal(lines.askLine(small, ANA, MATCH, 'Third thing is as described'))).toBe(lines.LINES_FULL);
    // And the insert carries both counts where it does run.
    world.lines.pop();
    await lines.askLine(small, ANA, MATCH, 'Third thing is as described');
    const at = (re: RegExp) => world.log.findIndex((s) => re.test(s));
    expect(at(/pg_advisory_xact_lock/)).toBeGreaterThan(at(/^BEGIN/));
    expect(at(/INSERT INTO confirm_lines/)).toBeGreaterThan(at(/pg_advisory_xact_lock/));
    expect(at(/^COMMIT/)).toBeGreaterThan(at(/INSERT INTO confirm_lines/));
  });

  it('is refused on a swap, in plain words', async () => {
    world.swap = true;
    expect(await refusal(lines.askLine(cfg, ANA, MATCH, 'Comes with both keys'))).toBe(lines.LINES_NO_DEAL_HERE);
  });

  it('is refused to the selling side, in plain words', async () => {
    expect(await refusal(lines.askLine(cfg, BEPPE, MATCH, 'Comes with both keys'))).toBe(lines.LINES_BUYING_SIDE_ONLY);
    expect(await refusal(lines.withdrawLine(BEPPE, MATCH, seed('Comes with both keys').id))).toBe(
      lines.LINES_BUYING_SIDE_ONLY,
    );
    expect(intake).not.toHaveBeenCalled();
  });

  it('is not found for somebody who is not on the introduction', async () => {
    await expect(lines.askLine(cfg, CARLA, MATCH, 'Comes with both keys')).rejects.toMatchObject({ notFound: true });
  });

  it('is refused once an offer on the introduction is accepted: a line cannot undo a deal', async () => {
    world.offers[0].state = 'accepted-by-human';
    expect(await refusal(lines.askLine(cfg, ANA, MATCH, 'Comes with both keys'))).toBe(lines.LINES_AFTER_ACCEPT);
    expect(intake).not.toHaveBeenCalled();
    expect(world.lines).toHaveLength(0);
  });

  it('is refused on an introduction that has closed', async () => {
    world.matchState = 'archived';
    expect(await refusal(lines.askLine(cfg, ANA, MATCH, 'Comes with both keys'))).toBe(lines.LINES_NOT_OPEN);
  });
});

// ---------------------------------------------------------------------------
describe('taking a line off', () => {
  it('takes off one of the asker’s own, whatever the answer to it was', async () => {
    for (const state of ['asked', 'confirmed', 'declined']) {
      const l = seed('Comes with both keys', state);
      const off = await lines.withdrawLine(ANA, MATCH, l.id);
      expect(off).toMatchObject({ confirmation_id: l.id, state: 'withdrawn', already: false });
      expect(l.state).toBe('withdrawn');
    }
  });

  it('answers the same for one already off', async () => {
    const l = seed('Comes with both keys', 'withdrawn');
    expect(await lines.withdrawLine(ANA, MATCH, l.id)).toMatchObject({ already: true });
  });

  it('finds nothing for a line on another introduction, or one that is nobody’s', async () => {
    const theirs = seed('Comes with a pump', 'asked', OTHER_MATCH, CARLA);
    await expect(lines.withdrawLine(ANA, MATCH, theirs.id)).rejects.toMatchObject({ notFound: true });
    await expect(lines.withdrawLine(ANA, MATCH, lineId())).rejects.toMatchObject({ notFound: true });
    expect(theirs.state).toBe('asked');
  });

  it('takes nothing off a deal that is already agreed', async () => {
    const l = seed('Comes with both keys', 'confirmed');
    world.offers[0].state = 'accepted-by-human';
    expect(await refusal(lines.withdrawLine(ANA, MATCH, l.id))).toBe(lines.LINES_AFTER_ACCEPT);
    expect(l.state).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
describe('the rule: accepted only with every asked line confirmed', () => {
  it('the seller ticks them all and the buyer’s figure is accepted', async () => {
    const a = seed('Comes with both keys');
    const b = seed('Brakes were serviced this year');
    const o: any = await offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter', undefined, {
      lines: press([a, b], [a, b]),
    });
    expect(o.state).toBe('accepted-by-human');
    expect([a.state, b.state]).toEqual(['confirmed', 'confirmed']);
    expect(a).toMatchObject({ answered_by: BEPPE, answered_via: 'counter', answered_on: 'offer-accept' });
  });

  it('the seller leaves one unticked: nothing is agreed, and the answers are saved', async () => {
    const a = seed('Comes with both keys');
    const b = seed('Brakes were serviced this year');
    const p = offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter', undefined, { lines: press([a, b], [a]) });
    await expect(p).rejects.toMatchObject({
      linesNotConfirmed: true,
      payload: { code: 'NOT_UNLOCKED_YET', human_action: lines.SELLER_NOT_AGREED_WORDS },
    });
    expect(world.offers[0].state).toBe('proposed');
    expect([a.state, b.state]).toEqual(['confirmed', 'declined']);
    // Saved means committed: the transaction that refused did not roll back.
    expect(world.log.filter((s) => /^ROLLBACK/.test(s))).toHaveLength(0);
    expect(world.log.filter((s) => /^COMMIT/.test(s))).toHaveLength(1);
    // No press was written down as an accept.
    expect(events().some((e) => e.event === 'offer-accepted-by-human')).toBe(false);
    // And the buyer's assistant learns which on its next sweep.
    const seen = (await lines.linesForAgent(ANA, matchRow(MATCH)))!;
    expect(seen.confirmations.map((l) => l.state)).toEqual(['confirmed', 'declined']);
    expect(seen.note.text).toBe(lines.LINES_NOTE_BUYER_DECLINED);
  });

  it('a line answered no earlier still stands in the way, until it is ticked', async () => {
    const a = seed('Comes with both keys', 'declined');
    await expect(
      offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter', undefined, { lines: press([a], []) }),
    ).rejects.toMatchObject({ linesNotConfirmed: true });
    // No second "declined" is written for a line that already was.
    expect(events()).toHaveLength(0);
    // The seller may change a no to a yes.
    await offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter', undefined, { lines: press([a], [a]) });
    expect(a.state).toBe('confirmed');
    expect(world.offers[0].state).toBe('accepted-by-human');
  });

  it('a line the page never showed is not taken as answered, and still holds it up', async () => {
    const a = seed('Comes with both keys');
    const late = seed('Has never been crashed'); // asked after the page was drawn
    await expect(
      offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter', undefined, { lines: press([a], [a]) }),
    ).rejects.toMatchObject({ linesNotConfirmed: true });
    expect(a.state).toBe('confirmed');
    expect(late.state).toBe('asked');
  });

  it('a press with no boxes on it cannot accept over an unanswered line', async () => {
    seed('Comes with both keys');
    await expect(offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter')).rejects.toMatchObject({
      linesNotConfirmed: true,
    });
    expect(world.offers[0].state).toBe('proposed');
  });

  it('the buyer is refused while a line is unanswered or answered no, and told what to do', async () => {
    for (const state of ['asked', 'declined']) {
      world.lines = [];
      seed('Comes with both keys', state);
      const said = await refusal(offers.acceptOfferByHuman(BEPPES_OFFER, ANA, 'counter'));
      expect(said, state).toBe(lines.BUYER_BLOCKED_WORDS);
      expect(said).toMatch(/tell your assistant to take it off/);
      expect(world.offers[1].state).toBe('proposed');
    }
  });

  it('and is let through once the line is taken off', async () => {
    const l = seed('Comes with both keys', 'declined');
    await expect(offers.acceptOfferByHuman(BEPPES_OFFER, ANA, 'counter')).rejects.toBeTruthy();
    await lines.withdrawLine(ANA, MATCH, l.id);
    const o: any = await offers.acceptOfferByHuman(BEPPES_OFFER, ANA, 'counter');
    expect(o.state).toBe('accepted-by-human');
  });

  it('a buyer’s press never answers a line, whatever its form says', async () => {
    const l = seed('Comes with both keys');
    await expect(
      offers.acceptOfferByHuman(BEPPES_OFFER, ANA, 'counter', undefined, { lines: press([l], [l]) }),
    ).rejects.toMatchObject({ linesNotConfirmed: true });
    expect(l.state).toBe('asked');
    expect(await lines.answerLinesByHuman(MATCH, ANA, 'counter', press([l], [l], 'lines-confirm'))).toEqual({
      confirmed: [],
      declined: [],
    });
    expect(l.state).toBe('asked');
    expect(events()).toHaveLength(0);
  });

  it('sending a figure is never held up by a line, from either side', async () => {
    seed('Comes with both keys');
    seed('Brakes were serviced this year', 'declined');
    const expiry = new Date(Date.now() + 86_400_000).toISOString();
    for (const who of [ANA, BEPPE]) {
      const placed: any = await offers.proposeOffer(
        cfg,
        who,
        { match_id: MATCH, amount: who === ANA ? 420 : 440, ccy: 'AUD', expiry },
        { author: 'human' },
      );
      expect(placed.state, who).toBe('proposed');
    }
  });

  it('checks and accepts inside one lock, with the lines read after it is held', async () => {
    const a = seed('Comes with both keys');
    world.log = [];
    await offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter', undefined, { lines: press([a], [a]) });
    const at = (re: RegExp) => world.log.findIndex((s) => re.test(s));
    const begin = at(/^BEGIN/);
    const lock = at(/pg_advisory_xact_lock/);
    const answered = at(/UPDATE confirm_lines SET state = \$2/);
    const read = world.log.findIndex((s, i) => i > answered && /FROM confirm_lines WHERE match_id = \$1 AND state <> 'withdrawn'/.test(s));
    const accepted = at(/UPDATE offers SET state='accepted-by-human'/);
    const commit = at(/^COMMIT/);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect([begin, lock, answered, read, accepted, commit]).toEqual(
      [begin, lock, answered, read, accepted, commit].slice().sort((x, y) => x - y),
    );
    // Asking takes the same lock, so it cannot land between the two.
    world.log = [];
    world.offers[0].state = 'proposed';
    await lines.askLine(cfg, ANA, MATCH, 'Has never been crashed');
    const asks = world.log.filter((s) => /pg_advisory_xact_lock/.test(s));
    expect(asks).toHaveLength(1);
  });

  it('settles two presses on one figure inside the lock', async () => {
    // The offer was open when the page was drawn and is gone by the press.
    const realPool = fakePool();
    let reads = 0;
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: realPool.query,
      connect: async () => ({
        release: () => {},
        query: async (sql: string, params: any[]) => {
          if (/SELECT \* FROM offers WHERE id/.test(sql) && ++reads === 1) {
            world.offers[0].state = 'withdrawn';
          }
          return realPool.query(sql, params);
        },
      }),
    } as any);
    await expect(offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter')).rejects.toBeInstanceOf(OsbError);
    expect(world.offers[0].state).toBe('withdrawn');
    expect(events()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('where no line was ever asked, nothing is different', () => {
  it('an accept goes through as it always did, either way round', async () => {
    const o: any = await offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter');
    expect(o.state).toBe('accepted-by-human');
    expect(events().map((e) => e.event)).toEqual(['offer-accepted-by-human']);
    world.offers[0].state = 'declined';
    const o2: any = await offers.acceptOfferByHuman(BEPPES_OFFER, ANA, 'counter');
    expect(o2.state).toBe('accepted-by-human');
  });

  it('the sweep entry, the offer list and the record carry nothing about lines', async () => {
    expect(await lines.linesForAgent(ANA, matchRow(MATCH))).toBeUndefined();
    const [entry]: any = await checkMatches(cfg, ANA);
    expect('confirmations' in entry).toBe(false);
    expect('confirmations_note' in entry).toBe(false);
    const r: any = await dispatchTool(cfg, ANA, 'respond', { intro_id: MATCH, action: 'list_offers' });
    expect(Object.keys(r.structuredContent)).toEqual(['offers']);
    const rec = await buildReceipt(matchRow(MATCH) as any, world.offers[0], new Date('2026-10-02T03:14:00Z'));
    expect(rec.block).not.toMatch(/confirmed by the seller/i);
    const same = await buildReceipt(matchRow(MATCH) as any, world.offers[0], new Date('2026-10-02T03:14:00Z'), {
      confirmed: [],
    });
    expect(same.sha256).toBe(rec.sha256);
  });

  it('a page with nothing to tick prints no boxes and no hidden field', () => {
    const html = pages.oneQuestionPage({
      token: 't',
      question: 'Accept $415 AUD for your Trek?',
      yesLabel: 'Accept',
      noLabel: 'Not now',
      needsPin: true,
      hasPin: true,
      hasPasskey: false,
      elevated: false,
      money: true,
    });
    expect(html).not.toContain('lines_shown');
    expect(html).not.toContain('type="checkbox"');
  });
});

// ---------------------------------------------------------------------------
describe('only the seller’s human answers a line, by their own press', () => {
  it('the page of its own: ticked is confirmed, unticked is declined, in one press', async () => {
    const a = seed('Comes with both keys');
    const b = seed('Brakes were serviced this year');
    const out = await lines.answerLinesByHuman(MATCH, BEPPE, 'counter', press([a, b], [b], 'lines-confirm'));
    expect(out).toEqual({ confirmed: [b.id], declined: [a.id] });
    expect([a.state, b.state]).toEqual(['declined', 'confirmed']);
    expect(b.answered_on).toBe('lines-confirm');
    // Nothing was accepted by it.
    expect(world.offers.every((o) => o.state === 'proposed')).toBe(true);
  });

  it('a confirmed line is never unconfirmed by a later press', async () => {
    const a = seed('Comes with both keys', 'confirmed');
    await lines.answerLinesByHuman(MATCH, BEPPE, 'counter', press([a], [], 'lines-confirm'));
    expect(a.state).toBe('confirmed');
  });

  it('refuses any recording that is not the human’s own page', async () => {
    const a = seed('Comes with both keys');
    for (const via of ['internal-ops', 'agent', 'agent-attested', '', undefined]) {
      await expect(
        lines.answerLinesByHuman(MATCH, BEPPE, via as any, press([a], [a], 'lines-confirm')),
      ).rejects.toThrow(/only recorded from the human's own press/);
      await expect(
        lines.applyLinePress(db.getPool(), matchRow(MATCH) as any, BEPPE, via as any, press([a], [a])),
      ).rejects.toThrow(/only recorded from the human's own press/);
    }
    expect(a.state).toBe('asked');
  });

  it('writes every answer to the locked log, without the words', async () => {
    const a = seed('Comes with both keys');
    const b = seed('Brakes were serviced this year');
    await lines.answerLinesByHuman(MATCH, BEPPE, 'counter', press([a, b], [a], 'lines-confirm'));
    expect(events()).toEqual([
      { event: 'line-confirmed-by-human', match_id: MATCH, line_id: a.id, account_id: BEPPE, recorded_via: 'counter' },
      { event: 'line-declined-by-human', match_id: MATCH, line_id: b.id, account_id: BEPPE, recorded_via: 'counter' },
    ]);
    const written = JSON.stringify(events());
    expect(written).not.toContain('both keys');
    expect(written).not.toContain('Brakes');
    // The log is written before the row changes.
    const firstUpdate = world.log.findIndex((s) => /UPDATE confirm_lines SET state = \$2/.test(s));
    expect(firstUpdate).toBeGreaterThan(-1);
  });

  it('gives an assistant no tool that confirms one', async () => {
    const a = seed('Comes with both keys');
    const actions: string[] = (TOOLS.find((t) => t.name === 'respond')!.inputSchema as any).properties.action.enum;
    // The three there are: ask, take off, and fetch the human's page.
    expect(actions.filter((x) => /confirm/.test(x)).sort()).toEqual([
      'ask_confirmation',
      'request_confirm',
      'withdraw_confirmation',
    ]);
    expect(TOOLS.map((t) => t.name).filter((n) => /confirm|line/.test(n))).toEqual([]);
    for (const action of ['confirm', 'confirm_line', 'confirm_confirmation', 'answer_confirmation', 'accept_confirmation']) {
      for (const who of [BEPPE, ANA]) {
        const r: any = await dispatchTool(cfg, who, 'respond', {
          intro_id: MATCH,
          action,
          confirmation_id: a.id,
        });
        expect(r.isError, action).toBe(true);
      }
    }
    // Fetching the page answers nothing either: it mints a link and returns.
    const link: any = await dispatchTool(cfg, BEPPE, 'respond', { intro_id: MATCH, action: 'request_confirm' });
    expect(link.isError).toBeFalsy();
    expect(link.structuredContent.say).toMatch(/^Here is your page — it asks you to confirm in writing what the buyer has asked about/);
    expect(link.structuredContent.say.endsWith(link.structuredContent.link)).toBe(true);
    expect(link.structuredContent.what_it_does).toMatch(/You cannot tick or confirm any of it for them/);
    expect(a.state).toBe('asked');
    expect(events()).toHaveLength(0);
  });

  it('is reachable from the counter and the accept path and nowhere else', () => {
    const src = join(__dirname, '..', '..', 'src');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
      );
    const callers = walk(src)
      .filter((f) => /answerLinesByHuman|applyLinePress/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(src.length + 1))
      .sort();
    expect(callers).toEqual(['counter/routes.ts', 'domain/confirmLines.ts', 'domain/offers.ts']);
    // The internal ops queue and the tool surface know nothing of it.
    expect(readFileSync(join(src, 'workers', 'opsWorker.ts'), 'utf8')).not.toMatch(/confirm_lines|confirmLines/);
    expect(readFileSync(join(src, 'mcp', 'tools.ts'), 'utf8')).not.toMatch(/answerLinesByHuman|applyLinePress/);
  });

  it('the database holds the same rule', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'migrations', '066_confirm_lines.sql'), 'utf8');
    expect(sql).toMatch(/confirm_lines_answer_is_a_press CHECK \(\s*state NOT IN \('confirmed', 'declined'\)\s*OR \(answered_at IS NOT NULL AND answered_by IS NOT NULL AND answered_via = 'counter'\)/);
    expect(sql).toMatch(/ALTER TABLE offers ADD COLUMN IF NOT EXISTS receipt_sha256 text/);
  });

  it('takes a fresh PIN or passkey on the page of its own, as a money press does', () => {
    expect(FRESH_CEREMONY_ACTIONS.has(LINES_CONFIRM_ACTION)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the record lists what the seller confirmed', () => {
  const at = new Date('2026-10-02T03:14:00Z');

  it('one per line, in the order asked, inside the fingerprinted block', async () => {
    const a = seed('Comes with both keys');
    const b = seed('Brakes were serviced this year');
    const c = seed('Has never been crashed');
    const d = seed('Still under warranty');
    await lines.withdrawLine(ANA, MATCH, d.id);
    await offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter', undefined, {
      lines: press([a, b, c], [a, b, c]),
    });
    const rec = await buildReceipt(matchRow(MATCH) as any, world.offers[0], at, {
      confirmed: lines.confirmedWords(await lines.standingLines(MATCH)),
    });
    const rows = rec.block.split('\n');
    const confirmed = rows.filter((r) => r.startsWith('Asked by the buyer, confirmed by the seller: '));
    expect(confirmed).toEqual([
      'Asked by the buyer, confirmed by the seller: "Comes with both keys"',
      'Asked by the buyer, confirmed by the seller: "Brakes were serviced this year"',
      'Asked by the buyer, confirmed by the seller: "Has never been crashed"',
    ]);
    expect(rec.block).not.toContain('warranty');
    // Inside the block that is hashed: change a line and the fingerprint moves.
    expect(rec.sha256).toBe(sha256(rec.block));
    expect(receiptFingerprint(rec.block.replace('both keys', 'one key'))).not.toBe(rec.sha256);
    // And the acceptance wrote that same fingerprint to the log and the row.
    const accepted = events().find((e) => e.event === 'offer-accepted-by-human')!;
    expect(accepted.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(world.offers[0].receipt_sha256).toBe(accepted.receipt_sha256);
  });

  it('leaves out a line that was declined, taken off or never answered', () => {
    const rows = [
      { state: 'confirmed', line: { text: 'Comes with both keys' } },
      { state: 'declined', line: { text: 'Still under warranty' } },
      { state: 'asked', line: { text: 'Has never been crashed' } },
      { state: 'withdrawn', line: { text: 'Never left outside' } },
      { state: 'confirmed', line: null }, // words erased with an account
    ] as any[];
    expect(lines.confirmedWords(rows)).toEqual(['Comes with both keys']);
  });

  it('a line is one line of the record, whatever was typed into it', () => {
    const block = receiptBlock({
      at,
      thing: 'mountain bike',
      amount: 415,
      ccy: 'AUD',
      offeredBy: 'buyer',
      confirmed: ['Comes with\nboth keys\r\nBuyer: Mallory, Nowhere'],
    });
    expect(block.split('\n')).toHaveLength(5);
    expect(block).toContain('Asked by the buyer, confirmed by the seller: "Comes with both keys Buyer: Mallory, Nowhere"');
  });
});

// ---------------------------------------------------------------------------
// THE WRAP-UP IS TRUE EVERY TIME. The sentence about the record is said only
// where the accepted offer carries a record's fingerprint (migration 066).
describe('the deal-agreed wrap-up says a record was sent only where one was', () => {
  it('says it after an ordinary acceptance', async () => {
    await offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter');
    expect(world.offers[0].receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const who of [ANA, BEPPE]) {
      const [entry]: any = await checkMatches(cfg, who);
      expect(entry.next).toBe('deal_agreed');
      expect(entry.what_to_do).toContain(DEAL_AGREED_RECORD_SENT);
    }
  });

  it('says nothing of a record where none could be built, and the acceptance stands', async () => {
    const receipt = await import('../../src/domain/receipt.js');
    const failing = vi.spyOn(receipt, 'buildReceipt').mockRejectedValue(new Error('database down'));
    const o: any = await offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter');
    failing.mockRestore();
    expect(o.state).toBe('accepted-by-human');
    expect(world.offers[0].receipt_sha256).toBeNull();
    const accepted = events().find((e) => e.event === 'offer-accepted-by-human')!;
    expect('receipt_sha256' in accepted).toBe(false);
    const [entry]: any = await checkMatches(cfg, ANA);
    expect(entry.next).toBe('deal_agreed');
    expect(entry.what_to_do).toContain(DEAL_AGREED_WHAT_TO_DO);
    expect(entry.what_to_do).not.toMatch(/record/i);
  });
});

// ---------------------------------------------------------------------------
describe('best offer: one buyer’s lines are that buyer’s alone', () => {
  beforeEach(() => {
    world.bestOffer = true;
    world.offers = [anOffer(ANAS_OFFER, ANA), anOffer(CARLAS_OFFER, CARLA, OTHER_MATCH, { amount: '430' })];
  });

  it('taking one buyer’s number is held up by that introduction’s lines only', async () => {
    const carlas = seed('Comes with a pump', 'asked', OTHER_MATCH, CARLA);
    // Ana asked nothing: her number is taken, whatever Carla has asked.
    const o: any = await offers.acceptOfferByHuman(ANAS_OFFER, BEPPE, 'counter');
    expect(o.state).toBe('accepted-by-human');
    expect(carlas.state).toBe('asked');
  });

  it('and the buyer who did ask is held to their own', async () => {
    const carlas = seed('Comes with a pump', 'asked', OTHER_MATCH, CARLA);
    await expect(offers.acceptOfferByHuman(CARLAS_OFFER, BEPPE, 'counter')).rejects.toMatchObject({
      linesNotConfirmed: true,
    });
    await offers.acceptOfferByHuman(CARLAS_OFFER, BEPPE, 'counter', undefined, { lines: press([carlas], [carlas]) });
    expect(world.offers[1].state).toBe('accepted-by-human');
    // A press on one introduction cannot answer a line on another.
    const anas = seed('Comes with both keys');
    await lines.answerLinesByHuman(OTHER_MATCH, BEPPE, 'counter', press([anas], [anas], 'lines-confirm'));
    expect(anas.state).toBe('asked');
  });

  it('neither buyer’s assistant sees the other’s lines', async () => {
    seed('Comes with a pump', 'asked', OTHER_MATCH, CARLA);
    seed('Comes with both keys');
    const anas = (await lines.linesForAgent(ANA, matchRow(MATCH)))!;
    expect(anas.confirmations.map((l) => l.line?.text)).toEqual(['Comes with both keys']);
    const carlas = (await lines.linesForAgent(CARLA, matchRow(OTHER_MATCH)))!;
    expect(carlas.confirmations.map((l) => l.line?.text)).toEqual(['Comes with a pump']);
  });
});

// ---------------------------------------------------------------------------
describe('what each assistant sees, wherever it sees the offers', () => {
  it('the words wear the other side’s label, exactly as an offer note does', async () => {
    seed('Comes with both keys');
    for (const who of [ANA, BEPPE]) {
      const seen = (await lines.linesForAgent(who, matchRow(MATCH)))!;
      expect(seen.confirmations[0].line).toEqual({
        text: 'Comes with both keys',
        provenance: 'counterparty-untrusted',
      });
      expect(seen.note.provenance).toBe('switchboard-system');
      // The switchboard's own sentence never quotes them.
      expect(seen.note.text).not.toContain('both keys');
    }
  });

  it('tells the seller’s assistant its human answers on their own page, and it cannot', async () => {
    seed('Comes with both keys');
    const seen = (await lines.linesForAgent(BEPPE, matchRow(MATCH)))!;
    expect(seen.note.text).toBe(lines.LINES_NOTE_SELLER_WAITING);
    expect(seen.note.text).toMatch(/on your human’s own page/);
    expect(seen.note.text).toMatch(/You cannot confirm any of them yourself/);
    expect(seen.note.text).toMatch(/in a sentence/);
    expect(seen.lead).toBe(lines.LINES_LEAD_SELLER);
  });

  it('tells the buyer’s assistant which were confirmed and which were not', async () => {
    const a = seed('Comes with both keys');
    expect(lines.linesNoteFor('want', [a]).text).toBe(lines.LINES_NOTE_BUYER_WAITING);
    a.state = 'confirmed';
    expect(lines.linesNoteFor('want', [a]).text).toBe(lines.LINES_NOTE_BUYER_CONFIRMED);
    const b = seed('Still under warranty', 'declined');
    const said = lines.linesNoteFor('want', [a, b]);
    expect(said.text).toBe(lines.LINES_NOTE_BUYER_DECLINED);
    expect(said.text).toMatch(/ask whether they want to go ahead without it/);
    expect(said.text).toMatch(/Only on their yes/);
    expect(said.text).toMatch(/only confirmed lines go on the record/);
    expect(said.lead).toBe(lines.LINES_LEAD_BUYER);
    expect(lines.linesNoteFor('have', [a, b]).text).toBe(lines.LINES_NOTE_SELLER_ANSWERED);
  });

  it('rides the sweep beside the figures, and on the lead sentence where it needs this human', async () => {
    seed('Comes with both keys');
    const [sellers]: any = await checkMatches(cfg, BEPPE);
    expect(sellers.confirmations).toHaveLength(1);
    expect(sellers.confirmations_note.text).toBe(lines.LINES_NOTE_SELLER_WAITING);
    expect(sellers.note.text.endsWith(lines.LINES_LEAD_SELLER)).toBe(true);
    const [buyers]: any = await checkMatches(cfg, ANA);
    expect(buyers.confirmations[0].state).toBe('asked');
    expect(buyers.note.text).not.toContain(lines.LINES_LEAD_SELLER);
    // An entry with a line still to deal with is never carried in the compact form.
    expect(
      compactCandidate({
        state: 'open',
        taken_down: 'theirs',
        next: 'ready_to_talk',
        conversation: { messages_waiting: 0 },
        confirmations: [{ state: 'asked' }],
      }),
    ).toBe(false);
  });

  it('rides list_offers too', async () => {
    seed('Comes with both keys', 'confirmed');
    const r: any = await dispatchTool(cfg, ANA, 'respond', { intro_id: MATCH, action: 'list_offers' });
    expect(r.structuredContent.confirmations).toHaveLength(1);
    expect(r.structuredContent.confirmations_note.text).toBe(lines.LINES_NOTE_BUYER_CONFIRMED);
  });
});

// ---------------------------------------------------------------------------
describe('the respond actions', () => {
  it('ask_confirmation asks, and answers with the sentence to say', async () => {
    const r: any = await dispatchTool(cfg, ANA, 'respond', {
      intro_id: MATCH,
      action: 'ask_confirmation',
      line: 'Comes with both keys',
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      intro_id: MATCH,
      state: 'asked',
      line: { text: 'Comes with both keys', provenance: 'counterparty-untrusted' },
      note: { text: lines.LINE_ASKED_SENTENCE, provenance: 'switchboard-system' },
    });
    expect(world.lines).toHaveLength(1);
  });

  it('withdraw_confirmation takes it off', async () => {
    const l = seed('Comes with both keys', 'declined');
    const r: any = await dispatchTool(cfg, ANA, 'respond', {
      intro_id: MATCH,
      action: 'withdraw_confirmation',
      confirmation_id: l.id,
    });
    expect(r.structuredContent).toMatchObject({ state: 'withdrawn', note: { text: lines.LINE_WITHDRAWN_SENTENCE } });
    expect(l.state).toBe('withdrawn');
  });

  it('refuses the selling side on both, in plain words, as an answer rather than a failure', async () => {
    const l = seed('Comes with both keys');
    for (const args of [
      { action: 'ask_confirmation', line: 'Comes with a pump' },
      { action: 'withdraw_confirmation', confirmation_id: l.id },
    ]) {
      const r: any = await dispatchTool(cfg, BEPPE, 'respond', { intro_id: MATCH, ...args });
      expect(JSON.stringify(r.structuredContent), args.action).toContain(lines.LINES_BUYING_SIDE_ONLY);
    }
    expect(world.lines).toHaveLength(1);
    expect(l.state).toBe('asked');
  });

  it('refuses the buying side the seller’s page, and the seller where nothing waits', async () => {
    seed('Comes with both keys');
    const buyer: any = await dispatchTool(cfg, ANA, 'respond', { intro_id: MATCH, action: 'request_confirm' });
    expect(JSON.stringify(buyer.structuredContent)).toMatch(/Confirming in writing is for the selling side/);
    world.lines[0].state = 'confirmed';
    const seller: any = await dispatchTool(cfg, BEPPE, 'respond', { intro_id: MATCH, action: 'request_confirm' });
    expect(JSON.stringify(seller.structuredContent)).toContain(lines.CONFIRM_NOTHING_WAITING);
  });

  it('says what is missing, and checks the id before any query', async () => {
    const noLine: any = await dispatchTool(cfg, ANA, 'respond', { intro_id: MATCH, action: 'ask_confirmation' });
    expect(noLine.isError).toBe(true);
    expect(noLine.content[0].text).toMatch(/requires `line`/);
    const noId: any = await dispatchTool(cfg, ANA, 'respond', { intro_id: MATCH, action: 'withdraw_confirmation' });
    expect(noId.content[0].text).toMatch(/requires confirmation_id/);
    expect(argumentComplaint('respond', { action: 'withdraw_confirmation', intro_id: MATCH, confirmation_id: 'x' })).toMatch(
      /confirmation_id is not an id/,
    );
    expect(
      argumentComplaint('respond', { action: 'ask_confirmation', intro_id: MATCH, line: 'x'.repeat(201) }),
    ).toBeTruthy();
  });

  it('are on the tool an agent reads, on every deployment, with the rules', () => {
    for (const tools of [TOOLS, toolsFor({ sealedContact: false })]) {
      const respond = tools.find((t) => t.name === 'respond')!;
      const d = respond.description;
      expect(d).toMatch(/ask_confirmation \(BUYING side: `line` is one thing your human is relying on, in their words, for the seller's human to confirm in writing; only confirmed lines go on the record\)/);
      expect(d).toMatch(/withdraw_confirmation \(takes one off, ONLY on your human's word\)/);
      expect(d).toMatch(/request_confirm \(SELLING side: their page to tick what the buyer asked them to confirm in writing; you cannot confirm it yourself\)/);
      expect(lintHumanCopy(d)).toEqual([]);
      const props = (respond.inputSchema as any).properties;
      expect(props.action.enum).toEqual(expect.arrayContaining(['ask_confirmation', 'withdraw_confirmation', 'request_confirm']));
      expect(props.line.description).toMatch(/never add a line they did not give you/);
      expect(props.line.description).toMatch(/without asking them about each one/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the manual says the general rules', () => {
  it('at version 85, in a section of its own', () => {
    expect(MANUAL.version).toBe(85);
    const note = MANUAL_CHANGELOG.find((c) => c.version === 85)!.note;
    const text = manualSection('in_writing')!.text;
    for (const t of [note, text]) {
      expect(t).toMatch(/relying on something the other side has said/);
      expect(t).toMatch(/respond\(ask_confirmation\)/);
      expect(t).toMatch(/no assistant can/);
      expect(lintEmailCopy(t)).toEqual([]);
      // General rules only: no thing is named, and no figure.
      expect(t).not.toMatch(/\d/);
      expect(t).not.toMatch(/wire|bike|car|phone/i);
    }
    expect(text).toMatch(/never a line they did not give you/);
    expect(text).toMatch(/there is no need to go back to them about each one/);
    expect(text).toMatch(/tell your human in a sentence that the buyer has asked for some things to be confirmed/);
    expect(text).toMatch(/tell your human which, and ask whether they want to go ahead without it/);
    expect(text).toMatch(/only on their yes/);
    expect(lintHumanCopy(text)).toEqual([]);
  });

  it('never rewords an entry that has shipped', () => {
    expect(MANUAL_CHANGELOG.find((c) => c.version === 84)!.note).toBe(
      'When an offer is accepted, the same record of what was agreed is sent by email to both people, however they hear about things. Tell your human to keep it, and never tell a human to expect no email about a deal.',
    );
  });
});

// ---------------------------------------------------------------------------
describe('every sentence here keeps the house register', () => {
  const AGENT = [
    lines.LINES_BUYING_SIDE_ONLY,
    lines.LINES_NO_DEAL_HERE,
    lines.LINES_NOT_OPEN,
    lines.LINES_AFTER_ACCEPT,
    lines.LINES_FULL,
    lines.LINE_HAS_FIGURE,
    lines.LINE_ASKED_SENTENCE,
    lines.LINE_WITHDRAWN_SENTENCE,
    lines.LINE_ALREADY_WITHDRAWN_SENTENCE,
    lines.LINES_NOTE_SELLER_WAITING,
    lines.LINES_NOTE_SELLER_ANSWERED,
    lines.LINES_NOTE_BUYER_DECLINED,
    lines.LINES_NOTE_BUYER_WAITING,
    lines.LINES_NOTE_BUYER_CONFIRMED,
    lines.LINES_LEAD_SELLER,
    lines.LINES_LEAD_BUYER,
    lines.PRESS_NOT_AGREED_SENTENCE,
  ];
  const HUMAN = [
    lines.BUYER_BLOCKED_WORDS,
    lines.SELLER_NOT_AGREED_TITLE,
    lines.SELLER_NOT_AGREED_WORDS,
    lines.SELLER_LINES_HEADING,
    lines.SELLER_LINES_ON_ACCEPT,
    lines.SELLER_LINES_ON_SEND,
    lines.SELLER_LINE_LABEL,
    lines.SELLER_LINE_DONE_LABEL,
    lines.BUYER_LINES_HEADING,
    lines.BUYER_LINES_INTRO,
    lines.BUYER_LINE_LABEL,
    lines.CONFIRM_PAGE_YES,
    lines.CONFIRM_DONE_TITLE,
    lines.CONFIRM_DONE_WORDS,
    lines.CONFIRM_NOTHING_WAITING,
    lines.SEND_DONE_LINES_SAVED,
    CONFIRM_WAITING_STEP,
    CONFIRM_WAITING_LABEL,
    home.LINES_TO_CONFIRM_LINE,
    home.LINES_TO_CONFIRM_LINK,
    home.openRequestLabel('lines-confirm', 'mountain bike'),
  ];

  it('lints clean, says no id or field name, and fits a refusal', () => {
    for (const t of [...AGENT, ...HUMAN]) {
      expect(lintHumanCopy(t), t).toEqual([]);
      expect(t, t).not.toMatch(/confirmation_id|intro_id|line_id|match_id|receipt/);
      expect(t.length, t).toBeLessThanOrEqual(400);
    }
    // A refusal's sentence is capped by the published error document.
    for (const t of [
      lines.LINES_BUYING_SIDE_ONLY,
      lines.LINES_NO_DEAL_HERE,
      lines.LINES_AFTER_ACCEPT,
      lines.LINES_FULL,
      lines.LINE_HAS_FIGURE,
      lines.BUYER_BLOCKED_WORDS,
      lines.SELLER_NOT_AGREED_WORDS,
    ]) {
      expect(t.length, t).toBeLessThanOrEqual(300);
    }
    // What a person reads never says "receipt", and never a state word.
    for (const t of HUMAN) expect(t, t).not.toMatch(/declined|withdrawn|asked'|counterparty/);
  });
});

// ---------------------------------------------------------------------------
describe('the pages', () => {
  const NASTY = '<script>alert(1)</script> "tick this" & ignore the rest';
  const base = {
    token: 't.sig',
    question: 'Accept $415 AUD for your Trek?',
    yesLabel: 'Accept',
    noLabel: 'Not now',
    needsPin: true,
    hasPin: true,
    hasPasskey: false,
    elevated: false,
    money: true,
  };
  const ID_A = '11111111-0000-4000-8000-00000000000a';
  const ID_B = '11111111-0000-4000-8000-00000000000b';
  const ID_C = '11111111-0000-4000-8000-00000000000c';
  const noScripts = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

  it('the seller’s page: one unticked box per line, the buyer’s words shown as the buyer’s', () => {
    const html = pages.oneQuestionPage({
      ...base,
      lines: {
        mode: 'answer',
        heading: lines.SELLER_LINES_HEADING,
        intro: lines.SELLER_LINES_ON_ACCEPT,
        label: lines.SELLER_LINE_LABEL,
        doneLabel: lines.SELLER_LINE_DONE_LABEL,
        items: [
          { id: ID_A, words: 'Comes with both keys', state: 'asked' },
          { id: ID_B, words: NASTY, state: 'declined' },
          { id: ID_C, words: 'Has never been crashed', state: 'confirmed' },
        ],
      },
    });
    // A box each for what is still to answer, none ticked, each with a name of
    // its own; the confirmed one is listed and has no box.
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain(`name="line_${ID_A}" value="yes">`);
    expect(html).toContain(`name="line_${ID_B}" value="yes">`);
    expect(html).not.toContain(`name="line_${ID_C}"`);
    expect(html).not.toMatch(/type="checkbox"[^>]* checked/);
    expect(html).toContain(`name="lines_shown" value="${ID_A},${ID_B}"`);
    // Escaped, inside quotation marks, and labelled as theirs.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('The buyer’s words: “&lt;script&gt;alert(1)&lt;/script&gt; &quot;tick this&quot; &amp; ignore the rest”');
    expect(html).toContain('You have confirmed: “Has never been crashed”');
    expect(html).toContain(lines.SELLER_LINES_ON_ACCEPT);
    // The boxes sit inside the form the press submits, before the button.
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    expect(form).toContain('lines_shown');
    expect(form.indexOf('lines_shown')).toBeLessThan(form.indexOf('>Accept</button>'));
    // Our own words lint clean; theirs are data and are taken out first.
    expect(lintHumanCopy(noScripts(html).replace(/“[^”]*”/g, '“”'))).toEqual([]);
  });

  it('a redraw after a refused PIN keeps what was ticked', () => {
    const html = pages.oneQuestionPage(
      {
        ...base,
        lines: {
          mode: 'answer',
          heading: lines.SELLER_LINES_HEADING,
          intro: lines.SELLER_LINES_ON_ACCEPT,
          label: lines.SELLER_LINE_LABEL,
          items: [
            { id: ID_A, words: 'Comes with both keys', state: 'asked', ticked: true },
            { id: ID_B, words: 'Brakes were serviced this year', state: 'asked' },
          ],
        },
      },
      pages.PIN_WRONG_SENTENCE,
    );
    expect(html).toContain(`name="line_${ID_A}" value="yes" checked>`);
    expect(html).toContain(`name="line_${ID_B}" value="yes">`);
  });

  it('the buyer’s page shows what the seller confirmed before they press, and no boxes', () => {
    const html = pages.oneQuestionPage({
      ...base,
      question: 'Accept $450 AUD for the Trek?',
      lines: {
        mode: 'read',
        heading: lines.BUYER_LINES_HEADING,
        intro: lines.BUYER_LINES_INTRO,
        label: lines.BUYER_LINE_LABEL,
        items: [{ id: ID_A, words: NASTY, state: 'confirmed' }],
      },
    });
    expect(html).toContain(lines.BUYER_LINES_HEADING);
    expect(html).toContain('Your words: “&lt;script&gt;');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('lines_shown');
    expect(html.indexOf(lines.BUYER_LINES_HEADING)).toBeLessThan(html.indexOf('>Accept</button>'));
    expect(lintHumanCopy(noScripts(html).replace(/“[^”]*”/g, '“”'))).toEqual([]);
  });

  it('the page of its own takes the PIN every time and says so', () => {
    const html = pages.oneQuestionPage({
      ...base,
      money: false,
      fresh: true,
      elevated: true, // a window is open, and it does not count
      question: 'Confirm what the buyer asked about your Trek?',
      yesLabel: lines.CONFIRM_PAGE_YES,
      lines: {
        mode: 'answer',
        heading: lines.SELLER_LINES_HEADING,
        intro: lines.SELLER_LINES_ALONE,
        label: lines.SELLER_LINE_LABEL,
        items: [{ id: ID_A, words: 'Comes with both keys', state: 'asked' }],
      },
    });
    expect(html).toContain('class="pinbox"');
    expect(html).toContain('This takes your PIN every time.');
    expect(html).toContain(`>${lines.CONFIRM_PAGE_YES}</button>`);
  });

  it('reads the boxes back out of a posted form, one value per name', () => {
    const body = {
      lines_shown: `${ID_A},${ID_B},not-an-id`,
      [`line_${ID_A}`]: 'yes',
      [`line_${ID_C}`]: 'yes', // never shown: not this page's to tick
      decision: 'yes',
    };
    expect(lines.readLinePress(body, 'offer-accept')).toEqual({
      shown: [ID_A, ID_B],
      ticked: [ID_A],
      on: 'offer-accept',
    });
    expect(lines.readLinePress({ decision: 'yes' }, 'offer-accept')).toBeUndefined();
  });

  it('the main page says something is waiting, with the way to it', () => {
    const { byMatch } = groupWaitingByMatch({
      openLinks: [],
      offers: [],
      disclosures: [],
      settlements: [],
      messages: [],
      confirmations: [{ match_id: MATCH }],
    });
    const g = byMatch.get(MATCH)!;
    expect(g.steps.map((s) => s.text)).toEqual([CONFIRM_WAITING_STEP]);
    expect(g.actions).toEqual([{ href: `/approvals/confirm/${MATCH}`, label: CONFIRM_WAITING_LABEL }]);
  });
});

// ---------------------------------------------------------------------------
describe('when an account is deleted', () => {
  it('does to the lines what it does to offers', () => {
    // Unanswered ones this account asked are taken off; its words are erased
    // except on an introduction under a hold; the rows are kept.
    expect(lines.ACCOUNT_DELETION_WITHDRAW_SQL).toMatch(/SET state = 'withdrawn'/);
    expect(lines.ACCOUNT_DELETION_WITHDRAW_SQL).toMatch(/WHERE asked_by = \$1 AND state = 'asked'/);
    expect(lines.ACCOUNT_DELETION_ERASE_SQL).toMatch(/SET line = NULL/);
    expect(lines.ACCOUNT_DELETION_ERASE_SQL).toMatch(/NOT \(match_id = ANY\(\$2::uuid\[\]\)\)/);
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'domain', 'accountDeletion.ts'), 'utf8');
    expect(src).toContain('await q(LINES_WITHDRAW_SQL);');
    expect(src).toContain('await q(LINES_ERASE_SQL, [accountId, heldMatches]);');
    expect(src).not.toMatch(/DELETE FROM confirm_lines/);
  });
});
