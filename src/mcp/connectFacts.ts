/**
 * What the switchboard already knows about THIS agent's own human, handed
 * over at connect, with the manual.
 *
 * Run 8 again (13 September 2026). A human said he had a mountain bike to
 * sell; his assistant asked which suburb he was in; he answered; on the next
 * posting it asked again. The area was made to ride every sweep for exactly
 * this, and the sweep did not reach it: the logs show the account made no
 * read call at all before the question. An assistant told "sell my bike"
 * turns to its human first and to the switchboard second, so a fact that
 * rides a sweep arrives after the question it was meant to answer.
 *
 * The one thing every agent reads is the manual, and the manual is served
 * once, at connect. So the human's own facts go there — outside the versioned
 * text, exactly like the settlement block in mcp.ts and for the same reason:
 * a fact an agent only learns by calling a tool arrives too late.
 *
 * Three rules hold this file:
 *
 *  1. These are the human's OWN facts going to their OWN agent, on their own
 *     bearer token. Nothing here is ever composed into an introduction, a
 *     disclosure or any other payload a counterparty can read.
 *  2. A missing fact is absent, never named. No "area unknown" line: an agent
 *     reading one out would be telling its human the switchboard lost
 *     something.
 *  3. Fail-soft, always. A connect that hangs or fails because of this block
 *     is far worse than a connect without it, so every read is raced against
 *     a timeout and every failure ends in an empty string. The manual is
 *     served either way.
 */
import { getTimezone } from '../domain/accounts.js';
import { clockNote } from '../domain/localTime.js';
import { areaNote, areaNotFullNote, readOwnArea, type OwnArea } from '../domain/profile.js';
import { countryOfTimeZone } from '../geo/homeCountry.js';
import { SUSPENDED_WORDS, isSuspended } from '../safety/suspend.js';

/**
 * THE SUSPENDED BLOCK, and why it is the first thing in the whole payload
 * (docs/trust-and-safety.md, "Telling their assistant").
 *
 * We cannot make an assistant remember anything, so the switchboard tells it
 * every time instead: this block at connect, `SUSPENDED` on every tool call,
 * and the manual asking the agent to keep the fact in its own memory. Told
 * every time beats remembered once.
 *
 * It goes ahead of YOUR HUMAN, TODAY because everything under that heading is
 * about work this agent is not going to be doing. An agent that reads the area
 * and the clock first will start composing a posting before it reaches the one
 * sentence that matters.
 */
export const SUSPENDED_HEADING = 'THIS ACCOUNT IS SUSPENDED';

export const SUSPENDED_BLOCK = `${SUSPENDED_HEADING}\n${SUSPENDED_WORDS} Keep it in your own memory as well as reading it here: this text is served once, at connect, and a client that never reconnects reads it once.`;

/**
 * The block, or an empty string. Fail-soft like everything else in this file:
 * a read that fails means the agent is not told at connect, and every tool
 * call it makes still answers SUSPENDED — so the worst case is a later answer
 * rather than a failed handshake.
 */
export async function suspendedBlock(
  accountId: string,
  opts: { timeoutMs?: number; onError?: (err: unknown) => void } = {},
): Promise<string> {
  try {
    const stopped = await withTimeout(
      isSuspended(accountId),
      opts.timeoutMs ?? OWN_HUMAN_READ_TIMEOUT_MS,
    );
    return stopped ? SUSPENDED_BLOCK : '';
  } catch (err) {
    opts.onError?.(err);
    return '';
  }
}

/** The heading, in the manual's own register and beside THIS DEPLOYMENT, TODAY. */
export const OWN_HUMAN_HEADING = 'YOUR HUMAN, TODAY';

/**
 * What the heading is for, said once before the facts themselves. Held short:
 * the connect text is capped now (instructions.ts, CONNECT_TEXT_CAP), and this
 * preamble is the one part of the block that says nothing an agent acts on.
 */
export const OWN_HUMAN_PREAMBLE =
  'What the switchboard holds about the human you act for; a sweep tells you ' +
  'anything newer.';

/**
 * How long the whole block may take before connect goes on without it. One
 * identity decrypt and one small query; anything past this is a database
 * having a bad day, and a bad day must not become a failed handshake.
 */
export const OWN_HUMAN_READ_TIMEOUT_MS = 1500;

/**
 * The audit purpose these reads carry. Every identity read writes a WORM
 * decrypt line, and the purpose is what tells a later reader why: this one was
 * the manual an agent was handed at connect, not a sweep and not a disclosure.
 */
export const OWN_AREA_CONNECT_PURPOSE = 'own-area-for-connect-manual';

export interface OwnHumanFacts {
  area?: OwnArea;
  timezone?: string | null;
}

/**
 * The block itself, or an empty string when nothing is known. Pure, so the
 * copy can be linted and read without a database.
 */
export function ownHumanBlockText(facts: OwnHumanFacts, now: Date = new Date()): string {
  const lines: string[] = [];

  if (facts.area && !facts.area.area_resolved) {
    // An area that does not name one town on its own (26 September 2026): the
    // sweep's own sentence, which says to ask for the town, state and country,
    // because a posting's place is taken only written in full.
    lines.push(areaNotFullNote(facts.area.area));
  } else if (facts.area) {
    const place = facts.area.area_resolved ?? facts.area.area;
    // The sweep's sentence, word for word, so an agent that has read one has
    // read the other. Where the gazetteer settled a shorter answer, the words
    // the human actually typed ride in the same breath as the full name: the
    // agent can then say the place back to them the way they said it.
    const said = areaNote(place);
    const typed = facts.area.area;
    const opening = `Your human is in ${place}.`;
    lines.push(
      place !== typed && said.startsWith(opening)
        ? said.replace(opening, `Your human is in ${place}, which they wrote as "${typed}".`)
        : said,
    );
  }

  const tz = facts.timezone;
  if (tz) lines.push(clockNote(now, tz));

  if (lines.length === 0) return '';
  return `${OWN_HUMAN_HEADING}\n${OWN_HUMAN_PREAMBLE}\n\n${lines.join('\n\n')}`;
}

/** Reject after `ms`, so a slow read can never hold a handshake open. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const capped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('own-facts read timed out')), ms);
    // Nothing should be kept alive waiting for this.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, capped]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

/**
 * Read this human's own facts and write the block. Never throws: a failure, a
 * timeout or an account with nothing on file all come back as an empty string,
 * and the caller serves the manual unchanged.
 */
export async function ownHumanBlock(
  accountId: string,
  opts: { now?: Date; timeoutMs?: number; onError?: (err: unknown) => void } = {},
): Promise<string> {
  const now = opts.now ?? new Date();
  try {
    // The zone is read first, and not only to be said back: it is what tells
    // the gazetteer which country this human is in, so a shared name is read
    // out to them with their own country's places at the top. One cheap query
    // ahead of the identity read, both still inside the one budget.
    const [area, timezone] = await withTimeout(
      (async () => {
        const tz = await getTimezone(accountId);
        const own = await readOwnArea(accountId, OWN_AREA_CONNECT_PURPOSE, {
          country: countryOfTimeZone(tz),
        });
        return [own, tz] as const;
      })(),
      opts.timeoutMs ?? OWN_HUMAN_READ_TIMEOUT_MS,
    );
    return ownHumanBlockText({ area, timezone }, now);
  } catch (err) {
    opts.onError?.(err);
    return '';
  }
}
