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
import type { CardRow } from './cards.js';
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
  'live-animals':
    'Live animals stay off the switchboard everywhere it runs. This one cannot go back on the board as it stands.',
  'wildlife-products':
    'Wildlife products stay off the switchboard everywhere it runs. This one cannot go back on the board as it stands.',
  alcohol:
    'Alcohol is held back until the rules around selling it are settled. This one cannot go back on the board for now.',
  'event-tickets':
    'Event tickets are held back until the rules around reselling them are settled. This one cannot go back on the board for now.',
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
};

// True wherever it renders: the approval page shows the raw code beneath it,
// an email does not, so this sentence never promises one.
const REASON_FALLBACK =
  'Screening held this back, under a check the switchboard has no plainer words for yet. If it looks wrong, edit what you posted and save it to send it through again.';

/** One human sentence for a reason code. Unknown codes get the honest fallback. */
export function screeningReasonInPlainWords(reasonCode?: string): string {
  return (reasonCode && REASON_SENTENCES[reasonCode]) || REASON_FALLBACK;
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
export function collectFreeText(card: Pick<CardRow, 'attributes'> & { kind?: string | null }): string[] {
  const out: string[] = [];
  if (typeof card.kind === 'string' && card.kind.trim()) out.push(`kind: ${card.kind.trim()}`);
  for (const [k, v] of Object.entries(card.attributes ?? {})) {
    if (typeof v === 'string') out.push(`${k}: ${v}`);
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
 */
export interface AppliedVerdict {
  applied: boolean;
  screening: StoredScreening;
}

export async function applyVerdict(
  cfg: Config,
  cardId: string,
  verdict: ScreeningVerdict,
): Promise<AppliedVerdict> {
  const screening: StoredScreening = { ...verdict, at: new Date().toISOString() };
  if (verdict.pass) {
    const { embedCard } = await import('./embeddings.js');
    const card = await getPool().query(
      'SELECT id, category, kind, attributes FROM cards WHERE id = $1',
      [cardId],
    );
    if (card.rows[0]) await embedCard(cfg, card.rows[0]);
    const r = await getPool().query(
      `UPDATE cards SET lifecycle_state='PUBLISHED', screening=$2, updated_at=now()
       WHERE id=$1 AND lifecycle_state='PENDING_SCREENING'`,
      [cardId, JSON.stringify(screening)],
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: cfg.matchingQueueUrl,
        MessageBody: JSON.stringify({ kind: 'card-published', card_id: cardId }),
      }),
    );
    return { applied: !!r.rowCount, screening };
  }
  const r = await getPool().query(
    `UPDATE cards SET lifecycle_state='SCREENING_REJECTED', screening=$2, updated_at=now()
     WHERE id=$1 AND lifecycle_state='PENDING_SCREENING'`,
    [cardId, JSON.stringify(screening)],
  );
  return { applied: !!r.rowCount, screening };
}
