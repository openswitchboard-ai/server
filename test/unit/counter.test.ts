/**
 * Counter unit tests, including the STRUCTURAL route-isolation matrix:
 *  - an MCP bearer token is rejected (403) on EVERY registered /counter
 *    route, enumerated from the live route table — before any DB access;
 *  - a counter session cookie is worthless on /mcp (401).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { buildApp } from '../../src/app.js';
import { COUNTER_ROUTE_TABLE } from '../../src/counter/routes.js';
import { CONSENT_STATEMENT } from '../../src/counter/pages.js';
import { lockoutMinutes, pinFormatOk, PIN_MAX_ATTEMPTS } from '../../src/counter/pin.js';
import { bindingString, signLink } from '../../src/counter/links.js';
import type { Config } from '../../src/config.js';
import type { FastifyInstance } from 'fastify';

const cfg: Config = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'https://mcp.test',
  counterOrigin: 'https://counter.test',
  sesFrom: 'OpenSwitchboard <board@openswitchboard.ai>',
  sesReplyTo: 'info@openswitchboard.ai',
  sesConfigurationSet: 'unused',
  emailEventsQueueUrl: 'http://unused',
  dbSecretArn: 'unused',
  screeningQueueUrl: 'http://unused',
  matchingQueueUrl: 'http://unused',
  opsQueueUrl: 'http://unused',
  consentLogBucket: 'unused',
  identityKeyArn: 'unused',
  bedrockModelId: 'unused',
  registrationMode: 'dev-bootstrap',
  region: 'us-east-1',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
};

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp(cfg);
  await app.ready();
});

const fillParams = (url: string) =>
  url
    .replace(':token', 'sometoken')
    .replace(':id', '00000000-0000-0000-0000-000000000000');

describe('route isolation: agent credentials x counter routes', () => {
  it('the counter route class is non-trivially enumerated', () => {
    expect(COUNTER_ROUTE_TABLE.length).toBeGreaterThanOrEqual(25);
    const urls = COUNTER_ROUTE_TABLE.map((r) => `${r.method} ${r.url}`);
    for (const must of [
      'GET /counter',
      'POST /counter/register',
      'POST /counter/verify',
      'POST /counter/pin/set',
      'POST /counter/approve',
      'GET /counter/ledger',
      'POST /counter/kill',
      'POST /counter/authorize',
      'GET /counter/a/:token',
    ]) {
      expect(urls, `missing route ${must}`).toContain(must);
    }
  });

  it('an MCP bearer token gets 403 on EVERY /counter route', async () => {
    for (const r of COUNTER_ROUTE_TABLE) {
      const res = await app.inject({
        method: r.method as any,
        url: fillParams(r.url),
        headers: {
          host: 'counter.test',
          authorization: 'Bearer osb_at_agent-token-should-never-work-here',
        },
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(res.json().error, `${r.method} ${r.url}`).toBe('agent_credentials_rejected');
    }
  });

  it('a counter session cookie gets 401 on /mcp', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'mcp.test',
        cookie: 'osb_counter=osb_cs_some-session-value',
        'content-type': 'application/json',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('oauth-protected-resource');
  });

  it('/mcp is not served on the counter hostname', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { host: 'counter.test', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('/counter is not served on the MCP hostname', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/counter',
      headers: { host: 'mcp.test' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PIN policy', () => {
  it('requires 6-12 digits', () => {
    expect(pinFormatOk('123456')).toBe(true);
    expect(pinFormatOk('123456789012')).toBe(true);
    expect(pinFormatOk('12345')).toBe(false);
    expect(pinFormatOk('abcdef')).toBe(false);
    expect(pinFormatOk('12 3456')).toBe(false);
  });
  it('locks after 5 tries with exponential backoff, capped at 60 minutes', () => {
    expect(PIN_MAX_ATTEMPTS).toBe(5);
    expect(lockoutMinutes(5)).toBe(1);
    expect(lockoutMinutes(6)).toBe(2);
    expect(lockoutMinutes(7)).toBe(4);
    expect(lockoutMinutes(20)).toBe(60);
  });
});

describe('approval link signing', () => {
  const key = Buffer.from('a'.repeat(64), 'hex');
  const row = {
    id: '11111111-1111-1111-1111-111111111111',
    account_id: 'acct-1',
    action: 'offer-accept',
    ref_id: 'offer-1',
    amount: 620,
    ccy: 'AUD',
    counterparty_account: 'acct-2',
  };
  it('binds {account, action, amount, counterparty}: any change breaks the MAC', () => {
    const token = signLink(row, key);
    expect(token.startsWith(row.id + '.')).toBe(true);
    for (const tampered of [
      { ...row, account_id: 'acct-9' },
      { ...row, action: 'stage3-disclosure' },
      { ...row, amount: 9999 },
      { ...row, counterparty_account: 'acct-9' },
      { ...row, ref_id: 'offer-2' },
    ]) {
      expect(signLink(tampered as any, key)).not.toBe(token);
    }
  });
  it('binding string is stable and complete', () => {
    expect(bindingString(row as any)).toBe(
      '11111111-1111-1111-1111-111111111111|acct-1|offer-accept|offer-1|620|AUD|acct-2',
    );
  });
});

describe('consent statement', () => {
  it('is the exact agreed text', () => {
    expect(CONSENT_STATEMENT).toBe(
      'My agent may store wants & haves as cards on my behalf. I can see, edit, or withdraw everything at the counter.',
    );
  });
});
