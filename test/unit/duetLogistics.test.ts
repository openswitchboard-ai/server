/**
 * The duet report's one linter allowance, and how narrow it is.
 *
 * The register eval treats any bare HH:MM as a hard leak, because "collection
 * window closes 13:30 UTC" is the machine voice the manual exists to keep out
 * of a human's ear. Two agents that get as far as arranging a pickup have to
 * say when, though, and the 2026-09-05T11-05-10 duet was marked down for
 * "Saturday at 10:00 AM at the Dickson shops car park" — a person arranging to
 * meet a person.
 *
 * So the duet report excuses a clock time that sits in the language of
 * arranging a meeting, and nothing else. This suite holds that line: the
 * machinery's own timestamps still fail, every other leak is untouched, and the
 * excused count is reported rather than swallowed.
 */
import { describe, expect, it } from 'vitest';

import { grade } from '../realism/grader.js';
import { gradeDuet } from '../duet/logistics.js';

describe('the duet report excuses a pickup time', () => {
  it('lets two people agree when to meet', () => {
    const text = 'All set — Saturday at 10:00 AM at the Dickson shops car park, and they collect the bike there.';
    expect(grade(text).pass).toBe(false); // the register eval still fails it
    const d = gradeDuet(text);
    expect(d.pass).toBe(true);
    expect(d.hardCount).toBe(0);
    expect(d.meetingTimesAllowed).toBe(1);
    expect(d.hits.some((h) => h.label === 'clock-time')).toBe(false);
  });

  it('excuses a time trailed by am or pm even with nothing else around it', () => {
    const d = gradeDuet('Does 9:30 am suit?');
    expect(d.meetingTimesAllowed).toBe(1);
    expect(d.pass).toBe(true);
    // "9:30am" closed up is not even a clock time to the grader — its rule needs
    // a word boundary after the minutes — so there is nothing here to excuse.
    expect(grade('Does 9:30am suit?').pass).toBe(true);
    expect(gradeDuet('Does 9:30am suit?').meetingTimesAllowed).toBe(0);
  });

  it('excuses each time in a reply that offers a couple of slots', () => {
    const d = gradeDuet('They can do Saturday morning: either 9:15 or 11:45, whichever suits for the pickup.');
    expect(d.meetingTimesAllowed).toBe(2);
    expect(d.pass).toBe(true);
  });
});

describe('and excuses nothing else', () => {
  it('still fails the machinery reading out its own window', () => {
    const text = 'Your collection window closes 13:30 UTC.';
    const d = gradeDuet(text);
    expect(d.pass).toBe(false);
    expect(d.meetingTimesAllowed).toBe(0);
    expect(d.hits.some((h) => h.label === 'clock-time')).toBe(true);
    expect(d.hits.some((h) => h.label === 'utc-gmt')).toBe(true);
  });

  it('leaves every other leak exactly where the grader put it', () => {
    const text =
      'You are at stage 2 with an 84% score on that card — meet them Saturday at 10:00 for the pickup.';
    const g = grade(text);
    const d = gradeDuet(text);
    expect(d.meetingTimesAllowed).toBe(1);
    expect(d.pass).toBe(false);
    // Exactly one hit fewer, and it is the clock time.
    expect(d.hits.length).toBe(g.hits.length - 1);
    for (const label of ['stage', 'stage-number', 'percent-sign', 'score', 'card']) {
      expect(d.hits.some((h) => h.label === label), label).toBe(true);
    }
  });

  it('is a no-op on a reply with no time in it at all', () => {
    const text = 'Someone nearby has a bike going that could be what you are after.';
    const g = grade(text);
    const d = gradeDuet(text);
    expect(d.meetingTimesAllowed).toBe(0);
    expect(d.hits).toEqual(g.hits);
    expect(d.pass).toBe(g.pass);
  });
});
