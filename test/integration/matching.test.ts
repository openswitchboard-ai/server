/**
 * 0.F matching-engine gates against a LIVE deployment (default dev). Run:
 *   AWS_PROFILE=openswitchboard npm run test:integration
 *
 * Seeds a fixture city (30 accounts, mixed WANT/HAVE across categories, geo
 * buckets and price bands) through the real product path (OAuth + MCP publish
 * + screening + Titan embedding + matcher worker), then evidences:
 *  (a)  correct-match matrix: designed pairs match (score >= threshold,
 *       stage-1 signals both sides); designed non-matches (wrong geo / band
 *       gap / wrong category) do not; urgency=today routing honoured;
 *  (b)  no-leak: raw stage-1/2 payloads deep-scanned for
 *       price|band|budget|reserve -> [];
 *  (c)  k-floor: a seeded 9-member pulse cell is ABSENT, a 10-member cell is
 *       present with the exact real count;
 *  (d)  collection window under concurrency: parallel offers from 3 buyers,
 *       holder sees all, non-holders see no rival signal, early-close
 *       honoured, post-window proceed works;
 *  (e)  anti-probing: 4th per-match offer in 24h -> RATE_LIMITED_OFFERS;
 *       ladder pattern flags the reputation stub; declines reasonless.
 * Plus: embedding-on-write (1024 dims), backfill op, match-quality verdicts.
 *
 * Each island of the fixture city gets a RUN-UNIQUE geo bucket, so re-runs
 * and other suites' leftovers in the shared dev DB cannot pollute assertions.
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_TTL_DAYS,
  SCHEMA_VERSION,
  TestActor,
  bootstrapActor,
  dbExec,
  mcpCall,
  poll,
  sendOp,
  setAutoNegotiate,
  waitForCardState,
  waitForCardStates,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

const runTag = randomBytes(3).toString('hex'); // 6 chars
// '_' keeps these out of the geohash namespace -> deterministic opaque-bucket
// geo semantics (equality/prefix), immune to leftovers from other runs.
const MATRIX_B = `mx_${runTag}`;
const FAR_B = `fa_${runTag}`;
const CLUSTER_B = `cl_${runTag}`;
const K9_B = `k9_${runTag}`;
const K10_B = `ka_${runTag}`;
const URG_B = `ur_${runTag}`;
const FILL_B = `fl_${runTag}`;

const card = (
  type: 'WANT' | 'HAVE',
  category: string,
  bucket: string,
  extra: Record<string, unknown> = {},
) => ({
  schema_version: SCHEMA_VERSION,
  type,
  category,
  geo: { bucket, radius_km: 25 },
  ttl_days: FIXTURE_TTL_DAYS,
  ...extra,
});

async function publish(actor: TestActor, c: any): Promise<string> {
  const r = await mcpCall(actor.accessToken, 'publish_intent', { listing: c });
  expect(r.isError, JSON.stringify(r.result)).toBe(false);
  return r.result.intent_id as string;
}

async function matchBetween(cardA: string, cardB: string): Promise<any[]> {
  const rows = await dbExec(
    `SELECT id, score::float8, state FROM matches
     WHERE (card_want = :a::uuid AND card_have = :b::uuid)
        OR (card_want = :b::uuid AND card_have = :a::uuid)`,
    [
      { name: 'a', value: cardA },
      { name: 'b', value: cardB },
    ],
  );
  return rows;
}

/** Deep key scan for forbidden material in counterparty-visible payloads. */
const FORBIDDEN_KEY = /price|band|budget|reserve|reason/i;
function deepScanKeys(o: any, path = ''): string[] {
  if (!o || typeof o !== 'object') return [];
  return Object.entries(o).flatMap(([k, v]) => [
    ...(FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []),
    ...deepScanKeys(v, `${path}.${k}`),
  ]);
}

// Fixture city cast.
let alice: TestActor; // camera WANT - designed match
let bob: TestActor; //   camera HAVE - designed match
let carol: TestActor; // camera WANT, far bucket - geo non-match
let dan: TestActor; //   camera WANT, band gap - price non-match
let erin: TestActor; //  camera HAVE, high reserve - price non-match
let frank: TestActor; // sofa HAVE, same bucket - category non-match
let hank: TestActor; //  guitar HAVE - contested holder
let buyers: TestActor[] = []; // 3 guitar WANTs - rivals
let ivy: TestActor; //   phone HAVE - urgency counterparty
let jack: TestActor; //  phone WANT urgency=today
let kAccounts: TestActor[] = []; // pulse cells
let fillers: TestActor[] = []; // city background

let aliceWant = '';
let bobHave = '';
let carolWant = '';
let danWant = '';
let erinHave = '';
let frankHave = '';
let hankHave = '';
const buyerWants: string[] = [];
let ivyHave = '';
let jackWant = '';
let fillerCardIds: string[] = [];

let abMatchId = ''; // alice-bob
const hankMatchIds: Record<string, string> = {}; // buyer accountId -> match id

d('0.F matching engine gates against live deployment', { timeout: 420_000 }, () => {
  beforeAll(async () => {
    // ---- accounts (batched to be kind to the counter) -------------------
    const mk = (n: string) => bootstrapActor(n, 'Fixtureville');
    [alice, bob, carol, dan, erin, frank] = await Promise.all([
      mk('Alice'), mk('Bob'), mk('Carol'), mk('Dan'), mk('Erin'), mk('Frank'),
    ]);
    [hank, ...buyers] = await Promise.all([mk('Hank'), mk('Ben'), mk('Bella'), mk('Boris')]);
    [ivy, jack] = await Promise.all([mk('Ivy'), mk('Jack')]);
    kAccounts = await Promise.all([mk('Kay1'), mk('Kay2'), mk('Kay3'), mk('Kay4')]);
    fillers = [];
    for (let i = 0; i < 14; i += 7) {
      fillers.push(
        ...(await Promise.all(
          Array.from({ length: 7 }, (_, j) => mk(`Filler${i + j}`)),
        )),
      );
    }

    // ---- cards ----------------------------------------------------------
    const cam = 'goods.electronics.camera';
    const camAttrs = { condition: 'good', brand: 'canon', model: 'eos r10' };
    [aliceWant, bobHave, carolWant, danWant, erinHave, frankHave] = await Promise.all([
      publish(alice, card('WANT', cam, MATRIX_B, {
        attributes: camAttrs,
        price: { band: { min: 0, max: 750 }, ccy: 'AUD' },
      })),
      publish(bob, card('HAVE', cam, MATRIX_B, {
        attributes: { ...camAttrs, year: 2022 },
        price: { band: { min: 400, max: 400 }, ccy: 'AUD' },
        ask: { amount: 620, ccy: 'AUD' },
      })),
      publish(carol, card('WANT', cam, FAR_B, {
        attributes: camAttrs,
        price: { band: { min: 0, max: 750 }, ccy: 'AUD' },
      })),
      publish(dan, card('WANT', cam, MATRIX_B, {
        attributes: camAttrs,
        price: { band: { min: 0, max: 100 }, ccy: 'AUD' },
      })),
      publish(erin, card('HAVE', cam, MATRIX_B, {
        attributes: { ...camAttrs, year: 2023 },
        price: { band: { min: 5000, max: 5000 }, ccy: 'AUD' },
      })),
      publish(frank, card('HAVE', 'goods.furniture.sofa', MATRIX_B, {
        attributes: { condition: 'good', seats: 3 },
      })),
    ]);

    const gtr = 'goods.music.guitar';
    const gtrAttrs = { condition: 'good', brand: 'fender', model: 'stratocaster' };
    hankHave = await publish(hank, card('HAVE', gtr, CLUSTER_B, {
      attributes: { ...gtrAttrs, handedness: 'right' },
      price: { band: { min: 300, max: 300 }, ccy: 'AUD' },
      ask: { amount: 450, ccy: 'AUD' },
    }));
    for (const b of buyers) {
      buyerWants.push(
        await publish(b, card('WANT', gtr, CLUSTER_B, {
          attributes: gtrAttrs,
          price: { band: { min: 0, max: 800 }, ccy: 'AUD' },
        })),
      );
    }

    // Urgency island: ivy's HAVE first, jack's 'today' WANT arrives later
    // (after ivy's agent is artificially aged - see the urgency test).
    ivyHave = await publish(ivy, card('HAVE', 'goods.electronics.phone', URG_B, {
      attributes: { condition: 'good', model: 'pixel 8', storage_gb: 128 },
    }));

    // Pulse cells: 9-member (ABSENT) and 10-member (present) - all WANTs so
    // the cells create no matches of their own.
    const kCard = (bucket: string) =>
      card('WANT', 'goods.toys-games', bucket, { attributes: { condition: 'good' } });
    const kPub: Promise<string>[] = [];
    for (let i = 0; i < 9; i++) kPub.push(publish(kAccounts[i < 5 ? 0 : 1], kCard(K9_B)));
    for (let i = 0; i < 10; i++) kPub.push(publish(kAccounts[i < 5 ? 2 : 3], kCard(K10_B)));
    const kIds = await Promise.all(kPub);

    // Filler city background: mixed categories/types/prices, own bucket.
    const fillerSpecs: [string, 'WANT' | 'HAVE'][] = [
      ['goods.furniture.table', 'HAVE'], ['goods.furniture.table', 'WANT'],
      ['goods.electronics.laptop', 'HAVE'], ['goods.electronics.laptop', 'WANT'],
      ['goods.appliances.kitchen', 'HAVE'], ['goods.appliances.kitchen', 'WANT'],
      ['goods.clothing.adult', 'HAVE'], ['goods.clothing.adult', 'WANT'],
      ['goods.sports.outdoor', 'HAVE'], ['goods.sports.outdoor', 'WANT'],
      ['goods.books-media', 'HAVE'], ['goods.books-media', 'WANT'],
      ['goods.tools.power', 'HAVE'], ['goods.tools.power', 'WANT'],
    ];
    fillerCardIds = await Promise.all(
      fillerSpecs.map(([cat, type], i) =>
        publish(fillers[i], card(type, cat, FILL_B, {
          attributes: { condition: 'good' },
          ...(i % 3 === 0 ? { price: { band: { min: 10, max: 500 }, ccy: 'AUD' } } : {}),
        })),
      ),
    );

    // ---- wait for screening + embedding + publication -------------------
    const waits: Promise<unknown>[] = [
      waitForCardState(alice.accessToken, aliceWant, ['PUBLISHED']),
      waitForCardState(bob.accessToken, bobHave, ['PUBLISHED']),
      waitForCardState(carol.accessToken, carolWant, ['PUBLISHED']),
      waitForCardState(dan.accessToken, danWant, ['PUBLISHED']),
      waitForCardState(erin.accessToken, erinHave, ['PUBLISHED']),
      waitForCardState(frank.accessToken, frankHave, ['PUBLISHED']),
      waitForCardState(hank.accessToken, hankHave, ['PUBLISHED']),
      ...buyers.map((b, i) => waitForCardState(b.accessToken, buyerWants[i], ['PUBLISHED'])),
      waitForCardState(ivy.accessToken, ivyHave, ['PUBLISHED']),
      // One poller per account (kAccounts hold 5 cards each): parallel
      // single-card waits on one token burn the shared hourly read ceiling.
      waitForCardStates(kAccounts[0].accessToken, kIds.slice(0, 5), ['PUBLISHED']),
      waitForCardStates(kAccounts[1].accessToken, kIds.slice(5, 9), ['PUBLISHED']),
      waitForCardStates(kAccounts[2].accessToken, kIds.slice(9, 14), ['PUBLISHED']),
      waitForCardStates(kAccounts[3].accessToken, kIds.slice(14), ['PUBLISHED']),
      ...fillerCardIds.map((id, i) =>
        waitForCardState(fillers[i].accessToken, id, ['PUBLISHED'])),
    ];
    await Promise.all(waits);

    // ---- wait for the matcher -------------------------------------------
    abMatchId = await poll(async () => {
      const rows = await matchBetween(aliceWant, bobHave);
      return rows[0]?.[0] as string | undefined;
    }, 'alice-bob designed match', 180_000);
    await poll(async () => {
      const n = await dbExec(
        `SELECT count(*)::int FROM matches
         WHERE card_have = :h::uuid AND state = 'open'`,
        [{ name: 'h', value: hankHave }],
      );
      return Number(n[0][0]) >= 3 ? true : undefined;
    }, 'hank contested by 3 buyers', 180_000);
    for (const [i, b] of buyers.entries()) {
      const rows = await matchBetween(hankHave, buyerWants[i]);
      hankMatchIds[b.accountId] = rows[0][0] as string;
    }
  }, 1_500_000);

  it('EMBEDDING: published cards carry a real 1024-dim Titan vector', async () => {
    const rows = await dbExec(
      `SELECT vector_dims(embedding) FROM cards WHERE id = :id::uuid`,
      [{ name: 'id', value: bobHave }],
    );
    expect(Number(rows[0][0])).toBe(1024);
    // Every seeded published card is embedded - none skipped, none faked.
    const missing = await dbExec(
      `SELECT count(*)::int FROM cards
       WHERE embedding IS NULL AND lifecycle_state = 'PUBLISHED'
         AND id = ANY(ARRAY[:a,:b,:c]::uuid[])`,
      [
        { name: 'a', value: aliceWant },
        { name: 'b', value: hankHave },
        { name: 'c', value: ivyHave },
      ],
    );
    expect(Number(missing[0][0])).toBe(0);
  });

  it('EMBEDDING: backfill op embeds a nulled-out card and re-queues matching', async () => {
    const target = fillerCardIds[1]; // a WANT with no match riding on it
    await dbExec(`UPDATE cards SET embedding = NULL WHERE id = :id::uuid`, [
      { name: 'id', value: target },
    ]);
    await sendOp({ op: 'backfill-embeddings' });
    await poll(async () => {
      const r = await dbExec(
        `SELECT vector_dims(embedding) FROM cards WHERE id = :id::uuid AND embedding IS NOT NULL`,
        [{ name: 'id', value: target }],
      );
      return Number(r[0]?.[0]) === 1024 ? true : undefined;
    }, 'backfilled embedding', 120_000);
  });

  it('GATE (a): designed pair matches with score >= threshold; both sides get stage-1 signals', async () => {
    const rows = await matchBetween(aliceWant, bobHave);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0][1])).toBeGreaterThanOrEqual(0.75);

    for (const [actor, who] of [
      [alice, 'alice'],
      [bob, 'bob'],
    ] as const) {
      const r = await mcpCall(actor.accessToken, 'check_matches', {});
      const entry = r.result.matches.find((m: any) => m.match_id === abMatchId);
      expect(entry, `${who} sees the match`).toBeTruthy();
      expect(entry.signal.kind).toBe('match.signal');
      expect(entry.signal.category).toBe('goods.electronics.camera');
      // No machine internals cross to the agent: no score, and a word for what
      // to do next rather than a stage integer. Neither side has expressed
      // interest yet, so this is a fresh signal.
      expect(entry.signal.score).toBeUndefined();
      expect(entry.stage_unlocked).toBeUndefined();
      expect(entry.next).toBe('show_interest');
      // The signal is THIN: no score, no attributes, no identity, no prices.
      expect(Object.keys(entry.signal).sort()).toEqual([
        'category', 'counterparty_type', 'kind', 'match_id', 'schema_version',
      ]);
    }
  });

  it('GATE (a): designed non-matches (geo / band gap / category) create nothing', async () => {
    // Give the matcher ample time to have been wrong before asserting.
    await new Promise((r) => setTimeout(r, 5_000));
    expect(await matchBetween(carolWant, bobHave), 'wrong geo').toHaveLength(0);
    expect(await matchBetween(danWant, bobHave), 'band gap (100 < 400)').toHaveLength(0);
    expect(await matchBetween(aliceWant, erinHave), 'band gap (750 < 5000)').toHaveLength(0);
    expect(await matchBetween(aliceWant, frankHave), 'wrong category').toHaveLength(0);
    // ...and none of them landed as near-misses either: hard-rule failures
    // are incompatible, not "nearly compatible".
    const nm = await dbExec(
      `SELECT count(*)::int FROM near_misses
       WHERE card_want = ANY(ARRAY[:c,:d]::uuid[]) OR card_have = ANY(ARRAY[:e,:f]::uuid[])`,
      [
        { name: 'c', value: carolWant },
        { name: 'd', value: danWant },
        { name: 'e', value: erinHave },
        { name: 'f', value: frankHave },
      ],
    );
    expect(Number(nm[0][0])).toBe(0);
  });

  it('GATE (a+): urgency=today only matches counterparties fast enough to matter', async () => {
    // Age ivy's agent tokens beyond the 1-hour freshness window.
    await dbExec(
      `UPDATE oauth_tokens SET last_used_at = now() - interval '2 hours'
       WHERE account_id = :id::uuid`,
      [{ name: 'id', value: ivy.accountId }],
    );
    jackWant = await publish(jack, card('WANT', 'goods.electronics.phone', URG_B, {
      attributes: { condition: 'good', model: 'pixel 8' },
      urgency: 'today',
    }));
    await waitForCardState(jack.accessToken, jackWant, ['PUBLISHED']);
    await new Promise((r) => setTimeout(r, 8_000)); // matcher had its chance
    expect(await matchBetween(jackWant, ivyHave), 'stale-agent counterparty').toHaveLength(0);

    // Ivy's agent shows up (a REAL authenticated MCP call refreshes
    // last_used_at) - re-running the card now matches.
    await mcpCall(ivy.accessToken, 'list_intents', {});
    await poll(async () => {
      const r = await dbExec(
        `SELECT 1 FROM oauth_tokens WHERE account_id = :id::uuid
           AND last_used_at > now() - interval '1 hour' LIMIT 1`,
        [{ name: 'id', value: ivy.accountId }],
      );
      return r.length ? true : undefined;
    }, 'ivy token freshness');
    const amend = await mcpCall(jack.accessToken, 'amend_intent', {
      intent_id: jackWant,
      patch: { attributes: { condition: 'good', model: 'pixel 8', unlocked: true } },
    });
    expect(amend.isError).toBe(false);
    await waitForCardState(jack.accessToken, jackWant, ['PUBLISHED']);
    await poll(async () => {
      const rows = await matchBetween(jackWant, ivyHave);
      return rows.length ? true : undefined;
    }, 'urgent match once the agent is fresh', 180_000);
  });

  it('GATE (b): no price/band/budget/reserve anywhere in stage-1/2 payloads', async () => {
    // respond drives the flow on the action word alone: alice expresses
    // interest first (nobody else has), so she is left awaiting the other side;
    // once bob matches it, the interest is mutual and the details unlock.
    const aliceInterest = await mcpCall(alice.accessToken, 'respond', {
      match_id: abMatchId,
      action: 'express_interest',
    });
    expect(aliceInterest.result.stage_unlocked).toBeUndefined();
    expect(aliceInterest.result.next).toBe('awaiting_other_side');
    const bobInterest = await mcpCall(bob.accessToken, 'respond', {
      match_id: abMatchId,
      action: 'express_interest',
    });
    expect(bobInterest.result.next).toBe('details_unlocked');
    for (const [actor, who] of [
      [alice, 'alice'],
      [bob, 'bob'],
    ] as const) {
      const stage1 = await mcpCall(actor.accessToken, 'check_matches', { match_id: abMatchId, stage: 1 });
      const stage2 = await mcpCall(actor.accessToken, 'check_matches', { match_id: abMatchId, stage: 2 });
      const all = await mcpCall(actor.accessToken, 'check_matches', {});
      expect(stage2.isError).toBe(false);
      for (const raw of [stage1.raw, stage2.raw, all.raw]) {
        expect(deepScanKeys(JSON.parse(raw)), `${who} deep scan`).toEqual([]);
        expect(raw).not.toMatch(/"(price|band|price_band|budget|reserve)"/);
      }
    }
    // The deliberate ask IS disclosable at stage 2 (bob chose to state it).
    const aliceStage2 = await mcpCall(alice.accessToken, 'check_matches', { match_id: abMatchId, stage: 2 });
    expect(aliceStage2.result.ask).toEqual({ amount: 620, ccy: 'AUD' });
    // The sweep entry now carries attributes and the details_unlocked word.
    const aliceAll = await mcpCall(alice.accessToken, 'check_matches', {});
    const abEntry = aliceAll.result.matches.find((m: any) => m.match_id === abMatchId);
    expect(abEntry.next).toBe('details_unlocked');
    expect(abEntry.attributes.kind).toBe('match.attributes');
  });

  it('GATE (d): collection window - holder sees all, rivals see nothing, early-close unlocks', async () => {
    // The contested card carries a live window.
    const w = await dbExec(
      `SELECT collect_until > now(), collect_closed_at IS NULL FROM cards WHERE id = :id::uuid`,
      [{ name: 'id', value: hankHave }],
    );
    expect(w[0]).toEqual([true, true]);

    // Unlock stage 2 on all three rival matches (both sides express interest).
    await Promise.all(
      buyers.map(async (b) => {
        const mid = hankMatchIds[b.accountId];
        await mcpCall(b.accessToken, 'respond', { match_id: mid, action: 'express_interest' });
        await mcpCall(hank.accessToken, 'respond', { match_id: mid, action: 'express_interest' });
      }),
    );

    // Every card starts on "Pass on", where an agent may not name a figure.
    // Each buyer's human writes a ceiling on their own card first — which is
    // what a real person would have to do before their agent could bid.
    await Promise.all(
      buyers.map((b, i) => setAutoNegotiate(b.jar, buyerWants[i], { limit: 1000 })),
    );

    // CONCURRENCY: all three buyers fire offers in parallel during the window.
    const offers = await Promise.all(
      buyers.map((b, i) =>
        mcpCall(b.accessToken, 'respond', {
          match_id: hankMatchIds[b.accountId],
          action: 'propose_offer',
          offer: {
            amount: 100 + i * 50,
            ccy: 'AUD',
            expiry: new Date(Date.now() + 86_400_000).toISOString(),
          },
        }),
      ),
    );
    for (const o of offers) expect(o.isError, JSON.stringify(o.result)).toBe(false);

    // HOLDER view: all three matches, all offers, and the window itself.
    const hankView = await mcpCall(hank.accessToken, 'check_matches', { intent_id: hankHave });
    const hankOpen = hankView.result.matches.filter((m: any) => m.state === 'open');
    expect(hankOpen.length).toBeGreaterThanOrEqual(3);
    const withWindow = hankOpen.filter((m: any) => m.collection?.collecting === true);
    expect(withWindow.length).toBe(hankOpen.length);
    expect(withWindow[0].collection.interested_parties).toBeGreaterThanOrEqual(3);
    for (const b of buyers) {
      const l = await mcpCall(hank.accessToken, 'respond', {
        match_id: hankMatchIds[b.accountId],
        action: 'list_offers',
      });
      expect(l.result.offers.length).toBeGreaterThanOrEqual(1);
    }

    // NON-HOLDER view: no rival signal of any kind (scarcity-theatre ban).
    for (const b of buyers) {
      const view = await mcpCall(b.accessToken, 'check_matches', {});
      expect(view.raw).not.toMatch(/collect|interested|rival|window|compet|contest/i);
      const mine = view.result.matches.filter(
        (m: any) => m.match_id === hankMatchIds[b.accountId],
      );
      expect(mine).toHaveLength(1);
      // A rival's match is not even addressable.
      const other = buyers.find((x) => x.accountId !== b.accountId)!;
      const probe = await mcpCall(b.accessToken, 'respond', {
        match_id: hankMatchIds[other.accountId],
        action: 'list_offers',
      });
      expect(probe.isError).toBe(true);
    }

    // HOLDER commit is locked while collecting...
    const locked = await mcpCall(hank.accessToken, 'respond', {
      match_id: hankMatchIds[buyers[0].accountId],
      action: 'opt_in',
    });
    expect(locked.isError).toBe(true);
    expect(locked.result.code).toBe('STAGE_LOCKED');

    // ...but a NON-holder buyer's own opt-in is not (their card is uncontested).
    const buyerOptIn = await mcpCall(buyers[1].accessToken, 'respond', {
      match_id: hankMatchIds[buyers[1].accountId],
      action: 'opt_in',
    });
    expect(buyerOptIn.isError, JSON.stringify(buyerOptIn.result)).toBe(false);

    // Early-close by the holder, then proceeding works.
    const close = await mcpCall(hank.accessToken, 'respond', {
      match_id: hankMatchIds[buyers[0].accountId],
      action: 'close_collection',
    });
    expect(close.isError).toBe(false);
    expect(close.result.collection_closed).toBe(true);
    const optIn = await mcpCall(hank.accessToken, 'respond', {
      match_id: hankMatchIds[buyers[0].accountId],
      action: 'opt_in',
    });
    expect(optIn.isError, JSON.stringify(optIn.result)).toBe(false);
    expect(optIn.result.optin_recorded).toBe(true);
    // Terminal: the card records the explicit close.
    const closed = await dbExec(
      `SELECT collect_closed_at IS NOT NULL FROM cards WHERE id = :id::uuid`,
      [{ name: 'id', value: hankHave }],
    );
    expect(closed[0][0]).toBe(true);
  });

  it('GATE (e): 4th per-match offer in 24h -> RATE_LIMITED_OFFERS; ladder flags reputation', async () => {
    const b1 = buyers[0];
    const mid = hankMatchIds[b1.accountId];
    // b1 already made one offer (100). Walk it up: 110, 120 - a ladder.
    for (const amount of [110, 120]) {
      const r = await mcpCall(b1.accessToken, 'respond', {
        match_id: mid,
        action: 'propose_offer',
        offer: { amount, ccy: 'AUD', expiry: new Date(Date.now() + 86_400_000).toISOString() },
      });
      expect(r.isError, JSON.stringify(r.result)).toBe(false);
    }
    // 4th offer on the same match inside 24h: rate-limited.
    const fourth = await mcpCall(b1.accessToken, 'respond', {
      match_id: mid,
      action: 'propose_offer',
      offer: { amount: 130, ccy: 'AUD', expiry: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(fourth.isError).toBe(true);
    expect(fourth.result.code).toBe('RATE_LIMITED_OFFERS');
    expect(fourth.result.retry_after).toBeGreaterThan(0);

    // The monotonic-increment probing pattern flagged the reputation stub.
    const rep = await dbExec(
      `SELECT probing_flags FROM reputation WHERE account_id = :id::uuid`,
      [{ name: 'id', value: b1.accountId }],
    );
    expect(Number(rep[0][0])).toBeGreaterThanOrEqual(1);
  });

  it('GATE (e): declines are reasonless - input rejected, output scanned', async () => {
    const b2 = buyers[1];
    const mid = hankMatchIds[b2.accountId];
    const l = await mcpCall(hank.accessToken, 'respond', { match_id: mid, action: 'list_offers' });
    const offerId = l.result.offers[0].offer_id;
    // Attaching a reason to a decline is rejected outright.
    const withReason = await mcpCall(hank.accessToken, 'respond', {
      match_id: mid,
      action: 'decline_offer',
      offer_id: offerId,
      reason: 'too low',
    });
    expect(withReason.isError).toBe(true);
    // A clean decline carries nothing but the state change.
    const declined = await mcpCall(hank.accessToken, 'respond', {
      match_id: mid,
      action: 'decline_offer',
      offer_id: offerId,
    });
    expect(declined.isError).toBe(false);
    expect(declined.result.state).toBe('declined');
    expect(declined.raw).not.toMatch(/reason/i);
  });

  it('VERDICT: good-call / not-for-me stored per human; not-for-me mutes + nudges threshold', async () => {
    // Hank: good call on the buyer[1] match.
    const good = await mcpCall(hank.accessToken, 'respond', {
      match_id: hankMatchIds[buyers[1].accountId],
      action: 'verdict',
      verdict: 'good-call',
    });
    expect(good.isError, JSON.stringify(good.result)).toBe(false);

    // Boris (buyers[2]): not for me.
    const b3 = buyers[2];
    const before = await dbExec(
      `SELECT threshold_bump::float8 FROM reputation WHERE account_id = :id::uuid`,
      [{ name: 'id', value: b3.accountId }],
    );
    const notForMe = await mcpCall(b3.accessToken, 'respond', {
      match_id: hankMatchIds[b3.accountId],
      action: 'verdict',
      verdict: 'not-for-me',
    });
    expect(notForMe.isError).toBe(false);

    const rows = await dbExec(
      `SELECT
         (SELECT count(*)::int FROM match_verdicts WHERE account_id = :b::uuid AND verdict = 'not-for-me'),
         (SELECT count(*)::int FROM match_mutes WHERE account_id = :b::uuid AND muted_account = :h::uuid),
         (SELECT threshold_bump::float8 FROM reputation WHERE account_id = :b::uuid),
         (SELECT state FROM matches WHERE id = :m::uuid)`,
      [
        { name: 'b', value: b3.accountId },
        { name: 'h', value: hank.accountId },
        { name: 'm', value: hankMatchIds[b3.accountId] },
      ],
    );
    expect(Number(rows[0][0])).toBeGreaterThanOrEqual(1); // verdict stored
    expect(Number(rows[0][1])).toBe(1); // pairing muted
    expect(Number(rows[0][2])).toBeCloseTo(Number(before[0][0]) + 0.01); // nudged up
    expect(rows[0][3]).toBe('declined'); // reasonless decline of the pairing
  });

  it('GATE (c): pulse k-floor - 9-member cell ABSENT, 10-member cell exact', async () => {
    await sendOp({ op: 'pulse-refresh' });
    const cell10 = await poll(async () => {
      const r = await dbExec(
        `SELECT open_want_count, open_have_count, matches_created
         FROM pulse_aggregates WHERE category = 'goods.toys-games' AND geo_bucket = :b`,
        [{ name: 'b', value: K10_B }],
      );
      return r.length ? r[0] : undefined;
    }, '10-member pulse cell', 120_000);
    expect(Number(cell10[0])).toBe(10); // exact, real count
    expect(Number(cell10[1])).toBe(0);
    expect(cell10[2]).toBeNull(); // 0 matches: under its own k-floor -> absent

    const cell9 = await dbExec(
      `SELECT count(*)::int FROM pulse_aggregates WHERE geo_bucket = :b`,
      [{ name: 'b', value: K9_B }],
    );
    expect(Number(cell9[0][0])).toBe(0); // ABSENT, not zeroed

    // The matrix island (6 cards) is under the floor too - absent.
    const matrixCell = await dbExec(
      `SELECT count(*)::int FROM pulse_aggregates WHERE geo_bucket = :b`,
      [{ name: 'b', value: MATRIX_B }],
    );
    expect(Number(matrixCell[0][0])).toBe(0);
  });

  it('NEAR-MISS mechanism: rows only ever live in [0.55, threshold) and are never disclosed', async () => {
    const bad = await dbExec(
      `SELECT count(*)::int FROM near_misses WHERE score < 0.55 OR score >= 0.9`,
    );
    expect(Number(bad[0][0])).toBe(0);
    // Nothing in any agent-visible surface mentions near-misses.
    const view = await mcpCall(alice.accessToken, 'check_matches', {});
    expect(view.raw).not.toMatch(/near.?miss/i);
  });
});
