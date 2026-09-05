/**
 * THE BINDING PROBE — proof, before the run says a word about bikes, that each
 * agent's MCP client is actually talking to THIS run's account.
 *
 * WHY IT EXISTS. The run points each agent at a freshly provisioned account by
 * writing an Authorization header into its OpenClaw config. Nothing in that
 * write guarantees the header is the one that reaches the switchboard on the
 * next turn: Nagatha's MCP client lives inside a long-running gateway that
 * holds its server connections open, so a key swapped underneath it can be
 * applied lazily — the config on disk says one thing and the live connection
 * presents another. An agent still bound to the PREVIOUS run's account reads
 * that account's history, concludes the errand is already handled, posts
 * nothing, and the whole run deadlocks with an empty database timeline. That is
 * a harness fault which looks exactly like an agent fault, and it cost a run.
 *
 * WHAT IT MEASURES, AND WHY THAT AND NOT SOMETHING EASIER. The agents cannot be
 * asked "which account are you on?" — the switchboard never tells them an
 * account id, and an answer would be the agent's account of itself rather than
 * the truth. The truth is in the database. Every read tool (check_in,
 * list_intents, collect_messages) writes one `read_calls` row stamped with the
 * ACCOUNT the call authenticated as, because that is how the hourly read
 * ceiling is enforced (migrations/011, src/domain/quotas.ts). So the probe asks
 * the agent to go and look at its human's account, then reads which account the
 * switchboard billed for that look. A row for the run's account is the binding,
 * observed from the server's side.
 *
 * WHAT IT COSTS. One read against a 60-per-hour ceiling, and one session that
 * is NOT the run's session, so nothing it says can reach the briefed
 * conversation. The words are deliberately about nothing: look, tell me, change
 * nothing.
 */
import { dbExec } from '../sim/harness.js';

/** A neutral errand that can only be answered by calling a read tool. */
export const PROBE_UTTERANCE =
  'Quick one before anything else: have a look at my switchboard account and tell me what is on it right now — anything I have got listed, and anything waiting for me. Do not post or change anything, just look and tell me what is there.';

/** A blunter second try, for an agent that answered without going to look. */
export const PROBE_RETRY_UTTERANCE =
  'Please actually check the switchboard now and tell me exactly what it says is on my account.';

export interface ProbeRead {
  accountId: string;
  n: number;
}

export interface ProbeResult {
  ok: boolean;
  /** Read calls the switchboard recorded during the probe, by account. */
  reads: ProbeRead[];
  /** Attempts spent (1 or 2). */
  attempts: number;
  /** One line, fit for a log, a report row, or an error message. */
  detail: string;
  /** The agent's own words, kept out of the run transcript. */
  replies: string[];
}

/** The database's own clock, so a probe window never depends on this laptop's. */
export async function dbNow(): Promise<string> {
  const rows = await dbExec('SELECT now()::text');
  const t = rows[0]?.[0];
  if (!t) throw new Error('could not read the database clock for the binding probe');
  return String(t);
}

/** Which accounts the switchboard billed a read to since `sinceIso`. */
export async function readsSince(sinceIso: string): Promise<ProbeRead[]> {
  const rows = await dbExec(
    `SELECT account_id::text, count(*)::int
       FROM read_calls
      WHERE called_at > :since::timestamptz
      GROUP BY 1
      ORDER BY 2 DESC`,
    [{ name: 'since', value: sinceIso }],
  );
  return rows.map((r) => ({ accountId: String(r[0]), n: Number(r[1]) }));
}

export interface ProbeOptions {
  /** For messages: 'Nagatha' / "Marlowe's assistant". */
  label: string;
  /** The account this agent is supposed to be bound to for this run. */
  accountId: string;
  /** A session id that is NOT the run's, so the briefed conversation stays clean. */
  session: string;
  ask: (session: string, text: string) => Promise<{ text: string; toolsUsed?: string[] }>;
  /**
   * Account ids this harness can put a name to — previous runs' accounts,
   * typically. A read billed to one of these is the stale-key smoking gun and
   * is named in the failure. Accounts not in here are other people's and are
   * only ever counted, never identified.
   */
  known?: Record<string, string>;
  log?: (msg: string) => void;
}

/**
 * Ask the agent to look at its account, then read from the database which
 * account the switchboard charged for that look. Never throws for an agent
 * that simply did not call a tool: that comes back as `ok: false` with a
 * detail saying so, and the caller decides.
 */
export async function probeAccountBinding(opts: ProbeOptions): Promise<ProbeResult> {
  const say = opts.log ?? (() => undefined);
  const want = opts.accountId.toLowerCase();
  const replies: string[] = [];
  const utterances = [PROBE_UTTERANCE, PROBE_RETRY_UTTERANCE];
  let reads: ProbeRead[] = [];

  for (let attempt = 1; attempt <= utterances.length; attempt++) {
    const since = await dbNow();
    const reply = await opts.ask(opts.session, utterances[attempt - 1]);
    replies.push(reply.text);
    reads = await readsSince(since);
    const mine = reads.find((r) => r.accountId.toLowerCase() === want);
    if (mine) {
      const detail =
        `${opts.label} is bound to ${want.slice(0, 8)} — the switchboard billed ${mine.n} read call(s) ` +
        `to it during the probe${attempt > 1 ? ` (attempt ${attempt})` : ''}.`;
      say(`  probe: ${detail}`);
      return { ok: true, reads, attempts: attempt, detail, replies };
    }
    // A read billed to an account we can name is the fault we are looking for.
    const stale = reads.filter((r) => opts.known?.[r.accountId.toLowerCase()]);
    if (stale.length) {
      const detail =
        `${opts.label} is NOT on this run's account. The switchboard billed its read to ` +
        stale
          .map((r) => `${opts.known![r.accountId.toLowerCase()]} (${r.accountId.slice(0, 8)}, ${r.n} call(s))`)
          .join(', ') +
        `, not to ${want.slice(0, 8)}. The key swap did not reach the live MCP connection.`;
      say(`  probe: ${detail}`);
      return { ok: false, reads, attempts: attempt, detail, replies };
    }
    say(
      `  probe: ${opts.label} attempt ${attempt} recorded no read for ${want.slice(0, 8)} ` +
        `(${reads.length} other account(s) read in the window)`,
    );
  }

  const detail =
    `${opts.label} made no read call the switchboard could bill to ${want.slice(0, 8)} in ${utterances.length} attempts, ` +
    `so its binding could not be confirmed. Either the agent answered without calling a tool, or its MCP client is not connecting at all.`;
  return { ok: false, reads, attempts: utterances.length, detail, replies };
}
