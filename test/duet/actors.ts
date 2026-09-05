/**
 * The two HUMAN accounts the duet runs on — Priya (seller, driven by Nagatha)
 * and Marlowe (buyer, driven by agent B) — and the file that carries them
 * between the one-time provisioning step and the run.
 *
 * WHY BOTH SIDES ARE FRESH ACCOUNTS. The realism eval drove Nagatha against her
 * long-lived dev account (411af5b9…) and could go no further than stage 2: the
 * stage-3 opt-in and the offer acceptance both happen on the HUMAN's approval
 * page, behind an email-code sign-in, and that account's email address is not
 * recoverable (the column is encrypted; nothing in the repo or the box records
 * it). A duet that cannot click either approval page stalls at exactly the wall
 * the realism report already documented.
 *
 * So the duet provisions a fresh dev account for EACH side and points the
 * agent at it. That buys the thing the eval exists to measure: both approval
 * pages are real pages this harness can sign in to and press, so the run can
 * go all the way to a channel, an offer and an archive. Nagatha's original
 * agent key is backed up and restored at teardown, so her long-lived account is
 * left exactly as it was found.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Jar, counterLogin, ensurePin } from '../integration/helpers.js';

/** Where the provisioned credentials live. Under realism-reports/, which is
 *  gitignored — these are live dev credentials and must never be committed. */
export const ACTORS_FILE = join(process.cwd(), 'realism-reports', '.duet-actors.json');

export interface DuetActor {
  /** 'priya' (seller, Nagatha) or 'marlowe' (buyer, agent B). */
  side: 'priya' | 'marlowe';
  firstName: string;
  locality: string;
  email: string;
  accountId: string;
  pin: string;
  /** The agent key the agent's MCP client presents (osb_ak_…). */
  agentKey: string;
  /** The handle the approval page revokes that key by. */
  agentKeyId: string;
  /** An OAuth access token for this account — the harness's own MCP door,
   *  used ONLY for teardown (withdrawing this account's leftover cards). The
   *  agents never see it and the harness never speaks on their behalf. */
  accessToken: string;
  createdAt: string;
}

export interface DuetActors {
  priya: DuetActor;
  marlowe: DuetActor;
  /** Nagatha's original openswitchboard MCP header, for restoring her box. */
  nagathaOriginalAuthHeader?: string;
  provisionedAt: string;
}

export function readActors(file = ACTORS_FILE): DuetActors {
  if (!existsSync(file)) {
    throw new Error(
      `no provisioned duet actors at ${file} — run: RUN_DUET_PROVISION=1 npx tsx test/duet/provision.ts`,
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as DuetActors;
}

export function writeActors(a: DuetActors, file = ACTORS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(a, null, 2), { mode: 0o600 });
}

/**
 * Re-establish a signed-in counter session for one side, the way its human
 * would: email code sign-in, then the PIN. Sessions do not survive between
 * processes, so the run does this once per side at start-up and holds the jar
 * for the approval-page steps it performs later.
 */
export async function signIn(actor: DuetActor): Promise<Jar> {
  const jar = new Jar();
  await counterLogin(jar, actor.email);
  await ensurePin(jar, actor.pin);
  return jar;
}
