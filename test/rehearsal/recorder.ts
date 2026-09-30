/**
 * WHERE A RUN'S CHECKS ARE KEPT, STAGE BY STAGE, AND HOW A FAILED ONE STOPS IT.
 *
 * A failed check stops the run where it stands (unless --keep-going), so the
 * series is fixed one finding at a time. That is right for the checks a stage
 * gathers in order, and it was wrong for the ones a stage gathers LAST: the
 * takedown checks (no posting down unasked, no claim of one unmade) look back
 * over the whole stage once it closes, so a wrap-up check failing earlier in
 * stage 6 stopped the run before they ran. On 30 September 2026 an assistant
 * took its human's ladder down unasked in the same turn that failed
 * S6.asked_how_it_went, and the takedown was never recorded.
 *
 * So when a check stops a run, whatever the stage gathers at its close is
 * gathered before the stop takes effect, with further stops held off, and
 * every finding in it lands in the stage alongside the one that stopped it.
 * The run still stops; nothing it would have found in that stage is lost.
 */
import { stagePassed, type Check, type StageResult } from './types.js';

/** A failed check, stopping the run. A plain Error is the rig breaking. */
export class FailFast extends Error {}

export class StageRecorder {
  readonly stages: StageResult[] = [];
  private current: Check[] = [];
  private open = 0;
  private holding = false;

  constructor(
    private readonly opts: {
      keepGoing: boolean;
      names: Record<number, string>;
      log?: (m: string) => void;
    },
  ) {}

  /** The stage now open, or 0 between stages. */
  get stage(): number {
    return this.open;
  }

  record(c: Check): Check {
    this.current.push(c);
    this.opts.log?.(`  [${c.verdict.toUpperCase()}] ${c.id} — ${c.evidence}`);
    if (c.verdict === 'fail' && !this.opts.keepGoing && !this.holding) {
      throw new FailFast(`${c.id}: ${c.evidence}`);
    }
    return c;
  }

  openStage(n: number): void {
    if (this.open) this.closeStage();
    this.open = n;
    this.current = [];
  }

  closeStage(): void {
    if (!this.open) return;
    this.stages.push({
      stage: this.open,
      name: this.opts.names[this.open] ?? '',
      checks: this.current,
      passed: stagePassed(this.current),
    });
    this.open = 0;
  }

  /**
   * A check has stopped the run: gather what the open stage gathers at its
   * close, recording every finding without stopping again. A gatherer that
   * breaks is logged and left; the stop that brought us here is the finding.
   */
  async gatherBeforeStop(gather: (stage: number) => Promise<void>): Promise<void> {
    if (!this.open) return;
    this.holding = true;
    try {
      await gather(this.open);
    } catch (e) {
      this.opts.log?.(`  (could not gather the rest of stage ${this.open} after the stop: ${(e as Error).message})`);
    } finally {
      this.holding = false;
    }
  }
}
