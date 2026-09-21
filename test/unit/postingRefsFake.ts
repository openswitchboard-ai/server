/**
 * The posting-reference table, in memory, for the suites that drive the posting
 * door (domain/postingRef.ts).
 *
 * Four suites stand a fake pool in front of the door, and every one of them has
 * to answer the three statements the reference makes: read one, write down that
 * a gate has asked, and forget it when the attempt succeeds. The rule the
 * statements enforce is the whole point of the reference — a read is by
 * reference AND account, so somebody else's number matches nothing — so it is
 * written once, here, rather than four times with three of them slightly wrong.
 */
export interface RefRow {
  reference: string;
  account_id: string;
  asked: string[];
}

export interface RefsFake {
  /** Every open attempt, by its reference. */
  rows: Map<string, RefRow>;
  /** The gates asked on one attempt, for a suite that wants to assert them. */
  asked(reference: string | undefined): string[];
  /** Answer a posting_references statement, or undefined if it is not one. */
  handle(sql: string, params: any[]): { rows: any[]; rowCount: number } | undefined;
}

export function refsFake(): RefsFake {
  const rows = new Map<string, RefRow>();
  const answer = (r: any[]) => ({ rows: r, rowCount: r.length });
  return {
    rows,
    asked: (reference) => (reference ? (rows.get(reference)?.asked ?? []) : []),
    handle(sql, params) {
      if (!/posting_references/.test(sql)) return undefined;
      if (/^\s*SELECT/i.test(sql)) {
        // Reference AND account: somebody else's number reads as no number.
        const row = rows.get(String(params[0]));
        return answer(row && row.account_id === params[1] ? [row] : []);
      }
      if (/^\s*INSERT/i.test(sql)) {
        const [reference, account_id, asked] = params as [string, string, string[]];
        const row = rows.get(reference);
        if (row && row.account_id !== account_id) return answer([]);
        const merged = [...new Set([...(row?.asked ?? []), ...(asked ?? [])])];
        rows.set(reference, { reference, account_id, asked: merged });
        return answer([]);
      }
      if (/^\s*DELETE/i.test(sql)) {
        rows.delete(String(params[0]));
        return answer([]);
      }
      return undefined;
    },
  };
}
