/**
 * The shared read ceiling.
 *
 * The defect this suite exists to hold shut: an agent that can wake itself has
 * no reason to stop calling. check_matches, channel_receive and list_intents
 * are all cheap, all safe, and all answerable in a loop, so a well-meaning
 * scheduler can hammer the board for nothing. Sixty calls an hour per account,
 * the three of them together, is the whole rule; past it the agent is told to
 * wait and told how long.
 *
 * The rules asserted here:
 *  - the ceiling is one budget across all three read tools, not one each;
 *  - the sixty-first call in an hour is refused with RATE_LIMITED and a
 *    retry_after, and the refusal is a conformant protocol error;
 *  - retry_after is the wait until the window's oldest call ages out;
 *  - a write tool is not touched by it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../src/db.js';
import { MAX_READS_PER_HOUR, checkReadRate } from '../../src/domain/quotas.js';
import { OsbError, validatePayload } from '../../src/protocol.js';
import { dispatchTool } from '../../src/mcp/tools.js';
import type { Config } from '../../src/config.js';

const cfg = { envName: 'dev', publicOrigin: 'https://mcp.test' } as unknown as Config;
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc';

/** Calls on record, per account, as timestamps in ms. */
let calls: Map<string, number[]>;
let now: number;

/**
 * The one statement checkReadRate runs, played back: prune what has fallen out
 * of the hour, count what is left, record this call only if it fits.
 */
function readCallsStatement(accountId: string, cap: number) {
  const kept = (calls.get(accountId) ?? []).filter((t) => t > now - 3_600_000);
  const n = kept.length;
  const oldest = n ? new Date(Math.min(...kept)) : null;
  if (n < cap) kept.push(now);
  calls.set(accountId, kept);
  return { rows: [{ n, oldest }], rowCount: 1 };
}

beforeEach(() => {
  calls = new Map();
  now = Date.parse('2026-09-02T10:00:00.000Z');
  vi.spyOn(db, 'getPool').mockReturnValue({
    query: async (sql: string, params: any[] = []) => {
      if (/read_calls/.test(sql)) return readCallsStatement(params[0], params[1]);
      // Nothing else is under test here: every other read comes back empty, so
      // the tools answer with nothing rather than with something invented.
      return { rows: [], rowCount: 0 };
    },
  } as any);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

describe('sixty an hour, shared', () => {
  it('lets the first sixty through and refuses the sixty-first', async () => {
    for (let i = 0; i < MAX_READS_PER_HOUR; i++) {
      await expect(checkReadRate(ANA)).resolves.toBeUndefined();
    }
    await expect(checkReadRate(ANA)).rejects.toThrow(OsbError);
  });

  it('the refusal is RATE_LIMITED with a retry_after, and conforms', async () => {
    for (let i = 0; i < MAX_READS_PER_HOUR; i++) await checkReadRate(ANA);
    const err = await checkReadRate(ANA).catch((e) => e as OsbError);
    expect(err).toBeInstanceOf(OsbError);
    expect((err as OsbError).payload.code).toBe('RATE_LIMITED');
    expect((err as OsbError).payload.retry_after).toBeGreaterThan(0);
    expect(validatePayload('error', (err as OsbError).payload).valid).toBe(true);
  });

  it('retry_after is the wait until the oldest call in the window ages out', async () => {
    await checkReadRate(ANA); // the oldest one, at 10:00
    now += 10 * 60_000; // ten minutes later, fill the rest
    for (let i = 1; i < MAX_READS_PER_HOUR; i++) await checkReadRate(ANA);
    const err = (await checkReadRate(ANA).catch((e) => e)) as OsbError;
    // 50 minutes still to run on the first call's hour.
    expect(err.payload.retry_after).toBe(50 * 60);
  });

  it('the window frees as calls age out', async () => {
    for (let i = 0; i < MAX_READS_PER_HOUR; i++) await checkReadRate(ANA);
    await expect(checkReadRate(ANA)).rejects.toThrow(OsbError);
    now += 3_600_001;
    await expect(checkReadRate(ANA)).resolves.toBeUndefined();
  });

  it('one account filling its budget leaves another account alone', async () => {
    for (let i = 0; i < MAX_READS_PER_HOUR; i++) await checkReadRate(ANA);
    await expect(checkReadRate(ANA)).rejects.toThrow(OsbError);
    await expect(checkReadRate(BEPPE)).resolves.toBeUndefined();
  });
});

describe('which tools it covers', () => {
  const spend = async (tool: string) => {
    const r: any = await dispatchTool(cfg, ANA, tool, { match_id: undefined });
    return r;
  };

  it('is one budget across check_matches, channel_receive and list_intents', async () => {
    // Twenty of each is sixty; the next call of any of them is refused.
    for (let i = 0; i < 20; i++) {
      await spend('list_intents');
      await spend('check_matches');
      await spend('channel_receive').catch(() => undefined);
    }
    const r: any = await dispatchTool(cfg, ANA, 'list_intents', {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent.code).toBe('RATE_LIMITED');
    expect(r.structuredContent.retry_after).toBeGreaterThan(0);
  });

  it('leaves the write surface alone', async () => {
    for (let i = 0; i < MAX_READS_PER_HOUR; i++) await checkReadRate(ANA);
    const r: any = await dispatchTool(cfg, ANA, 'withdraw_intent', { intent_id: 'nope' });
    // It fails for its own reasons; what it does not do is come back rate-limited.
    expect(r.structuredContent?.code).not.toBe('RATE_LIMITED');
  });
});
