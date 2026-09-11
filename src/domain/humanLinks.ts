/**
 * The links an assistant fetches and hands to its human.
 *
 * The principle this file exists for: the assistant does the talking and the
 * carrying, and the switchboard's own page does the confirming. So an agent
 * never acts on a formality — it asks here for its human's link, says in the
 * chat what the link will ask, and hands it over. The person opens one page,
 * reads one sentence, and presses one of two buttons.
 *
 * Every function below MINTS and RETURNS. None of them changes anything that
 * matters: nothing is sent, shared, closed or switched on until a human
 * presses the button on the page the link opens.
 *
 * Each link is single-use, lives fifteen minutes, and is HMAC-bound to the
 * exact figures and ids it was minted for (see counter/links.ts). A link that
 * has been tampered with, or pressed once already, fails plainly on the page.
 *
 * The refusals here are deliberate and happen at mint time rather than on the
 * page: an agent that asks for a link to an impossible question should learn
 * why while it is still talking to its human, not hand over a link that dies.
 */
import { getPool } from '../db.js';
import { OsbError } from '../protocol.js';
import { getHearsVia } from './accounts.js';
import { getMatch, ownCardId, sideOf } from './matches.js';
import { categoryLeafLabel } from './matchRules.js';
import { validateMandate, validateOfferNote, type Mandate } from './negotiation.js';
import { APPROVAL_LINK_TTL_MINUTES, createApprovalLink } from '../counter/links.js';
import type { Config } from '../config.js';

/** What every one of these answers with, in the same three fields. */
export interface HumanLink {
  link: string;
  expires_in_minutes: number;
  /** One plain sentence saying what the person will be asked. */
  what_it_does: string;
}

/**
 * The two things that have to be true before an agent may even offer to
 * negotiate, and the sentence each one earns when it is not.
 *
 * Handing the wheel to an agent only makes sense when there is an agent there
 * to hold it, and that is two separate facts rather than one. The account has
 * to hear through an always-on assistant (hears_via), because a person who
 * only ever hears by email has nobody moving between conversations on their
 * behalf. AND the agent asking has to have said it runs on its own, in the
 * standing arrangement, because a chat assistant on that same account is still
 * a chat assistant — it wakes when spoken to, and a box it cannot act inside
 * is a box that does nothing but weaken the rule that numbers are the human's.
 *
 * Whichever is missing is the one named, so an agent knows what to do about it.
 */
export const AUTO_NEGOTIATE_NEEDS_ASSISTANT =
  'Auto-negotiate needs an assistant that runs on its own; this account hears by email.';

export const AUTO_NEGOTIATE_NEEDS_RUNS_ON_ITS_OWN =
  'Auto-negotiate is for an agent that runs between conversations. You have not said you are one, so the numbers stay with your human — bring them the figure instead.';

const url = (cfg: Config, token: string) => `${cfg.counterOrigin}/a/${encodeURIComponent(token)}`;

function money(amount: number, ccy: string): string {
  const n = Number(amount);
  return `$${Number.isInteger(n) ? String(n) : n.toFixed(2)} ${ccy.toUpperCase()}`;
}

/** The thing itself, in the words a person uses for it. */
async function thingOf(cardId: string): Promise<string> {
  const r = await getPool().query('SELECT category FROM cards WHERE id = $1', [cardId]);
  return r.rows[0] ? categoryLeafLabel(r.rows[0].category).toLowerCase() : 'what you posted';
}

/** This account's own card behind an introduction, or a refusal. */
async function ownCardFor(accountId: string, matchId: string): Promise<string> {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, accountId);
  return ownCardId(m, accountId);
}

/** One of this account's own wants or haves, or a refusal. */
async function ownCard(
  accountId: string,
  cardId: string,
): Promise<{ id: string; type: 'WANT' | 'HAVE'; category: string }> {
  if (!cardId) throw Object.assign(new Error('which want or have?'), { validation: true });
  const r = await getPool().query(
    'SELECT id, type, category, account_id FROM cards WHERE id = $1',
    [cardId],
  );
  const row = r.rows[0];
  if (!row || row.account_id !== accountId) {
    throw Object.assign(new Error('want or have not found'), { notFound: true });
  }
  return { id: row.id, type: row.type, category: row.category };
}

// ---------------------------------------------------------------------------
// (b) Send a number. The figure an agent was carrying, parked against the
// introduction and bound into the link, so the page asks about that figure and
// no other.
// ---------------------------------------------------------------------------
export async function sendNumberLink(
  cfg: Config,
  accountId: string,
  matchId: string,
  input: { amount: number; ccy: string; message?: string; good_for_days?: number },
): Promise<HumanLink> {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, accountId);
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('a number to send is more than nothing'), { validation: true });
  }
  const ccy = String(input.ccy ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(ccy)) {
    throw Object.assign(new Error('the currency is a three-letter code, like AUD'), {
      validation: true,
    });
  }
  const note = validateOfferNote(input.message);
  if (!note.ok) throw Object.assign(new Error(note.error), { validation: true });
  const days = [3, 7, 14].includes(Number(input.good_for_days)) ? Number(input.good_for_days) : 7;
  const counterparty = m.account_want === accountId ? m.account_have : m.account_want;
  const rounded = Math.round(amount * 100) / 100;
  const { token } = await createApprovalLink({
    accountId,
    action: 'offer-send',
    refId: matchId,
    amount: rounded,
    ccy,
    counterpartyAccount: counterparty,
    payload: {
      amount: rounded,
      ccy,
      good_for_days: days,
      ...(note.value ? { note: note.value } : {}),
    },
  });
  return {
    link: url(cfg, token),
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
    what_it_does: `Opens one page asking your human whether to send ${money(rounded, ccy)} to the other side. They press Send and it goes; they press Not now and nothing does.`,
  };
}

// ---------------------------------------------------------------------------
// (c) Accept a number. Works on a figure the other side's agent has brought
// over (proposed) and on one already parked for this human (awaiting-human):
// a live number is theirs to take whether or not anyone brought it to them.
// ---------------------------------------------------------------------------
export async function acceptNumberLink(
  cfg: Config,
  accountId: string,
  offerId: string,
): Promise<HumanLink> {
  if (!offerId) throw Object.assign(new Error('which number?'), { validation: true });
  const r = await getPool().query(
    `SELECT o.*, m.category, m.account_want, m.account_have FROM offers o
     JOIN matches m ON m.id = o.match_id WHERE o.id = $1`,
    [offerId],
  );
  const o = r.rows[0];
  if (!o) throw Object.assign(new Error('offer not found'), { notFound: true });
  if (o.account_want !== accountId && o.account_have !== accountId) {
    throw Object.assign(new Error('offer not found'), { notFound: true });
  }
  if (o.proposer_account === accountId) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'That figure is your own side\'s. Only the other person can accept it.',
    });
  }
  if (o.state !== 'proposed' && o.state !== 'awaiting-human') {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: `That figure is ${o.state} — there is nothing left to accept.`,
    });
  }
  const { token } = await createApprovalLink({
    accountId,
    action: 'offer-accept',
    refId: offerId,
    amount: Number(o.amount),
    ccy: o.ccy,
    counterpartyAccount: o.proposer_account,
  });
  return {
    link: url(cfg, token),
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
    what_it_does: `Opens one page saying ${money(Number(o.amount), o.ccy)} is on the table for their ${categoryLeafLabel(o.category).toLowerCase()}, with Accept and Not now. They press Accept and it is agreed, and that takes their PIN.`,
  };
}

// ---------------------------------------------------------------------------
// (a) Share your name. The same link the names step has always used, fetched
// on purpose rather than arriving with a refusal.
// ---------------------------------------------------------------------------
export async function shareNameLink(
  cfg: Config,
  accountId: string,
  matchId: string,
): Promise<HumanLink> {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, accountId);
  if (m.state !== 'open') {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'This introduction is no longer open.',
    });
  }
  const counterparty = m.account_want === accountId ? m.account_have : m.account_want;
  const { stage3LinkFor } = await import('./profile.js');
  const link = await stage3LinkFor(cfg, accountId, matchId, counterparty);
  if (!link) throw new Error('could not mint the names link');
  return {
    link,
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
    what_it_does:
      'Opens one page asking your human whether to share their first name and area with the other side. Nothing crosses until they say yes there.',
  };
}

// ---------------------------------------------------------------------------
// (d) Close the window. The holder's own want or have is contested and still
// collecting; closing it early lets them go ahead with whoever they choose.
// ---------------------------------------------------------------------------
export async function closeWindowLink(
  cfg: Config,
  accountId: string,
  intentId: string,
): Promise<HumanLink> {
  const card = await ownCard(accountId, intentId);
  const r = await getPool().query(
    `SELECT collect_until FROM cards
     WHERE id = $1 AND collect_until > now() AND collect_closed_at IS NULL`,
    [intentId],
  );
  if (!r.rowCount) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'There is no window open on that one right now.',
    });
  }
  const { token } = await createApprovalLink({
    accountId,
    action: 'collection-close',
    refId: card.id,
    counterpartyAccount: accountId,
  });
  return {
    link: url(cfg, token),
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
    what_it_does: `Opens one page asking your human whether to close the window on their ${categoryLeafLabel(card.category).toLowerCase()} now and go ahead with someone.`,
  };
}

// ---------------------------------------------------------------------------
// (e) Auto-negotiate. The one link an agent may offer only when BOTH halves
// hold: the account hears through an always-on assistant, and the agent asking
// has said it is one. A box nobody is inside is a box nobody can use.
// ---------------------------------------------------------------------------
export async function autoNegotiateLink(
  cfg: Config,
  accountId: string,
  intentId: string,
  numbers: { open?: number; limit?: number; step?: number; ccy?: string },
): Promise<HumanLink> {
  if ((await getHearsVia(accountId)) === 'email') {
    throw new OsbError('CONSENT_REQUIRED', { human_action: AUTO_NEGOTIATE_NEEDS_ASSISTANT });
  }
  const { readArrangement } = await import('./arrangement.js');
  if ((await readArrangement(accountId)).runs_on_its_own !== true) {
    throw new OsbError('CONSENT_REQUIRED', {
      human_action: AUTO_NEGOTIATE_NEEDS_RUNS_ON_ITS_OWN,
    });
  }
  const card = await ownCard(accountId, intentId);
  const checked = validateMandate(numbers, card.type);
  if (!checked.ok) throw Object.assign(new Error(checked.error), { validation: true });
  const mandate: Mandate = checked.value;
  const { token } = await createApprovalLink({
    accountId,
    action: 'negotiation-auto',
    refId: card.id,
    amount: mandate.limit,
    ccy: mandate.ccy,
    counterpartyAccount: accountId,
    payload: {
      limit: mandate.limit,
      ccy: mandate.ccy,
      ...(mandate.open !== undefined ? { open: mandate.open } : {}),
      ...(mandate.step !== undefined ? { step: mandate.step } : {}),
    },
  });
  const thing = categoryLeafLabel(card.category).toLowerCase();
  const edge =
    card.type === 'HAVE'
      ? `take no less than ${money(mandate.limit, mandate.ccy)}`
      : `pay no more than ${money(mandate.limit, mandate.ccy)}`;
  return {
    link: url(cfg, token),
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
    what_it_does: `Opens one page asking your human whether to let you negotiate their ${thing}: ${edge}. Saying yes takes their PIN, and it writes those numbers onto that one want or have.`,
  };
}

/** Exported for the page that renders the question these links carry. */
export { thingOf as categoryWordsFor };
