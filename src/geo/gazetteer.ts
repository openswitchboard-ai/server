/**
 * Offline place lookup.
 *
 * The switchboard turns a locality name into a point on the globe entirely
 * in-process, from an asset baked into the image (`data/gazetteer.json.gz`,
 * built by `scripts/build-gazetteer.ts` from the GeoNames public dump, CC BY
 * 4.0 — see NOTICE). Nothing here talks to the network, so resolution has no
 * latency, no quota and no third party watching what people are looking for.
 *
 * What resolves:
 *   - a settlement name: "Canberra", "Braddon", "Kraków", "Sao Paulo";
 *   - an alternate spelling carried by the source data;
 *   - a first-level division by name or code: "Australian Capital Territory",
 *     "AU-ACT", "AU-01", "US-CA";
 *   - a country by name or code: "Australia", "AU", "AUS";
 *   - any of the above narrowed by a trailing hint: "Springfield, IL",
 *     "Richmond, Australia".
 *
 * Each answer carries a reach in kilometres: how wide the named area actually
 * is. A town is a few kilometres across, a state is a few hundred, and a
 * country is as wide as its people are spread. That reach becomes the card's
 * radius when its agent did not state one.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export type PlaceKind = 'city' | 'admin1' | 'country';

/** Row shape in the asset: name, country, division, lat*1e4, lon*1e4,
 *  population, kind (0 city / 1 division / 2 country), reach km. */
export type GazetteerRow = [string, string, string, number, number, number, number, number];

export interface GazetteerFile {
  source: string;
  generated_at: string;
  rows: GazetteerRow[];
  index: Record<string, number | number[]>;
  /** ISO 3166-1 alpha-2 and alpha-3 country codes -> country row. */
  codes: Record<string, number>;
}

export interface Place {
  /** Display name from the source data. */
  name: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  /** GeoNames first-level division code ('' for a country row). */
  admin1: string;
  lat: number;
  lon: number;
  population: number;
  kind: PlaceKind;
  /** How wide the named area is, in km. */
  reach_km: number;
}

// ---------------------------------------------------------------------------
// Key normalisation. The builder and the resolver MUST agree on this, which
// is why both import it from here.
// ---------------------------------------------------------------------------
export function normaliseKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining marks: Krakow, Zurich
    .replace(/['\u2018\u2019]/g, '') // O'Connor -> OConnor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Street addresses are refused outright. A card names an area, never a door.
// ---------------------------------------------------------------------------
const UNIT_PREFIX =
  /^\s*(unit|apt|apartment|flat|suite|level|shop|lot|po\s*box|gpo\s*box|building|floor)\b/i;
const LEADING_NUMBER = /^\s*\d{1,5}\s*[a-z]?\s*[-/,]?\s+\S/i;
const LEADING_NUMBER_SLASH = /^\s*\d{1,5}\s*[a-z]?\s*\/\s*\d/i;
const STREET_WORD =
  /\b(st|street|rd|road|ave|av|avenue|ln|lane|dr|drive|blvd|boulevard|ct|court|cres|crescent|cl|close|pl|place|hwy|highway|pde|parade|tce|terrace|way|circuit|cct|esplanade|esp)\b/i;

/**
 * True when the text reads like a street address. Two shapes are refused: a
 * leading street number, and a unit/level prefix. A number anywhere alongside
 * a street word is refused as well, which catches "Smith St 12".
 */
export function looksLikeStreetAddress(input: string): boolean {
  const s = input.trim();
  if (!s) return false;
  if (UNIT_PREFIX.test(s)) return true;
  if (LEADING_NUMBER_SLASH.test(s)) return true;
  if (LEADING_NUMBER.test(s)) return true;
  if (/\d/.test(s) && STREET_WORD.test(s)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Asset loading (lazy, once per process).
// ---------------------------------------------------------------------------
let cache:
  | {
      file: GazetteerFile;
      /** keys carried by each division/country row, for hint matching */
      coarseKeys: Map<number, Set<string>>;
      countryRow: Map<string, number>;
      admin1Row: Map<string, number>;
    }
  | undefined;

function assetPath(): string {
  if (process.env.OSB_GAZETTEER_PATH) return process.env.OSB_GAZETTEER_PATH;
  // Works compiled (dist/src/geo/gazetteer.js), via tsx (src/geo/gazetteer.ts),
  // and from the process working directory.
  const candidates = [
    join(here, '..', '..', '..', 'data', 'gazetteer.json.gz'),
    join(here, '..', '..', 'data', 'gazetteer.json.gz'),
    join(process.cwd(), 'data', 'gazetteer.json.gz'),
  ];
  const found = candidates.find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
  if (!found) throw new Error(`gazetteer asset not found (looked in ${candidates.join(', ')})`);
  return found;
}

function load() {
  if (cache) return cache;
  const file = JSON.parse(gunzipSync(readFileSync(assetPath())).toString('utf8')) as GazetteerFile;
  const coarseKeys = new Map<number, Set<string>>();
  const countryRow = new Map<string, number>();
  const admin1Row = new Map<string, number>();
  for (const [key, v] of Object.entries(file.index)) {
    for (const i of Array.isArray(v) ? v : [v]) {
      if (file.rows[i]?.[6] === 0) continue; // cities carry no hint keys
      (coarseKeys.get(i) ?? coarseKeys.set(i, new Set()).get(i)!).add(key);
    }
  }
  file.rows.forEach((r, i) => {
    if (r[6] === 2) countryRow.set(r[1], i);
    else if (r[6] === 1) admin1Row.set(`${r[1]}.${r[2]}`, i);
  });
  cache = { file, coarseKeys, countryRow, admin1Row };
  return cache;
}

/** Provenance line for the loaded asset (used by the ops log and NOTICE). */
export function gazetteerSource(): { source: string; generated_at: string; rows: number } {
  const { file } = load();
  return { source: file.source, generated_at: file.generated_at, rows: file.rows.length };
}

const KINDS: PlaceKind[] = ['city', 'admin1', 'country'];

function toPlace(i: number): Place {
  const r = load().file.rows[i];
  return {
    name: r[0],
    country: r[1],
    admin1: r[2],
    lat: r[3] / 1e4,
    lon: r[4] / 1e4,
    population: r[5],
    kind: KINDS[r[6]],
    reach_km: r[7],
  };
}

function rowsFor(key: string): number[] {
  const v = load().file.index[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Does a trailing hint ("IL", "Australia", "ACT") describe this row? */
function hintMatches(rowIdx: number, hint: string): boolean {
  const g = load();
  const r = g.file.rows[rowIdx];
  const cc = r[1];
  if (hint === normaliseKey(cc)) return true;
  const country = g.countryRow.get(cc);
  if (country !== undefined && g.coarseKeys.get(country)?.has(hint)) return true;
  if (!r[2]) return false;
  const division = g.admin1Row.get(`${cc}.${r[2]}`);
  if (division === undefined) return false;
  const keys = g.coarseKeys.get(division);
  return !!keys && (keys.has(hint) || keys.has(`${normaliseKey(cc)} ${hint}`));
}

/** A settlement this size is what someone typing the bare name almost
 *  always means: "Sao Paulo" is the city, "Australia" is the country. */
const CITY_WINS_ABOVE = 100_000;

/**
 * When several places answer to one name, a substantial settlement wins;
 * failing that, the most populous answer of any kind. So "Sao Paulo" is the
 * city rather than the state around it, while "Australia" is the country
 * rather than the Cuban village of the same name and "England" is the
 * English region rather than the town in Arkansas.
 */
function best(candidates: number[]): number | undefined {
  if (!candidates.length) return undefined;
  const rows = load().file.rows;
  const bigCities = candidates.filter(
    (i) => rows[i][6] === 0 && rows[i][5] >= CITY_WINS_ABOVE,
  );
  const pool = bigCities.length ? bigCities : candidates;
  return [...pool].sort((a, b) => {
    if (rows[b][5] !== rows[a][5]) return rows[b][5] - rows[a][5];
    return rows[a][6] - rows[b][6];
  })[0];
}

const CODE_FORM = /^([A-Za-z]{2})[-_. ]([A-Za-z0-9]{1,4})$/;

/**
 * Resolve free text to one place, or undefined when nothing in the asset
 * answers to it. Street addresses are never resolved — callers check
 * looksLikeStreetAddress first and refuse the card.
 */
export function resolvePlace(input: string): Place | undefined {
  const raw = (input ?? '').trim();
  if (!raw) return undefined;

  // "AU-ACT", "US-CA", "AU-01": a country code and a division code.
  const code = raw.match(CODE_FORM);
  if (code) {
    const hit = best(rowsFor(normaliseKey(`${code[1]} ${code[2]}`)).filter((i) => load().file.rows[i][6] === 1));
    if (hit !== undefined) return toPlace(hit);
  }

  // A bare country code is the country, never a village or an airport tag
  // that shares the spelling ("AU" is Australia, not Au in Sankt Gallen;
  // "AUS" is Australia, not Austin).
  if (/^[A-Za-z]{2,3}$/.test(raw)) {
    const i = load().file.codes[raw.toUpperCase()];
    if (i !== undefined) return toPlace(i);
  }

  const parts = raw.split(',').map((p) => normaliseKey(p)).filter(Boolean);
  if (!parts.length) return undefined;

  // Whole string first ("New South Wales", "Sao Paulo"), then the leading
  // segment narrowed by whatever follows the comma.
  const whole = normaliseKey(raw);
  const wholeHit = best(rowsFor(whole));
  if (wholeHit !== undefined && parts.length === 1) return toPlace(wholeHit);

  const [head, ...hints] = parts;
  const candidates = rowsFor(head);
  if (candidates.length) {
    if (!hints.length) {
      const hit = best(candidates);
      if (hit !== undefined) return toPlace(hit);
    } else {
      const narrowed = candidates.filter((i) => hints.every((h) => hintMatches(i, h)));
      const hit = best(narrowed.length ? narrowed : []);
      if (hit !== undefined) return toPlace(hit);
    }
  }
  if (wholeHit !== undefined) return toPlace(wholeHit);
  return undefined;
}
