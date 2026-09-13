/**
 * Suggestions for the one box a human types an area into.
 *
 * The same offline asset that places every posting answers this, so the area a
 * person shares and the area their postings match on come out of one source.
 * Nothing here talks to the network: no key, no bill, no third party watching
 * a person type the name of their own suburb — which is the whole reason the
 * switchboard carries a gazetteer rather than calling one.
 *
 * Only settlements are offered. A state, a territory and a country are places
 * nobody lives in the middle of, and the posting path refuses them outright,
 * so they are left out of the list a person picks from.
 *
 * What comes back is the exact string to store: "Braddon, Australian Capital
 * Territory". It reads as an area to the person it is shown to, and it
 * resolves straight back through `resolvePlace` to the place it came from, so
 * a shared area and a posting's place agree without a second column.
 */
import { LOCALITY_MAX } from '../domain/profile.js';
import {
  allRows,
  countryNameOf,
  indexKeys,
  normaliseKey,
  placeAt,
  qualifyPlace,
} from './gazetteer.js';

/** Shorter than this and the list would be half the gazetteer. */
export const AREA_QUERY_MIN = 3;
/** As many as a person reads without scrolling, and no more. */
export const AREA_SUGGEST_MAX = 8;
/** A common prefix ("san", "new") runs to thousands of rows. Ranking a
 *  bounded slice puts the places people have heard of at the top without
 *  walking the whole run on every keystroke. */
const SCAN_CEILING = 2000;

export interface AreaSuggestion {
  /** The string stored and shown: "Braddon, Australian Capital Territory". */
  value: string;
  /** The country it sits in, written out: "Australia". */
  country: string;
}

interface Sorted {
  keys: string[];
  rows: number[];
}

let sorted: Sorted | undefined;

/** An alternate spelling shorter than this is an airport code as often as it
 *  is a name — the dump hangs "ACT" off Waco and "TAS" off Tashkent. */
const ALTERNATE_MIN = 5;
/** How far an alternate spelling may sit from the name it spells. Two edits
 *  covers the transliterations ("Zuerich" for Zurich, "Arhus" for Aarhus) and
 *  stops well short of a different word. */
const ALTERNATE_EDITS = 2;

/** True when two spellings are within `ALTERNATE_EDITS` of each other. */
function closeSpelling(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > ALTERNATE_EDITS) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > ALTERNATE_EDITS) return false;
    prev = row;
  }
  return prev[b.length] <= ALTERNATE_EDITS;
}

/**
 * Every spelling a settlement can be found by, normalised and sorted, built
 * once on the first suggestion and kept for the life of the process.
 *
 * A place's own name always counts. An alternate spelling counts only when it
 * is plainly a spelling of that same name and no settlement owns it outright —
 * which keeps Columbus, Ohio out of the list of Franklins while still finding
 * the places whose own name in the source data is a transliteration nobody
 * types: "Zuerich" under Zurich, "Arhus" under Aarhus, "Krakow" under Cracow.
 * A different word for the same place — Bombay, Peking — is past the list, and
 * a person who types one keeps their own words, as they always could.
 *
 * Whatever is found, what a person sees and stores is the place's own name.
 */
function index(): Sorted {
  if (sorted) return sorted;
  const rows = allRows();
  const ownedByASettlement = new Set<string>();
  rows.forEach((r) => {
    if (r[6] === 0) ownedByASettlement.add(normaliseKey(r[0]));
  });
  const pairs: { key: string; row: number }[] = [];
  for (const [key, v] of indexKeys()) {
    if (!key) continue;
    for (const i of Array.isArray(v) ? v : [v]) {
      const r = rows[i];
      if (!r || r[6] !== 0) continue;
      const name = normaliseKey(r[0]);
      const own = name === key;
      if (
        !own &&
        (key.length < ALTERNATE_MIN ||
          ownedByASettlement.has(key) ||
          !closeSpelling(key, name))
      ) {
        continue;
      }
      pairs.push({ key, row: i });
    }
  }
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  sorted = { keys: pairs.map((p) => p.key), rows: pairs.map((p) => p.row) };
  return sorted;
}

/** First position whose key is not less than the prefix. */
function lowerBound(keys: string[], prefix: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The settlements whose own name starts with what has been typed, largest
 * first, at most `limit` of them.
 *
 * Empty for anything shorter than `AREA_QUERY_MIN`. A suggestion that would
 * not fit the box it goes into is dropped rather than offered, so everything
 * in the list saves when it is picked.
 */
export function suggestAreas(query: string, limit = AREA_SUGGEST_MAX): AreaSuggestion[] {
  const prefix = normaliseKey(query ?? '');
  if (prefix.length < AREA_QUERY_MIN) return [];
  const cap = Math.max(1, Math.min(limit, AREA_SUGGEST_MAX));
  const { keys, rows } = index();
  const all = allRows();
  const hits: number[] = [];
  for (let i = lowerBound(keys, prefix); i < keys.length; i++) {
    if (!keys[i].startsWith(prefix)) break;
    hits.push(rows[i]);
    if (hits.length >= SCAN_CEILING) break;
  }
  hits.sort((a, b) => {
    if (all[b][5] !== all[a][5]) return all[b][5] - all[a][5];
    return all[a][0].length - all[b][0].length;
  });
  const seen = new Set<string>();
  const out: AreaSuggestion[] = [];
  for (const i of hits) {
    const p = placeAt(i);
    const { place } = qualifyPlace(p);
    if (place.length > LOCALITY_MAX || seen.has(place)) continue;
    seen.add(place);
    out.push({ value: place, country: countryNameOf(p.country) ?? p.country });
    if (out.length >= cap) break;
  }
  return out;
}
