/**
 * OAuth 2.1 authorization server (per the MCP authorization spec):
 * authorization-code + PKCE (S256, mandatory), dynamic client registration
 * (RFC 7591), refresh tokens (rotated), RFC 8414 + RFC 9728 metadata.
 * Tokens are opaque and stored as sha256 hashes, bound to one human account.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../db.js';
import { findAccountByEmail, verifyLoginCode } from '../domain/accounts.js';
import { loginPage, registrationClosedPage } from './pages.js';
import type { Config } from '../config.js';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');

const ACCESS_TTL_S = 3600; // 1h
const REFRESH_TTL_S = 30 * 24 * 3600; // 30d
const CODE_TTL_S = 600; // 10m

export interface AuthContext {
  accountId: string;
  clientId: string;
  scope: string;
}

/** Resolve a Bearer token to an account. Returns undefined when invalid. */
export async function authenticate(req: FastifyRequest): Promise<AuthContext | undefined> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return undefined;
  const token = h.slice(7).trim();
  if (!token.startsWith('osb_at_')) return undefined;
  const r = await getPool().query(
    `SELECT account_id, client_id, scope FROM oauth_tokens
     WHERE token_hash = $1 AND kind = 'access' AND NOT revoked AND expires_at > now()`,
    [sha256hex(token)],
  );
  if (!r.rows[0]) return undefined;
  return {
    accountId: r.rows[0].account_id,
    clientId: r.rows[0].client_id,
    scope: r.rows[0].scope,
  };
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
      const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
      if (parsed.protocol === 'http:' && !isLoopback) {
        return reply.code(400).send({
          error: 'invalid_redirect_uri',
          error_description: 'http redirect URIs are allowed for loopback only',
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
  const validateAuthzRequest = async (q: any) => {
    const clientRow = await getPool().query(
      'SELECT * FROM oauth_clients WHERE client_id = $1',
      [q.client_id],
    ).catch(() => ({ rows: [] as any[] }));
    const client = clientRow.rows[0];
    if (!client) return { error: 'unknown client_id' };
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
  };

  app.get('/oauth/authorize', async (req, reply) => {
    if (cfg.registrationMode === 'closed') {
      // Prod, phase 0.C: registration is CLOSED. Clean page, no bypass.
      return reply.code(200).type('text/html').send(registrationClosedPage());
    }
    const q: any = req.query ?? {};
    const v = await validateAuthzRequest(q);
    if (v.error) {
      return reply.code(400).type('text/plain').send(`invalid authorization request: ${v.error}`);
    }
    const hidden: Record<string, string> = {
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      response_type: 'code',
      code_challenge: q.code_challenge,
      code_challenge_method: 'S256',
      scope: typeof q.scope === 'string' ? q.scope : 'switchboard',
      state: typeof q.state === 'string' ? q.state : '',
      resource: typeof q.resource === 'string' ? q.resource : '',
    };
    return reply
      .type('text/html')
      .send(loginPage({ clientName: v.client!.client_name, hidden }));
  });

  app.post('/oauth/authorize', async (req, reply) => {
    if (cfg.registrationMode === 'closed') {
      return reply.code(200).type('text/html').send(registrationClosedPage());
    }
    const b: any = req.body ?? {};
    const v = await validateAuthzRequest(b);
    if (v.error) {
      return reply.code(400).type('text/plain').send(`invalid authorization request: ${v.error}`);
    }
    const hidden: Record<string, string> = {
      client_id: b.client_id,
      redirect_uri: b.redirect_uri,
      response_type: 'code',
      code_challenge: b.code_challenge,
      code_challenge_method: 'S256',
      scope: b.scope || 'switchboard',
      state: b.state || '',
      resource: b.resource || '',
    };
    const fail = (msg: string) =>
      reply
        .code(401)
        .type('text/html')
        .send(loginPage({ clientName: v.client!.client_name, hidden, error: msg }));

    const account =
      typeof b.email === 'string' ? await findAccountByEmail(b.email) : undefined;
    if (!account || !account.login_code_hash || typeof b.login_code !== 'string') {
      return fail('Unknown email or access code.');
    }
    if (!verifyLoginCode(b.login_code, account.login_code_hash)) {
      return fail('Unknown email or access code.');
    }
    if (account.status !== 'active') return fail('This account is not active.');

    const code = `osb_ac_${b64url(randomBytes(32))}`;
    await getPool().query(
      `INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, scope, resource, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '${CODE_TTL_S} seconds')`,
      [
        sha256hex(code),
        b.client_id,
        account.id,
        b.redirect_uri,
        b.code_challenge,
        hidden.scope,
        hidden.resource || null,
      ],
    );
    const target = new URL(b.redirect_uri);
    target.searchParams.set('code', code);
    if (hidden.state) target.searchParams.set('state', hidden.state);
    return reply.redirect(target.toString(), 302);
  });

  // ---- Userinfo: the caller's own opaque account id ---------------------------
  app.get('/oauth/userinfo', async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth) return unauthorized(cfg, reply);
    return { account_id: auth.accountId, scope: auth.scope };
  });

  // ---- Token endpoint ---------------------------------------------------------
  const issueTokens = async (accountId: string, clientId: string, scope: string) => {
    const access = `osb_at_${b64url(randomBytes(32))}`;
    const refresh = `osb_rt_${b64url(randomBytes(32))}`;
    await getPool().query(
      `INSERT INTO oauth_tokens (token_hash, kind, account_id, client_id, scope, expires_at)
       VALUES ($1,'access',$3,$4,$5, now() + interval '${ACCESS_TTL_S} seconds'),
              ($2,'refresh',$3,$4,$5, now() + interval '${REFRESH_TTL_S} seconds')`,
      [sha256hex(access), sha256hex(refresh), accountId, clientId, scope],
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
      const r = await getPool().query('SELECT * FROM oauth_codes WHERE code_hash = $1', [
        sha256hex(b.code),
      ]);
      const row = r.rows[0];
      if (!row || row.used || new Date(row.expires_at) < new Date()) {
        return reply.code(400).send({ error: 'invalid_grant' });
      }
      if (b.client_id !== row.client_id || b.redirect_uri !== row.redirect_uri) {
        return reply.code(400).send({ error: 'invalid_grant' });
      }
      const challenge = b64url(createHash('sha256').update(b.code_verifier).digest());
      if (challenge !== row.code_challenge) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      await getPool().query('UPDATE oauth_codes SET used = true WHERE code_hash = $1', [
        sha256hex(b.code),
      ]);
      return reply.send(await issueTokens(row.account_id, row.client_id, row.scope));
    }
    if (b.grant_type === 'refresh_token') {
      if (typeof b.refresh_token !== 'string') return reply.code(400).send({ error: 'invalid_request' });
      const hash = sha256hex(b.refresh_token);
      const r = await getPool().query(
        `SELECT * FROM oauth_tokens WHERE token_hash = $1 AND kind='refresh' AND NOT revoked AND expires_at > now()`,
        [hash],
      );
      const row = r.rows[0];
      if (!row) return reply.code(400).send({ error: 'invalid_grant' });
      if (b.client_id && b.client_id !== row.client_id) {
        return reply.code(400).send({ error: 'invalid_grant' });
      }
      // Rotate: revoke the old refresh token, issue a fresh pair.
      await getPool().query('UPDATE oauth_tokens SET revoked = true WHERE token_hash = $1', [hash]);
      const tokens = await issueTokens(row.account_id, row.client_id, row.scope);
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
