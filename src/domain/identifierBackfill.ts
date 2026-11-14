/**
 * THE STORED FORMS OF IDENTIFIERS, WRITTEN AGAIN (14 November 2026,
 * migration 073).
 *
 * The rule an identifier is compared by changed (domain/identifiers.ts
 * normaliseIdentifier: a mark between two digits is kept as a boundary). A
 * row carries the compared forms in three places, all worked out from the
 * value as given, which is never touched:
 *
 *   - `identifiers[*].norm`, beside each value;
 *   - `screened_content.identifiers[*].norm`, the snapshot the screen passed;
 *   - `identifier_norms`, the forms the exact-match lookup reads.
 *
 * Every comparison already works the forms out again from the values
 * (identifiersOf), so a row under the old rule is compared correctly; only
 * the lookup reads what is stored. Migration 073 cleared `identifier_norms`
 * on every row with identifiers, and this writes all three again with the
 * same code the doors use. SQL cannot be relied on to reproduce the rule
 * (NFKD folding and Unicode letters and digits), so it is done here.
 *
 * Two ways in. Each task runs the DUE pass as it starts (index.ts): the rows
 * with identifiers and no lookup forms, which a partial index finds at once,
 * so on a start with nothing to do it is one empty read. The ops command
 * `identifier-forms --all` reads every row with identifiers and writes the
 * ones that differ, for a row an older task wrote during a rollout.
 *
 * Idempotent, and careful with a row that changes under it: each write only
 * lands if the row still holds what was read, so an amend in between wins.
 * Nothing else on the row moves: no content version, no updated_at.
 */
import { getPool } from '../db.js';
import { identifierNorms, identifiersOf, normaliseIdentifier } from './identifiers.js';

/** Rows per read. */
export const IDENTIFIER_FORMS_BATCH = 500;

/** Each element's `norm` worked out again from its value; anything else kept as it is. */
export function restampIdentifiers(stored: unknown): unknown {
  if (!Array.isArray(stored)) return stored;
  return stored.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const el = item as Record<string, unknown>;
    if (typeof el.value !== 'string' || typeof el.norm !== 'string') return item;
    return { ...el, norm: normaliseIdentifier(el.value) };
  });
}

/** The snapshot with its identifiers restamped, or as it was where it has none. */
export function restampSnapshot(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const s = snapshot as Record<string, unknown>;
  return Array.isArray(s.identifiers) ? { ...s, identifiers: restampIdentifiers(s.identifiers) } : snapshot;
}

/**
 * The lookup forms for what a row stores. An empty array, never NULL, where
 * nothing on the row can be compared, so the row is not read again as due.
 */
export const lookupFormsFor = (identifiers: unknown): string[] => identifierNorms(identifiersOf(identifiers));

export interface IdentifierFormsOutcome {
  read: number;
  written: number;
}

export async function fillIdentifierForms(
  log: (msg: string, extra?: any) => void = () => {},
  opts: { all?: boolean; batch?: number } = {},
): Promise<IdentifierFormsOutcome> {
  const pool = getPool();
  const batch = opts.batch ?? IDENTIFIER_FORMS_BATCH;
  const due = opts.all ? '' : 'AND identifier_norms IS NULL';
  const out: IdentifierFormsOutcome = { read: 0, written: 0 };
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const r = await pool.query(
      `SELECT id, identifiers, screened_content, identifier_norms FROM cards
        WHERE identifiers IS NOT NULL ${due} AND id > $1::uuid
        ORDER BY id LIMIT $2`,
      [after, batch],
    );
    const rows = r.rows as { id: string; identifiers: unknown; screened_content: unknown; identifier_norms: string[] | null }[];
    for (const row of rows) {
      out.read++;
      const identifiers = restampIdentifiers(row.identifiers);
      const snapshot = restampSnapshot(row.screened_content);
      const forms = lookupFormsFor(row.identifiers);
      const same =
        JSON.stringify(identifiers) === JSON.stringify(row.identifiers) &&
        JSON.stringify(snapshot ?? null) === JSON.stringify(row.screened_content ?? null) &&
        row.identifier_norms !== null &&
        JSON.stringify([...row.identifier_norms].sort()) === JSON.stringify([...forms].sort());
      if (same) continue;
      const w = await pool.query(
        `UPDATE cards
            SET identifiers = $2::jsonb, identifier_norms = $3::text[], screened_content = $4::jsonb
          WHERE id = $1 AND identifiers = $5::jsonb AND screened_content IS NOT DISTINCT FROM $6::jsonb`,
        [
          row.id,
          JSON.stringify(identifiers),
          forms,
          snapshot == null ? null : JSON.stringify(snapshot),
          JSON.stringify(row.identifiers),
          row.screened_content == null ? null : JSON.stringify(row.screened_content),
        ],
      );
      out.written += w.rowCount ?? 0;
    }
    if (rows.length < batch) break;
    after = rows[rows.length - 1].id;
  }
  if (out.read) log('identifier-forms: pass done', { ...out, all: opts.all === true });
  return out;
}
