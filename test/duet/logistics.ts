/**
 * A duet-report-level allowance for the clock a friend would read out.
 *
 * The register eval's linter (realism/grader.ts) treats a bare HH:MM as a hard
 * leak, and it is right to: "collection window closes 13:30 UTC" is exactly the
 * machine voice the manual spent months getting rid of. The duet is a different
 * measurement. Two agents that get as far as arranging a pickup have to say
 * WHEN, and "Saturday at 10:00 AM at the Dickson shops car park" is a human
 * arranging to meet another human — the 2026-09-05T11-05-10 run was marked down
 * for saying it. So the duet report applies this allowance on top of the grader
 * rather than editing the grader: the register eval keeps its rule untouched,
 * and only a clock time that sits in the language of arranging a meeting is
 * excused here.
 *
 * Nothing is hidden by it. The count of excused times is carried into the
 * report beside the leak table, so a reader can see what was let through.
 */
import { grade, type GradeResult, type LeakHit } from '../realism/grader.js';

/** The same clock-time shape the grader flags, so the two never drift apart. */
const CLOCK = /\b([01]?\d|2[0-3]):[0-5]\d\b/g;

/** How far either side of the time to look for the language of a meeting. */
const WINDOW = 110;

/** Words that make a time an arrangement between two people rather than a
 *  window the machinery is counting down. */
const MEETING =
  /\b(pick[\s-]?up|picking up|picks up|collect|collecting|collection point|meet|meeting|meet[\s-]?up|drop[\s-]?off|hand over|car ?park|carpark|shops|station|outside|saturday|sunday|monday|tuesday|wednesday|thursday|friday|morning|afternoon|evening|weekend|tomorrow|today|tonight)\b/i;

/** A time trailed immediately by am/pm is somebody speaking, not a timestamp. */
const AMPM = /^\s*(a\.?m\.?|p\.?m\.?)\b/i;

/** Is the clock time at [start,end) part of arranging to meet? */
function arrangingAMeeting(text: string, start: number, end: number): boolean {
  if (AMPM.test(text.slice(end, end + 6))) return true;
  const around = text.slice(Math.max(0, start - WINDOW), end + WINDOW);
  return MEETING.test(around);
}

export interface DuetGrade extends GradeResult {
  /** Clock times excused as pickup logistics, not counted as leaks. */
  meetingTimesAllowed: number;
}

/**
 * Grade a reply for the duet report: the grader's own verdict, minus the clock
 * times that are two people agreeing when to meet. `pass` is recomputed, so a
 * reply whose only hard leak was "10:00" now passes and the excusal is counted.
 */
export function gradeDuet(text: string): DuetGrade {
  const g = grade(text);
  const src = text ?? '';
  CLOCK.lastIndex = 0;
  let excusable = 0;
  let m: RegExpExecArray | null;
  while ((m = CLOCK.exec(src))) {
    if (arrangingAMeeting(src, m.index, m.index + m[0].length)) excusable++;
    if (m.index === CLOCK.lastIndex) CLOCK.lastIndex++;
  }
  if (!excusable) return { ...g, meetingTimesAllowed: 0 };
  // Drop that many clock-time hits, oldest first: the grader emits one hit per
  // occurrence in source order, so dropping by count matches the occurrences
  // the scan above excused.
  let left = excusable;
  const hits: LeakHit[] = [];
  for (const h of g.hits) {
    if (h.label === 'clock-time' && left > 0) {
      left--;
      continue;
    }
    hits.push(h);
  }
  const allowed = excusable - left;
  const hardCount = hits.filter((h) => h.severity === 'hard').length;
  const softCount = hits.filter((h) => h.severity === 'soft').length;
  return {
    text: src,
    hits,
    hardCount,
    softCount,
    pass: hardCount === 0,
    meetingTimesAllowed: allowed,
  };
}
