/**
 * Counter sessions — the HUMAN route class's own credential, structurally
 * disjoint from the agent path:
 *  - the cookie (__Host-osb_counter) is HttpOnly + Secure + SameSite=Lax and
 *    host-only (no Domain attribute), so browsers never present it to the
 *    MCP hostname;
 *  - signing in always mints a fresh one and deletes the old row, so a cookie
 *    somebody else planted never becomes a signed-in credential;
 *  - the cookie value is opaque; only its sha256 is stored;
 *  - nothing in this module reads the Authorization header, and the counter
 *    route guard hard-rejects any request that carries one.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../db.js';

/**
 * The cookie's name, and the one it used to have.
 *
 * `__Host-` is a promise the BROWSER enforces rather than one the server
 * makes: a cookie with that prefix is refused unless it is Secure, has
 * Path=/, and carries no Domain — so no other host on openswitchboard.ai can
 * write one, which is the whole of what the attribute is for here.
 *
 * The old name is no longer read (28 September 2026). Any other host on the
 * domain could write a cookie under it, so reading it undid what the prefix is
 * for. It is still cleared on sign-out, because a browser may still hold one.
 */
export const COUNTER_COOKIE = '__Host-osb_counter';
export const LEGACY_COUNTER_COOKIE = 'osb_counter';
const SESSION_TTL_HOURS = 24 * 7;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * What opened the current window. A passkey and a PIN are the account's own
 * credentials. An emailed code is its recovery: anyone who can read the inbox
 * can produce one, so a window it opened carries the everyday presses and
 * never a credential change, an agent key or an authorisation.
 */
export type ElevationSource = 'passkey' | 'pin' | 'code';

export interface CounterSession {
  id: string;
  accountId: string | null;
  pinOkUntil: Date | null;
  /** What opened the window in pinOkUntil. Null reads as the weaker kind. */
  elevatedVia?: ElevationSource | null;
  oauthCtx: any;
}

export async function createSession(
  reply: FastifyReply,
  accountId: string | null,
  oauthCtx?: any,
): Promise<CounterSession> {
  const sid = `osb_cs_${randomBytes(32).toString('base64url')}`;
  const r = await getPool().query(
    `INSERT INTO counter_sessions (sid_hash, account_id, oauth_ctx, expires_at)
     VALUES ($1,$2,$3, now() + make_interval(hours => ${SESSION_TTL_HOURS}))
     RETURNING id`,
    [sha256hex(sid), accountId, oauthCtx ? JSON.stringify(oauthCtx) : null],
  );
  reply.header(
    'set-cookie',
    `${COUNTER_COOKIE}=${sid}; Path=/; Max-Age=${SESSION_TTL_HOURS * 3600}; HttpOnly; Secure; SameSite=Lax`,
  );
  return { id: r.rows[0].id, accountId, pinOkUntil: null, elevatedVia: null, oauthCtx: oauthCtx ?? null };
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

function cookieValue(req: FastifyRequest): string | undefined {
  return readCookie(req, COUNTER_COOKIE);
}

export async function loadSession(req: FastifyRequest): Promise<CounterSession | undefined> {
  const sid = cookieValue(req);
  if (!sid?.startsWith('osb_cs_')) return undefined;
  const r = await getPool().query(
    `SELECT id, account_id, pin_ok_until, elevated_via, oauth_ctx FROM counter_sessions
     WHERE sid_hash = $1 AND expires_at > now()`,
    [sha256hex(sid)],
  );
  if (!r.rows[0]) return undefined;
  return {
    id: r.rows[0].id,
    accountId: r.rows[0].account_id,
    pinOkUntil: r.rows[0].pin_ok_until ? new Date(r.rows[0].pin_ok_until) : null,
    elevatedVia: r.rows[0].elevated_via ?? null,
    oauthCtx: r.rows[0].oauth_ctx,
  };
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sid = cookieValue(req);
  if (sid) {
    await getPool().query('DELETE FROM counter_sessions WHERE sid_hash = $1', [sha256hex(sid)]);
  }
  // Both names, because the browser may still be holding the old one.
  reply.header('set-cookie', [
    `${COUNTER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    `${LEGACY_COUNTER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  ]);
}

/**
 * Signing in takes a NEW session, not the old one with a name written on it.
 *
 * The cookie a person arrives holding may not be theirs: anyone who can set a
 * cookie on this host — a shared machine, a browser extension, a link that
 * planted one — can hand somebody an identifier and then wait for them to sign
 * in on it. Attaching the account to that row would make the planted
 * identifier a live credential for the person who signed in. So the row is
 * replaced: a fresh identifier the attacker has never seen, and the old row
 * deleted in the same act.
 *
 * What DOES carry across is the pending authorization request, because it is
 * the reason the person was sent to sign in and it belongs to them, not to
 * whoever might have planted the cookie.
 */
export async function rotateSession(
  reply: FastifyReply,
  previous: CounterSession | undefined,
  accountId: string,
): Promise<CounterSession> {
  const fresh = await createSession(reply, accountId, previous?.oauthCtx ?? undefined);
  if (previous) {
    await getPool().query('DELETE FROM counter_sessions WHERE id = $1', [previous.id]);
  }
  return fresh;
}

export async function setOauthCtx(sessionId: string, ctx: any): Promise<void> {
  await getPool().query('UPDATE counter_sessions SET oauth_ctx = $2 WHERE id = $1', [
    sessionId,
    ctx ? JSON.stringify(ctx) : null,
  ]);
}

/**
 * Grant the session a window after a ceremony, and say which ceremony it was.
 * A later ceremony replaces both, so a passkey pressed inside a window an
 * emailed code opened makes it the stronger kind.
 */
export async function elevateSession(
  sessionId: string,
  minutes: number,
  via: ElevationSource,
): Promise<void> {
  await getPool().query(
    `UPDATE counter_sessions SET pin_ok_until = now() + make_interval(mins => $2::int),
       elevated_via = $3 WHERE id = $1`,
    [sessionId, minutes, via],
  );
}

/** Inside a window, whatever opened it. The everyday presses lean on this. */
export function isElevated(s: CounterSession): boolean {
  return !!s.pinOkUntil && s.pinOkUntil > new Date();
}

/**
 * Inside a window the account's own credential opened: a passkey, or a PIN
 * that is not waiting out a recovery. Changing a credential, making an agent
 * key and authorising an assistant lean on this and nothing weaker.
 */
export function isStronglyElevated(s: CounterSession): boolean {
  return isElevated(s) && (s.elevatedVia === 'passkey' || s.elevatedVia === 'pin');
}

/** Inside a window an emailed code opened, and nothing stronger since. */
export function isCodeElevated(s: CounterSession): boolean {
  return isElevated(s) && !isStronglyElevated(s);
}

// ---------------------------------------------------------------------------
// Where to come back to after signing in.
//
// A person opens the link their assistant gave them, is not signed in, signs
// in, and used to land on their main page with the link lost in the chat. The
// path they were on is now kept in a short cookie and they are sent back to it.
//
// ONLY TWO SHAPES OF PATH are ever kept or followed: a one-use link (/a/…) and
// an open request on the main page (/open/<uuid>). Both are this host's own
// pages, so the cookie cannot be used to send anybody anywhere else, and both
// are checked again on the way back out, so a cookie somebody else wrote is
// held to the same two shapes.
// ---------------------------------------------------------------------------
export const RETURN_COOKIE = '__Host-osb_return';
const RETURN_TTL_SECONDS = 15 * 60;
const RETURN_PATH_RES = [
  /^\/a\/[A-Za-z0-9._-]+$/,
  /^\/open\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
];

/** True for the only paths a sign-in may return to. */
export function returnPathOk(path: unknown): path is string {
  return (
    typeof path === 'string' && path.length <= 300 && RETURN_PATH_RES.some((re) => re.test(path))
  );
}

/** Keep the path a signed-out person was on, for fifteen minutes. */
export function rememberReturnPath(reply: FastifyReply, path: string): void {
  if (!returnPathOk(path)) return;
  reply.header(
    'set-cookie',
    `${RETURN_COOKIE}=${path}; Path=/; Max-Age=${RETURN_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  );
}

/** The kept path, if there is one and it is one of the two shapes; cleared either way. */
export function takeReturnPath(req: FastifyRequest, reply: FastifyReply): string | undefined {
  const raw = readCookie(req, RETURN_COOKIE);
  if (raw === undefined) return undefined;
  reply.header('set-cookie', `${RETURN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return returnPathOk(raw) ? raw : undefined;
}

/** WebAuthn ceremony state. The SQL is exported so the tests exercise the
 *  exact statements production runs (see test/unit/my.test.ts for the
 *  structural invariant and test/integration/gates.test.ts for the lifecycle
 *  against a real PostgreSQL). */
export const WEBAUTHN_CHALLENGE_TTL = '5 minutes';

export const SET_WEBAUTHN_CHALLENGE_SQL = `UPDATE counter_sessions SET webauthn_challenge = $2,
       webauthn_challenge_expires = now() + interval '${WEBAUTHN_CHALLENGE_TTL}' WHERE id = $1`;

export async function setWebauthnChallenge(sessionId: string, challenge: string): Promise<void> {
  await getPool().query(SET_WEBAUTHN_CHALLENGE_SQL, [sessionId, challenge]);
}

/**
 * Consume the session's pending challenge: return it and clear it in one
 * statement, so a challenge is usable exactly once and only inside its TTL.
 *
 * The read has to come from a separate CTE rather than the UPDATE's own
 * RETURNING: on PostgreSQL below 18, RETURNING yields the NEW row, so
 * `RETURNING webauthn_challenge` after `SET webauthn_challenge = NULL` hands
 * back the NULL it just wrote and every ceremony fails as no_pending_challenge.
 * The FOR UPDATE row lock keeps concurrent takes single-use: the loser
 * re-checks the qual against the cleared row and matches nothing.
 */
export const TAKE_WEBAUTHN_CHALLENGE_SQL = `WITH pending AS (
       SELECT id, webauthn_challenge FROM counter_sessions
        WHERE id = $1 AND webauthn_challenge IS NOT NULL AND webauthn_challenge_expires > now()
        FOR UPDATE
     ), cleared AS (
       UPDATE counter_sessions c
          SET webauthn_challenge = NULL, webauthn_challenge_expires = NULL
         FROM pending WHERE c.id = pending.id
       RETURNING c.id
     )
     SELECT pending.webauthn_challenge FROM pending JOIN cleared ON cleared.id = pending.id`;

export async function takeWebauthnChallenge(sessionId: string): Promise<string | undefined> {
  const r = await getPool().query(TAKE_WEBAUTHN_CHALLENGE_SQL, [sessionId]);
  return r.rows[0]?.webauthn_challenge ?? undefined;
}
