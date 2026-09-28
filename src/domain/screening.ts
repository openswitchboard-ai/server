/**
 * Screening pipeline. A published card stays PENDING_SCREENING until this
 * pipeline passes it — there is no bypass. Checks:
 *  1. Deterministic deny-list category re-check (schema repo seed).
 *  2. Bedrock (Claude Haiku) content screening of every free-text value on
 *     the card: prompt-injection patterns, PII, stolen-goods markers,
 *     recalled-goods markers.
 * A rejection stores the reason internally (cards.screening) — it is never
 * disclosed to a counterparty beyond the SCREENING_REJECTED error code.
 *
 * BOTH CHECKS NOW LIVE IN src/intake (docs/trust-and-safety.md): one pipe for
 * everything a person hands over, one check per file. What is left here is the
 * part that is about a posting in particular — the plain sentences behind each
 * reason code, and applying a verdict to the row — plus screenCard, which is
 * the posting door of that pipe under the name the screening worker calls it by.
 */
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { decidingCheck, runIntake } from '../intake/pipe.js';
import { promptSafePair } from '../intake/promptText.js';
import type { CardRow } from './cards.js';
import { snapshotOf, type ScreenableWords } from './screenedContent.js';
import { heldBackReason } from '../denylist.js';
import { NO_MONEY_REASON, shelfReasonSentence, shelfRuleRefusal } from './shelfRules.js';
import type { Config } from '../config.js';

export { screenTextWithBedrock } from '../intake/checks/modelScreen.js';

export interface ScreeningVerdict {
  pass: boolean;
  reason_code?: string;
  detail?: string;
  model_id?: string;
}

/** What actually lands in cards.screening: the verdict plus when it was made. */
export interface StoredScreening extends ScreeningVerdict {
  at: string;
}

/**
 * Reason codes in plain words, for the person whose card it is. These are the
 * ONLY sentences a human or their own agent ever sees about a rejection; the
 * model's free-text note (verdict.detail) stays internal, and nothing here
 * ever crosses to a counterparty (a rejected card never reaches PUBLISHED, so
 * it never enters matching, and the disclosure payloads are schema-closed).
 */
const REASON_SENTENCES: Record<string, string> = {
  'prompt-injection':
    'Some of the wording here reads like an instruction aimed at an AI that comes across it. What goes on the board carries plain facts about the thing itself. Take that wording out and it can go back on the board.',
  'pii-in-card':
    'There are personal details in what you posted — a name, an email address, a phone number, a street address or something like them. Wants and haves stay anonymous until you say yes to sharing. Take those out and it can go back on the board.',
  'stolen-goods-markers':
    'The wording here reads the way an advert for stolen goods reads. If that is a turn of phrase rather than the truth of it, say it plainly instead and it can go back on the board.',
  'recalled-goods':
    'This looks like an item under a safety recall, so the switchboard is holding it back. If that is wrong, describe the item more exactly in its attributes and it can go back on the board.',
  weapons:
    'Weapons stay off the switchboard everywhere it runs. This one cannot go back on the board as it stands.',
  'prescription-medication':
    'Prescription medication stays off the switchboard everywhere it runs. This one cannot go back on the board as it stands.',
  // One shelf is the exception since 26 September 2026 (its taxonomy node's
  // screen_note, domain/shelfRules.ts). The sentence says so, so a person
  // refused elsewhere hears where it can go.
  'live-animals':
    'Live animals stay off the switchboard everywhere it runs, apart from lost and found pets going home. This one cannot go back on the board as it stands.',
  // The families held back because of the law around them (the deny-list
  // seed's 'vertical-policy-pending' entries) are not here: their one
  // sentence is the entry's own closed_reason, read by heldBackReason below.
  // Prohibited by what the thing IS, whatever it was filed under. The
  // catalogue is a deny list now, so a made-up category is no longer a way
  // past this; these four have no path in the seed and never did, because
  // they describe a thing rather than a place in the tree.
  drugs:
    'Drugs stay off the switchboard everywhere it runs. This one cannot go back on the board as it stands.',
  'sexual-services':
    'Sex sold or sought stays off the switchboard everywhere it runs. This one cannot go back on the board as it stands.',
  'illegal-activity':
    'This reads as something unlawful, and the switchboard carries none of that anywhere it runs. If that is a turn of phrase rather than the truth of it, say plainly what the thing is and it can go back on the board.',
  people:
    'A person is not a thing to be offered or asked for, so this cannot go on the board. Looking for somebody to do something WITH — a partner, a hand, company — is what the switchboard is for, so if that is what was meant, say it that way and it can go up.',
  prohibited:
    'This is not something the switchboard carries, whatever it was filed under. It cannot go back on the board as it stands.',
  // No verdict could be reached in time (rejectStuckScreening below). Nothing
  // was found wrong with it; it simply never got checked.
  'could-not-screen':
    'This could not be checked, so it did not go on the board. Post it again.',
};

// True wherever it renders: the main page shows the raw code beneath it,
// an email does not, so this sentence never promises one.
const REASON_FALLBACK =
  'Screening held this back, under a check the switchboard has no plainer words for yet. Tell your assistant what to change and it will send it back to be checked.';

/** Shelf-rule codes written on rows before the rules moved into the data. */
const LEGACY_SHELF_CODES: Record<string, string> = { 'no-money-on-lost-pets': NO_MONEY_REASON };

/** One human sentence for a reason code. Unknown codes get the honest fallback. */
export function screeningReasonInPlainWords(reasonCode?: string): string {
  if (!reasonCode) return REASON_FALLBACK;
  // A shelf rule's code is the taxonomy's own (domain/shelfRules.ts), and so
  // is the plain name its one sentence says. A code stored before the rules
  // moved into the data (27 September 2026) is read as the code it became.
  const code = LEGACY_SHELF_CODES[reasonCode] ?? reasonCode;
  return heldBackReason(code) ?? REASON_SENTENCES[code] ?? shelfReasonSentence(code) ?? REASON_FALLBACK;
}

/**
 * The rejection carried by a card's stored screening record, if it is one.
 * Returns undefined for a passing card, an unscreened card, or a malformed
 * record — a caller must never invent a rejection that the row does not say.
 */
export function rejectionInPlainWords(
  screening: unknown,
): { reasonCode?: string; plain: string; at?: string } | undefined {
  if (!screening || typeof screening !== 'object') return undefined;
  const s = screening as Partial<StoredScreening>;
  if (s.pass !== false) return undefined;
  return {
    reasonCode: typeof s.reason_code === 'string' ? s.reason_code : undefined,
    plain: screeningReasonInPlainWords(
      typeof s.reason_code === 'string' ? s.reason_code : undefined,
    ),
    at: typeof s.at === 'string' ? s.at : undefined,
  };
}

/**
 * Every free-text value an author controls on the card.
 *
 * `kind` leads, where the posting gave one. It is the agent's own plain words
 * for the thing, it is the only thing on a card filed under an unknown leaf
 * that says what the thing IS, and it is therefore both the first place a
 * personal detail or a figure would land and the whole of what the
 * prohibited-by-meaning check has to read.
 */
export function collectFreeText(
  card: Pick<CardRow, 'attributes'> & {
    kind?: string | null;
    also_called?: unknown;
    not_these?: unknown;
  },
): string[] {
  const out: string[] = [];
  // Every piece here is the author's own words — the kind, the attribute names
  // they chose and the values they wrote — so every piece goes through
  // promptSafe on its way to a prompt (src/intake/promptText.ts). An attribute
  // KEY is as much theirs as the value is.
  if (typeof card.kind === 'string' && card.kind.trim()) {
    out.push(promptSafePair('kind', card.kind.trim()));
  }
  // AND THE HUMAN'S OTHER WORDS FOR IT (migration 050), screened exactly as
  // `kind` is and for exactly the same reasons: they are free words the author
  // chose, they are the first place a figure or a contact detail would land now
  // that they exist, and the prohibited-by-meaning check must read every word
  // that says what the thing is. Both lists go: something a person insists the
  // thing is NOT is still words they wrote.
  for (const [field, value] of [
    ['also_called', card.also_called],
    ['not_these', card.not_these],
  ] as const) {
    if (!Array.isArray(value)) continue;
    for (const phrase of value) {
      if (typeof phrase === 'string' && phrase.trim()) out.push(promptSafePair(field, phrase.trim()));
    }
  }
  for (const [k, v] of Object.entries(card.attributes ?? {})) {
    if (typeof v === 'string') out.push(promptSafePair(k, v));
  }
  return out;
}

/**
 * The posting door of the intake pipe, in the shape the screening worker and
 * its stored record have always used. Both checks run: the deny-list path
 * first, then the model over the card's free text, which is handed over as one
 * block because that is how the prompt has always carried it.
 *
 * A check that could not answer — Bedrock unreachable — comes back from the
 * pipe as a HOLD carrying the error it threw, and the error is re-thrown here.
 * That is deliberate and unchanged: the queue message is not deleted, SQS
 * redelivers, and the card stays PENDING_SCREENING rather than being published
 * on a screen that never happened.
 */
export async function screenCard(cfg: Config, card: CardRow): Promise<ScreeningVerdict> {
  // THE SHELF RULES ONCE MORE, on the row as it stands (domain/shelfRules.ts).
  // The door already asked them at publish and amend; this is the backstop
  // for anything that reached the queue another way, and it costs no model
  // call. A band on the row is never decrypted here: that it exists is enough.
  const shelf = shelfRuleRefusal({
    category: card.category,
    kind: card.kind,
    also_called: card.also_called,
    attributes: card.attributes,
    ask: card.ask,
    sale: card.sale,
    price: card.price_enc ? true : undefined,
  });
  if (shelf) return { pass: false, reason_code: shelf.reason_code, detail: 'shelf rule' };
  const verdict = await runIntake(cfg, {
    door: 'posting',
    sender_account: card.account_id,
    intent_id: card.id,
    fields: {
      category: card.category,
      ...(card.kind ? { kind: card.kind } : {}),
    },
    text: collectFreeText(card).join('\n'),
  });
  const deciding = decidingCheck(verdict);
  if (verdict.outcome === 'hold') {
    throw deciding?.error ?? new Error(`screening could not finish: ${deciding?.detail ?? deciding?.name}`);
  }
  if (verdict.outcome === 'refuse') {
    return {
      pass: false,
      reason_code: deciding?.reason_code,
      detail: deciding?.detail,
      ...(deciding?.model_id ? { model_id: deciding.model_id } : {}),
    };
  }
  const modelId = verdict.checks.find((c) => c.name === 'modelScreen')?.model_id;
  return { pass: true, ...(modelId ? { model_id: modelId } : {}) };
}

/**
 * Apply a verdict: PUBLISHED (and enqueue for matching) or SCREENING_REJECTED.
 * A passing card is EMBEDDED FIRST (Titan v2 over its canonical projection,
 * see matchRules.projectionText): if the embedding call fails the whole
 * message redelivers and the card stays PENDING_SCREENING - a card is never
 * published without its matching-engine embedding (NO-FALLBACKS).
 *
 * Returns the record it wrote and whether the UPDATE actually landed. A
 * rejection notice hangs off `applied`: the state change is the ONE rejection
 * event, so a redelivered queue message that finds the card already rejected
 * changes nothing and mails nothing.
 *
 * THE VERDICT LANDS ONLY ON THE WORDS IT READ (migration 055). `card` is the
 * row the worker read and screened, never a fresh read, and both statements
 * below require the row's content_version to still be the one on it. An amend
 * or a refine that landed while the model was thinking has moved the version
 * on and sent a message of its own; this verdict then changes nothing, and the
 * newer message screens the newer words. The embedding, the published state
 * and the screened snapshot are all written in the one guarded statement, from
 * these same values, so what the other side is shown is exactly what passed.
 *
 * A refusal leaves screened_content alone. Whatever last passed stays the
 * last thing anybody else is shown; the refused words never cross.
 */
export interface AppliedVerdict {
  applied: boolean;
  screening: StoredScreening;
}

/** The row as the worker read it: what was screened, and which version it was. */
export type ScreenedCard = Pick<CardRow, 'id' | 'category'> & ScreenableWords;

export async function applyVerdict(
  cfg: Config,
  card: ScreenedCard,
  verdict: ScreeningVerdict,
): Promise<AppliedVerdict> {
  const screening: StoredScreening = { ...verdict, at: new Date().toISOString() };
  const version = Number(card.content_version ?? 1);
  if (verdict.pass) {
    const { embedText, vectorLiteral } = await import('./embeddings.js');
    const { projectionText } = await import('./matchRules.js');
    const vec = await embedText(
      cfg,
      projectionText({
        category: card.category,
        kind: card.kind,
        also_called: card.also_called,
        attributes: card.attributes,
      }),
    );
    const r = await getPool().query(
      `UPDATE cards SET lifecycle_state='PUBLISHED', screening=$2, screened_content=$4::jsonb,
              embedding=$5::vector, updated_at=now()
       WHERE id=$1 AND lifecycle_state='PENDING_SCREENING' AND content_version=$3`,
      [
        card.id,
        JSON.stringify(screening),
        version,
        JSON.stringify(snapshotOf(card, screening.at)),
        vectorLiteral(vec),
      ],
    );
    // Only a card this verdict actually published goes to the matcher. One
    // whose words moved on is published, if at all, by the message that
    // carries them.
    if (r.rowCount) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: cfg.matchingQueueUrl,
          MessageBody: JSON.stringify({ kind: 'card-published', card_id: card.id }),
        }),
      );
    }
    return { applied: !!r.rowCount, screening };
  }
  const r = await getPool().query(
    `UPDATE cards SET lifecycle_state='SCREENING_REJECTED', screening=$2, updated_at=now()
     WHERE id=$1 AND lifecycle_state='PENDING_SCREENING' AND content_version=$3`,
    [card.id, JSON.stringify(screening), version],
  );
  return { applied: !!r.rowCount, screening };
}

/**
 * HOW LONG A POSTING MAY WAIT FOR A VERDICT. A posting the model cannot give a
 * verdict on is held rather than published — the message redelivers, and after
 * its last try it lands on the dead-letter queue — and until this sweep it then
 * stayed pending for ever: not on the board, not refused, and nothing the
 * human could do about it but wait on a verdict that was never coming.
 */
export const STUCK_SCREENING_HOURS = 6;

/** The reason code a posting refused for want of a verdict carries. */
export const COULD_NOT_SCREEN = 'could-not-screen';

/**
 * Refuse every posting that has waited on the screen for longer than
 * STUCK_SCREENING_HOURS, with the plain reason that it could not be checked.
 * Driven by the ttl-expiry tick (workers/opsWorker.ts), beside expireDueCards.
 *
 * A refusal like any other: the words never went up, the owner reads the
 * reason on their main page, and posting it again sends it back through. The
 * clock is updated_at, which publish, amend and refine all set, so a posting
 * changed a minute ago is a minute old here. Returns how many it refused.
 */
export async function rejectStuckScreening(): Promise<number> {
  const screening: StoredScreening = {
    pass: false,
    reason_code: COULD_NOT_SCREEN,
    detail: `no verdict after ${STUCK_SCREENING_HOURS} hours`,
    at: new Date().toISOString(),
  };
  const r = await getPool().query(
    `UPDATE cards SET lifecycle_state='SCREENING_REJECTED', screening=$1::jsonb, updated_at=now()
      WHERE lifecycle_state='PENDING_SCREENING'
        AND updated_at < now() - make_interval(hours => $2::int)
      RETURNING id`,
    [JSON.stringify(screening), STUCK_SCREENING_HOURS],
  );
  return r.rowCount ?? 0;
}
