/**
 * Public read API (0.G): the website's ONLY data source.
 *
 * Two GET endpoints, no auth:
 *  - /public/pulse — rows straight from pulse_aggregates (the k>=10 floor is
 *    enforced at materialisation time by domain/pulse.ts: under-floor cells
 *    are absent, under-floor match stats are NULL; this layer exposes
 *    NOTHING the pulse module floored and adds no un-floored numbers).
 *  - /public/stats — network totals, each INDEPENDENTLY floored: a total is
 *    present in the response only when the underlying count is >= K_ANON,
 *    otherwise the key is omitted entirely (never zeroed, never rounded up).
 *
 * Both are cached in-process for 60s and rate-limited per client IP.
 * CORS: the public site origin + the local Astro dev server. GET-only.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { K_ANON, readPulse, type PulseRow } from './domain/pulse.js';
import { categoryLabelPath, decodeGeohash, isGeohash } from './domain/matchRules.js';
import { getPool } from './db.js';
import type { Config } from './config.js';

const ALLOWED_ORIGINS = ['https://openswitchboard.ai', 'http://localhost:4321'];

const CACHE_MS = 60_000;

// Modest per-IP rate limit: 60 requests per rolling minute across both routes.
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

export interface PublicDataSource {
  pulseRows(): Promise<PulseRow[]>;
  stats(): Promise<PublicStats>;
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
        `SELECT count(*)::int AS matches_created,
                percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY EXTRACT(EPOCH FROM (m.created_at - w.created_at)))
                  AS median_seconds_to_match
         FROM matches m JOIN cards w ON w.id = m.card_want`,
      );
      const c = cards.rows[0];
      const m = matches.rows[0];
      const out: PublicStats = {};
      // Independent flooring: each total appears only at >= K_ANON.
      if (c.open_want_count >= K_ANON) out.open_want_count = c.open_want_count;
      if (c.back_pocket_count >= K_ANON) out.back_pocket_count = c.back_pocket_count;
      if (m.matches_created >= K_ANON) {
        out.matches_created = m.matches_created;
        if (m.median_seconds_to_match != null) {
          out.median_seconds_to_match = Math.round(Number(m.median_seconds_to_match));
        }
      }
      return out;
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
  _cfg: Config,
  deps: PublicDataSource = realDataSource(),
): void {
  let pulseCache: { at: number; body: unknown } | undefined;
  let statsCache: { at: number; body: unknown } | undefined;
  const hits = new Map<string, { windowStart: number; n: number }>();

  const rateLimited = (req: FastifyRequest): boolean => {
    const now = Date.now();
    const ip = req.ip;
    const h = hits.get(ip);
    if (!h || now - h.windowStart >= RATE_WINDOW_MS) {
      hits.set(ip, { windowStart: now, n: 1 });
      // Opportunistic cleanup so the map cannot grow unboundedly.
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (now - v.windowStart >= RATE_WINDOW_MS) hits.delete(k);
      }
      return false;
    }
    h.n += 1;
    return h.n > RATE_LIMIT;
  };

  const cors = (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
    }
    reply.header('access-control-allow-methods', 'GET');
    reply.header('cache-control', 'public, max-age=60');
  };

  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    cors(req, reply);
    if (rateLimited(req)) {
      void reply.code(429).send({ error: 'rate_limited' });
      return false;
    }
    return true;
  };

  app.options('/public/pulse', async (req, reply) => {
    cors(req, reply);
    return reply.code(204).send();
  });
  app.options('/public/stats', async (req, reply) => {
    cors(req, reply);
    return reply.code(204).send();
  });

  app.get('/public/pulse', async (req, reply) => {
    if (!guard(req, reply)) return;
    if (!pulseCache || Date.now() - pulseCache.at >= CACHE_MS) {
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
      pulseCache = {
        at: Date.now(),
        body: { k_floor: K_ANON, as_of: new Date().toISOString(), rows: publicRows },
      };
    }
    return reply.send(pulseCache.body);
  });

  app.get('/public/stats', async (req, reply) => {
    if (!guard(req, reply)) return;
    if (!statsCache || Date.now() - statsCache.at >= CACHE_MS) {
      const stats = await deps.stats();
      statsCache = {
        at: Date.now(),
        body: { k_floor: K_ANON, as_of: new Date().toISOString(), ...stats },
      };
    }
    return reply.send(statsCache.body);
  });
}
