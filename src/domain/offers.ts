import { aboutThing } from '../email/templates.js';
import { getPool } from '../db.js';
import { writeConsentEvent } from '../crypto.js';
import { getMatch, ownCardId, sideOf } from './matches.js';
import { isLadderPattern } from './matchRules.js';
import {
  checkAgainstMandate,
  noMandateRefusal,
  outsideMandateRefusal,
  readNegotiation,
  readNegotiationMode,
  relayRefusal,
} from './negotiation.js';
import { clearOfferDrafts, saveOfferDraft } from './offerDrafts.js';
import { checkOfferRate, checkPerMatchOfferRate } from './quotas.js';
import { OsbError, SCHEMA_VERSION, assertOutbound, assertReasonless } from '../protocol.js';
import type { Config } from '../config.js';

export interface OfferRow {
  id: string;
  match_id: string;
  proposer_account: string;
  amount: string;
  ccy: string;
  expiry: Date;
  state: 'proposed' | 'awaiting-human' | 'accepted-by-human' | 'declined' | 'withdrawn';
  message: any;
  /** 'human' when typed on an approval page, 'agent' when sent from inside a
   *  mandate. Own-side bookkeeping: the offer schema has no slot for it. */
  authored_by?: 'human' | 'agent';
}

async function loadOffer(offerId: string): Promise<OfferRow> {
  const r = await getPool().query('SELECT * FROM offers WHERE id = $1', [offerId]);
  if (!r.rows[0]) throw Object.assign(new Error('offer not found'), { notFound: true });
  return r.rows[0];
}

export function serializeOffer(o: OfferRow) {
  const payload: any = {
    schema_version: SCHEMA_VERSION,
    kind: 'offer' as const,
    offer_id: o.id,
    intro_id: o.match_id,
    amount: Number(o.amount),
    ccy: o.ccy,
    expiry: new Date(o.expiry).toISOString(),
    state: o.state,
  };
  if (o.message) payload.message = o.message;
  // Outbound-validated: the offer schema has additionalProperties:false, so a
  // decline reason (or anything else) is structurally impossible here - and
  // assertReasonless makes it a server invariant on top of the schema.
  return assertReasonless(assertOutbound('offer', payload));
}

/** This side's own offer amounts on a match, oldest first (withdrawn aside). */
async function ownOfferAmounts(accountId: string, matchId: string): Promise<number[]> {
  const r = await getPool().query(
    `SELECT amount FROM offers
     WHERE match_id = $1 AND proposer_account = $2 AND state <> 'withdrawn'
     ORDER BY created_at ASC`,
    [matchId, accountId],
  );
  return r.rows.map((x: any) => Number(x.amount));
}

/**
 * Put a figure on the table.
 *
 * `author` is the whole of the new rule. A figure authored by the human — typed
 * on their own approval page — goes straight through, because the point of the
 * page is that they wrote it. A figure an agent wants to send has to get past
 * the card's negotiation mode first: refused outright in relay ("Pass on"), and
 * in mandate ("Auto-negotiate") allowed only inside the box the human drew.
 * Everything after that gate — stage, rates, ladder detection — is unchanged
 * and applies to both.
 */
export async function proposeOffer(
  cfg: Config,
  accountId: string,
  input: { match_id: string; amount: number; ccy: string; expiry: string; message?: string },
  opts: { author?: 'agent' | 'human' } = {},
) {
  const author = opts.author ?? 'agent';
  const m = await getMatch(input.match_id);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, accountId);
  if (m.state !== 'open') throw new OsbError('NOT_UNLOCKED_YET');
  if (m.stage < 2) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'Offers open once both sides have said they are interested.',
    });
  }
  // Best offer, if this is one: the floor, the one-number rule and the closed
  // window, all refused to the side that tried rather than silently dropped.
  await assertBestOfferRules(m, accountId, input);
  if (author === 'agent') {
    await assertAgentMayPropose(cfg, accountId, m.id, ownCardId(m, accountId), input);
  }
  await checkOfferRate(accountId, cfg.quotas);
  // Anti-probing: max 3 offers per side per match per rolling 24h.
  await checkPerMatchOfferRate(accountId, input.match_id);
  const message = input.message
    ? { text: input.message.slice(0, 2000), provenance: 'counterparty-untrusted' }
    : null;
  const r = await getPool().query(
    `INSERT INTO offers (match_id, proposer_account, amount, ccy, expiry, message, authored_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.match_id,
      accountId,
      input.amount,
      input.ccy,
      input.expiry,
      message ? JSON.stringify(message) : null,
      author,
    ],
  );
  await detectLadderProbing(accountId, input.match_id);
  // A figure is movement: the slot's clock starts again (domain/sequencer.ts).
  const { noteMovement } = await import('./sequencer.js');
  await noteMovement(input.match_id);
  // A figure is on the table now, so anything this side's agent parked for
  // the human to check has been answered.
  await clearOfferDrafts(accountId, input.match_id);
  // A figure the HUMAN typed on their own page has nobody carrying it across:
  // the other side's agent will find it on its next sweep, and if that agent
  // only wakes when spoken to, "its next sweep" may be days away. So the other
  // human is told by email, when email is how they hear about this.
  if (author === 'human') await notifyCounterpartyOfHumanOffer(cfg, r.rows[0]);
  return serializeOffer(r.rows[0]);
}

/**
 * Tell the other human a number is on the table, when email is how they hear
 * about the switchboard. Best-effort in every direction: the offer is already
 * on the board and on both agents' next sweep, so a failed send delays
 * discovery rather than undoing anything.
 */
async function notifyCounterpartyOfHumanOffer(cfg: Config, o: OfferRow): Promise<void> {
  try {
    const { getHearsVia } = await import('./accounts.js');
    const m = await getMatch(o.match_id);
    if (!m) return;
    const counterparty = o.proposer_account === m.account_want ? m.account_have : m.account_want;
    if ((await getHearsVia(counterparty)) !== 'email') return; // their agent brings it
    const { categoryLeafLabel } = await import('./matchRules.js');
    const { sendOfferOnTheTableEmail } = await import('../counter/email.js');
    const { accountEmail } = await import('./counterOps.js');
    const to = await accountEmail(counterparty, 'offer-on-the-table');
    if (!to) return;
    await sendOfferOnTheTableEmail(cfg, to, counterparty, {
      offerId: o.id,
      matchId: o.match_id,
      amount: Number(o.amount),
      ccy: o.ccy,
      categoryLabel: categoryLeafLabel(m.category),
      side: counterparty === m.account_want ? 'want' : 'have',
    });
  } catch (err) {
    console.warn('offer-on-the-table email failed; the offer stands', err);
  }
}

/**
 * The gate an agent's own figure has to pass. Throws CONSENT_REQUIRED carrying
 * the human's own link; the reason names the boundary, and the only reader is
 * the agent of the human who set it.
 */
async function assertAgentMayPropose(
  cfg: Config,
  accountId: string,
  matchId: string,
  cardId: string,
  input: { amount: number; ccy: string; message?: string },
): Promise<void> {
  // The mode is read first, and on its own: a card on Pass on is refused
  // without the mandate ever being decrypted, so a refusal costs no audit line
  // and tells an agent nothing about numbers it may not act on.
  if ((await readNegotiationMode(accountId, cardId)) === 'relay') {
    // The refusal stands whatever happens next; parking the figure the agent
    // was carrying is a courtesy to its human, so a failure to park it must
    // never turn a clean refusal into a 500.
    try {
      await saveOfferDraft(accountId, matchId, {
        amount: input.amount,
        ccy: input.ccy,
        ...(input.message ? { note: input.message } : {}),
      });
    } catch {
      // The human still gets their link; the box simply opens empty.
    }
    // The link the refusal carries is the one-question page for THIS figure:
    // "Send $440 AUD to Sam for your mountain bike?", bound to the amount the
    // agent tried to send, so the person presses once and it goes. A link that
    // cannot be minted costs the courtesy and nothing else — the refusal still
    // stands, pointing at the page where they can type the figure themselves.
    let link: string | undefined;
    try {
      const { sendNumberLink } = await import('./humanLinks.js');
      link = (
        await sendNumberLink(cfg, accountId, matchId, {
          amount: input.amount,
          ccy: input.ccy,
          ...(input.message ? { message: input.message } : {}),
        })
      ).link;
    } catch {
      link = undefined;
    }
    throw relayRefusal(cfg, matchId, link);
  }
  const neg = await readNegotiation(accountId, cardId, {
    purpose: 'mandate-offer-check',
    refs: { match_id: matchId },
  });
  if (!neg.mandate) throw noMandateRefusal(cfg, cardId);
  const priorAmounts = await ownOfferAmounts(accountId, matchId);
  const check = checkAgainstMandate(neg.mandate, neg.cardType, {
    amount: input.amount,
    ccy: input.ccy,
    priorAmounts,
    isOpening: priorAmounts.length === 0,
  });
  if (!check.ok) throw outsideMandateRefusal(cfg, cardId, check.reason);
}

// ---------------------------------------------------------------------------
// BEST OFFER: one sealed number each, and nothing readable from inside it.
//
// A have can be sold two ways (cards.sale). 'straight' is the ask as it
// stands, worked through one introduction at a time. 'best-offer' opens a
// short GATHERING WINDOW at the first candidate: everyone who fits is
// introduced at once, slots are ignored for its length, and each buyer may put
// exactly ONE number on the table.
//
// WHAT IS SEALED, and why each part of it matters:
//
//   - a buyer's agent sees its own number and no other. Not a highest, not a
//     count, not a rank, not a "you are in front" — there is nothing for an
//     agent to read back to its human that would turn this into an auction, so
//     it cannot become one by accident or by probing;
//   - the seller's agent sees NONE of them until the window closes. A seller
//     who could watch them arrive would be running an auction too, and would
//     be tempted to tell somebody where they stood;
//   - the ask is the FLOOR. A number under it is refused to the buyer's own
//     agent, with the reason, and never reaches the seller at all;
//   - a number after the close is refused. A buyer who put none by the close
//     is filed away the way a lapsed slot is.
//
// When the window closes the seller sees every number at once, best first,
// with the fit facts beside each (how far, how soon, how reliable — bands, not
// figures). Accepting one declines the rest, and the rest are told only that
// the seller went with someone else.
// ---------------------------------------------------------------------------

/** The have behind an introduction, with everything best offer turns on. */
interface SaleRow {
  card_id: string;
  sale: string;
  ask: { amount: number; ccy: string } | null;
  gather_until: Date | null;
  gather_closed_at: Date | null;
  open: boolean;
}

async function saleOf(matchId: string): Promise<SaleRow | undefined> {
  const r = await getPool().query(
    `SELECT c.id AS card_id, c.sale, c.ask, c.gather_until, c.gather_closed_at,
            (c.gather_until IS NOT NULL AND c.gather_until > now()
             AND c.gather_closed_at IS NULL) AS open
       FROM matches m JOIN cards c ON c.id = m.card_have
      WHERE m.id = $1`,
    [matchId],
  );
  return r.rows[0];
}

/**
 * Is what this account can see about the money sealed right now? True only for
 * the SELLER on a best-offer have whose gathering window is still open. Every
 * read of the money goes through it, so there is no path — sweep, table, list
 * — on which a number reaches a seller early.
 */
export async function bestOfferSealedFrom(matchId: string, accountId: string): Promise<boolean> {
  const m = await getMatch(matchId);
  if (!m || m.account_have !== accountId) return false;
  const sale = await saleOf(matchId);
  return !!sale && sale.sale === 'best-offer' && !!sale.open;
}

/** The refusals a best-offer number can meet, each said plainly to the side
 *  that tried. None of them leaks anything about anyone else's number. */
async function assertBestOfferRules(
  m: { id: string; account_have: string; account_want: string },
  accountId: string,
  input: { amount: number; ccy: string },
): Promise<void> {
  const sale = await saleOf(m.id);
  if (!sale || sale.sale !== 'best-offer') return;
  if (accountId === m.account_have) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action:
        'This one is on best offer, so the numbers come to your human rather than from them. They will see them all when the window closes.',
    });
  }
  if (!sale.open) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'The window on this has closed.',
    });
  }
  const ask = sale.ask;
  if (ask && Number.isFinite(ask.amount)) {
    const sameCcy = String(input.ccy).toUpperCase() === String(ask.ccy).toUpperCase();
    if (!sameCcy || Number(input.amount) < Number(ask.amount)) {
      // The floor is the seller's own asking price, which the buyer's side has
      // already been shown, so naming it here discloses nothing new.
      throw new OsbError('NOT_UNLOCKED_YET', {
        human_action: `That is below the floor on this one: the asking price is ${ask.amount} ${String(ask.ccy).toUpperCase()}, and a number under it is not carried.`,
      });
    }
  }
  const prior = await getPool().query(
    `SELECT 1 FROM offers
      WHERE match_id = $1 AND proposer_account = $2 AND state <> 'withdrawn' LIMIT 1`,
    [m.id, accountId],
  );
  if (prior.rowCount) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action:
        'This is a best offer, so it is one number each. Your human has already put theirs in and it stands until the window closes.',
    });
  }
}

/**
 * Everything the seller sees once the window has closed: every number on this
 * have, best first, with the fit facts beside each. The facts are BANDS, never
 * figures — how far, how soon, how reliable — so the seller can choose on more
 * than money without anybody's private inputs crossing.
 */
export interface BestOfferLine {
  offer_id: string;
  intro_id: string;
  amount: number;
  ccy: string;
  message: string | null;
  /** 'nearby' | 'a drive away' | 'further afield' | 'not local' */
  distance: string;
  /** 'today' | 'within days' | 'no rush' */
  timing: string;
  /** 'well established' | 'getting started' */
  reliability: string;
}

const distanceBand = (km: number | null): string => {
  if (km === null) return 'not local';
  if (km <= 10) return 'nearby';
  if (km <= 50) return 'a drive away';
  return 'further afield';
};

const timingBand = (urgency: string | null): string =>
  urgency === 'today' ? 'today' : urgency === 'days' ? 'within days' : 'no rush';

/**
 * The closed window's result for the seller, or undefined when there is none
 * (not a best offer, still open, or nobody put a number in).
 */
export async function bestOfferResult(
  cardId: string,
  accountId: string,
): Promise<{ offers: BestOfferLine[]; note: string } | undefined> {
  const c = await getPool().query(
    `SELECT id, account_id, sale, category, geo_lat, geo_lon, gather_until, gather_closed_at
       FROM cards WHERE id = $1`,
    [cardId],
  );
  const card = c.rows[0];
  if (!card || card.account_id !== accountId || card.sale !== 'best-offer') return undefined;
  if (!card.gather_until || new Date(card.gather_until) > new Date()) return undefined;
  const r = await getPool().query(
    `SELECT o.id, o.match_id, o.amount, o.ccy, o.message,
            w.urgency AS want_urgency, w.geo_lat AS want_lat, w.geo_lon AS want_lon,
            COALESCE(rep.score, 0.5) AS reliability
       FROM offers o
       JOIN matches m ON m.id = o.match_id
       JOIN cards w ON w.id = m.card_want
       LEFT JOIN reputation rep ON rep.account_id = m.account_want
      WHERE m.card_have = $1 AND o.state IN ('proposed','awaiting-human','accepted-by-human')
      ORDER BY o.amount DESC, o.created_at ASC`,
    [cardId],
  );
  if (!r.rowCount) return undefined;
  const { haversineKm } = await import('../geo/geohash.js');
  const offers: BestOfferLine[] = (r.rows as any[]).map((o) => {
    const placed =
      typeof card.geo_lat === 'number' &&
      typeof card.geo_lon === 'number' &&
      typeof o.want_lat === 'number' &&
      typeof o.want_lon === 'number';
    return {
      offer_id: o.id as string,
      intro_id: o.match_id as string,
      amount: Number(o.amount),
      ccy: o.ccy as string,
      message: offerMessageText(o.message),
      distance: distanceBand(
        placed
          ? haversineKm(
              { lat: Number(card.geo_lat), lon: Number(card.geo_lon) },
              { lat: Number(o.want_lat), lon: Number(o.want_lon) },
            )
          : null,
      ),
      timing: timingBand(o.want_urgency),
      reliability: Number(o.reliability) >= 0.5 ? 'well established' : 'getting started',
    };
  });
  // The category as a person says it mid-sentence, from the taxonomy itself.
  const { categoryPhrase } = await import('./matchRules.js');
  const thing = categoryPhrase(card.category);
  const n = offers.length;
  return {
    offers,
    note:
      `${n === 1 ? 'One person has' : `${n} people have`} put a number on your ${thing}; ` +
      `here ${n === 1 ? 'it is' : 'they are, best first'}. It is your human's choice. ` +
      'Say the word and I will fetch their link to accept one.',
  };
}

/**
 * The seller took one of them. Everybody else's number is declined and their
 * introduction is filed away as not chosen, which is what their sweep reads
 * the sentence off. No figure and no count travels to any of them.
 */
async function declineTheRest(acceptedOfferId: string, matchId: string): Promise<void> {
  const c = await getPool().query(
    `SELECT c.id FROM matches m JOIN cards c ON c.id = m.card_have
      WHERE m.id = $1 AND c.sale = 'best-offer'`,
    [matchId],
  );
  const cardId = c.rows[0]?.id;
  if (!cardId) return;
  await getPool().query(
    `UPDATE offers o SET state = 'declined', updated_at = now()
       FROM matches m
      WHERE o.match_id = m.id AND m.card_have = $1 AND o.id <> $2
        AND o.state IN ('proposed','awaiting-human')`,
    [cardId, acceptedOfferId],
  );
  await getPool().query(
    `UPDATE matches SET state = 'archived', archived_at = now(),
            archived_via = 'not-chosen', live = false, updated_at = now()
      WHERE card_have = $1 AND id <> $2 AND state = 'open'`,
    [cardId, matchId],
  );
}

/**
 * The underpricing note, and the k-anonymity floor under it.
 *
 * When a straight-sale have has at least five introductions — live or in line
 * — whose sealed limits ALL clear the ask by a quarter or more, the person
 * selling is probably asking too little, and telling them is worth doing. What
 * is NOT worth doing is telling them anything else: there is no figure in the
 * sentence, no count of people, and no suggestion of what to ask instead, so
 * nothing about any individual buyer's private ceiling can be read out of it.
 * Five is the floor because below it the note is about one or two people
 * rather than about the market, and that is exactly what a private band must
 * never become.
 *
 * It goes to the holder and to nobody else, once per have (cards.price_note_at).
 */
export const UNDERPRICED_FLOOR = 5;

export const UNDERPRICED_NOTE =
  'A lot of people fit this with room to spare. You may be asking too little.';

export async function underpricingNote(
  cardId: string,
  accountId: string,
): Promise<string | undefined> {
  const r = await getPool().query(
    `SELECT c.id,
            (SELECT count(*)::int FROM matches m
              WHERE m.card_have = c.id AND m.state = 'open') AS fitting,
            (SELECT count(*)::int FROM matches m
              WHERE m.card_have = c.id AND m.state = 'open' AND m.clears_ask_25) AS with_room
       FROM cards c
      WHERE c.id = $1 AND c.account_id = $2 AND c.type = 'HAVE'
        AND c.sale = 'straight' AND c.ask IS NOT NULL AND c.price_note_at IS NULL`,
    [cardId, accountId],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  const fitting = Number(row.fitting ?? 0);
  const withRoom = Number(row.with_room ?? 0);
  if (fitting < UNDERPRICED_FLOOR || withRoom < fitting) return undefined;
  const stamped = await getPool().query(
    `UPDATE cards SET price_note_at = now(), updated_at = now()
      WHERE id = $1 AND price_note_at IS NULL RETURNING id`,
    [cardId],
  );
  return stamped.rowCount ? UNDERPRICED_NOTE : undefined;
}

/**
 * Ladder detection: three offers by one side on one match with strictly
 * monotonically increasing amounts is the classic reserve-probing walk.
 * Flags the account's reputation stub (internal only - the counterparty
 * learns nothing, and the offer itself still stands).
 */
async function detectLadderProbing(accountId: string, matchId: string): Promise<void> {
  const r = await getPool().query(
    `SELECT amount FROM offers
     WHERE match_id = $1 AND proposer_account = $2 AND state <> 'withdrawn'
     ORDER BY created_at ASC`,
    [matchId, accountId],
  );
  const amounts = r.rows.map((x: any) => Number(x.amount));
  // Fire exactly once, on the offer that completes the pattern.
  if (amounts.length === 3 && isLadderPattern(amounts)) {
    await getPool().query(
      `UPDATE reputation SET probing_flags = probing_flags + 1, updated_at = now()
       WHERE account_id = $1`,
      [accountId],
    );
  }
}

/**
 * Agent-reachable offer transitions. The ONLY accept-flavoured transition an
 * agent can make is proposed -> awaiting-human ("send_to_human"): parking the
 * offer for its human. 'accepted-by-human' is reachable exclusively via
 * acceptOfferByHuman() below, which has NO public route.
 */
export async function agentOfferAction(
  cfg: Config,
  accountId: string,
  offerId: string,
  action: 'send_to_human' | 'decline_offer' | 'withdraw_offer',
) {
  const o = await loadOffer(offerId);
  const m = await getMatch(o.match_id);
  if (!m) throw new Error('introduction missing');
  const side = sideOf(m, accountId); // throws notFound if not a party
  void side;
  const isProposer = o.proposer_account === accountId;

  if (action === 'withdraw_offer') {
    if (!isProposer) throw Object.assign(new Error('only the proposer can withdraw'), { notFound: true });
    if (o.state !== 'proposed' && o.state !== 'awaiting-human') {
      throw new OsbError('NOT_UNLOCKED_YET');
    }
    const r = await getPool().query(
      `UPDATE offers SET state='withdrawn', updated_at=now() WHERE id=$1 RETURNING *`,
      [offerId],
    );
    return serializeOffer(r.rows[0]);
  }

  if (isProposer) {
    throw Object.assign(new Error('the proposer cannot respond to its own offer'), {
      notFound: true,
    });
  }

  if (action === 'decline_offer') {
    // Declines carry NO reason. The API accepts none and the schema forbids one.
    if (o.state !== 'proposed' && o.state !== 'awaiting-human') throw new OsbError('NOT_UNLOCKED_YET');
    const r = await getPool().query(
      `UPDATE offers SET state='declined', updated_at=now() WHERE id=$1 RETURNING *`,
      [offerId],
    );
    return serializeOffer(r.rows[0]);
  }

  // send_to_human: the sole agent-reachable "accept-direction" state.
  if (o.state !== 'proposed') throw new OsbError('NOT_UNLOCKED_YET');
  if (new Date(o.expiry) < new Date()) throw new OsbError('NOT_UNLOCKED_YET');
  const r = await getPool().query(
    `UPDATE offers SET state='awaiting-human', updated_at=now() WHERE id=$1 RETURNING *`,
    [offerId],
  );
  // 0.D: parking an offer for a human creates a counter approval link
  // (single-use, 15-min TTL, HMAC-bound to account/action/amount/counterparty)
  // and notifies the human by email. Blind mode strips all content.
  await notifyHumanOfOffer(cfg, r.rows[0]);
  return serializeOffer(r.rows[0]);
}

/**
 * An agent parked a figure for its human. Nobody is emailed: the agent that
 * parked it is the one talking to the human right now, and hands them the
 * link in the same breath (respond(request_accept)). The "a number is on the
 * table" notice, sent when the figure first arrived, already covers the
 * person who was away. Run 6 (12 September 2026): "accept the $430" produced
 * an email telling Lachlan to ask his assistant about the thing his assistant
 * was telling him about.
 */
async function notifyHumanOfOffer(_cfg: Config, _o: OfferRow): Promise<void> {
  // Deliberately nothing. Kept as the seam so the two callers read the same.
}

/**
 * INTERNAL-ONLY human acceptance. There is deliberately no HTTP route to this
 * function: in 0.C it is reachable only through the IAM-gated internal ops
 * queue (and tests); in 0.D the counter's human-approval UI becomes the
 * caller. Records the consent event in the WORM log first.
 */
export async function acceptOfferByHuman(
  offerId: string,
  humanAccountId: string,
  recordedVia: string,
  cfg?: Config,
) {
  const o = await loadOffer(offerId);
  // Humans hold every gate. A live offer is theirs to accept from their own
  // page whether or not their agent has brought it to them yet — the parking
  // step (send_to_human) is the agent's advice arriving, never a lock on the
  // human's yes. Anything past live is a "not yet" to explain, never a 500.
  if (o.state !== 'awaiting-human' && o.state !== 'proposed') {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: `This offer is no longer open to accept (it is ${o.state}).`,
    });
  }
  const m = await getMatch(o.match_id);
  if (!m) throw new Error('introduction missing');
  const side = sideOf(m, humanAccountId);
  void side;
  if (o.proposer_account === humanAccountId) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action: 'This is your own side\'s offer. Only the other person can accept it.',
    });
  }
  // The collection window used to lock acceptance here while the accepting
  // human's own want or have was contested. It is gone (migration 030): a
  // human's yes is never blocked by how many other people are about.
  await writeConsentEvent({
    event: 'offer-accepted-by-human',
    offer_id: offerId,
    match_id: o.match_id,
    account_id: humanAccountId,
    recorded_via: recordedVia,
  });
  await getPool().query(
    `INSERT INTO consent_tokens (match_id, account_id, kind, recorded_via)
     VALUES ($1,$2,'offer-accept',$3) ON CONFLICT (match_id, account_id, kind) DO NOTHING`,
    [o.match_id, humanAccountId, recordedVia],
  );
  const r = await getPool().query(
    `UPDATE offers SET state='accepted-by-human', updated_at=now() WHERE id=$1 RETURNING *`,
    [offerId],
  );
  // Best offer: taking one is choosing, so the rest are declined in the same
  // breath and their people are told, plainly, that it went elsewhere.
  await declineTheRest(offerId, o.match_id);
  // The person whose figure this was is owed the news. It goes however they
  // hear about the switchboard: their agent may bring it on its next sweep,
  // and an agreed price is the one moment worth saying twice.
  if (cfg) await notifyProposerOfAcceptance(cfg, r.rows[0]);
  return serializeOffer(r.rows[0]);
}

/**
 * "Deal: $415 AUD agreed for your mountain bike." Sent to the human who made
 * the offer, once the other human has taken it. Nothing about money moving —
 * a settlement is a separate thing the two of them may or may not use — so the
 * copy hands the handover back to the two people. Best-effort: the acceptance
 * is recorded and stands whatever happens here.
 */
async function notifyProposerOfAcceptance(cfg: Config, o: OfferRow): Promise<void> {
  try {
    const m = await getMatch(o.match_id);
    if (!m) return;
    const { categoryLeafLabel } = await import('./matchRules.js');
    const { sendDealAgreedEmail } = await import('../counter/email.js');
    const { accountEmail } = await import('./counterOps.js');
    const to = await accountEmail(o.proposer_account, 'deal-agreed');
    if (!to) return;
    await sendDealAgreedEmail(cfg, to, o.proposer_account, {
      offerId: o.id,
      matchId: o.match_id,
      amount: Number(o.amount),
      ccy: o.ccy,
      categoryLabel: categoryLeafLabel(m.category),
      side: o.proposer_account === m.account_want ? 'want' : 'have',
    });
  } catch (err) {
    console.warn('deal-agreed email failed; the acceptance stands', err);
  }
}

// ---------------------------------------------------------------------------
// What check_in shows an agent about the money.
//
// The gap this closes: an agent could see a figure the OTHER side had sent and
// nothing at all about its own human's, because a human types their number on
// their own approval page and the agent that never saw it typed has no way to
// learn it happened. In the 2026-09-09 rehearsal that produced an agent
// telling its human their $420 "never went out" and describing the other
// side's $415 as unprompted, with the whole exchange sitting in the table all
// along. Both sides of the table cross now, most recent first.
// ---------------------------------------------------------------------------

export interface OfferLine {
  offer_id: string;
  /** Whose figure it is, said from the reading agent's side. */
  side: 'yours' | 'theirs';
  /** 'human' when their human typed it on their own page, 'agent' when an
   *  agent sent it from inside a mandate. Own-side bookkeeping either way. */
  authored_by: 'human' | 'agent';
  amount: number;
  ccy: string;
  state: OfferRow['state'];
  /** The words that rode with the figure, if any — the text and nothing else. */
  message: string | null;
  at: string;
}

/** The note text on an offer message: the words, never the wrapper. A message
 *  is stored as { text, provenance }, and rendering the object itself is what
 *  put "[object Object]" in front of a human. */
export function offerMessageText(message: any): string | null {
  if (!message) return null;
  if (typeof message === 'string') return message;
  const text = (message as any).text;
  return typeof text === 'string' && text.trim() ? text : null;
}

/**
 * Every live figure on an introduction, both sides, most recent first.
 * Withdrawn and declined offers drop out: they are no longer on the table and
 * an agent reading them back to its human would be reading history as news.
 */
export async function offerTable(accountId: string, matchId: string): Promise<OfferLine[]> {
  // Sealed: the seller on a best offer sees nothing at all until the window
  // closes. This is the single read the sweep uses, so the seal holds there.
  if (await bestOfferSealedFrom(matchId, accountId)) return [];
  const r = await getPool().query(
    `SELECT id, proposer_account, amount, ccy, state, message, authored_by, created_at
       FROM offers
      WHERE match_id = $1 AND state IN ('proposed', 'awaiting-human', 'accepted-by-human')
      ORDER BY created_at DESC`,
    [matchId],
  );
  return (r.rows as any[]).map((o) => ({
    offer_id: o.id as string,
    side: o.proposer_account === accountId ? ('yours' as const) : ('theirs' as const),
    authored_by: (o.authored_by === 'human' ? 'human' : 'agent') as 'human' | 'agent',
    amount: Number(o.amount),
    ccy: o.ccy as string,
    state: o.state as OfferRow['state'],
    message: offerMessageText(o.message),
    at: new Date(o.created_at).toISOString(),
  }));
}

/**
 * The plain sentence that rides with the table. Written from the reading
 * agent's side, in the words its human would use, with no figure left
 * unexplained and no machinery named.
 *
 * Three shapes, in the order they matter:
 *  - the other side has accepted this human's figure: the deal is done, and
 *    what is left is a handover the two people arrange;
 *  - both sides have numbers out: say both, so an agent never describes its
 *    own human's offer as something that never went out;
 *  - one side has a number out: whose it is, and what happens next.
 */
export function offerTableNote(
  lines: OfferLine[],
  thing: string,
  side: 'want' | 'have' = 'have',
): string | undefined {
  if (!lines.length) return undefined;
  const said = (l: OfferLine) => `${l.amount} ${l.ccy}`;
  const mine = lines.filter((l) => l.side === 'yours');
  const theirs = lines.filter((l) => l.side === 'theirs');
  const acceptedMine = mine.find((l) => l.state === 'accepted-by-human');
  const about = aboutThing(thing, side);
  if (acceptedMine) {
    return `The other side has accepted your human's ${said(acceptedMine)}${about}. The switchboard's part is done: agree pickup or handover in the conversation.`;
  }
  const acceptedTheirs = theirs.find((l) => l.state === 'accepted-by-human');
  if (acceptedTheirs) {
    return `Your human has accepted ${said(acceptedTheirs)}${about}. The switchboard's part is done: agree pickup or handover in the conversation.`;
  }
  const newestMine = mine[0];
  const newestTheirs = theirs[0];
  if (newestMine && newestTheirs) {
    const earlier = newestMine.at <= newestTheirs.at ? newestMine : newestTheirs;
    const later = earlier === newestMine ? newestTheirs : newestMine;
    const clause = (l: OfferLine, isLater: boolean) =>
      l.side === 'yours'
        ? `your human ${isLater ? 'came back with' : 'offered'} ${said(l)}${l.authored_by === 'human' ? ' on their approval page' : ''}`
        : `the other side ${isLater ? 'has answered with' : 'offered'} ${said(l)}`;
    const both = `${clause(earlier, false)}; ${clause(later, true)}`;
    return `${both[0].toUpperCase()}${both.slice(1)}. Nothing is agreed until one of the two humans says yes on their own page.`;
  }
  if (newestMine) {
    return `Your human's ${said(newestMine)}${newestMine.authored_by === 'human' ? ', typed on their approval page,' : ''} is on the table${about}. The other side answers when they next hear from their own assistant.`;
  }
  const l = newestTheirs!;
  return `The other side has offered ${said(l)}${about}${l.message ? ` — "${l.message}"` : ''}. It is your human's to weigh up; say the word and I will answer, and nothing is agreed until they say so.`;
}

export async function listOffers(accountId: string, matchId: string) {
  const m = await getMatch(matchId);
  if (!m) throw Object.assign(new Error('introduction not found'), { notFound: true });
  sideOf(m, accountId);
  // The same seal as the sweep: asking a second way is still asking early.
  if (await bestOfferSealedFrom(matchId, accountId)) return [];
  const r = await getPool().query(
    `SELECT * FROM offers WHERE match_id = $1 ORDER BY created_at ASC`,
    [matchId],
  );
  return (r.rows as OfferRow[]).map(serializeOffer);
}
