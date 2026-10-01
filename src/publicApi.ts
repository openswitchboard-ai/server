/**
 * Public read API (0.G): the website's ONLY data source.
 *
 * Three GET endpoints, no auth:
 *  - /public/pulse — rows straight from pulse_aggregates (the k>=10 floor is
 *    enforced at materialisation time by domain/pulse.ts: under-floor cells
 *    are absent, under-floor match stats are NULL; this layer exposes
 *    NOTHING the pulse module floored and adds no un-floored numbers).
 *  - /public/stats — network totals, each INDEPENDENTLY floored: a total is
 *    present in the response only when the underlying count is >= K_ANON,
 *    otherwise the key is omitted entirely (never zeroed, never rounded up).
 *  - /public/totals — the website's headline line, staged: network-wide
 *    aggregates that appear only once each is worth showing (thresholds in
 *    config, never below K_ANON). A number under its threshold is not served
 *    at all, so no page can show a small count. See totalsFor.
 *
 * All are cached in-process for 60s and rate-limited per client IP. A cold
 * cache is filled by ONE query however many requests arrive while it runs
 * (single flight), so a burst after the minute turns over costs one scan.
 * CORS: the public site origin, plus the local Astro dev server outside prod.
 * GET-only.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { K_ANON, readPulse, type PulseRow } from './domain/pulse.js';
import { categoryLabelPath, decodeGeohash, isGeohash } from './domain/matchRules.js';
import { getPool } from './db.js';
import { SURFACED_SQL } from './domain/counterOps.js';
import { makeIpLimiter } from './abuseLimit.js';
import type { Config } from './config.js';

/**
 * The origins a browser may read these from. The local Astro dev server is a
 * developer's convenience and has no business being trusted by production
 * (2026-09-28 review), so it is on the list everywhere but prod.
 */
export function allowedOrigins(cfg: Pick<Config, 'envName'> | undefined): string[] {
  // www serves the same site with no redirect, so it reads the same counts.
  const site = ['https://openswitchboard.ai', 'https://www.openswitchboard.ai'];
  return cfg?.envName === 'prod' ? site : [...site, 'http://localhost:4321'];
}

/**
 * How far back the median time-to-match looks. The percentile is a sort over
 * every row it is given, and "every match there has ever been" grows without
 * end (2026-09-28 review); ninety days is also the more honest figure for a
 * network that is changing.
 */
export const STATS_MEDIAN_WINDOW_DAYS = 90;

const CACHE_MS = 60_000;

// Modest per-IP rate limit: 60 requests a minute across every route here, shared by every task.
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export interface PublicPulseRow {
  category: string;
  category_label: string;
  geo_bucket: string;
  /** Honest, derived-only label: the coarse cell itself (never a guessed
   *  place name we don't actually know). */
  geo_label: string;
  open_want_count: number;
  open_have_count: number;
  matches_created: number | null;
  median_seconds_to_match: number | null;
}

export interface PublicStats {
  /** Every field optional: present ONLY when its own count >= K_ANON. */
  open_want_count?: number;
  back_pocket_count?: number;
  matches_created?: number;
  median_seconds_to_match?: number;
}

/** How far back /public/totals counts introductions. */
export const TOTALS_INTROS_WINDOW_DAYS = 30;

export const DEFAULT_TOTALS_THRESHOLDS = { postingsMin: 100, introsMin: 25 } as const;

/** The unfloored counts behind /public/totals. Never served as they are. */
export interface RawTotals {
  /** PUBLISHED wants and haves, not expired, not paused. */
  live_postings: number;
  /** Countries holding at least K_ANON live postings each. */
  live_countries: number;
  /** Introductions created in the window that went live (never in-line ones). */
  introductions_30d: number;
  /** Rows on /public/pulse, every one already at or above K_ANON. */
  category_rows: number;
}

/**
 * The served shape. Each stage adds to the one before and nothing else:
 *  0 nothing worth showing: the stage alone, no numbers at all
 *  1 the network total (and its countries)
 *  2 plus introductions in the last 30 days
 *  3 plus the per-category view, which the page reads from /public/pulse
 */
export type PublicTotals =
  | { stage: 0 }
  | { stage: 1; live_postings: number; live_countries: number }
  | { stage: 2 | 3; live_postings: number; live_countries: number; introductions_30d: number };

/**
 * Stage from raw counts. The thresholds are held to K_ANON whatever config
 * says, so a misconfigured deployment still never serves a count under the
 * floor. Pure, so the suppression is tested without a database.
 */
export function totalsFor(
  raw: RawTotals,
  thresholds: { postingsMin: number; introsMin: number } = DEFAULT_TOTALS_THRESHOLDS,
): PublicTotals {
  const postingsMin = Math.max(K_ANON, thresholds.postingsMin);
  const introsMin = Math.max(K_ANON, thresholds.introsMin);
  if (raw.live_postings < postingsMin) return { stage: 0 };
  const base = { live_postings: raw.live_postings, live_countries: raw.live_countries };
  if (raw.introductions_30d < introsMin) return { stage: 1, ...base };
  return {
    stage: raw.category_rows > 0 ? 3 : 2,
    ...base,
    introductions_30d: raw.introductions_30d,
  };
}

export interface PublicDataSource {
  pulseRows(): Promise<PulseRow[]>;
  stats(): Promise<PublicStats>;
  totals(): Promise<RawTotals>;
}

/** Real data source: pulse module + two aggregate-only SQL totals. */
function realDataSource(): PublicDataSource {
  return {
    pulseRows: () => readPulse({ limit: 200 }),
    stats: async () => {
      const pool = getPool();
      const cards = await pool.query(
        `SELECT
           count(*) FILTER (WHERE type = 'WANT' AND protocol_status = 'active')::int
             AS open_want_count,
           count(*) FILTER (WHERE protocol_status = 'latent')::int
             AS back_pocket_count
         FROM cards
         WHERE lifecycle_state = 'PUBLISHED' AND expires_at > now()
           AND NOT paused_by_kill_switch`,
      );
      const matches = await pool.query(
        `SELECT (SELECT count(*)::int FROM matches) AS matches_created,
                count(*)::int AS recent_matches,
                percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY EXTRACT(EPOCH FROM (m.created_at - w.created_at)))
                  AS median_seconds_to_match
         FROM matches m JOIN cards w ON w.id = m.card_want
         WHERE m.created_at > now() - make_interval(days => $1::int)`,
        [STATS_MEDIAN_WINDOW_DAYS],
      );
      const c = cards.rows[0];
      const m = matches.rows[0];
      const out: PublicStats = {};
      // Independent flooring: each total appears only at >= K_ANON.
      if (c.open_want_count >= K_ANON) out.open_want_count = c.open_want_count;
      if (c.back_pocket_count >= K_ANON) out.back_pocket_count = c.back_pocket_count;
      if (m.matches_created >= K_ANON) out.matches_created = m.matches_created;
      // The median is floored on the rows it was actually taken over — the
      // window's — not on the all-time total beside it.
      if (m.recent_matches >= K_ANON && m.median_seconds_to_match != null) {
        out.median_seconds_to_match = Math.round(Number(m.median_seconds_to_match));
      }
      return out;
    },
    totals: async () => {
      const pool = getPool();
      const r = await pool.query(
        `WITH live AS (
           SELECT geo_country FROM cards
            WHERE lifecycle_state = 'PUBLISHED' AND expires_at > now()
              AND NOT paused_by_kill_switch
         )
         SELECT
           (SELECT count(*)::int FROM live) AS live_postings,
           (SELECT count(*)::int FROM (
              SELECT geo_country FROM live WHERE geo_country IS NOT NULL
               GROUP BY geo_country HAVING count(*) >= $2::int) c) AS live_countries,
           (SELECT count(*)::int FROM matches m
             WHERE m.created_at > now() - make_interval(days => $1::int)
               AND ${SURFACED_SQL}) AS introductions_30d,
           (SELECT count(*)::int FROM pulse_aggregates) AS category_rows`,
        [TOTALS_INTROS_WINDOW_DAYS, K_ANON],
      );
      const t = r.rows[0];
      return {
        live_postings: t.live_postings,
        live_countries: t.live_countries,
        introductions_30d: t.introductions_30d,
        category_rows: t.category_rows,
      };
    },
  };
}

/** Coarse, honest geo label: the cell code + its approximate size. */
export function geoLabel(bucket: string): string {
  if (isGeohash(bucket)) {
    const { cellKm } = decodeGeohash(bucket);
    return `area ${bucket} (~${Math.round(cellKm * 2)} km cell)`;
  }
  return `region ${bucket}`;
}

export function registerPublicRoutes(
  app: FastifyInstance,
  cfg: Config,
  deps: PublicDataSource = realDataSource(),
): void {
  const origins = allowedOrigins(cfg);
  const thresholds = cfg?.publicTotals ?? DEFAULT_TOTALS_THRESHOLDS;
  // Counted across every task (src/abuseLimit.ts, N11); one limiter per
  // registration so each app built in a test starts with an empty window.
  const limiter = makeIpLimiter(RATE_LIMIT, RATE_WINDOW_MS, 'public-api');
  const rateLimited = (req: FastifyRequest): Promise<boolean> => limiter.limited(req.ip);

  const cors = (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
    }
    reply.header('access-control-allow-methods', 'GET');
    reply.header('cache-control', 'public, max-age=60');
  };

  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    cors(req, reply);
    if (await rateLimited(req)) {
      void reply.code(429).send({ error: 'rate_limited' });
      return false;
    }
    return true;
  };

  for (const path of ['/public/pulse', '/public/stats', '/public/totals']) {
    app.options(path, async (req, reply) => {
      cors(req, reply);
      return reply.code(204).send();
    });
  }

  const pulseBody = cachedBody(async () => {
    const rows = await deps.pulseRows();
    const publicRows: PublicPulseRow[] = rows.map((r) => ({
      category: r.category,
      category_label: categoryLabelPath(r.category),
      geo_bucket: r.geo_bucket,
      geo_label: geoLabel(r.geo_bucket),
      open_want_count: r.open_want_count,
      open_have_count: r.open_have_count,
      matches_created: r.matches_created,
      median_seconds_to_match:
        r.median_seconds_to_match == null ? null : Math.round(Number(r.median_seconds_to_match)),
    }));
    return { k_floor: K_ANON, as_of: new Date().toISOString(), rows: publicRows };
  });
  const statsBody = cachedBody(async () => {
    const stats = await deps.stats();
    return { k_floor: K_ANON, as_of: new Date().toISOString(), ...stats };
  });
  // Only the staged shape leaves here: the raw counts stay in this closure.
  const totalsBody = cachedBody(async () => {
    const staged = totalsFor(await deps.totals(), thresholds);
    // Stage 0 is the stage and nothing else, not even a timestamp.
    return staged.stage === 0 ? staged : { ...staged, as_of: new Date().toISOString() };
  });

  app.get('/public/pulse', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    return reply.send(await pulseBody());
  });
  app.get('/public/stats', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    return reply.send(await statsBody());
  });
  app.get('/public/totals', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    return reply.send(await totalsBody());
  });
}

/**
 * A body cached for CACHE_MS. A cold cache is filled by ONE call however many
 * requests arrive while it runs: they wait on the same promise rather than
 * each starting a query. A failed fill caches nothing.
 */
function cachedBody<T>(fill: () => Promise<T>): () => Promise<T> {
  let cache: { at: number; body: T } | undefined;
  let inFlight: Promise<T> | undefined;
  return async () => {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.body;
    inFlight ??= fill()
      .then((body) => {
        cache = { at: Date.now(), body };
        return body;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
