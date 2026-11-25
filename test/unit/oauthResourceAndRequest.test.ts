import { describe, expect, it } from 'vitest';
import { oauthRequestDigest, resourceIsOurs } from '../../src/auth/oauth.js';

const ORIGIN = 'https://mcp.openswitchboard.ai';

describe('resourceIsOurs (RFC 8707)', () => {
  it('accepts no resource at all', () => {
    for (const r of [undefined, null, '', []]) expect(resourceIsOurs(r, ORIGIN)).toBe(true);
  });
  it('accepts this server, bare or /mcp, with or without a closing slash', () => {
    for (const r of [ORIGIN, `${ORIGIN}/`, `${ORIGIN}/mcp`, `${ORIGIN}/mcp/`, 'https://MCP.openswitchboard.ai/mcp']) {
      expect(resourceIsOurs(r, ORIGIN)).toBe(true);
    }
    expect(resourceIsOurs([`${ORIGIN}/mcp`, ORIGIN], ORIGIN)).toBe(true);
  });
  it('refuses any other service, path, scheme, query or fragment', () => {
    for (const r of [
      'https://api.example.com/mcp',
      'https://mcp.dev.openswitchboard.ai/mcp',
      'https://openswitchboard.ai/mcp',
      'http://mcp.openswitchboard.ai/mcp',
      'https://mcp.openswitchboard.ai:8443/mcp',
      `${ORIGIN}/other`,
      `${ORIGIN}/mcp?x=1`,
      `${ORIGIN}/mcp#f`,
      'https://user@mcp.openswitchboard.ai/mcp',
      'not a url',
      42,
    ]) {
      expect(resourceIsOurs(r, ORIGIN)).toBe(false);
    }
    expect(resourceIsOurs([`${ORIGIN}/mcp`, 'https://api.example.com'], ORIGIN)).toBe(false);
  });
});

describe('oauthRequestDigest', () => {
  const ctx = {
    client_id: 'c-1',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'a'.repeat(43),
    scope: 'switchboard',
    state: 's',
    resource: `${ORIGIN}/mcp`,
  };
  it('is stable for the same request', () => {
    expect(oauthRequestDigest({ ...ctx })).toBe(oauthRequestDigest(ctx));
    expect(oauthRequestDigest(ctx)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes when any part of the request changes', () => {
    for (const k of Object.keys(ctx) as (keyof typeof ctx)[]) {
      expect(oauthRequestDigest({ ...ctx, [k]: ctx[k] + 'x' })).not.toBe(oauthRequestDigest(ctx));
    }
  });
});
