/**
 * Agent-key issuance sends a security notice (0.E). The route mints the key,
 * then mails the account holder through the notifyBestEffort pattern: the
 * notice names the key, and a failed send never breaks the issuance itself.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeConsentEvent: vi.fn(async () => 'consent/key'),
}));

vi.mock('../../src/domain/counterOps.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  accountEmail: vi.fn(async () => 'human@example.test'),
}));

vi.mock('../../src/counter/email.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendSecurityNoticeEmail: vi.fn(async () => ({ outcome: 'sent' })),
}));

import { buildApp } from '../../src/app.js';
import { accountEmail } from '../../src/domain/counterOps.js';
import { sendSecurityNoticeEmail } from '../../src/counter/email.js';
import * as db from '../../src/db.js';
import type { Config } from '../../src/config.js';

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
  settlementFeePercent: 0,
};

const ACCOUNT = 'acct-agent-key-email';

// Enough of PostgreSQL for this one path: an elevated signed-in session, and
// the oauth_tokens statements createAgentKey runs.
let tokenRows: any[] = [];
const fakePool = {
  query: async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id, account_id, pin_ok_until, oauth_ctx FROM counter_sessions')) {
      return {
        rows: [
          {
            id: 'sess-1',
            account_id: ACCOUNT,
            pin_ok_until: new Date(Date.now() + 600_000), // elevated: no PIN ceremony
            oauth_ctx: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (s.startsWith('INSERT INTO oauth_tokens')) {
      const row = {
        key_id: '00000000-0000-4000-8000-000000000001',
        name: params[2],
        created_at: new Date(),
        last_used_at: null,
        expires_at: new Date(Date.now() + 90 * 86_400_000),
      };
      tokenRows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('SELECT key_id, name, created_at')) {
      return { rows: tokenRows, rowCount: tokenRows.length };
    }
    return { rows: [], rowCount: 0 };
  },
} as any;

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp(cfg);
  await app.ready();
});

beforeEach(() => {
  tokenRows = [];
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool);
  vi.mocked(accountEmail).mockClear();
  vi.mocked(sendSecurityNoticeEmail).mockClear();
  vi.mocked(sendSecurityNoticeEmail).mockResolvedValue({ outcome: 'sent' } as any);
});

const createKey = (name = 'the laptop agent') =>
  app.inject({
    method: 'POST',
    url: '/counter/agent-keys',
    headers: {
      host: 'counter.test',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: 'osb_counter=osb_cs_test-session',
    },
    payload: new URLSearchParams({ name }).toString(),
  });

describe('POST /counter/agent-keys: the security notice', () => {
  it('mints the key and mails an agent-key-created notice with the key name', async () => {
    const res = await createKey();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('osb_ak_');
    expect(vi.mocked(accountEmail)).toHaveBeenCalledWith(ACCOUNT, 'security-notice');
    expect(vi.mocked(sendSecurityNoticeEmail)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSecurityNoticeEmail)).toHaveBeenCalledWith(
      cfg,
      'human@example.test',
      ACCOUNT,
      'agent-key-created',
      'the laptop agent',
    );
  });

  it('a failed send never breaks the issuance (best effort)', async () => {
    vi.mocked(sendSecurityNoticeEmail).mockRejectedValueOnce(new Error('SES down'));
    const res = await createKey();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('osb_ak_');
    expect(tokenRows).toHaveLength(1);
  });

  it('an account with no reachable email gets the key and no send is attempted', async () => {
    vi.mocked(accountEmail).mockResolvedValueOnce(undefined);
    const res = await createKey();
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(sendSecurityNoticeEmail)).not.toHaveBeenCalled();
  });
});
