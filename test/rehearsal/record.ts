/**
 * THE RECORD OF A DEAL, BUILT AGAIN FROM WHAT THE DATABASE STILL HOLDS.
 *
 * When an offer is accepted the switchboard builds a short block of plain
 * facts, emails the same block to both people, and keeps only its SHA-256
 * (server src/domain/receipt.ts). So no row holds the record's words, and a
 * check cannot open one and look for a line in it.
 *
 * What a check can do is build the block again. Every fact in it is either in
 * a row this harness may read (the seller's screened words, the figure, the
 * note, the confirmed lines) or on the two fact sheets (the first names and
 * suburbs the humans shared). The block is built with the server's own pure
 * function, so the words and their order are the server's. Where a rebuilt
 * block has the stored fingerprint, the record that went out is known word
 * for word, and whether it lists a line is a fact.
 *
 * A FEW THINGS ARE NOT KNOWN EXACTLY, so each is tried both ways: the minute
 * the accept was pressed (the row's own time, and the minute after), and how
 * each person's suburb is written on their account. Nothing here guesses at
 * words: where no candidate has the stored fingerprint the answer is "could
 * not be rebuilt", and the check says so.
 */
import type { PostingShown } from './db.js';

export interface RecordParts {
  /** When the offer row says it was accepted, in milliseconds. */
  acceptedAtMs: number;
  posting: PostingShown;
  amount: number;
  ccy: string;
  offeredBy: 'buyer' | 'seller';
  note?: string;
  /** The confirmed lines, in the order asked. */
  confirmed: string[];
  /** Each person's first name, and the ways their suburb may be written. */
  people?: {
    buyer: { firstName: string; localities: string[] };
    seller: { firstName: string; localities: string[] };
  };
}

export interface RecordCandidate {
  sha256: string;
  block: string;
  /** Whether this candidate lists the confirmed lines. */
  withLines: boolean;
}

/** The server's own block builder and the helpers it leans on. */
export interface RecordBuilders {
  receiptFrom(f: Record<string, unknown>): { block: string; sha256: string };
  oneLine(s: unknown): string;
  promptSafe(raw: unknown, cap?: number): string;
  attributesSentence(attrs: unknown): string | undefined;
  categoryPhrase(labelOrId?: string, kind?: string | null): string;
  kindMaxChars: number;
}

/** Load the server's functions. Throws where the source cannot be imported. */
export async function loadRecordBuilders(): Promise<RecordBuilders> {
  const receipt = await import('../../src/domain/receipt.js');
  const prompt = await import('../../src/intake/promptText.js');
  const home = await import('../../src/counter/pagesHome.js');
  const rules = await import('../../src/domain/matchRules.js');
  return {
    receiptFrom: receipt.receiptFrom as unknown as RecordBuilders['receiptFrom'],
    oneLine: receipt.oneLine,
    promptSafe: prompt.promptSafe,
    attributesSentence: home.attributesSentence,
    categoryPhrase: rules.categoryPhrase,
    kindMaxChars: rules.KIND_MAX_CHARS,
  };
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * Every block the record could have been, each with and without the
 * confirmed lines. Pure, given the builders.
 */
export function recordCandidates(parts: RecordParts, b: RecordBuilders): RecordCandidate[] {
  const theirWords = parts.posting.kind ? b.promptSafe(parts.posting.kind.trim(), b.kindMaxChars) : '';
  const thing = b.oneLine(theirWords) || b.categoryPhrase(parts.posting.category);
  const details = b.attributesSentence(parts.posting.attributes);
  const minutes = [parts.acceptedAtMs, parts.acceptedAtMs + 60_000, parts.acceptedAtMs - 60_000];
  const pairs: ({ buyer: { firstName: string; locality: string }; seller: { firstName: string; locality: string } } | undefined)[] = [
    undefined,
  ];
  if (parts.people) {
    for (const bl of unique(parts.people.buyer.localities)) {
      for (const sl of unique(parts.people.seller.localities)) {
        pairs.push({
          buyer: { firstName: parts.people.buyer.firstName, locality: bl },
          seller: { firstName: parts.people.seller.firstName, locality: sl },
        });
      }
    }
  }
  const out: RecordCandidate[] = [];
  const seen = new Set<string>();
  for (const at of minutes) {
    for (const people of pairs) {
      for (const withLines of [true, false]) {
        if (!withLines && !parts.confirmed.length) continue;
        const built = b.receiptFrom({
          at: new Date(at),
          thing,
          ...(details ? { details } : {}),
          amount: parts.amount,
          ccy: parts.ccy,
          offeredBy: parts.offeredBy,
          ...(parts.note ? { note: parts.note } : {}),
          ...(withLines && parts.confirmed.length ? { confirmed: parts.confirmed } : {}),
          ...(people ? { people } : {}),
        });
        if (seen.has(built.sha256)) continue;
        seen.add(built.sha256);
        out.push({ sha256: built.sha256, block: built.block, withLines: withLines && parts.confirmed.length > 0 });
      }
    }
  }
  return out;
}
