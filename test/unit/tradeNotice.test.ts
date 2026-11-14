/**
 * A TRADE TELLS A HUMAN WHO HEARS BY EMAIL (14 November 2026; review of P2;
 * email/digestEngine.ts notifyTrade, domain/trades.ts enqueueTradeNotice).
 *
 * A trade put to somebody tells them; a trade accepted or turned down tells
 * the person who put it. The ordinary road and every gate on it: the ops job
 * carries ids only, who is told is read off the trade, quiet for match mail
 * turned off, held back for anyone whose assistant brings the news, behind the
 * suppression, complaint and deleted-account gates, one key per trade and
 * moment, and the mail that goes is the one fixed notice with nothing of the
 * trade in it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.toString('utf8').replace(/^enc:/, '')])),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

const sesSend = vi.fn(async (_cmd: any): Promise<any> => ({ MessageId: 'ses-1' }));
vi.mock('../../src/aws.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sesv2: { send: (cmd: any) => sesSend(cmd) },
  sqs: { send: vi.fn(async () => ({})) },
}));

import * as db from '../../src/db.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { notifyTrade } from '../../src/email/digestEngine.js';
import { NEWS_NOTICE_SUBJECT, NOTICE_TEMPLATES, renderYourMove } from '../../src/email/templates.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  sesFrom: 'switchboard@test',
  sesReplyTo: 'switchboard@test',
  sesConfigurationSet: 'cs',
  opsQueueUrl: 'https://sqs.test/ops',
} as unknown as Config;

const ANA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BEPPE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const TRADE = 'dddddddd-4444-4444-8444-dddddddddddd';
const addressOf = (accountId: string) => `${accountId}@example.test`;

interface World {
  hearsVia: Record<string, 'email' | 'assistant'>;
  freqMatches: string;
  blind: boolean;
  status: string;
  complaint: boolean;
  suppressed: boolean;
  trade: { state: string } | null;
  sends: Map<string, { template: string; status: string; account: string }>;
}
let world: World;

function fakePool() {
  const query = async (sql: string, params: any[] = []) => {
    const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
    if (/INSERT INTO email_sends/.test(sql)) {
      const had = world.sends.get(params[0]);
      if (had && had.status !== 'failed') return rows([]);
      world.sends.set(params[0], { template: params[3], status: params[6], account: params[1] });
      return rows([{ id: 'send' }]);
    }
    if (/UPDATE email_sends/.test(sql)) {
      const row = world.sends.get(params[0]);
      if (row) row.status = params[1];
      return rows([]);
    }
    if (/FROM email_suppressions/.test(sql)) return rows(world.suppressed ? [{ reason: 'bounce' }] : []);
    if (/SELECT email_unreachable_at/.test(sql)) {
      return rows([{ email_unreachable_at: null, email_complaint_suppressed_at: world.complaint ? new Date() : null, status: world.status }]);
    }
    if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: world.hearsVia[params[0]] ?? 'email' }]);
    if (/SELECT blind_mode/.test(sql)) {
      return rows([
        {
          blind_mode: world.blind,
          email_freq_matches: world.freqMatches,
          email_freq_digests: 'weekly',
          email_unreachable_at: null,
          email_complaint_suppressed_at: world.complaint ? new Date() : null,
        },
      ]);
    }
    if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
      return rows([{ id: params[0], status: world.status, data_key_enc: Buffer.from('w'), email_enc: Buffer.from(`enc:${addressOf(params[0])}`) }]);
    }
    if (/FROM trade_proposals t\s+JOIN pairings p/.test(sql)) {
      if (params[0] !== TRADE || !world.trade) return rows([]);
      return rows([
        {
          proposer_account: ANA,
          recipient_account: BEPPE,
          state: world.trade.state,
          match_id: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
          category: 'goods.bicycle.parts',
          account_want: BEPPE,
          account_have: ANA,
          card_want: 'ffffffff-6666-4666-8666-ffffffffffff',
          card_have: 'ffffffff-6666-4666-8666-000000000001',
          swap: false,
        },
      ]);
    }
    if (/SELECT category, kind FROM cards/.test(sql) || /FROM cards WHERE id/.test(sql)) {
      return rows([{ category: 'goods.bicycle.parts', kind: 'brake lever set' }]);
    }
    return rows([]);
  };
  return { query, connect: async () => ({ query, release: () => {} }) } as any;
}

beforeAll(async () => {
  vi.stubGlobal('setTimeout', ((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
});

beforeEach(() => {
  world = {
    hearsVia: {},
    freqMatches: 'immediate',
    blind: false,
    status: 'active',
    complaint: false,
    suppressed: false,
    trade: { state: 'open' },
    sends: new Map(),
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sesSend.mockClear();
});

const mails = () =>
  sesSend.mock.calls.map(([cmd]: any[]) => ({
    to: cmd.input.Destination.ToAddresses[0] as string,
    subject: cmd.input.Content.Simple.Subject.Data as string,
    text: cmd.input.Content.Simple.Body.Text.Data as string,
    html: cmd.input.Content.Simple.Body.Html.Data as string,
  }));

describe('who is told, and in what words', () => {
  it('a trade sent tells the person it was put to, with the one fixed notice', async () => {
    await notifyTrade(cfg, TRADE, 'arrived');
    expect(mails()).toHaveLength(1);
    expect(mails()[0].to).toBe(addressOf(BEPPE));
    expect(mails()[0].subject).toBe(NEWS_NOTICE_SUBJECT);
    // Nothing of the trade crosses: no thing, no quantity, no word of theirs.
    expect(mails()[0].text).not.toMatch(/brake|lever|trade/i);
    expect(world.sends.get(`trade:${TRADE}:arrived`)).toMatchObject({ template: 'your-move', account: BEPPE });
  });

  it('an accepted trade tells the person who put it, under its own key, and a stale job tells nobody', async () => {
    world.trade = { state: 'accepted' };
    await notifyTrade(cfg, TRADE, 'accepted');
    // A 'declined' job for a trade that was in fact accepted says nothing.
    await notifyTrade(cfg, TRADE, 'declined');
    expect(mails().map((m) => m.to)).toEqual([addressOf(ANA)]);
    expect(world.sends.has(`trade:${TRADE}:accepted`)).toBe(true);
    expect(world.sends.has(`trade:${TRADE}:declined`)).toBe(false);
  });

  it('a declined trade tells the proposer', async () => {
    world.trade = { state: 'declined' };
    await notifyTrade(cfg, TRADE, 'declined');
    expect(mails().map((m) => m.to)).toEqual([addressOf(ANA)]);
  });

  it('once per trade and moment: a redelivered job finds the key spent', async () => {
    await notifyTrade(cfg, TRADE, 'arrived');
    await notifyTrade(cfg, TRADE, 'arrived');
    expect(mails()).toHaveLength(1);
  });

  it('says only what the trade itself still says happened', async () => {
    world.trade = { state: 'withdrawn' };
    await notifyTrade(cfg, TRADE, 'arrived');
    await notifyTrade(cfg, TRADE, 'accepted');
    world.trade = { state: 'awaiting-send' };
    await notifyTrade(cfg, TRADE, 'arrived');
    world.trade = null;
    await notifyTrade(cfg, TRADE, 'arrived');
    expect(mails()).toHaveLength(0);
  });

  it('ignores a job that names no trade or no moment', async () => {
    await notifyTrade(cfg, 'not-an-id', 'arrived');
    await notifyTrade(cfg, TRADE, 'sold');
    expect(mails()).toHaveLength(0);
  });
});

describe('every gate on the ordinary road', () => {
  it('holds it back for anyone whose assistant brings them the news', async () => {
    world.hearsVia[BEPPE] = 'assistant';
    await notifyTrade(cfg, TRADE, 'arrived');
    expect(mails()).toHaveLength(0);
    expect(world.sends.get(`trade:${TRADE}:arrived`)?.status).toBe('suppressed');
  });

  it('is quiet for an account that turned match mail off', async () => {
    world.freqMatches = 'off';
    await notifyTrade(cfg, TRADE, 'arrived');
    expect(mails()).toHaveLength(0);
  });

  it('sends nothing to a deleted account, a complaint or a suppressed address', async () => {
    for (const set of [
      () => (world.status = 'deleted'),
      () => (world.complaint = true),
      () => (world.suppressed = true),
    ]) {
      world.status = 'active';
      world.complaint = false;
      world.suppressed = false;
      world.sends.clear();
      set();
      await notifyTrade(cfg, TRADE, 'arrived');
    }
    expect(mails()).toHaveLength(0);
  });

  it('is a notice template, and its own words keep the register', () => {
    expect(NOTICE_TEMPLATES.has('your-move')).toBe(true);
    for (const step of ['trade', 'trade-news'] as const) {
      for (const blind of [false, true]) {
        const c = renderYourMove({ categoryLabel: 'goods.bicycle.parts', blind, step, side: 'have' }, { settingsUrl: 'https://my.test/settings' });
        expect(lintHumanCopy(c.text)).toEqual([]);
        expect(lintHumanCopy(c.html)).toEqual([]);
        expect(c.text).not.toMatch(/https?:\/\/(?!my\.test\/settings)/);
      }
    }
  });
});
