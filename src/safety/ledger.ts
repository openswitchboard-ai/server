/**
 * The ledger behind the pipe's fifth step (docs/trust-and-safety.md).
 *
 * Everything that passed intake is written here, encrypted to the safety
 * public key, and deleted after thirty days. Refused items leave the sender,
 * the door and the reason code, and nothing else.
 *
 * THREE RULES THIS FILE KEEPS.
 *
 *  1. A ledger write can never fail an intake. The verdict was reached before
 *     this file was asked for anything; a database that is down, a public key
 *     that is malformed, a row that will not insert — all of it is logged as a
 *     count and a code, and the verdict still goes back to the sender's
 *     assistant. Losing evidence is bad. Refusing to carry a message because
 *     the evidence store hiccuped is worse.
 *  2. Body bytes never go to logs. Not in an error, not in a detail string,
 *     not in a length that is close enough to be a fingerprint. What this file
 *     logs is: an event name, a door, an outcome, a reason code, and counts.
 *  3. The server writes and cannot read. There is no decrypt path in this
 *     module, on purpose. The only decrypt in the repository is the export
 *     ceremony, which takes two share files.
 */
import { randomUUID, type KeyObject } from 'node:crypto';
import { getPool } from '../db.js';
import { publicKeyFromPem, seal } from './keys.js';
import { noLedger, type CheckResult, type IntakeItem, type Ledger, type Verdict } from '../intake/types.js';
import type { Config } from '../config.js';

/** Thirty days, as the doc says and the privacy page promises. */
export const LEDGER_WINDOW_DAYS = 30;

function ledgerLog(event: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/**
 * What gets encrypted: the item as it arrived, in one JSON object. The words,
 * the named facts a check needed, and where the bytes of a photo are — never
 * the bytes themselves, which stay in the photo bucket and outlive nothing.
 */
export function bodyOf(item: IntakeItem): Buffer {
  return Buffer.from(
    JSON.stringify({
      door: item.door,
      ...(item.text !== undefined ? { text: item.text } : {}),
      ...(item.fields ? { fields: item.fields } : {}),
      ...(item.object ? { object: item.object } : {}),
    }),
    'utf8',
  );
}

/**
 * The checks with the words taken out. `detail`, `plain_words` and `error` can
 * all quote the item back, and the `checks` column is one the server can read,
 * so none of the three is kept. What is left is what a transparency count and
 * a review queue actually need: which check, what it said, under what code,
 * and which model said it.
 */
export function reasonCodesOnly(checks: CheckResult[]): Array<Record<string, string>> {
  return checks.map((c) => ({
    name: c.name,
    outcome: c.outcome,
    ...(c.reason_code ? { reason_code: c.reason_code } : {}),
    ...(c.model_id ? { model_id: c.model_id } : {}),
  }));
}

/** A uuid, or nothing. The columns are uuid and a door may hand over neither. */
const uuidOrNull = (v: string | undefined): string | null =>
  v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;

export const INSERT_SQL = `INSERT INTO ledger_entries
   (id, door, outcome, reason_code, sender_account, recipient_account, match_id,
    intent_id, created_at, expires_at, wrapped_key, body_enc, nonce, checks)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now() + ($9 || ' days')::interval,
         $10, $11, $12, $13::jsonb)`;

/**
 * The row for one verdict. Pure, so the suite can look at exactly what would
 * be written without a database and without a key.
 *
 * A REFUSED item carries no body and no key: the three encryption columns go
 * in null and the table's own check constraint says the same thing again. A
 * held item keeps its body — a hold is an item on its way to a human reviewer,
 * and a review with the words taken out is not a review.
 */
export function entryParams(
  publicKey: KeyObject,
  item: IntakeItem,
  verdict: Verdict,
): unknown[] {
  const keep = verdict.outcome !== 'refuse';
  const sealed = keep ? seal(publicKey, bodyOf(item)) : undefined;
  return [
    randomUUID(),
    item.door,
    verdict.outcome,
    verdict.reason_code ?? null,
    item.sender_account,
    uuidOrNull(item.recipient_account),
    uuidOrNull(item.match_id),
    uuidOrNull(item.intent_id),
    String(LEDGER_WINDOW_DAYS),
    sealed?.wrapped_key ?? null,
    sealed?.body_enc ?? null,
    sealed?.nonce ?? null,
    JSON.stringify(reasonCodesOnly(verdict.checks)),
  ];
}

/** The real ledger, over one public key and the pool. */
export function ledgerFor(publicKey: KeyObject): Ledger {
  return {
    async recordVerdict(item: IntakeItem, verdict: Verdict): Promise<void> {
      try {
        await getPool().query(INSERT_SQL, entryParams(publicKey, item, verdict));
      } catch (e: any) {
        // A code and a count. Never the item, never the error's own message if
        // it might carry a value from the row — pg puts parameters in some of
        // them, and one of those parameters is the sealed body.
        ledgerLog('ledger-write-failed', {
          door: item.door,
          outcome: verdict.outcome,
          code: typeof e?.code === 'string' ? e.code : 'unknown',
        });
      }
    },
  };
}

// One parsed key per PEM, so the pipe is not re-parsing a key on every item.
const cache = new Map<string, Ledger>();

/**
 * The ledger this deployment has. A deployment with no `SAFETY_PUBLIC_KEY`
 * keeps nothing and says so once at startup (see `warnIfLedgerDisabled`) —
 * the same spirit as running without a Stripe secret, and the state dev sits
 * in until the ceremony has been held.
 *
 * A key that will not parse is a boot-time mistake, not a per-item one: it is
 * logged once here and the deployment carries on keeping nothing, because the
 * alternative is a switchboard that refuses to carry anything at all.
 */
export function ledgerFromConfig(cfg: Config | undefined): Ledger {
  const pem = cfg?.safetyPublicKey;
  if (!pem) return noLedger;
  const hit = cache.get(pem);
  if (hit) return hit;
  let made: Ledger;
  try {
    made = ledgerFor(publicKeyFromPem(pem));
  } catch (e: any) {
    ledgerLog('ledger-key-unreadable', { reason: String(e?.message ?? 'unparseable') });
    made = noLedger;
  }
  cache.set(pem, made);
  return made;
}

/** For the suite, which builds several deployments in one process. */
export function resetLedgerCache(): void {
  cache.clear();
}

/** One plain line at startup where this deployment keeps nothing. */
export function warnIfLedgerDisabled(
  cfg: Config,
  log: (msg: string, extra?: any) => void,
): boolean {
  if (cfg.safetyPublicKey) return false;
  log(
    'safety ledger disabled: no SAFETY_PUBLIC_KEY configured for this deployment. ' +
      'Nothing that passes intake is kept, so a report has no evidence behind it.',
  );
  return true;
}

// ---------------------------------------------------------------------------
// The sweep.

/**
 * What the thirty days mean, as one predicate, in one place.
 *
 * Past its expiry AND not preserved. A preservation request under lawful
 * process sets `preserved_until` into the future and the row stays until that
 * date, however far past the window it is; when that date passes, the ordinary
 * rule takes over again and the row goes on the next sweep.
 */
export const SWEEP_PREDICATE = `expires_at < now() AND (preserved_until IS NULL OR preserved_until < now())`;

export const SWEEP_SQL = `DELETE FROM ledger_entries WHERE id IN (
   SELECT id FROM ledger_entries WHERE ${SWEEP_PREDICATE} LIMIT 1000)`;

/**
 * The same rule in JavaScript, so the suite can state it against rows rather
 * than against a string. The two are held together by the suite: a change to
 * one that is not a change to the other fails.
 */
export function isDueForSweep(
  row: { expires_at: Date; preserved_until?: Date | null },
  now: Date,
): boolean {
  if (row.expires_at >= now) return false;
  if (row.preserved_until && row.preserved_until >= now) return false;
  return true;
}

/** Delete what has run out. Counts only; the sweep never looks at what it deletes. */
export async function sweepLedgerEntries(): Promise<{ entries: number }> {
  const r = await getPool().query(SWEEP_SQL);
  const gone = r.rowCount ?? 0;
  if (gone) ledgerLog('ledger-swept', { count: gone });
  return { entries: gone };
}

/**
 * Hold named entries past the window. The freeze half of a lawful request: it
 * reads nothing and decrypts nothing, and needs no keyholder.
 */
export async function preserveEntries(ids: string[], until: Date): Promise<{ preserved: number }> {
  if (!ids.length) return { preserved: 0 };
  const r = await getPool().query(
    `UPDATE ledger_entries SET preserved_until = $2
      WHERE id = ANY($1::uuid[])
        AND (preserved_until IS NULL OR preserved_until < $2)`,
    [ids, until],
  );
  const n = r.rowCount ?? 0;
  ledgerLog('ledger-preserved', { count: n, until: until.toISOString() });
  return { preserved: n };
}
