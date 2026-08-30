/**
 * Counter sessions — the HUMAN route class's own credential, structurally
 * disjoint from the agent path:
 *  - the cookie (osb_counter) is HttpOnly + Secure + SameSite=Lax and
 *    host-only (no Domain attribute), so browsers never present it to the
 *    MCP hostname;
 *  - the cookie value is opaque; only its sha256 is stored;
 *  - nothing in this module reads the Authorization header, and the counter
 *    route guard hard-rejects any request that carries one.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../db.js';

export const COUNTER_COOKIE = 'osb_counter';
const SESSION_TTL_HOURS = 24 * 7;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export interface CounterSession {
  id: string;
  accountId: string | null;
  pinOkUntil: Date | null;
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
  return { id: r.rows[0].id, accountId, pinOkUntil: null, oauthCtx: oauthCtx ?? null };
}

function cookieValue(req: FastifyRequest): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COUNTER_COOKIE) return rest.join('=');
  }
  return undefined;
}

export async function loadSession(req: FastifyRequest): Promise<CounterSession | undefined> {
  const sid = cookieValue(req);
  if (!sid?.startsWith('osb_cs_')) return undefined;
  const r = await getPool().query(
    `SELECT id, account_id, pin_ok_until, oauth_ctx FROM counter_sessions
     WHERE sid_hash = $1 AND expires_at > now()`,
    [sha256hex(sid)],
  );
  if (!r.rows[0]) return undefined;
  return {
    id: r.rows[0].id,
    accountId: r.rows[0].account_id,
    pinOkUntil: r.rows[0].pin_ok_until ? new Date(r.rows[0].pin_ok_until) : null,
    oauthCtx: r.rows[0].oauth_ctx,
  };
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sid = cookieValue(req);
  if (sid) {
    await getPool().query('DELETE FROM counter_sessions WHERE sid_hash = $1', [sha256hex(sid)]);
  }
  reply.header('set-cookie', `${COUNTER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

export async function attachAccount(sessionId: string, accountId: string): Promise<void> {
  await getPool().query('UPDATE counter_sessions SET account_id = $2 WHERE id = $1', [
    sessionId,
    accountId,
  ]);
}

export async function setOauthCtx(sessionId: string, ctx: any): Promise<void> {
  await getPool().query('UPDATE counter_sessions SET oauth_ctx = $2 WHERE id = $1', [
    sessionId,
    ctx ? JSON.stringify(ctx) : null,
  ]);
}

/** Grant the session a PIN-elevated window (after PIN or passkey ceremony). */
export async function elevateSession(sessionId: string, minutes: number): Promise<void> {
  await getPool().query(
    'UPDATE counter_sessions SET pin_ok_until = now() + make_interval(mins => $2::int) WHERE id = $1',
    [sessionId, minutes],
  );
}

export function isElevated(s: CounterSession): boolean {
  return !!s.pinOkUntil && s.pinOkUntil > new Date();
}

export async function setWebauthnChallenge(sessionId: string, challenge: string): Promise<void> {
  await getPool().query(
    `UPDATE counter_sessions SET webauthn_challenge = $2,
       webauthn_challenge_expires = now() + interval '5 minutes' WHERE id = $1`,
    [sessionId, challenge],
  );
}

export async function takeWebauthnChallenge(sessionId: string): Promise<string | undefined> {
  const r = await getPool().query(
    `UPDATE counter_sessions SET webauthn_challenge = NULL, webauthn_challenge_expires = NULL
     WHERE id = $1 AND webauthn_challenge IS NOT NULL AND webauthn_challenge_expires > now()
     RETURNING webauthn_challenge`,
    [sessionId],
  );
  return r.rows[0]?.webauthn_challenge ?? undefined;
}
