/**
 * The three things a worker does that have no end in them.
 *
 *   - THE EMAIL TICKS walked every account that qualified, in one SQS message.
 *     Fine at a hundred accounts and an outage at a hundred thousand: the whole
 *     result set in memory, an unbounded walk inside a message with a
 *     visibility timeout, and a tick that cannot finish before it is
 *     redelivered and started again from the top. Twenty-five a message now,
 *     ordered by id, with a continuation carrying the last one — the same shape
 *     as backfill-geo.
 *
 *   - THE SETTLEMENT SWEEP retried a failed transfer on every hourly pass, for
 *     ever. A seller whose account cannot take the money is not a transient
 *     failure, and four hundred identical log lines are how a settlement that
 *     genuinely needs a person gets lost. Doubling backoff from an hour, capped
 *     at a day, and after ten attempts it stops and counts it.
 *
 *   - A CHARGEBACK was not subscribed to at all, so a buyer going to their card
 *     issuer was invisible here. It is recorded now, and it moves no money:
 *     whether an issuer's dispute succeeds is decided elsewhere on a clock
 *     nobody here controls, and acting on the dispute being RAISED would be
 *     deciding it for them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from '../../src/db.js';
import { TICK_PAGE } from '../../src/email/digestEngine.js';
import {
  TRANSFER_ATTEMPT_CEILING,
  TRANSFER_BACKOFF_CAP_HOURS,
  transferBackoffHours,
} from '../../src/domain/settlements.js';
import { WEBHOOK_EVENTS } from '../../src/stripe.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, '..', '..', 'src', p), 'utf8');

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('the email ticks are paged', () => {
  it('takes twenty-five accounts a message, ordered so a cursor means something', () => {
    expect(TICK_PAGE).toBe(25);
    const src = read('email/digestEngine.ts');
    for (const fn of ['runSummonsBatch', 'runDigestTick', 'runRenewalTick']) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      const scope = body.slice(0, body.indexOf('\n}\n'));
      expect(scope, fn).toContain('ORDER BY');
      expect(scope, fn).toContain('LIMIT ${TICK_PAGE}');
      expect(scope, fn).toContain('pageEnd(');
    }
  });

  it('stops at the end rather than one message past it', () => {
    const src = read('email/digestEngine.ts');
    const fn = src.slice(src.indexOf('function pageEnd'));
    // A short page is the last page. A full one may have more behind it, and
    // one extra message that finds nothing is cheaper than a page dropped.
    expect(fn).toContain('rows.length === TICK_PAGE');
  });

  it('enqueues a continuation carrying where it got to', () => {
    const src = read('workers/opsWorker.ts');
    const digest = src.slice(src.indexOf("case 'email-digest-tick'"));
    const scope = digest.slice(0, digest.indexOf("case 'email-renewal-tick'"));
    expect(scope).toContain('QueueUrl: cfg.opsQueueUrl');
    // The two halves page independently — an account can be on a daily digest
    // and a weekly summons — and a half that has finished must not start again
    // from the top on the next page, so it is carried as null rather than
    // dropped from the message.
    expect(scope).toContain('summons: summons?.next ?? null');
    expect(scope).toContain('digests: digests?.next ?? null');
    const renewal = src.slice(src.indexOf("case 'email-renewal-tick'"));
    expect(renewal.slice(0, 1200)).toContain('after: r.next');
  });

  it('still logs and skips one account rather than losing the page', () => {
    const src = read('email/digestEngine.ts');
    // Every tick's per-account body is a try/catch that counts and carries on.
    expect([...src.matchAll(/logAccountFailure\(/g)].length).toBeGreaterThanOrEqual(3);
    expect(src).not.toMatch(/catch \(e: any\) \{\s*throw e/);
  });
});

// ---------------------------------------------------------------------------
describe('the sweep gives up on a transfer, and says so', () => {
  it('doubles from an hour and caps at a day', () => {
    expect(transferBackoffHours(1)).toBe(1);
    expect(transferBackoffHours(2)).toBe(2);
    expect(transferBackoffHours(3)).toBe(4);
    expect(transferBackoffHours(4)).toBe(8);
    expect(transferBackoffHours(5)).toBe(16);
    expect(transferBackoffHours(6)).toBe(TRANSFER_BACKOFF_CAP_HOURS);
    expect(transferBackoffHours(50)).toBe(TRANSFER_BACKOFF_CAP_HOURS);
    // The nought case is the first attempt: an hour, not none.
    expect(transferBackoffHours(0)).toBe(1);
  });

  it('leaves a settlement out of the retry set while its next attempt is not due', async () => {
    let asked = '';
    let params: any[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string, p: any[] = []) => {
        asked = sql;
        params = p;
        return { rows: [], rowCount: 0 };
      },
    } as any);
    const { autoReleasesAwaitingTransfer } = await import('../../src/domain/settlements.js');
    await autoReleasesAwaitingTransfer();
    expect(asked).toContain('transfer_attempts < $2');
    expect(asked).toContain('next_transfer_attempt_at IS NULL OR next_transfer_attempt_at <= now()');
    expect(params[1]).toBe(TRANSFER_ATTEMPT_CEILING);
  });

  it('records the attempt and the wait in one statement', async () => {
    let asked = '';
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string) => {
        asked = sql;
        return { rows: [{ transfer_attempts: 10 }], rowCount: 1 };
      },
    } as any);
    const { noteTransferAttempt } = await import('../../src/domain/settlements.js');
    const out = await noteTransferAttempt('sid');
    expect(asked).toContain('transfer_attempts = transfer_attempts + 1');
    expect(asked).toContain('LEAST($2::int, POWER(2, GREATEST(0, transfer_attempts))::int)');
    // Ten is the ceiling, so this settlement is out of attempts.
    expect(out).toEqual({ attempts: 10, stuck: true });
  });

  it('says transfer_stuck once, loudly, and moves nothing', () => {
    expect(TRANSFER_ATTEMPT_CEILING).toBe(10);
    const src = read('workers/settlementAutoRelease.ts');
    expect(src).toContain('transfer_stuck:');
    expect(src).toContain('result.transferStuck += 1');
    // A transfer that DID go through clears the clock behind it, so a
    // settlement that recovered is not carrying a backoff nobody will use.
    expect(src).toContain('await clearTransferAttempts(stuck.id)');
  });

  it('puts the count where an operator looks, beside the chargebacks', () => {
    const src = read('opsMetrics.ts');
    expect(src).toContain('transfers_stuck: number');
    expect(src).toContain('chargebacks: number');
    expect(src).toContain('Transfers the sweep has given up on');
    expect(src).toContain('Chargebacks raised');
  });
});

// ---------------------------------------------------------------------------
describe('a chargeback is recorded and nothing else', () => {
  it('is in the subscribed set', () => {
    expect(WEBHOOK_EVENTS).toContain('charge.dispute.created');
  });

  it('moves no money on the way through', () => {
    const src = read('stripeWebhook.ts');
    const start = src.indexOf("case 'charge.dispute.created'");
    const scope = src.slice(start, src.indexOf("case 'charge.refunded'", start));
    expect(scope).toContain('markChargeback(ctx, s.id)');
    // Not a refund, not a transfer, not a state: the three things this must
    // never do, named so a later edit has to argue with the test.
    expect(scope).not.toContain('refunds.create');
    expect(scope).not.toContain('transferToSeller');
    expect(scope).not.toContain('applyTransition');
    expect(scope).toContain('nothing moved');
  });

  it('writes the stamp without touching state, so the single writer stands', () => {
    const src = read('domain/settlements.ts');
    const fn = src.slice(src.indexOf('export async function markChargeback'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('chargeback_at = COALESCE(chargeback_at, now())');
    expect(body).not.toContain('state =');
    // It still demands a verified webhook context, like every other writer.
    expect(body).toContain('assertTransitionContext(ctx)');
  });

  it('says so plainly when the chargeback is on a payment we have no settlement for', () => {
    const src = read('stripeWebhook.ts');
    expect(src).toContain('chargeback on a payment with no settlement behind it');
  });
});
