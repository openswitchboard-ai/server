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

  it('passes a door with nothing but the suspension check at it', async () => {
    for (const door of ['offer_words', 'shared_identity'] as const) {
      const v = await runIntake(undefined, item({ door }), { checks: [] });
      expect(v.outcome).toBe('pass');
      expect(v.checks).toEqual([]);
    }
  });

  it('puts the real checks at the doors the design says', () => {
    // The money check joined the posting door when `kind` arrived: the agent's
    // own plain words for the thing are free text somebody typed, and that is
    // exactly where a figure lands by accident.
    //
    // `suspended` stands at EVERY door and it stands FIRST: an account the
    // operator has stopped must not cost the switchboard a category lookup,
    // let alone a model call (docs/trust-and-safety.md, step 6).
    expect(checksForDoor('posting', CHECKS).map((c) => c.name)).toEqual([
      'suspended',
      'denyListPath',
      'modelScreen',
      'moneyFigure',
    ]);
    // The grooming classifier stands LAST at the message door: it is the one
    // check that can only hold, so a message already going back for carrying a
    // figure never costs the model call (docs/trust-and-safety.md, step 7).
    expect(checksForDoor('message', CHECKS).map((c) => c.name)).toEqual([
      'suspended',
      'moneyFigure',
      'messageSafety',
    ]);
    // The metadata gate answers at presign; the two machines that look at the
    // picture answer at the send press. All three stand at the photo door, in
    // that order — and the hash match comes BEFORE the moderation call,
    // because an identification must not depend on an opinion being reached
    // first (checks/photoHashMatch.ts).
    expect(checksForDoor('photo', CHECKS).map((c) => c.name)).toEqual([
      'suspended',
      'photoMetadata',
      'photoHashMatch',
      'photoModeration',
    ]);
    // Every door, with no exception: that is the whole of what "at every door"
    // is worth, and a door added later without it is a door around it.
    for (const door of [
      'posting',
      'amendment',
      'message',
      'photo',
      'offer_words',
      'shared_identity',
      'report',
    ] as const) {
      expect(checksForDoor(door, CHECKS)[0]?.name, door).toBe('suspended');
    }
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
    // The model never ran: the deny list ended it. The suspension check ran
    // first, as it does at every door, and found nothing to say.
    expect(v.checks.map((c) => c.name)).toEqual(['suspended', 'denyListPath']);
  });

  it('passes a posting handed over with no words in it, without a model call', async () => {
    const v = await runIntake(undefined, item({ door: 'posting', fields: { category: 'goods.bicycle.mountain' } }));
    expect(v.outcome).toBe('pass');
    expect(v.checks.map((c) => c.name)).toEqual([
      'suspended',
      'denyListPath',
      'modelScreen',
      'moneyFigure',
    ]);
  });

  it('reads the money check over `kind`, and over nothing else on a posting', async () => {
    const plain = await runIntake(
      undefined,
      item({
        door: 'posting',
        fields: { category: 'goods.bicycle.mountain', kind: 'old push bike' },
      }),
    );
    expect(plain.outcome).toBe('pass');

    // Spelled out is the case the synchronous lint cannot catch: no digits in
    // it at all, and still a price.
    const spelled = await runIntake(
      undefined,
      item({
        door: 'posting',
        fields: { category: 'goods.bicycle.mountain', kind: 'bike, four hundred dollars' },
      }),
    );
    expect(spelled.outcome).toBe('refuse');
    expect(spelled.reason_code).toBe('money-figure-in-words');
  });
});
