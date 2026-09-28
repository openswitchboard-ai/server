/**
 * EVERY CALL'S ARGUMENTS, CHECKED IN ONE PLACE, AND NO DATABASE WORDS ON THE
 * WIRE (28 September 2026 review, src/mcp/tools.ts argumentComplaint).
 *
 *  - Each tool's arguments are held against the schema the agent was shown,
 *    and an id that is not an id is answered before any query runs.
 *  - Every older argument name a handler still reads, and every field a
 *    handler checks in its own words, still reaches that handler.
 *  - Anything thrown that is not one of the switchboard's own answers comes
 *    back as one fixed sentence, and its own words go only to the log.
 *  - settle's figure and description are checked before they are stored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../src/db.js';
import {
  argumentComplaint,
  dispatchTool,
  internalError,
  settleArgumentComplaint,
} from '../../src/mcp/tools.js';
import { MANDATE_AMOUNT_MAX } from '../../src/domain/negotiation.js';
import type { Config } from '../../src/config.js';

const cfg = { envName: 'dev', publicOrigin: 'https://mcp.test', quotas: {} } as unknown as Config;
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ID = '00000000-0000-4000-8000-000000000001';

afterEach(() => vi.restoreAllMocks());

describe('ids', () => {
  it('an id that is not one is refused in words, whichever argument it is', () => {
    for (const k of ['intent_id', 'intro_id', 'match_id', 'offer_id', 'settlement_id', 'press_id']) {
      expect(argumentComplaint('respond', { action: 'decline', [k]: "1' OR '1'='1" }), k).toBe(
        `${k} is not an id the switchboard handed out`,
      );
    }
    expect(argumentComplaint('withdraw_intent', { intent_id: 42 })).toMatch(/intent_id is not an id/);
  });

  it('a real one passes', () => {
    expect(argumentComplaint('withdraw_intent', { intent_id: ID })).toBeUndefined();
  });

  it('is refused before any query naming it runs', async () => {
    const seen: string[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string, params: any[] = []) => {
        seen.push(`${sql} ${JSON.stringify(params)}`);
        return { rows: [], rowCount: 0 };
      },
    } as any);
    const r: any = await dispatchTool(cfg, ANA, 'withdraw_intent', { intent_id: 'not-an-id' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toBe('invalid_input');
    expect(seen.some((q) => q.includes('not-an-id'))).toBe(false);
  });
});

describe('the schema the agent was shown', () => {
  it('turns away an argument no tool takes', () => {
    expect(argumentComplaint('withdraw_intent', { intent_id: ID, force: true })).toBe(
      "withdraw_intent takes no 'force'",
    );
  });

  it('turns away the wrong type, in words', () => {
    expect(argumentComplaint('send_message', { intro_id: ID, text: 42 })).toBe('text has to be a string');
    expect(argumentComplaint('send_message', { intro_id: ID, text: 'x'.repeat(4001) })).toMatch(/^text /);
  });

  it('says what is missing', () => {
    expect(argumentComplaint('wait_for_press', {})).toBe('wait_for_press needs press_id');
  });

  it('checks inside objects too', () => {
    expect(
      argumentComplaint('respond', {
        intro_id: ID,
        action: 'propose_offer',
        offer: { amount: 5, ccy: 'AUD', expiry: '2026-10-01T00:00:00Z', surprise: 1 },
      }),
    ).toBe("respond takes no 'surprise' inside offer");
  });

  it('leaves read_manual alone: it is always readable', () => {
    expect(argumentComplaint('read_manual', { section: 7, since: 'soon', extra: true })).toBeUndefined();
  });
});

describe('older names and handler-owned fields still reach their handler', () => {
  it.each([
    ['check_in', { match_id: ID, step: 2 }],
    ['check_in', { intro_id: ID, step: 'details' }],
    ['publish_intent', { card: { type: 'WANT' } }],
    ['publish_intent', { listing: { type: 'HAVE', whatever: 1 }, reference: 'not-a-uuid' }],
    ['respond', { match_id: ID, action: 'close_collection' }],
    ['respond', { intro_id: ID, action: 'verdict', verdict: 'positive' }],
    ['respond', { intro_id: ID, action: 'decline', reason: 'too far' }],
    ['respond', { intro_id: ID, action: 'propose_offer', offer: { match_id: ID, amount: 5, ccy: 'AUD', expiry: '2026-10-01T00:00:00Z' } }],
    ['open_conversation', { match_id: ID }],
    ['send_message', { match_id: ID, text: 'hello' }],
    ['collect_messages', { match_id: ID }],
    ['settle', { match_id: ID }],
    ['amend_intent', { intent_id: ID, patch: { slots: 99 } }],
    ['standing_arrangement', { action: 'set', arrangement: { check_every_minutes: 1 } }],
    ['refine_intent', { intent_id: ID, also_called: ['x'.repeat(200)] }],
  ] as const)('%s %j', (tool, args) => {
    expect(argumentComplaint(tool, args)).toBeUndefined();
  });

  it('a decline carrying a reason is still turned away in its own words', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue({ query: async () => ({ rows: [], rowCount: 0 }) } as any);
    const r: any = await dispatchTool(cfg, ANA, 'respond', { intro_id: ID, action: 'decline', reason: 'x' });
    expect(r.structuredContent.message).toBe('declines carry no reason, by design');
  });

  it('a conversation tool with no introduction at all says which it needs', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue({ query: async () => ({ rows: [], rowCount: 0 }) } as any);
    const r: any = await dispatchTool(cfg, ANA, 'open_conversation', {});
    expect(r.structuredContent.message).toBe('open_conversation requires intro_id');
  });
});

describe('what goes back when something breaks', () => {
  it('is one fixed sentence, and the database’s own words go only to the log', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async () => {
        throw Object.assign(new Error('invalid input syntax for type uuid: "abc" at cards.account_id'), {
          code: '22P02',
        });
      },
    } as any);
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const r: any = await dispatchTool(cfg, ANA, 'list_intents', {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toBe('internal_error');
    const wire = JSON.stringify(r);
    expect(wire).not.toContain('uuid');
    expect(wire).not.toContain('cards');
    expect(wire).not.toContain('22P02');
    const line = JSON.parse(logged.find((l) => l.includes('tool failed'))!);
    expect(line).toMatchObject({ tool: 'list_intents', code: '22P02' });
    expect(line.error).toContain('invalid input syntax');
    expect(line).not.toHaveProperty('account_id');
  });

  it('is the same sentence whoever builds it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = internalError('check_in', new Error('one thing'));
    const b = internalError('settle', new Error('another'));
    expect(a.structuredContent).toEqual(b.structuredContent);
  });
});

describe('settle, before anything is stored', () => {
  it('takes an ordinary figure and an ordinary description', () => {
    expect(settleArgumentComplaint(420, 'AUD', 'The Trek, collected Saturday.\nWith the pump.')).toBeUndefined();
    expect(settleArgumentComplaint(1500, 'JPY', undefined)).toBeUndefined();
  });

  it('caps the figure at the switchboard’s ceiling', () => {
    expect(settleArgumentComplaint(MANDATE_AMOUNT_MAX, 'AUD', undefined)).toBeUndefined();
    expect(settleArgumentComplaint(MANDATE_AMOUNT_MAX + 1, 'AUD', undefined)).toMatch(/runs past/);
    expect(settleArgumentComplaint(1e300, 'AUD', undefined)).toMatch(/runs past/);
  });

  it('goes no finer than the currency does', () => {
    expect(settleArgumentComplaint(10.005, 'AUD', undefined)).toMatch(/no finer than cents/);
    expect(settleArgumentComplaint(10.5, 'JPY', undefined)).toMatch(/whole units/);
    expect(settleArgumentComplaint(10.05, 'AUD', undefined)).toBeUndefined();
  });

  it('refuses nothing, a negative and something that is not a number', () => {
    for (const bad of [0, -5, Number.NaN, '12' as any]) {
      expect(settleArgumentComplaint(bad, 'AUD', undefined)).toMatch(/above nothing/);
    }
  });

  it('holds the description to the offer note’s rule', () => {
    expect(settleArgumentComplaint(10, 'AUD', 'ring me on 0412 345 678')).toMatch(/phone number/);
    expect(settleArgumentComplaint(10, 'AUD', 'see me@example.com')).toMatch(/email/);
    expect(settleArgumentComplaint(10, 'AUD', 'https://example.com/pay')).toMatch(/web address/);
    expect(settleArgumentComplaint(10, 'AUD', '<b>bike</b>')).toMatch(/plain text/);
    expect(settleArgumentComplaint(10, 'AUD', 'x'.repeat(2001))).toMatch(/2000/);
  });

  it('refuses at the tool, before the settlement is proposed', async () => {
    const seen: string[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string) => {
        seen.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as any);
    const settleCfg = { ...cfg, stripeSecretArn: 'arn', evidenceBucket: 'bucket' } as unknown as Config;
    const r: any = await dispatchTool(settleCfg, ANA, 'settle', {
      intro_id: ID,
      amount: 10,
      ccy: 'AUD',
      description: 'call 0412 345 678',
    });
    expect(r.structuredContent.error).toBe('invalid_input');
    expect(r.structuredContent.message).toMatch(/phone number/);
    expect(seen.some((q) => /settlements/.test(q))).toBe(false);
  });
});
