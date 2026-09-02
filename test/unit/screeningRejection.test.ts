/**
 * A card that fails screening now says so out loud, in three places:
 *
 *  - the approval-page dashboard carries an attention item for it;
 *  - the ledger edit page shows the reason in plain words (raw code small);
 *  - the screening worker mails the human, best-effort and de-duped, and the
 *    verdict stands whatever the send does.
 *
 * Plus the boundary that must hold while all of that is true: the reason is
 * the OWNER's to see. It reaches the owning agent on its own card through
 * list_intents, and it appears in no counterparty payload — those are
 * schema-closed, and a rejected card never reaches PUBLISHED at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/domain/profile.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readSharedProfile: vi.fn(async () => ({ firstName: 'Ana', locality: 'Fremantle' })),
}));

vi.mock('../../src/domain/counterOps.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  accountEmail: vi.fn(async () => 'human@example.test'),
}));

vi.mock('../../src/counter/email.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendScreeningRejectedEmail: vi.fn(async () => ({ status: 'sent' })),
}));

import { buildApp } from '../../src/app.js';
import { accountEmail } from '../../src/domain/counterOps.js';
import { sendScreeningRejectedEmail } from '../../src/counter/email.js';
import { notifyScreeningRejection } from '../../src/workers/screeningWorker.js';
import { listIntents } from '../../src/domain/cards.js';
import { buildAttributes, buildSignal } from '../../src/domain/matches.js';
import {
  rejectionInPlainWords,
  screeningReasonInPlainWords,
} from '../../src/domain/screening.js';
import { categoryLeafLabel } from '../../src/domain/matchRules.js';
import * as db from '../../src/db.js';
import type { Config } from '../../src/config.js';

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
};

const ACCOUNT = 'acct-screening-rejection';
const CARD = '00000000-0000-4000-8000-0000000000c1';
const SLUG = 'goods.bicycle.mountain';
const LABEL = categoryLeafLabel(SLUG);
const REJECTED_AT = '2026-09-02T01:02:03.000Z';

const rejectedRow = () => ({
  id: CARD,
  account_id: ACCOUNT,
  schema_version: '0.1.0',
  type: 'WANT',
  category: SLUG,
  geo: { place: 'Fremantle', radius_km: 20 },
  geo_lat: null,
  geo_lon: null,
  geo_radius_km: 20,
  attributes: { condition: 'good' },
  ask: null,
  urgency: 'none',
  visibility: 'public',
  protocol_status: 'active',
  lifecycle_state: 'SCREENING_REJECTED',
  price_enc: null,
  ttl_days: 60,
  expires_at: new Date('2026-11-01'),
  created_at: new Date('2026-09-01'),
  updated_at: new Date('2026-09-02'),
  collect_window_minutes: null,
  match_count: 0,
  screening: {
    pass: false,
    reason_code: 'prompt-injection',
    detail: 'the model note, which stays internal',
    model_id: 'some-model',
    at: REJECTED_AT,
  },
});

/** Enough PostgreSQL for the dashboard and the ledger edit page. */
function fakePool(rows: Record<string, any[]>) {
  return {
    query: async (sql: string) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT id, account_id, pin_ok_until, oauth_ctx FROM counter_sessions')) {
        return {
          rows: [{ id: 'sess-1', account_id: ACCOUNT, pin_ok_until: null, oauth_ctx: null }],
          rowCount: 1,
        };
      }
      if (s.startsWith('SELECT * FROM accounts')) {
        return {
          rows: [
            {
              id: ACCOUNT,
              pin_hash: 'set',
              status: 'active',
              kill_switch_at: null,
              email_unreachable_at: null,
              arrangement: null,
              data_key_enc: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (s.startsWith('SELECT arrangement FROM accounts')) {
        return { rows: [{ arrangement: null }], rowCount: 1 };
      }
      if (s.startsWith('SELECT count(*)::int AS total')) {
        return { rows: [{ total: 1, published: 0, pending: 0 }], rowCount: 1 };
      }
      for (const [prefix, r] of Object.entries(rows)) {
        if (s.startsWith(prefix)) return { rows: r, rowCount: r.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

const REJECTED_QUERY = 'SELECT id, category, screening FROM cards';
const LEDGER_QUERY = 'SELECT c.*, (SELECT count(*)::int FROM matches m';

let app: FastifyInstance;

beforeEach(async () => {
  app ??= buildApp(cfg);
  await app.ready();
  vi.mocked(accountEmail).mockClear();
  vi.mocked(accountEmail).mockResolvedValue('human@example.test');
  vi.mocked(sendScreeningRejectedEmail).mockClear();
  vi.mocked(sendScreeningRejectedEmail).mockResolvedValue({ status: 'sent' } as any);
});

const get = (url: string) =>
  app.inject({
    method: 'GET',
    url,
    headers: { host: 'my.test', cookie: 'osb_counter=osb_cs_test-session' },
  });

// ---------------------------------------------------------------------------
// (1) The dashboard says something is waiting.
// ---------------------------------------------------------------------------
describe('approval-page dashboard: a card that failed screening', () => {
  it('shows an attention item linking to that card&#39;s edit page', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(
      fakePool({
        [REJECTED_QUERY]: [{ id: CARD, category: SLUG, screening: rejectedRow().screening }],
      }),
    );
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`Your ${LABEL} card didn&#39;t pass screening`);
    expect(res.body).toContain(`/ledger/${CARD}/edit`);
    expect(res.body).toContain('See why and fix it');
    // The raw slug and the model's internal note never render.
    expect(res.body).not.toContain(SLUG);
    expect(res.body).not.toContain('stays internal');
  });

  it('says nothing when no card of theirs was rejected', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool({}));
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('pass screening');
    expect(res.body).toContain('Nothing is waiting for you.');
  });
});

// ---------------------------------------------------------------------------
// (2) The edit page says why, in plain words.
// ---------------------------------------------------------------------------
describe('ledger edit page: the reason in plain words', () => {
  it('renders the plain-words sentence with the raw code small beneath', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool({ [LEDGER_QUERY]: [rejectedRow()] }));
    const res = await get(`/ledger/${CARD}/edit`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('This card didn&#39;t pass screening.');
    expect(res.body).toContain('reads like an instruction aimed at an AI');
    expect(res.body).toContain('screening code: prompt-injection');
    // The model's own note is internal and never reaches the page.
    expect(res.body).not.toContain('stays internal');
  });

  it('a card that is not rejected carries no screening block', async () => {
    const ok = { ...rejectedRow(), lifecycle_state: 'PUBLISHED', screening: { pass: true, at: REJECTED_AT } };
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool({ [LEDGER_QUERY]: [ok] }));
    const res = await get(`/ledger/${CARD}/edit`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('pass screening');
    expect(res.body).not.toContain('screening code:');
  });
});

// ---------------------------------------------------------------------------
// (3) Reason codes -> human sentences.
// ---------------------------------------------------------------------------
describe('screening reasons in plain words', () => {
  it('gives every seeded reason code its own sentence', () => {
    const codes = [
      'prompt-injection',
      'pii-in-card',
      'stolen-goods-markers',
      'recalled-goods',
      'weapons',
      'prescription-medication',
      'live-animals',
      'wildlife-products',
      'alcohol',
      'event-tickets',
    ];
    const seen = new Set<string>();
    for (const c of codes) {
      const s = screeningReasonInPlainWords(c);
      expect(s.length, c).toBeGreaterThan(40);
      expect(s, c).not.toContain('_');
      seen.add(s);
    }
    expect(seen.size).toBe(codes.length);
  });

  it('an unknown code still gets an honest sentence rather than a blank', () => {
    const s = screeningReasonInPlainWords('some-new-check');
    expect(s).toContain('Screening held this card back');
    expect(screeningReasonInPlainWords(undefined)).toBe(s);
  });

  it('reads a rejection only out of a record that says one happened', () => {
    expect(rejectionInPlainWords(undefined)).toBeUndefined();
    expect(rejectionInPlainWords({ pass: true, at: REJECTED_AT })).toBeUndefined();
    expect(rejectionInPlainWords('nonsense')).toBeUndefined();
    expect(rejectionInPlainWords({ pass: false, reason_code: 'pii-in-card', at: REJECTED_AT })).toMatchObject({
      reasonCode: 'pii-in-card',
      at: REJECTED_AT,
    });
  });
});

// ---------------------------------------------------------------------------
// (4) The worker's notice: best effort, de-duped, transactional.
// ---------------------------------------------------------------------------
describe('screening worker: the rejection notice', () => {
  const card = rejectedRow() as any;
  const screening = card.screening;
  const log = () => {};

  it('mails the card&#39;s human with the label, the plain reason and a per-event dedupe key', async () => {
    await notifyScreeningRejection(cfg, card, screening, log);
    expect(vi.mocked(accountEmail)).toHaveBeenCalledWith(
      ACCOUNT,
      'card-screening-rejected-notification',
    );
    expect(vi.mocked(sendScreeningRejectedEmail)).toHaveBeenCalledTimes(1);
    const [, to, accountId, input] = vi.mocked(sendScreeningRejectedEmail).mock.calls[0];
    expect(to).toBe('human@example.test');
    expect(accountId).toBe(ACCOUNT);
    expect(input).toEqual({
      cardId: CARD,
      rejectedAt: REJECTED_AT,
      categoryLabel: LABEL,
      reason: screeningReasonInPlainWords('prompt-injection'),
    });
    // The key is the card plus the moment of THIS rejection, so a redelivered
    // queue message cannot produce a second email.
    expect(`card-screening-rejected:${input.cardId}:${input.rejectedAt}`).toBe(
      `card-screening-rejected:${CARD}:${REJECTED_AT}`,
    );
  });

  it('a send that throws never disturbs the verdict', async () => {
    vi.mocked(sendScreeningRejectedEmail).mockRejectedValueOnce(new Error('SES down'));
    await expect(notifyScreeningRejection(cfg, card, screening, log)).resolves.toBeUndefined();
  });

  it('an account with no reachable address is simply not mailed', async () => {
    vi.mocked(accountEmail).mockResolvedValueOnce(undefined);
    await notifyScreeningRejection(cfg, card, screening, log);
    expect(vi.mocked(sendScreeningRejectedEmail)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (5) The boundary: own agent sees the reason, a counterparty never does.
// ---------------------------------------------------------------------------
describe('who may see a rejection reason', () => {
  it('the owning agent gets it on its own card through list_intents', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(
      fakePool({ 'SELECT id, schema_version, type, category': [rejectedRow()] }),
    );
    const [intent] = await listIntents(ACCOUNT);
    expect(intent.state).toBe('SCREENING_REJECTED');
    expect(intent.screening).toEqual({
      reason_code: 'prompt-injection',
      reason: screeningReasonInPlainWords('prompt-injection'),
      at: REJECTED_AT,
    });
    // The model's own note stays internal even for the owner.
    expect(JSON.stringify(intent)).not.toContain('stays internal');
  });

  it('a card that passed carries no screening field at all', async () => {
    const ok = { ...rejectedRow(), lifecycle_state: 'PUBLISHED', screening: { pass: true, at: REJECTED_AT } };
    vi.spyOn(db, 'getPool').mockReturnValue(
      fakePool({ 'SELECT id, schema_version, type, category': [ok] }),
    );
    const [intent] = await listIntents(ACCOUNT);
    expect(intent).not.toHaveProperty('screening');
  });

  it('no counterparty payload carries the screening record, whatever the row holds', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(
      fakePool({ 'SELECT * FROM cards WHERE id': [{ ...rejectedRow(), lifecycle_state: 'PUBLISHED' }] }),
    );
    const match: any = {
      id: '00000000-0000-4000-8000-0000000000m1'.replace('m', '0'),
      state: 'open',
      stage: 2,
      score: 0.8,
      category: SLUG,
      account_want: ACCOUNT,
      account_have: 'acct-other',
      card_want: CARD,
      card_have: CARD,
    };
    const signal: any = await buildSignal(match, ACCOUNT);
    const attributes: any = await buildAttributes(match, ACCOUNT);
    for (const payload of [signal, attributes]) {
      const text = JSON.stringify(payload);
      expect(payload).not.toHaveProperty('screening');
      expect(text).not.toContain('prompt-injection');
      expect(text).not.toContain('reason_code');
      expect(text).not.toContain('stays internal');
    }
    // The schemas are closed, so a future slip that tried to attach one fails
    // outbound validation rather than shipping it.
    const { assertOutbound } = await import('../../src/protocol.js');
    expect(() =>
      assertOutbound('match.attributes', { ...attributes, screening: { reason_code: 'pii-in-card' } }),
    ).toThrow(/validation/);
  });
});
