/**
 * The pipe itself: door filtering, how the checks fold into one verdict, and
 * the one rule that matters most — a check that could not answer is a HOLD and
 * never a pass. "Looked and found nothing" and "could not look" are different
 * answers, and a pipe that confused them would quietly publish the thing the
 * screen was there to catch.
 */
import { describe, expect, it } from 'vitest';
import { runIntake, checksForDoor, decidingCheck, CHECKS } from '../../src/intake/pipe.js';
import type { Check, IntakeItem } from '../../src/intake/types.js';

const item = (over: Partial<IntakeItem> = {}): IntakeItem => ({
  door: 'message',
  sender_account: 'acct-1',
  ...over,
});

const stub = (
  name: string,
  outcome: 'pass' | 'hold' | 'refuse',
  extra: Record<string, unknown> = {},
  doors: IntakeItem['door'][] = ['message'],
): Check => ({
  name,
  doors,
  async run() {
    return { name, outcome, ...extra };
  },
});

const thrower = (name: string, doors: IntakeItem['door'][] = ['message']): Check => ({
  name,
  doors,
  async run() {
    throw new Error('the model was unreachable');
  },
});

describe('the pipe folds checks into one verdict', () => {
  it('passes when every check at the door passed', async () => {
    const v = await runIntake(undefined, item(), {
      checks: [stub('a', 'pass'), stub('b', 'pass')],
    });
    expect(v.outcome).toBe('pass');
    expect(v.reason_code).toBeUndefined();
    expect(v.checks.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('refuses with the first refusing check, and runs nothing after it', async () => {
    const v = await runIntake(undefined, item(), {
      checks: [
        stub('a', 'refuse', { reason_code: 'first', plain_words: 'the first sentence' }),
        stub('b', 'refuse', { reason_code: 'second', plain_words: 'the second sentence' }),
      ],
    });
    expect(v.outcome).toBe('refuse');
    expect(v.reason_code).toBe('first');
    expect(v.plain_words).toBe('the first sentence');
    expect(v.checks).toHaveLength(1);
  });

  it('holds when nothing refused but something held', async () => {
    const v = await runIntake(undefined, item(), {
      checks: [stub('a', 'pass'), stub('b', 'hold', { reason_code: 'needs-a-look' }), stub('c', 'pass')],
    });
    expect(v.outcome).toBe('hold');
    expect(v.reason_code).toBe('needs-a-look');
    // A hold does not end the run: the later checks still have their say.
    expect(v.checks.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('lets a refusal beat a hold no matter which came first', async () => {
    const v = await runIntake(undefined, item(), {
      checks: [stub('a', 'hold'), stub('b', 'refuse', { reason_code: 'no' })],
    });
    expect(v.outcome).toBe('refuse');
    expect(v.reason_code).toBe('no');
  });
});

describe('a check that throws is a hold, never a pass', () => {
  it('holds, keeps the error, and says which check it was', async () => {
    const v = await runIntake(undefined, item(), { checks: [thrower('modelish'), stub('b', 'pass')] });
    expect(v.outcome).toBe('hold');
    expect(v.reason_code).toBe('check-failed');
    const deciding = decidingCheck(v)!;
    expect(deciding.name).toBe('modelish');
    expect(deciding.detail).toBe('the model was unreachable');
    expect((deciding.error as Error).message).toBe('the model was unreachable');
  });

  it('does not let a later pass turn it back into a pass', async () => {
    const v = await runIntake(undefined, item(), { checks: [stub('a', 'pass'), thrower('b')] });
    expect(v.outcome).toBe('hold');
  });
});

describe('only the checks that stand at this door run', () => {
  it('skips a check whose doors do not include this one', async () => {
    const v = await runIntake(undefined, item({ door: 'photo' }), {
      checks: [
        stub('messageOnly', 'refuse', { reason_code: 'wrong-door' }, ['message']),
        stub('photoOnly', 'pass', {}, ['photo']),
      ],
    });
    expect(v.outcome).toBe('pass');
    expect(v.checks.map((c) => c.name)).toEqual(['photoOnly']);
  });

  it('passes a door nothing stands at yet', async () => {
    for (const door of ['offer_words', 'shared_identity'] as const) {
      const v = await runIntake(undefined, item({ door }));
      expect(v.outcome).toBe('pass');
      expect(v.checks).toEqual([]);
    }
  });

  it('puts the real checks at the doors the design says', () => {
    expect(checksForDoor('posting', CHECKS).map((c) => c.name)).toEqual([
      'denyListPath',
      'modelScreen',
    ]);
    expect(checksForDoor('message', CHECKS).map((c) => c.name)).toEqual(['moneyFigure']);
    // The metadata gate answers at presign; the look at the picture answers at
    // the send press. Both stand at the photo door, in that order.
    expect(checksForDoor('photo', CHECKS).map((c) => c.name)).toEqual([
      'photoMetadata',
      'photoModeration',
    ]);
  });
});

describe('the ledger hook', () => {
  it('sees every verdict, and cannot change one', async () => {
    const seen: string[] = [];
    const v = await runIntake(undefined, item(), {
      checks: [stub('a', 'refuse', { reason_code: 'r' })],
      ledger: {
        recordVerdict(i, verdict) {
          seen.push(`${i.door}:${verdict.outcome}`);
        },
      },
    });
    expect(seen).toEqual(['message:refuse']);
    expect(v.outcome).toBe('refuse');
  });

  it('a ledger that fails leaves the verdict standing', async () => {
    const v = await runIntake(undefined, item(), {
      checks: [stub('a', 'pass')],
      ledger: {
        recordVerdict() {
          throw new Error('no ledger yet');
        },
      },
    });
    expect(v.outcome).toBe('pass');
  });
});

describe('the moved checks decide what they always decided', () => {
  it('refuses a message carrying a figure, with the sentence the agent has always read', async () => {
    const { FIGURE_IN_WORDS_ACTION } = await import('../../src/domain/moneyInWords.js');
    const v = await runIntake(undefined, item({ text: 'I could go to 450 if you deliver' }));
    expect(v.outcome).toBe('refuse');
    expect(v.reason_code).toBe('money-figure-in-words');
    expect(v.plain_words).toBe(FIGURE_IN_WORDS_ACTION);
  });

  it('lets plain words through', async () => {
    const v = await runIntake(undefined, item({ text: 'I can collect Saturday morning if that helps' }));
    expect(v.outcome).toBe('pass');
  });

  it('refuses a photo whose page did not say it cleaned the file', async () => {
    const { METADATA_NOT_REMOVED } = await import('../../src/intake/checks/photoMetadata.js');
    const v = await runIntake(undefined, item({ door: 'photo', fields: { metadata_removed: 'false' } }));
    expect(v.outcome).toBe('refuse');
    expect(v.plain_words).toBe(METADATA_NOT_REMOVED);
    const ok = await runIntake(undefined, item({ door: 'photo', fields: { metadata_removed: 'true' } }));
    expect(ok.outcome).toBe('pass');
  });

  it('refuses a posting on a denied category without a model call', async () => {
    const v = await runIntake(undefined, item({ door: 'posting', fields: { category: 'goods.weapons.knives' } }));
    expect(v.outcome).toBe('refuse');
    expect(v.reason_code).toBe('weapons');
    // The model never ran: the deny list ended it.
    expect(v.checks.map((c) => c.name)).toEqual(['denyListPath']);
  });

  it('passes a posting handed over with no words in it, without a model call', async () => {
    const v = await runIntake(undefined, item({ door: 'posting', fields: { category: 'goods.bicycle.mountain' } }));
    expect(v.outcome).toBe('pass');
    expect(v.checks.map((c) => c.name)).toEqual(['denyListPath', 'modelScreen']);
  });
});
