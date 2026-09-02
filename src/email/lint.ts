/**
 * Banned-phrase lint for outgoing email copy (the project's standing VOICE
 * rules). Antithesis constructions are banned outright; the render suite
 * runs every template's HTML + text through this, and send.ts asserts it in
 * dev so a template regression can never quietly ship marketing voice.
 */

const BANNED: { pattern: RegExp; label: string }[] = [
  { pattern: / not just /i, label: '" not just " (antithesis)' },
  { pattern: /— not /i, label: '"— not " (antithesis)' },
  { pattern: /, not /i, label: '", not " (antithesis)' },
];

export interface LintHit {
  label: string;
  excerpt: string;
}

/** Returns every banned-phrase hit in the given copy (empty array = clean). */
export function lintEmailCopy(copy: string): LintHit[] {
  const hits: LintHit[] = [];
  for (const b of BANNED) {
    const m = copy.match(b.pattern);
    if (m && m.index !== undefined) {
      hits.push({
        label: b.label,
        excerpt: copy.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' '),
      });
    }
  }
  return hits;
}

export function assertEmailCopyClean(copy: string, context: string): void {
  const hits = lintEmailCopy(copy);
  if (hits.length) {
    throw new Error(
      `banned phrase in email copy (${context}): ${hits.map((h) => `${h.label} near "…${h.excerpt}…"`).join('; ')}`,
    );
  }
}
