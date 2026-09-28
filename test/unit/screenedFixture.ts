/**
 * A card row as a published one reads since migration 055: its words carried
 * twice, live and as the screen passed them. Every counterparty read serves
 * the screened copy (domain/screenedContent.ts), so a fixture standing in for
 * a card that is up has to carry one. Taken from the row as it is at the
 * moment of the read, so a test that changes the row's words before reading
 * sees them the way a card that passed with those words would show them.
 *
 * A row that already says what its screened copy is — including null, for a
 * card that has never been screened through — keeps it.
 */
import { snapshotOf } from '../../src/domain/screenedContent.js';

export function asScreened<T extends Record<string, any>>(row: T): T & { screened_content: unknown } {
  if (!row || 'screened_content' in row) return row as T & { screened_content: unknown };
  return { ...row, screened_content: snapshotOf(row, '2026-09-28T00:00:00.000Z') };
}
