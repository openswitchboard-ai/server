/**
 * The stage-1 signal and the `next` action word — the agent boundary after
 * the machine internals came off it. buildSignal and nextAction are pure over
 * a match row (buildSignal validates outbound but touches no DB), so the whole
 * mapping is exercised here without standing up Postgres.
 *
 * Gate: buildSignal carries no score; a NEW introduction is details_unlocked
 * on both sides at once (the posting is the statement of interest, 13
 * September 2026); an open channel is ready_to_talk; every signal still passes
 * outbound schema validation (buildSignal asserts it internally). The two
 * retired words are still derivable for a row made before that change and
 * never moved up, which is the last case below.
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
    // How every introduction is born: both sides keen, details open.
    stage: 2,
    interest_want: true,
    interest_have: true,
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
  it('a new introduction is details_unlocked for both sides at once', () => {
    expect(nextAction(row(), WANT)).toBe('details_unlocked');
    expect(nextAction(row(), HAVE)).toBe('details_unlocked');
  });

  it('the go-ahead this side has already given is awaiting_their_go_ahead', () => {
    expect(nextAction(row({ my_optin: true }), WANT)).toBe('awaiting_their_go_ahead');
    expect(nextAction(row({ my_optin: true }), HAVE)).toBe('awaiting_their_go_ahead');
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

  // Unreachable for anything made since 13 September 2026 — the matcher writes
  // stage 2 with both columns true, and migration 031 moved every open row up
  // — and still honest for a row that somehow is not.
  it('keeps the two retired words for a row that predates the change', () => {
    const fresh = row({ stage: 1, interest_want: false, interest_have: false });
    expect(nextAction(fresh, WANT)).toBe('show_interest');
    const oneSide = row({ stage: 1, interest_want: true, interest_have: false });
    expect(nextAction(oneSide, WANT)).toBe('awaiting_other_side');
    expect(nextAction(oneSide, HAVE)).toBe('show_interest');
  });
});
