/**
 * A report, and the three things it does at once
 * (docs/trust-and-safety.md, "Reporting" and "Enforcement"; step 5).
 *
 * One human presses one button on one page, and:
 *
 *   SEVER   the introduction closes. Nothing more is delivered either way, and
 *           each side is told, in a sentence, what happened to it — the
 *           reporter that their report closed it, the other person that the
 *           switchboard closed it and not one thing more.
 *   BLOCK   the pairing is muted, which is the same mute a 'bad' verdict puts
 *           on. The matcher never puts these two accounts together again.
 *   PRESERVE every ledger entry behind that introduction is held ninety days,
 *           so the evidence outlives the thirty-day sweep and is still there
 *           when somebody looks. Nothing is read and nothing is decrypted: that
 *           takes two keyholders and it is a separate act.
 *
 * AND THE OPERATOR IS TOLD. One line, carrying the report id and the
 * introduction id and nothing else — no words, no accounts, no content. The
 * words of the report are in the ledger and in the reports table, which is
 * where a person reads them, under the ordinary ceremony.
 *
 * A REPORT IS NEVER REFUSED. The words go through the pipe at a door that
 * cannot refuse (intake/pipe.ts, REFUSAL_FREE_DOORS): a figure or a phone
 * number in the box holds the words for a person to read, and the report
 * itself stands either way. Somebody frightened enough to report a stranger is
 * never handed their own words back with a note about phrasing.
 */
import { getPool } from '../db.js';
import { runIntake } from '../intake/pipe.js';
import { preserveEntriesForMatch } from './ledger.js';
import { getMatch, severMatch, sideOf } from '../domain/matches.js';
import type { Config } from '../config.js';

/** As long a line as the page takes, and as the column allows. */
export const REASON_MAX_CHARS = 300;

/**
 * How long the entries behind a reported introduction are held. Ninety days
 * rather than thirty: the thirty-day window is what the switchboard keeps
 * about people in the ordinary course, and a report is the moment somebody
 * asked for a person to look. The doc's number.
 */
export const REPORT_PRESERVE_DAYS = 90;

/** The line the operator gets. No content, ever — an id and an id. */
export function reportLogLine(reportId: string, matchId: string | null): string {
  return JSON.stringify({ event: 'report', report_id: reportId, match_id: matchId });
}

export interface ReportOutcome {
  report_id: string;
  match_id: string;
  /** False where the words were held rather than written: see the pipe. */
  words_kept: boolean;
  severed: boolean;
  preserved: number;
}

/** What a reason has to be before it is stored. Never a reason to refuse. */
export function readReason(raw: unknown): string | undefined {
  const words = typeof raw === 'string' ? raw.trim() : '';
  if (!words) return undefined;
  return words.slice(0, REASON_MAX_CHARS);
}

/**
 * File one. Called from the press on the one-question page and from nowhere
 * else: minting the link changes nothing, and this is the act.
 */
export async function fileReport(
  cfg: Config | undefined,
  input: { reporterAccount: string; matchId: string; reason?: unknown },
  opts: { warn?: (line: string) => void } = {},
): Promise<ReportOutcome> {
  const m = await getMatch(input.matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  // Throws notFound when the caller is not a party: you may report the person
  // you were introduced to and nobody else.
  const side = sideOf(m, input.reporterAccount);
  const reported = side === 'want' ? m.account_have : m.account_want;
  const reason = readReason(input.reason);

  // The words through the pipe. A pass writes them; anything else holds them,
  // and the ledger keeps the body either way because a hold keeps its body.
  let words_kept = true;
  if (reason) {
    const verdict = await runIntake(cfg, {
      door: 'report',
      sender_account: input.reporterAccount,
      recipient_account: reported,
      match_id: input.matchId,
      text: reason,
    });
    words_kept = verdict.outcome === 'pass';
  }

  const pool = getPool();
  const inserted = await pool.query(
    `INSERT INTO reports (reporter_account, reported_account, match_id, reason_words)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.reporterAccount, reported, input.matchId, words_kept ? (reason ?? null) : null],
  );
  const reportId = inserted.rows[0].id as string;

  // SEVER. The state leaving 'open' is what stops delivery both ways.
  const severed = await severMatch(input.matchId, input.reporterAccount, cfg);

  // BLOCK. One row is enough: the matcher reads the mute in both directions
  // (migrations/003_matching.sql), and this is the same mute a 'bad' verdict
  // puts on, on purpose — there is one way these two never meet again.
  await pool.query(
    `INSERT INTO match_mutes (account_id, muted_account) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [input.reporterAccount, reported],
  );

  // PRESERVE. A date moves; nothing is read.
  const until = new Date(Date.now() + REPORT_PRESERVE_DAYS * 24 * 60 * 60 * 1000);
  const { preserved } = await preserveEntriesForMatch(input.matchId, until);

  // TELL THE OPERATOR. A line at warn, with two ids on it. There is no abuse
  // address on this deployment's config to email, and a line that carried
  // anything of what was said would put the words of a report into the logs,
  // which is the one place in this system they are never allowed to be.
  (opts.warn ?? ((line: string) => console.warn(line)))(reportLogLine(reportId, input.matchId));

  return {
    report_id: reportId,
    match_id: input.matchId,
    words_kept,
    severed: severed.severed,
    preserved,
  };
}
