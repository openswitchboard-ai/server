/**
 * Attribute value canonicalisation.
 *
 * WHY THIS EXISTS.
 *
 *   A seller wrote `frame_size: "medium"`. A buyer wrote `frame_size: "M"`.
 *   They meant the same bike. The matcher did not agree: projectionText
 *   (domain/matchRules.ts) embeds the sorted attribute pairs, so one card
 *   embedded "frame_size: medium" and the other "frame_size: m", and the
 *   semantic component - more than half the blend on a rich pair - priced a
 *   spelling difference as a disagreement. The pair scored 0.7309 against a
 *   0.75 threshold and never met.
 *
 *   The embedding cannot be asked to fix this. It reads the text it is given.
 *   So the text has to be the same text when the meaning is the same, which
 *   means the card has to be stored in one agreed spelling.
 *
 * WHERE IT RUNS.
 *
 *   domain/cards.ts, on publish and on amend, AFTER schema validation and
 *   BEFORE the row is written. The canonical form is what is stored, so it is
 *   what projectionText reads, what the embedding sees, what listIntents
 *   echoes back to the owning agent, and what a later amend rebuilds from.
 *   An amend re-queues the card for screening, and a passing verdict
 *   (domain/screening.ts applyVerdict) re-reads `attributes` from the row and
 *   re-embeds, so an amended card's vector is built from the canonical form
 *   too.
 *
 * THE RULES, IN ORDER, PER KEY.
 *
 *   Numbers and booleans pass through untouched - they are already canonical.
 *   A string is trimmed and its internal whitespace runs collapse to single
 *   spaces, and then, in this order, the first rule that applies wins:
 *
 *     1. VOCABULARY. If the taxonomy defines an enum for this key on this
 *        category (or on an ancestor category, or in common_attributes), the
 *        value is matched onto that vocabulary: case-insensitively, ignoring
 *        the difference between spaces, hyphens and underscores, and finally
 *        by unique prefix ("int" -> "intermediate"). An ambiguous prefix
 *        ("o" against both "once" and "ongoing") matches nothing and the
 *        value falls through. This rule is first so a category that HAS an
 *        opinion about its vocabulary always wins over the generic ones.
 *
 *     2. BOOLEAN WORDS. yes/no/y/n/true/false -> a real boolean.
 *
 *     3. NUMBER. A purely numeric string becomes a number, but only when the
 *        number prints back as exactly the string it came from. "26" -> 26;
 *        "1.10", "007" and "+61" stay strings, because turning them into
 *        numbers would throw information away.
 *
 *     4. SIZE SCALE. On a key that is about size (`size`, or anything ending
 *        `_size`: frame_size, clothing_size, shoe_size) AND that the taxonomy
 *        has no vocabulary for, the letter scale becomes the word: s -> small,
 *        m -> medium, l -> large, xl -> extra-large, xs -> extra-small.
 *        Numeric sizes are already gone by rule 3 and are left as numbers - a
 *        54 cm frame is not an M. `bed_size` is single/double/queen/king in
 *        the taxonomy, so the scale never reaches it.
 *
 *     5. Otherwise, lowercase. Free text keeps every word it had; only its
 *        whitespace and its case are touched.
 *
 *   Every rule is idempotent: canon(canon(x)) === canon(x), which matters
 *   because an amend rebuilds the card from stored (already canonical)
 *   attributes and canonicalises the result again.
 */
import { loadTaxonomy } from '../protocol.js';

let taxonomyCache: any | undefined;
function taxonomy(): any {
  if (!taxonomyCache) taxonomyCache = loadTaxonomy();
  return taxonomyCache;
}

/** Letter sizes, in the words the rest of the world writes them out in. */
const SIZE_SCALE: Record<string, string> = {
  xs: 'extra-small',
  'x-small': 'extra-small',
  'x small': 'extra-small',
  'extra small': 'extra-small',
  'extra-small': 'extra-small',
  s: 'small',
  sm: 'small',
  small: 'small',
  m: 'medium',
  med: 'medium',
  medium: 'medium',
  l: 'large',
  lg: 'large',
  large: 'large',
  xl: 'extra-large',
  'x-large': 'extra-large',
  'x large': 'extra-large',
  'extra large': 'extra-large',
  'extra-large': 'extra-large',
};

const TRUE_WORDS = new Set(['true', 'yes', 'y']);
const FALSE_WORDS = new Set(['false', 'no', 'n']);

/** `size`, `frame_size`, `clothing_size`, `shoe_size` - not `size_note`. */
function looksLikeSizeKey(key: string): boolean {
  return key === 'size' || key.endsWith('_size');
}

/**
 * The enum vocabularies in force for a category: the node's own attributes,
 * then every ancestor's on the way up, then common_attributes. The nearest
 * definition wins, which is how the taxonomy already reads elsewhere - a leaf
 * that redefines a key means it.
 */
export function enumVocabulary(category: string, key: string): string[] | undefined {
  const tx = taxonomy();
  const nodes = tx.nodes ?? {};
  const parts = category.split('.');
  for (let i = parts.length; i >= 1; i--) {
    const def = nodes[parts.slice(0, i).join('.')]?.attributes?.[key];
    if (def) return def.type === 'enum' && Array.isArray(def.values) ? def.values : undefined;
  }
  const common = tx.common_attributes?.[key];
  if (common) {
    return common.type === 'enum' && Array.isArray(common.values) ? common.values : undefined;
  }
  return undefined;
}

/** Spaces, hyphens and underscores all read as one separator. */
function loose(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, '');
}

function matchVocabulary(value: string, values: string[]): string | undefined {
  const lower = value.toLowerCase();
  const exact = values.find((v) => v.toLowerCase() === lower);
  if (exact) return exact;
  const target = loose(value);
  if (!target) return undefined;
  const separatorInsensitive = values.filter((v) => loose(v) === target);
  if (separatorInsensitive.length === 1) return separatorInsensitive[0];
  // A prefix has to be unambiguous, and long enough to be a word someone
  // shortened rather than a letter they happened to type.
  if (target.length < 2) return undefined;
  const prefixed = values.filter((v) => loose(v).startsWith(target));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * A purely numeric string, but only when nothing is lost: the number has to
 * print back as the exact string it came from, so "1.10" and "007" stay text.
 */
function numericOrUndefined(value: string): number | undefined {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return String(n) === value ? n : undefined;
}

/** One value, canonicalised. Exported so the tests can read the rules one at a time. */
export function canonicaliseValue(
  category: string,
  key: string,
  value: unknown,
): string | number | boolean | unknown {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return trimmed;

  const vocabulary = enumVocabulary(category, key);
  if (vocabulary) {
    const matched = matchVocabulary(trimmed, vocabulary);
    if (matched !== undefined) return matched;
  }

  const lower = trimmed.toLowerCase();
  if (TRUE_WORDS.has(lower)) return true;
  if (FALSE_WORDS.has(lower)) return false;

  const numeric = numericOrUndefined(trimmed);
  if (numeric !== undefined) return numeric;

  // The letter scale only fills a vacuum. A key the taxonomy has an opinion
  // about is governed by that opinion: `bed_size` is single/double/queen/king,
  // and an 's' there is a bed, not a t-shirt. If rule 1 could not place it,
  // it stays as it was written rather than being mapped onto a scale its own
  // category does not use.
  if (!vocabulary && looksLikeSizeKey(key)) {
    const scaled = SIZE_SCALE[lower];
    if (scaled) return scaled;
  }

  return lower;
}

/**
 * The whole attribute bag, canonicalised. Keys are untouched - the schema
 * already constrains them to lower_snake_case and bans the identity ones.
 * A non-object (or absent) bag comes back unchanged so the callers can hand
 * this whatever validation let through.
 */
export function canonicaliseAttributes<T>(category: string, attributes: T): T {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    return attributes;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attributes as Record<string, unknown>)) {
    out[k] = canonicaliseValue(category, k, v);
  }
  return out as T;
}
