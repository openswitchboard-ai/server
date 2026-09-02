/**
 * Per-card negotiation mode: who authors the numbers.
 *
 * The agent is the estate agent, not the seller. It presents, it advises, it
 * carries — and the figure it carries is one its human wrote. Two modes say
 * how that works on any one card, and both of them are set on the human-only
 * page class and nowhere else.
 *
 *  'relay' — "Pass on". The default, on every card, including every card that
 *      existed before this file did. respond(propose_offer) is refused outright
 *      with CONSENT_REQUIRED and the human's own approval link. The human types
 *      the amount on their approval page and the switchboard sends it as their
 *      side's offer through the ordinary offer machinery.
 *
 *  'mandate' — "Auto-negotiate". The human writes a box: where to open, where
 *      to walk away, and how big a move to make. Inside the box the agent may
 *      act without asking each time. Outside it the server refuses, and says
 *      which edge was crossed.
 *
 * Three rules hold this file together.
 *
 *  1. A mandate is a reservation price, so it is held like one — sealed under
 *     the account's envelope key, audited on every read (see
 *     migrations/010_negotiation.sql). It is decrypted only to check an offer
 *     the owning agent is attempting and to show the owning human their own
 *     numbers back.
 *  2. Nothing here ever crosses to a counterparty. The mandate is not in any
 *     protocol payload, is not in the offer row, and the refusal that names its
 *     boundary is returned to the caller's own agent, which is by construction
 *     the agent of the human who wrote it.
 *  3. Every change writes a WORM consent event naming the card and which parts
 *     of the box moved — never the figures themselves.
 */
import { getPool } from '../db.js';
import { decryptFields, encryptField, writeConsentEvent } from '../crypto.js';
import { getAccount } from './accounts.js';
import { looksLikeContactDetail } from './arrangement.js';
import { OsbError } from '../protocol.js';
import type { Config } from '../config.js';

export type NegotiationMode = 'relay' | 'mandate';

/** What each mode is called everywhere a human or an agent reads it. */
export const MODE_NAMES: Record<NegotiationMode, string> = {
  relay: 'Pass on',
  mandate: 'Auto-negotiate',
};

/** The one-line explanation each mode carries on the human's own pages. */
export const MODE_EXPLANATIONS: Record<NegotiationMode, string> = {
  relay: 'Your agent brings every offer to you and sends back the numbers you give it.',
  mandate:
    'You set an opening figure and a walk-away limit; your agent can move between them without asking each time.',
};

export interface Mandate {
  /** Where the agent may open. Optional: without it, only the limit binds. */
  open?: number;
  /** The walk-away figure. A floor on a HAVE, a ceiling on a WANT. */
  limit: number;
  /** Smallest move the agent may make between its own offers, if set. */
  step?: number;
  ccy: string;
}

export interface Negotiation {
  mode: NegotiationMode;
  /** Present only in mandate mode with a mandate on file. */
  mandate?: Mandate;
}

/** Amounts are money: positive, finite, two decimal places, sanely bounded. */
export const MANDATE_AMOUNT_MAX = 100_000_000;
export const MANDATE_NOTE_MAX = 200;

const CCY_RE = /^[A-Z]{3}$/;

export type MandateValidation = { ok: true; value: Mandate } | { ok: false; error: string };

function money(label: string, raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n)) return { ok: false, error: `${label} needs to be a number.` };
  if (n <= 0) return { ok: false, error: `${label} needs to be more than nothing.` };
  if (n > MANDATE_AMOUNT_MAX) {
    return { ok: false, error: `${label} runs past what this switchboard carries.` };
  }
  if (Math.round(n * 100) !== Number((n * 100).toFixed(6))) {
    return { ok: false, error: `${label} goes no finer than cents.` };
  }
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/**
 * Validate a mandate for a card of this type. The ordering rule is the whole
 * of the safety here, and it reads differently on each side:
 *
 *  HAVE — you are selling. `limit` is the floor you will not go below, and
 *         `open` (if given) is the higher figure you start from. Offers live
 *         in [limit, open].
 *  WANT — you are buying. `limit` is the ceiling you will not go above, and
 *         `open` (if given) is the lower figure you start from. Offers live
 *         in [open, limit].
 */
export function validateMandate(input: unknown, cardType: 'WANT' | 'HAVE'): MandateValidation {
  if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Your numbers are an opening figure, a limit and a currency.' };
  }
  const src = input as Record<string, unknown>;
  const known = ['open', 'limit', 'step', 'ccy'];
  const strayKey = Object.keys(src).find((k) => !known.includes(k));
  if (strayKey) {
    return { ok: false, error: `'${strayKey}' is not one of your numbers. They are ${known.join(', ')}.` };
  }

  const ccy = String(src.ccy ?? '').trim().toUpperCase();
  if (!CCY_RE.test(ccy)) {
    return { ok: false, error: 'The currency is a three-letter code, like AUD.' };
  }

  const lim = money('Your limit', src.limit);
  if (!lim.ok) return lim;

  const out: Mandate = { limit: lim.value, ccy };

  const hasOpen = src.open !== undefined && src.open !== null && String(src.open).trim() !== '';
  if (hasOpen) {
    const op = money('Your opening figure', src.open);
    if (!op.ok) return op;
    if (cardType === 'HAVE' && op.value < out.limit) {
      return {
        ok: false,
        error:
          'On something you are offering, the limit is the least you will take, so your opening figure sits at or above it.',
      };
    }
    if (cardType === 'WANT' && op.value > out.limit) {
      return {
        ok: false,
        error:
          'On something you are after, the limit is the most you will pay, so your opening figure sits at or below it.',
      };
    }
    out.open = op.value;
  }

  const hasStep = src.step !== undefined && src.step !== null && String(src.step).trim() !== '';
  if (hasStep) {
    const st = money('Your step', src.step);
    if (!st.ok) return st;
    const span = out.open === undefined ? undefined : Math.abs(out.open - out.limit);
    if (span !== undefined && span > 0 && st.value > span) {
      return {
        ok: false,
        error: 'Your step is larger than the whole distance between your opening figure and your limit.',
      };
    }
    out.step = st.value;
  }

  return { ok: true, value: out };
}

/** Where an offer from this side is allowed to land, given the mandate. */
export function mandateRange(m: Mandate, cardType: 'WANT' | 'HAVE'): { min?: number; max?: number } {
  return cardType === 'HAVE' ? { min: m.limit, max: m.open } : { min: m.open, max: m.limit };
}

/** The human's own numbers, said back to them in plain words. */
export function mandateInPlainWords(m: Mandate, cardType: 'WANT' | 'HAVE'): { k: string; v: string }[] {
  const lines: { k: string; v: string }[] = [];
  if (m.open !== undefined) lines.push({ k: 'Open at', v: `${m.open} ${m.ccy}` });
  lines.push({
    k: cardType === 'HAVE' ? 'Take no less than' : 'Pay no more than',
    v: `${m.limit} ${m.ccy}`,
  });
  if (m.step !== undefined) lines.push({ k: 'Move in steps of at least', v: `${m.step} ${m.ccy}` });
  return lines;
}

// ---------------------------------------------------------------------------
// The note that can ride along with a counter-offer the human types. Short, and
// held to the same rule as everything else that crosses to a stranger: terms,
// never a way to reach anyone. Stage 3 is where identities are exchanged, and a
// line typed beside a price is not it.
// ---------------------------------------------------------------------------

export type NoteValidation = { ok: true; value?: string } | { ok: false; error: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f<>]/;

export function validateOfferNote(raw: unknown): NoteValidation {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: 'A note is a short line of text.' };
  const value = raw.trim();
  if (!value) return { ok: true };
  if (CONTROL_CHARS.test(value)) return { ok: false, error: 'Plain text only in your note.' };
  if (value.length > MANDATE_NOTE_MAX) {
    return {
      ok: false,
      error: `Your note runs past ${MANDATE_NOTE_MAX} characters. A line about the terms is enough.`,
    };
  }
  if (looksLikeContactDetail(value)) {
    return {
      ok: false,
      error:
        'Your note holds an email, phone number or web address. Keep ways of reaching you out of it — you share a first name and an area only when you both approve it.',
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Storage. Mode in the clear, mandate under the envelope key.
// ---------------------------------------------------------------------------

interface NegotiationRow {
  account_id: string;
  type: 'WANT' | 'HAVE';
  negotiation_mode: NegotiationMode;
  mandate_enc: Buffer | null;
}

async function negotiationRow(cardId: string): Promise<NegotiationRow | undefined> {
  const r = await getPool().query(
    'SELECT account_id, type, negotiation_mode, mandate_enc FROM cards WHERE id = $1',
    [cardId],
  );
  return r.rows[0];
}

/**
 * The mode and (in mandate mode) the numbers for one of this account's cards.
 * A card belonging to anyone else is not found, and a card whose row predates
 * this feature reads as 'relay' — the default in the column and here.
 */
export async function readNegotiation(
  accountId: string,
  cardId: string,
  ctx: { purpose: string; refs?: Record<string, string> },
): Promise<Negotiation & { cardType: 'WANT' | 'HAVE' }> {
  const row = await negotiationRow(cardId);
  if (!row || row.account_id !== accountId) {
    throw Object.assign(new Error('card not found'), { notFound: true });
  }
  const mode: NegotiationMode = row.negotiation_mode === 'mandate' ? 'mandate' : 'relay';
  // The numbers are read back whatever the mode says, so a person who switches
  // a card to Pass on for a while still sees what they wrote when they switch
  // back. Only the mode decides whether an agent may act on them.
  if (!row.mandate_enc) return { mode, cardType: row.type };
  const account = await getAccount(accountId);
  if (!account) throw new Error('account not found');
  const fields = await decryptFields(
    accountId,
    account.data_key_enc,
    { mandate: row.mandate_enc },
    { purpose: ctx.purpose, actor: accountId, refs: { card_id: cardId, ...(ctx.refs ?? {}) } },
  );
  const checked = validateMandate(JSON.parse(fields.mandate), row.type);
  // Anything that predates a tightening of the rules is filtered on the way
  // out, so no reader ever acts on a box the current validator would refuse.
  return { mode, cardType: row.type, ...(checked.ok ? { mandate: checked.value } : {}) };
}

/** The mode alone — no decrypt, no audit line. Used where only the mode matters. */
export async function readNegotiationMode(
  accountId: string,
  cardId: string,
): Promise<NegotiationMode> {
  const row = await negotiationRow(cardId);
  if (!row || row.account_id !== accountId) {
    throw Object.assign(new Error('card not found'), { notFound: true });
  }
  return row.negotiation_mode === 'mandate' ? 'mandate' : 'relay';
}

/**
 * Write the mode and the numbers together — they only ever move together, and
 * a human switching a card to Auto-negotiate is saying both things at once.
 * Called from the human page class and from nowhere else.
 */
export async function saveNegotiation(
  accountId: string,
  cardId: string,
  next: { mode: NegotiationMode; mandate?: Mandate | null },
  recordedVia: string,
): Promise<void> {
  const row = await negotiationRow(cardId);
  if (!row || row.account_id !== accountId) {
    throw Object.assign(new Error('card not found'), { notFound: true });
  }
  const account = await getAccount(accountId);
  if (!account) throw new Error('account not found');

  const clearing = next.mandate === null;
  const setting = !!next.mandate;
  await writeConsentEvent({
    event: 'negotiation-mode-set',
    account_id: accountId,
    card_id: cardId,
    mode: next.mode,
    // Which parts of the box the human wrote, never what they say.
    mandate_fields: next.mandate ? Object.keys(next.mandate).sort() : [],
    mandate_cleared: clearing,
    recorded_via: recordedVia,
  });

  const enc = setting
    ? await encryptField(accountId, account.data_key_enc, JSON.stringify(next.mandate))
    : null;
  if (setting || clearing) {
    await getPool().query(
      `UPDATE cards SET negotiation_mode = $3, mandate_enc = $4,
              mandate_updated_at = now(), updated_at = now()
       WHERE id = $1 AND account_id = $2`,
      [cardId, accountId, next.mode, enc],
    );
  } else {
    await getPool().query(
      `UPDATE cards SET negotiation_mode = $3, updated_at = now()
       WHERE id = $1 AND account_id = $2`,
      [cardId, accountId, next.mode],
    );
  }
}

// ---------------------------------------------------------------------------
// The refusals. Every one of these is answered to the caller's OWN agent, and
// every one of them points at the page where the human can settle it.
// ---------------------------------------------------------------------------

/**
 * The human's own link to the card's numbers page. A link is the courtesy and
 * the refusal is the rule: when a link cannot be built the agent is still
 * refused, with the plain instruction on its own.
 */
export function numbersPageUrl(cfg: Config, cardId: string): string {
  return `${cfg.counterOrigin}/counter/ledger/${encodeURIComponent(cardId)}/numbers`;
}

export function matchPageUrl(cfg: Config, matchId: string): string {
  return `${cfg.counterOrigin}/counter/matches/${encodeURIComponent(matchId)}`;
}

/** human_action is capped at 300 characters, so the link goes on only if it fits. */
function withLink(sentence: string, url: string): string {
  const joined = `${sentence} ${url}`;
  return joined.length <= 300 ? joined : sentence;
}

export const RELAY_ACTION =
  'Your numbers come from you — reply to offers on your approval page, or switch this card to hands-off negotiation there:';

export const NO_MANDATE_ACTION =
  'This card is set to Auto-negotiate with no numbers written yet. Set your opening figure and your limit on your approval page:';

/** relay mode: the agent may not author a figure at all. */
export function relayRefusal(cfg: Config, matchId: string): OsbError {
  return new OsbError('CONSENT_REQUIRED', {
    human_action: withLink(RELAY_ACTION, matchPageUrl(cfg, matchId)),
  });
}

/** mandate mode, nothing written: the box is empty, so there is nothing to act inside. */
export function noMandateRefusal(cfg: Config, cardId: string): OsbError {
  return new OsbError('CONSENT_REQUIRED', {
    human_action: withLink(NO_MANDATE_ACTION, numbersPageUrl(cfg, cardId)),
  });
}

/**
 * The out-of-box refusal. It names the edge that was crossed, because the only
 * reader is the agent of the human who drew the box.
 */
export function outsideMandateRefusal(cfg: Config, cardId: string, reason: string): OsbError {
  return new OsbError('CONSENT_REQUIRED', {
    human_action: withLink(`${reason} Bring it to your human on their approval page:`, numbersPageUrl(cfg, cardId)),
  });
}

// ---------------------------------------------------------------------------
// Enforcement.
// ---------------------------------------------------------------------------

export interface MandateCheckInput {
  amount: number;
  ccy: string;
  /** This side's own previous offers on this match, oldest first. */
  priorAmounts: number[];
  /** Whether this side has opened on this match yet. */
  isOpening: boolean;
}

export type MandateCheck = { ok: true } | { ok: false; reason: string };

/**
 * Is this figure inside what the human wrote? Four questions, in the order a
 * person would ask them: is it the right money, is it past the walk-away, is
 * it further out than they said to open, and is the move the size they asked
 * for and pointed the way they meant.
 */
export function checkAgainstMandate(
  m: Mandate,
  cardType: 'WANT' | 'HAVE',
  input: MandateCheckInput,
): MandateCheck {
  if (input.ccy.toUpperCase() !== m.ccy) {
    return { ok: false, reason: `Your human's numbers on this card are in ${m.ccy}, and this offer is in ${input.ccy.toUpperCase()}.` };
  }
  const amount = input.amount;

  if (cardType === 'HAVE') {
    if (amount < m.limit) {
      return { ok: false, reason: `${amount} ${m.ccy} is below the ${m.limit} ${m.ccy} your human said they would not go under.` };
    }
    if (m.open !== undefined && amount > m.open) {
      return { ok: false, reason: `${amount} ${m.ccy} is above the ${m.open} ${m.ccy} your human said to open at.` };
    }
  } else {
    if (amount > m.limit) {
      return { ok: false, reason: `${amount} ${m.ccy} is above the ${m.limit} ${m.ccy} your human said they would not go over.` };
    }
    if (m.open !== undefined && amount < m.open) {
      return { ok: false, reason: `${amount} ${m.ccy} is below the ${m.open} ${m.ccy} your human said to open at.` };
    }
  }

  // The opening move: with an opening figure written down, the first offer is
  // that figure. "Open where they told you" is the whole instruction.
  if (input.isOpening && m.open !== undefined && amount !== m.open) {
    return { ok: false, reason: `Your human said to open this card at ${m.open} ${m.ccy}.` };
  }

  if (m.step !== undefined && input.priorAmounts.length) {
    const prev = input.priorAmounts[input.priorAmounts.length - 1];
    const delta = amount - prev;
    if (delta === 0) {
      return { ok: false, reason: `You have already offered ${amount} ${m.ccy} on this match; a further offer moves by at least ${m.step} ${m.ccy}.` };
    }
    // Toward the limit: down on something you are selling, up on something
    // you are buying. A move back out is re-trading ground the human gave.
    const towardLimit = cardType === 'HAVE' ? delta < 0 : delta > 0;
    if (!towardLimit) {
      return {
        ok: false,
        reason:
          cardType === 'HAVE'
            ? `Your last offer here was ${prev} ${m.ccy}, and your human's numbers only let you come down from it.`
            : `Your last offer here was ${prev} ${m.ccy}, and your human's numbers only let you go up from it.`,
      };
    }
    if (Math.abs(delta) + 1e-9 < m.step) {
      return { ok: false, reason: `That moves ${Math.round(Math.abs(delta) * 100) / 100} ${m.ccy} from your last offer, and your human set a step of at least ${m.step} ${m.ccy}.` };
    }
  }

  return { ok: true };
}
