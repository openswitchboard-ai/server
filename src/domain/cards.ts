import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { encryptField } from '../crypto.js';
import { getAccount } from './accounts.js';
import {
  OPEN_CARDS_GUARD_SQL,
  checkPublishQuota,
  recordPublishWithinQuota,
} from './quotas.js';
import {
  OsbError,
  SCHEMA_VERSION,
  checkSchemaVersion,
  validatePayload,
} from '../protocol.js';
import { categoryDenied, categoryGate } from '../denylist.js';
import { decidingCheck, runIntake } from '../intake/pipe.js';
import { attributeFields } from '../intake/checks/moneyFigure.js';
import { canonicaliseAttributes } from './attributeCanon.js';
import { suggestCategories, suggestionSentence } from './categorySuggest.js';
import { SHELF_NONE_OPTION, snapCategory } from './categoryBackfill.js';
import {
  closeShelfAttempt,
  markNoneOfThese,
  openShelfAttempt,
  readShelfAttempt,
  recordShelfGap,
  shortlistForGap,
  type ShelfAttempt,
  type ShelfGapOutcome,
} from './shelfGaps.js';
import { SHELF_PICK_ACTION, generalShelf, shelfInWords, shelfPickLink } from './shelfPick.js';
import {
  DETAIL_HUMAN_ACTION,
  DETAIL_UNKNOWN_UNMATCHED,
  detailShortfall,
} from './postingDetail.js';
import {
  FIGURE_HUMAN_ACTION,
  figureQuestions,
  figuresOnPosting,
  type PostingFigure,
} from './postingFigure.js';
import {
  closePostingRef,
  noteAsked,
  readPostingRef,
  type PostingGate,
} from './postingRef.js';
import { type Arrangement } from './arrangement.js';
import { readLaneFacts, sayFor } from './lanes.js';
import type { HearsVia } from './accounts.js';
import { categoryLabelPath } from './matchRules.js';
import { recordCategoryMiss } from './categoryMisses.js';
import { nearMissesForCards } from './nearMisses.js';
import { NormalisedGeo, normaliseGeo } from '../geo/normalise.js';
import { ownCountryHint } from './profile.js';
import { rejectionInPlainWords, screeningReasonInPlainWords } from './screening.js';
import { categoryPhrase, theirThing } from '../email/templates.js';
import type { Config } from '../config.js';

/**
 * What a publish or an amend answers with. `location_resolved` is the
 * switchboard saying out loud where it put the card and how far it reaches —
 * "Canberra, Australian Capital Territory, Australia — matching within 25 km",
 * or "— reaching all of Australia", or "— reaching anywhere". The agent folds
 * that into what it tells its human, and a card that landed somewhere
 * unintended, or that reaches further than its owner meant, is caught by the
 * one person who would know.
 */
export interface PublishResult {
  intent_id: string;
  state: string;
  location_resolved?: { display: string; radius_km: number };
  /** The node the posting is actually filed under (see filedUnder below). */
  /** The shelf in plain words, for saying aloud. */
  filed_under?: string;
  /** The dotted path the posting is filed under, under the name it was sent in by. */
  category?: string;
  /** Said out loud, and only where that is somewhere other than what was sent. */
  filed_under_note?: { text: string; provenance: 'switchboard-system' };
  /** The sentence to say once it is up (see WHAT_HAPPENS_NEXT_NOTE). */
  what_happens_next_note?: { text: string; provenance: 'switchboard-system' };
}

/**
 * THE SENTENCE TO SAY AFTER POSTING, because the vague one keeps being said.
 *
 * Two things went wrong in the 19 September rehearsal and this note answers
 * both. An assistant posted and then told its human "I'll check back shortly
 * and let you know the moment someone comes forward, no need to keep asking
 * me" — with nothing scheduled, nothing saved, and no way to wake itself, so
 * nobody was ever going to let anybody know. And the same assistant looked no
 * more that day, although screening takes seconds and the board is checked the
 * moment a posting clears it, so somebody can be waiting within minutes.
 *
 * The note this replaced said the rule to every account alike: tell them the
 * switchboard emails them, and promise to tell them yourself only if you have
 * saved an arrangement. A rule is a thing an assistant has to apply to itself,
 * and the one that said the sentence had read a version of it. So the note is
 * a FACT ABOUT THIS ACCOUNT instead, read off what is actually saved: either
 * there is a standing arrangement that says this agent runs on its own and how
 * often it looks, or there is not, and the note says which and what may be
 * said out loud because of it.
 */
export function whatHappensNextNote(
  a: Arrangement,
  hearsVia?: HearsVia,
): {
  text: string;
  provenance: 'switchboard-system';
} {
  return {
    text: sayFor('after_posting', a, { hearsVia }),
    provenance: 'switchboard-system' as const,
  };
}

/** The note for an account with nothing saved, which is where every one starts. */
export const WHAT_HAPPENS_NEXT_NOTE = whatHappensNextNote({});

/**
 * The note for this account, on the two facts it actually holds: the
 * arrangement, and whether the switchboard writes to this human at all. One
 * read for both. Best-effort in the same sense the rest of the courtesies here
 * are: an unreadable row gives the note for an account with nothing saved,
 * which is the careful answer — it promises the human nothing and claims no
 * post on their behalf.
 */
async function whatHappensNextFor(accountId: string): Promise<{
  text: string;
  provenance: 'switchboard-system';
}> {
  const facts = await readLaneFacts(accountId);
  return whatHappensNextNote(facts.arrangement, facts.hearsVia);
}

/**
 * WHERE THE POSTING WAS FILED, said out loud.
 *
 * Run 9 on dev: a have went up under 'goods.gaming.sim-racing' and a want for
 * the same object under 'goods.electronics'. Neither assistant was told
 * anything was wrong, because nothing was refused — the catalogue is a deny
 * list and an unwritten leaf goes up. But the matcher reads the category as a
 * hard gate, there is no goods.gaming node for a sibling rule to reach, and
 * both candidate pools came out empty. Two people wanting the same thing, on
 * the same switchboard, in silence.
 *
 * So an unknown path is snapped onto the nearest node the catalogue knows
 * (domain/categoryBackfill.ts snapCategory), and the answer says where that
 * was. The assistant's own path is kept on the row and is never lost. The
 * sentence is a protocol answer for the assistant to fold into what it tells
 * its human, in the same shape as every other note on the wire.
 */
/**
 * Every remap, written down the way the ops sweep writes its own: the path
 * that was sent, the node it went to, and how that node was chosen. Nothing
 * about the person, and nothing from the posting itself.
 */
function logSnap(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/**
 * The one line on a SHELF_UNCLEAR refusal. It names the two moves: which of
 * these, or none of them. "None of these" used to mean the top level, where
 * the posting went up at once; since 20 September it opens the searchable
 * shelf page instead (SHELF_PICK, domain/shelfPick.ts), so the answer is sent
 * back as its own word and the switchboard hands over the page.
 */
function shelfUnclearAction(): string {
  return `The catalogue has nothing written down for that, and the shelves nearest it disagree. Ask your human which of these is closest to what the thing is, then post it again with that category. If they say none of these, post it again with category ${SHELF_NONE_OPTION} and you are handed a page where they search every shelf. Put only the question to them: how the posting is filed and sent again is yours to handle quietly.`;
}

// shelfInWords, the shelf the way a person would say it, lives beside the
// shelf page now (domain/shelfPick.ts), because the page says it too.

function filedUnderNote(decision: { changed: boolean; category: string }): string {
  // The shelf somebody asked for still needs WORDS. The first rehearsal-suite
  // run (19 September 2026): an assistant chose goods.electronics itself, so
  // nothing had moved and no sentence came back, only the dotted path, and it
  // read the path to its human because the path was all it had been given.
  if (!decision.changed) {
    return `Filed under ${shelfInWords(decision.category)}. Say it in those words; the dotted path is yours to work with and is never said aloud.`;
  }
  return `Filed under ${shelfInWords(decision.category)}, which is the nearest thing the catalogue knows. Your own words for it are kept as they were. Say where it went, and if that is the wrong shelf, take it down and put it up again somewhere better.`;
}

/**
 * A posting's location, resolved — and, when the name turns out to be one
 * several real towns answer to, asked again with the human's own country in
 * front of the list.
 *
 * The rehearsal (19 September 2026): a person living in Franklin, ACT was
 * offered five Franklins, all of them in the United States, because the
 * candidates are ranked on population and five American towns outrank both
 * Australian ones. The hint fixes the order; it never picks, so the human is
 * asked exactly as before.
 *
 * Reading the hint costs an identity decrypt, so it is read only on the
 * refusal that needs it. Nothing about a posting whose place resolves cleanly
 * — which is nearly all of them — touches the account at all.
 */
async function placeCard(geo: any, accountId: string, purpose: string): Promise<NormalisedGeo> {
  try {
    return normaliseGeo(geo);
  } catch (e) {
    if (!(e instanceof OsbError) || e.payload.code !== 'LOCATION_AMBIGUOUS') throw e;
    // The same refusal again, with the candidates in the order this human
    // should hear them. It raises LOCATION_AMBIGUOUS once more; it returns
    // only if a hint somehow settled the name, which is fine either way.
    return normaliseGeo(geo, await ownCountryHint(accountId, purpose));
  }
}

function locationEcho(geo: NormalisedGeo): Pick<PublishResult, 'location_resolved'> {
  return geo.resolved
    ? { location_resolved: { display: geo.resolved.display, radius_km: geo.radius_km } }
    : {};
}

export interface CardRow {
  id: string;
  account_id: string;
  schema_version: string;
  type: 'WANT' | 'HAVE';
  category: string;
  /** The path the posting assistant sent, before any snap. Never a matching key. */
  category_as_posted?: string | null;
  /** The poster's own plain words for the thing, where they gave any. */
  kind: string | null;
  /** Their other words for the same thing: up to six short phrases (050). */
  also_called?: string[] | null;
  /** Short phrases they say it is NOT: a negative word signal only (050). */
  not_these?: string[] | null;
  geo: any;
  geo_lat: number | null;
  geo_lon: number | null;
  geo_radius_km: number | null;
  geo_country: string | null;
  attributes: any;
  ask: any;
  urgency: string;
  visibility: string;
  protocol_status: 'active' | 'latent';
  lifecycle_state: string;
  price_enc: Buffer | null;
  ttl_days: number;
  expires_at: Date;
  screening: any;
  /** How many live introductions this can hold at once (domain/sequencer.ts). */
  slots?: number;
  /** Haves only: 'straight' or 'best-offer'. */
  sale?: 'straight' | 'best-offer';
}

/**
 * The category gate, identical on every deployment. The catalogue is a DENY
 * LIST (docs/taxonomy-question.md, denylist.ts categoryGate): a want or a have
 * goes up unless somebody deliberately closed the door on it, which means a
 * reserved family or a top level the taxonomy has no name for. A leaf nobody
 * has written down is not a closed door, so it goes up.
 *
 * What it costs is the word for the thing, and that is what `kind` buys back:
 * an unknown leaf has to say in plain words what it is, or none of the
 * sentences the switchboard writes about it can name it. That refusal is a
 * validation refusal rather than CATEGORY_PROHIBITED, because the category was
 * fine and the posting was short of a field.
 *
 * When it does refuse, the switchboard adds up to three of the closest open
 * categories so the agent can correct itself on the next call. Working those
 * out is a courtesy — it never changes the decision, and a refusal stands
 * whether or not the suggestions arrive.
 *
 * Returns whether the taxonomy knew the leaf, because the caller writes the
 * unknown ones down AFTER the posting is up (recordUnknownLeaf below).
 */
export async function assertCategoryOpen(
  cfg: Config,
  category: string,
  accountId: string,
  kind?: unknown,
): Promise<{ known: boolean }> {
  const gate = categoryGate(category);
  if (!gate.ok) {
    const { categories } = await suggestCategories(cfg, category, 3);
    throw new OsbError('CATEGORY_PROHIBITED', {
      human_action: suggestionSentence(gate.refusal ?? 'unknown', categories),
      ...(categories.length ? { suggestions: categories } : {}),
    });
  }
  // A path the deny list names is refused HERE, before anything asks for
  // `kind`: a weapon filed under goods.weapons is a category decision, and the
  // answer to it is the category's word, never "say what the thing is". The
  // pipe's denyListPath check says the same thing a moment later for a caller
  // that reaches it; this is the door for the ones that never do.
  const denied = categoryDenied(category);
  if (denied) {
    throw new OsbError('CATEGORY_PROHIBITED', {
      human_action: screeningReasonInPlainWords(denied.reason_code),
    });
  }
  if (!gate.known) assertKindPresent(kind);
  return { known: gate.known };
}

/**
 * WHAT THE THING IS, IN THE AGENT'S OWN WORDS. Required on a posting the
 * catalogue has no leaf for, welcome on any other.
 *
 * Two checks stand between `kind` and the row, and they answer to different
 * masters. This one is synchronous and cheap, and it is about SHAPE: a noun
 * phrase is words, and words have no digits, no dollar sign, no address and no
 * link in them. It runs here so an agent that sent prose, a price or a contact
 * detail hears about it in the same call rather than finding the posting
 * rejected minutes later.
 *
 * The other one is the model screen, off the queue, at the posting door of the
 * one pipe, where `kind` is handed over beside the rest of the free text
 * (src/intake, docs/trust-and-safety.md). That is the check that reads what it
 * MEANS. Neither stands in for the other.
 */
const KIND_MAX_WORDS = 6;

export function kindComplaint(kind: unknown): string | undefined {
  if (typeof kind !== 'string') return 'say in a few plain words what the thing is';
  const k = kind.trim();
  if (!k) return 'say in a few plain words what the thing is';
  if (k.length > 60) return 'what the thing is has to fit in sixty characters';
  if (/\d/.test(k)) return 'what the thing is takes plain words rather than numbers';
  if (/[$£€¥]/.test(k)) return 'what the thing is carries no price';
  if (/@|https?:\/\/|www\./i.test(k)) {
    return 'what the thing is carries no email address, phone number or link';
  }
  if (k.split(/\s+/).length > KIND_MAX_WORDS) {
    return `what the thing is takes ${KIND_MAX_WORDS} words at most`;
  }
  return undefined;
}

function assertKindPresent(kind: unknown): void {
  const complaint = kindComplaint(kind);
  if (!complaint) return;
  throw Object.assign(
    new Error(
      `this cannot go up as it stands: the catalogue has no leaf for that category, so ${complaint}`,
    ),
    { validation: ['kind'] },
  );
}

/**
 * ON A BEST OFFER THE FLOOR IS PRIVATE, and `ask` is not where it lives.
 *
 * The rehearsal that bought this (dev, 20 September 2026). A man selling by
 * best offer was asked by his assistant "what's your floor — the minimum you'd
 * take?", said $10, and was told in the assistant's own words that "that
 * becomes the asking price everyone's sealed offers get measured against". It
 * went up as the posting's `ask`, which is the one money field that is
 * DISCLOSABLE, so the switchboard carried it across at the details step and
 * the buyer's assistant read it out: "Their asking price: $10 AUD." A seller's
 * reserve, said aloud to the person bidding against it.
 *
 * Nobody misread anything. On a STRAIGHT sale an asking price is exactly what
 * it sounds like and crossing early is the point of it. On a best offer there
 * is no asking price at all — the whole arrangement is that nobody sees a
 * number until the seller sees them all — so the question "where does the
 * floor go?" had no answer anywhere, and `ask` was a reasonable guess at it.
 *
 * WHY REFUSE RATHER THAN MOVE IT QUIETLY. Routing the figure into `price`
 * would post the thing and say so in a note, and the human would never be
 * asked. Putting somebody's number somewhere they did not ask for it is its
 * own surprise, and it teaches the assistant nothing: the next posting guesses
 * again. A refusal costs one round trip and is the only place this rule can be
 * said at the moment it is being broken.
 *
 * The check is on the CARD AS IT WILL STAND, so it holds an amend that turns a
 * straight sale into a best offer with an ask already on the row, as well as
 * one that adds an ask to a best offer. It is the first of the cheap refusals
 * for a reason: the figure gate below would otherwise read the ask back to the
 * human as "your asking price" on a posting that may not carry one at all.
 */
export const FLOOR_IS_PRIVATE_ACTION =
  'On a best offer the floor is private: nobody is ever shown it, and a number under it is refused before it travels. Take the asking price off this one and give that figure as the floor of the private band in `price` instead, then post it again.';

function assertFloorStaysPrivate(card: { sale?: unknown; ask?: unknown }): void {
  // A want cannot carry either field — the schema forbids both on looking_for
  // — so this reads the two that matter and asks nothing about the side.
  if (card.sale !== 'best-offer' || !card.ask) return;
  throw new OsbError('FLOOR_IS_PRIVATE', { human_action: FLOOR_IS_PRIVATE_ACTION });
}

/**
 * ONE ATTEMPT AT PUTTING A THING UP, AND ITS NUMBER.
 *
 * Every gate below that can send a posting back asks the same question — "have
 * I already asked this?" — and every one of them now answers it from here, off
 * the attempt's reference and nothing else. The whole of why is in
 * domain/postingRef.ts: the keys this replaces were built out of the agent's
 * own prose, and the questions beside them ask the agent to change that prose.
 */
interface Attempt {
  /** The number, once there is one: sent back by the agent, or minted here. */
  reference?: string;
  /** The gates that have already asked on it. */
  asked: Set<PostingGate>;
}

/** The attempt an agent is continuing, or a fresh one with no number yet. */
async function openAttempt(accountId: string, sent: unknown): Promise<Attempt> {
  const open = await readPostingRef(accountId, sent);
  return { reference: open?.reference, asked: new Set(open?.asked ?? []) };
}

/**
 * Write down that this gate has asked, minting the number on first contact.
 * The attempt carries it from here on, so the next gate in the same call and
 * every later attempt the agent makes are all talking about the same thing.
 */
async function askOnce(accountId: string, attempt: Attempt, gate: PostingGate): Promise<string> {
  attempt.reference = await noteAsked(accountId, attempt.reference, gate);
  attempt.asked.add(gate);
  return attempt.reference;
}

/**
 * A FIGURE IS READ BACK ONCE, and then it goes up as it stands.
 *
 * The manual's rule (c), which this enforces word for word: "Before anything
 * leaves, read back what you are about to send and ask yourself which words of
 * theirs that exact number came from. If you cannot point at them, you invented
 * it." An assistant did not, and posted a private band of "up to $45 AUD" for a
 * human whose whole word about money was "not sure what my budget is, what do
 * these usually go for?"
 *
 * So the first attempt comes back unposted with the figures on it, and the
 * second — carrying the reference that refusal handed over — goes through
 * untouched, because by then somebody has been asked. A posting with no figure
 * never comes here at all.
 *
 * WHAT THE AGENT WROTE IS NOT CONSULTED. The old key carried the amounts and
 * the poster's own words for the thing, and the detail gate above asks for
 * sharper words, so an assistant doing as it was told was asked the same
 * question for ever (21 September 2026, four rounds, nothing posted).
 *
 * Nothing is logged: the amounts are the human's own business, which is why
 * the band is encrypted on the row in the first place.
 */
async function confirmFigures(
  accountId: string,
  attempt: Attempt,
  figures: PostingFigure[],
): Promise<void> {
  if (!figures.length) return;
  if (attempt.asked.has('figure')) return;
  const reference = await askOnce(accountId, attempt, 'figure');
  throw new OsbError('CONFIRM_FIGURE', {
    human_action: FIGURE_HUMAN_ACTION,
    questions: figureQuestions(figures),
    figures,
    reference,
  });
}

/** `kind` as it is stored: trimmed, or null where the posting gave none. */
const kindOf = (card: any): string | null => {
  const k = typeof card?.kind === 'string' ? card.kind.trim() : '';
  return k ? k : null;
};

/**
 * WHAT THE CATALOGUE IS MISSING, written down once the posting is UP.
 *
 * It used to be written on the refusal, because the refusal was the only place
 * the switchboard ever heard of the gap. Now there is no refusal, so the
 * record moves to the posting itself and changes meaning with it: this is a
 * growth list, not a complaints book. Every row is a person, through their
 * agent, saying "this is the errand I actually have", and the thing went up.
 *
 * Best-effort in the same strong sense it always was: awaited so the row is
 * really there, unable to throw, and invisible to the agent either way.
 */
async function recordUnknownLeaf(
  cfg: Config,
  accountId: string,
  category: string,
  kind: string | null,
): Promise<void> {
  let categories: string[] = [];
  try {
    categories = (await suggestCategories(cfg, category, 3)).categories;
  } catch {
    /* the suggester is a courtesy; the record is the point */
  }
  await recordCategoryMiss(accountId, category, categories, kind);
}

/**
 * How many people this want or have can take at once. The wire bounds it 1-10
 * and the column checks the same, so this is only the default: one, which is
 * what "introduce me to someone" means when nobody has said otherwise.
 */
const slotsOf = (card: any): number => {
  const n = Number(card?.slots);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
};

/** How the asking price works. A want has no asking price, so it is always the
 *  straight one — the schema forbids `sale` there in any case. */
const saleOf = (card: any): 'straight' | 'best-offer' =>
  card?.type === 'offering' && card?.sale === 'best-offer' ? 'best-offer' : 'straight';

/** What a publish attempt may carry beside the posting itself. */
export interface PublishOpts {
  /**
   * The human genuinely does not know the rest. Honoured only on a second
   * attempt at the same thing — see domain/postingDetail.ts.
   */
  detailUnknown?: boolean;
  /**
   * The attempt's own number, as the last refusal handed it over. It is the
   * only thing that says "this is the posting you already asked me about", and
   * if the posting goes up it becomes its id (domain/postingRef.ts).
   */
  reference?: unknown;
}

/**
 * Publish an intent card.
 * Order of gates: schema validation -> schema_version -> taxonomy/deny-list
 * (CATEGORY_PROHIBITED) -> quota (QUOTA_EXCEEDED) -> stored PENDING_SCREENING
 * with the price band envelope-encrypted -> screening queue. The card is NOT
 * matchable until the screening pipeline passes it.
 *
 * THE NUMBER RIDES ON EVERY REFUSAL, minted at first contact. The gates below
 * put it on the answers they write; this wrapper puts it on every other refusal
 * that leaves here, so an attempt that came back for its category or its shelf
 * carries the same number as one that came back for its figure, and the agent
 * never has to work out which of its questions belong together.
 */
export async function publishIntent(
  cfg: Config,
  accountId: string,
  card: any,
  opts: PublishOpts = {},
): Promise<PublishResult> {
  const attempt = await openAttempt(accountId, opts.reference);
  try {
    return await runPublish(cfg, accountId, card, opts, attempt);
  } catch (e) {
    if (e instanceof OsbError && !e.payload.reference) {
      e.payload.reference = await noteAsked(accountId, attempt.reference);
    }
    throw e;
  }
}

async function runPublish(
  cfg: Config,
  accountId: string,
  card: any,
  opts: PublishOpts,
  attempt: Attempt,
): Promise<PublishResult> {
  // THE ANSWER "NONE OF THESE" (Lachlan, 20 September 2026). After
  // SHELF_UNCLEAR an assistant whose human recognised none of the shelves sends
  // the posting back with category 'none_of_these'. That is an answer to a
  // question, and a word the protocol's path pattern would refuse, so it is
  // read here, before validation, against the question this account has in
  // flight about the same words (domain/shelfGaps.ts). The posting then carries
  // on under the path it first came in with, and is turned into SHELF_PICK at
  // the shelf step below; or, where the human has already chosen on the page,
  // under the shelf they chose.
  let shelfAttempt: ShelfAttempt | undefined;
  const saidNone =
    !!card && typeof card === 'object' && (card as any).category === SHELF_NONE_OPTION;
  if (saidNone) {
    shelfAttempt = await readShelfAttempt(accountId, (card as any).kind);
    if (!shelfAttempt) {
      throw Object.assign(
        new Error(
          `this cannot go up as it stands: ${SHELF_NONE_OPTION} answers a question about shelves, and there is none open about this thing. Post it with a category.`,
        ),
        { validation: ['category'] },
      );
    }
    card = { ...card, category: shelfAttempt.picked ?? shelfAttempt.as_posted };
  }
  const v = validatePayload('intent-card', card);
  if (!v.valid) {
    // In words, because this sentence has been seen in a chat window: the
    // validator's own account reads like a fault the person at the keyboard
    // caused, and they only said what they were after.
    throw Object.assign(new Error(`this cannot go up as it stands: ${v.plain.join('; ')}`), {
      validation: v.reasons,
    });
  }
  checkSchemaVersion(card.schema_version);

  // THE QUOTA COMES FIRST, BEFORE ANYTHING COSTS ANYTHING (2026-09-17 audit).
  // It used to sit below the category gate and the intake pipe, so an account
  // that had already used up its day could still make the switchboard embed a
  // category to suggest alternatives, and still push a posting through the
  // pipe, on every call. Two statements against this account's own rows is the
  // cheapest question here and it is now the first one: an account with nothing
  // left to spend spends nothing.
  await checkPublishQuota(accountId, cfg.quotas);

  const { known } = await assertCategoryOpen(cfg, card.category, accountId, card.kind);
  const kind = kindOf(card);
  // Everything a person hands over goes through the one pipe (src/intake,
  // docs/trust-and-safety.md). At the posting door, synchronously, that is the
  // deny-list path check and the figure check over `kind`: the only two things
  // that can refuse here, which is why a category refusal is still
  // CATEGORY_PROHIBITED and still word for word what it was. The rest of the
  // words on the card are screened afterwards, off the queue, by the screening
  // worker through the same pipe — so none are handed over here.
  const intake = await runIntake(cfg, {
    door: 'posting',
    sender_account: accountId,
    fields: {
      category: card.category,
      ...(kind ? { kind } : {}),
      // AND THE ATTRIBUTES, key by key (20 September 2026). Every value here
      // crosses to the counterparty at the details step, so `budget: 25` on a
      // want is a human's ceiling handed to the person they are about to
      // haggle with. The rule is in domain/moneyInWords.ts and what it reads
      // is written down in intake/checks/moneyFigure.ts. They go in as the
      // agent wrote them, before canonicalisation, because what it wrote is
      // what the check is about.
      ...attributeFields(card.attributes),
    },
  });
  if (intake.outcome === 'refuse') {
    // A figure in `kind` or in an attribute is not a category decision, so it
    // does not wear the category's word. It comes back the way the money check
    // comes back everywhere else: the sentence the check wrote, and the field
    // to fix, which the check itself names.
    if (intake.reason_code === 'money-figure-in-words') {
      throw Object.assign(new Error(intake.plain_words ?? 'this cannot go up as it stands'), {
        validation: [decidingCheck(intake)?.field ?? 'kind'],
      });
    }
    throw new OsbError('CATEGORY_PROHIBITED', { human_action: intake.plain_words });
  }

  // THE CHEAP REFUSALS, IN A FIXED ORDER, ONE AT A TIME.
  //
  // All four of them live here, after the cheap checks and before anything is
  // written or queued, because a posting that comes back unposted should cost
  // the switchboard the same as a posting that is refused for its category.
  //
  // The order is: FLOOR, then DETAIL, then REACH, then FIGURE. It is fixed,
  // and each one throws, so an assistant is handed exactly one refusal per
  // attempt and never two different ones for the same posting. The floor first
  // because it is the only one about a field that must not be on the posting
  // at all, and the figure gate below would otherwise read that same number
  // back as "your asking price"; detail next because it is about what the
  // thing IS, and the answers to it can change the rest; reach after that
  // because it is one question with two answers; the figure last because it is
  // the one that is read back rather than asked about, and reading a number
  // back on a posting that is still being described would be reading it back
  // too early.
  //
  // A BEST OFFER HAS NO ASKING PRICE. See assertFloorStaysPrivate above for
  // the rehearsal in which a seller's $10 reserve was read out to the buyer.
  assertFloorStaysPrivate(card);
  //
  // DOES IT SAY ENOUGH TO DESCRIBE THE THING TO A STRANGER? The whole of the
  // reasoning, and the rule itself, is in domain/postingDetail.ts.
  const shortfall = detailShortfall(card);
  if (shortfall) {
    const excused = opts.detailUnknown && attempt.asked.has('detail');
    if (!excused) {
      // Minted or written down first, so the next attempt has something to
      // recognise — and something no rewording of the posting can move.
      const reference = await askOnce(accountId, attempt, 'detail');
      throw new OsbError('NEEDS_DETAIL', {
        // The escape hatch was reached for and did not match: say so, rather
        // than handing back the same questions as though it had never been
        // sent. See DETAIL_UNKNOWN_UNMATCHED in domain/postingDetail.ts.
        human_action: opts.detailUnknown ? DETAIL_UNKNOWN_UNMATCHED : DETAIL_HUMAN_ACTION,
        questions: shortfall.questions,
        reference,
      });
    }
  }

  // HOW FAR IT REACHES IS THE HUMAN'S ANSWER, never a default. A posting that
  // leaves `reach` out used to fall silently to a radius, and in the third
  // rehearsal-suite run an assistant put a parcel-sized spring up within 8 km
  // of Queanbeyan without ever asking its human whether they would post it,
  // where the human would have said "anywhere in Australia". So a thing that
  // is being offered comes back with that one question until somebody has
  // answered it. It was asked of things on offer only until a later run, where
  // the BUYER's assistant did the same: a want went up within 8 km of Franklin,
  // the seller was twenty kilometres away and posting country-wide, the two
  // postings read 0.86 alike, and the buyer's own radius kept them apart. So
  // it is asked of every goods posting, in the words that fit its side. A
  // service and a social posting keep the old default, which suits them.
  const isGoods = String(card.category ?? '').split('.')[0] === 'goods';
  const offering = card.type === 'offering';
  if (isGoods && !card.geo?.reach) {
    throw new OsbError('NEEDS_DETAIL', {
      reference: await askOnce(accountId, attempt, 'reach'),
      human_action: offering
        ? 'Ask your human how far this should reach, then post it again with `reach` filled in: "country" if they would post it, "radius" with a distance if it is pick-up only.'
        : 'Ask your human how far this should reach, then post it again with `reach` filled in: "country" if they are happy to have it posted to them, "radius" with a distance if they will only collect it.',
      questions: [
        offering
          ? 'Would you post it to someone, or is it pick-up only? If pick-up, how far from you?'
          : 'Are you happy to have it posted to you, or would you only collect it? If collecting, how far would you go?',
      ],
    });
  }

  // AND A RADIUS ON A THING ON OFFER IS CONFIRMED ONCE. The question above
  // catches a reach left out; an assistant can also CHOOSE pick-up only without
  // asking, and one did (a parcel-sized spring, "about 8 km around Queanbeyan",
  // from a human who would have posted it anywhere). Pick-up only is a fair
  // answer for a sofa, so it is never refused outright: the first attempt comes
  // back with the question, and the second, carrying the reference that refusal
  // handed over, goes up as it is, because by then somebody has been asked.
  //
  // IT USED TO BE KEYED ON `${kind}#reach`, which is the poster's own words for
  // the thing with a word stuck on the end — the same defect as the other two,
  // never hit only because the detail gate in front of it usually asked first.
  if (isGoods && card.geo?.reach === 'radius' && !attempt.asked.has('reach')) {
    throw new OsbError('NEEDS_DETAIL', {
      reference: await askOnce(accountId, attempt, 'reach'),
      human_action: offering
        ? 'You chose pick-up only. Ask your human the question below, then post again: "country" if they would post it, or the same radius if it really is pick-up only.'
        : 'You chose collection only. Ask your human the question below, then post again: "country" if they are happy to have it posted, or the same radius if they really will only collect.',
      questions: [
        offering
          ? 'Would you post it to someone further away, or is it pick-up only?'
          : 'Would you be happy to have it posted to you from further away, or will you only collect it?',
      ],
    });
  }

  // AND A FIGURE IS READ BACK ONCE, before it can decide anything. See
  // domain/postingFigure.ts for the rehearsal that bought this and for the
  // manual rule it enforces.
  await confirmFigures(accountId, attempt, figuresOnPosting(card));

  // SNAP AT THE DOOR. The gate above decided whether this may go up at all,
  // on the path the assistant wrote; this decides where it goes. A path the
  // catalogue has never heard of is moved onto the nearest node it does know,
  // because the matcher reads the category as a hard gate and an invented
  // branch has no neighbours — see filedUnderNote above for the run that
  // bought this. The assistant's own path is kept on the row.
  //
  // The snapped node is what the row carries, so the screening worker embeds
  // from it without being told: the projection text starts with the category
  // and its label path (domain/matchRules.ts projectionText). `kind` is left
  // exactly as the assistant wrote it — the switchboard is moving the shelf,
  // never the words.
  //
  // And where the answer is close but scattered, nothing is filed at all: the
  // posting comes back with the shelves and the human settles it (see
  // SHELF_CONFIDENT_MIN). Only publish asks — an amend below takes the answer
  // it is given, because a posting already up must never come down for being
  // what it already was.
  //
  // FIRST, THOUGH, THE ANSWER TO A SHELF QUESTION ALREADY ASKED. A posting that
  // comes back after SHELF_UNCLEAR is the human's answer, and there are two
  // kinds. A shelf the catalogue knows is the answer "this one", and it goes up
  // there. "None of these" — sent as its own word, or as a bare top level the
  // way the manual said to before version 58 — is answered with the searchable
  // page rather than the top level (SHELF_PICK, domain/shelfPick.ts). Once the
  // human has chosen on that page the choice is on the question, and the
  // posting goes up under it.
  if (!saidNone) shelfAttempt = await readShelfAttempt(accountId, kind);
  const bareTopLevel = !String(card.category).includes('.');
  if (shelfAttempt && !shelfAttempt.picked && (saidNone || bareTopLevel)) {
    let page: Awaited<ReturnType<typeof shelfPickLink>> | undefined;
    try {
      page = await shelfPickLink(cfg, accountId, shelfAttempt.attempt);
    } catch (e: any) {
      // The page is how "none of these" is answered, and without it the old
      // answer still stands: the top level, where it goes up as it stands.
      logSnap('publish: shelf page could not be minted, filing under the top level', {
        error: e?.message,
      });
    }
    if (page) {
      if (await markNoneOfThese(accountId, shelfAttempt.attempt)) {
        await recordShelfGap({
          attempt: shelfAttempt.attempt,
          as_posted: shelfAttempt.as_posted,
          kind,
          outcome: 'none_of_these',
        });
      }
      throw new OsbError('SHELF_PICK', {
        human_action: `${SHELF_PICK_ACTION} ${page.link}`,
        press_id: page.press_id,
      });
    }
    card = { ...card, category: generalShelf(shelfAttempt.as_posted) };
  }

  const filed = await snapCategory(cfg, card.category, undefined, {
    fallbackToAncestor: true,
    askWhenUnsure: true,
    posting: { kind, attributes: card.attributes },
  });
  if (filed.how === 'unclear') {
    logSnap('publish: nothing near enough to file this under', {
      account_id: accountId,
      as_posted: filed.from,
      source: filed.source,
      score: filed.score,
      lead: filed.lead,
      runners_up: filed.runners_up,
    });
    // Written down for the catalogue, once per question: asking the same thing
    // again while it is still open keeps the attempt it already has.
    const opened = await openShelfAttempt(accountId, kind, filed.from);
    if (opened?.fresh) {
      await recordShelfGap({
        attempt: opened.attempt,
        as_posted: filed.from,
        kind,
        outcome: 'asked',
        shortlist: shortlistForGap(filed.shortlist),
      });
    }
    throw new OsbError('SHELF_UNCLEAR', {
      human_action: shelfUnclearAction(),
      candidates: filed.candidates,
    });
  }
  // Is this posting the end of a shelf question? Only where it went up on a
  // shelf somebody chose: an unknown path sent again is a new question.
  const answering = shelfAttempt && filed.how === 'as-posted' ? shelfAttempt : undefined;
  // And is it a filing the door was unsure of, made without asking?
  const unsureFiling: ShelfGapOutcome | undefined =
    filed.how === 'ancestor'
      ? filed.category.includes('.')
        ? 'snapped_low_confidence'
        : 'top_level'
      : filed.how === 'suggestion' && filed.confident === false
        ? 'snapped_low_confidence'
        : undefined;
  if (filed.changed) {
    logSnap('publish: posting filed under a node the catalogue knows', {
      account_id: accountId,
      as_posted: filed.from,
      filed_under: filed.category,
      how: filed.how,
      source: filed.source,
      score: filed.score,
      lead: filed.lead,
      runners_up: filed.runners_up,
    });
  }

  // One agreed spelling before the row is written, so two people who meant
  // the same thing embed the same text (domain/attributeCanon.ts). This runs
  // after validation and its output is what is stored, read back, and
  // embedded. Canonicalisation is per category, so it reads the one the
  // posting is actually filed under.
  const attributes = canonicaliseAttributes(filed.category, card.attributes ?? {});

  // Location resolution: a named place becomes a centre point and a
  // canonical cell before the card is stored (LOCATION_UNRESOLVED otherwise).
  const geo = await placeCard(card.geo, accountId, 'own-country-for-publish');

  const account = await getAccount(accountId);
  if (!account) throw new Error('account not found');

  const ttl = card.ttl_days ?? 60;
  // "Today" means the human's today. With their zone known, a want or have
  // marked today ends at the last second of their day rather than 24 hours
  // after the moment it was posted; without it, the old ttl arithmetic holds.
  let endsAt: Date | null = null;
  if (card.urgency === 'today') {
    const { getTimezone } = await import('./accounts.js');
    const { endOfLocalDay } = await import('./localTime.js');
    const tz = await getTimezone(accountId);
    if (tz) endsAt = endOfLocalDay(new Date(), tz);
  }
  // The price band is a PRIVATE matching input: encrypted before it touches a
  // row, decrypted only inside the matching engine, never serialised outbound.
  const priceEnc = card.price
    ? await encryptField(accountId, account.data_key_enc, JSON.stringify(card.price))
    : null;

  // The open-cards ceiling, asked in the statement that changes the count
  // rather than in a question some distance before it (domain/quotas.ts). The
  // check at the top of this function is the courtesy; this is the rail.
  //
  // AND THE POSTING TAKES THE ATTEMPT'S OWN NUMBER AS ITS ID. Where this
  // posting was asked about before, the number the agent has been carrying
  // since the first question is the number it keeps for everything that
  // follows: one reference, first question to last conversation, and never a
  // moment where two numbers mean the same want or have. Where nothing was ever
  // asked there is no number yet, and the row makes its own as it always did.
  // $23 can only be a reference this switchboard minted for THIS account, since
  // that is the only thing readPostingRef will hand back (domain/postingRef.ts).
  const r = await getPool().query(
    `INSERT INTO cards (id, account_id, schema_version, type, category, geo, geo_lat, geo_lon,
                        geo_radius_km, geo_country, attributes, ask, urgency, visibility,
                        protocol_status, price_enc, ttl_days, expires_at, slots, sale, kind,
                        category_as_posted)
     SELECT COALESCE($23::uuid, gen_random_uuid()),
             $1,$2,$3,$4,$5,$13,$14,$15,$16,$6,$7,$8,$9,$10,$11,$12::int,
             COALESCE($17::timestamptz, now() + make_interval(days => $12::int)),
             $18::int, $19, $20, $22
      WHERE ${OPEN_CARDS_GUARD_SQL('$21::int')}
     RETURNING id`,
    [
      accountId,
      card.schema_version,
      // The wire says looking_for/offering; the column keeps WANT/HAVE.
      card.type === 'looking_for' ? 'WANT' : 'HAVE',
      // The matching key is the node the switchboard filed it under; the
      // assistant's own path rides along as $22 and is never a matching key.
      filed.category,
      JSON.stringify(geo.geo),
      JSON.stringify(attributes),
      card.ask ? JSON.stringify(card.ask) : null,
      card.urgency ?? 'none',
      'anonymous-until-match',
      card.status ?? 'active',
      priceEnc,
      ttl,
      geo.lat,
      geo.lon,
      geo.radius_km,
      geo.country,
      endsAt,
      // How many people this can take at once, and (on a have) how the asking
      // price works. Both are the human's own word, and both are routing only:
      // see domain/sequencer.ts for the line they drive.
      slotsOf(card),
      saleOf(card),
      kind,
      cfg.quotas.maxOpenCards,
      // The assistant's own path from the FIRST attempt where this posting is
      // the answer to a shelf question: that is what was actually sent for the
      // thing, and the shelf it went on is the human's choice.
      answering?.as_posted ?? filed.from,
      attempt.reference ?? null,
    ],
  );
  if (!r.rows[0]) {
    // The statement counted the board as it is now and there is no room. The
    // check knows the sentence and the figures; re-asking it here gets them.
    await checkPublishQuota(accountId, cfg.quotas);
    throw new OsbError('QUOTA_EXCEEDED', {
      human_action: `You are at the limit of ${cfg.quotas.maxOpenCards} open wants and haves. Withdraw one to post another.`,
    });
  }
  const id = r.rows[0].id as string;
  // THE ATTEMPT IS OVER, so what it was asked is forgotten. The number lives on
  // as the posting's id, which is the point; the going-back-and-forth it stood
  // for is finished, and a row left standing would excuse a question on a
  // posting that no longer needs excusing.
  await closePostingRef(attempt.reference);
  // The shelf gap log (domain/shelfGaps.ts), written once the posting is up so
  // a refused insert leaves no row claiming it went anywhere.
  if (answering) {
    // A pick on the page wrote its own row when it was pressed; a shelf chosen
    // from the options in chat is written here, as the answer arrives.
    if (!answering.picked) {
      await recordShelfGap({
        attempt: answering.attempt,
        as_posted: answering.as_posted,
        kind,
        outcome: 'human_picked',
        picked: filed.category,
      });
    }
    await closeShelfAttempt(accountId, answering.attempt);
  } else if (unsureFiling) {
    await recordShelfGap({
      as_posted: filed.from,
      kind,
      outcome: unsureFiling,
      picked: filed.category,
      shortlist: shortlistForGap(filed.shortlist),
    });
  }
  // The catalogue's gaps, counted from what went UP rather than from what was
  // turned away. Nothing about this reaches the agent, and nothing about it can
  // fail the publish.
  if (!known) await recordUnknownLeaf(cfg, accountId, card.category, kind);
  // The day's posting, counted and capped in the one statement that records
  // it (domain/quotas.ts). A publish that meets the day's end here has its card
  // row already: it is withdrawn rather than left standing, so the refusal is
  // the same board the agent would have had if the count had come first.
  try {
    await recordPublishWithinQuota(accountId, id, cfg.quotas);
  } catch (e) {
    await getPool()
      .query(`UPDATE cards SET lifecycle_state = 'WITHDRAWN', updated_at = now() WHERE id = $1`, [id])
      .catch(() => {});
    throw e;
  }
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: cfg.screeningQueueUrl,
      MessageBody: JSON.stringify({ kind: 'screen-card', card_id: id }),
    }),
  );
  return {
    intent_id: id,
    state: 'PENDING_SCREENING',
    ...locationEcho(geo),
    // Where it actually went, every time, so an assistant never has to guess
    // whether the switchboard took its path as given, and always with a
    // sentence in plain words beside it, moved or not.
    // The shelf in WORDS, because this is the field an assistant reaches for
    // when it tells its human where the posting went: handed the dotted path
    // here, with the sentence right beside it, one still said "filed under
    // goods.electronics" (rehearsal, 19 September 2026). The path itself is
    // the posting's `category`, under the name it was sent in by.
    filed_under: shelfInWords(filed.category),
    category: filed.category,
    filed_under_note: { text: filedUnderNote(filed), provenance: 'switchboard-system' as const },
    what_happens_next_note: await whatHappensNextFor(accountId),
  };
}

export async function getCard(id: string): Promise<CardRow | undefined> {
  const r = await getPool().query('SELECT * FROM cards WHERE id = $1', [id]);
  return r.rows[0];
}

/**
 * WHO IS THERE, counted once for the whole list.
 *
 * The defect this exists to close (rehearsal, 2026-09-13): a human asked their
 * assistant whether anyone had turned up yet, the assistant read this list,
 * saw the want was published and said no. An introduction had been live on it
 * for thirteen minutes and somebody else was waiting behind that. The list
 * said nothing either way, so the wrong answer was the easy one.
 *
 * One grouped statement for every want and have returned, never one per row:
 * how many people are with each of them right now, and how many are waiting
 * their turn. Only open introductions count — a declined, closed or filed-away
 * one is nobody standing there.
 */
async function peopleOnCards(
  cardIds: string[],
): Promise<Map<string, { here: number; waiting: number }>> {
  const out = new Map<string, { here: number; waiting: number }>();
  if (!cardIds.length) return out;
  const r = await getPool().query(
    `SELECT t.cid,
            count(*) FILTER (WHERE t.live)::int     AS here,
            count(*) FILTER (WHERE NOT t.live)::int AS waiting
       FROM (SELECT unnest(ARRAY[m.card_want, m.card_have]) AS cid, m.live
               FROM matches m
              WHERE m.state = 'open'
                AND (m.card_want = ANY($1::uuid[]) OR m.card_have = ANY($1::uuid[]))) t
      WHERE t.cid = ANY($1::uuid[])
      GROUP BY t.cid`,
    [cardIds],
  );
  for (const row of r.rows as { cid: string; here: number; waiting: number }[]) {
    out.set(row.cid, { here: Number(row.here ?? 0), waiting: Number(row.waiting ?? 0) });
  }
  return out;
}

/** People, counted and conjugated the way a person says it out loud. */
const peopleWord = (n: number, singular: string, plural: string): string =>
  n === 1 ? `One person ${singular}` : `${n} people ${plural}`;

/**
 * The one sentence the agent leads with about something of its human's: who
 * has come forward on it, who is waiting their turn behind them, and where to
 * look next. Plain words only, and the thing is named the way its owner would
 * name it — "your mountain bike" for the person offering it, "the mountain
 * bike you are after" for the person looking, which is the same split every
 * notice uses (email/templates.ts).
 */
function peopleSentence(
  category: string,
  type: 'WANT' | 'HAVE',
  here: number,
  waiting: number,
): string {
  const thing = theirThing(categoryPhrase(category) || 'this', type === 'HAVE' ? 'have' : 'want');
  if (here === 0 && waiting === 0) {
    return `Nothing yet on ${thing}. I'll say the moment somebody comes forward.`;
  }
  if (here === 0) {
    return `${peopleWord(waiting, 'is', 'are')} waiting their turn on ${thing}. Check in for what to do next.`;
  }
  const behind =
    waiting > 0
      ? `, and ${waiting === 1 ? 'one more person is' : `${waiting} more people are`} waiting their turn behind ${here === 1 ? 'them' : 'that'}`
      : '';
  return `${peopleWord(here, 'has', 'have')} come forward about ${thing}${behind}. Check in for what to do next.`;
}

export async function listIntents(accountId: string): Promise<any[]> {
  const r = await getPool().query(
    `SELECT id, schema_version, type, category, kind, geo, attributes, ask, urgency, visibility,
            protocol_status, lifecycle_state, ttl_days, expires_at, created_at, updated_at,
            screening, slots, sale
     FROM cards WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [accountId],
  );
  // The expiry as the human would say it, beside the UTC instant, so an agent
  // never has to do the zone sum itself.
  const { getTimezone } = await import('./accounts.js');
  const { localTimeText } = await import('./localTime.js');
  const tz = await getTimezone(accountId);
  // Who is there, for every want and have in one statement (peopleOnCards).
  // Only something still up can have anybody on it, so a withdrawn, expired or
  // screening-rejected one is left alone rather than told "nothing yet".
  const stillUp = r.rows.filter((row) => row.lifecycle_state === 'PUBLISHED');
  const people = await peopleOnCards(stillUp.map((row) => row.id));
  // What came close and did not make it, for each posting still up
  // (domain/nearMisses.ts). Its own list, never folded in among the people who
  // have actually come forward: a near miss is information and nobody has been
  // introduced to anybody.
  const near = await nearMissesForCards(
    accountId,
    stillUp.map((row) => row.id),
  );
  // Own-card view for the owning agent. The private price band is not stored
  // in plaintext and is not echoed back; agents keep their own record of it.
  //
  // A SCREENING_REJECTED card carries WHY, in the same plain words the
  // approval page shows, so the agent can tell its human without a second
  // call. This is an own-card field ONLY: it is read here from the caller's
  // own rows, and no counterparty path ever reads cards.screening (the
  // disclosure payloads are schema-closed — see domain/matches.ts).
  return r.rows.map((row) => {
    const who =
      row.lifecycle_state === 'PUBLISHED'
        ? (people.get(row.id) ?? { here: 0, waiting: 0 })
        : undefined;
    return {
      intent_id: row.id,
      state: row.lifecycle_state,
      // WHO HAS COME FORWARD, and who is behind them. The two counts are for the
      // agent; the sentence is the whole of what its human hears. Anything past
      // the counting of them — whose move it is, a figure, a message — belongs
      // to the sweep and is not here.
      ...(who
        ? {
            people_here: who.here,
            in_line: who.waiting,
            note: {
              text: peopleSentence(row.category, row.type, who.here, who.waiting),
              provenance: 'switchboard-system' as const,
            },
          }
        : {}),
      ...(near.has(row.id) ? { near_misses: near.get(row.id) } : {}),
      ...(row.lifecycle_state === 'SCREENING_REJECTED'
        ? (() => {
            const rej = rejectionInPlainWords(row.screening);
            return rej
              ? {
                  screening: {
                    ...(rej.reasonCode ? { reason_code: rej.reasonCode } : {}),
                    reason: rej.plain,
                    ...(rej.at ? { at: rej.at } : {}),
                  },
                }
              : {};
          })()
        : {}),
      listing: {
        schema_version: row.schema_version,
        // The side, in the words the wire uses. WANT/HAVE stay in the column.
        type: row.type === 'WANT' ? 'looking_for' : 'offering',
        category: row.category,
        ...(row.kind ? { kind: row.kind } : {}),
        geo: row.geo,
        ...(row.attributes && Object.keys(row.attributes).length
          ? { attributes: row.attributes }
          : {}),
        ...(row.ask ? { ask: row.ask } : {}),
        urgency: row.urgency,
        visibility: row.visibility,
        status: row.protocol_status,
        ttl_days: row.ttl_days,
        slots: row.slots ?? 1,
        ...(row.type === 'HAVE' ? { sale: row.sale ?? 'straight' } : {}),
      },
      expires_at: row.expires_at,
      ...(tz && row.expires_at ? { expires_local: localTimeText(new Date(row.expires_at), tz) } : {}),
      created_at: row.created_at,
    };
  });
}

function assertOwnUsableCard(card: CardRow | undefined, accountId: string): CardRow {
  if (!card || card.account_id !== accountId) {
    throw Object.assign(new Error('intent not found'), { notFound: true });
  }
  if (card.lifecycle_state === 'EXPIRED') throw new OsbError('INTENT_EXPIRED');
  return card;
}

/**
 * Amend = re-validate + re-screen. Amendable fields only; type/category fixed.
 *
 * AN AMEND NEEDS NO NUMBER OF ITS OWN. The posting already has one, and
 * `intent_id` IS that number — the very reference the first question about this
 * posting was minted under. So the figure gate below reads and writes it
 * directly, and an agent amending a posting has nothing extra to send or to
 * keep track of.
 *
 * What it does need is for the memory to be cleared when the amend goes
 * through, which closePostingRef does at the end. A posting's id outlives any
 * one attempt at amending it, so without that, one figure read back in
 * September would excuse every figure put on it afterwards.
 */
export async function amendIntent(
  cfg: Config,
  accountId: string,
  intentId: string,
  patch: any,
): Promise<PublishResult> {
  const card = assertOwnUsableCard(await getCard(intentId), accountId);
  const attempt = await openAttempt(accountId, intentId);
  // The posting's own id is the reference, whether or not a row exists yet.
  attempt.reference = intentId;
  if (card.lifecycle_state === 'WITHDRAWN') {
    throw Object.assign(new Error('intent is withdrawn'), { notFound: true });
  }
  const account = await getAccount(accountId);
  if (!account) throw new Error('account not found');

  // Rebuild the full card in the wire's words (the protocol document admits
  // only those), apply the patch, and re-validate as a whole card. Neither
  // type nor visibility is amendable, so nothing translates back on write.
  const current: any = {
    schema_version: card.schema_version,
    type: card.type === 'WANT' ? 'looking_for' : 'offering',
    category: card.category,
    // Not amendable, for the same reason the category is not: what the thing
    // IS is what the posting was, and a different thing is a different posting.
    ...(card.kind ? { kind: card.kind } : {}),
    geo: card.geo,
    ...(card.attributes && Object.keys(card.attributes).length
      ? { attributes: card.attributes }
      : {}),
    ...(card.ask ? { ask: card.ask } : {}),
    urgency: card.urgency,
    visibility:
      card.visibility === 'anonymous-until-match' ? 'anonymous-until-introduced' : card.visibility,
    status: card.protocol_status,
    ttl_days: card.ttl_days,
    slots: card.slots ?? 1,
    ...(card.type === 'HAVE' && card.sale ? { sale: card.sale } : {}),
  };
  const allowed = [
    'geo',
    'attributes',
    'ask',
    'urgency',
    'status',
    'ttl_days',
    'price',
    'slots',
    'sale',
  ];
  for (const k of Object.keys(patch ?? {})) {
    if (!allowed.includes(k)) {
      throw Object.assign(new Error(`field '${k}' cannot be amended`), { validation: [k] });
    }
  }
  // How the asking price works is settled before anyone is introduced. Once a
  // real introduction is live on it, somebody is already acting on the terms
  // they were shown — a buyer about to send one sealed number should not have
  // the rules change under them, and a best offer half-way through is not a
  // thing anyone can reason about. Changing it is refused plainly; taking the
  // want or have down and posting it again is always open to them.
  if ('sale' in (patch ?? {}) && String(patch.sale) !== String(card.sale ?? 'straight')) {
    const live = await getPool().query(
      `SELECT 1 FROM matches
        WHERE (card_want = $1 OR card_have = $1) AND state = 'open' AND live LIMIT 1`,
      [intentId],
    );
    if (live.rowCount) {
      throw new OsbError('NOT_UNLOCKED_YET', {
        human_action:
          'How this one sells can only change before the first person is introduced, and somebody is already talking to your human about it. Take it down and post it again to change that.',
      });
    }
  }
  const next: any = { ...current, ...patch };
  if (next.price === null || next.price === undefined) delete next.price;
  if (next.ask === null || next.ask === undefined) delete next.ask;
  const v = validatePayload('intent-card', next);
  if (!v.valid) {
    throw Object.assign(new Error(`this change cannot be made as it stands: ${v.plain.join('; ')}`), {
      validation: v.reasons,
    });
  }
  // AND THE AMENDMENT DOOR OF THE PIPE, which had stood with its checks on it
  // and no caller (20 September 2026). `attributes` is amendable and `kind` is
  // not, so an amend is the one call that can put new free words on a posting
  // that is already up — and every attribute value crosses to the counterparty
  // at the details step, which makes `budget: 25` added by an amend the same
  // leak as one posted on the first day. The card AS IT WILL STAND is what
  // goes in, so an amend that leaves an attribute alone is refused for it
  // exactly as a re-publish would be.
  //
  // No `category` goes in: it is not amendable, it has already been through
  // the deny list, and assertCategoryOpen below asks the question again in the
  // words the door has always answered it in. `kind` stays out for the same
  // reason. What is left that can refuse here is the money check and a
  // suspended account, and an account the operator has stopped amending a
  // posting is a door that should be shut to it.
  const amendIntake = await runIntake(cfg, {
    door: 'amendment',
    sender_account: accountId,
    intent_id: intentId,
    fields: attributeFields(next.attributes),
  });
  if (amendIntake.outcome === 'refuse') {
    const deciding = decidingCheck(amendIntake);
    if (amendIntake.reason_code === 'money-figure-in-words') {
      throw Object.assign(
        new Error(amendIntake.plain_words ?? 'this change cannot be made as it stands'),
        { validation: [deciding?.field ?? 'attributes'] },
      );
    }
    throw new OsbError('CATEGORY_PROHIBITED', { human_action: amendIntake.plain_words });
  }
  // AND THE FLOOR STAYS PRIVATE ON AN AMEND TOO, read off the card as it will
  // stand rather than off the patch: turning a straight sale into a best offer
  // while an asking price sits on the row is the same disclosure as posting
  // the two together, and so is adding an ask to a best offer.
  assertFloorStaysPrivate(next);
  // A FIGURE AN AMEND ADDS OR CHANGES IS READ BACK ONCE, exactly as one on a
  // publish is. Only the figures this patch is putting there are read back: an
  // amend that leaves the money alone is nothing to ask about, and the band
  // already on the row cannot be read back in any case, since it is encrypted
  // under this account's own key and nothing here decrypts it. `price` sent at
  // all is therefore treated as a change; an `ask` is compared with the one the
  // posting already carries.
  const p = patch ?? {};
  const askChanged =
    'ask' in p && JSON.stringify(p.ask ?? null) !== JSON.stringify(card.ask ?? null);
  await confirmFigures(
    accountId,
    attempt,
    figuresOnPosting({
      type: next.type,
      ask: askChanged ? p.ask : undefined,
      price: 'price' in p ? p.price : undefined,
    }),
  );
  // An amend is a re-publish, so the category faces the same gate. A card
  // whose category left the taxonomy since it was posted cannot be renewed
  // under it; the error names where to go instead.
  await assertCategoryOpen(cfg, next.category, accountId, next.kind);
  // And it faces the snap again, for the same reason. The category is not
  // amendable, so on anything posted since the door started snapping this is
  // a no-op — it is already a node the catalogue knows. What it is really for
  // is the postings that went up before, under a branch nobody has written
  // down: amending one is the moment it can be put somewhere it will actually
  // meet things, and the human amending it is the one who hears where.
  // No askWhenUnsure here, deliberately. An amend only ever adds to something
  // already up, and refusing one would take a thing off the board for being
  // what it already was; the posting's own words go in so the snap is at least
  // as well informed as the door's.
  const filed = await snapCategory(cfg, next.category, undefined, {
    fallbackToAncestor: true,
    posting: { kind: next.kind ?? card.kind, attributes: next.attributes },
  });
  // The same gap log as the door, for the one kind of amend that moves a
  // posting: an old one under an unwritten branch, filed without asking.
  if (filed.changed && (filed.how === 'ancestor' || filed.confident === false)) {
    await recordShelfGap({
      as_posted: filed.from,
      kind: next.kind ?? card.kind,
      outcome:
        filed.how === 'ancestor' && !filed.category.includes('.') ? 'top_level' : 'snapped_low_confidence',
      picked: filed.category,
      shortlist: shortlistForGap(filed.shortlist),
    });
  }
  if (filed.changed) {
    logSnap('amend: posting filed under a node the catalogue knows', {
      account_id: accountId,
      intent_id: intentId,
      as_posted: filed.from,
      filed_under: filed.category,
      how: filed.how,
      source: filed.source,
      score: filed.score,
      runners_up: filed.runners_up,
    });
  }
  // Same canonicalisation as publish, on the same terms: an amend is a
  // re-publish, and the re-screen that follows re-embeds from this row, so
  // the amended card's vector is built from the canonical form as well.
  // Canonicalisation is idempotent, so rebuilding `current` from attributes
  // that already went through it changes nothing.
  const attributes = canonicaliseAttributes(filed.category, next.attributes ?? {});
  // An amend re-resolves the place, so it asks the same question as publish
  // and must offer the same answers in the same order.
  const geo = await placeCard(next.geo, accountId, 'own-country-for-amend');

  await checkPublishQuota(accountId, cfg.quotas);

  const priceEnc =
    'price' in (patch ?? {})
      ? patch.price
        ? await encryptField(accountId, account.data_key_enc, JSON.stringify(patch.price))
        : null
      : card.price_enc;

  await getPool().query(
    // category_as_posted is only ever written where it is empty: the original
    // path is the one thing here that must never be overwritten, and on a row
    // that predates the column the pre-amend category IS the original.
    `UPDATE cards SET geo=$2, geo_lat=$9, geo_lon=$10, geo_radius_km=$11, geo_country=$12,
        attributes=$3, ask=$4, urgency=$5, protocol_status=$6,
        ttl_days=$7::int, expires_at = created_at + make_interval(days => $7::int),
        renewal_notified_at = NULL, slots=$13::int, sale=$14,
        category=$15, category_as_posted = COALESCE(category_as_posted, $16),
        price_enc=$8, lifecycle_state='PENDING_SCREENING', screening=NULL, updated_at=now()
     WHERE id=$1`,
    [
      intentId,
      JSON.stringify(geo.geo),
      JSON.stringify(attributes),
      next.ask ? JSON.stringify(next.ask) : null,
      next.urgency ?? 'none',
      next.status ?? 'active',
      next.ttl_days ?? 60,
      priceEnc,
      geo.lat,
      geo.lon,
      geo.radius_km,
      geo.country,
      slotsOf(next),
      saleOf(next),
      filed.category,
      filed.from,
    ],
  );
  await recordPublishWithinQuota(accountId, intentId, cfg.quotas);
  // The attempt is over: what it was asked is forgotten, so the NEXT amend with
  // a different figure on it is a question that gets asked. See the note on
  // this function for why an amend must clear what a publish consumes.
  await closePostingRef(attempt.reference);
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: cfg.screeningQueueUrl,
      MessageBody: JSON.stringify({ kind: 'screen-card', card_id: intentId }),
    }),
  );
  // The echo rides on an amend that moved the card, which is also the call an
  // agent makes when its human says the place is wrong.
  return {
    intent_id: intentId,
    state: 'PENDING_SCREENING',
    ...('geo' in (patch ?? {}) ? locationEcho(geo) : {}),
    // The shelf in WORDS, because this is the field an assistant reaches for
    // when it tells its human where the posting went: handed the dotted path
    // here, with the sentence right beside it, one still said "filed under
    // goods.electronics" (rehearsal, 19 September 2026). The path itself is
    // the posting's `category`, under the name it was sent in by.
    filed_under: shelfInWords(filed.category),
    category: filed.category,
    filed_under_note: { text: filedUnderNote(filed), provenance: 'switchboard-system' as const },
    what_happens_next_note: await whatHappensNextFor(accountId),
  };
}

/**
 * Take a want or a have down. The thing is gone — sold, filled, no longer
 * wanted — so nobody new is introduced to it, and every open introduction that
 * never reached a conversation is filed away in the same breath: one must not
 * keep advancing on something the other person can no longer have. A
 * conversation already open is left open: the two people may still be
 * arranging the handover in it, and closing it is a separate act (archive),
 * on the human's word, once they are done.
 */
export async function withdrawIntent(
  accountId: string,
  intentId: string,
  cfg?: Config,
): Promise<{
  intent_id: string;
  state: string;
  introductions_archived: number;
  conversations_kept: number;
}> {
  const card = await getCard(intentId);
  if (!card || card.account_id !== accountId) {
    throw Object.assign(new Error('intent not found'), { notFound: true });
  }
  await getPool().query(
    `UPDATE cards SET lifecycle_state='WITHDRAWN', updated_at=now() WHERE id=$1`,
    [intentId],
  );
  // Dynamic import: matches.ts reads cards, so a static import here would
  // close a cycle between the two modules.
  const { archiveOpenIntroductionsOnCard } = await import('./matches.js');
  const introductions_archived = await archiveOpenIntroductionsOnCard(
    intentId,
    accountId,
    'withdrawn',
    cfg,
  );
  const kept = await getPool().query(
    `SELECT count(*)::int AS n FROM matches
      WHERE (card_want = $1 OR card_have = $1) AND state = 'open'`,
    [intentId],
  );
  const conversations_kept = Number(kept.rows[0]?.n ?? 0);
  return { intent_id: intentId, state: 'WITHDRAWN', introductions_archived, conversations_kept };
}

/** TTL expiry sweep (EventBridge schedule -> ops queue -> here). */
export async function expireDueCards(): Promise<number> {
  const r = await getPool().query(
    `UPDATE cards SET lifecycle_state='EXPIRED', updated_at=now()
     WHERE expires_at < now() AND lifecycle_state IN ('PENDING_SCREENING','PUBLISHED')
     RETURNING id`,
  );
  return r.rowCount ?? 0;
}

void SCHEMA_VERSION;
