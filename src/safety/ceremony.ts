/**
 * The two-keyholder ceremony, as the parts that can be tested. The scripts in
 * `scripts/safety/` are thin hands on top of this file: they read files, print
 * what they are about to do, and call in here.
 *
 * THE CEREMONY, IN ORDER.
 *
 *   generate   once, offline. A safety keypair is made, the public half is
 *              printed for whoever wires SSM, and the private half is split
 *              three ways and written to three files the operator names. The
 *              private key is never written whole, never printed, and does not
 *              survive the process.
 *
 *   preserve   whenever lawful process asks us to freeze something. Reads
 *              nothing, decrypts nothing, needs no keyholder.
 *
 *   export     only under a warrant or a report that has been taken up. Two of
 *              the three shares come together, the private key exists in
 *              memory for as long as the decrypt takes, and the output is a
 *              directory with one file per entry, a manifest, and a hash over
 *              the whole so that what was handed over can be shown later to be
 *              what was handed over.
 */
import { createHash, type KeyObject } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintOf, open, privateKeyFromRaw, zeroize } from './keys.js';
import { combine, split, type Share } from './shamir.js';

export const SHARES = 3;
export const THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Share files.

/**
 * One share, as the text a keyholder keeps. Deliberately plain: a person can
 * read it over a phone, print it, and tell at a glance which key it belongs to
 * and whether it is the piece they were handed.
 *
 * The fingerprint is the public key's, which is public, so the file says which
 * ledger it opens without saying anything about how to open it. The checksum
 * catches a share that was transcribed wrong before two people spend an hour
 * discovering the bundle will not decrypt.
 */
export function shareFile(share: Share, fingerprint: string): string {
  const hex = Buffer.from(share.y).toString('hex');
  const checksum = createHash('sha256').update(share.y).digest('hex').slice(0, 16);
  return [
    'OpenSwitchboard safety key share',
    'version: 1',
    `scheme: shamir-gf256 ${THRESHOLD}-of-${SHARES}`,
    `fingerprint: ${fingerprint}`,
    `index: ${share.index}`,
    `checksum: ${checksum}`,
    `share: ${hex}`,
    '',
    'Two of these three open thirty days of the OpenSwitchboard ledger.',
    'One of them opens nothing at all. Keep it that way.',
    '',
  ].join('\n');
}

export interface ParsedShare extends Share {
  fingerprint: string;
}

/** Read a share file back, refusing one that has been damaged in transit. */
export function parseShareFile(text: string): ParsedShare {
  const field = (name: string): string => {
    const m = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(text);
    if (!m) throw new Error(`share file has no ${name}`);
    return m[1]!.trim();
  };
  if (!/OpenSwitchboard safety key share/.test(text)) {
    throw new Error('this is not an OpenSwitchboard share file');
  }
  const index = Number(field('index'));
  if (!Number.isInteger(index) || index < 1 || index > 255) throw new Error('bad share index');
  const hex = field('share');
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) throw new Error('bad share body');
  const y = new Uint8Array(Buffer.from(hex, 'hex'));
  const checksum = createHash('sha256').update(y).digest('hex').slice(0, 16);
  if (checksum !== field('checksum')) throw new Error(`share ${index} does not match its checksum`);
  return { index, y, fingerprint: field('fingerprint') };
}

/** Split the private half three ways. The caller zeroes `privateRaw` after. */
export function splitPrivateKey(privateRaw: Uint8Array): Share[] {
  return split(privateRaw, SHARES, THRESHOLD);
}

/**
 * Put the private key back from two share files, in memory and nowhere else.
 *
 * Both shares must name the same key: two shares of different keys interpolate
 * perfectly happily into something that is not a key at all, and the failure
 * would show up later as "nothing decrypts" rather than as the mistake it is.
 */
export function privateKeyFromShares(shares: ParsedShare[]): KeyObject {
  if (shares.length < THRESHOLD) throw new Error(`${THRESHOLD} shares are needed`);
  const fp = shares[0]!.fingerprint;
  for (const s of shares) {
    if (s.fingerprint !== fp) throw new Error('these shares belong to different keys');
  }
  const raw = combine(shares);
  try {
    const key = privateKeyFromRaw(raw);
    if (fingerprintOf(key) !== fp) {
      throw new Error('the reconstructed key is not the key these shares name');
    }
    return key;
  } finally {
    zeroize(raw);
  }
}

// ---------------------------------------------------------------------------
// The export bundle.

/** One row out of `ledger_entries`, as the export reads it. */
export interface LedgerRow {
  id: string;
  door: string;
  outcome: string;
  reason_code: string | null;
  sender_account: string;
  recipient_account: string | null;
  match_id: string | null;
  intent_id: string | null;
  created_at: Date;
  expires_at: Date;
  preserved_until: Date | null;
  wrapped_key: Buffer | null;
  body_enc: Buffer | null;
  nonce: Buffer | null;
  checks: unknown;
}

/** What was asked for. Entry ids, or one introduction, or a span of days. */
export interface ExportQuery {
  ids?: string[];
  match_id?: string;
  from?: Date;
  to?: Date;
}

/**
 * Where the rows come from. A function, so the suite can hand the export three
 * rows it made itself and the whole path runs with no database anywhere near
 * it.
 */
export type RowSource = (q: ExportQuery) => Promise<LedgerRow[]>;

export interface Bundle {
  dir: string;
  entries: number;
  /** SHA-256 over SHA256SUMS: one hash standing for the whole bundle. */
  hash: string;
  files: string[];
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

/**
 * Decrypt the rows and write the bundle.
 *
 * A REFUSED row has no body and never had one; it appears in the bundle with
 * its reason code and `body: null`, which is the honest answer to "what did
 * this person send" for something that was turned back at the door.
 *
 * A row that will not decrypt is written with `body: null` and an error code
 * rather than stopping the export: an incomplete bundle that says where it is
 * incomplete is worth more to the person holding the warrant than no bundle.
 */
export async function exportBundle(opts: {
  rows: LedgerRow[];
  privateKey: KeyObject;
  outDir: string;
  query: ExportQuery;
  shareIndices: number[];
  now?: Date;
}): Promise<Bundle> {
  const { rows, privateKey, outDir, query, shareIndices } = opts;
  const now = opts.now ?? new Date();
  mkdirSync(join(outDir, 'entries'), { recursive: true });
  const written: Array<{ name: string; sha: string }> = [];

  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  for (const row of sorted) {
    let body: unknown = null;
    let note: string | undefined;
    if (row.body_enc && row.wrapped_key && row.nonce) {
      try {
        const plain = open(privateKey, {
          wrapped_key: row.wrapped_key,
          body_enc: row.body_enc,
          nonce: row.nonce,
        });
        body = JSON.parse(plain.toString('utf8'));
        zeroize(plain);
      } catch {
        note = 'this entry could not be decrypted with the key these shares rebuilt';
      }
    } else {
      note = 'refused at the door: nothing of what was sent was kept';
    }
    const entry = {
      id: row.id,
      door: row.door,
      outcome: row.outcome,
      reason_code: row.reason_code,
      sender_account: row.sender_account,
      recipient_account: row.recipient_account,
      match_id: row.match_id,
      intent_id: row.intent_id,
      created_at: iso(row.created_at),
      expires_at: iso(row.expires_at),
      preserved_until: iso(row.preserved_until),
      checks: row.checks,
      body,
      ...(note ? { note } : {}),
    };
    written.push(writeOne(outDir, join('entries', `${row.id}.json`), entry));
  }

  const manifest = {
    produced_at: now.toISOString(),
    key_fingerprint: fingerprintOf(privateKey),
    keyholder_shares: [...shareIndices].sort((a, b) => a - b),
    asked_for: {
      ids: query.ids ?? null,
      match_id: query.match_id ?? null,
      from: iso(query.from ?? null),
      to: iso(query.to ?? null),
    },
    entries: sorted.map((r) => r.id),
    entry_count: sorted.length,
    about:
      'Entries from the OpenSwitchboard thirty-day safety ledger, decrypted under the ' +
      'two-keyholder ceremony described in docs/trust-and-safety.md. SHA256SUMS covers ' +
      'every file in this bundle; the bundle hash is SHA-256 of SHA256SUMS.',
  };
  written.push(writeOne(outDir, 'manifest.json', manifest));

  const sums =
    written
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => `${f.sha}  ${f.name}`)
      .join('\n') + '\n';
  writeFileSync(join(outDir, 'SHA256SUMS'), sums);
  const hash = createHash('sha256').update(sums).digest('hex');
  return {
    dir: outDir,
    entries: sorted.length,
    hash,
    files: [...written.map((f) => f.name), 'SHA256SUMS'],
  };
}

function writeOne(outDir: string, name: string, value: unknown): { name: string; sha: string } {
  const text = JSON.stringify(value, null, 2) + '\n';
  writeFileSync(join(outDir, name), text);
  return { name, sha: createHash('sha256').update(text).digest('hex') };
}

/**
 * The SQL behind the real row source, kept here beside the query shape it
 * serves. The script builds the parameters; nothing else in the service reads
 * this table.
 */
export function rowQuery(q: ExportQuery): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.ids?.length) {
    params.push(q.ids);
    where.push(`id = ANY($${params.length}::uuid[])`);
  }
  if (q.match_id) {
    params.push(q.match_id);
    where.push(`match_id = $${params.length}`);
  }
  if (q.from) {
    params.push(q.from);
    where.push(`created_at >= $${params.length}`);
  }
  if (q.to) {
    params.push(q.to);
    where.push(`created_at <= $${params.length}`);
  }
  if (!where.length) throw new Error('an export must name entries, an introduction, or dates');
  return {
    sql: `SELECT * FROM ledger_entries WHERE ${where.join(' AND ')} ORDER BY created_at LIMIT 5000`,
    params,
  };
}
