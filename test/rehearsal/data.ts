/**
 * WHERE THE REHEARSAL'S DATA LIVES.
 *
 * The harness is public: the orchestration, the checks, the drivers and the
 * report writer are all in this folder. The data it rehearses with is not. The
 * scenario (the two fact sheets, the opening lines, the words a posting should
 * carry) and the hand-written meaning examples are our evaluation data, kept in
 * a private data repository. This file finds them, in order:
 *
 *   1. OSB_REHEARSAL_DATA — a folder laid out like this one's data
 *      (`scenarios/<name>.ts`, `meaningExamples.ts`);
 *   2. OSB_INTERNAL_DIR — a checkout of the private data repository, where
 *      the same folder is `server/test/rehearsal/`;
 *   3. `../internal` — that checkout sitting beside this `server/` checkout.
 *
 * Without any of them the runner and the calibrator say so and exit 0, and the
 * unit tests that need a scenario skip with that message, so a fork builds and
 * tests clean. To rehearse your own errand, write a scenario module with the
 * exports `Scenario` names below and point OSB_REHEARSAL_DATA at its folder.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FactSheet } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The folder the rehearsal's data is read from, whether or not it exists. */
export function rehearsalDataDir(): string {
  if (process.env.OSB_REHEARSAL_DATA) return process.env.OSB_REHEARSAL_DATA;
  const internal = process.env.OSB_INTERNAL_DIR ?? join(here, '..', '..', '..', 'internal');
  return join(internal, 'server', 'test', 'rehearsal');
}

/** One sentence saying what is missing and how to supply it. */
export function missingData(what: string): string {
  return (
    `No rehearsal ${what} at ${rehearsalDataDir()}. The rehearsal's scenario and examples are ` +
    'evaluation data and not in this repository: set OSB_REHEARSAL_DATA to a folder holding ' +
    'your own (see test/rehearsal/data.ts). Skipping.'
  );
}

/** What a scenario module exports. */
export interface Scenario {
  /** The seller's fact sheet. */
  ALEX: FactSheet;
  /** The buyer's fact sheet. */
  TONY: FactSheet;
  /** The buyer's second opening, said after the advice question is answered. */
  TONY_WANT: string;
  /** What the buyer says when a maybe is not his thing. */
  WRONG_THING: string;
  /** What each person says once connected, round by round. */
  FIRST_WORDS: { buyer: readonly string[]; seller: readonly string[] };
  /** The shelf this item does not belong on, where there is one. */
  FORBIDDEN_CATEGORY_PREFIX?: string;
  /** Words that identify the thing, for "the posting says what it is". */
  IDENTIFYING_WORDS: readonly string[];
  /** Words that say what state it is in. */
  CONDITION_WORDS: readonly string[];

  // --- The shape of the errand. Every field below is optional, and left out
  // --- it means what the first scenario (a sale, sent by post) always meant.

  /**
   * Whether money changes hands. Default true. Where it is false there is no
   * kind of sale to ask about, no figure is ever typed or accepted, the
   * figures stage becomes the two people settling the arrangement, and a
   * figure anywhere — on a posting, in a relay, on the table — is the finding.
   */
  MONEY?: boolean;
  /**
   * How far each posting should reach: 'country' for what goes in a parcel,
   * 'radius' for what is bulky or happens in person. Default: the offering
   * side 'country', the looking side unchecked.
   */
  REACH?: { seller: Reach; buyer?: Reach };
  /**
   * What the offering side's assistant must ask before it posts. Default all
   * three. `kind_of_sale` is never asked where there is no money; a make and
   * a model are not asked of something lent (the manual says so), so
   * `which_item` there means which kind of thing and its size.
   */
  ASK_BEFORE_POSTING?: readonly AskBeforePosting[];
  /** What each person says to start the photo step. Default "can I send them a photo of it?". */
  PHOTO_WORDS?: { seller?: string; buyer?: string };
  /**
   * Where there is no money: what each person says to settle the arrangement
   * in the stage a sale spends on its figure. Asked of the looking side first.
   */
  AGREE_WORDS?: { buyer: string; seller: string };
  /**
   * What each person says to open the wrap-up, meaning the whole thing is
   * over. Default "we're all sorted, thanks", which after a sale can only mean
   * done; after a lend it reads as "the arrangement is sorted" while the
   * thing is still to be picked up, so an errand whose end is a later event
   * says that event.
   */
  WRAP_WORDS?: { seller: string; buyer: string };
}

export type Reach = 'country' | 'radius';
export type AskBeforePosting = 'which_item' | 'condition' | 'kind_of_sale';

async function importData<T>(file: string): Promise<T | undefined> {
  const path = join(rehearsalDataDir(), file);
  if (!existsSync(path)) return undefined;
  return (await import(pathToFileURL(path).href)) as T;
}

/** The named scenario, or undefined when the data is not here. */
export async function loadScenario(name = 'spring'): Promise<Scenario | undefined> {
  return importData<Scenario>(join('scenarios', `${name}.ts`));
}

/** A hand-written example for one meaning question, with the right answer. */
export interface MeaningExample {
  id: string;
  said: string[];
  expect: boolean;
  humanLast?: string;
}

/** The hand-written meaning examples, or undefined when the data is not here. */
export async function loadMeaningExamples(): Promise<MeaningExample[] | undefined> {
  const mod = await importData<{ MEANING_EXAMPLES: MeaningExample[] }>('meaningExamples.ts');
  return mod?.MEANING_EXAMPLES;
}
