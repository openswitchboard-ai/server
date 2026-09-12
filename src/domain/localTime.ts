/**
 * Local time for a human whose switchboard runs on UTC.
 *
 * The switchboard stores and computes in UTC and always will. What changes
 * here is what a person's agent is handed: with the account's IANA zone known,
 * a timestamp can be said the way the person would say it, and "today" can
 * mean their today. Everything degrades to the old UTC behaviour when the zone
 * is unknown, so nothing here is ever load-bearing for correctness.
 */

/** True for a name Node's ICU knows ('Australia/Sydney'), false otherwise. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length < 3 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallClock(at: Date, tz: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Minutes the zone's wall clock is ahead of UTC at `at` (AEST = 600). */
export function offsetMinutes(at: Date, tz: string): number {
  const w = wallClock(at, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/**
 * The last second of the human's current day: 23:59:59 on the wall clock of
 * `tz`, as a UTC instant. Resolved twice so a zone that changes offset that
 * evening still lands on the right second.
 */
export function endOfLocalDay(now: Date, tz: string): Date {
  const w = wallClock(now, tz);
  const wall = Date.UTC(w.y, w.m - 1, w.d, 23, 59, 59);
  const first = new Date(wall - offsetMinutes(now, tz) * 60000);
  return new Date(wall - offsetMinutes(first, tz) * 60000);
}

/** "Sat 12 Sep, 15:58 AEST" — a timestamp as the human would say it. */
export function localTimeText(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  })
    .format(at)
    .replace(/^(\w{3}),\s/, '$1 ')
    .replace('Sept', 'Sep');
}

/**
 * The sentence that rides the sweep when the zone is known. Written so the
 * agent has the local clock in front of it before it does any sum.
 */
export function clockNote(now: Date, tz: string): string {
  return `Your human's clock reads ${localTimeText(now, tz)} (${tz}). Every timestamp the switchboard hands you is UTC; say times to them in their own zone, and do any sum about days in that zone too.`;
}
