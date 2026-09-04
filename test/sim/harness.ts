/**
 * OpenSwitchboard simulation harness — shared core.
 *
 * This is NOT a unit test. It is a scenario runner that drives many synthetic
 * accounts through the real agent-to-agent flow against a LIVE deployment
 * (default dev, https://mcp-dev.openswitchboard.ai) to surface edge cases and
 * interaction bugs at scale — the class of problem we keep finding by hand
 * (matcher crowding, geo mis-resolution, disclosure leaks, register/consent
 * races). It reuses the integration suite's helpers verbatim: same OAuth,
 * same ops queue, same counter routes for the human-only steps.
 *
 * Gated OFF by default: nothing here runs under `npm test`. It is invoked
 * explicitly (npm run sim / tsx test/sim/run.ts) and refuses to start unless
 * RUN_SIM=1 is set.
 *
 * Rate limits: many synthetic actors from one runner IP would trip the per-IP
 * limiters (5 DCR/hr, 5 verification-emails/hr), so — exactly as the e2e suite
 * does — every request carries the x-osb-ratelimit-bypass header when
 * OSB_RATELIMIT_BYPASS is set. Per-ACCOUNT quotas are never bypassed; the
 * harness respects them (open-intent quota, 60/h read ceiling, 3/day offers).
 */
import { randomBytes } from 'node:crypto';
import {
  BASE_URL,
  COUNTER_URL,
  SCHEMA_VERSION,
  TestActor,
  bootstrapActor,
  dbExec,
  mcpCall as rawMcpCall,
  poll,
  registerActor,
  sendOp,
} from '../integration/helpers.js';

export { BASE_URL, COUNTER_URL, SCHEMA_VERSION, dbExec, poll, sendOp };
export type { TestActor };

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
let indent = 0;
export function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log('  '.repeat(indent) + args.map(String).join(' '));
}
export function group(title: string): void {
  log(title);
  indent++;
}
export function groupEnd(): void {
  indent = Math.max(0, indent - 1);
}

// ---------------------------------------------------------------------------
// MCP call shape used throughout. `result` is the parsed tool payload,
// `raw` the on-the-wire string (what we deep-scan), `isError` the tool's own
// isError flag.
// ---------------------------------------------------------------------------
export interface McpResult {
  raw: string;
  result: any;
  isError: boolean;
}

export interface SimActor extends TestActor {
  label: string;
  /** The first name / area actually on this account's shared profile, if any.
   *  Used by the identity-leak invariant: these strings must never appear in a
   *  counterparty payload before both sides have opted in. */
  firstName?: string;
  locality?: string;
}

/**
 * A run-scoped context. Owns the actor pool, tracks every card and match the
 * run creates so cleanup can take them all down, and carries the run marker
 * that scopes cross-run teardown.
 */
export class Harness {
  /** 4-hex run id; every synthetic geo bucket ends in it, so `--clean` and the
   *  board-cleanliness check can find exactly this run's cards. */
  readonly runId = randomBytes(2).toString('hex');
  readonly actors: SimActor[] = [];

  /** Every card the run published, by the token that owns it. Cleanup withdraws
   *  through the same door a person's agent uses (withdraw_intent). */
  private readonly cards: { token: string; id: string; label: string }[] = [];
  /** Every match the run created (via the ops queue), for archival on teardown. */
  private readonly matches: { token: string; id: string }[] = [];

  /** call counters, for the report */
  mcpCalls = 0;
  rateLimited = 0;

  /**
   * A fresh opaque geo bucket, unique to this run. The leading `_` keeps it out
   * of the geohash namespace and out of the gazetteer, so a card in it stays
   * unplaced and meets ONLY another card carrying the same string — each
   * scenario an island, immune to other runs' leftovers and to the live
   * matcher pairing our cards with strangers'. Prefix ≤3 chars so it also
   * matches scripts/withdraw-fixture-cards.ts's fixture-bucket regex.
   */
  bucket(prefix = 'sm'): string {
    return `${prefix}_${this.runId}${randomBytes(1).toString('hex')}`;
  }

  /** The SQL predicate matching every opaque card this run could have left. */
  runBucketLike(): string {
    return `%_${this.runId}%`;
  }

  async mcp(token: string, name: string, args: Record<string, unknown>): Promise<McpResult> {
    this.mcpCalls++;
    const r = (await rawMcpCall(token, name, args)) as McpResult;
    if (r.isError && r.result?.code === 'RATE_LIMITED') this.rateLimited++;
    return r;
  }

  /** publish_intent that tracks the card for teardown. Throws on error unless
   *  expectError is set (screening/geo refusals want the error envelope). */
  async publish(
    actor: SimActor,
    card: Record<string, unknown>,
    opts: { expectError?: boolean } = {},
  ): Promise<McpResult> {
    const r = await this.mcp(actor.accessToken, 'publish_intent', { listing: card });
    if (!r.isError && r.result?.intent_id) {
      this.cards.push({ token: actor.accessToken, id: r.result.intent_id, label: actor.label });
    }
    if (r.isError && !opts.expectError) {
      throw new Error(`publish failed for ${actor.label}: ${JSON.stringify(r.result)}`);
    }
    return r;
  }

  /** Deterministic match via the internal ops queue (the same door the
   *  integration suites use), then poll for the agent-visible match id. */
  async createMatch(
    wantActor: SimActor,
    wantId: string,
    haveActor: SimActor,
    haveId: string,
    score = 0.87,
  ): Promise<string> {
    await sendOp({ op: 'create-match', card_want: wantId, card_have: haveId, score });
    // Observe the match through the DB, not check_matches: match observation
    // must not depend on the want actor's shared 60/h read ceiling (a scenario
    // or red-team probe may already have spent it), and the row is the source
    // of truth either way.
    const id = await this.waitForLiveMatch(wantId, haveId, 120_000);
    this.matches.push({ token: wantActor.accessToken, id });
    return id;
  }

  /**
   * Wait for a card to reach one of `states`, polling the DB (RDS Data API),
   * NOT list_intents. Readiness polling over MCP would burn each account's
   * shared 60/h read ceiling — a whole run of it could starve the reads the
   * assertions actually need. The agent-visible state is still asserted
   * separately, via check_matches, where it is the point.
   */
  async waitCardDB(intentId: string, states: string[], timeoutMs = 120_000): Promise<string> {
    return poll(
      async () => {
        const rows = await dbExec(`SELECT lifecycle_state FROM cards WHERE id = :id::uuid`, [
          { name: 'id', value: intentId },
        ]);
        const s = rows[0]?.[0] as string | undefined;
        return s && states.includes(s) ? s : undefined;
      },
      `card ${intentId.slice(0, 8)} -> ${states.join('|')}`,
      timeoutMs,
      2_000,
    );
  }

  /** Wait for a specific match between two cards to appear in the DB (used when
   *  we want the LIVE matcher, not create-match, to be the one that pairs). */
  async waitForLiveMatch(wantId: string, haveId: string, timeoutMs = 180_000): Promise<string> {
    return poll(
      async () => {
        const rows = await dbExec(
          `SELECT id::text FROM matches WHERE card_want = :w::uuid AND card_have = :h::uuid`,
          [
            { name: 'w', value: wantId },
            { name: 'h', value: haveId },
          ],
        );
        return (rows[0]?.[0] as string) ?? undefined;
      },
      `a live match between ${wantId.slice(0, 8)} and ${haveId.slice(0, 8)}`,
      timeoutMs,
    );
  }

  /**
   * Single-shot: is there a match row between these two cards, in EITHER
   * direction? Returns the match id, or undefined. Non-throwing — the fuzz
   * classifier decides whether a match here is expected (compatible) or a
   * finding (a false match on an incompatible pair). DB-based, so it never
   * touches an account's 60/h MCP read ceiling.
   */
  async matchBetween(wantId: string, haveId: string): Promise<string | undefined> {
    const rows = await dbExec(
      `SELECT id::text FROM matches
        WHERE (card_want = :w::uuid AND card_have = :h::uuid)
           OR (card_want = :h::uuid AND card_have = :w::uuid)`,
      [
        { name: 'w', value: wantId },
        { name: 'h', value: haveId },
      ],
    );
    return (rows[0]?.[0] as string) ?? undefined;
  }

  /**
   * Wait up to `timeoutMs` for the LIVE matcher to pair these two cards (either
   * direction), polling the DB. Returns the match id if it appears, or
   * undefined on timeout — non-throwing, so the fuzz classifier can record a
   * compatible-but-no-match FINDING rather than aborting the run.
   */
  async waitMatchDB(wantId: string, haveId: string, timeoutMs = 90_000): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const id = await this.matchBetween(wantId, haveId);
      if (id) return id;
      if (Date.now() > deadline) return undefined;
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  /** Assert (with a budget) that NO match ever forms between two cards. */
  async assertNoLiveMatch(wantId: string, haveId: string, settleMs = 20_000): Promise<void> {
    await new Promise((r) => setTimeout(r, settleMs));
    const rows = await dbExec(
      `SELECT id::text FROM matches
        WHERE (card_want = :w::uuid AND card_have = :h::uuid)
           OR (card_want = :h::uuid AND card_have = :w::uuid)`,
      [
        { name: 'w', value: wantId },
        { name: 'h', value: haveId },
      ],
    );
    if (rows.length) {
      throw new Error(
        `INVARIANT/DESIGN: a match was formed that must not exist (${wantId.slice(0, 8)} × ${haveId.slice(0, 8)})`,
      );
    }
  }

  registerMatch(token: string, id: string): void {
    if (!this.matches.find((m) => m.id === id)) this.matches.push({ token, id });
  }

  // -------------------------------------------------------------------------
  // Actor pool. Creating an actor is expensive (ops-queue account + full
  // OAuth) and per-IP rate-limited, so the pool is created ONCE and scenarios
  // borrow from it. `waitForCardState`-style polling is billed against each
  // account's 60/h read ceiling, so scenarios stay economical.
  // -------------------------------------------------------------------------
  async createPool(
    n: number,
    kind: 'bootstrap' | 'register',
    localities: string[] = ['Fremantle', 'Subiaco', 'Cottesloe', 'Claremont', 'Leederville', 'Nedlands', 'Mosman Park', 'Applecross'],
  ): Promise<void> {
    const names = ['Ava', 'Ben', 'Cara', 'Dev', 'Eve', 'Finn', 'Gia', 'Hal', 'Isa', 'Jo'];
    const firstNames = Array.from({ length: n }, (_, i) => `${names[i % names.length]}${this.runId}`);
    const made = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        kind === 'bootstrap'
          ? bootstrapActor(firstNames[i], localities[i % localities.length])
          : registerActor(),
      ),
    );
    made.forEach((a, i) =>
      this.actors.push({
        ...a,
        label: `${names[i % names.length]}#${i}`,
        firstName: kind === 'bootstrap' ? firstNames[i] : undefined,
        locality: kind === 'bootstrap' ? localities[i % localities.length] : undefined,
      }),
    );
  }

  /** Withdraw one card now and stop tracking it (frees the owner's open-intent
   *  quota between scenarios so a reused account does not hit QUOTA_EXCEEDED). */
  async withdraw(token: string, id: string): Promise<void> {
    try {
      await this.mcp(token, 'withdraw_intent', { intent_id: id });
    } catch {
      /* best effort */
    }
    const i = this.cards.findIndex((c) => c.token === token && c.id === id);
    if (i >= 0) this.cards.splice(i, 1);
  }

  /** Withdraw every card published since the last reclaim. Called by the runner
   *  between scenarios so reused accounts recover their open-intent quota. */
  async reclaimCards(): Promise<number> {
    const snapshot = [...this.cards];
    let taken = 0;
    for (const c of snapshot) {
      try {
        const r = await this.mcp(c.token, 'withdraw_intent', { intent_id: c.id });
        if (!r.isError) taken++;
      } catch {
        /* best effort */
      }
    }
    this.cards.length = 0;
    return taken;
  }

  /**
   * Full teardown: archive every match the run created, withdraw every card
   * still tracked, and report what was left. Best-effort and never throws.
   */
  async teardown(): Promise<{ cardsWithdrawn: number; matchesArchived: number }> {
    let matchesArchived = 0;
    for (const m of this.matches) {
      try {
        const r = await this.mcp(m.token, 'respond', { match_id: m.id, action: 'archive' });
        if (!r.isError) matchesArchived++;
      } catch {
        /* best effort — a declined/foreign match cannot be archived, that is fine */
      }
    }
    const cardsWithdrawn = await this.reclaimCards();
    return { cardsWithdrawn, matchesArchived };
  }

  /** Count PUBLISHED cards left on the board in this run's opaque buckets. The
   *  board-cleanliness evidence: this should be 0 after teardown. */
  async boardResidue(): Promise<number> {
    const rows = await dbExec(
      `SELECT count(*)::int FROM cards
        WHERE lifecycle_state = 'PUBLISHED' AND geo->>'bucket' LIKE :b`,
      [{ name: 'b', value: this.runBucketLike() }],
    );
    return Number(rows[0][0]);
  }
}

/** Firstname / locality strings the run assigned, for the identity-leak scan.
 *  Only names actually on file can leak, so undefined ones are dropped. */
export function actorIdentityStrings(actors: SimActor[]): string[] {
  const out: string[] = [];
  for (const a of actors) {
    if (a.firstName) out.push(a.firstName);
    if (a.locality) out.push(a.locality);
  }
  return out;
}
