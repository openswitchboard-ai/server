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
import { readLaneFacts, sayFor } from './lanes.js';
import { getMatch, ownCardId, sideOf } from './matches.js';
import { categoryPhrase } from './matchRules.js';
import { validateMandate, validateOfferNote, type Mandate } from './negotiation.js';
import { APPROVAL_LINK_TTL_MINUTES, createApprovalLink, signLink } from '../counter/links.js';
import type { Config } from '../config.js';

/** What every one of these answers with, in the same five fields. */
export interface HumanLink {
  /**
   * THE SENTENCE TO SAY, and the reason this field exists.
   *
   * Dev, 20 September 2026: an assistant fetched a names link, waited on it,
   * fetched a second one, waited again, and across a quarter of an hour never
   * put a link in front of its human at all. It talked at length about a page
   * he had never been given and asked him whether it was loading. The manual
   * says the handover in three steps at great length, and both tool
   * descriptions say it again; it happened anyway.
   *
   * What has worked in this codebase is handing the agent a ready-made
   * sentence in the answer it is reading at that moment, which it then relays.
   * So every link answer now carries one: plain, in the house register, in the
   * second person, WITH THE LINK ALREADY IN IT and with what the page asks
   * already said. Leading with it is the whole of steps one and two, and it
   * cannot be led with while the link is still sitting in the answer.
   *
   * `what_it_does` below stays exactly what it was: the agent-facing half.
   */
  say: string;
  link: string;
  /**
   * The press itself, to wait on. An agent hands the link over and then calls
   * wait_for_press with this, so the answer reaches its human the moment they
   * press rather than when they remember to come back and say so.
   */
  press_id: string;
  expires_in_minutes: number;
  /** One plain sentence saying what the person will be asked. */
  what_it_does: string;
}

/**
 * The one shape every `say` wears. The lead-in is the same everywhere — it is
 * the lead-in `PRESS_SENTENCES.waiting` already uses — so an agent learns the
 * shape once, and the page itself always lands at the end where it is read out
 * last and stays clickable.
 *
 * `asks` is what the page asks, said to the person who will press it: it reads
 * after "it asks", so it is written as a clause rather than a sentence.
 */
const saySentence = (asks: string, link: string): string =>
  `Here is your page — it asks ${asks}: ${link}`;

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
  return r.rows[0] ? categoryPhrase(r.rows[0].category) : 'what you posted';
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
  const { token, id } = await createApprovalLink({
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
  // A best offer is one number each, sealed until the seller sees them all, so
  // the page says so: this is the whole of your human's say on it, and nobody
  // is going to come back with a counter.
  const oneNumber =
    m.account_want === accountId && (await isBestOffer(matchId))
      ? ' This is your one number for this; it stays sealed until the seller sees them all.'
      : '';
  const sealed =
    oneNumber === ''
      ? ''
      : ' — this is your one number for this one, and it stays sealed until the seller sees them all';
  const page = url(cfg, token);
  return {
    say: saySentence(
      `whether to send ${money(rounded, ccy)} to the other side, and nothing goes until you press it${sealed}`,
      page,
    ),
    link: page,
    press_id: id,
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
    what_it_does: `Opens one page asking your human whether to send ${money(rounded, ccy)} to the other side. They press Send and it goes; they press Not now and nothing does.${oneNumber} Once they press it, your next check_matches shows the result.`,
  };
}

/** Is the have behind this introduction being sold on best offer? */
async function isBestOffer(matchId: string): Promise<boolean> {
  const r = await getPool().query(
    `SELECT 1 FROM matches m JOIN cards c ON c.id = m.card_have
      WHERE m.id = $1 AND c.sale = 'best-offer'
        AND c.gather_until IS NOT NULL AND c.gather_until > now()
        AND c.gather_closed_at IS NULL`,
    [matchId],
  );
  return !!r.rowCount;
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
  // And its own clock, refused HERE rather than at the press: minting a page
  // for a human to accept something that has already run out is a page nobody
  // should be handed (2026-09-17 audit).
  const { OFFER_EXPIRED_WORDS, offerHasExpired } = await import('./offers.js');
  if (offerHasExpired(o)) {
    throw new OsbError('NOT_UNLOCKED_YET', { human_action: OFFER_EXPIRED_WORDS });
  }
  const { token, id } = await createApprovalLink({
    accountId,
    action: 'offer-accept',
    refId: offerId,
    amount: Number(o.amount),
    ccy: o.ccy,
    counterpartyAccount: o.proposer_account,
  });
  const page = url(cfg, token);
  const forWhat =
    o.account_have === accountId
      ? ` for your ${categoryPhrase(o.category)}`
      : ` for the ${categoryPhrase(o.category)} you are after`;
  return {
    say: saySentence(
      `whether to accept ${money(Number(o.amount), o.ccy)}${forWhat}, and saying yes takes your passkey or PIN`,
      page,
    ),
    link: page,
    press_id: id,
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
    what_it_does: `Opens one page saying ${money(Number(o.amount), o.ccy)} is on the table${o.account_have === accountId ? ` for their ${categoryPhrase(o.category)}` : ` for the ${categoryPhrase(o.category)} they are after`}, with Accept and Not now. They press Accept and it is agreed, and that takes their PIN. Once they press it, your next check_matches shows the result.`,
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
  const minted = await stage3LinkFor(cfg, accountId, matchId, counterparty);
  if (!minted) throw new Error('could not mint the names link');
  return {
    // Suburb, and never anything vaguer: the other person is working out
    // whether this is ten minutes away or two hours, and a state tells them
    // nothing. The sentence the agent relays has to say the word the page uses.
    say: saySentence(
      'whether to share your first name and your suburb with them, and nothing crosses until you press it',
      minted.link,
    ),
    link: minted.link,
    press_id: minted.press_id,
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
    what_it_does:
      'Opens one page asking your human whether to share their first name and suburb with the other side. Nothing crosses until they say yes there. Once they press it, your next check_matches shows the result.',
  };
}

// ---------------------------------------------------------------------------
// (f) Send a photo. The one image step, and the whole of an agent's part in it.
//
// An agent CANNOT upload. It can say a picture would help, fetch this, and hand
// it over; the person picks the photo on their own page and presses Send. An
// agent holding an image is a category of problem nobody needs, and the bytes
// never reach this service in any case — the browser puts them in the bucket on
// a presigned link.
//
// BOUND TO THE CONVERSATION AT MINT TIME, like every other link here. The
// alternative — one page where a person chooses which conversation a photo
// belongs to — is a page that can be answered wrongly, with the wrong stranger
// on the other end of the mistake. There is nothing to choose here: the link
// says which conversation, and the page says who it goes to.
//
// Refused at mint time when there is no open conversation, so an agent learns
// why while it is still talking to its human rather than handing over a link
// that dies.
// ---------------------------------------------------------------------------
export async function photoLink(
  cfg: Config,
  accountId: string,
  matchId: string,
): Promise<HumanLink> {
  const { loadOpenChannel } = await import('./channel.js');
  const { photosConfigured } = await import('./channelPhoto.js');
  if (!photosConfigured(cfg)) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action:
        'Photos are not switched on here yet. Ask your human what the thing looks like and send that in words.',
    });
  }
  const ch = await loadOpenChannel(matchId, accountId);
  const { token, id } = await createApprovalLink({
    accountId,
    action: 'conversation-photo',
    refId: matchId,
    counterpartyAccount: ch.counterpartyAccount,
  });
  const page = url(cfg, token);
  return {
    say: saySentence(
      'you to pick a photo from your own phone and press Send, and it goes to the person you are already talking to on this one and nowhere else',
      page,
    ),
    link: page,
    press_id: id,
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
    what_it_does:
      'Opens one page where your human picks a photo from their own phone and presses Send. It goes to the person they are already talking to on this one and nowhere else, it is held until that side picks it up, and then it is gone. You cannot send a photo yourself. A machine looks at the picture once before it is delivered, no person at the switchboard sees it, and one that is turned back comes back with one plain sentence to say.',
  };
}

// ---------------------------------------------------------------------------
// (g) Report this person. The one link on this surface that ENDS something.
//
// An agent may hand it over and nothing more: the words are the human's, the
// press is the human's, and what happens next is the switchboard's. Everything
// else here follows the pattern exactly — bound to the introduction at mint
// time, single-use, fifteen minutes, wait_for_press works on it.
//
// Refused at mint time only where there is no open introduction to report on,
// so an agent learns why while it is still talking to its human.
// ---------------------------------------------------------------------------
export async function reportLink(
  cfg: Config,
  accountId: string,
  matchId: string,
): Promise<HumanLink> {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, accountId);
  if (m.state !== 'open') {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'This one is already closed, so there is nothing left to close.',
    });
  }
  const counterparty = m.account_want === accountId ? m.account_have : m.account_want;
  const { token, id } = await createApprovalLink({
    accountId,
    action: 'report',
    refId: matchId,
    counterpartyAccount: counterparty,
  });
  const page = url(cfg, token);
  return {
    // The passkey is said here because the manual says to say it (version 46):
    // this page ends a conversation for good and puts somebody on the record,
    // so it asks for a credential, and a frightened person should not meet
    // that as a surprise. A press no assistant can make is the point of it.
    say: saySentence(
      'whether to report this person, with a box for a line in your own words about what happened, and it will ask for your passkey or PIN because this press is yours alone',
      page,
    ),
    link: page,
    press_id: id,
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
    what_it_does:
      'Opens one page asking your human whether to report this person, with a box for a line in their own words about what happened. One press does the whole of it: the switchboard closes this one, nothing more goes either way, the two of them are never put together again, and somebody here looks at what was said. The other person is told only that the switchboard closed it — never that they were reported, never by whom, and never what was said.',
  };
}

// ---------------------------------------------------------------------------
// (h) Keep the conversation going. The renewal of one side's own window
// (domain/conversationWindow.ts): consent to talk runs out, and this is how it
// is given again.
//
// It may be fetched at any time while the conversation is open, not only once
// the window is spent — renewing early simply starts a fresh window, and a
// human who has just said "yes, keep going" should not have to wait for the old
// one to run out first. What it cannot do is be fetched by somebody who is not
// a party or on a conversation that is not open, and loadOpenChannel is what
// says so, in the same words every other door on an open conversation uses.
//
// It grants nothing to the other side and tells them nothing.
// ---------------------------------------------------------------------------
export async function keepTalkingLink(
  cfg: Config,
  accountId: string,
  matchId: string,
): Promise<HumanLink> {
  const { loadOpenChannel } = await import('./channel.js');
  const ch = await loadOpenChannel(matchId, accountId);
  const { token, id } = await createApprovalLink({
    accountId,
    action: 'conversation-renew',
    refId: matchId,
    counterpartyAccount: ch.counterpartyAccount,
  });
  const page = url(cfg, token);
  return {
    say: saySentence(
      'whether to keep this conversation going, and one press gives us a fresh run of messages and days on it',
      page,
    ),
    link: page,
    press_id: id,
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
    what_it_does:
      'Opens one page asking your human whether to keep this conversation going, with how many messages your side has sent so far on it. One press gives you a fresh run of messages and days on this one; Not now leaves it paused, and nothing is lost either way. It changes nothing for the other side, who are told none of this.',
  };
}

// ---------------------------------------------------------------------------
// (d) There used to be a link here for closing the short window on a want or
// have of the holder's own. The window is gone (migration 030): nothing blocks
// a holder now, so there is nothing for them to close. See domain/sequencer.ts.
// ---------------------------------------------------------------------------

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
  // Which lane this agent is in is decided in exactly one place
  // (domain/lanes.ts), so nothing here reads the flag itself.
  const { readArrangement } = await import('./arrangement.js');
  const { laneFor } = await import('./lanes.js');
  if (laneFor(await readArrangement(accountId)) !== 'autonomous') {
    throw new OsbError('CONSENT_REQUIRED', {
      human_action: AUTO_NEGOTIATE_NEEDS_RUNS_ON_ITS_OWN,
    });
  }
  const card = await ownCard(accountId, intentId);
  const checked = validateMandate(numbers, card.type);
  if (!checked.ok) throw Object.assign(new Error(checked.error), { validation: true });
  const mandate: Mandate = checked.value;
  const { token, id } = await createApprovalLink({
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
  const thing = categoryPhrase(card.category);
  const edge =
    card.type === 'HAVE'
      ? `take no less than ${money(mandate.limit, mandate.ccy)}`
      : `pay no more than ${money(mandate.limit, mandate.ccy)}`;
  const page = url(cfg, token);
  return {
    say: saySentence(
      `whether to let me talk numbers on your ${thing} and ${edge}, and saying yes takes your passkey or PIN`,
      page,
    ),
    link: page,
    press_id: id,
    expires_in_minutes: APPROVAL_LINK_TTL_MINUTES,
    what_it_does: `Opens one page asking your human whether to let you negotiate their ${thing}: ${edge}. Saying yes takes their PIN, and it writes those numbers onto that one want or have. Once they press it, your next check_matches shows the result.`,
  };
}

// ---------------------------------------------------------------------------
// Waiting for the press.
//
// The hole this fills: an agent hands over a link and then has nothing to do
// but ask its human to come back and say "done". People forget, and word it
// oddly when they do, so the agent guesses. Here the agent holds the line
// instead, and the switchboard answers the instant the button is pressed.
//
// The hole the waiting itself then opened, found in a live rehearsal within an
// hour of shipping it: an agent minted a link, waited on it, and never handed
// it over, so its human was told to press something they had never been given
// and the whole turn went on a press that could not come. So every answer with
// a live page behind it carries that page, worked out again from the row it was
// minted from. The wrong order still ends with the link in front of the human.
//
// An expired link is not replaced here, on purpose. Minting belongs to the
// functions above, which refuse at mint time when the thing being asked about
// is no longer there — and this call costs nothing against the hourly ceiling,
// so re-minting on every stale wait would let a loop spray live approval links
// for one question. The answer says plainly to fetch a fresh one instead.
//
// Nothing here changes anything. It reads one row, over and over, until that
// row says the human has answered — or until the cap, which is well short of
// the load balancer's sixty-second idle timeout, so the call ends on our own
// terms with a sentence rather than as a dropped request.
// ---------------------------------------------------------------------------

/** How long one wait holds the line. The balancer gives up at sixty seconds. */
export const PRESS_WAIT_CAP_MS = 50_000;

/** How often the row is re-read while the line is held. */
export const PRESS_POLL_MS = 1_500;

export interface PressAnswer {
  pressed: boolean;
  decision?: 'approved' | 'declined';
  /** Present only when the link ran out before anyone pressed it. */
  expired?: true;
  /**
   * The very page this wait is about, on every answer where there is still
   * something for a human to press. It rides along so that an agent which
   * waited before it handed anything over still ends the turn holding the
   * page: the note is written to be read out with the link in it.
   */
  link?: string;
  /** What the agent does next, in plain words, when waiting again is wrong. */
  what_to_do?: string;
  /**
   * On the shelf page (SHELF_PICK): the shelf the human chose, as the path to
   * post again with and in the words to say. The posting is still the
   * assistant's to send: the switchboard holds the choice and nothing else.
   */
  picked?: { category: string; words: string };
  note: { text: string; provenance: 'switchboard-system' };
}

/** The sentences, in the register every other answer is written in. */
export const PRESS_SENTENCES = {
  /**
   * THE PROMPTED WORDING, and the one the account-less callers get. The live
   * answer is served per lane through `press_approved` in domain/lanes.ts:
   * this constant is what an agent that only wakes when spoken to is told, and
   * an agent that runs on its own is told it may bring the news itself.
   */
  approved: sayFor('press_approved', {}),
  declined:
    'You pressed Not now, so nothing went ahead. Say the word whenever you want to look at it again.',
  /** Lead-in only: the link itself follows it, which is the whole point. */
  waiting: 'Here is the page again — nothing has come through yet:',
  expired: 'That page has run out. I can fetch you a fresh one whenever you are ready.',
} as const;

/**
 * The part of a still-waiting answer that is for the agent rather than the
 * human.
 *
 * THE LAST SENTENCE IS THERE BECAUSE ASSISTANTS KEEP ASKING TO BE TOLD. Both
 * sides of a rehearsal wrote "just let me know once you've clicked through it"
 * while holding the line on the press (dev, 20 September 2026) — the one
 * sentence the manual names as never to write, said by an agent that was in
 * fact doing the right thing. It asks the human to do the reporting, and the
 * switchboard already knows. Saying so here, in the answer the agent is
 * reading at that moment, is worth more than another line of manual.
 */
export const PRESS_WHAT_TO_DO = {
  // PASTE THE ADDRESS, said in those words because "put the page in front of
  // your human" was read as satisfied by MENTIONING a link.
  //
  // Two assistants, two runs, the same failure: holding the line on a press
  // while telling their human "the link's above" and "it's good for fifteen
  // minutes", having pasted nothing. One human said so outright — "I don't see
  // a link in what you just sent me, can you paste it?" — and was answered
  // "still waiting on the press" (21 September 2026). Both talked as though
  // the link had gone. Neither had sent it.
  //
  // So this says what to PASTE rather than what to do, and says what a link is
  // not, because that is the step being skipped.
  waiting:
    'PASTE THE WEB ADDRESS ABOVE into your next message to your human, on its own line, exactly as it is written. A sentence about a link is not a link — if they cannot see the address there is nothing for them to press. Say what the page asks, then wait again. Never ask them to report back: this call answers the instant they press.',
  expired:
    'There is nothing left to hand over, so fetch a fresh link, give them that one, and wait on the press that comes back with it.',
} as const;

const pressNote = (text: string) => ({ text, provenance: 'switchboard-system' as const });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface PressRow {
  id: string;
  account_id: string;
  action: string;
  ref_id: string;
  amount: string | number | null;
  ccy: string | null;
  counterparty_account: string;
  payload: string | null;
  used_at: Date | string | null;
  decision: 'approved' | 'declined' | null;
  expires_at: Date | string;
}

/**
 * The page this press belongs to, worked out again from the row it was minted
 * from. Nothing is minted here and nothing is written: the token is the HMAC
 * over the stored binding, so the same row always yields the same link, and
 * the one the human was handed is the one that comes back. It is never logged,
 * only handed to the agent that is already allowed to hold it.
 */
const linkFromRow = (cfg: Config, row: PressRow): string => url(cfg, signLink(row));

/** The shelf chosen on a shelf page, read off the question it was minted for. */
async function shelfPicked(accountId: string, attempt: string): Promise<string | undefined> {
  const r = await getPool().query(
    'SELECT picked FROM shelf_attempts WHERE account_id = $1 AND attempt = $2',
    [accountId, attempt],
  );
  return r.rows[0]?.picked ?? undefined;
}

/**
 * Hold the line until this human presses, and answer the moment they do.
 *
 * The row is loaded by id AND account, so a press id belonging to somebody
 * else is not found rather than waited on: an agent may only ever wait on a
 * link its own human was handed.
 *
 * A burnt link whose decision has not landed yet is not called pressed: the
 * page burns the link first and writes the decision after the thing itself has
 * gone through, so the two are a moment apart and a press that failed never
 * writes one at all. The loop keeps looking, and the cap is the backstop.
 */
export async function waitForPress(
  cfg: Config,
  accountId: string,
  pressId: string,
  opts: { capMs?: number; pollMs?: number } = {},
): Promise<PressAnswer> {
  if (!pressId) throw Object.assign(new Error('which press?'), { validation: true });
  const capMs = opts.capMs ?? PRESS_WAIT_CAP_MS;
  const pollMs = opts.pollMs ?? PRESS_POLL_MS;
  const deadline = Date.now() + capMs;

  const read = async (): Promise<PressRow> => {
    const r = await getPool().query(
      `SELECT id, account_id, action, ref_id, amount, ccy, counterparty_account, payload,
              used_at, decision, expires_at
         FROM approval_links WHERE id = $1 AND account_id = $2`,
      [pressId, accountId],
    );
    const row: PressRow | undefined = r.rows[0];
    if (!row) {
      throw Object.assign(new Error('NOT_FOUND: no press of yours with that id'), {
        notFound: true,
      });
    }
    return row;
  };

  for (;;) {
    const row = await read();
    if (row.used_at && row.decision === 'approved' && row.action === 'shelf-pick') {
      const picked = await shelfPicked(accountId, row.ref_id);
      if (picked) {
        const { shelfPickedNote, shelfInWords } = await import('./shelfPick.js');
        const said = shelfPickedNote(picked);
        return {
          pressed: true,
          decision: 'approved',
          picked: { category: picked, words: shelfInWords(picked) },
          what_to_do: said.what_to_do,
          note: pressNote(said.say),
        };
      }
    }
    if (row.used_at && (row.decision === 'approved' || row.decision === 'declined')) {
      // Declining ends it, so that sentence promises nothing and needs no
      // lane. An approval is a wait, and what the agent may say about it turns
      // on whether it can wake itself: one arrangement read, on the one branch
      // that needs it.
      const said =
        row.decision === 'approved'
          ? await (async () => {
              const { arrangement, hearsVia } = await readLaneFacts(accountId);
              return sayFor('press_approved', arrangement, { hearsVia });
            })()
          : PRESS_SENTENCES.declined;
      return {
        pressed: true,
        decision: row.decision,
        note: pressNote(said),
      };
    }
    if (!row.used_at && new Date(row.expires_at).getTime() <= Date.now()) {
      return {
        pressed: false,
        expired: true,
        what_to_do: PRESS_WHAT_TO_DO.expired,
        note: pressNote(PRESS_SENTENCES.expired),
      };
    }
    if (Date.now() + pollMs > deadline) {
      const link = linkFromRow(cfg, row);
      return {
        pressed: false,
        link,
        what_to_do: PRESS_WHAT_TO_DO.waiting,
        note: pressNote(`${PRESS_SENTENCES.waiting} ${link}`),
      };
    }
    await sleep(pollMs);
  }
}

/** Exported for the page that renders the question these links carry. */
export { thingOf as categoryWordsFor };
