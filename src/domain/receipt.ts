/**
 * THE RECORD OF WHAT WAS AGREED (2 October 2026).
 *
 * The switchboard introduces people and keeps records. It never judges a thing
 * and never judges a dispute; what it can do is make sure that evidence of what
 * was agreed exists, and that both people hold the same evidence. Until now an
 * accepted offer left the locked log saying only that a press happened, and
 * the one email about it went to one of the two people and carried a figure
 * and nothing else. A buyer had nothing to show for what was agreed.
 *
 * So at the moment a human accepts an offer, three things happen here:
 *
 *   1. A short block of plain facts is built, THE SAME BLOCK FOR BOTH PEOPLE:
 *      when, the thing as the seller posted it, the amount, the note that rode
 *      with the offer, the written lines the seller confirmed, and who the two
 *      are in as much as each has already been told about the other.
 *   2. The block is fingerprinted: SHA-256 over its canonical form.
 *   3. The fingerprint goes in the locked record beside the press, and the
 *      block goes to both people by email. The switchboard keeps the
 *      fingerprint and never the block, so either person can later show their
 *      email and anyone at all can work the fingerprint out again from it.
 *
 * WHAT MAY BE IN THE BLOCK is exactly what each of the two is already allowed
 * to see. The thing is read through buildAttributes, the function that serves
 * the details step to the buyer's own assistant, so the block can never say
 * more about a posting than that step does: the seller's screened words and
 * nothing off the live columns. The asking figure that step can carry is left
 * out on purpose, because the only figure in a record of what was agreed is
 * the one that was agreed. A private price band, a limit, a mandate, an email
 * address and anything else held under an account's own key are never read
 * here at all. First names and suburbs appear only where BOTH humans have
 * already pressed the names step on this introduction, checked against the
 * recorded presses themselves, the same hard gate buildMutual uses.
 *
 * THE LINES THE SELLER CONFIRMED (domain/confirmLines.ts) are in the block,
 * one per line, in the order they were asked. Only confirmed ones: a line
 * that was declined, taken off or never answered is not on the record.
 *
 * A RECORD IS BUILT WHENEVER AN OFFER IS ACCEPTED. Where the details step
 * would refuse the buyer right now (the posting has run out, or has no
 * screened words to show), the block is thinner and no less a record: the
 * thing is named by its shelf, the "as the seller posted it" line is left
 * out, and everything else stands. Nothing is read off the live columns to
 * fill the gap. Only a genuine failure, a database that will not answer,
 * leaves an acceptance without one.
 *
 * THE CANONICAL FORM, which is the whole of what makes the fingerprint
 * reproducible: UTF-8, Unicode NFC, one fact per line, LF between lines, no
 * whitespace at the end of any line, and no newline after the last line. The
 * email's plain-text part carries the block in exactly that form between two
 * marker lines (email/templates.ts, renderReceipt); the marker lines are not
 * part of it.
 *
 * Everything a person typed is DATA here. It is flattened to one line, shown
 * as theirs, and never read as an instruction by anything.
 */
import { createHash } from 'node:crypto';
import { getPool } from '../db.js';
import { decryptFields } from '../crypto.js';
import { offerAmountInWords } from '../email/templates.js';
import { getAccount } from './accounts.js';
import { categoryLeafLabel, categoryPhrase } from './matchRules.js';
import type { MatchRow } from './matches.js';
import { OsbError } from '../protocol.js';

/** One person as the record names them: both halves, or the record uses roles. */
export interface ReceiptPerson {
  firstName: string;
  locality: string;
}

/** The facts a record is made from. Pure data; receiptBlock turns it to words. */
export interface ReceiptFacts {
  /** When the accept was pressed. Said in UTC, to the minute. */
  at: Date;
  /** The thing in the seller's own screened words, else the shelf's phrase. */
  thing: string;
  /** The seller's posted details as one plain sentence, values only. */
  details?: string;
  amount: number;
  ccy: string;
  /** Whose figure it was. The other one is the person who accepted it. */
  offeredBy: 'buyer' | 'seller';
  /** The note that rode with the accepted offer, in its writer's own words. */
  note?: string;
  /** The lines the buyer asked and the seller's human confirmed with their
   *  own press, in the order asked. The buyer's words. */
  confirmed?: string[];
  /** Present only where both have already shared a first name and a suburb. */
  people?: { buyer: ReceiptPerson; seller: ReceiptPerson };
}

export interface Receipt {
  /** The block in canonical form: what the email carries and what is hashed. */
  block: string;
  /** SHA-256 of the block's UTF-8 bytes, lowercase hex. */
  sha256: string;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const two = (n: number) => String(n).padStart(2, '0');

/**
 * "2 October 2026, 03:14 UTC". Written out by hand from the UTC parts so it
 * reads the same on every machine and in every locale, which a formatter that
 * asks the runtime for its opinion does not promise.
 */
export function receiptTime(at: Date): string {
  return (
    `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ` +
    `${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`
  );
}

/**
 * Words a person typed, as one line of a record: control characters and line
 * breaks become spaces, runs of whitespace become one space, and the ends are
 * trimmed. A fact is one line, and nothing a person wrote can start a new one.
 */
export function oneLine(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The canonical form of a block (see the top of this file). Anyone checking a
 * fingerprint runs their copy of the block through these same four steps.
 */
export function canonicalReceipt(block: string): string {
  return String(block)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** SHA-256 over the canonical block's UTF-8 bytes, lowercase hex. */
export function receiptFingerprint(block: string): string {
  return createHash('sha256').update(canonicalReceipt(block), 'utf8').digest('hex');
}

const other = (role: 'buyer' | 'seller') => (role === 'buyer' ? 'seller' : 'buyer');

/**
 * The block itself. One fact per line, each line starting with what it is, and
 * the same words whoever is reading: there is no "you" in a record two people
 * hold. General statements only; nothing here knows what kind of thing it is.
 */
export function receiptBlock(f: ReceiptFacts): string {
  const lines: string[] = [];
  lines.push(`Agreed: ${receiptTime(f.at)}`);
  lines.push(`What: ${oneLine(f.thing)}`);
  const details = oneLine(f.details);
  if (details) lines.push(`As the seller posted it: ${details}`);
  lines.push(`Amount agreed: ${offerAmountInWords(f.amount, f.ccy)}`);
  lines.push(`Offered by the ${f.offeredBy}. Accepted by the ${other(f.offeredBy)}.`);
  const note = oneLine(f.note);
  // Their own words, inside quotation marks, said to be theirs.
  if (note) lines.push(`Note the ${f.offeredBy} sent with the offer: "${note}"`);
  // One line each, in the order asked. The words are the buyer's and the
  // confirming was the seller's, and the line says both.
  for (const raw of f.confirmed ?? []) {
    const line = oneLine(raw);
    if (line) lines.push(`Asked by the buyer, confirmed by the seller: "${line}"`);
  }
  if (f.people) {
    lines.push(`Buyer: ${oneLine(f.people.buyer.firstName)}, ${oneLine(f.people.buyer.locality)}`);
    lines.push(`Seller: ${oneLine(f.people.seller.firstName)}, ${oneLine(f.people.seller.locality)}`);
  }
  return canonicalReceipt(lines.join('\n'));
}

/** The block and its fingerprint, from the facts. Pure. */
export function receiptFrom(f: ReceiptFacts): Receipt {
  const block = receiptBlock(f);
  return { block, sha256: receiptFingerprint(block) };
}

/**
 * One person's first name and suburb, for the record. Their own envelope, read
 * by the system under a purpose of its own, so the audit line says what it was
 * for. Undefined where either half is missing or will not open.
 */
async function sharedPerson(accountId: string, matchId: string): Promise<ReceiptPerson | undefined> {
  const account: any = await getAccount(accountId);
  if (!account?.first_name_enc || !account?.locality_enc) return undefined;
  const fields = await decryptFields(
    accountId,
    account.data_key_enc,
    { first_name: account.first_name_enc, locality: account.locality_enc },
    { purpose: 'receipt', actor: 'system', refs: { match_id: matchId } },
  );
  const firstName = oneLine(fields.first_name);
  const locality = oneLine(fields.locality);
  return firstName && locality ? { firstName, locality } : undefined;
}

/**
 * Both people by name, or nobody by name.
 *
 * THE GATE IS THE RECORDED PRESSES. Names cross on an introduction only once
 * both humans have pressed the names step, and that is read here straight off
 * consent_tokens rather than off the stage column, for the reason buildMutual
 * gives: a bug somewhere else must not be able to open it. If either name is
 * missing, or anything at all goes wrong reading them, the record says "the
 * buyer" and "the seller" and is still a record.
 */
async function peopleIfShared(
  m: MatchRow,
): Promise<{ buyer: ReceiptPerson; seller: ReceiptPerson } | undefined> {
  try {
    if (Number(m.stage) < 3) return undefined;
    const r = await getPool().query(
      `SELECT count(DISTINCT account_id)::int AS n
         FROM consent_tokens
        WHERE match_id = $1 AND kind = 'stage3-optin'
          AND account_id = ANY($2::uuid[])`,
      [m.id, [m.account_want, m.account_have]],
    );
    if (Number(r.rows[0]?.n ?? 0) < 2) return undefined;
    const buyer = await sharedPerson(m.account_want, m.id);
    const seller = await sharedPerson(m.account_have, m.id);
    return buyer && seller ? { buyer, seller } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the record for one accepted offer.
 *
 * THROWS where no honest record can be made: a swap (nobody is buying and
 * there is no figure), or a genuine failure underneath. The caller treats a
 * throw as "no record this time" and records the acceptance without one.
 *
 * A posting whose details the buyer could not be shown right now is NOT a
 * throw: the details step's own refusal is caught, and the block is built
 * without the seller's words (see the top of this file).
 */
export async function buildReceipt(
  m: MatchRow,
  o: { amount: string | number; ccy: string; proposer_account: string; message?: unknown },
  at: Date = new Date(),
  extra: { confirmed?: string[] } = {},
): Promise<Receipt> {
  if (m.swap) throw new Error('receipt: a swap has no figure and no record of one');
  // The seller's posting AS THE BUYER IS ALREADY SHOWN IT: the details step,
  // asked for the buyer. Every gate on that step is a gate on what this may
  // say about the posting, so where the step refuses, the record says nothing
  // of the posting beyond its shelf. A refusal is one of the protocol's own
  // answers; anything else that goes wrong is a failure and is thrown.
  const { buildAttributes } = await import('./matches.js');
  let shown: any;
  try {
    shown = await buildAttributes(m, m.account_want);
  } catch (e) {
    if (!(e instanceof OsbError)) throw e;
    shown = undefined;
  }
  // The seller's own words for the thing are the first of their notes on that
  // payload (matchStory.ts reads it the same way for the page).
  const theirWords = Array.isArray(shown?.notes)
    ? shown.notes.find(
        (n: any) =>
          n?.provenance === 'counterparty-untrusted' && typeof n.text === 'string' && n.text.trim(),
      )?.text
    : undefined;
  const thing =
    oneLine(theirWords) || categoryPhrase(m.category) || categoryLeafLabel(m.category, null);
  // Values only, in the order they were written: no key is ever said.
  const { attributesSentence } = await import('../counter/pagesHome.js');
  const details = attributesSentence(shown?.attributes);
  const { offerMessageText } = await import('./offers.js');
  const note = offerMessageText(o.message) ?? undefined;
  const people = await peopleIfShared(m);
  const confirmed = (extra.confirmed ?? []).map(oneLine).filter(Boolean);
  return receiptFrom({
    at,
    thing,
    ...(details ? { details } : {}),
    amount: Number(o.amount),
    ccy: o.ccy,
    offeredBy: o.proposer_account === m.account_want ? 'buyer' : 'seller',
    ...(note ? { note } : {}),
    ...(confirmed.length ? { confirmed } : {}),
    ...(people ? { people } : {}),
  });
}
