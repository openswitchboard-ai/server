/**
 * Category divergence: two agents, one errand, two different taxonomy nodes.
 *
 * THE QUESTION. Nothing makes two agents agree on where in the taxonomy an
 * errand lives. One files a mountain bike under goods.bicycle.mountain, the
 * other files the same bike under goods.bicycle, or goods.bicycle.road, or —
 * because their human said "pushbike" — under a node that does not exist at
 * all. Every one of those is a person with a real errand. This group walks the
 * live matcher through those filings and writes down, plainly, which of them it
 * pairs.
 *
 * WHAT IS A FAILURE AND WHAT IS A FINDING. The matcher's rule is
 * matchRules.ts categoryCompatible: equal, ancestor, descendant, or siblings
 * under a shared parent that is itself below the top level. Three of these
 * cases are therefore assertions about behaviour that must hold — the control,
 * the parent/child pair, and, since the sibling rule landed, the two bike
 * leaves under goods.bicycle. The cross-subtree cousins are an assertion about
 * CURRENT behaviour: they share no ancestor and no parent, the rule says they
 * do not pair, and the group asserts exactly that, so a change is caught
 * rather than assumed. What this group does is put the consequence of the
 * rule in front of a person in one table.
 *
 * One case in the group is not about filing at all. Case 3b holds the two
 * cards constant on one node and varies how much each side SAYS: the duet
 * pair's rich seller against its one-attribute buyer. It sits here because it
 * shares the island machinery and reads beside the others, and because the
 * question it asks is the same shape — what keeps two people apart who are
 * not actually in disagreement.
 *
 * Every case gets its own run-scoped opaque bucket, so each is an island: the
 * pairing under test is the only one available, and nothing another run left
 * behind can either gate-crash it or stand in for it.
 *
 * Cards are withdrawn as each case finishes, so the group costs each actor two
 * open-intent slots at a time rather than a dozen.
 */
import { Checker } from './checker.js';
import { Harness, SCHEMA_VERSION, SimActor, dbExec, log } from './harness.js';

// ---------------------------------------------------------------------------
// Real nodes, looked up in the shipped taxonomy (data/taxonomy.v2.json in
// @openswitchboard/schema). Every path below exists there except PUSHBIKE,
// which deliberately does not.
// ---------------------------------------------------------------------------
const BIKE = 'goods.bicycle';
const BIKE_MTN = 'goods.bicycle.mountain';
const BIKE_ROAD = 'goods.bicycle.road';
/** Slang a human would actually say. Not in the taxonomy, on purpose. */
const PUSHBIKE = 'goods.pushbike';
/** Cousins: the same errand — "practise a language with someone" — filed under
 *  two different top levels, which is exactly how two agents diverge when the
 *  errand is a service to one of them and company to the other. */
const TUTOR_LANG = 'services.tutoring.languages';
const SOCIAL_LANG = 'social.language-exchange.conversation-practice';

/** Attributes shared by both sides of a pair, so category is the ONLY thing
 *  that differs and the semantic score stays as high as it can. */
const BIKE_ATTRS = { condition: 'good', frame_size: 'L' };
const LANG_ATTRS = { level: 'intermediate' };

/** The duet pair's two cards, attribute for attribute, from
 *  realism-reports/duet-2026-09-05T09-19-26-360Z.json. A seller who wrote
 *  everything down, and a buyer who said the one thing that mattered to them. */
const RICH_SELLER_ATTRS = {
  year: 2021,
  brand: 'Giant',
  model: 'Trance',
  condition: 'well kept, good condition',
  frame_size: 'medium',
};
const THIN_BUYER_ATTRS = { frame_size: 'medium' };

/** A generous band pair: both sides assert a price, so the price term stays in
 *  the blend (matchRules.ts, AN UNASSERTED DIMENSION CANNOT VOTE) and
 *  contributes its full weight at fit 1.0 — which leaves the blend to be
 *  decided by category and semantics, the thing under test. */
const WANT_BAND = { band: { min: 0, max: 750 }, ccy: 'AUD' };
const HAVE_BAND = { band: { min: 0, max: 750 }, ccy: 'AUD' };

function card(
  type: 'WANT' | 'HAVE',
  category: string,
  geo: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { schema_version: SCHEMA_VERSION, type, category, geo, ttl_days: 1, ...extra };
}

export interface CategoryCaseResult {
  name: string;
  wantCategory: string;
  haveCategory: string;
  /** What the current rules say should happen. */
  expected: 'match' | 'no-match' | 'refused';
  /** What actually happened, in the same words. */
  observed: 'match' | 'no-match' | 'refused' | 'error';
  /** The matcher's own score on the pair, when a row exists to read it from. */
  score?: number;
  /** Where the score came from: the match, or the near-miss it left instead. */
  scoreFrom?: 'match' | 'near-miss';
  ok: boolean;
  detail?: string;
}

export interface CategoryDivergenceResult {
  rows: CategoryCaseResult[];
  failures: number;
  /** Whether Feature 1's table was present on the target when the slang case
   *  ran, and what it held afterwards. */
  missTable: 'absent' | 'row-found' | 'no-row';
}

/** Score band, in the words a person reads a table in. */
function band(score: number | undefined): string {
  if (score === undefined) return '—';
  const s = score.toFixed(3);
  if (score >= 0.75) return `${s} (match)`;
  if (score >= 0.55) return `${s} (near-miss)`;
  return `${s} (below floor)`;
}

/**
 * The matcher's own numbers on a pair, read from the DB in either direction:
 * the match row if it made one, the near-miss row if it only got that far.
 * Nothing agent-facing carries a score (invariant I7), so the DB is the only
 * place this is visible — which is why the table is worth printing.
 */
async function scoreFor(
  wantId: string,
  haveId: string,
): Promise<{ score?: number; scoreFrom?: 'match' | 'near-miss' }> {
  const params = [
    { name: 'w', value: wantId },
    { name: 'h', value: haveId },
  ];
  const m = await dbExec(
    `SELECT score::text FROM matches
      WHERE (card_want = :w::uuid AND card_have = :h::uuid)
         OR (card_want = :h::uuid AND card_have = :w::uuid)`,
    params,
  );
  if (m[0]?.[0] != null) return { score: Number(m[0][0]), scoreFrom: 'match' };
  const n = await dbExec(
    `SELECT score::text FROM near_misses
      WHERE (card_want = :w::uuid AND card_have = :h::uuid)
         OR (card_want = :h::uuid AND card_have = :w::uuid)`,
    params,
  );
  if (n[0]?.[0] != null) return { score: Number(n[0][0]), scoreFrom: 'near-miss' };
  return {};
}

/** How long to leave a pair that should NOT match before believing it. */
const NO_MATCH_SETTLE_MS = Number(process.env.SIM_CATEGORY_SETTLE_MS ?? 45_000);

export async function runCategoryDivergence(
  h: Harness,
  check: Checker,
  actors: SimActor[],
): Promise<CategoryDivergenceResult> {
  const rows: CategoryCaseResult[] = [];
  const [wantActor, haveActor] = actors;

  /**
   * One pairing case. Both cards go into ONE fresh opaque bucket so the live
   * matcher is the only thing that can pair them, and only with each other.
   */
  async function pairing(
    name: string,
    wantCategory: string,
    haveCategory: string,
    expected: 'match' | 'no-match',
    attributes: Record<string, unknown>,
    note?: string,
    opts: {
      /** Different attributes on the HAVE side; defaults to the same set. */
      haveAttributes?: Record<string, unknown>;
      /**
       * Post both cards with no price at all, the way most cards arrive.
       * With neither side asserting a price the engine drops the price term
       * and renormalises the other three weights over 0.9, so a score from a
       * noBands case is not comparable with one from a banded case.
       */
      noBands?: boolean;
    } = {},
  ): Promise<void> {
    const geo = { bucket: h.bucket('cd'), radius_km: 25 };
    const haveAttributes = opts.haveAttributes ?? attributes;
    let wantId: string | undefined;
    let haveId: string | undefined;
    try {
      const w = await h.publish(
        wantActor,
        card('WANT', wantCategory, geo, {
          attributes,
          ...(opts.noBands ? {} : { price: WANT_BAND }),
        }),
      );
      const hv = await h.publish(
        haveActor,
        card('HAVE', haveCategory, geo, {
          attributes: haveAttributes,
          ...(opts.noBands ? {} : { price: HAVE_BAND }),
        }),
      );
      wantId = w.result.intent_id;
      haveId = hv.result.intent_id;
      await Promise.all([
        h.waitCardDB(wantId!, ['PUBLISHED']),
        h.waitCardDB(haveId!, ['PUBLISHED']),
      ]);

      let matched: boolean;
      if (expected === 'match') {
        matched = !!(await h.waitMatchDB(wantId!, haveId!, 120_000));
      } else {
        // Give the matcher the same room it would have had to succeed, then
        // look once. A pair that has not been made by now was not going to be.
        await new Promise((r) => setTimeout(r, NO_MATCH_SETTLE_MS));
        matched = !!(await h.matchBetween(wantId!, haveId!));
      }
      const s = await scoreFor(wantId!, haveId!);
      const observed = matched ? ('match' as const) : ('no-match' as const);
      rows.push({
        name,
        wantCategory,
        haveCategory,
        expected,
        observed,
        ...s,
        ok: observed === expected,
        detail: note,
      });
      log(
        `${observed === expected ? 'as expected' : 'DIVERGED  '}  ${name}: ` +
          `${wantCategory} × ${haveCategory} -> ${observed} ${band(s.score)}`,
      );
    } catch (e) {
      rows.push({
        name,
        wantCategory,
        haveCategory,
        expected,
        observed: 'error',
        ok: false,
        detail: String(e).slice(0, 300),
      });
      log(`ERROR  ${name}: ${String(e).slice(0, 200)}`);
    } finally {
      // Hand the quota back before the next case.
      if (wantId) await h.withdraw(wantActor.accessToken, wantId);
      if (haveId) await h.withdraw(haveActor.accessToken, haveId);
    }
  }

  // -------------------------------------------------------------------------
  // 1. Control. The same node on both sides must pair; if this one fails,
  //    nothing below it means anything.
  // -------------------------------------------------------------------------
  await pairing('same-node (control)', BIKE_MTN, BIKE_MTN, 'match', BIKE_ATTRS);

  // -------------------------------------------------------------------------
  // 2. Parent vs child. categoryCompatible admits the ancestor line, and the
  //    SQL prefilter in matcher.ts admits it too, so this must pair — one
  //    agent being vaguer than the other is not a reason to keep two people
  //    apart. It costs 0.0525 of blended score (categoryCloseness 0.85 at the
  //    thin blend's 0.35 category weight; it was 0.03 at 0.20, and BIKE_ATTRS
  //    is two attributes a side, which is thin — see 3b).
  // -------------------------------------------------------------------------
  await pairing('parent vs child', BIKE, BIKE_MTN, 'match', BIKE_ATTRS);

  // -------------------------------------------------------------------------
  // 3. Sibling leaves under one parent, identical attributes.
  //
  //    These pair now. categoryCompatible admits siblings whose shared parent
  //    is itself below the top level, so goods.bicycle.mountain and
  //    goods.bicycle.road reach the blend, the SQL prefilter keeps the
  //    candidate, and semantic similarity decides. With the attributes
  //    identical on both sides it decides in favour: the category component
  //    is discounted to 0.7 closeness, which the rest of the score carries
  //    comfortably past 0.75. BIKE_ATTRS is two attributes a side, so this
  //    pair scores on the thin blend (semantic 0.30, category 0.35) and the
  //    sibling discount is 0.105 rather than 0.06 — still well clear.
  //
  //    A sibling pair whose descriptions have little in common lands under the
  //    threshold instead and leaves a near-miss row. That case is not staged
  //    here: this island holds one pair, and what it is testing is that the
  //    filing alone no longer keeps two people apart.
  // -------------------------------------------------------------------------
  await pairing(
    'sibling leaves',
    BIKE_MTN,
    BIKE_ROAD,
    'match',
    BIKE_ATTRS,
    'siblings under goods.bicycle pair, at 0.7 category closeness; semantics decide.',
  );

  // -------------------------------------------------------------------------
  // 3b. Rich seller, thin buyer, one node.
  //
  //     THE CASE THIS EXISTS FOR. On dev, 2026-09-05, two live agents posted
  //     these exact two cards — a 2021 Giant Trance in Canberra against "a
  //     medium mountain bike, Canberra" — and the pair scored 0.6072 against
  //     a 0.75 threshold, twice, byte-identical. Nothing about the two people
  //     disagreed: the buyer asserted one thing, the seller asserted five,
  //     and the semantic component read the difference in LENGTH as a
  //     difference in meaning. See matchRules.ts, ASSERTION-SCALED WEIGHTS.
  //     The thin blend took the same pair to 0.7489 on the 09-52-42 run, which
  //     is 0.0011 SHORT of the threshold — the second half of the fix is what
  //     closed that gap.
  //
  //     THE ARITHMETIC HERE. The card bodies below are the duet's, attribute
  //     for attribute; the bucket is this run's own island rather than
  //     Canberra, so both cards sit on one bucket and geo closeness is 1.0
  //     (the duet's two Canberra cards did not quite, which is why the live
  //     numbers differ). Neither card carries a price, as in the duet, so the
  //     price term is dropped and the thin weights are renormalised over 0.9:
  //         (0.30 s + 0.35 (1.0) + 0.25 (1.0)) / 0.9
  //     At the duet's semantic (0.35847) that is about 0.786 — where the same
  //     pair with the old neutral price term in it reached 0.7675. The live
  //     semantic on this island is its own number, so expect a score near
  //     that rather than exactly it.
  //
  //     NOT YET TRUE OF DEV. This case asserts the FIXED behaviour. Until the
  //     assertion-scaled weights AND the no-price renormalisation are both
  //     deployed it will read 'DIVERGED', and that is what it is for: it is
  //     the post-deploy check that the duet near-miss is gone.
  // -------------------------------------------------------------------------
  await pairing(
    'rich seller vs thin buyer (same node)',
    BIKE_MTN,
    BIKE_MTN,
    'match',
    THIN_BUYER_ATTRS,
    'the duet pair, card for card: 0.6072 on the original weights, 0.7489 with the thin blend alone, ~0.786 with the price term dropped as well.',
    { haveAttributes: RICH_SELLER_ATTRS, noBands: true },
  );

  // -------------------------------------------------------------------------
  // 4. Cross-subtree cousins: the same errand, one filed as a service and one
  //    as company. The two paths share no ancestor and no parent, so they are
  //    further apart than the siblings under any reading of the tree, and the
  //    prefilter drops them before scoring. No near-miss row either: however
  //    alike the two read, nobody hears about it.
  // -------------------------------------------------------------------------
  await pairing(
    'cross-subtree cousins',
    SOCIAL_LANG,
    TUTOR_LANG,
    'no-match',
    LANG_ATTRS,
    'no shared ancestor: services.* and social.* never pair, however alike the errand reads.',
  );

  // -------------------------------------------------------------------------
  // 5. Off-taxonomy slang. Refused at publish, with somewhere to go instead —
  //    and, since the demand log landed, leaving a row behind that says what
  //    was wanted.
  // -------------------------------------------------------------------------
  let missTable: CategoryDivergenceResult['missTable'] = 'absent';
  const geo = { bucket: h.bucket('cd'), radius_km: 25 };
  const slang = await h.publish(
    wantActor,
    card('WANT', PUSHBIKE, geo, { attributes: BIKE_ATTRS }),
    { expectError: true },
  );
  check.sweep(slang.raw, 'pushbike refusal');
  const refused = slang.isError && slang.result?.code === 'CATEGORY_PROHIBITED';
  const suggestions: string[] = slang.result?.suggestions ?? [];
  const pointsAtBikes = suggestions.some((s) => s.includes('bicycle'));

  // Did Feature 1's row land? The table only exists where the migration has
  // been applied, so a target without it is reported as such rather than
  // failed — this group runs against whatever dev happens to be on.
  const present = await dbExec(`SELECT to_regclass('public.category_misses') IS NOT NULL AS ok`);
  const tableExists = String(present[0]?.[0]).toLowerCase() === 'true';
  if (tableExists) {
    const seen = await dbExec(
      `SELECT count(*)::int FROM category_misses
        WHERE requested = :c AND account_id = :a::uuid AND created_at > now() - interval '10 minutes'`,
      [
        { name: 'c', value: PUSHBIKE },
        { name: 'a', value: wantActor.accountId },
      ],
    );
    missTable = Number(seen[0]?.[0]) > 0 ? 'row-found' : 'no-row';
  }

  const slangOk = refused && pointsAtBikes && missTable !== 'no-row';
  rows.push({
    name: 'off-taxonomy slang',
    wantCategory: PUSHBIKE,
    haveCategory: '—',
    expected: 'refused',
    observed: refused ? 'refused' : 'error',
    ok: slangOk,
    detail:
      `suggestions: ${suggestions.join(', ') || 'none'}` +
      `; category_misses: ${
        missTable === 'absent' ? 'table not deployed on this env' : missTable
      }`,
  });
  log(
    `${slangOk ? 'as expected' : 'DIVERGED  '}  off-taxonomy slang: ${PUSHBIKE} -> ` +
      `${refused ? 'CATEGORY_PROHIBITED' : JSON.stringify(slang.result).slice(0, 160)} ` +
      `[${suggestions.join(', ') || 'no suggestions'}] misses=${missTable}`,
  );

  return { rows, failures: rows.filter((r) => !r.ok).length, missTable };
}

/**
 * The compact table the report prints. Deliberately readable by a person who
 * has not read this file: scenario, both categories, what was expected, what
 * happened, and the matcher's own number where one exists.
 */
export function formatCategoryTable(res: CategoryDivergenceResult): string[] {
  const header = ['scenario', 'want category', 'have category', 'expected', 'observed', 'score'];
  const body = res.rows.map((r) => [
    r.name,
    r.wantCategory,
    r.haveCategory,
    r.expected,
    r.observed + (r.ok ? '' : '  <-- DIVERGED'),
    r.scoreFrom ? `${band(r.score)} [${r.scoreFrom}]` : band(r.score),
  ]);
  const widths = header.map((hd, i) => Math.max(hd.length, ...body.map((c) => c[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const out = [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)];
  for (const r of res.rows) {
    if (r.detail) out.push(`  note (${r.name}): ${r.detail}`);
  }
  return out;
}
