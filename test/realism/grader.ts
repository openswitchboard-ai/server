/**
 * Jargon linter — the teeth of the realism eval.
 *
 * The hardest, most-iterated part of OpenSwitchboard is how a user's AI talks
 * to its human about switchboard activity. The served agent manual has been
 * re-tuned many times to get plain, friendly English with NO jargon or metrics
 * — no "stage 2", no "84% match", no "collection window closes 13:30 UTC", no
 * "card"/"match"/"connection"/"intent", no tool names. This linter measures a
 * real model's replies against that bar so we can iterate the manual from data
 * instead of by hand.
 *
 * Each captured reply is scanned for the LEAK set below (case-insensitive,
 * word-boundary, except WANT/HAVE which are case-SENSITIVE so the everyday
 * verbs "want"/"have" are not flagged). A reply FAILS if it contains any HARD
 * leak. SOFT leaks (opt-in) are recorded but do not fail on their own — they
 * are borderline: a friendly agent may reasonably say "opt in" to a human.
 *
 * ALLOWED (never flagged): "archive"/"archived" (an allowed word by design),
 * "switchboard", "listing"/"listings" (approved by the human as plain speech,
 * and the word the switchboard's own payloads and manual use), and plain human
 * times a friend would say ("Saturday", "this afternoon", "9am"). Only digit
 * clock times (13:30) are a leak.
 *
 * The linter is deliberately a blunt instrument that over-reports rather than
 * under-reports: every hit carries the offending substring so a human can
 * eyeball a false positive (chiefly the verb/noun ambiguity on "match"). The
 * point is to rank WHICH jargon leaks most across a run, to aim the next tune.
 */

export type Severity = 'hard' | 'soft';

export interface LeakRule {
  /** Stable label used in the frequency table. */
  label: string;
  severity: Severity;
  /** Global regex; every match's substring is captured. */
  re: RegExp;
  /** Optional note shown in the report for a heuristic rule. */
  note?: string;
}

export interface LeakHit {
  label: string;
  severity: Severity;
  /** The exact offending substring, verbatim from the reply. */
  substring: string;
}

export interface GradeResult {
  text: string;
  hits: LeakHit[];
  hardCount: number;
  softCount: number;
  /** pass === true iff there are zero HARD leaks. */
  pass: boolean;
}

/**
 * The leak set. Order is presentation order in the report. `re` must be a
 * global regex (the linter relies on lastIndex iteration).
 */
export const LEAK_RULES: LeakRule[] = [
  // --- lifecycle / metrics jargon ---
  { label: 'stage', severity: 'hard', re: /\bstages?\b/gi },
  { label: 'stage-number', severity: 'hard', re: /\bstage[\s-]?[123]\b/gi },
  { label: 'score', severity: 'hard', re: /\bscores?\b/gi },
  { label: 'match-score', severity: 'hard', re: /\bmatch[\s-]?score\b/gi },
  { label: 'percent-sign', severity: 'hard', re: /\d\s?%/g },
  { label: 'percent-word', severity: 'hard', re: /\bpercent(age)?\b/gi },
  { label: 'collection-window', severity: 'hard', re: /\b(collect(ion)?)\s+window\b/gi },
  {
    label: 'window-closes',
    severity: 'hard',
    re: /\bwindow\s+(closes?|closing|ends?|expires?)\b/gi,
  },
  { label: 'utc-gmt', severity: 'hard', re: /\b(UTC|GMT)\b/g },
  {
    label: 'clock-time',
    severity: 'hard',
    re: /\b([01]?\d|2[0-3]):[0-5]\d\b/g,
    note: 'a bare HH:MM clock time; plain "Saturday"/"this afternoon"/"9am" are allowed',
  },

  // --- the object nouns the human must never hear ---
  { label: 'card', severity: 'hard', re: /\b(index\s+)?cards?\b/gi },
  { label: 'intent', severity: 'hard', re: /\bintents?\b/gi },
  // "listing" used to sit here. The human approved it as plain speech — it is
  // what the switchboard's own payloads and manual now call a thin post — so
  // it is an ALLOWED word (see ALLOW_GUARDS) rather than a leak.
  {
    label: 'WANT-noun',
    severity: 'hard',
    re: /\bWANTs?\b/g, // case-SENSITIVE: the verb "want" is fine, the noun "a WANT" is not
    note: 'case-sensitive: only all-caps WANT is flagged, not the verb "want"',
  },
  {
    label: 'HAVE-noun',
    severity: 'hard',
    re: /\bHAVEs?\b/g,
    note: 'case-sensitive: only all-caps HAVE is flagged, not the verb "have"',
  },
  {
    label: 'match-noun',
    severity: 'hard',
    re: /\b(a|the|your|our|its|this|that|new|another|first|second|third|potential|possible|good|strong|fresh|one|1|two|2)\s+match(es)?\b|\bmatch(es)?\s+(found|waiting|for you|on your|with)\b|\bfound\s+(a|another|\d+)\s+match|\bnew matches?\b/gi,
    note: 'heuristic: "match" in a noun context. Verb uses ("interests that match") are not flagged; eyeball the substrings.',
  },
  {
    label: 'connection-noun',
    severity: 'hard',
    re: /\bconnections?\b/gi,
    note: 'the system noun; plain "connect you with" (verb) is not flagged',
  },
  { label: 'channel', severity: 'hard', re: /\bchannels?\b/gi },
  { label: 'provenance', severity: 'hard', re: /\bprovenance\b/gi },
  { label: 'counterparty', severity: 'hard', re: /\bcounter[\s-]?part(y|ies)\b/gi },

  // --- infra / protocol terms ---
  { label: 'MCP', severity: 'hard', re: /\bMCP\b/g },
  { label: 'server', severity: 'hard', re: /\bservers?\b/gi },
  { label: 'payload', severity: 'hard', re: /\bpayloads?\b/gi },
  { label: 'stage_unlocked', severity: 'hard', re: /\bstage[_\s-]?unlocked\b/gi },
  { label: 'next-action', severity: 'hard', re: /\bnext[_\s-]action\b/gi },
  {
    label: 'tool-name',
    severity: 'hard',
    // Only the DISTINCTIVE (snake_case / compound) tool tokens. The bare words
    // "respond" and "settle" are ordinary English ("the moment they respond",
    // "settle in") and were dropped after they produced false positives against
    // real replies — the whole point of capturing substrings is to catch this.
    // The current names AND the ones they replaced: a stale agent still
    // narrating open_channel is exactly as much of a leak as one narrating
    // open_conversation. Every token here carries an underscore, so a
    // \b-bounded match only ever fires on the literal snake_case tool name and
    // never on ordinary prose like "send a message".
    re: /\b(check_matches|publish_intent|withdraw_intent|amend_intent|list_intents|open_conversation|send_message|collect_messages|open_channel|channel_send|channel_receive|express_interest|propose_offer|send_to_human|decline_offer|withdraw_offer|list_offers|close_collection|standing_arrangement)\b/g,
    note: 'the raw switchboard tool names (distinctive snake_case tokens only; bare "respond"/"settle" excluded as common English)',
  },

  // --- soft / borderline ---
  {
    label: 'opt-in',
    severity: 'soft',
    re: /\bopt[\s-]?in(s|ned|ted|ping)?\b/gi,
    note: 'borderline: a friendly agent may say "opt in" to a human; recorded, not a hard fail',
  },
];

/** Substrings that, if a hit falls entirely inside one, are NOT a leak. Guards
 *  the allowed words that a leak regex would otherwise catch. */
const ALLOW_GUARDS: RegExp[] = [
  /\bswitchboard\b/gi, // never let any rule flag the product's own name
  // "listing"/"listings": approved by the human as plain speech, and the word
  // the switchboard itself uses for a thin post. Guarded rather than merely
  // un-ruled so that a future noun rule cannot quietly re-flag it.
  /\blistings?\b/gi,
];

function isGuarded(text: string, start: number, end: number): boolean {
  for (const g of ALLOW_GUARDS) {
    g.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      if (start >= m.index && end <= m.index + m[0].length) return true;
      if (m.index === g.lastIndex) g.lastIndex++;
    }
  }
  return false;
}

export function grade(text: string): GradeResult {
  const hits: LeakHit[] = [];
  const src = text ?? '';
  for (const rule of LEAK_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(src))) {
      const start = m.index;
      const end = start + m[0].length;
      if (!isGuarded(src, start, end)) {
        hits.push({ label: rule.label, severity: rule.severity, substring: m[0] });
      }
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++; // zero-width guard
    }
  }
  const hardCount = hits.filter((h) => h.severity === 'hard').length;
  const softCount = hits.filter((h) => h.severity === 'soft').length;
  return { text: src, hits, hardCount, softCount, pass: hardCount === 0 };
}

/** Frequency table of leak labels across many grade results, hard leaks first,
 *  most frequent first — this is what tells us where to aim the manual tune. */
export function leakFrequency(
  results: GradeResult[],
): { label: string; severity: Severity; count: number }[] {
  const counts = new Map<string, { severity: Severity; count: number }>();
  for (const r of results) {
    for (const h of r.hits) {
      const cur = counts.get(h.label) ?? { severity: h.severity, count: 0 };
      cur.count++;
      counts.set(h.label, cur);
    }
  }
  return [...counts.entries()]
    .map(([label, v]) => ({ label, severity: v.severity, count: v.count }))
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'hard' ? -1 : 1;
      return b.count - a.count;
    });
}
