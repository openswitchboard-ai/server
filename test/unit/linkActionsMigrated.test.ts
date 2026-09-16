/**
 * Every link action the code knows must be one the database will accept.
 *
 * The check on approval_links.action is rewritten by whichever migration
 * last touched it, and two pages (photo, 032; report, 035) shipped without
 * touching it, so on a real database their INSERT was refused while the unit
 * suite, which never reaches Postgres, stayed green. This test reads the
 * migrations as text and holds the LAST constraint to the code's own list.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', '..', 'migrations');

function lastActionConstraint(): string[] {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  let last: string | undefined;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    const m = sql.match(/approval_links_action_check\s*\n?\s*CHECK\s*\(action IN \(([\s\S]*?)\)\)/);
    if (m) last = m[1];
  }
  if (!last) throw new Error('no approval_links_action_check found in migrations');
  return [...last.matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
}

/** The code's list, read from the source so a new action cannot hide. */
function codeActions(): string[] {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'counter', 'links.ts'), 'utf8');
  const block = src.match(/export type ApprovalAction =([\s\S]*?);/)?.[1] ?? '';
  return [...block.matchAll(/\|\s*'([a-z-]+)'/g)].map((x) => x[1]);
}

describe('approval_links.action: the database accepts every action the code mints', () => {
  it('the last migration to touch the check lists them all', () => {
    const migrated = lastActionConstraint();
    const known = codeActions();
    expect(known.length).toBeGreaterThan(5);
    for (const a of known) expect(migrated, `'${a}' is in links.ts and missing from the check`).toContain(a);
  });
});
