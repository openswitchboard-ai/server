/**
 * The stage-1 signal and the `next` action word — the agent boundary after
 * the machine internals came off it. buildSignal and nextAction are pure over
 * a match row (buildSignal validates outbound but touches no DB), so the whole
 * mapping is exercised here without standing up Postgres.
 *
 * Gate: buildSignal carries no score; a fresh signal is show_interest; this
 * side expressing interest becomes awaiting_other_side; stage 2 is
 * details_unlocked; an open channel is ready_to_talk; every signal still
 * passes outbound schema validation (buildSignal asserts it internally).
 */
import { describe, it, expect } from 'vitest';
import { buildSignal, nextAction, type MatchRow } from '../../src/domain/matches.js';
import { validateOutbound } from '../../src/protocol.js';

const WANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HAVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function row(over: Partial<MatchRow> = {}): MatchRow {
  return {
    id: '0d9f2c1e-7b4a-4f7e-9c2d-1a2b3c4d5e6f',
    card_want: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    card_have: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    account_want: WANT,
    account_have: HAVE,
    score: 0.91,
    category: 'goods.bicycle.mountain',
    stage: 1,
    interest_want: false,
    interest_have: false,
    state: 'open',
    channel_id: null,
    opened_at: null,
    ...over,
  };
}

describe('buildSignal: the thin stage-1 payload', () => {
  it('carries no score, and validates outbound without one', async () => {
    const sig = await buildSignal(row(), WANT);
    expect((sig as any).score).toBeUndefined();
    expect(Object.keys(sig).sort()).toEqual([
      'category',
      'counterparty_type',
      'intro_id',
      'kind',
      'schema_version',
    ]);
    // buildSignal asserts outbound internally; prove the shape is conformant.
    expect(validateOutbound('intro.signal', sig).valid).toBe(true);
  });

  it('names the counterparty side in the words the wire uses', async () => {
    // The database keeps WANT/HAVE; what crosses to an agent does not.
    expect((await buildSignal(row(), WANT)).counterparty_type).toBe('offering');
    expect((await buildSignal(row(), HAVE)).counterparty_type).toBe('looking_for');
  });
});

describe('nextAction: a word for what to do now, never a stage number', () => {
  it('a fresh signal is show_interest for either side', () => {
    expect(nextAction(row(), WANT)).toBe('show_interest');
    expect(nextAction(row(), HAVE)).toBe('show_interest');
  });

  it('this side keen but not yet mutual is awaiting_other_side', () => {
    const m = row({ interest_want: true }); // want side expressed interest
    expect(nextAction(m, WANT)).toBe('awaiting_other_side');
    // ...and the other side, who has not, still sees a fresh signal.
    expect(nextAction(m, HAVE)).toBe('show_interest');
  });

  it('stage 2 (mutual interest) is details_unlocked for both', () => {
    const m = row({ stage: 2, interest_want: true, interest_have: true });
    expect(nextAction(m, WANT)).toBe('details_unlocked');
    expect(nextAction(m, HAVE)).toBe('details_unlocked');
  });

  it('both opted in (stage 3) is ready_to_talk before the channel exists', () => {
    const m = row({ stage: 3, interest_want: true, interest_have: true });
    expect(nextAction(m, WANT)).toBe('ready_to_talk');
  });

  it('an open channel (stage 4) is ready_to_talk', () => {
    const m = row({ stage: 4, channel_id: 'ch_x', interest_want: true, interest_have: true });
    expect(nextAction(m, WANT)).toBe('ready_to_talk');
    expect(nextAction(m, HAVE)).toBe('ready_to_talk');
  });
});
