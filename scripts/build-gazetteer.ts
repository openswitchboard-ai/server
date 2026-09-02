/**
 * Gazetteer builder — turns the GeoNames public dump into the compact,
 * offline lookup asset the switchboard ships in its image
 * (`data/gazetteer.json.gz`).
 *
 * Run it only when the place data needs refreshing:
 *
 *     npm run build:gazetteer                 # downloads into a temp dir
 *     OSB_GEONAMES_DIR=/path/to/dump npm run build:gazetteer
 *
 * Inputs (https://download.geonames.org/export/dump/):
 *   cities1000.zip        every populated place above 1000 people
 *   admin1CodesASCII.txt  first-level divisions (states, territories, regions)
 *   countryInfo.txt       country codes and names
 *   alternateNamesV2.zip  ~200 MB; only the 'abbr' rows are read, which is
 *                         where subdivision codes such as ACT and NSW live
 *
 * Source data: GeoNames, licensed CC BY 4.0 (see NOTICE).
 *
 * The asset holds one row per place with name, country, first-level division,
 * centre point, population and a reach in kilometres, plus a name index that
 * maps a normalised lookup key to the rows that answer to it. Nothing else
 * from the dump survives the reduction.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { normaliseKey, type GazetteerFile, type PlaceKind } from '../src/geo/gazetteer.js';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, '..', 'data', 'gazetteer.json.gz');

const BASE = 'https://download.geonames.org/export/dump';
const FILES = [
  'cities1000.zip',
  'admin1CodesASCII.txt',
  'countryInfo.txt',
  'alternateNamesV2.zip',
];

function sourceDir(): string {
  const given = process.env.OSB_GEONAMES_DIR;
  if (given) return given;
  const dir = join(tmpdir(), 'osb-geonames');
  mkdirSync(dir, { recursive: true });
  for (const f of FILES) {
    if (existsSync(join(dir, f))) continue;
    console.log(`fetching ${f} ...`);
    execFileSync('curl', ['-sSf', '-o', join(dir, f), `${BASE}/${f}`], { stdio: 'inherit' });
  }
  for (const zip of ['cities1000.zip', 'alternateNamesV2.zip']) {
    const txt = join(dir, zip.replace('.zip', '.txt'));
    if (!existsSync(txt)) execFileSync('unzip', ['-o', '-q', join(dir, zip), '-d', dir]);
  }
  return dir;
}

const lines = (p: string) => readFileSync(p, 'utf8').split('\n');

/** Line-by-line over a file too large to hold as one string. */
async function forEachLine(p: string, cb: (line: string) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(p), crlfDelay: Infinity });
  for await (const line of rl) cb(line);
}

/** Acronym of a multi-word division name: "New South Wales" -> "NSW". */
function acronym(name: string): string | undefined {
  const words = name
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && !['of', 'the', 'and', 'de', 'del', 'da'].includes(w.toLowerCase()));
  if (words.length < 2) return undefined;
  return words.map((w) => w[0].toUpperCase()).join('');
}

interface Row {
  name: string;
  cc: string;
  admin1: string;
  lat: number;
  lon: number;
  pop: number;
  kind: PlaceKind;
  reach: number;
  keys: Set<string>;
}

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Population-weighted centre of a group, plus the reach that covers ~90% of it. */
function centroid(members: { lat: number; lon: number; pop: number }[]): {
  lat: number;
  lon: number;
  reach: number;
} {
  let wsum = 0;
  let lat = 0;
  let lon = 0;
  for (const m of members) {
    const w = Math.max(1, m.pop);
    wsum += w;
    lat += m.lat * w;
    lon += m.lon * w;
  }
  lat /= wsum;
  lon /= wsum;
  const dists = members.map((m) => haversineKm({ lat, lon }, m)).sort((a, b) => a - b);
  const p90 = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.9))] ?? 0;
  return { lat, lon, reach: Math.max(10, Math.min(500, Math.round(p90))) };
}

/** A city's own reach: small towns are tight, capitals sprawl. */
function cityReach(pop: number): number {
  if (pop >= 2_000_000) return 40;
  if (pop >= 500_000) return 30;
  if (pop >= 100_000) return 20;
  if (pop >= 20_000) return 12;
  return 8;
}

const ASCII_ONLY = /^[\x20-\x7e]+$/;

async function build(): Promise<void> {
  const dir = sourceDir();
  console.log(`reading GeoNames dump from ${dir}`);

  // --- countries -----------------------------------------------------------
  const countryName = new Map<string, string>();
  const iso3 = new Map<string, string>();
  for (const l of lines(join(dir, 'countryInfo.txt'))) {
    if (!l || l.startsWith('#')) continue;
    const f = l.split('\t');
    if (f.length < 5 || !f[0]) continue;
    countryName.set(f[0], f[4]);
    if (f[1]) iso3.set(f[1], f[0]);
  }

  // --- first-level divisions ----------------------------------------------
  interface Admin1 {
    cc: string;
    code: string;
    name: string;
    geonameId: string;
    aliases: Set<string>;
  }
  const admin1s = new Map<string, Admin1>(); // "AU.01"
  const admin1ById = new Map<string, Admin1>();
  for (const l of lines(join(dir, 'admin1CodesASCII.txt'))) {
    const f = l.split('\t');
    if (f.length < 4) continue;
    const [key, , asciiName, id] = f;
    const [cc, code] = key.split('.');
    if (!cc || !code) continue;
    const a: Admin1 = { cc, code, name: asciiName, geonameId: id.trim(), aliases: new Set() };
    a.aliases.add(code); // "AU-01"
    const ac = acronym(asciiName);
    if (ac) a.aliases.add(ac); // "AU-NSW" from "New South Wales"
    admin1s.set(key, a);
    admin1ById.set(a.geonameId, a);
  }
  // Subdivision abbreviations (ACT, NSW, CA, ...) from the alternate-names dump.
  // These earn their keep twice: they resolve "AU-ACT", and the resolver reads
  // them back out of the finished index as the list of region words it refuses
  // to place (see regionNamed in src/geo/gazetteer.ts). Dropping them would
  // quietly let "ACT" through again.
  let abbrHits = 0;
  await forEachLine(join(dir, 'alternateNamesV2.txt'), (l) => {
    const f = l.split('\t');
    if (f[2] !== 'abbr') return;
    const a = admin1ById.get(f[1]);
    if (!a) return;
    const v = f[3]?.trim();
    if (v && v.length <= 4 && /^[A-Za-z0-9.]+$/.test(v)) {
      a.aliases.add(v.replace(/\./g, ''));
      abbrHits++;
    }
  });
  console.log(`${admin1s.size} first-level divisions, ${abbrHits} abbreviations`);

  // --- cities --------------------------------------------------------------
  const rows: Row[] = [];
  const byAdmin1 = new Map<string, { lat: number; lon: number; pop: number }[]>();
  const byCountry = new Map<string, { lat: number; lon: number; pop: number }[]>();
  await forEachLine(join(dir, 'cities1000.txt'), (l) => {
    const f = l.split('\t');
    if (f.length < 15) return;
    const name = f[1];
    const ascii = f[2];
    const alts = f[3];
    const lat = Number(f[4]);
    const lon = Number(f[5]);
    const cc = f[8];
    const admin1 = f[10];
    const pop = Number(f[14]) || 0;
    if (!name || !cc || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const keys = new Set<string>();
    for (const n of [name, ascii]) {
      const k = normaliseKey(n);
      if (k) keys.add(k);
    }
    // Alternate spellings, ASCII only and capped, so the asset stays small.
    if (pop >= 20_000 && alts) {
      let taken = 0;
      for (const alt of alts.split(',')) {
        if (taken >= 8) break;
        if (alt.length > 40 || !ASCII_ONLY.test(alt)) continue;
        const k = normaliseKey(alt);
        if (!k || keys.has(k)) continue;
        keys.add(k);
        taken++;
      }
    }
    rows.push({
      name: ascii || name,
      cc,
      admin1,
      lat,
      lon,
      pop,
      kind: 'city',
      reach: cityReach(pop),
      keys,
    });
    const point = { lat, lon, pop };
    if (admin1) {
      const k = `${cc}.${admin1}`;
      (byAdmin1.get(k) ?? byAdmin1.set(k, []).get(k)!).push(point);
    }
    (byCountry.get(cc) ?? byCountry.set(cc, []).get(cc)!).push(point);
  });
  console.log(`${rows.length} populated places`);

  // --- division rows -------------------------------------------------------
  for (const [key, a] of admin1s) {
    const members = byAdmin1.get(key);
    if (!members?.length) continue;
    const c = centroid(members);
    const keys = new Set<string>();
    const nk = normaliseKey(a.name);
    if (nk) keys.add(nk);
    for (const alias of a.aliases) {
      const k = normaliseKey(`${a.cc} ${alias}`);
      if (k) keys.add(k); // "au act"
    }
    rows.push({
      name: a.name,
      cc: a.cc,
      admin1: a.code,
      lat: c.lat,
      lon: c.lon,
      pop: members.reduce((s, m) => s + m.pop, 0),
      kind: 'admin1',
      reach: c.reach,
      keys,
    });
  }

  // --- country rows --------------------------------------------------------
  for (const [cc, members] of byCountry) {
    const c = centroid(members);
    const keys = new Set<string>();
    const nk = normaliseKey(countryName.get(cc) ?? cc);
    if (nk) keys.add(nk);
    keys.add(normaliseKey(cc));
    for (const [three, two] of iso3) if (two === cc) keys.add(normaliseKey(three));
    rows.push({
      name: countryName.get(cc) ?? cc,
      cc,
      admin1: '',
      lat: c.lat,
      lon: c.lon,
      pop: members.reduce((s, m) => s + m.pop, 0),
      kind: 'country',
      reach: c.reach,
      keys,
    });
  }

  // Country codes (alpha-2 and alpha-3) point straight at their country row,
  // so "AU" and "AUS" never land on a village or an airport alias.
  const codes: Record<string, number> = {};
  rows.forEach((r, i) => {
    if (r.kind !== 'country') return;
    codes[r.cc] = i;
    for (const [three, two] of iso3) if (two === r.cc) codes[three] = i;
  });

  // --- index ---------------------------------------------------------------
  // A key answers with every row that carries it; resolution picks between
  // them by country/division hint and then by population.
  const index: Record<string, number | number[]> = {};
  rows.forEach((r, i) => {
    for (const k of r.keys) {
      const cur = index[k];
      if (cur === undefined) index[k] = i;
      else if (Array.isArray(cur)) cur.push(i);
      else index[k] = [cur, i];
    }
  });

  const file: GazetteerFile = {
    source: 'GeoNames cities1000 + admin1CodesASCII + countryInfo (CC BY 4.0)',
    generated_at: new Date().toISOString().slice(0, 10),
    rows: rows.map((r) => [
      r.name,
      r.cc,
      r.admin1,
      Math.round(r.lat * 1e4),
      Math.round(r.lon * 1e4),
      r.pop,
      r.kind === 'city' ? 0 : r.kind === 'admin1' ? 1 : 2,
      r.reach,
    ]),
    index,
    codes,
  };

  mkdirSync(dirname(outFile), { recursive: true });
  const gz = gzipSync(Buffer.from(JSON.stringify(file)), { level: 9 });
  writeFileSync(outFile, gz);
  console.log(
    `wrote ${outFile}: ${rows.length} rows, ${Object.keys(index).length} keys, ${(gz.length / 1e6).toFixed(2)} MB`,
  );
}

await build();
