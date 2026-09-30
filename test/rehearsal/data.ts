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
  /** The shelf this item does not belong on. */
  FORBIDDEN_CATEGORY_PREFIX: string;
  /** Words that identify the thing, for "the posting says what it is". */
  IDENTIFYING_WORDS: readonly string[];
  /** Words that say what state it is in. */
  CONDITION_WORDS: readonly string[];
}

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
