/**
 * THE LEDGER OF ACCOUNTS THIS SUITE HAS EVER MADE, and what it is for.
 *
 * The founder's rule for these rehearsals is "everything is deleted and the run
 * starts again from the top". The orchestrating session is NOT permitted to
 * truncate the dev database, so "deleted" is built out of the two things that
 * actually matter:
 *
 *   1. Nobody from a previous run is on the board. Every PUBLISHED or
 *      PENDING_SCREENING card belonging to any account this suite has ever
 *      created is withdrawn at the END of a run and again at the START of the
 *      next one, and a run refuses to begin while one is still standing. An
 *      earlier run's spring meeting a later run's is not a finding about the
 *      product; it is the harness contaminating itself.
 *   2. Both sides are new people. Fresh accounts every run, so no assistant can
 *      read last run's history off its own account and conclude the errand is
 *      already handled — the failure duet/actors.ts documents at length.
 *
 * The file holds ACCOUNT IDS AND NOTHING ELSE. No email addresses, no PINs, no
 * agent keys: those belong to the run that minted them and die with it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dbExec, retireAccountCards } from '../integration/helpers.js';

export const LEDGER_FILE = join(process.cwd(), 'test', 'rehearsal', '.ledger.json');

export interface LedgerFile {
  /** Every account id the suite has minted, oldest first. */
  accounts: string[];
  updatedAt: string;
}

export function readLedger(file = LEDGER_FILE): LedgerFile {
  if (!existsSync(file)) return { accounts: [], updatedAt: new Date(0).toISOString() };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LedgerFile>;
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts.map(String) : [];
    return { accounts, updatedAt: String(parsed.updatedAt ?? '') };
  } catch {
    // A corrupt ledger must not stop a run, but it must not silently become an
    // empty one either: the caller sees an empty list and the start-of-run
    // assertion below still reads the board.
    return { accounts: [], updatedAt: new Date(0).toISOString() };
  }
}

export function rememberAccounts(ids: (string | undefined)[], file = LEDGER_FILE): LedgerFile {
  const current = readLedger(file);
  const merged = [...new Set([...current.accounts, ...ids.filter((i): i is string => !!i)])];
  const next: LedgerFile = { accounts: merged, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/** Take down every live card owned by any account the suite has ever made. */
export async function sweepLedgerCards(label: string, file = LEDGER_FILE): Promise<number> {
  const { accounts } = readLedger(file);
  if (!accounts.length) return 0;
  return retireAccountCards(accounts, `rehearsal ${label}`);
}

export interface BoardState {
  clear: boolean;
  live: { cardId: string; accountId: string; state: string }[];
}

/**
 * Is the board free of every earlier run's postings?
 *
 * Read AFTER the sweep, not instead of it: the sweep is an UPDATE and this is
 * the SELECT that proves it landed. A run that starts with one of its own
 * ancestors' cards still PUBLISHED is a run whose stage-1 "they met" check can
 * pass on the wrong pair.
 */
export async function boardIsClear(_file = LEDGER_FILE): Promise<BoardState> {
  // THE WHOLE BOARD, NOT JUST THE ACCOUNTS WE WROTE DOWN.
  //
  // This asked only about accounts in the ledger, which made it blind to
  // exactly the card it exists to catch: one from a run older than the ledger
  // itself. A "upgraded Fanatec pedal spring" posted on 19 September, filed
  // under goods.motoring before that was fixed, stayed live for two days. The
  // sweep did not retire it because it belonged to no account we knew, the
  // guard did not see it for the same reason, and every seller since was put
  // IN LINE behind it — one at a time by fit — so the names step never came
  // and the run failed on a link that was never offered (21 September 2026).
  //
  // Dev has no humans on it. Any live card at the start of a run is a
  // leftover, whoever made it, and the guard refuses rather than retires: a
  // card belonging to nobody we recorded is not ours to withdraw.
  const rows = await dbExec(
    `SELECT id::text, account_id::text, lifecycle_state
       FROM cards
      WHERE lifecycle_state IN ('PUBLISHED','PENDING_SCREENING')`,
  );
  const live = rows.map((r) => ({
    cardId: String(r[0]),
    accountId: String(r[1]),
    state: String(r[2]),
  }));
  return { clear: live.length === 0, live };
}
