/**
 * WHAT HAS HAPPENED ON ONE MATCH, in the order it happened (27 September 2026).
 *
 * The main page used to show a negotiation as loose cards: "Send your number
 * on your road bike match? 280 AUD" beside "Offer on your road bike match
 * 290 AUD". Two cards, no order, no link between them, and the founder could
 * not tell which came first or whose was whose. So every match with something
 * waiting now gets one box on the main page, and the box tells the story of
 * that match as a short list of steps, oldest first.
 *
 * This file reads the facts and turns them into steps. It says nothing about
 * markup: counter/matchStory.ts draws the steps, on the main page and on the
 * match's own page, with the same renderer.
 *
 * WHERE EACH STEP COMES FROM, and what it can never say:
 *
 *  - introduced: the match row's own created_at. Where the two postings
 *    carry the same identifier (domain/identifiers.ts), one more line says
 *    so, read from the screened words on both sides and never naming it.
 *  - names: the stage-3 opt-ins in consent_tokens. The other side's opt-in is
 *    only ever told once both have said yes (stage 3), because "they said yes,
 *    waiting on you" before that is a thing the names step does not reveal.
 *  - photos: the photo pages that were pressed and sent (approval_links,
 *    conversation-photo, decision 'approved'). The photo rows themselves are
 *    swept soon after they are collected, so the press is the lasting record.
 *    No image, no caption.
 *  - messages: counted from the safety ledger (ledger_entries, door
 *    'message'), which keeps who sent something and when, for thirty days,
 *    and never a readable word. The switchboard does not keep what was said,
 *    so a run of messages is a count and nothing more. Where the ledger is off
 *    (a deployment without the key) there is simply no message step.
 *  - offers: every offer row, with its own note in the proposer's words.
 *    A seller on a best offer whose window is still open sees none of the
 *    other side's numbers, the same seal every other read of the money keeps.
 */
import { getPool } from '../db.js';
import { decryptFields } from '../crypto.js';
import { getAccount } from './accounts.js';
import { offerAmountInWords } from '../email/templates.js';
import { sharesIdentifier } from './identifiers.js';
import { screenedContentOf } from './screenedContent.js';

/** One line on a match's timeline. `text` is plain words, never markup. */
export interface MatchStep {
  at: Date;
  text: string;
  /** Words somebody wrote, shown as a quote under the line. `mine` says whose. */
  quote?: { words: string; mine: boolean };
  /** Waiting for this person to do something. Drawn with an accent dot. */
  waiting?: boolean;
  /** True where the moment is not known (a count of messages waiting), so
   *  no time is printed. `at` still orders it: it is set to now. */
  noTime?: boolean;
  /** A short visible label beside the line: "still open", "waiting for you". */
  tag?: string;
}

export interface StoryOffer {
  id: string;
  proposer_account: string;
  amount: string | number;
  ccy: string;
  state: string;
  created_at: Date;
  updated_at: Date;
  expiry: Date;
  note?: string | null;
}

/** Everything the steps are built from. Plain data, so the build is pure. */
export interface StoryFacts {
  viewer: string;
  match: {
    id: string;
    state: string;
    stage: number;
    created_at: Date;
    account_want: string;
    account_have: string;
  };
  /** The other side's first name, once names have crossed. */
  theirName?: string;
  /** The two postings carry the same identifier, as screened on both sides. */
  sharedIdentifier?: boolean;
  optIns: { account_id: string; recorded_at: Date }[];
  photos: { account_id: string; at: Date }[];
  messages: { sender_account: string; at: Date }[];
  offers: StoryOffer[];
}

/** The line under "You were introduced" where both postings carry the same identifier. */
export const IDENTIFIER_STEP = 'Both postings carry the same identifier';

export const STEP_TAG_OPEN = 'still open';
export const STEP_TAG_WAITING = 'waiting for you';

const money = (amount: string | number, ccy: string) => offerAmountInWords(Number(amount), ccy);

const OPEN_STATES = new Set(['proposed', 'awaiting-human']);

/**
 * The steps, oldest first. Pure: the same facts give the same list, and the
 * clock is passed in so a lapse is decided the same way in a test.
 */
export function buildSteps(f: StoryFacts, now: Date = new Date()): MatchStep[] {
  const me = f.viewer;
  const Who = f.theirName ?? 'They';
  const Whose = f.theirName ? `${f.theirName}'s` : 'Their';
  const steps: MatchStep[] = [];
  const t = (d: Date | string) => new Date(d);

  steps.push({ at: t(f.match.created_at), text: 'You were introduced' });
  if (f.sharedIdentifier) {
    steps.push({ at: t(f.match.created_at), text: IDENTIFIER_STEP });
  }

  // Names. The other side's yes is said only once both have said it.
  const mineIn = f.optIns.find((o) => o.account_id === me);
  const theirsIn = f.optIns.find((o) => o.account_id !== me);
  if (f.match.stage >= 3 && mineIn && theirsIn) {
    const at = t(mineIn.recorded_at) > t(theirsIn.recorded_at) ? mineIn.recorded_at : theirsIn.recorded_at;
    steps.push({
      at: t(at),
      text: f.theirName ? `You and ${f.theirName} shared first names` : 'You both shared first names',
    });
  } else if (mineIn) {
    steps.push({ at: t(mineIn.recorded_at), text: 'You said yes to sharing first names' });
  }

  for (const p of f.photos) {
    steps.push({ at: t(p.at), text: p.account_id === me ? 'You sent a photo' : `${Who} sent a photo` });
  }

  // Messages: one step per run from the same side, as a count.
  const msgs = [...f.messages].sort((a, b) => t(a.at).getTime() - t(b.at).getTime());
  for (let i = 0; i < msgs.length; ) {
    const from = msgs[i]!.sender_account;
    let j = i;
    while (j < msgs.length && msgs[j]!.sender_account === from) j++;
    const n = j - i;
    const what = n === 1 ? 'a message' : `${n} messages`;
    steps.push({
      at: t(msgs[j - 1]!.at),
      text: from === me ? `You sent ${what}` : `${Who} sent ${what}`,
    });
    i = j;
  }

  // Offers. When each one ends, for the "countered" test and the end step.
  const endOf = (o: StoryOffer): Date | undefined => {
    if (OPEN_STATES.has(o.state)) {
      return t(o.expiry) < now ? t(o.expiry) : undefined;
    }
    return t(o.updated_at);
  };
  const offers = [...f.offers].sort((a, b) => t(a.created_at).getTime() - t(b.created_at).getTime());
  for (const o of offers) {
    const mine = o.proposer_account === me;
    const made = t(o.created_at);
    const m = money(o.amount, o.ccy);
    // A counter is a figure put up while the other side had one open.
    const countered = offers.some((x) => {
      if (x.proposer_account === o.proposer_account) return false;
      if (t(x.created_at) >= made) return false;
      const end = endOf(x);
      return !end || end > made;
    });
    const open = OPEN_STATES.has(o.state) && t(o.expiry) >= now && f.match.state === 'open';
    const lead = mine ? 'You' : Who;
    const step: MatchStep = {
      at: made,
      text: countered ? `${lead} countered with ${m}` : `${lead} offered ${m}`,
    };
    if (o.note) step.quote = { words: o.note, mine };
    if (open) {
      if (mine) step.tag = STEP_TAG_OPEN;
      else {
        step.tag = STEP_TAG_WAITING;
        step.waiting = true;
      }
    }
    steps.push(step);

    const end = endOf(o);
    if (!end) continue;
    let text: string | undefined;
    switch (o.state) {
      case 'accepted-by-human':
        text = mine ? `${Who} accepted your ${m}` : `You accepted ${m}`;
        break;
      case 'declined':
        text = mine ? `${Who} declined your ${m}` : `You declined ${m}`;
        break;
      case 'withdrawn':
        text = mine ? `You withdrew your ${m}` : `${Who} withdrew their ${m}`;
        break;
      default:
        text = mine ? `Your ${m} lapsed` : `${Whose} ${m} lapsed`;
    }
    steps.push({ at: end, text });
  }

  // Oldest first; a tie keeps the order the steps were written in.
  return steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.at.getTime() - b.s.at.getTime() || a.i - b.i)
    .map((x) => x.s);
}

/**
 * The other side's first name and suburb, once names have crossed. Undefined
 * before that, and wherever the profile has since been cleared. Every decrypt
 * writes an audit line under its own purpose.
 */
export async function theirNameAndArea(
  viewer: string,
  counterparty: string,
  matchId: string,
): Promise<{ firstName: string; locality?: string } | undefined> {
  const account: any = await getAccount(counterparty);
  if (!account?.first_name_enc) return undefined;
  try {
    const enc: Record<string, Buffer> = { first_name: account.first_name_enc };
    if (account.locality_enc) enc.locality = account.locality_enc;
    const fields = await decryptFields(counterparty, account.data_key_enc, enc, {
      purpose: 'match-story-view',
      actor: viewer,
      refs: { match_id: matchId },
    });
    const firstName = String(fields.first_name ?? '').trim();
    if (!firstName) return undefined;
    const locality = String(fields.locality ?? '').trim();
    return { firstName, ...(locality ? { locality } : {}) };
  } catch {
    return undefined;
  }
}

/** What the box is about, in the reader's own words, and who is on the other side. */
export interface StoryHead {
  matchId: string;
  /** The reader's own word for the thing: their posting's kind, else its shelf. */
  thing: string;
  theirName?: string;
  theirArea?: string;
  /** "Theirs: Trek Marlin 5 mountain bike · asking $620 AUD": the other side's
   *  own words for their thing and their stated asking figure. Filled in by
   *  readTheirThing where a page wants it. */
  theirs?: string;
}

/**
 * Read one match's facts for the person asking, and what the box is headed
 * with. Undefined when the match is not theirs.
 */
export async function readStoryFacts(
  viewer: string,
  matchId: string,
): Promise<{ facts: StoryFacts; head: StoryHead } | undefined> {
  const pool = getPool();
  const mr = await pool.query(
    `SELECT m.id, m.state, m.stage, m.created_at, m.account_want, m.account_have, m.category,
            m.live, c.category AS own_category, c.kind AS own_kind,
            c.screened_content AS own_screened, t.screened_content AS their_screened
       FROM matches m
       LEFT JOIN cards c ON c.id = CASE WHEN m.account_want = $1 THEN m.card_want ELSE m.card_have END
       LEFT JOIN cards t ON t.id = CASE WHEN m.account_want = $1 THEN m.card_have ELSE m.card_want END
      WHERE m.id = $2 AND (m.account_want = $1 OR m.account_have = $1)`,
    [viewer, matchId],
  );
  const m = mr.rows[0];
  if (!m) return undefined;
  // An introduction still in line has no story to tell anybody on a page: the
  // holder is never shown it, and the person waiting has one sentence from
  // their assistant (domain/sequencer.ts).
  if (m.state === 'open' && m.live === false) return undefined;
  const them = m.account_want === viewer ? m.account_have : m.account_want;
  const { categoryLeafLabel } = await import('./matchRules.js');
  const { bestOfferSealedFrom } = await import('./offers.js');

  const [optIns, photos, messages, offers, sealed] = await Promise.all([
    pool.query(
      `SELECT account_id, recorded_at FROM consent_tokens
        WHERE match_id = $1 AND kind = 'stage3-optin'`,
      [matchId],
    ),
    pool.query(
      `SELECT account_id, used_at AS at FROM approval_links
        WHERE ref_id = $1 AND action = 'conversation-photo' AND decision = 'approved'
          AND used_at IS NOT NULL AND account_id = ANY($2::uuid[])
        ORDER BY used_at ASC LIMIT 50`,
      [matchId, [viewer, them]],
    ),
    // Who and when, and never a word: the ledger's sealed body is not read.
    pool
      .query(
        `SELECT sender_account, created_at AS at FROM ledger_entries
          WHERE match_id = $1 AND door = 'message' AND outcome IN ('pass', 'hold')
          ORDER BY created_at ASC LIMIT 500`,
        [matchId],
      )
      .catch(() => ({ rows: [] as any[] })),
    pool.query(
      `SELECT id, proposer_account, amount, ccy, state, created_at, updated_at, expiry, message
         FROM offers WHERE match_id = $1 ORDER BY created_at ASC LIMIT 50`,
      [matchId],
    ),
    bestOfferSealedFrom(matchId, viewer).catch(() => false),
  ]);

  const names = m.stage >= 3 ? await theirNameAndArea(viewer, them, matchId) : undefined;
  const offerRows = (offers.rows as any[])
    .filter((o) => !sealed || o.proposer_account === viewer)
    .map((o) => ({
      id: o.id,
      proposer_account: o.proposer_account,
      amount: o.amount,
      ccy: o.ccy,
      state: o.state,
      created_at: o.created_at,
      updated_at: o.updated_at ?? o.created_at,
      expiry: o.expiry,
      note: typeof o.message?.text === 'string' ? o.message.text : null,
    }));
  return {
    facts: {
      viewer,
      match: {
        id: m.id,
        state: m.state,
        stage: Number(m.stage),
        created_at: m.created_at,
        account_want: m.account_want,
        account_have: m.account_have,
      },
      ...(names ? { theirName: names.firstName } : {}),
      ...(sharesIdentifier(
        screenedContentOf({ screened_content: m.own_screened })?.identifiers,
        screenedContentOf({ screened_content: m.their_screened })?.identifiers,
      )
        ? { sharedIdentifier: true }
        : {}),
      optIns: optIns.rows,
      photos: photos.rows,
      messages: messages.rows,
      offers: offerRows,
    },
    head: {
      matchId,
      thing: categoryLeafLabel(m.own_category ?? m.category, m.own_kind ?? null),
      ...(names ? { theirName: names.firstName } : {}),
      ...(names?.locality ? { theirArea: names.locality } : {}),
    },
  };
}

/** The asking figure as the muted line says it. */
const askingWords = (ask: any): string | undefined => {
  const amount = Number(ask?.amount);
  const ccy = typeof ask?.ccy === 'string' ? ask.ccy : '';
  return Number.isFinite(amount) && amount > 0 && ccy ? offerAmountInWords(amount, ccy) : undefined;
};

/**
 * The line that tells two boxes about the same kind of thing apart:
 * "Theirs: Trek Marlin 5 mountain bike · asking $620 AUD".
 *
 * It is read through buildAttributes, the same function that serves the
 * details step to the reader's assistant, so the page never shows more than
 * the assistant already sees: the other side's own word for their thing (the
 * first of their notes, which is their `kind`) and the asking figure a have
 * chose to show. Never a private limit, never a distance, never anything the
 * details step would refuse. Undefined wherever that step would refuse, or
 * where there is nothing to say.
 */
export async function readTheirThing(viewer: string, matchId: string): Promise<string | undefined> {
  try {
    const { getMatch, buildAttributes } = await import('./matches.js');
    const m = await getMatch(matchId);
    if (!m) return undefined;
    if (m.state === 'open' && m.live === false) return undefined;
    const p: any = await buildAttributes(m, viewer);
    return theirThingLine(p);
  } catch {
    return undefined;
  }
}

/** The line itself, from a details payload. Pure, for the tests. */
export function theirThingLine(p: any): string | undefined {
  const words = Array.isArray(p?.notes)
    ? p.notes.find((n: any) => n?.provenance === 'counterparty-untrusted' && typeof n.text === 'string' && n.text.trim())
        ?.text?.trim()
    : undefined;
  const asking = askingWords(p?.ask);
  if (!words && !asking) return undefined;
  const parts = [words, asking ? `asking ${asking}` : undefined].filter(Boolean);
  return `Theirs: ${parts.join(' · ')}`;
}
