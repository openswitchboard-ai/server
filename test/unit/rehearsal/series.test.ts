/**
 * The streak is the suite's exit code, so it is tested rather than trusted.
 */
import { describe, expect, it } from 'vitest';
import { bandFor, CRITICAL_FAIL_AT, MAX_UNCERTAIN_TURN_SHARE, OTHER_FAIL_AT, streakMeaning } from '../../rehearsal/levels.js';
import { judgeRun, judgeSeries, passRates, type RunSummary } from '../../rehearsal/series.js';
import { castForRun, parseCast, parseCasts } from '../../rehearsal/drivers/index.js';

const clean = (run: number, cast: string): RunSummary => ({
  run,
  cast,
  deterministicClean: true,
  failedTurns: 0,
  uncertainTurns: 0,
  scoredTurns: 20,
  overruled: false,
  cutShort: false,
});

describe('the bar', () => {
  it('holds a critical rule to a coin flip and the rest to the rubric band', () => {
    expect(bandFor('invented_figure', CRITICAL_FAIL_AT)).toBe('fail');
    expect(bandFor('invented_figure', 0.49)).toBe('uncertain');
    expect(bandFor('queue_claim', OTHER_FAIL_AT)).toBe('uncertain');
    expect(bandFor('queue_claim', 0.71)).toBe('fail');
    expect(bandFor('queue_claim', 0.1)).toBe('no');
    expect(bandFor('queue_claim', null)).toBeNull();
  });

  it('says what a streak does and does not show', () => {
    expect(streakMeaning(5)).toContain('does not establish');
    expect(streakMeaning(10)).toContain('74%');
  });
});

describe('judging one run', () => {
  it('passes a clean one', () => {
    expect(judgeRun(clean(1, 'nagatha,bilby')).clean).toBe(true);
  });

  it('fails on a deterministic check, a failed turn, or too much doubt', () => {
    expect(judgeRun({ ...clean(1, 'x'), deterministicClean: false }).clean).toBe(false);
    expect(judgeRun({ ...clean(1, 'x'), failedTurns: 1 }).clean).toBe(false);
    const doubtful = { ...clean(1, 'x'), uncertainTurns: 4, scoredTurns: 20 };
    expect(4 / 20).toBeGreaterThan(MAX_UNCERTAIN_TURN_SHARE);
    expect(judgeRun(doubtful).clean).toBe(false);
    // Exactly at the bar is still clean.
    expect(judgeRun({ ...clean(1, 'x'), uncertainTurns: 3, scoredTurns: 20 }).clean).toBe(true);
  });

  it('never counts an overruled run, and never counts one cut short', () => {
    expect(judgeRun({ ...clean(1, 'x'), overruled: true }).clean).toBe(false);
    expect(judgeRun({ ...clean(1, 'x'), cutShort: true }).clean).toBe(false);
  });
});

describe('judging a series', () => {
  it('needs the streak AND both pairings inside it, whichever way round they sat', () => {
    const runs = [
      clean(1, 'claude,nagatha'),
      clean(2, 'nagatha,claude'),
      clean(3, 'nagatha,bilby'),
      clean(4, 'bilby,nagatha'),
      clean(5, 'claude,nagatha'),
    ];
    const v = judgeSeries(runs, 5);
    expect(v.streak).toBe(5);
    // Three Claude/Nagatha runs and two Nagatha/Bilby runs: the pairing is what
    // counts, not which of the two sold, so this meets the bar.
    expect(v.green).toBe(true);
  });

  it('says what pairing is still wanted when one is missing', () => {
    const runs = [1, 2, 3, 4, 5].map((i) => clean(i, 'nagatha,bilby'));
    const v = judgeSeries(runs, 5);
    expect(v.green).toBe(false);
    expect(v.missing.join(' ')).toContain('claude');
  });

  it('resets on an unclean run however many came before it', () => {
    const runs = [clean(1, 'a'), clean(2, 'a'), { ...clean(3, 'a'), failedTurns: 1 }];
    expect(judgeSeries(runs, 3).streak).toBe(0);
  });

  it('counts only the tail', () => {
    const runs = [{ ...clean(1, 'a'), failedTurns: 1 }, clean(2, 'a'), clean(3, 'a')];
    expect(judgeSeries(runs, 2).streak).toBe(2);
  });
});

describe('pass rates', () => {
  it('never counts a skipped check as a pass', () => {
    const rates = passRates([
      { checks: [{ id: 'S1.a', verdict: 'pass' }, { id: 'S1.b', verdict: 'skip' }] },
      { checks: [{ id: 'S1.a', verdict: 'fail' }] },
    ]);
    expect(rates.find((r) => r.id === 'S1.a')).toMatchObject({ passed: 1, seen: 2 });
    expect(rates.find((r) => r.id === 'S1.b')).toBeUndefined();
  });
});

describe('the cast', () => {
  it('alternates the sides run over run', () => {
    const cast = parseCast('nagatha,bilby');
    expect(castForRun(cast, 1)).toEqual({ seller: 'nagatha', buyer: 'bilby' });
    expect(castForRun(cast, 2)).toEqual({ seller: 'bilby', buyer: 'nagatha' });
  });

  it('cycles several pairings, and swaps the sides when one comes round again', () => {
    const casts = parseCasts('nagatha,bilby;claude,nagatha');
    expect(castForRun(casts, 1)).toEqual({ seller: 'nagatha', buyer: 'bilby' });
    expect(castForRun(casts, 2)).toEqual({ seller: 'claude', buyer: 'nagatha' });
    expect(castForRun(casts, 3)).toEqual({ seller: 'bilby', buyer: 'nagatha' });
    expect(castForRun(casts, 4)).toEqual({ seller: 'nagatha', buyer: 'claude' });
  });

  it('refuses one assistant on both sides, and a name it does not know', () => {
    expect(() => parseCast('nagatha,nagatha')).toThrow(/both sides/);
    expect(() => parseCast('nagatha,gerald')).toThrow(/gerald/);
    expect(() => parseCast('nagatha')).toThrow(/two clients/);
  });
});

describe('a run the harness broke', () => {
  it('neither extends the streak nor resets it', () => {
    // An ssh call died mid-turn and took a clean streak with it. That says
    // nothing about the assistants, so the run is void: skipped, and reported.
    const broken: RunSummary = { ...clean(2, 'nagatha,bilby'), cutShort: true, voided: true };
    const v = judgeSeries([clean(1, 'nagatha,bilby'), broken, clean(3, 'nagatha,bilby')], 2);
    expect(v.streak).toBe(2);
  });

  it('still resets on a run that failed a check', () => {
    const failed: RunSummary = { ...clean(2, 'nagatha,bilby'), deterministicClean: false, cutShort: true };
    const v = judgeSeries([clean(1, 'nagatha,bilby'), failed, clean(3, 'nagatha,bilby')], 2);
    expect(v.streak).toBe(1);
  });
});
