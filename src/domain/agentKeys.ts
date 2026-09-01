/**
 * Agent keys (1.C) — static bearer tokens a human issues by hand on their
 * approval page, for MCP clients that cannot run the OAuth flow.
 *
 * The key is `osb_ak_` + 32 random bytes, base64url. Only its sha256 hash is
 * stored, in oauth_tokens with kind 'api-key', so the plaintext exists once:
 * on the page that just minted it.
 *
 * Everything that governs an OAuth access token governs a key too, because
 * they share the row shape: the kill switch's suspend-all reaches it, revoke
 * sets the same column, and it expires 90 days after issue.
 */
import { createHash, randomBytes } from 'node:crypto';
import { getPool } from '../db.js';
import { writeConsentEvent } from '../crypto.js';
import { AGENT_KEY_PREFIX } from '../auth/oauth.js';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** How long an agent key lives before it has to be reissued. */
export const AGENT_KEY_TTL_DAYS = 90;
/** Ceiling on how many live keys one account may hold at once. */
export const AGENT_KEY_MAX_LIVE = 10;
/** Ceiling on the human's own label for a key. */
export const AGENT_KEY_NAME_MAX = 60;

export interface AgentKeyRow {
  keyId: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
}

/** Every live (unrevoked, unexpired) key on the account, newest first. */
export async function listAgentKeys(accountId: string): Promise<AgentKeyRow[]> {
  const r = await getPool().query(
    `SELECT key_id, name, created_at, last_used_at, expires_at
       FROM oauth_tokens
      WHERE account_id = $1 AND kind = 'api-key' AND NOT revoked AND expires_at > now()
      ORDER BY created_at DESC`,
    [accountId],
  );
  return r.rows.map((row: any) => ({
    keyId: row.key_id,
    name: row.name ?? 'agent key',
    createdAt: new Date(row.created_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    expiresAt: new Date(row.expires_at),
  }));
}

export class AgentKeyLimitError extends Error {
  constructor() {
    super('too many live agent keys');
  }
}

/**
 * Mint one key. Returns the plaintext token — the ONLY time it exists — plus
 * the row the approval page lists it by. Callers must have elevated the
 * human's session first; this function does not check that.
 */
export async function createAgentKey(
  accountId: string,
  name: string,
): Promise<{ token: string; row: AgentKeyRow }> {
  const live = await listAgentKeys(accountId);
  if (live.length >= AGENT_KEY_MAX_LIVE) throw new AgentKeyLimitError();

  const label = (name || '').trim().slice(0, AGENT_KEY_NAME_MAX) || 'agent key';
  const token = `${AGENT_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const r = await getPool().query(
    `INSERT INTO oauth_tokens (token_hash, kind, account_id, client_id, scope, name, key_id, expires_at)
     VALUES ($1,'api-key',$2,NULL,'switchboard',$3, gen_random_uuid(),
             now() + interval '${AGENT_KEY_TTL_DAYS} days')
     RETURNING key_id, name, created_at, last_used_at, expires_at`,
    [sha256hex(token), accountId, label],
  );
  const row = r.rows[0];
  await writeConsentEvent({
    event: 'agent-key-issued',
    account_id: accountId,
    key_id: row.key_id,
    key_name: label,
    expires_at: new Date(row.expires_at).toISOString(),
    recorded_via: 'counter',
  });
  return {
    token,
    row: {
      keyId: row.key_id,
      name: row.name,
      createdAt: new Date(row.created_at),
      lastUsedAt: null,
      expiresAt: new Date(row.expires_at),
    },
  };
}

/** Revoke one key. Returns the label when a live key was actually revoked. */
export async function revokeAgentKey(
  accountId: string,
  keyId: string,
): Promise<string | undefined> {
  const r = await getPool().query(
    `UPDATE oauth_tokens SET revoked = true
      WHERE account_id = $1 AND key_id = $2::uuid AND kind = 'api-key' AND NOT revoked
      RETURNING name`,
    [accountId, keyId],
  );
  const name = r.rows[0]?.name;
  if (name === undefined) return undefined;
  await writeConsentEvent({
    event: 'agent-key-revoked',
    account_id: accountId,
    key_id: keyId,
    key_name: name,
    recorded_via: 'counter',
  });
  return name ?? 'agent key';
}
