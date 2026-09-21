/**
 * The reads that were standing in for locks.
 *
 * Every defect in this suite has the same shape. A SELECT asked whether
 * something was allowed; an INSERT or an UPDATE some distance later did it; and
 * two callers arriving together both read the board as it was before either of
 * them, both passed, and both wrote. A limit enforced that way is a limit on
 * callers who take turns and no limit at all on callers who do not — which is
 * the only kind an agent has.
 *
 * The reads all stay. They are what gives a person a sentence they can act on,
 * and they save an account with nothing left to spend from spending a model
 * call. What changed is where the decision is made: in the statement that does
 * the writing, or under a row lock held across both halves.
 *
 * WHAT IS PROVED HERE, with no database and no Stripe — these are claims about
 * the statements, driven against a pool that records them:
 *   - one live settlement per introduction, and the index's refusal wearing the
 *     same words as the read's;
 *   - a funding event claims the settlement or is told it is a stray, and the
 *     payment reference is never written over one already there;
 *   - an approval carries the two figures it was shown, into the lock and into
 *     both writes;
 *   - one channel and one channel KEY per introduction;
 *   - both counting rails ride inside the INSERT they guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from '../../src/db.js';
import * as crypto from '../../src/crypto.js';
import * as settlements from '../../src/domain/settlements.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, '..', '..', 'src', p), 'utf8');

const SID = '7a2e5c1d-9f4b-4c8a-b3e6-2d1f0a9b8c7d';
const MID = '0d9f2c1e-7b4a-4f7e-9c2d-1a2b3c4d5e6f';

const row = (over: Record<string, any> = {}): any => ({
  id: SID,
  match_id: MID,
  proposer_account: 'buyer-acct',
  buyer_account: 'buyer-acct',
  seller_account: 'seller-acct',
  amount: '87.65',
  ccy: 'AUD',
  state: 'resolution-proposed',
  refund_minor: 2000,
  release_minor: 6765,
  split_proposed_by: 'seller-acct',
  split_buyer_approved_at: null,
  split_seller_approved_at: new Date(),
  stripe_payment_intent: null,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('one live settlement per introduction', () => {
  it('turns the index\'s refusal into the same sentence the read gives', () => {
    // Both roads end at one function, so there is exactly one wording of this
    // news and the agent cannot tell which road it came down.
    const src = read('domain/settlements.ts');
    expect(src).toContain('function alreadyUnderWay()');
    expect([...src.matchAll(/A settlement is already under way/g)]).toHaveLength(1);
    // The catch is on the unique violation, by name, so a different constraint
    // failing is not quietly reported as a settlement already in flight.
    expect(src).toContain("e?.code === '23505'");
    expect(src).toContain("settlements_one_live");
  });

  it('names the same terminal states the index does', () => {
    const migration = readFileSync(
      join(here, '..', '..', 'migrations', '043_dispute_integrity.sql'),
      'utf8',
    );
    for (const state of settlements.TERMINAL_STATES) {
      expect(migration).toContain(`'${state}'`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the funding event claims the settlement, or it is a stray', () => {
  const ctx = () => settlements.webhookAction('evt_x', 'checkout.session.completed');

  it('writes the payment reference only onto an approved settlement with none', async () => {
    const asked: { sql: string; params: any[] }[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string, params: any[] = []) => {
        asked.push({ sql, params });
        if (/state = 'approved' AND stripe_payment_intent IS NULL/.test(sql)) {
          return { rows: [{ id: SID }], rowCount: 1 };
        }
        if (/UPDATE settlements SET state/.test(sql)) {
          return { rows: [row({ state: 'funded' })], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as any);
    const out = await settlements.markFunded(ctx(), SID, { paymentIntent: 'pi_x' });
    expect('funded' in out).toBe(true);
    expect(asked[0].sql).toContain("state = 'approved' AND stripe_payment_intent IS NULL");
  });

  it('calls a second payment a stray rather than overwriting the first', async () => {
    const asked: string[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string) => {
        asked.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as any);
    const out = await settlements.markFunded(ctx(), SID, { paymentIntent: 'pi_second' });
    expect(out).toEqual({ stray: true });
    // And nothing else was attempted: no state was moved on the way out.
    expect(asked.some((s) => /UPDATE settlements SET state/.test(s))).toBe(false);
  });

  it('gives the webhook one stray road, whichever way it found out', () => {
    const src = read('stripeWebhook.ts');
    expect(src).toContain('async function refundStrayPayment(');
    // One refund statement, reached from both the early read and markFunded.
    expect([...src.matchAll(/osb-settlement-stray-/g)]).toHaveLength(1);
    expect([...src.matchAll(/refundStrayPayment\(/g)].length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
describe('agreeing to a split agrees to the figures that were shown', () => {
  /** A client that records everything, so the test can read the transaction. */
  function fakeClient(locked: any, moved: any) {
    const seen: { sql: string; params: any[] }[] = [];
    return {
      seen,
      client: {
        query: async (sql: string, params: any[] = []) => {
          seen.push({ sql, params });
          if (/FOR UPDATE/.test(sql)) return { rows: locked ? [locked] : [], rowCount: locked ? 1 : 0 };
          if (/UPDATE settlements SET state/.test(sql)) {
            return { rows: moved ? [moved] : [], rowCount: moved ? 1 : 0 };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      },
    };
  }

  function poolWith(c: any, current: any) {
    return {
      connect: async () => c,
      query: async (sql: string) => {
        if (/^SELECT \* FROM settlements WHERE id/.test(sql.trim())) {
          return { rows: current ? [current] : [], rowCount: current ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as any;
  }

  it('reads under a row lock and carries the figures into both writes', async () => {
    const current = row();
    const { seen, client } = fakeClient(current, row({ state: 'resolved' }));
    vi.spyOn(db, 'getPool').mockReturnValue(poolWith(client, current));
    vi.spyOn(crypto, 'writeConsentEvent').mockResolvedValue('consent-key');
    await settlements.approveResolution(
      settlements.counterAction('buyer-acct'),
      SID,
      2000,
      6765,
    );
    const sql = seen.map((s) => s.sql.replace(/\s+/g, ' '));
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toContain('FOR UPDATE');
    // Both writes name the figures, so a split that changed underneath the
    // approver matches nothing and moves nothing.
    expect(sql[2]).toContain('refund_minor = $3 AND release_minor = $4');
    expect(sql[3]).toContain('refund_minor = $4 AND release_minor = $5');
    expect(seen[3].params.slice(-2)).toEqual([2000, 6765]);
    expect(sql[4]).toBe('COMMIT');
  });

  it('rolls back and says to look again when the figures moved under the lock', async () => {
    // The row the page rendered from, and the row the lock actually found.
    const current = row();
    const changed = row({ refund_minor: 8765, release_minor: 0 });
    const { seen, client } = fakeClient(changed, null);
    vi.spyOn(db, 'getPool').mockReturnValue(poolWith(client, current));
    vi.spyOn(crypto, 'writeConsentEvent').mockResolvedValue('consent-key');
    await expect(
      settlements.approveResolution(settlements.counterAction('buyer-acct'), SID, 2000, 6765),
    ).rejects.toMatchObject({
      payload: { human_action: expect.stringMatching(/changed while you were looking/) },
    });
    expect(seen.map((s) => s.sql)).toContain('ROLLBACK');
    // Nothing was stamped: the approval never touched the row.
    expect(seen.some((s) => /split_buyer_approved_at =/.test(s.sql))).toBe(false);
  });

  it('still lets exactly one statement in the codebase write settlements.state', () => {
    // The transaction reuses applyTransition rather than writing its own
    // UPDATE, so the single-state-writer invariant is untouched. (The full
    // source scan lives in settlements.test.ts; this is the local claim.)
    const src = read('domain/settlements.ts');
    const fn = src.slice(src.indexOf('export async function approveResolution'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).not.toMatch(/UPDATE settlements SET state/);
    expect(body).toContain('applyTransition(');
    expect(body).toContain('client');
  });
});

// ---------------------------------------------------------------------------
describe('one conversation, and one key, per introduction', () => {
  it('claims the channel with a compare-and-swap and takes the winner\'s otherwise', () => {
    const src = read('domain/matches.ts');
    const fn = src.slice(src.indexOf('export async function openChannel'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('WHERE id = $1 AND channel_id IS NULL');
    expect(body).toContain('RETURNING channel_id');
    // The loser re-reads rather than returning the channel it minted: the key
    // on the row belongs to the winner, and messages are encrypted under it.
    expect(body).toContain('const fresh = await getMatch(matchId)');
    expect(body).toContain('channelId = fresh.channel_id');
  });
});

// ---------------------------------------------------------------------------
describe('the counting rails ride inside the statement they guard', () => {
  it('counts open cards in the INSERT that adds one', () => {
    const src = read('domain/cards.ts');
    expect(src).toContain('OPEN_CARDS_GUARD_SQL');
    // An INSERT … SELECT … WHERE, not an INSERT … VALUES: the count and the
    // row that changes it are one statement.
    // (The first thing selected is the posting's id, which is the attempt's own
    // reference where there is one — domain/postingRef.ts.)
    expect(src).toMatch(/INSERT INTO cards[\s\S]{0,400}SELECT[\s\S]{0,120}\$1,\$2,\$3/);
  });

  it('counts the day\'s posting in the statement that records it', () => {
    const src = read('domain/quotas.ts');
    const fn = src.slice(src.indexOf('export async function recordPublishWithinQuota'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/INSERT INTO publish_events[\s\S]*SELECT \$1, \$2[\s\S]*WHERE \(SELECT count/);
    expect(body).toContain('RETURNING id');
    // No row means no room, and that is the whole of the decision.
    expect(body).toContain("throw new OsbError('QUOTA_EXCEEDED'");
  });

  it('counts both offer rails in the INSERT that adds an offer', () => {
    const quotas = read('domain/quotas.ts');
    const guard = quotas.slice(quotas.indexOf('export const OFFER_RATE_GUARD_SQL'));
    expect(guard).toContain("interval '1 hour'");
    expect(guard).toContain("interval '24 hours'");
    const offers = read('domain/offers.ts');
    expect(offers).toMatch(/INSERT INTO offers[\s\S]{0,300}SELECT \$1,\$2/);
    expect(offers).toContain("WHERE ${OFFER_RATE_GUARD_SQL('$9::int', '$10::int')}");
    // And the refusal comes from the checks, which know the words and the wait.
    expect(offers).toContain('await offerRateRefusal(accountId, input.match_id, cfg.quotas)');
  });

  it('marks a sealed number on the row, so the index can hold one each', () => {
    const offers = read('domain/offers.ts');
    // assertBestOfferRules answers the question rather than merely refusing.
    expect(offers).toContain('const sealed = await assertBestOfferRules(');
    expect(offers).toContain('Promise<boolean>');
    // One wording of the news, whichever road found it.
    expect(offers).toContain('function oneNumberEach()');
    expect([...offers.matchAll(/it is one number each/g)]).toHaveLength(1);
    expect(offers).toContain('offers_one_best_offer');
  });

  it('puts every index in the migration that the code catches by name', () => {
    const migration = readFileSync(
      join(here, '..', '..', 'migrations', '043_dispute_integrity.sql'),
      'utf8',
    );
    for (const name of ['settlements_one_live', 'settlements_one_payment', 'offers_one_best_offer']) {
      expect(migration).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${name}`);
    }
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS best_offer');
  });
});
