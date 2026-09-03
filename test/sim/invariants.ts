/**
 * The universal properties the switchboard must hold, everywhere, always.
 *
 * Every scenario and every fuzz step funnels its agent-facing payloads through
 * here. A violation is a real defect — it fails loudly with a repro
 * description (what payload, what leaked) rather than being swallowed. These
 * are deliberately black-box: they read only what an agent can see over MCP.
 *
 *   I1  no price ceiling / floor / band in any agent-facing payload, ever
 *   I2  no first name / locality before BOTH stage-3 opt-ins
 *   I3  no MCP accept path (asserted against the live tools list + dispatch)
 *   I4  stage / `next` never moves backward for a match
 *   I5  declines are reasonless
 *   I6  archived matches stay retrievable but never resurface as actionable
 *   I7  no match score and no integer stage in any agent-facing payload
 */

export interface Violation {
  invariant: string;
  detail: string;
  where: string;
  /** enough to reproduce: the offending payload (truncated) */
  payload?: string;
}

/** Keys that carry a private price band or a card's negotiation box. `amount`
 *  and `ccy` are NOT here — a deliberate `ask` and an offer figure are meant to
 *  cross. */
const FORBIDDEN_PRICE_KEYS = new Set([
  'price',
  'band',
  'price_band',
  'budget',
  'reserve',
  'mandate',
  'negotiation_mode',
  'authored_by',
]);

/** Keys that expose a machine internal an agent must never be handed. */
const FORBIDDEN_MACHINE_KEYS = new Set(['score', 'stage_unlocked', 'threshold', 'embedding']);

function deepKeys(o: any, path: string, hit: (k: string, path: string, value: any) => void): void {
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    hit(k, path, v);
    deepKeys(v, `${path}.${k}`, hit);
  }
}

/** I1 + I7: scan a raw payload for any forbidden price/negotiation key or any
 *  machine internal (score/stage). Applied to EVERYTHING an agent sees. */
export function scanForbidden(raw: string, where: string): Violation[] {
  const out: Violation[] = [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out; // not JSON (should not happen on an MCP payload)
  }
  deepKeys(parsed, '$', (k, path, value) => {
    if (FORBIDDEN_PRICE_KEYS.has(k)) {
      out.push({ invariant: 'I1', detail: `forbidden price/negotiation key "${k}"`, where: `${where} at ${path}.${k}`, payload: raw.slice(0, 600) });
    }
    if (FORBIDDEN_MACHINE_KEYS.has(k)) {
      out.push({ invariant: 'I7', detail: `machine-internal key "${k}"`, where: `${where} at ${path}.${k}`, payload: raw.slice(0, 600) });
    }
    // An integer `stage` field in OUTPUT is a leak (stage is an input arg only).
    if (k === 'stage' && typeof value === 'number') {
      out.push({ invariant: 'I7', detail: 'integer stage in output', where: `${where} at ${path}.stage`, payload: raw.slice(0, 600) });
    }
  });
  return out;
}

/**
 * I2: identity must not appear before both opt-ins. `identityStrings` are the
 * real first names / areas on file across the run. If a payload is from a match
 * that has NOT reached both-sides-opted-in (and is not an archived record,
 * which legitimately retains the disclosed identity), none of them may appear,
 * and the structural keys first_name / locality / mutual must be absent.
 */
export function scanIdentityLeak(
  raw: string,
  identityStrings: string[],
  where: string,
): Violation[] {
  const out: Violation[] = [];
  for (const s of identityStrings) {
    if (s && raw.includes(`"${s}"`)) {
      out.push({ invariant: 'I2', detail: `identity string "${s}" present before both opt-ins`, where, payload: raw.slice(0, 600) });
    }
  }
  if (/"(first_name|locality|mutual)"\s*:/.test(raw)) {
    out.push({ invariant: 'I2', detail: 'first_name/locality/mutual key present before both opt-ins', where, payload: raw.slice(0, 600) });
  }
  return out;
}

/** I4: the ladder of `next` words, as a monotonic rank. `awaiting_your_human`
 *  sits at the stage-3 landing (one opt-in recorded, waiting on the human), so
 *  it ranks above details_unlocked and below ready_to_talk. */
const NEXT_RANK: Record<string, number> = {
  show_interest: 0,
  awaiting_other_side: 1,
  details_unlocked: 2,
  awaiting_your_human: 3,
  ready_to_talk: 4,
};

export class LadderTracker {
  private readonly high = new Map<string, { rank: number; word: string }>();

  /** Feed a match's current `next`. Returns a violation if it regressed. A
   *  terminal state (archived/declined → next undefined) is exempt. */
  observe(matchId: string, next: string | undefined, where: string): Violation | undefined {
    if (!next) return undefined;
    const rank = NEXT_RANK[next];
    if (rank === undefined) return undefined; // unknown word — not our ladder
    const prev = this.high.get(matchId);
    if (prev && rank < prev.rank) {
      return {
        invariant: 'I4',
        detail: `next moved backward: ${prev.word} (rank ${prev.rank}) -> ${next} (rank ${rank})`,
        where,
      };
    }
    if (!prev || rank > prev.rank) this.high.set(matchId, { rank, word: next });
    return undefined;
  }
}

/** I5: a decline response must carry nothing shaped like a reason. */
export function scanDeclineReasonless(raw: string, where: string): Violation[] {
  if (/reason/i.test(raw)) {
    return [{ invariant: 'I5', detail: 'a decline response mentions a reason', where, payload: raw.slice(0, 600) }];
  }
  return [];
}

/** I6: an archived match entry is retrievable (present, state archived) but is
 *  never offered as an actionable signal (no `next`, no `signal`). */
export function scanArchivedEntry(entry: any, where: string): Violation[] {
  const out: Violation[] = [];
  if (!entry) {
    out.push({ invariant: 'I6', detail: 'archived match not retrievable via check_matches', where });
    return out;
  }
  if (entry.state !== 'archived') {
    out.push({ invariant: 'I6', detail: `archived match has state ${entry.state}`, where });
  }
  if (entry.next !== undefined) {
    out.push({ invariant: 'I6', detail: `archived match still carries an action word: ${entry.next}`, where });
  }
  if (entry.signal !== undefined) {
    out.push({ invariant: 'I6', detail: 'archived match still carries a stage-1 signal', where });
  }
  return out;
}

/** The canonical live tool set. I3: no accept tool exists on the surface. */
export const EXPECTED_TOOLS = [
  'amend_intent',
  'channel_receive',
  'channel_send',
  'check_matches',
  'list_intents',
  'open_channel',
  'publish_intent',
  'respond',
  'settle',
  'standing_arrangement',
  'withdraw_intent',
].sort();

export function scanToolsForAccept(toolNames: string[], where: string): Violation[] {
  const out: Violation[] = [];
  const suspicious = toolNames.filter((n) => /accept|approve|confirm.*deal|finali[sz]e/i.test(n));
  for (const n of suspicious) {
    out.push({ invariant: 'I3', detail: `an accept-shaped tool exists on the MCP surface: ${n}`, where });
  }
  const missing = EXPECTED_TOOLS.filter((t) => !toolNames.includes(t));
  const extra = toolNames.filter((t) => !EXPECTED_TOOLS.includes(t));
  if (missing.length) out.push({ invariant: 'I3', detail: `tool surface missing: ${missing.join(', ')}`, where });
  if (extra.length) out.push({ invariant: 'I3', detail: `tool surface has unexpected tools: ${extra.join(', ')}`, where });
  return out;
}
