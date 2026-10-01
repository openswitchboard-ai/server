/**
 * Connected assistants: the OAuth sign-ins a person can see and end.
 *
 * An assistant that signed in through OAuth holds an access token and a
 * refresh token for one account. Until 1 October 2026 the person could see and
 * revoke the agent keys they issued by hand, but not these: the only way to
 * end one was "Stop all wants and haves", which ends everything. This is the
 * per-assistant door.
 *
 * Disconnecting removes access and nothing else, like Stop: it revokes every
 * access and refresh token that client holds on this one account. The client's
 * registration stays, so the same assistant can be authorised again with a
 * fresh press, and every other account it is connected to is untouched.
 */
import { getPool } from '../db.js';
import { writeConsentEvent } from '../crypto.js';

/** A registered client id: the uuid oauth_clients hands out. */
export const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConnectedAssistant {
  clientId: string;
  /** The name the client registered itself under. Untrusted: escape on render. */
  clientName: string;
  /** The host(s) of its registered redirect addresses, e.g. "localhost". */
  redirectHost: string;
  /** When the person first authorised the connection that is live now. */
  firstConnected: Date;
  /** The later of its last call and its last sign-in or refresh. */
  lastUsed: Date;
}

/** "connect.smithery.ai", "localhost", or both hosts when it registered two. */
export function redirectHostOf(redirectUris: unknown): string {
  const list = Array.isArray(redirectUris) ? redirectUris : [];
  const hosts: string[] = [];
  for (const u of list) {
    if (typeof u !== 'string') continue;
    try {
      const h = new URL(u).hostname;
      if (h && !hosts.includes(h)) hosts.push(h);
    } catch {
      // Registration refuses an unparseable address; nothing to show for one.
    }
  }
  return hosts.join(', ');
}

/**
 * Every OAuth client holding a usable credential on this account: an access
 * token or a refresh token that is neither revoked nor expired. A token the
 * Stop switch suspended still counts, because it comes back when Stop is
 * turned off, and the person should be able to end it before then.
 *
 * Agent keys are not here (kind 'api-key', no client): they have their own page.
 */
export async function connectedAssistants(accountId: string): Promise<ConnectedAssistant[]> {
  const r = await getPool().query(
    `SELECT c.client_id, c.client_name, c.redirect_uris,
            COALESCE(MIN(t.family_started_at) FILTER (WHERE NOT t.revoked AND t.expires_at > now()),
                     MIN(t.created_at) FILTER (WHERE NOT t.revoked AND t.expires_at > now())) AS first_connected,
            GREATEST(MAX(t.last_used_at), MAX(t.created_at)) AS last_used
       FROM oauth_tokens t
       JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.account_id = $1 AND t.kind IN ('access', 'refresh')
      GROUP BY c.client_id, c.client_name, c.redirect_uris
     HAVING bool_or(NOT t.revoked AND t.expires_at > now())
      ORDER BY last_used DESC`,
    [accountId],
  );
  return r.rows.map((row: any) => ({
    clientId: String(row.client_id),
    clientName: String(row.client_name ?? '') || 'An assistant',
    redirectHost: redirectHostOf(row.redirect_uris),
    firstConnected: new Date(row.first_connected),
    lastUsed: new Date(row.last_used),
  }));
}

/** The statement that ends one client's access to one account. */
const REVOKE_SQL = `UPDATE oauth_tokens SET revoked = true
      WHERE account_id = $1 AND client_id = $2::uuid AND kind IN ('access', 'refresh') AND NOT revoked`;

/**
 * Disconnect one assistant from one account. Returns how many tokens were
 * revoked (0 when there was nothing live) and the client's registered name.
 *
 * One UPDATE ends every access and refresh token the client holds here, every
 * refresh family included, since a family never crosses client or account.
 * The refresh endpoint rotates in a single statement that only proceeds while
 * the presented token is unrevoked (oauth.ts), so a refresh that reaches the
 * row after this has run is refused; one that reached it first holds the row
 * until it commits, this statement waits for it, and the second sweep below
 * then sees the pair it minted and ends that too.
 *
 * Unused authorization codes for the pair are spent first, so a sign-in that
 * was half way through cannot finish into a fresh token afterwards.
 */
export async function disconnectAssistant(
  accountId: string,
  clientId: string,
): Promise<{ revoked: number; clientName?: string }> {
  if (!CLIENT_ID_RE.test(clientId)) return { revoked: 0 };
  const pool = getPool();
  await pool.query(
    `UPDATE oauth_codes SET used = true
      WHERE account_id = $1 AND client_id = $2::uuid AND NOT used`,
    [accountId, clientId],
  );
  const first = await pool.query(REVOKE_SQL, [accountId, clientId]);
  const second = await pool.query(REVOKE_SQL, [accountId, clientId]);
  const revoked = (first.rowCount ?? 0) + (second.rowCount ?? 0);
  if (revoked === 0) return { revoked };
  const name = await pool.query(`SELECT client_name FROM oauth_clients WHERE client_id = $1::uuid`, [clientId]);
  const clientName = String(name.rows[0]?.client_name ?? '') || undefined;
  await writeConsentEvent({
    event: 'assistant-disconnected',
    account_id: accountId,
    client_id: clientId,
    tokens_revoked: revoked,
    recorded_via: 'counter',
  });
  return { revoked, ...(clientName ? { clientName } : {}) };
}

/**
 * The name to put in the "Disconnected." notice after the redirect, read back
 * from the client id in the address. Only a client this account has held
 * tokens for, and holds none live now, is named: anybody can register a client
 * under any name, and a crafted link must not put their words on this page.
 */
export async function disconnectedName(accountId: string, clientId: string): Promise<string | undefined> {
  if (!CLIENT_ID_RE.test(clientId)) return undefined;
  const r = await getPool().query(
    `SELECT c.client_name FROM oauth_clients c
      WHERE c.client_id = $2::uuid
        AND EXISTS (SELECT 1 FROM oauth_tokens t
                     WHERE t.client_id = c.client_id AND t.account_id = $1)
        AND NOT EXISTS (SELECT 1 FROM oauth_tokens t
                         WHERE t.client_id = c.client_id AND t.account_id = $1
                           AND NOT t.revoked AND t.expires_at > now())`,
    [accountId, clientId],
  );
  const name = r.rows[0]?.client_name;
  return typeof name === 'string' && name ? name : undefined;
}
