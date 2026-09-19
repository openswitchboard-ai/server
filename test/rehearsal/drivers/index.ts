/**
 * The cast, and how a client joins it.
 *
 * Three drivers today: two OpenClaw agents on the EC2 box (Nagatha on the
 * default profile, Bilby on `--profile bilby`) and Claude Code headless on this
 * laptop. Adding a fourth is one function returning a Driver and one line in
 * DRIVERS — nothing else in the suite knows which client is on which side.
 */
import { ask as askNagatha } from '../../realism/nagatha.js';
// Bilby is agent B under another name: same `--profile` mechanism, same
// `--local` runner. DUET_B_PROFILE=bilby is what makes it Bilby.
import { ask as askB } from '../../duet/agentB.js';
import { deepCleanAndBind } from '../box.js';
import { MCP_URL } from '../config.js';
import type { Driver } from '../types.js';
import { claudeCodeDriver } from './claudeCode.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. The rehearsal suite needs NAGATHA_HOST / NAGATHA_KEY and ` +
        'DUET_B_HOST / DUET_B_KEY (the same box) with DUET_B_PROFILE=bilby.',
    );
  }
  return v;
}

export function nagathaDriver(): Driver {
  return {
    name: 'Nagatha',
    async prepare(agentKey, _runId, humanFirstName) {
      return deepCleanAndBind(
        'nagatha',
        requireEnv('NAGATHA_HOST'),
        requireEnv('NAGATHA_KEY'),
        agentKey,
        MCP_URL,
        humanFirstName,
      );
    },
    async ask(sessionId, utterance) {
      const r = await askNagatha(sessionId, utterance);
      return {
        text: r.text,
        // An OpenClaw receipt that is absent means "not observable", and that
        // is carried through rather than flattened to an empty list.
        ...(r.toolsObserved ? { toolActivity: r.toolsUsed } : {}),
        model: r.model,
        durationMs: r.durationMs,
        raw: r.raw,
      };
    },
  };
}

export function bilbyDriver(): Driver {
  return {
    name: 'Bilby',
    async prepare(agentKey, _runId, humanFirstName) {
      return deepCleanAndBind(
        'bilby',
        requireEnv('DUET_B_HOST'),
        requireEnv('DUET_B_KEY'),
        agentKey,
        MCP_URL,
        humanFirstName,
      );
    },
    async ask(sessionId, utterance) {
      const r = await askB(sessionId, utterance);
      return { text: r.text, toolActivity: r.toolsUsed, model: r.model, durationMs: r.durationMs, raw: r.raw };
    },
  };
}

export const DRIVER_NAMES = ['nagatha', 'bilby', 'claude'] as const;
export type DriverName = (typeof DRIVER_NAMES)[number];

export function makeDriver(name: DriverName, privateDir: string): Driver {
  switch (name) {
    case 'nagatha':
      return nagathaDriver();
    case 'bilby':
      return bilbyDriver();
    case 'claude':
      return claudeCodeDriver({ privateDir, mcpUrl: MCP_URL });
  }
}

/**
 * `--cast nagatha,bilby;claude,nagatha` — one or more PAIRINGS, cycled run over
 * run.
 *
 * WHY A LIST. The bar asks for a streak that contains at least two runs with
 * Claude Code and Nagatha in the room and at least two with Nagatha and Bilby,
 * and no single pairing can satisfy that, so a series has to be able to change
 * cast between runs. Sides still alternate WITHIN a pairing, so both clients
 * are exercised on both sides of the errand.
 */
export function parseCasts(raw: string): [DriverName, DriverName][] {
  const groups = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!groups.length) throw new Error('--cast is empty');
  return groups.map(parseCast);
}

/** `--cast nagatha,bilby` → the two clients, in the order they are named. */
export function parseCast(raw: string): [DriverName, DriverName] {
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`--cast wants exactly two clients, got "${raw}"`);
  }
  for (const p of parts) {
    if (!(DRIVER_NAMES as readonly string[]).includes(p)) {
      throw new Error(`--cast: "${p}" is not one of ${DRIVER_NAMES.join(', ')}`);
    }
  }
  if (parts[0] === parts[1]) {
    throw new Error(
      `--cast: both sides are "${parts[0]}". Two sides of one errand must be two different ` +
        'assistants on two different accounts, or the run measures one assistant talking to itself.',
    );
  }
  return parts as [DriverName, DriverName];
}

/**
 * Which client plays the seller on run `i` (1-based).
 *
 * The cast alternates so both clients are exercised on BOTH sides. A client
 * that only ever sells is never asked the buyer's questions, and the buyer's
 * side is where the invented-figure slip lives.
 */
export function castForRun(
  casts: [DriverName, DriverName] | [DriverName, DriverName][],
  run: number,
): { seller: DriverName; buyer: DriverName } {
  const list: [DriverName, DriverName][] = Array.isArray(casts[0])
    ? (casts as [DriverName, DriverName][])
    : [casts as [DriverName, DriverName]];
  // The pairing cycles, and within a pairing the sides swap each time it comes
  // round, so over four runs of two pairings every client has sold and bought.
  const pairing = list[(run - 1) % list.length];
  const timesSeen = Math.floor((run - 1) / list.length);
  return timesSeen % 2 === 0
    ? { seller: pairing[0], buyer: pairing[1] }
    : { seller: pairing[1], buyer: pairing[0] };
}
