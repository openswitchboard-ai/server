/**
 * The hardening that lives on the app itself rather than in any one route:
 * how far up the X-Forwarded-For chain we trust, the security headers every
 * response carries, the legacy /counter redirect, and what the request log
 * is allowed to say about a URL that carries a credential.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import type { FastifyInstance } from 'fastify';

const cfg: Config = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'https://mcp.test',
  counterOrigin: 'https://my.test',
  legacyCounterHosts: ['counter.test'],
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
  settlementFeePercent: 0,
  settlementFeeFlatMinor: 100,
};

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp(cfg);
  // A window onto what the framework decided the caller's address was. Added
  // here rather than in the service so nothing in production answers on it.
  app.get('/__ip', async (req) => ({ ip: req.ip }));
  await app.ready();
});

describe('trusted proxy hops', () => {
  it('takes the last X-Forwarded-For entry — the one the ALB wrote', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/__ip',
      remoteAddress: '10.0.0.7',
      headers: { host: 'mcp.test', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
    });
    expect(r.json().ip).toBe('2.2.2.2');
  });

  it('a forged chain cannot make the caller anything it likes', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/__ip',
      remoteAddress: '10.0.0.7',
      headers: { host: 'mcp.test', 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 2.2.2.2' },
    });
    expect(r.json().ip).toBe('2.2.2.2');
    expect(r.json().ip).not.toBe('9.9.9.9');
  });

  it('with no forwarding header the socket address stands', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/__ip',
      remoteAddress: '10.0.0.7',
      headers: { host: 'mcp.test' },
    });
    expect(r.json().ip).toBe('10.0.0.7');
  });
});

describe('security headers', () => {
  const common = (h: Record<string, any>) => {
    expect(h['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('no-referrer');
  };

  it('a human page carries them, with a policy that allows what the page uses', async () => {
    const r = await app.inject({ method: 'GET', url: '/login', headers: { host: 'my.test' } });
    expect(r.statusCode).toBe(200);
    common(r.headers as any);
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
    // The browser PUTs photos and evidence straight to a presigned S3 URL.
    expect(csp).toContain("connect-src 'self' https://*.amazonaws.com");
  });

  it('the MCP host is allowed nothing at all, 404s included', async () => {
    const r = await app.inject({ method: 'GET', url: '/nope', headers: { host: 'mcp.test' } });
    expect(r.statusCode).toBe(404);
    common(r.headers as any);
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it('no human page reaches a third-party origin for its type', async () => {
    const r = await app.inject({ method: 'GET', url: '/login', headers: { host: 'my.test' } });
    expect(r.body).not.toContain('fonts.googleapis.com');
    expect(r.body).not.toContain('fonts.gstatic.com');
  });
});
