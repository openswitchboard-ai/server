/**
 * THE HUMAN'S OTHER WORDS FOR THE THING (Lachlan, 20 September 2026).
 *
 * The founder asked whether an assistant could just read the whole board and
 * judge for itself. It cannot, and it never will: an open board ends the
 * anonymity everything here rests on. What it can have instead is BETTER
 * MATERIAL on its own human's postings, and this is the first half of it.
 *
 * A posting has said what the thing is in one short phrase since the beginning.
 * A person knows more than one phrase for it — the trade name, the part number,
 * the thing everyone in that hobby says, and the near neighbour it is
 * emphatically not — and until now none of that reached the search.
 *
 * WHY THIS IS ITS OWN TOOL RATHER THAN A WIDER `amend_intent`. Three reasons,
 * and the first is the founder's rule that a heading cannot change. An amend is
 * a re-publish of a whole posting in the wire's own words: it re-resolves the
 * place, re-reads a figure back, spends a publish from the quota, and answers
 * with where the posting was filed. None of that is what is happening here.
 * Second, this takes phrases rather than a patch, so folding it into `patch`
 * would mean a field that is a list of free words sitting beside geo and price
 * and being validated by the card schema, which does not admit it. Third, the
 * sentences back are different: an amend says where the posting went, and this
 * says what was added and that the switchboard is looking again now. Amend's
 * rule is untouched — a heading still cannot change, and neither can `kind`.
 *
 * WHAT IT DOES NOT DO. It cannot change what the thing IS. `also_called` is the
 * same thing said again; a different thing is a different posting, exactly as a
 * different heading is.
 */
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { getCard } from './cards.js';
import { OsbError } from '../protocol.js';
import { type Arrangement } from './arrangement.js';
import { readLaneFacts, sayFor } from './lanes.js';
import type { HearsVia } from './accounts.js';
import type { Config } from '../config.js';

/** How many phrases either list takes, and how long one may be. */
export const OTHER_WORDS_MAX = 6;
export const OTHER_WORDS_MAX_CHARS = 60;

/**
 * WHAT A PHRASE MAY BE, checked here and now.
 *
 * The same two-checks-to-different-masters arrangement `kind` has had since it
 * existed (cards.ts kindComplaint). This one is synchronous and about SHAPE, so
 * an assistant that sent a price or a phone number hears about it in the same
 * call. The other one is the model screen, off the queue, at the posting door
 * of the one pipe, and it is the check that reads what the words MEAN
 * (src/intake, src/domain/screening.ts collectFreeText). Neither stands in for
 * the other, and the words reach the board only once both have passed.
 */
export function phraseComplaint(phrase: unknown): string | undefined {
  if (typeof phrase !== 'string') return 'each one has to be a few plain words';
  const p = phrase.trim();
  if (!p) return 'each one has to be a few plain words';
  if (p.length > OTHER_WORDS_MAX_CHARS) {
    return `each one has to fit in ${OTHER_WORDS_MAX_CHARS} characters`;
  }
  if (/[$£€¥]/.test(p)) return 'these carry no price';
  if (/@|https?:\/\/|www\./i.test(p)) {
    return 'these carry no email address, phone number or link';
  }
  // A part number is the whole point of this, so a digit is welcome where it
  // sits inside a word ("TB-303", "ClubSport V3"). A phrase that is nothing but
  // figures is a figure, and figures do not belong in the words for a thing.
  if (/^[\d\s.,-]+$/.test(p)) return 'these take plain words rather than a bare figure';
  return undefined;
}

/** Both lists, checked and tidied, or the plain-words complaint about them. */
export function readOtherWords(
  value: unknown,
  field: 'also_called' | 'not_these',
): { ok: true; phrases: string[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, phrases: [] };
  const said = field === 'also_called' ? 'the other words for the thing' : 'what it is not';
  if (!Array.isArray(value)) return { ok: false, error: `${said} comes as a list of short phrases` };
  if (value.length > OTHER_WORDS_MAX) {
    return { ok: false, error: `${said} takes ${OTHER_WORDS_MAX} phrases at most` };
  }
  const phrases: string[] = [];
  for (const v of value) {
    const complaint = phraseComplaint(v);
    if (complaint) return { ok: false, error: `${said}: ${complaint}` };
    const p = (v as string).trim();
    if (!phrases.some((q) => q.toLowerCase() === p.toLowerCase())) phrases.push(p);
  }
  return { ok: true, phrases };
}

export interface RefineResult {
  intent_id: string;
  state: string;
  also_called: string[];
  not_these: string[];
  say_note: { text: string; provenance: 'switchboard-system' };
}

/**
 * THE SENTENCES BACK, and they say three things and stop: what was added, that
 * the switchboard is looking again right now, and nothing whatever about the
 * board. An assistant reading this must not be able to tell its human anything
 * about what is out there, because it has been told nothing.
 */
export function refinedSentence(
  alsoCalled: string[],
  notThese: string[],
  a: Arrangement = {},
  hearsVia?: HearsVia,
): string {
  const bits: string[] = [];
  if (alsoCalled.length) {
    bits.push(
      alsoCalled.length === 1
        ? 'I have added the other way they say it.'
        : 'I have added their other ways of saying it.',
    );
  }
  if (notThese.length) bits.push('I have written down what it is not, so close things count for less.');
  const added = bits.length ? bits.join(' ') : 'Nothing was added to it.';
  return sayFor('refined', a, { added, hearsVia });
}

/**
 * Store the words and send the posting back through the door it came in by.
 *
 * THE RE-RUN IS THE RE-PUBLISH PATH, exactly. The row goes to
 * PENDING_SCREENING with its verdict cleared and a screen-card message goes on
 * the queue, which is what an amend does. The screening worker reads the words
 * through the same checks `kind` goes through, re-embeds the posting from its
 * new projection, and hands it to the matching queue — so the search really
 * does run again on the new words, and the human hears about whoever it finds
 * in the conversation they are already having.
 *
 * WHAT IT WILL NOT DO. A posting that is not this account's, or is withdrawn or
 * expired, is refused exactly as an amend refuses one.
 */
export async function refineIntent(
  cfg: Config,
  accountId: string,
  intentId: string,
  input: { also_called?: unknown; not_these?: unknown },
): Promise<RefineResult> {
  if (typeof intentId !== 'string' || !intentId) {
    throw Object.assign(new Error('intent not found'), { notFound: true });
  }
  const card = await getCard(intentId);
  if (!card || card.account_id !== accountId) {
    throw Object.assign(new Error('intent not found'), { notFound: true });
  }
  if (card.lifecycle_state === 'WITHDRAWN') {
    throw Object.assign(new Error('intent is withdrawn'), { notFound: true });
  }
  if (card.lifecycle_state === 'EXPIRED') throw new OsbError('INTENT_EXPIRED');

  const also = readOtherWords(input?.also_called, 'also_called');
  if (!also.ok) throw Object.assign(new Error(also.error), { validation: ['also_called'] });
  const nots = readOtherWords(input?.not_these, 'not_these');
  if (!nots.ok) throw Object.assign(new Error(nots.error), { validation: ['not_these'] });
  if (!also.phrases.length && input?.also_called === undefined) {
    throw Object.assign(
      new Error('say at least one other way your human says it'),
      { validation: ['also_called'] },
    );
  }

  await getPool().query(
    `UPDATE cards
        SET also_called = $2::jsonb,
            not_these = $3::jsonb,
            lifecycle_state = 'PENDING_SCREENING', screening = NULL, updated_at = now()
      WHERE id = $1`,
    [intentId, JSON.stringify(also.phrases), JSON.stringify(nots.phrases)],
  );
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: cfg.screeningQueueUrl,
      MessageBody: JSON.stringify({ kind: 'screen-card', card_id: intentId }),
    }),
  );
  const facts = await readLaneFacts(accountId);
  return {
    intent_id: intentId,
    state: 'PENDING_SCREENING',
    also_called: also.phrases,
    not_these: nots.phrases,
    say_note: {
      // One cheap read of this account's own row, so the sentence knows which
      // lane it is speaking into and whether the human behind it is written to
      // at all. Best-effort: unreadable is prompted, the lane that promises the
      // least, and no claim about post.
      text: refinedSentence(also.phrases, nots.phrases, facts.arrangement, facts.hearsVia),
      provenance: 'switchboard-system' as const,
    },
  };
}
