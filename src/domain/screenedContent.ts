/**
 * WHAT CROSSES IS WHAT WAS SCREENED (migration 055).
 *
 * A card's words live in two places. The live columns are the owner's: what
 * they posted, amended and refined, read back to them on their own list and
 * their own page. `screened_content` is everybody else's: the same words as
 * the screen last passed them, written in the statement that publishes the
 * card, from the exact values that were screened.
 *
 * Every read that shows one person something about another person's card goes
 * through here and never touches the live columns. An amend or a refine sends
 * the card back to the screen without touching the snapshot, so the other side
 * goes on seeing the last words that passed until the new ones pass too; and a
 * refusal leaves it alone, so the refused words never cross at all.
 *
 * A card with no snapshot has never been screened through. It serves nothing.
 */
import { identifiersOf, type Identifier } from './identifiers.js';

/** The card's words as the screen last passed them. */
export interface ScreenedContent {
  /** The content_version that was screened. */
  version: number;
  /** When the passing verdict landed. */
  at: string;
  kind: string | null;
  also_called: string[] | null;
  not_these: string[] | null;
  attributes: Record<string, unknown>;
  ask: unknown;
  /**
   * The identifiers as screened (migration 067). Never shown to the other
   * side: they are here so that the one sentence saying two postings carry the
   * same identifier is worked out from screened words on both sides.
   */
  identifiers?: Identifier[];
}

/** The fields of a card row the snapshot is taken from. */
export interface ScreenableWords {
  kind?: string | null;
  also_called?: unknown;
  not_these?: unknown;
  attributes?: unknown;
  ask?: unknown;
  identifiers?: unknown;
  content_version?: number | null;
}

const phrases = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : null;

/** The key is left off a posting with none, so a snapshot with none reads as it always has. */
const withIdentifiers = (v: unknown): { identifiers?: Identifier[] } => {
  const ids = identifiersOf(v);
  return ids.length ? { identifiers: ids } : {};
};

const plainObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The snapshot of exactly these values. The screening worker hands in the row
 * it read and screened, never a fresh read, so what is written is what the
 * screen saw.
 */
export function snapshotOf(card: ScreenableWords, at: string): ScreenedContent {
  return {
    version: Number(card.content_version ?? 1),
    at,
    kind: typeof card.kind === 'string' ? card.kind : null,
    also_called: phrases(card.also_called),
    not_these: phrases(card.not_these),
    attributes: plainObject(card.attributes),
    ask: card.ask ?? null,
    ...withIdentifiers(card.identifiers),
  };
}

/**
 * The snapshot on a row, read defensively, or undefined where there is none.
 * A malformed value reads as none: nothing is served rather than something the
 * screen never passed.
 */
export function screenedContentOf(card: { screened_content?: unknown } | null | undefined):
  | ScreenedContent
  | undefined {
  const s = card?.screened_content;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined;
  const o = s as Record<string, unknown>;
  return {
    version: Number(o.version ?? 0),
    at: typeof o.at === 'string' ? o.at : '',
    kind: typeof o.kind === 'string' ? o.kind : null,
    also_called: phrases(o.also_called),
    not_these: phrases(o.not_these),
    attributes: plainObject(o.attributes),
    ask: o.ask ?? null,
    ...withIdentifiers(o.identifiers),
  };
}
