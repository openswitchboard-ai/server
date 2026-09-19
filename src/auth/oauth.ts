/**
 * OAuth 2.1 authorization server (per the MCP authorization spec):
 * authorization-code + PKCE (S256, mandatory), dynamic client registration
 * (RFC 7591), refresh tokens (rotated), RFC 8414 + RFC 9728 metadata.
 * Tokens are opaque and stored as sha256 hashes, bound to one human account.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { clientRegistrationLimiter, rateLimitBypassed } from '../abuseLimit.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../db.js';
import { registrationClosedPage } from '../counter/pages.js';
import { isSuspended } from '../safety/suspend.js';
import type { Config } from '../config.js';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');

const ACCESS_TTL_S = 3600; // 1h
const REFRESH_TTL_S = 30 * 24 * 3600; // 30d
const CODE_TTL_S = 600; // 10m

/**
 * How long a grant may go on renewing itself before the person has to say yes
 * again. Rotation alone has no end: an agent refreshing every hour holds a
 * live credential for ever off one press. Ninety days is the end of it,
 * counted from the press and not from the last rotation.
 */
export const FAMILY_MAX_AGE_S = 90 * 24 * 3600;

/**
 * What a PKCE verifier may be (RFC 7636 §4.1): 43 to 128 characters from the
 * unreserved set. Checked before it is hashed, so a client sending something
 * else is told it is malformed rather than quietly failing the compare.
 */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/** A constant-time compare of two strings that may differ in length. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export interface AuthContext {
  accountId: string;
  /** null for an agent key: the human issued it, so no OAuth client owns it. */
  clientId: string | null;
  scope: string;
  /** sha256 of the presented token: the row this session's state lives on. */
  tokenHash: string;
  /**
   * The agent-manual version this session was handed at initialize. null when
   * the session has never sent one — see migrations/014_manual_version.sql.
   */
  manualVersion: number | null;
  manualNotifiedAt: Date | string | null;
  /**
   * When this session was handed the manual's first page on a tool answer, or
   * read it itself. null means it has had neither — see migration 048.
   */
  manualStartSentAt: Date | string | null;
}

/** Prefix of an OAuth access token minted by the token endpoint. */
export const ACCESS_TOKEN_PREFIX = 'osb_at_';
/** Prefix of an agent key: a static bearer token a human issues by hand. */
export const AGENT_KEY_PREFIX = 'osb_ak_';

/** Resolve a Bearer token to an account. Returns undefined when invalid. */
export async function authenticate(req: FastifyRequest): Promise<AuthContext | undefined> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return undefined;
  const token = h.slice(7).trim();
  // Two credentials reach the agent surface: an OAuth access token, and an
  // agent key for clients that cannot run the OAuth flow. Both are opaque,
  // stored sha256-hashed, bound to one account, and carry identical
  // revoked/suspended/expiry semantics — only the row's kind differs.
  const kind = token.startsWith(ACCESS_TOKEN_PREFIX)
    ? 'access'
    : token.startsWith(AGENT_KEY_PREFIX)
      ? 'api-key'
      : undefined;
  if (!kind) return undefined;
  // NOT suspended: the counter's kill switch suspends (reversibly) every
  // agent token on the account, agent keys included.
  // manual_version rides along on this SELECT so the check_in sweep can
  // tell a stale session what has changed without a query of its own.
  const r = await getPool().query(
    `SELECT account_id, client_id, scope, manual_version, manual_notified_at,
            manual_start_sent_at FROM oauth_tokens
     WHERE token_hash = $1 AND kind = $2 AND NOT revoked AND NOT suspended
       AND expires_at > now()`,
    [sha256hex(token), kind],
  );
  if (!r.rows[0]) return undefined;
  // Urgency-routing input ("agent seen in the last hour"): stamp last_used_at,
  // throttled to one write per 5 minutes per token, off the request path.
  void getPool()
    .query(
      `UPDATE oauth_tokens SET last_used_at = now()
       WHERE token_hash = $1
         AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
      [sha256hex(token)],
    )
    .catch(() => {});
  return {
    accountId: r.rows[0].account_id,
    clientId: r.rows[0].client_id ?? null,
    scope: r.rows[0].scope,
    tokenHash: sha256hex(token),
    manualVersion: r.rows[0].manual_version ?? null,
    manualNotifiedAt: r.rows[0].manual_notified_at ?? null,
    manualStartSentAt: r.rows[0].manual_start_sent_at ?? null,
  };
}

/**
 * Mark that this session has the manual's first page: either it was handed to
 * it on a tool answer, or it called read_manual and fetched the page itself.
 *
 * Written once per session and never unwound. The connect page has carried the
 * instruction to read the manual since version 54 and a live session on
 * 19 September never did — the clients that truncate server instructions, and
 * the agent-key clients whose harness sends no initialize at all, never see it.
 * This is the second place it appears, and there is no third.
 */
export async function recordManualStartSent(tokenHash: string): Promise<void> {
  await getPool().query(
    `UPDATE oauth_tokens SET manual_start_sent_at = now()
      WHERE token_hash = $1 AND manual_start_sent_at IS NULL`,
    [tokenHash],
  );
}

/**
 * Stamp the manual version a session has been served. Called once at
 * initialize, and again on the sweep that delivers a change — the only two
 * moments a session's reading of the manual moves.
 */
export async function recordManualVersion(tokenHash: string, version: number): Promise<void> {
  await getPool().query(
    `UPDATE oauth_tokens SET manual_version = $2, manual_notified_at = NULL WHERE token_hash = $1`,
    [tokenHash, version],
  );
}

/** Mark the first sweep that carried a manual update to this token. */
export async function recordManualNotified(tokenHash: string): Promise<void> {
  await getPool().query(
    `UPDATE oauth_tokens SET manual_notified_at = now() WHERE token_hash = $1 AND manual_notified_at IS NULL`,
    [tokenHash],
  );
}

export function unauthorized(cfg: Config, reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${cfg.publicOrigin}/.well-known/oauth-protected-resource"`,
    )
    .send({ error: 'invalid_token', error_description: 'A valid access token is required.' });
}

export function registerOAuthRoutes(app: FastifyInstance, cfg: Config): void {
  const issuer = cfg.publicOrigin;

  // ---- RFC 8414 authorization-server metadata --------------------------------
  const asMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['switchboard'],
  };
  app.get('/.well-known/oauth-authorization-server', async () => asMetadata);

  // ---- RFC 9728 protected-resource metadata ----------------------------------
  app.get('/.well-known/oauth-protected-resource', async () => ({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ['switchboard'],
    bearer_methods_supported: ['header'],
  }));
  app.get('/.well-known/oauth-protected-resource/mcp', async () => ({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ['switchboard'],
    bearer_methods_supported: ['header'],
  }));

  // ---- RFC 7591 dynamic client registration ----------------------------------
  app.post('/oauth/register', async (req, reply) => {
    if (!rateLimitBypassed(req.headers as Record<string, unknown>) && clientRegistrationLimiter.limited(req.ip)) {
      req.log.warn({ ip: req.ip }, 'oauth-register: per-IP rate limit hit');
      return reply.code(429).send({ error: 'rate_limited', error_description: 'too many registrations from this address; try again later' });
    }
    const body: any = req.body ?? {};
    const uris: unknown = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string')) {
      return reply.code(400).send({
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris (non-empty array of strings) is required',
      });
    }
    for (const u of uris as string[]) {
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        return reply
          .code(400)
          .send({ error: 'invalid_redirect_uri', error_description: `unparseable: ${u}` });
      }
      // Two schemes and no others. https anywhere, and plain http on the
      // loopback address for a CLI listening on the person's own machine.
      // Anything else — a custom scheme, a javascript: or data: URL — is a
      // place this switchboard will not send an authorization code, because
      // it cannot tell who would be listening at the other end of it.
      const isLoopback =
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '[::1]' ||
        parsed.hostname === '::1';
      const allowed = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback);
      if (!allowed) {
        return reply.code(400).send({
          error: 'invalid_redirect_uri',
          error_description:
            'redirect URIs must be https, or http on the loopback address',
        });
      }
    }
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : 'MCP client';
    const r = await getPool().query(
      `INSERT INTO oauth_clients (client_name, redirect_uris, token_endpoint_auth_method)
       VALUES ($1,$2,'none') RETURNING client_id, created_at`,
      [name, JSON.stringify(uris)],
    );
    return reply.code(201).send({
      client_id: r.rows[0].client_id,
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(new Date(r.rows[0].created_at).getTime() / 1000),
    });
  });

  // ---- Authorization endpoint -------------------------------------------------
  const validateAuthzRequest = async (q: any) => validateAuthorizeRequest(q);

  // 0.D: the human-facing login/consent moved to the counter hostname. The
  // authorize endpoint here only validates the request and hands the human
  // over — the PIN and passkey NEVER transit the agent hostname.
  app.get('/oauth/authorize', async (req, reply) => {
    if (cfg.registrationMode === 'closed') {
      // Prod: registration is CLOSED until launch. Clean page, no bypass.
      return reply.code(200).type('text/html').send(registrationClosedPage());
    }
    const q: any = req.query ?? {};
    const v = await validateAuthzRequest(q);
    if (v.error) {
      return reply.code(400).type('text/plain').send(`invalid authorization request: ${v.error}`);
    }
    const target = new URL('/authorize', cfg.counterOrigin);
    for (const k of [
      'client_id',
      'redirect_uri',
      'response_type',
      'code_challenge',
      'code_challenge_method',
      'scope',
      'state',
      'resource',
    ]) {
      if (typeof q[k] === 'string' && q[k]) target.searchParams.set(k, q[k]);
    }
    return reply.redirect(target.toString(), 302);
  });

  // ---- Userinfo: the caller's own opaque account id ---------------------------
  app.get('/oauth/userinfo', async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth) return unauthorized(cfg, reply);
    return { account_id: auth.accountId, scope: auth.scope };
  });

  // ---- Token endpoint ---------------------------------------------------------
  // manualVersion carries across a rotation: an hourly refresh is the same
  // agent in the same session, and it does not send initialize again, so
  // without this every refresh would look like a session that has read nothing.
  // The first-page mark carries across for exactly the same reason: an agent
  // that has read the manual should not be handed it again every hour.
  const issueTokens = async (
    accountId: string,
    clientId: string,
    scope: string,
    manualVersion: number | null = null,
    manualStartSentAt: Date | string | null = null,
    // The family this pair belongs to. A code exchange starts one; a refresh
    // carries the one it was handed, so the whole chain from one press stays
    // killable in a single statement and ages from the press.
    family: { id: string; startedAt: Date | string } = { id: randomUUID(), startedAt: new Date() },
  ) => {
    const access = `osb_at_${b64url(randomBytes(32))}`;
    const refresh = `osb_rt_${b64url(randomBytes(32))}`;
    await getPool().query(
      `INSERT INTO oauth_tokens (token_hash, kind, account_id, client_id, scope, manual_version, family_id, family_started_at, manual_start_sent_at, expires_at)
       VALUES ($1,'access',$3,$4,$5,$6,$7,$8,$9, now() + interval '${ACCESS_TTL_S} seconds'),
              ($2,'refresh',$3,$4,$5,$6,$7,$8,$9, now() + interval '${REFRESH_TTL_S} seconds')`,
      [
        sha256hex(access),
        sha256hex(refresh),
        accountId,
        clientId,
        scope,
        manualVersion,
        family.id,
        family.startedAt,
        manualStartSentAt,
      ],
    );
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope,
    };
  };

  app.post('/oauth/token', async (req, reply) => {
    const b: any = req.body ?? {};
    if (b.grant_type === 'authorization_code') {
      if (typeof b.code !== 'string' || typeof b.code_verifier !== 'string') {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      if (!VERIFIER_RE.test(b.code_verifier)) {
        req.log.warn({ why: 'malformed-verifier' }, 'token exchange refused');
        return reply.code(400).send({
          error: 'invalid_request',
          error_description: 'code_verifier must be 43-128 characters from [A-Za-z0-9._~-]',
        });
      }
      // Single use, decided by the database rather than by this code reading a
      // row and then writing it. Two exchanges of the same code arriving at
      // once used both to pass the read before either wrote; whoever wins this
      // UPDATE gets the row and the loser gets nothing back.
      const r = await getPool().query(
        `UPDATE oauth_codes SET used = true
          WHERE code_hash = $1 AND NOT used AND expires_at > now()
        RETURNING *`,
        [sha256hex(b.code)],
      );
      const row = r.rows[0];
      if (!row) {
        req.log.warn({ why: 'code-unusable' }, 'token exchange refused');
        return reply
          .code(400)
          .send({ error: 'invalid_grant', error_description: 'code-unusable' });
      }
      // From here the code is spent whatever happens next. That is the point:
      // a mismatched client, redirect or verifier is somebody presenting a
      // code that is not theirs, and it must not be presentable again.
      if (b.client_id !== row.client_id || b.redirect_uri !== row.redirect_uri) {
        const why = b.client_id !== row.client_id ? 'client-mismatch' : 'redirect-uri-mismatch';
        req.log.warn({ why }, 'token exchange refused');
        return reply.code(400).send({ error: 'invalid_grant', error_description: why });
      }
      const challenge = b64url(createHash('sha256').update(b.code_verifier).digest());
      if (!sameSecret(challenge, String(row.code_challenge))) {
        req.log.warn({ why: 'pkce-mismatch' }, 'token exchange refused');
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      return reply.send(await issueTokens(row.account_id, row.client_id, row.scope));
    }
    if (b.grant_type === 'refresh_token') {
      if (typeof b.refresh_token !== 'string') return reply.code(400).send({ error: 'invalid_request' });
      const hash = sha256hex(b.refresh_token);
      // The row is read WITHOUT the revoked filter, because a revoked refresh
      // token being presented is the thing worth knowing about.
      const r = await getPool().query(
        `SELECT * FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh'`,
        [hash],
      );
      const row = r.rows[0];
      const refuse = (why: string) => {
        req.log.warn({ why }, 'refresh refused');
        return reply.code(400).send({ error: 'invalid_grant', error_description: why });
      };
      if (!row) return refuse('unknown-refresh-token');
      /** End every token descended from the same authorization. */
      const killFamily = async () => {
        if (row.family_id) {
          await getPool().query(
            `UPDATE oauth_tokens SET revoked = true WHERE family_id = $1 AND NOT revoked`,
            [row.family_id],
          );
        } else {
          // Minted before families existed: the one token is all there is to
          // reach, and rotated_from is the only thread back.
          await getPool().query(
            `UPDATE oauth_tokens SET revoked = true WHERE token_hash = $1 OR rotated_from = $1`,
            [hash],
          );
        }
      };
      // REUSE. This token was rotated already, so either the agent retried
      // after an answer it never received, or somebody else has a copy. The
      // switchboard cannot tell the two apart and must assume the second: the
      // whole family dies and the person authorises again.
      if (row.revoked) {
        await killFamily();
        req.log.warn(
          { why: 'refresh-reuse', account_id: row.account_id, client_id: row.client_id },
          'a rotated refresh token was presented again; the family is revoked',
        );
        return reply
          .code(400)
          .send({ error: 'invalid_grant', error_description: 'refresh-token-reused' });
      }
      if (row.suspended) return refuse('token-suspended');
      if (new Date(row.expires_at) <= new Date()) return refuse('refresh-token-expired');
      if (b.client_id && b.client_id !== row.client_id) return refuse('client-mismatch');
      // THE END OF THE GRANT. Rotation on its own never expires: an agent
      // refreshing every hour would hold a live credential for ever off one
      // press. The family dies ninety days after that press.
      const startedAt = row.family_started_at ? new Date(row.family_started_at) : null;
      if (startedAt && Date.now() - startedAt.getTime() > FAMILY_MAX_AGE_S * 1000) {
        await killFamily();
        return refuse('authorization-expired');
      }
      // A stopped account gets no new keys. Suspending flips `suspended` on
      // every token it can see; this is the floor under it, for a token minted
      // in the same second or a row the update missed. Refusing here rather
      // than rotating means a suspension ends an agent's access within the
      // access token's own hour.
      if (await isSuspended(row.account_id)) return refuse('account-suspended');
      // Rotate: revoke the old refresh token, issue a fresh pair in the same
      // family, ageing from the same press.
      await getPool().query('UPDATE oauth_tokens SET revoked = true WHERE token_hash = $1', [hash]);
      const tokens = await issueTokens(
        row.account_id,
        row.client_id,
        row.scope,
        row.manual_version ?? null,
        row.manual_start_sent_at ?? null,
        {
          id: row.family_id ?? randomUUID(),
          startedAt: row.family_started_at ?? new Date(),
        },
      );
      await getPool().query(
        `UPDATE oauth_tokens SET rotated_from = $1 WHERE token_hash = $2`,
        [hash, sha256hex(tokens.refresh_token)],
      );
      return reply.send(tokens);
    }
    return reply.code(400).send({ error: 'unsupported_grant_type' });
  });
}

export { randomUUID };

/** Validate an authorization request (client, redirect_uri, PKCE). Shared by
 *  the /oauth/authorize hand-off and the counter's authorize page. */
export async function validateAuthorizeRequest(
  q: any,
): Promise<{ error?: string; client?: any }> {
  const clientRow = await getPool()
    .query('SELECT * FROM oauth_clients WHERE client_id = $1', [q.client_id])
    .catch(() => ({ rows: [] as any[] }));
  const client = clientRow.rows[0];
  if (!client) {
    // The app is presenting a registration this switchboard has no record of:
    // a client registered against a different deployment, or one whose record
    // is gone (a dev wipe does exactly this). A person reading it needs the
    // remedy rather than the word for what is missing.
    return {
      error:
        'this app is not registered with the switchboard. Remove the OpenSwitchboard connection in your assistant and add it again, which registers it afresh, then authorise from there.',
    };
  }
  const uris: string[] = client.redirect_uris;
  if (typeof q.redirect_uri !== 'string' || !uris.includes(q.redirect_uri)) {
    return { error: 'redirect_uri is not registered for this client' };
  }
  if (q.response_type !== 'code') return { error: 'response_type must be code', client };
  if (typeof q.code_challenge !== 'string' || q.code_challenge.length < 43) {
    return { error: 'PKCE code_challenge is required', client };
  }
  if (q.code_challenge_method !== 'S256') {
    return { error: 'code_challenge_method must be S256', client };
  }
  return { client };
}

/** Mint an authorization code for an approved authorize request (counter). */
export async function createAuthCode(input: {
  clientId: string;
  accountId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
}): Promise<string> {
  const code = `osb_ac_${b64url(randomBytes(32))}`;
  await getPool().query(
    `INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, scope, resource, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '${CODE_TTL_S} seconds')`,
    [
      sha256hex(code),
      input.clientId,
      input.accountId,
      input.redirectUri,
      input.codeChallenge,
      input.scope || 'switchboard',
      input.resource || null,
    ],
  );
  return code;
}
