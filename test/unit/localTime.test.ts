/**
 * Local time for a human on a UTC switchboard.
 *
 * From the 12 September 2026 rehearsal: a have posted at 15:58 Canberra time
 * with a one-day life was called "expired today" by an assistant at ten the
 * next morning, because every timestamp it saw was UTC and it did the sum by
 * date. These hold the pieces that fix it: a zone is validated, a timestamp is
 * said in the human's clock, "today" ends at the end of their day, and the
 * sweep carries the clock and the rule.
 */
import { describe, expect, it } from 'vitest';
import {
  clockNote,
  endOfLocalDay,
  isValidTimeZone,
  localTimeText,
  offsetMinutes,
} from '../../src/domain/localTime.js';
import { MANUAL_CHANGELOG, SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.js';
import { lintEmailCopy } from '../../src/email/lint.js';

const REHEARSAL = new Date('2026-09-12T05:58:46Z'); // 15:58 AEST, the have's expiry

describe('a zone name', () => {
  it('is accepted when ICU knows it and refused otherwise', () => {
    expect(isValidTimeZone('Australia/Sydney')).toBe(true);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone('x'.repeat(65))).toBe(false);
  });
});

describe('a timestamp in the human\'s clock', () => {
  it('says the rehearsal expiry as 15:58 in Canberra, in one short phrase', () => {
    expect(localTimeText(REHEARSAL, 'Australia/Sydney')).toBe('Sat 12 Sep, 15:58 AEST');
  });

  it('knows the offset, daylight saving included', () => {
    expect(offsetMinutes(REHEARSAL, 'Australia/Sydney')).toBe(600);
    expect(offsetMinutes(new Date('2026-01-12T05:00:00Z'), 'Australia/Sydney')).toBe(660);
    expect(offsetMinutes(REHEARSAL, 'UTC')).toBe(0);
  });
});

describe('"today" ends at the end of the human\'s day', () => {
  it('runs to 23:59:59 Canberra time on the day it was posted', () => {
    const posted = new Date('2026-09-11T05:58:46Z'); // 15:58 on 11 Sep in Canberra
    const ends = endOfLocalDay(posted, 'Australia/Sydney');
    // 23:59:59 on 11 Sep AEST is 13:59:59Z the same day: eight hours, never 24.
    expect(ends.toISOString()).toBe('2026-09-11T13:59:59.000Z');
  });

  it('rolls the date the way the zone does, either side of midnight UTC', () => {
    // 01:00Z on 12 Sep is already 11:00 on 12 Sep in Canberra.
    expect(endOfLocalDay(new Date('2026-09-12T01:00:00Z'), 'Australia/Sydney').toISOString()).toBe(
      '2026-09-12T13:59:59.000Z',
    );
    // 23:30Z on 11 Sep is already 00:30 on 12 Sep in London (BST), so the
    // day that ends is the 12th, at 22:59:59Z.
    expect(endOfLocalDay(new Date('2026-09-11T23:30:00Z'), 'Europe/London').toISOString()).toBe(
      '2026-09-12T22:59:59.000Z',
    );
    // In winter London sits on UTC and the same instant is still the 11th.
    expect(endOfLocalDay(new Date('2026-01-11T23:30:00Z'), 'Europe/London').toISOString()).toBe(
      '2026-01-11T23:59:59.000Z',
    );
  });

  it('lands on the right second across a daylight-saving switch', () => {
    // Sydney springs forward on 4 Oct 2026 at 02:00 → the day is 23 hours long.
    const morning = new Date('2026-10-03T20:00:00Z'); // 06:00 on 4 Oct AEST
    expect(endOfLocalDay(morning, 'Australia/Sydney').toISOString()).toBe('2026-10-04T12:59:59.000Z');
  });
});

describe('what the sweep says', () => {
  it('reads the clock, names the zone, and says times are theirs', () => {
    const note = clockNote(REHEARSAL, 'Australia/Sydney');
    expect(note).toContain('Sat 12 Sep, 15:58 AEST (Australia/Sydney)');
    expect(note).toMatch(/UTC/);
    expect(note).toMatch(/their own zone/);
    expect(lintEmailCopy(note)).toEqual([]);
  });

  it('the manual carries the rule and the version note', () => {
    expect(SERVER_INSTRUCTIONS).toContain('Times are theirs.');
    expect(SERVER_INSTRUCTIONS).toContain('local_time_now');
    expect(SERVER_INSTRUCTIONS).toContain('expires_local');
    const v28 = MANUAL_CHANGELOG.find((c) => c.version === 28);
    expect(v28?.note).toMatch(/never call something expired from the date alone/);
  });
});
