/**
 * Taking a want or a have down: the people it frees are told.
 *
 * The defect this holds shut, found alongside the decline one (run 8, 13
 * September 2026). Taking something down files away every open introduction on
 * it, and each of those people had a slot of their own taken up by it. That
 * slot is freed here, and whoever is next in THEIR line goes live in this same
 * request — but the withdrawal resequenced without the config, so the
 * promotion happened and the summons that tells the promoted human never went
 * out. Somebody went live and nobody told them.
 *
 * The rule: the withdrawal carries the config, so every person promoted behind
 * it is summoned the ordinary way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqsSend = vi.fn(async () => ({}));
vi.mock('../../src/aws.js', () => ({
  sesv2: { send: async () => ({}) },
  sqs: { send: (...a: unknown[]) => sqsSend(...(a as [])) },
}));
vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

import * as db from '../../src/db.js';
import * as cards from '../../src/domain/cards.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
  opsQueueUrl: 'https://sqs.test/ops',
} as unknown as Config;

const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd'; // the one being taken down
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'; // the other person's
const INTRO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const NEXT = '11111111-7777-4777-8777-111111111111'; // waiting behind, on CARD_H

function fakePool() {
  const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
  return {
    query: async (sql: string, params: any[] = []) => {
      if (/SELECT \* FROM cards WHERE id/.test(sql)) {
        return rows([{ id: CARD_W, account_id: ANA, lifecycle_state: 'PUBLISHED' }]);
      }
      // The one open introduction on the thing being taken down.
      if (/UPDATE matches\s+SET state = 'archived'/.test(sql)) return rows([{ id: INTRO }]);
      if (/SELECT card_want, card_have FROM matches/.test(sql)) {
        return rows([{ card_want: CARD_W, card_have: CARD_H }]);
      }
      // Nobody is left in line on the withdrawn one; one person is waiting on
      // the other side's, and that is the slot the withdrawal just freed.
      if (/FROM matches m\s+JOIN cards own/.test(sql)) {
        if (String(params[0]) !== CARD_H) return rows([]);
        return rows([
          {
            id: NEXT,
            live: false,
            limits_overlap: true,
            created_at: new Date(),
            other_card: CARD_W,
            own_urgency: null,
            own_slots: 1,
            own_sale: null,
            own_gather_open: false,
            other_urgency: null,
            own_lat: null,
            own_lon: null,
            other_lat: null,
            other_lon: null,
            reliability: 0.5,
          },
        ]);
      }
      if (/FROM cards c WHERE c\.id/.test(sql)) {
        return rows([{ slots: 1, sale: null, gather_open: false, live_now: 0 }]);
      }
      if (/UPDATE matches SET live = true/.test(sql)) return rows([{ id: params[0] }]);
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  sqsSend.mockClear();
  vi.spyOn(db, 'getPool').mockImplementation(() => fakePool());
});

const bodies = () =>
  sqsSend.mock.calls.map((c: any) => JSON.parse(c[0].input.MessageBody as string));

describe('taking something down and the line behind it', () => {
  it('summons the person whose own turn the withdrawal just started', async () => {
    const r = await cards.withdrawIntent(ANA, CARD_W, cfg);
    expect(r).toMatchObject({ state: 'WITHDRAWN', introductions_archived: 1 });
    expect(bodies()).toContainEqual({ op: 'match-notify', match_id: NEXT });
  });

  it('still promotes when there is nowhere to send the summons', async () => {
    // No ops queue: the promotion stands and nothing throws, which is the
    // existing best-effort rule and not a licence to skip the config.
    const r = await cards.withdrawIntent(ANA, CARD_W);
    expect(r).toMatchObject({ state: 'WITHDRAWN', introductions_archived: 1 });
    expect(sqsSend).not.toHaveBeenCalled();
  });
});
