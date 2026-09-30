/**
 * A failed check stops the run, and the stage it stopped in still gathers
 * what it gathers at its close (test/rehearsal/recorder.ts). The case that
 * bought it: a wrap-up check failed in stage 6 and the unasked takedown in the
 * same turn was never recorded.
 */
import { describe, expect, it } from 'vitest';
import { FailFast, StageRecorder } from '../../rehearsal/recorder.js';
import { fail, pass } from '../../rehearsal/types.js';

describe('a stop still gathers the stage it happened in', () => {
  it('records the takedown check after a wrap-up check stops the run', async () => {
    const rec = new StageRecorder({ keepGoing: false, names: { 6: 'wrapping up' } });
    rec.openStage(6);
    let stopped: unknown;
    try {
      rec.record(fail('S6.asked_how_it_went.buyer', 'asked how it went', 'never asked'));
    } catch (e) {
      stopped = e;
    }
    expect(stopped).toBeInstanceOf(FailFast);

    await rec.gatherBeforeStop(async (stage) => {
      expect(stage).toBe(6);
      // A second fail while gathering is recorded, not thrown.
      rec.record(fail(`S${stage}.no_unasked_takedown.buyer`, 'no takedown unasked', 'took it down unasked'));
      rec.record(pass(`S${stage}.takedown_claim_backed.buyer`, 'no claim unmade', 'none'));
    });
    rec.closeStage();

    expect(rec.stages).toHaveLength(1);
    expect(rec.stages[0].checks.map((c) => c.id)).toEqual([
      'S6.asked_how_it_went.buyer',
      'S6.no_unasked_takedown.buyer',
      'S6.takedown_claim_backed.buyer',
    ]);
    expect(rec.stages[0].passed).toBe(false);
  });

  it('stops again as usual once the gathering is done', async () => {
    const rec = new StageRecorder({ keepGoing: false, names: {} });
    rec.openStage(1);
    await rec.gatherBeforeStop(async () => {
      rec.record(fail('S1.a', 'a', 'no'));
    });
    expect(() => rec.record(fail('S1.b', 'b', 'no'))).toThrow(FailFast);
  });

  it('a gatherer that breaks does not hide the stop that brought us there', async () => {
    const rec = new StageRecorder({ keepGoing: false, names: {} });
    rec.openStage(6);
    await expect(
      rec.gatherBeforeStop(async () => {
        throw new Error('database unreachable');
      }),
    ).resolves.toBeUndefined();
  });

  it('gathers nothing between stages', async () => {
    const rec = new StageRecorder({ keepGoing: false, names: {} });
    let called = false;
    await rec.gatherBeforeStop(async () => {
      called = true;
    });
    expect(called).toBe(false);
  });
});
