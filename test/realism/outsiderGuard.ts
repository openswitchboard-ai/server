/**
 * OUTSIDER GUARD — keep the evals off real people's boards.
 *
 * THE PROBLEM. Both eval harnesses (test/realism/run.ts, test/adversary/run.ts)
 * post real cards on the SHARED dev board and let the LIVE matcher do the
 * pairing — that fidelity is the whole point of them. But the live matcher does
 * not know an eval from an errand: it happily pairs an eval card against a
 * REAL account's standing card (the owner's own test accounts, which sit on dev
 * for weeks), and the driven agent then greets that person. One greeting per
 * run is fifteen near-identical messages in a real human's queue after fifteen
 * runs.
 *
 * THE MECHANISM. The matcher's candidate prefilter already excludes account
 * pairs present in `match_mutes` (src/domain/matcher.ts, the NOT EXISTS clause
 * that checks BOTH directions). A mute is account-PAIR level and permanent, so
 * one pair of rows stops all future matching between an eval account and a real
 * account whatever either posts later — cards, categories and geo do not come
 * into it. That is exactly the shape of the fix we want: nothing per-card to
 * keep in sync, and it holds for runs that have not been written yet.
 *
 * WHAT THIS DOES. After each card of a run lands, and again at teardown, it
 * looks for matches created since the run started where EXACTLY ONE side is a
 * run account. The other side is, by definition, an outsider. For every such
 * outsider it writes the mute rows in both directions against every run
 * account, idempotently.
 *
 * Where the run controls the card's owner over MCP (the scripted counterpart)
 * it also responds `decline` on the crossing match, so nothing lingers as a
 * pending introduction on the real person's page. Where the crossing is on the
 * DRIVEN AGENT's side, the mute IS the whole fix: fabricating a decline with a
 * DB write to `matches` would invent a state the product did not produce, and
 * driving the agent with a hygiene prompt would contaminate the transcript the
 * eval exists to grade.
 *
 * SAFETY. The sweep is disarmed until the driven agent's account id is known
 * (`setAgentAccount`). Before that, an agent-vs-counterpart match looks exactly
 * like a counterpart-vs-outsider one, and the guard would mute the agent
 * against her own scripted counterpart — silently breaking every later run.
 * Both harnesses learn her account id from her first card, so the disarmed
 * window is short.
 *
 * WRITES. `match_mutes` only: an additive hygiene table the matcher reads.
 * Nothing here deletes or updates a row in matches, cards, accounts or any
 * consent-related table.
 *
 * BEST-EFFORT. Every entry point swallows its own errors and logs a warning.
 * A guard that fails must never fail a run — the run is the expensive thing.
 *
 * The sim harness's `dbExec` is reached through a LAZY import so that the unit
 * test covering the logic below can import this file without dragging in the
 * integration helpers (AWS clients at module scope, and a runner-detecting
 * teardown hook that would attach itself to whatever suite loaded it).
 */

/** The DB door: `dbExec` from the sim harness, or a fake in unit tests. */
export type Exec = (
  sql: string,
  parameters?: { name: string; value: any }[],
) => Promise<any[][]>;

export interface MatchRow {
  matchId: string;
  accountWant: string;
  accountHave: string;
}

/** One match with a run account on one side and someone else on the other. */
export interface Crossing {
  matchId: string;
  /** The run account that is a party to it. */
  runAccountId: string;
  /** The account that is NOT part of this run — the person to leave alone. */
  outsiderAccountId: string;
}

/** How many mute pairs go in one INSERT (two bound parameters per pair). */
export const MUTE_INSERT_CHUNK = 200;

/** The live door: the sim harness's RDS Data API exec, loaded on first use. */
const liveExec: Exec = async (sql, parameters) => {
  const { dbExec } = await import('../sim/harness.js');
  return dbExec(sql, parameters);
};

const consoleLine = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(msg);
};

// ---------------------------------------------------------------------------
// Pure logic — everything below the DB, and everything worth unit-testing.
// ---------------------------------------------------------------------------

/** Trim, lower-case and de-duplicate a set of account ids; drop the empties. */
export function normaliseIds(ids: (string | undefined | null)[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const v = (id ?? '').trim().toLowerCase();
    if (v) out.add(v);
  }
  return [...out];
}

/**
 * Matches created since the run started where exactly one side is a run
 * account. Both this and the SQL apply the XOR: the SQL so the result set stays
 * small, this so the rule is asserted somewhere a test can reach it.
 */
export function buildOutsiderQuery(
  runAccountIds: string[],
  sinceIso: string,
): { sql: string; parameters: { name: string; value: any }[] } {
  const ids = normaliseIds(runAccountIds);
  return {
    sql: `WITH run AS (SELECT unnest(string_to_array(:ids, ','))::uuid AS id)
          SELECT m.id::text, m.account_want::text, m.account_have::text
            FROM matches m
           WHERE m.created_at > :since::timestamptz
             AND (m.account_want IN (SELECT id FROM run))
                 <> (m.account_have IN (SELECT id FROM run))
           ORDER BY m.created_at`,
    parameters: [
      { name: 'ids', value: ids.join(',') },
      { name: 'since', value: sinceIso },
    ],
  };
}

/**
 * Split the rows into crossings (one run account, one outsider). A row with
 * both sides inside the run — the eval's own intended pairing — is NOT a
 * crossing and is left completely alone.
 */
export function classifyCrossings(rows: MatchRow[], runAccountIds: string[]): Crossing[] {
  const run = new Set(normaliseIds(runAccountIds));
  const out: Crossing[] = [];
  for (const r of rows) {
    const want = (r.accountWant ?? '').trim().toLowerCase();
    const have = (r.accountHave ?? '').trim().toLowerCase();
    const wantIn = run.has(want);
    const haveIn = run.has(have);
    if (wantIn === haveIn) continue; // both ours, or neither: not our business
    out.push({
      matchId: r.matchId,
      runAccountId: wantIn ? want : have,
      outsiderAccountId: wantIn ? have : want,
    });
  }
  return out;
}

/** The distinct outsider account ids in a set of crossings, in first-seen order. */
export function outsidersOf(crossings: Crossing[]): string[] {
  return normaliseIds(crossings.map((c) => c.outsiderAccountId));
}

/**
 * Every mute row needed to sever a set of outsiders from a run: BOTH
 * directions, every run account against every outsider. Self-pairs are
 * impossible by construction and dropped anyway; duplicates are collapsed so a
 * single statement never presents the same primary key twice.
 */
export function mutePairs(runAccountIds: string[], outsiders: string[]): [string, string][] {
  const run = normaliseIds(runAccountIds);
  const others = normaliseIds(outsiders);
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const outsider of others) {
    for (const mine of run) {
      if (mine === outsider) continue;
      for (const [a, b] of [
        [mine, outsider],
        [outsider, mine],
      ] as [string, string][]) {
        const key = `${a}|${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

/** Chop a list into fixed-size batches (the RDS Data API takes bound params). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The idempotent insert, in the shape domain/matches.ts uses for the same
 * table: named columns, ON CONFLICT DO NOTHING, and RETURNING so the caller can
 * say how many rows were genuinely new.
 */
export function buildMuteInsert(pairs: [string, string][]): {
  sql: string;
  parameters: { name: string; value: any }[];
} {
  const values = pairs.map((_, i) => `(:a${i}::uuid, :b${i}::uuid)`).join(', ');
  const parameters: { name: string; value: any }[] = [];
  pairs.forEach(([a, b], i) => {
    parameters.push({ name: `a${i}`, value: a }, { name: `b${i}`, value: b });
  });
  return {
    sql: `INSERT INTO match_mutes (account_id, muted_account)
          VALUES ${values}
          ON CONFLICT DO NOTHING
          RETURNING account_id::text`,
    parameters,
  };
}

// ---------------------------------------------------------------------------
// The guard itself
// ---------------------------------------------------------------------------

export interface MuteOptions {
  /**
   * Run accounts this process drives over MCP (the scripted counterpart). A
   * crossing whose run side is one of these can also be declined properly,
   * through the same door a person's agent uses.
   */
  declinable?: string[];
  /** respond(decline) on a crossing match, as the declinable run account. */
  decline?: (matchId: string) => Promise<boolean>;
  /** DB door; defaults to the sim harness's dbExec against dev. */
  exec?: Exec;
  /** Where the guard talks; defaults to the harness log. */
  logLine?: (msg: string) => void;
}

export interface MuteResult {
  /** Outsider account ids this call muted against every run account. */
  muted: string[];
  /** Crossings the run's own controlled account successfully declined. */
  declined: number;
}

/**
 * Find every outsider a run has bumped into since `sinceIso` and mute the pair
 * permanently, both directions, against every run account. Where a decline
 * function is supplied and the crossing's run side is one this process
 * controls, the introduction is also declined so it does not sit pending on the
 * real person's page.
 *
 * Throws only if the DB itself refuses — callers treat that as a warning.
 */
export async function muteOutsiders(
  runAccountIds: string[],
  sinceIso: string,
  opts: MuteOptions = {},
): Promise<MuteResult> {
  const exec = opts.exec ?? liveExec;
  const say = opts.logLine ?? consoleLine;
  const run = normaliseIds(runAccountIds);
  if (!run.length) return { muted: [], declined: 0 };

  const q = buildOutsiderQuery(run, sinceIso);
  const rows = await exec(q.sql, q.parameters);
  const crossings = classifyCrossings(
    rows.map((r) => ({
      matchId: String(r[0]),
      accountWant: String(r[1]),
      accountHave: String(r[2]),
    })),
    run,
  );
  const outsiders = outsidersOf(crossings);
  if (!outsiders.length) return { muted: [], declined: 0 };

  // 1. Mute first: the pair is severed before anything else is attempted, so a
  //    failure further down still leaves the outsider protected from the NEXT
  //    card this run posts.
  const pairs = mutePairs(run, outsiders);
  let inserted = 0;
  for (const batch of chunk(pairs, MUTE_INSERT_CHUNK)) {
    const ins = buildMuteInsert(batch);
    const written = await exec(ins.sql, ins.parameters);
    inserted += written.length;
  }
  // Ids only. Nothing about who these people are is selected or printed.
  say(
    `outsider guard: muted ${outsiders.length} outsider account(s) against ${run.length} run account(s) ` +
      `(${inserted} new mute rows of ${pairs.length}): ${outsiders.join(', ')}`,
  );

  // 2. Decline the crossings we can decline honestly — only where the run side
  //    is an account this process holds a token for.
  let declined = 0;
  const declinable = new Set(normaliseIds(opts.declinable ?? []));
  if (opts.decline && declinable.size) {
    for (const c of crossings) {
      if (!declinable.has(c.runAccountId)) continue;
      try {
        if (await opts.decline(c.matchId)) declined++;
      } catch (e) {
        say(`outsider guard: decline of ${c.matchId} failed: ${(e as Error).message}`);
      }
    }
    if (declined) say(`outsider guard: declined ${declined} crossing introduction(s)`);
  }
  return { muted: outsiders, declined };
}

export interface OutsiderGuardOptions extends MuteOptions {
  /** ISO time the run started. Only matches created after it are considered. */
  since: string;
  /** Run accounts known up front (the scripted counterpart's, typically). */
  runAccountIds?: string[];
}

/**
 * A run-scoped wrapper: remembers the run's accounts as they are discovered,
 * refuses to sweep until the driven agent's account id is known, serialises its
 * sweeps, and never throws.
 */
export class OutsiderGuard {
  private readonly opts: OutsiderGuardOptions;
  private readonly runAccounts = new Set<string>();
  private readonly mutedAlready = new Set<string>();
  private agentAccountId?: string;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: OutsiderGuardOptions) {
    this.opts = opts;
    for (const id of normaliseIds(opts.runAccountIds ?? [])) this.runAccounts.add(id);
  }

  private say(msg: string): void {
    (this.opts.logLine ?? consoleLine)(msg);
  }

  addRunAccount(id: string | undefined): void {
    for (const v of normaliseIds([id])) this.runAccounts.add(v);
  }

  /**
   * The driven agent's account id, learned in-run from her first card. The
   * guard stays disarmed until this is set — see the SAFETY note at the top.
   */
  setAgentAccount(id: string | undefined): void {
    const [v] = normaliseIds([id]);
    if (!v || this.agentAccountId === v) return;
    this.agentAccountId = v;
    this.runAccounts.add(v);
    this.say(`outsider guard: armed (agent account ${v})`);
  }

  get armed(): boolean {
    return !!this.agentAccountId && this.runAccounts.size > 0;
  }

  /** Sweep now. Serialised, best-effort: logs and returns zeroes on failure. */
  sweep(reason: string): Promise<MuteResult> {
    const next = this.chain.then(() => this.sweepNow(reason));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async sweepNow(reason: string): Promise<MuteResult> {
    if (!this.armed) return { muted: [], declined: 0 };
    try {
      const r = await muteOutsiders([...this.runAccounts], this.opts.since, {
        ...this.opts,
        // Outsiders already severed stay severed; do not re-write or re-log
        // them on every sweep. Declines still run for their crossings.
        logLine: (m) => this.say(m),
      });
      const fresh = r.muted.filter((id) => !this.mutedAlready.has(id));
      for (const id of r.muted) this.mutedAlready.add(id);
      if (fresh.length) this.say(`outsider guard (${reason}): newly severed ${fresh.join(', ')}`);
      return r;
    } catch (e) {
      this.say(`outsider guard (${reason}) failed, continuing: ${(e as Error).message}`);
      return { muted: [], declined: 0 };
    }
  }

  /**
   * Sweep shortly — long enough for the matcher to have run on a card that was
   * just posted, short enough that a stray greeting has nowhere to happen. Does
   * not block the caller; `flush()` settles it.
   */
  sweepSoon(reason: string, delayMs = 15_000): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.sweep(reason);
    }, delayMs);
    // A pending hygiene sweep must not keep a finished run's process alive.
    t.unref?.();
    this.timers.add(t);
  }

  /** Cancel anything scheduled, let anything running finish, then sweep once. */
  async flush(reason = 'teardown'): Promise<MuteResult> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await this.chain.catch(() => undefined);
    return this.sweep(reason);
  }
}
