/**
 * WHO IS WITH A POSTING AND WHO IS IN ITS OWN LINE: PEOPLE, NOT INTRODUCTIONS
 * (domain/sequencer.ts lineCounts; rehearsal, 24 October 2026).
 *
 * A buyer's assistant was told "One more person is in line for this" when the
 * row in line was the same seller's second item on a list. The count is of
 * distinct other accounts now, and only of rows in this posting's own line:
 * a row that is not live while this posting has room is waiting on the other
 * side's full posting, where the caller is the one waiting.
 */
import { describe, expect, it } from 'vitest';
import { lineCounts, type OwnLineRow } from '../../src/domain/sequencer.js';

const ME = 'my-posting';
const row = (over: Partial<OwnLineRow>): OwnLineRow => ({
  cid: ME,
  live: false,
  other: 'someone',
  slots: 1,
  gather_open: false,
  ...over,
});
const at = (rows: OwnLineRow[]) => lineCounts(rows).get(ME) ?? { here: 0, waiting: 0 };

describe('people, not introductions', () => {
  it('counts two introductions from one seller’s list as one person waiting', () => {
    expect(
      at([row({ live: true, other: 'talking-to' }), row({ other: 'lister' }), row({ other: 'lister' })]),
    ).toEqual({ here: 1, waiting: 1 });
  });

  it('never counts the person already live as waiting behind themselves', () => {
    // The rehearsal's case: the live seller's other list item in line on the buyer's want.
    expect(at([row({ live: true, other: 'seller' }), row({ other: 'seller' })])).toEqual({ here: 1, waiting: 0 });
  });

  it('counts two live introductions from one person as one person here', () => {
    expect(at([row({ live: true, other: 'a', slots: 2 }), row({ live: true, other: 'a', slots: 2 })])).toEqual({
      here: 1,
      waiting: 0,
    });
  });
});

describe('only this posting’s own line', () => {
  it('does not count a row held by the other side’s full posting', () => {
    // A slot free here, so the row is not waiting on this posting at all.
    expect(at([row({ other: 'busy-seller' })])).toEqual({ here: 0, waiting: 0 });
    expect(
      at([row({ live: true, other: 'a', slots: 2 }), row({ other: 'busy', slots: 2 })]),
    ).toEqual({ here: 1, waiting: 0 });
  });

  it('counts nobody as waiting while a gathering window is open', () => {
    expect(at([row({ live: true, other: 'a', gather_open: true }), row({ other: 'b', gather_open: true })])).toEqual({
      here: 1,
      waiting: 0,
    });
  });
});

describe('ordinary single postings, unchanged', () => {
  it('one live, three different people behind, one slot: one here, three waiting', () => {
    expect(
      at([row({ live: true, other: 'a' }), row({ other: 'b' }), row({ other: 'c' }), row({ other: 'd' })]),
    ).toEqual({ here: 1, waiting: 3 });
  });

  it('keeps postings apart, and says nothing of one with nobody on it', () => {
    const m = lineCounts([
      row({ live: true, other: 'a' }),
      row({ other: 'b' }),
      row({ cid: 'other-posting', live: true, other: 'c' }),
    ]);
    expect(m.get(ME)).toEqual({ here: 1, waiting: 1 });
    expect(m.get('other-posting')).toEqual({ here: 1, waiting: 0 });
    expect(m.get('nobody')).toBeUndefined();
  });
});
