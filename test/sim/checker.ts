/**
 * The bridge between a running scenario and the invariants module: every
 * agent-facing payload a scenario or fuzz step sees is fed through a Checker,
 * which runs the universal scans and collects violations for the report. A
 * violation never throws — it is a finding, surfaced with its repro — so a
 * single leak does not abort the run before other invariants are exercised.
 */
import type { McpResult } from './harness.js';
import {
  LadderTracker,
  Violation,
  scanArchivedEntry,
  scanDeclineReasonless,
  scanForbidden,
  scanIdentityLeak,
  scanToolsForAccept,
} from './invariants.js';

export class Checker {
  readonly violations: Violation[] = [];
  readonly ladder = new LadderTracker();
  constructor(private readonly identityStrings: string[]) {}

  private add(vs: Violation[]): void {
    this.violations.push(...vs);
  }

  /** I1 + I7 on any agent-facing payload. Safe on stage-3 mutual payloads
   *  (identity there is legitimate and is NOT scanned here). */
  sweep(raw: string, where: string): void {
    this.add(scanForbidden(raw, where));
  }

  /** A check_matches sweep: universal scan, plus per-entry ladder (I4) and
   *  identity-leak (I2). Identity is permitted only once a match is at
   *  ready_to_talk (both opted in) or is an archived record. */
  matchesView(res: McpResult, where: string): void {
    this.sweep(res.raw, where);
    const entries: any[] = res.result?.matches ?? [];
    for (const e of entries) {
      const v = this.ladder.observe(e.match_id, e.next, `${where} entry ${e.match_id}`);
      if (v) this.add([v]);
      const identityAllowed = e.next === 'ready_to_talk' || e.state === 'archived';
      if (!identityAllowed) {
        this.add(scanIdentityLeak(JSON.stringify(e), this.identityStrings, `${where} entry ${e.match_id}`));
      }
    }
  }

  /** A single-match view whose stage is known NOT to have both opt-ins. */
  preOptinView(res: McpResult, where: string): void {
    this.sweep(res.raw, where);
    this.add(scanIdentityLeak(res.raw, this.identityStrings, where));
  }

  decline(raw: string, where: string): void {
    this.sweep(raw, where);
    this.add(scanDeclineReasonless(raw, where));
  }

  archivedEntry(entry: any, where: string): void {
    this.add(scanArchivedEntry(entry, where));
  }

  tools(names: string[], where: string): void {
    this.add(scanToolsForAccept(names, where));
  }
}
