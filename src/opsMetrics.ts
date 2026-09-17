/**
 * Operator metrics page (private): GET /ops/metrics and GET /ops/metrics.json.
 *
 * What it is for: one page an operator can open to see whether the switchboard
 * is being used and whether it is healthy. It is NOT a public surface and NOT
 * the pulse: the public read API (publicApi.ts) floors every number at
 * K_ANON, and this page does not, because it is behind a credential and shown
 * to one person. What it still refuses to show is any personal data — no
 * email, name, account id, card text, or message body ever reaches this file.
 * Everything here is a count, a state name, a category path, or a timestamp.
 *
 * Where it lives: registered directly on `app` (app.ts), deliberately OUTSIDE
 * the human page plugin — that plugin 403s any Authorization header, and this
 * route's whole auth is an Authorization header. It answers only on the MCP
 * hostname; on the human hostname /ops* is 404'd by the host hook in app.ts.
 *
 * Protection: HTTP Basic, credential from OPS_METRICS_BASIC_AUTH
 * (`user:password`). When the env var is unset the routes are never
 * registered, so the path 404s — the same spirit as the Stripe webhook, which
 * exists only where Stripe is configured. Failed attempts are rate-limited per
 * IP. The header and the credential are never logged.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getPool } from './db.js';
import { MANUAL } from './mcp/instructions.js';
import { SCHEMA_VERSION } from './protocol.js';
import { settlementsConfigured, type Config } from './config.js';

/** How long the whole collected result is reused before the SQL runs again. */
const CACHE_MS = 30_000;

/** Failed-auth allowance per IP, and the window it rolls on. */
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60_000;

/** A grouped count: a state name, category path or bucket, and how many. */
export interface CountRow {
  label: string;
  n: number;
}

/** A money total: never a per-settlement figure, always a currency sum. */
export interface MoneyRow {
  ccy: string;
  amount: string;
  n: number;
}

export interface OpsDbStatus {
  db_round_trip_ms: number;
  db_now: string | null;
  migrations_applied: number | null;
  pulse_computed_at: string | null;
}

export interface OpsPeople {
  accounts_total: number;
  new_24h: number;
  new_7d: number;
  new_30d: number;
  suspended: number;
  onboarded: number;
  kill_switch_on: number;
  with_timezone: number;
  with_passkey: number;
  hears_via: CountRow[];
  active_tokens: number;
  accounts_with_active_token: number;
  tokens_by_client: CountRow[];
  tokens_by_manual_version: CountRow[];
}

export interface OpsCards {
  total: number;
  wants_open: number;
  haves_open: number;
  posted_24h: number;
  posted_7d: number;
  posted_30d: number;
  expiring_24h: number;
  paused_by_kill_switch: number;
  screening_rejected: number;
  pending_screening: number;
  open_by_protocol_status: CountRow[];
  by_lifecycle_state: CountRow[];
  open_top_categories: CountRow[];
  open_by_reach: CountRow[];
}

export interface OpsMatching {
  total: number;
  created_24h: number;
  created_7d: number;
  declined: number;
  by_state: CountRow[];
  by_stage: CountRow[];
  median_seconds_to_match_7d: number | null;
  near_misses_7d: number;
  category_misses_7d: number;
  top_missed_categories_7d: CountRow[];
}

export interface OpsConversations {
  messages_24h: number;
  messages_7d: number;
  channels_active_7d: number;
  offers_total: number;
  offers_7d: number;
  offers_by_state: CountRow[];
  verdicts_by_value: CountRow[];
}

export interface OpsMoney {
  settlements_total: number;
  created_30d: number;
  by_state: CountRow[];
  released_totals: MoneyRow[];
}

export interface OpsEmail {
  sends_24h: number;
  sends_7d: number;
  sends_by_template_7d: CountRow[];
  sends_by_kind_7d: CountRow[];
  sends_by_status_7d: CountRow[];
  events_by_type_7d: CountRow[];
  bounce_rate_7d: number | null;
}

export interface OpsAbuse {
  read_calls_24h: number;
  read_call_accounts_24h: number;
  channel_sends_counted_24h: number;
  /**
   * Reports filed in the last day, and by how many accounts (2026-09-17
   * audit). COUNTS ONLY, and that is the whole of the design: no reporter, no
   * reported, no introduction, not a word of what anybody said. A report is
   * one of the few things here that is both a safety signal and a thing an
   * account could abuse, and the operator needs to see the SHAPE of it — five
   * reports from five people is a Tuesday, five from one account is a
   * campaign — without any of it becoming a way to read the reports.
   */
  reports_filed_24h: number;
  report_accounts_24h: number;
}

/** Everything the database can answer. Injectable so tests need no Postgres. */
export interface OpsDbMetrics {
  status: OpsDbStatus;
  people: OpsPeople;
  cards: OpsCards;
  matching: OpsMatching;
  conversations: OpsConversations;
  money: OpsMoney;
  email: OpsEmail;
  abuse: OpsAbuse;
}

export interface OpsDataSource {
  read(): Promise<OpsDbMetrics>;
}

/** The whole page: process/config facts plus everything the database said. */
export interface OpsMetrics extends OpsDbMetrics {
  generated_at: string;
  cache_age_seconds: number;
  process: {
    env_name: string;
    schema_version: string;
    manual_version: number;
    registration_mode: string;
    settlements_configured: boolean;
    uptime_seconds: number;
    node_version: string;
  };
}

const rows = (r: { label: unknown; n: unknown }[]): CountRow[] =>
  r.map((x) => ({ label: x.label == null ? '(none)' : String(x.label), n: Number(x.n) }));

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** Real data source: eight aggregate-only round trips, plus a timed ping. */
export function realOpsDataSource(): OpsDataSource {
  return {
    read: async (): Promise<OpsDbMetrics> => {
      const pool = getPool();

      // ---- 1. Status -----------------------------------------------------
      const t0 = Date.now();
      await pool.query('SELECT 1');
      const dbRoundTripMs = Date.now() - t0;
      const status = await pool.query(
        `SELECT now() AS db_now,
                (SELECT count(*)::int FROM schema_migrations) AS migrations_applied,
                (SELECT max(computed_at) FROM pulse_aggregates) AS pulse_computed_at`,
      );

      // ---- 2. People -----------------------------------------------------
      const accounts = await pool.query(
        `SELECT count(*)::int AS accounts_total,
                count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS new_24h,
                count(*) FILTER (WHERE created_at > now() - interval '7 days')::int  AS new_7d,
                count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new_30d,
                count(*) FILTER (WHERE status = 'suspended')::int      AS suspended,
                count(*) FILTER (WHERE onboarded_at IS NOT NULL)::int  AS onboarded,
                count(*) FILTER (WHERE kill_switch_at IS NOT NULL)::int AS kill_switch_on,
                count(*) FILTER (WHERE timezone IS NOT NULL)::int      AS with_timezone
         FROM accounts`,
      );
      const passkeys = await pool.query(
        `SELECT count(DISTINCT account_id)::int AS with_passkey FROM webauthn_credentials`,
      );
      const hearsVia = await pool.query(
        `SELECT hears_via AS label, count(*)::int AS n
         FROM accounts GROUP BY 1 ORDER BY 2 DESC`,
      );
      const tokens = await pool.query(
        `SELECT count(*)::int AS active_tokens,
                count(DISTINCT account_id)::int AS accounts_with_active_token
         FROM oauth_tokens
         WHERE kind = 'access' AND NOT revoked AND NOT suspended AND expires_at > now()`,
      );
      const tokensByClient = await pool.query(
        `SELECT coalesce(c.client_name, '(no client)') AS label, count(*)::int AS n
         FROM oauth_tokens t
         LEFT JOIN oauth_clients c ON c.client_id = t.client_id
         WHERE t.kind = 'access' AND NOT t.revoked AND NOT t.suspended
           AND t.expires_at > now()
         GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
      );
      const tokensByManual = await pool.query(
        `SELECT coalesce(manual_version::text, '(none)') AS label, count(*)::int AS n
         FROM oauth_tokens
         WHERE kind = 'access' AND NOT revoked AND NOT suspended AND expires_at > now()
         GROUP BY 1 ORDER BY 1`,
      );

      // ---- 3. Wants and haves -------------------------------------------
      const openWhere = `lifecycle_state = 'PUBLISHED' AND expires_at > now()
                         AND NOT paused_by_kill_switch`;
      const cards = await pool.query(
        `WITH c AS (SELECT *, (${openWhere}) AS is_open FROM cards)
         SELECT count(*)::int AS total,
                count(*) FILTER (WHERE is_open AND type = 'WANT')::int AS wants_open,
                count(*) FILTER (WHERE is_open AND type = 'HAVE')::int AS haves_open,
                count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS posted_24h,
                count(*) FILTER (WHERE created_at > now() - interval '7 days')::int  AS posted_7d,
                count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS posted_30d,
                count(*) FILTER (WHERE is_open AND expires_at < now() + interval '24 hours')::int
                  AS expiring_24h,
                count(*) FILTER (WHERE paused_by_kill_switch)::int AS paused_by_kill_switch,
                count(*) FILTER (WHERE lifecycle_state = 'SCREENING_REJECTED')::int
                  AS screening_rejected,
                count(*) FILTER (WHERE lifecycle_state = 'PENDING_SCREENING')::int
                  AS pending_screening
         FROM c`,
      );
      const byProtocolStatus = await pool.query(
        `SELECT protocol_status AS label, count(*)::int AS n
         FROM cards WHERE ${openWhere} GROUP BY 1 ORDER BY 2 DESC, 1`,
      );
      const byLifecycle = await pool.query(
        `SELECT lifecycle_state AS label, count(*)::int AS n
         FROM cards GROUP BY 1 ORDER BY 2 DESC, 1`,
      );
      const topCategories = await pool.query(
        `SELECT category AS label, count(*)::int AS n
         FROM cards WHERE ${openWhere} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`,
      );
      const byReach = await pool.query(
        `SELECT coalesce(geo->>'reach', 'radius') AS label, count(*)::int AS n
         FROM cards WHERE ${openWhere} GROUP BY 1 ORDER BY 2 DESC, 1`,
      );

      // ---- 4. Matching ---------------------------------------------------
      const matches = await pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS created_24h,
                count(*) FILTER (WHERE created_at > now() - interval '7 days')::int  AS created_7d,
                count(*) FILTER (WHERE state = 'declined')::int AS declined
         FROM matches`,
      );
      const matchesByState = await pool.query(
        `SELECT state AS label, count(*)::int AS n
         FROM matches GROUP BY 1 ORDER BY 2 DESC, 1`,
      );
      const matchesByStage = await pool.query(
        `SELECT stage::text AS label, count(*)::int AS n
         FROM matches GROUP BY 1 ORDER BY 1`,
      );
      const median = await pool.query(
        `SELECT percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY EXTRACT(EPOCH FROM (m.created_at - w.created_at)))
                  AS median_seconds_to_match_7d
         FROM matches m JOIN cards w ON w.id = m.card_want
         WHERE m.created_at > now() - interval '7 days'`,
      );
      const misses = await pool.query(
        `SELECT (SELECT count(*)::int FROM near_misses
                  WHERE created_at > now() - interval '7 days') AS near_misses_7d,
                (SELECT count(*)::int FROM category_misses
                  WHERE created_at > now() - interval '7 days') AS category_misses_7d`,
      );
      // Free-typed category paths that went UP without a leaf behind them.
      // The catalogue is a deny list, so these are postings that are live on
      // the board right now under a name nobody has written down, and this is
      // the growth list for the next taxonomy release rather than a tally of
      // refusals. Category-ish by construction, truncated hard, and escaped on
      // the way out.
      const topMissed = await pool.query(
        `SELECT left(requested, 60) AS label, count(*)::int AS n
         FROM category_misses WHERE created_at > now() - interval '7 days'
         GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
      );

      // ---- 5. Conversations & offers -------------------------------------
      const messages = await pool.query(
        `SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int
                  AS messages_24h,
                count(*) FILTER (WHERE created_at > now() - interval '7 days')::int
                  AS messages_7d,
                count(DISTINCT channel_id) FILTER (WHERE created_at > now() - interval '7 days')::int
                  AS channels_active_7d
         FROM channel_messages`,
      );
      const offers = await pool.query(
        `SELECT count(*)::int AS offers_total,
                count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS offers_7d
         FROM offers`,
      );
      const offersByState = await pool.query(
        `SELECT state AS label, count(*)::int AS n
         FROM offers GROUP BY 1 ORDER BY 2 DESC, 1`,
      );
      const verdicts = await pool.query(
        `SELECT verdict AS label, count(*)::int AS n
         FROM match_verdicts GROUP BY 1 ORDER BY 2 DESC, 1`,
      );

      // ---- 6. Money ------------------------------------------------------
      const settlements = await pool.query(
        `SELECT count(*)::int AS settlements_total,
                count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS created_30d
         FROM settlements`,
      );
      const settlementsByState = await pool.query(
        `SELECT state AS label, count(*)::int AS n
         FROM settlements GROUP BY 1 ORDER BY 2 DESC, 1`,
      );
      // `amount` is the agreed amount in the currency's major unit (the minor
      // -unit columns beside it are the buyer's fee breakdown, not this).
      const releasedTotals = await pool.query(
        `SELECT upper(ccy) AS ccy, to_char(sum(amount), 'FM999999999990.00') AS amount,
                count(*)::int AS n
         FROM settlements WHERE state = 'released' GROUP BY 1 ORDER BY 1`,
      );

      // ---- 7. Email ------------------------------------------------------
      const sends = await pool.query(
        `SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS sends_24h,
                count(*) FILTER (WHERE created_at > now() - interval '7 days')::int  AS sends_7d
         FROM email_sends`,
      );
      const sendsByTemplate = await pool.query(
        `SELECT template AS label, count(*)::int AS n
         FROM email_sends WHERE created_at > now() - interval '7 days'
         GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`,
      );
      const sendsByKind = await pool.query(
        `SELECT kind AS label, count(*)::int AS n
         FROM email_sends WHERE created_at > now() - interval '7 days'
         GROUP BY 1 ORDER BY 2 DESC, 1`,
      );
      const sendsByStatus = await pool.query(
        `SELECT status AS label, count(*)::int AS n
         FROM email_sends WHERE created_at > now() - interval '7 days'
         GROUP BY 1 ORDER BY 2 DESC, 1`,
      );
      const eventsByType = await pool.query(
        `SELECT event_type AS label, count(*)::int AS n
         FROM email_events WHERE created_at > now() - interval '7 days'
         GROUP BY 1 ORDER BY 2 DESC, 1`,
      );

      // ---- 8. Rate-limit signal -----------------------------------------
      const readCalls = await pool.query(
        `SELECT count(*)::int AS read_calls_24h,
                count(DISTINCT account_id)::int AS read_call_accounts_24h
         FROM read_calls WHERE called_at > now() - interval '24 hours'`,
      );
      const channelSends = await pool.query(
        `SELECT coalesce(sum(n), 0)::int AS channel_sends_counted_24h
         FROM channel_send_rate WHERE window_start > now() - interval '24 hours'`,
      );
      // Two counts and nothing else. This query names no column that could
      // carry a word of a report or the identity of anybody in one.
      const reportsFiled = await pool.query(
        `SELECT count(*)::int AS reports_filed_24h,
                count(DISTINCT reporter_account)::int AS report_accounts_24h
         FROM reports WHERE created_at > now() - interval '24 hours'`,
      );

      const s = status.rows[0];
      const a = accounts.rows[0];
      const c = cards.rows[0];
      const m = matches.rows[0];
      const mi = misses.rows[0];
      const ch = messages.rows[0];
      const o = offers.rows[0];
      const st = settlements.rows[0];
      const em = sends.rows[0];
      const evRows = rows(eventsByType.rows);
      const bounces = evRows
        .filter((r) => /bounce/i.test(r.label))
        .reduce((t, r) => t + r.n, 0);

      return {
        status: {
          db_round_trip_ms: dbRoundTripMs,
          db_now: s.db_now instanceof Date ? s.db_now.toISOString() : (s.db_now ?? null),
          migrations_applied: s.migrations_applied == null ? null : Number(s.migrations_applied),
          pulse_computed_at:
            s.pulse_computed_at instanceof Date
              ? s.pulse_computed_at.toISOString()
              : (s.pulse_computed_at ?? null),
        },
        people: {
          accounts_total: num(a.accounts_total),
          new_24h: num(a.new_24h),
          new_7d: num(a.new_7d),
          new_30d: num(a.new_30d),
          suspended: num(a.suspended),
          onboarded: num(a.onboarded),
          kill_switch_on: num(a.kill_switch_on),
          with_timezone: num(a.with_timezone),
          with_passkey: num(passkeys.rows[0]?.with_passkey),
          hears_via: rows(hearsVia.rows),
          active_tokens: num(tokens.rows[0]?.active_tokens),
          accounts_with_active_token: num(tokens.rows[0]?.accounts_with_active_token),
          tokens_by_client: rows(tokensByClient.rows),
          tokens_by_manual_version: rows(tokensByManual.rows),
        },
        cards: {
          total: num(c.total),
          wants_open: num(c.wants_open),
          haves_open: num(c.haves_open),
          posted_24h: num(c.posted_24h),
          posted_7d: num(c.posted_7d),
          posted_30d: num(c.posted_30d),
          expiring_24h: num(c.expiring_24h),
          paused_by_kill_switch: num(c.paused_by_kill_switch),
          screening_rejected: num(c.screening_rejected),
          pending_screening: num(c.pending_screening),
          open_by_protocol_status: rows(byProtocolStatus.rows),
          by_lifecycle_state: rows(byLifecycle.rows),
          open_top_categories: rows(topCategories.rows),
          open_by_reach: rows(byReach.rows),
        },
        matching: {
          total: num(m.total),
          created_24h: num(m.created_24h),
          created_7d: num(m.created_7d),
          declined: num(m.declined),
          by_state: rows(matchesByState.rows),
          by_stage: rows(matchesByStage.rows),
          median_seconds_to_match_7d:
            median.rows[0]?.median_seconds_to_match_7d == null
              ? null
              : Math.round(Number(median.rows[0].median_seconds_to_match_7d)),
          near_misses_7d: num(mi.near_misses_7d),
          category_misses_7d: num(mi.category_misses_7d),
          top_missed_categories_7d: rows(topMissed.rows),
        },
        conversations: {
          messages_24h: num(ch.messages_24h),
          messages_7d: num(ch.messages_7d),
          channels_active_7d: num(ch.channels_active_7d),
          offers_total: num(o.offers_total),
          offers_7d: num(o.offers_7d),
          offers_by_state: rows(offersByState.rows),
          verdicts_by_value: rows(verdicts.rows),
        },
        money: {
          settlements_total: num(st.settlements_total),
          created_30d: num(st.created_30d),
          by_state: rows(settlementsByState.rows),
          released_totals: releasedTotals.rows.map((r: any) => ({
            ccy: String(r.ccy),
            amount: String(r.amount),
            n: Number(r.n),
          })),
        },
        email: {
          sends_24h: num(em.sends_24h),
          sends_7d: num(em.sends_7d),
          sends_by_template_7d: rows(sendsByTemplate.rows),
          sends_by_kind_7d: rows(sendsByKind.rows),
          sends_by_status_7d: rows(sendsByStatus.rows),
          events_by_type_7d: evRows,
          bounce_rate_7d: num(em.sends_7d) > 0 ? bounces / num(em.sends_7d) : null,
        },
        abuse: {
          read_calls_24h: num(readCalls.rows[0]?.read_calls_24h),
          read_call_accounts_24h: num(readCalls.rows[0]?.read_call_accounts_24h),
          channel_sends_counted_24h: num(channelSends.rows[0]?.channel_sends_counted_24h),
          reports_filed_24h: num(reportsFiled.rows[0]?.reports_filed_24h),
          report_accounts_24h: num(reportsFiled.rows[0]?.report_accounts_24h),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** Everything interpolated into the page goes through this. */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root { color-scheme: light dark; --fg:#141414; --bg:#fbfbfa; --muted:#5c5c5c;
        --line:#dcdcd8; --card:#fff; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8e6; --bg:#141414; --muted:#9a9a96; --line:#2e2e2c; --card:#1c1c1b; }
}
* { box-sizing: border-box; }
body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
       font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
       Helvetica, Arial, sans-serif; }
h1 { font-size:20px; margin:0 0 4px; }
h2 { font-size:15px; margin:28px 0 8px; text-transform:uppercase;
     letter-spacing:.06em; color:var(--muted); }
p.sub { margin:0 0 8px; color:var(--muted); font-size:13px; }
table { border-collapse:collapse; width:100%; max-width:640px; margin:0 0 12px;
        background:var(--card); border:1px solid var(--line); }
th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line);
         font-variant-numeric:tabular-nums; }
th[scope=col] { font-size:12px; text-transform:uppercase; letter-spacing:.05em;
                color:var(--muted); }
td.n { text-align:right; width:8em; }
tr:last-child th, tr:last-child td { border-bottom:0; }
footer { margin-top:32px; color:var(--muted); font-size:12px; }
`;

interface Pair {
  label: string;
  value: string | number | null;
}

function pairTable(caption: string, pairs: Pair[]): string {
  const body = pairs
    .map(
      (p) =>
        `<tr><th scope="row">${esc(p.label)}</th><td class="n">${esc(
          p.value === null ? '—' : p.value,
        )}</td></tr>`,
    )
    .join('');
  return `<h2>${esc(caption)}</h2><table><thead><tr>` +
    `<th scope="col">Measure</th><th scope="col">Value</th>` +
    `</tr></thead><tbody>${body}</tbody></table>`;
}

function countTable(caption: string, heading: string, list: CountRow[]): string {
  if (!list.length) {
    return `<h2>${esc(caption)}</h2><p class="sub">Nothing yet.</p>`;
  }
  const body = list
    .map((r) => `<tr><th scope="row">${esc(r.label)}</th><td class="n">${esc(r.n)}</td></tr>`)
    .join('');
  return `<h2>${esc(caption)}</h2><table><thead><tr>` +
    `<th scope="col">${esc(heading)}</th><th scope="col">Count</th>` +
    `</tr></thead><tbody>${body}</tbody></table>`;
}

/** The whole page. Server-rendered; no client JS; refreshes itself each minute. */
export function renderOpsMetricsHtml(d: OpsMetrics): string {
  const pct = (v: number | null) => (v === null ? null : `${(v * 100).toFixed(2)}%`);
  const parts: string[] = [];

  parts.push(
    pairTable('Status', [
      { label: 'Environment', value: d.process.env_name },
      { label: 'Schema version', value: d.process.schema_version },
      { label: 'Manual version', value: d.process.manual_version },
      { label: 'Registration mode', value: d.process.registration_mode },
      { label: 'Settlements configured', value: d.process.settlements_configured ? 'yes' : 'no' },
      { label: 'Process uptime (seconds)', value: d.process.uptime_seconds },
      { label: 'Node version', value: d.process.node_version },
      { label: 'Database round trip (ms)', value: d.status.db_round_trip_ms },
      { label: 'Database now', value: d.status.db_now },
      { label: 'Migrations applied', value: d.status.migrations_applied },
      { label: 'Pulse last computed', value: d.status.pulse_computed_at },
    ]),
  );

  parts.push(
    pairTable('People', [
      { label: 'Accounts', value: d.people.accounts_total },
      { label: 'New today', value: d.people.new_24h },
      { label: 'New this week', value: d.people.new_7d },
      { label: 'New this month', value: d.people.new_30d },
      { label: 'Suspended', value: d.people.suspended },
      { label: 'Onboarded', value: d.people.onboarded },
      { label: 'Kill switch on', value: d.people.kill_switch_on },
      { label: 'Time zone set', value: d.people.with_timezone },
      { label: 'Has a passkey', value: d.people.with_passkey },
      { label: 'Active agent tokens', value: d.people.active_tokens },
      { label: 'Accounts with a live agent', value: d.people.accounts_with_active_token },
    ]),
  );
  parts.push(countTable('How they hear', 'Route', d.people.hears_via));
  parts.push(countTable('Tokens by client', 'Client', d.people.tokens_by_client));
  parts.push(
    countTable('Tokens by manual version', 'Manual version', d.people.tokens_by_manual_version),
  );

  parts.push(
    pairTable('Wants and haves', [
      { label: 'Wants open', value: d.cards.wants_open },
      { label: 'Haves open', value: d.cards.haves_open },
      { label: 'Posted today', value: d.cards.posted_24h },
      { label: 'Posted this week', value: d.cards.posted_7d },
      { label: 'Posted this month', value: d.cards.posted_30d },
      { label: 'Expiring within a day', value: d.cards.expiring_24h },
      { label: 'Paused by kill switch', value: d.cards.paused_by_kill_switch },
      { label: 'Turned away by screening', value: d.cards.screening_rejected },
      { label: 'Waiting on screening', value: d.cards.pending_screening },
      { label: 'All ever posted', value: d.cards.total },
    ]),
  );
  parts.push(countTable('Open by protocol status', 'Status', d.cards.open_by_protocol_status));
  parts.push(countTable('By lifecycle state', 'State', d.cards.by_lifecycle_state));
  parts.push(countTable('Open by reach', 'Reach', d.cards.open_by_reach));
  parts.push(countTable('Busiest open categories', 'Category', d.cards.open_top_categories));

  parts.push(
    pairTable('Matching', [
      { label: 'Introductions made', value: d.matching.total },
      { label: 'Made today', value: d.matching.created_24h },
      { label: 'Made this week', value: d.matching.created_7d },
      { label: 'Declined', value: d.matching.declined },
      { label: 'Median seconds to match (week)', value: d.matching.median_seconds_to_match_7d },
      { label: 'Near misses this week', value: d.matching.near_misses_7d },
      { label: 'Posted without a leaf this week', value: d.matching.category_misses_7d },
    ]),
  );
  parts.push(countTable('Introductions by state', 'State', d.matching.by_state));
  parts.push(countTable('Introductions by stage', 'Stage', d.matching.by_stage));
  parts.push(
    countTable('Posted without a leaf', 'Filed under', d.matching.top_missed_categories_7d),
  );

  parts.push(
    pairTable('Conversations and offers', [
      { label: 'Messages today', value: d.conversations.messages_24h },
      { label: 'Messages this week', value: d.conversations.messages_7d },
      { label: 'Conversations alive this week', value: d.conversations.channels_active_7d },
      { label: 'Offers', value: d.conversations.offers_total },
      { label: 'Offers this week', value: d.conversations.offers_7d },
    ]),
  );
  parts.push(countTable('Offers by state', 'State', d.conversations.offers_by_state));
  parts.push(countTable('How it went', 'Verdict', d.conversations.verdicts_by_value));

  parts.push(
    pairTable('Money', [
      { label: 'Settlements', value: d.money.settlements_total },
      { label: 'Started this month', value: d.money.created_30d },
    ]),
  );
  parts.push(countTable('Settlements by state', 'State', d.money.by_state));
  if (d.money.released_totals.length) {
    const body = d.money.released_totals
      .map(
        (r) =>
          `<tr><th scope="row">${esc(r.ccy)}</th><td class="n">${esc(r.amount)}</td>` +
          `<td class="n">${esc(r.n)}</td></tr>`,
      )
      .join('');
    parts.push(
      `<h2>Released to sellers</h2><table><thead><tr><th scope="col">Currency</th>` +
        `<th scope="col">Agreed total</th><th scope="col">Settlements</th></tr></thead>` +
        `<tbody>${body}</tbody></table>`,
    );
  }

  parts.push(
    pairTable('Email', [
      { label: 'Sent today', value: d.email.sends_24h },
      { label: 'Sent this week', value: d.email.sends_7d },
      { label: 'Bounce rate this week', value: pct(d.email.bounce_rate_7d) },
    ]),
  );
  parts.push(countTable('Sent this week by template', 'Template', d.email.sends_by_template_7d));
  parts.push(countTable('Sent this week by kind', 'Kind', d.email.sends_by_kind_7d));
  parts.push(countTable('Sent this week by status', 'Status', d.email.sends_by_status_7d));
  parts.push(countTable('Delivery events this week', 'Event', d.email.events_by_type_7d));

  parts.push(
    pairTable('Read calls and channel sends', [
      { label: 'Agent read calls today', value: d.abuse.read_calls_24h },
      { label: 'Accounts reading today', value: d.abuse.read_call_accounts_24h },
      { label: 'Channel sends counted today', value: d.abuse.channel_sends_counted_24h },
    ]),
  );

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<meta name="robots" content="noindex">
<title>Ops metrics — OpenSwitchboard</title>
<style>${CSS}</style>
</head><body>
<h1>Ops metrics — OpenSwitchboard</h1>
<p class="sub">Environment ${esc(d.process.env_name)} · generated ${esc(d.generated_at)} · ` +
    `figures ${esc(d.cache_age_seconds)}s old · refreshes itself every minute</p>
${parts.join('\n')}
<footer>Aggregates only: no names, emails, account ids, or message content ever
reach this page. <a href="/ops/metrics.json">Same numbers as JSON</a>.</footer>
</body></html>
`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time credential comparison over equal-length digests. */
export function credentialMatches(expected: string, presented: string): boolean {
  return timingSafeEqual(sha256(expected), sha256(presented));
}

/**
 * Registers /ops/metrics and /ops/metrics.json — but ONLY when the deployment
 * carries a credential. Without OPS_METRICS_BASIC_AUTH the routes do not
 * exist, so the path answers 404 and there is nothing to guess at.
 */
export function registerOpsMetricsRoutes(
  app: FastifyInstance,
  cfg: Config,
  deps: OpsDataSource = realOpsDataSource(),
): void {
  const credential = cfg.opsMetricsBasicAuth;
  if (!credential) return;

  const mcpHost = new URL(cfg.publicOrigin).host.toLowerCase();
  let cache: { at: number; data: OpsDbMetrics } | undefined;
  const failures = new Map<string, { windowStart: number; n: number }>();

  const failureLimited = (ip: string): boolean => {
    const f = failures.get(ip);
    if (!f || Date.now() - f.windowStart >= FAIL_WINDOW_MS) return false;
    return f.n >= FAIL_LIMIT;
  };

  const recordFailure = (ip: string): void => {
    const now = Date.now();
    const f = failures.get(ip);
    if (!f || now - f.windowStart >= FAIL_WINDOW_MS) {
      failures.set(ip, { windowStart: now, n: 1 });
      if (failures.size > 10_000) {
        for (const [k, v] of failures) {
          if (now - v.windowStart >= FAIL_WINDOW_MS) failures.delete(k);
        }
      }
      return;
    }
    f.n += 1;
  };

  /** Basic auth, never logged, constant-time. Returns true when it passed. */
  const authorised = (req: FastifyRequest): boolean => {
    const header = req.headers.authorization;
    if (!header) return false;
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header.trim());
    if (!m) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(m[1], 'base64').toString('utf8');
    } catch {
      return false;
    }
    if (!decoded.includes(':')) return false;
    return credentialMatches(credential, decoded);
  };

  /** No-store and noindex on every answer, pass or fail. */
  const headers = (reply: FastifyReply): void => {
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex');
  };

  /** Host, rate limit, credential. Returns the collected metrics or undefined
   *  when it already answered. */
  const gate = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<OpsMetrics | undefined> => {
    headers(reply);
    // Operator surface, MCP hostname only. The human hostname 404s /ops* in
    // app.ts; this is the other half of the same fence.
    if ((req.headers.host ?? '').toLowerCase() !== mcpHost) {
      void reply.code(404).send({ error: 'not_found' });
      return undefined;
    }
    if (failureLimited(req.ip)) {
      void reply.code(429).type('text/plain').send('too many failed attempts\n');
      return undefined;
    }
    if (!authorised(req)) {
      recordFailure(req.ip);
      void reply
        .code(401)
        .header('www-authenticate', 'Basic realm="OpenSwitchboard ops"')
        .type('text/plain')
        .send('operator credentials required\n');
      return undefined;
    }
    if (!cache || Date.now() - cache.at >= CACHE_MS) {
      cache = { at: Date.now(), data: await deps.read() };
    }
    return {
      ...cache.data,
      generated_at: new Date().toISOString(),
      cache_age_seconds: Math.round((Date.now() - cache.at) / 1000),
      process: {
        env_name: cfg.envName,
        schema_version: SCHEMA_VERSION,
        manual_version: MANUAL.version,
        registration_mode: cfg.registrationMode,
        settlements_configured: settlementsConfigured(cfg),
        uptime_seconds: Math.round(process.uptime()),
        node_version: process.version,
      },
    };
  };

  app.get('/ops/metrics', async (req, reply) => {
    const data = await gate(req, reply);
    if (!data) return;
    return reply.type('text/html').send(renderOpsMetricsHtml(data));
  });

  app.get('/ops/metrics.json', async (req, reply) => {
    const data = await gate(req, reply);
    if (!data) return;
    return reply.send(data);
  });
}
