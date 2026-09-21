/**
 * THE POSTING'S OWN NUMBER, AND THE ONE THING EVERY QUESTION IS KEYED ON.
 *
 * The rehearsal that bought this (21 September 2026, three times in one day).
 * A posting that came back with a question was remembered by a fingerprint
 * built out of the agent's own prose: the poster's words for the thing, and the
 * amounts on it. The other questions in the same flow ask the agent to REWORD
 * that very thing. So an agent posted "upgraded Fanatec pedal spring, $10", was
 * asked whether the ten dollars was its human's own figure, asked its human,
 * was told yes, and posted again as "Fanatec ClubSport V3 brake performance
 * spring, $10" — because the detail question beside it had asked for exactly
 * that. New words, new key, same question. Four rounds, and then the agent told
 * its human it was posted when nothing had gone up at all.
 *
 * Two mechanisms, each sensible alone, that together make a posting impossible.
 *
 * SO THE THING'S NAME IS NOT A KEY ANY MORE. The first time a posting attempt
 * comes back with anything, a reference is minted and handed over with the
 * refusal. Every later question about that same attempt carries it, the agent
 * sends it back on its next attempt, and that is what ties a question to the
 * posting it belongs to. No time window softens it — one was considered and
 * rejected as needless complication. No reference means a genuinely new
 * attempt, so the questions are asked, and that is the whole of the fallback.
 *
 * THE AMOUNT STAYED, AND THE DISTINCTION IS THE POINT. The name had to go
 * because the other questions explicitly ask the agent to change it. Nothing in
 * the flow ever asks an agent to change a price, and the amount is precisely
 * what the figure gate is checking, so the reference sits BESIDE the figures
 * rather than in place of them: the same reference with the same figures is a
 * question already answered, and the same reference with a different figure is
 * asked again (`amounts` below, and confirmFigures in domain/cards.ts). The
 * detail and reach gates key on the reference alone, because what they ask
 * about has no equivalent worth holding — the detail gate's answer IS the
 * sharpened words, which are the one thing that must never be a key.
 *
 * THE REFERENCE IS THE POSTING'S ID. It is minted as a uuid and, when the
 * posting finally goes up, it is the id the posting is given (domain/cards.ts
 * passes it to the INSERT). One number, from the first question through to the
 * conversations that follow, so an agent never has to work out that two numbers
 * mean the same want or have. An amend needs none of its own: the posting it
 * amends already has one, and `intent_id` is that number already.
 *
 * IT IS MACHINERY AND IS NEVER READ TO A HUMAN, the same rule the manual
 * already carries for a posting's id — which, being the same number, is the
 * same rule. Nothing the gates write invites an agent to say it out loud.
 *
 * AND IT HOLDS NOT ONE WORD ABOUT THE THING. The account, the names of the
 * gates that have already asked, and the figures the figure gate read back. The
 * table it replaces carried the poster's own words for the thing, because the
 * words were the key; nothing here does. The figures are the same plaintext
 * that table held, so they are no new disclosure — and they are still somebody's
 * private business, so the row is deleted the moment the posting goes up, an
 * abandoned attempt is swept after a week, and no log line ever carries one.
 */
import { randomUUID } from 'node:crypto';
import { getPool } from '../db.js';

/** The gates that ask a question about a posting attempt, by name. */
export type PostingGate = 'detail' | 'reach' | 'figure';

/** An attempt the switchboard has already said something about. */
export interface PostingRef {
  /** The number itself, which becomes the posting's id if it goes up. */
  reference: string;
  /** The gates that have already asked on this attempt. */
  asked: PostingGate[];
  /**
   * The figures the figure gate last read back on this attempt, as
   * figureAmountsKey writes them (domain/postingFigure.ts). Undefined until it
   * has asked. The reference says which posting; this says what was confirmed
   * on it, and the figure gate needs both — see the note on that function for
   * why the amounts stayed when the thing's name had to go.
   */
  amounts?: string;
}

/** A uuid and nothing else. Anything else the agent sends is not a reference. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The reference as it arrived, or undefined where nothing usable did. */
export const referenceOf = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return UUID.test(s) ? s.toLowerCase() : undefined;
};

/**
 * The attempt this reference names, if there is one and it is this account's.
 *
 * WHOSE IT IS, asked here and nowhere else. The account is half the lookup, so
 * a reference minted for somebody else matches no row and reads as no reference
 * at all — a new attempt, and the questions are asked. Nothing an agent can
 * send here reaches another account's posting: the reference is only ever used
 * to excuse a question on the attempt the SAME account is making, and to become
 * the id of a row inserted under that same account.
 */
export async function readPostingRef(
  accountId: string,
  reference: unknown,
): Promise<PostingRef | undefined> {
  const ref = referenceOf(reference);
  if (!ref) return undefined;
  try {
    const r = await getPool().query(
      `SELECT reference, asked, asked_amounts FROM posting_references
        WHERE reference = $1 AND account_id = $2`,
      [ref, accountId],
    );
    const row = r.rows[0] as
      | { reference: string; asked: string[]; asked_amounts: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      reference: row.reference,
      asked: (row.asked ?? []) as PostingGate[],
      amounts: row.asked_amounts ?? undefined,
    };
  } catch {
    // The table is unreachable. Believing the agent is the kinder failure, and
    // the same one the old row made: the alternative is trapping a human behind
    // a question nobody can answer. The reference is a uuid this switchboard
    // minted and handed to this agent, so there is nothing here to guess at.
    //
    // `amounts` is deliberately left out: there is no figure to claim was
    // confirmed, so the figure gate falls to its own comparison and asks. A
    // read-back that cannot prove it happened is one worth doing again.
    return { reference: ref, asked: ['detail', 'reach', 'figure'] };
  }
}

/**
 * Write down that a gate has asked, minting the reference where this is the
 * first thing the switchboard has said about the attempt.
 *
 * Returns the reference to put on the refusal. Never fails a publish: a record
 * that could not be written costs the next attempt one more round of the same
 * question, which is the ordinary failure this switchboard already accepts.
 */
export async function noteAsked(
  accountId: string,
  known: string | undefined,
  gate?: PostingGate,
  /** The figures just read back, where the gate doing the asking is the one
   *  that reads figures back. Written as they were said to the human. */
  amounts?: string,
): Promise<string> {
  // An amend hands in the posting's own id, which IS its reference; a publish
  // hands in the one the agent sent back, or nothing at all on a first contact.
  const reference = known ?? randomUUID();
  const asked = gate ? [gate] : [];
  try {
    await getPool().query(
      // The figures REPLACE what stood there rather than joining it: what an
      // attempt is excused for is the last set somebody was actually asked
      // about, so reading $45 back after $10 must not leave the $10 excused.
      // A gate that carries no figures (detail, reach) leaves the column alone.
      `INSERT INTO posting_references (reference, account_id, asked, asked_amounts)
       VALUES ($1, $2, $3::text[], $4)
       ON CONFLICT (reference) DO UPDATE
          SET asked = (SELECT coalesce(array_agg(DISTINCT g), '{}'::text[])
                         FROM unnest(posting_references.asked || $3::text[]) AS g),
              asked_amounts = COALESCE($4, posting_references.asked_amounts)
        WHERE posting_references.account_id = $2`,
      [reference, accountId, asked, amounts ?? null],
    );
  } catch {
    /* the record is a courtesy to the next attempt; the refusal is the point */
  }
  return reference;
}

/**
 * THE ATTEMPT IS OVER, so what it was asked is forgotten.
 *
 * Called the moment the posting goes up or the amend goes through. It is what
 * keeps a reference from excusing a question for ever: on a publish the row's
 * number has just become the posting's id and the going-back-and-forth is
 * finished, and on an amend — where the reference IS the posting's id and so
 * outlives any one attempt — clearing it is what makes the NEXT amend, with a
 * different figure on it, a question that gets asked.
 */
export async function closePostingRef(reference: string | undefined): Promise<void> {
  if (!reference) return;
  try {
    await getPool().query(`DELETE FROM posting_references WHERE reference = $1`, [reference]);
  } catch {
    /* a row left standing costs one skipped question on the next attempt */
  }
}

/**
 * How long an attempt nobody came back for is kept. Long enough for "I'll ask
 * him when he's home tomorrow", short enough that the table stays a working set
 * rather than a record of who was asked what.
 */
export const POSTING_REF_SWEEP_DAYS = 7;

/** The sweep, on the ordinary ops tick. Counts only. */
export async function sweepPostingRefs(): Promise<{ references: number }> {
  const r = await getPool().query(
    `DELETE FROM posting_references WHERE opened_at < now() - make_interval(days => $1::int)`,
    [POSTING_REF_SWEEP_DAYS],
  );
  return { references: r.rowCount ?? 0 };
}
