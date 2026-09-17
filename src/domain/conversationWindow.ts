/**
 * The conversation budget: how long one human's go-ahead lasts.
 *
 * Two agents talk unattended once both humans have pressed the names page, and
 * until now that one press was the whole of the consent: an agent could carry
 * on a conversation for a month without its human ever being asked again
 * whether it still mattered. This is the answer to that, and it is deliberately
 * the smallest one that works. No new emails, no new gate before talking, and
 * nothing the other side can see.
 *
 * ONE WINDOW PER SIDE, AND IT IS THAT SIDE'S OWN. A press grants that human's
 * agent so many messages sent by that side, or so many days, whichever ends
 * first. It says nothing about what the other side may send, and the other side
 * is never told anything about it: a paused conversation looks, from over
 * there, exactly like a conversation whose reply has not come yet. Telling them
 * would be a disclosure about somebody's attention that nobody consented to.
 *
 * WHAT A PAUSE IS NOT. It is not an ending, and nothing is lost. The other
 * side's messages keep arriving and keep being collectable, so a paused agent
 * can still bring its human everything that comes in. The only thing that stops
 * is sending, and one press starts a fresh window.
 *
 * The spend is ONE STATEMENT. The budget is enforced by the same UPDATE that
 * increments the count, so two calls racing cannot both slip past the last
 * message — the second one matches no row and is paused. It is the shape the
 * hourly slot already uses in domain/channel.ts, for the same reason.
 */
import { getPool } from '../db.js';
import { OsbError } from '../protocol.js';
import type { Config } from '../config.js';

/** What the agent is told when its own side has run out. */
export const CONVERSATION_PAUSED_WORDS =
  'The conversation is paused on your side until your human says to keep going. ' +
  'Ask them with respond(request_keep_talking): hand over the page it gives you, say what it asks, ' +
  'and wait on the press. Nothing is lost, and you can still collect whatever the other side sends.';

/** Where a window came from, for the record on the row. */
export type WindowGrantedVia = 'names-press' | 'renewal-press' | 'backfill';

export interface WindowState {
  /** Has this side spent its window? */
  paused: boolean;
  /** Messages this side has sent inside the current window. */
  sent: number;
  /** How many are left in it, never below zero. */
  remaining: number;
}

/**
 * Open a window for a side that has none, dated from that human's own names
 * press.
 *
 * recordStage3OptIn calls this the moment the press lands, which is the
 * ordinary path. The lazy call from the send path is for an introduction whose
 * opt-ins were recorded before this table existed and which the migration's
 * backfill did not reach — one that had both opt-ins but no conversation open
 * yet. Dating it from the opt-in rather than from now is what keeps the clock
 * honest: the days were granted by that press and have been running since.
 *
 * ON CONFLICT DO NOTHING, so a row that is already there — including a fresh
 * one from a renewal — is never wound back by a late call to this.
 */
export async function openWindowFromOptIn(
  matchId: string,
  accountId: string,
  grantedVia: WindowGrantedVia = 'names-press',
): Promise<void> {
  await getPool().query(
    `INSERT INTO conversation_windows (match_id, account_id, started_at, messages_sent, granted_via)
     SELECT $1, $2, COALESCE(
              (SELECT recorded_at FROM consent_tokens
                WHERE match_id = $1 AND account_id = $2 AND kind = 'stage3-optin'),
              now()),
            0, $3
     ON CONFLICT (match_id, account_id) DO NOTHING`,
    [matchId, accountId, grantedVia],
  );
}

/**
 * A fresh window for this side, from now. The press on the renewal page is the
 * only caller, and it may come at any time: renewing early is allowed on
 * purpose, because a human who has just said "yes, keep going" should not have
 * to wait for the old window to run out before their yes means anything.
 */
export async function startFreshWindow(
  matchId: string,
  accountId: string,
  grantedVia: WindowGrantedVia = 'renewal-press',
): Promise<void> {
  await getPool().query(
    `INSERT INTO conversation_windows (match_id, account_id, started_at, messages_sent, granted_via)
     VALUES ($1, $2, now(), 0, $3)
     ON CONFLICT (match_id, account_id)
     DO UPDATE SET started_at = now(), messages_sent = 0, granted_via = EXCLUDED.granted_via`,
    [matchId, accountId, grantedVia],
  );
}

/**
 * Spend one message of this side's window, or say it is spent.
 *
 * The WHERE clause is the budget: below the count AND inside the days. Zero
 * rows back means one of the two has run out, or that there is no row at all —
 * and all three are the same answer to the caller, which is that this side is
 * paused. The caller creates a missing row and asks once more before believing
 * it.
 */
export async function spendMessage(
  cfg: Config | undefined,
  matchId: string,
  accountId: string,
): Promise<{ spent: boolean; sent: number; remaining: number }> {
  const budget = budgetOf(cfg);
  const r = await getPool().query(
    `UPDATE conversation_windows
        SET messages_sent = messages_sent + 1
      WHERE match_id = $1 AND account_id = $2
        AND messages_sent < $3
        AND started_at > now() - ($4 || ' days')::interval
      RETURNING messages_sent`,
    [matchId, accountId, budget.messages, String(budget.days)],
  );
  if (!r.rowCount) return { spent: false, sent: budget.messages, remaining: 0 };
  const sent = Number(r.rows[0].messages_sent);
  return { spent: true, sent, remaining: Math.max(0, budget.messages - sent) };
}

/**
 * The same question asked without spending anything, for the sweep's notes.
 * A side with no row is reported as paused, which is what the send path would
 * do with it too once it had tried to open one.
 */
export async function readWindow(
  cfg: Config | undefined,
  matchId: string,
  accountId: string,
): Promise<WindowState> {
  const budget = budgetOf(cfg);
  const r = await getPool().query(
    `SELECT messages_sent,
            started_at > now() - ($3 || ' days')::interval AS in_time
       FROM conversation_windows WHERE match_id = $1 AND account_id = $2`,
    [matchId, accountId, String(budget.days)],
  );
  const row = r.rows[0];
  if (!row) return { paused: true, sent: 0, remaining: 0 };
  const sent = Number(row.messages_sent ?? 0);
  const paused = !row.in_time || sent >= budget.messages;
  return { paused, sent, remaining: paused ? 0 : Math.max(0, budget.messages - sent) };
}

/** The two figures, with the defaults a caller without a config would use. */
export function budgetOf(cfg?: Config): { messages: number; days: number } {
  return {
    messages: cfg?.conversationBudgetMessages ?? 40,
    days: cfg?.conversationBudgetDays ?? 7,
  };
}

/** The refusal, in the one shape the whole surface answers refusals in. */
export function conversationPaused(): OsbError {
  return new OsbError('CONVERSATION_PAUSED', { human_action: CONVERSATION_PAUSED_WORDS });
}

/**
 * How near the edge is near enough to say so, so an agent can ask its human
 * ahead of time rather than in the middle of carrying something across.
 */
export const REMAINING_WARNING_AT = 10;

/** The sweep's sentence for a side that is paused. */
export const PAUSED_SWEEP_SENTENCE =
  'Your side of this conversation is paused until your human says keep going.';

/** And the one for a side that is nearly there. */
export function remainingSentence(remaining: number): string {
  return remaining === 1
    ? 'One more message will go from your side on this one before your human is asked whether to keep going. Ask them now rather than mid-sentence.'
    : `${remaining} more messages will go from your side on this one before your human is asked whether to keep going. Ask them before you run out.`;
}
