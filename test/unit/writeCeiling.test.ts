/**
 * The shared WRITE ceiling, and the rail under wait_for_press.
 *
 * The defect this suite exists to hold shut (2026-09-17 audit): migration 011
 * capped reading and nothing capped writing. Every write tool carried a limit
 * of its own and every one of those limits was scoped to something smaller than
 * the account — offers per hour, publishes per day, messages per channel per
 * hour — so an agent holding introductions on ten conversations could send six
 * hundred messages an hour inside the rules, every one of them a model call and
 * a ledger row, with nothing anywhere counting the account.
 *
 * And wait_for_press, which is charged against neither ceiling and rightly so,
 * HOLDS: a thousand of them was a thousand sockets and a thousand pollers for a
 * human who is going to press one link.
 *
 * The rules asserted here:
 *  - one budget across send_message, publish_intent, respond and settle;
 *  - the call past it is RATE_LIMITED with a retry_after, and conforms;
 *  - link minting is on that budget, because every request_* is a respond;
 *  - the read tools are not on it, and it is not on them;
 *  - three concurrent waits per account, the fourth refused, and the count
 *    comes back down when a wait ends — including when it ends by throwing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../src/db.js';
import * as humanLinks from '../../src/domain/humanLinks.js';
import { MAX_WRITES_PER_HOUR, checkWriteRate } from '../../src/domain/quotas.js';
import { OsbError, validatePayload } from '../../src/protocol.js';
import {
  MAX_CONCURRENT_WAITS,
  dispatchTool,
  resetWaitsInFlight,
  waitsHeldFor,
} from '../../src/mcp/tools.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  publicOrigin: 'https://mcp.test',
  counterOrigin: 'https://my.test',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6, maxWritesPerHour: MAX_WRITES_PER_HOUR },
} as unknown as Config;

const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc';

let calls: Map<string, number[]>;
let now: number;

/** The one statement checkWriteRate runs, played back. */
function writeCallsStatement(accountId: string, cap: number) {
  const kept = (calls.get(accountId) ?? []).filter((t) => t > now - 3_600_000);
  const n = kept.length;
  const oldest = n ? new Date(Math.min(...kept)) : null;
  if (n < cap) kept.push(now);
  calls.set(accountId, kept);
  return { rows: [{ n, oldest }], rowCount: 1 };
}

beforeEach(() => {
  calls = new Map();
  now = Date.parse('2026-09-17T10:00:00.000Z');
  resetWaitsInFlight();
  vi.spyOn(db, 'getPool').mockReturnValue({
    query: async (sql: string, params: any[] = []) => {
      if (/write_calls/.test(sql)) return writeCallsStatement(params[0], params[1]);
      if (/read_calls/.test(sql)) return { rows: [{ n: 0, oldest: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as any);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetWaitsInFlight();
});

// ---------------------------------------------------------------------------
describe('three hundred an hour, shared across everything that changes something', () => {
  it('lets the budget through and refuses the call past it', async () => {
    for (let i = 0; i < MAX_WRITES_PER_HOUR; i++) {
      await expect(checkWriteRate(ANA, cfg.quotas)).resolves.toBeUndefined();
    }
    await expect(checkWriteRate(ANA, cfg.quotas)).rejects.toThrow(OsbError);
  });

  it('the refusal is RATE_LIMITED with a retry_after, and conforms', async () => {
    for (let i = 0; i < MAX_WRITES_PER_HOUR; i++) await checkWriteRate(ANA, cfg.quotas);
    const err = (await checkWriteRate(ANA, cfg.quotas).catch((e) => e)) as OsbError;
    expect(err).toBeInstanceOf(OsbError);
    expect(err.payload.code).toBe('RATE_LIMITED');
    expect(err.payload.retry_after).toBeGreaterThan(0);
    expect(validatePayload('error', err.payload).valid).toBe(true);
  });

  it('retry_after is the wait until the oldest call in the window ages out', async () => {
    await checkWriteRate(ANA, cfg.quotas);
    now += 10 * 60_000;
    for (let i = 1; i < MAX_WRITES_PER_HOUR; i++) await checkWriteRate(ANA, cfg.quotas);
    const err = (await checkWriteRate(ANA, cfg.quotas).catch((e) => e)) as OsbError;
    expect(err.payload.retry_after).toBe(50 * 60);
  });

  it('the window frees as calls age out', async () => {
    for (let i = 0; i < MAX_WRITES_PER_HOUR; i++) await checkWriteRate(ANA, cfg.quotas);
    await expect(checkWriteRate(ANA, cfg.quotas)).rejects.toThrow(OsbError);
    now += 3_600_001;
    await expect(checkWriteRate(ANA, cfg.quotas)).resolves.toBeUndefined();
  });

  it('one account filling its budget leaves another alone', async () => {
    for (let i = 0; i < MAX_WRITES_PER_HOUR; i++) await checkWriteRate(ANA, cfg.quotas);
    await expect(checkWriteRate(ANA, cfg.quotas)).rejects.toThrow(OsbError);
    await expect(checkWriteRate(BEPPE, cfg.quotas)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('which tools it covers', () => {
  const spend = (tool: string, args: any = {}) => dispatchTool(cfg, ANA, tool, args);

  it('is one budget across send_message, publish_intent, respond and settle', async () => {
    const quarter = MAX_WRITES_PER_HOUR / 4;
    for (let i = 0; i < quarter; i++) {
      await spend('send_message', { intro_id: 'x', text: 'hello' }).catch(() => undefined);
      await spend('publish_intent', { listing: {} }).catch(() => undefined);
      await spend('respond', { intro_id: 'x', action: 'decline' }).catch(() => undefined);
      await spend('settle', { match_id: 'x', amount: 1, ccy: 'AUD' }).catch(() => undefined);
    }
    const r: any = await spend('send_message', { intro_id: 'x', text: 'hello' });
    // Hitting the ceiling is the ceiling working, so it is an ordinary answer.
    expect(r.isError).toBe(false);
    expect(r.structuredContent.code).toBe('RATE_LIMITED');
    expect(r.structuredContent.retry_after).toBeGreaterThan(0);
  });

  /**
   * Every request_* is a respond action, so minting a page for a human to press
   * costs an account exactly what sending a message costs. That is the point: a
   * link is cheap for an agent to ask for and expensive for a human to be
   * handed one after another.
   */
  it('link minting is on the budget, because every request_* is a respond', async () => {
    for (let i = 0; i < MAX_WRITES_PER_HOUR; i++) await checkWriteRate(ANA, cfg.quotas);
    const r: any = await spend('respond', { intro_id: 'x', action: 'request_share_name' });
    expect(r.structuredContent.code).toBe('RATE_LIMITED');
  });

  it('leaves the read surface alone, and the read ceiling leaves it alone', async () => {
    for (let i = 0; i < MAX_WRITES_PER_HOUR; i++) await checkWriteRate(ANA, cfg.quotas);
    const r: any = await spend('list_intents', {});
    expect(r.structuredContent?.code).not.toBe('RATE_LIMITED');
    // And a write does not spend a read: `calls` is the write table alone, and
    // nothing above touched read_calls.
    expect(calls.get(ANA)!.length).toBe(MAX_WRITES_PER_HOUR);
  });
});

// ---------------------------------------------------------------------------
/**
 * IN MEMORY, DELIBERATELY. A wait is held by ONE process — the task holding the
 * socket — so a per-process count is a count of exactly the thing being
 * limited, and a restart that clears the map is a process holding no waits.
 */
describe('three waits at a time, and no more', () => {
  /** A wait that hangs until we let it go. */
  const pending = () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.spyOn(humanLinks, 'waitForPress').mockImplementation(async () => {
      await held;
      return { pressed: false } as any;
    });
    return release;
  };

  const wait = () => dispatchTool(cfg, ANA, 'wait_for_press', { press_id: 'p' });

  it('holds three, refuses the fourth, and says what to do about it', async () => {
    const release = pending();
    const open = [wait(), wait(), wait()];
    // Give the three a turn to register themselves before the fourth asks.
    await Promise.resolve();
    expect(waitsHeldFor(ANA)).toBe(MAX_CONCURRENT_WAITS);
    const fourth: any = await wait();
    expect(fourth.structuredContent.code).toBe('RATE_LIMITED');
    expect(fourth.structuredContent.human_action).toMatch(/several of these waiting/);
    release();
    await Promise.all(open);
    expect(waitsHeldFor(ANA)).toBe(0);
  });

  it('the count comes back down as each one ends', async () => {
    const release = pending();
    const open = [wait(), wait()];
    await Promise.resolve();
    expect(waitsHeldFor(ANA)).toBe(2);
    release();
    await Promise.all(open);
    expect(waitsHeldFor(ANA)).toBe(0);
    await expect(wait()).resolves.toBeTruthy();
  });

  it('and down again when one ends by throwing', async () => {
    vi.spyOn(humanLinks, 'waitForPress').mockRejectedValue(
      Object.assign(new Error('press not found'), { notFound: true }),
    );
    await dispatchTool(cfg, ANA, 'wait_for_press', { press_id: 'p' });
    expect(waitsHeldFor(ANA)).toBe(0);
  });

  it('one account holding three leaves another account free to wait', async () => {
    const release = pending();
    const open = [wait(), wait(), wait()];
    await Promise.resolve();
    const theirs = dispatchTool(cfg, BEPPE, 'wait_for_press', { press_id: 'p' });
    release();
    const r: any = await theirs;
    expect(r.structuredContent?.code).not.toBe('RATE_LIMITED');
    await Promise.all(open);
  });

  it('a wait still costs nothing against either hourly ceiling', async () => {
    const release = pending();
    const open = wait();
    release();
    await open;
    expect(calls.get(ANA) ?? []).toEqual([]);
  });
});
