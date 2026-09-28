/**
 * The sweep that must not sweep (src/safety/photoQuarantine.ts).
 *
 * A photo refused for sexual content is held rather than deleted, because
 * Rekognition cannot tell an adult from a child and s 474.25 of the Criminal
 * Code (Cth) says what a host becomes aware of must be referred to the AFP.
 * The whole point is undone by a cron that deletes it ninety days later, so
 * what is asserted here is mostly what the sweep REFUSES to touch:
 *
 *  - `cleared` past expiry is deleted, as it always was.
 *  - A `held` row past its ninety days is deleted too (founder decision,
 *    28 September 2026), UNLESS it is a known-image match, a report or a
 *    safety flag names its introduction or its sender, or a lawful hold is on
 *    it. Those are OVERDUE, not due: counted, said out loud, left for a person.
 *  - A `referred` row is never swept at any age. The AFP have been told it
 *    exists; it has to still exist.
 *  - The predicate the database runs and the predicate the suite states are
 *    the same predicate.
 *  - Where a held object goes, and that the key carries the introduction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { s3 } from '../../../src/aws.js';
import * as db from '../../../src/db.js';
import {
  QUARANTINE_DUE_SQL,
  QUARANTINE_KEEP_SQL,
  QUARANTINE_OVERDUE_SQL,
  QUARANTINE_PREFIX,
  QUARANTINE_SWEEP_PREDICATE,
  QUARANTINE_WINDOW_DAYS,
  isDueForQuarantineSweep,
  isOverdueInQuarantine,
  quarantineKey,
  sweepPhotoQuarantine,
} from '../../../src/safety/photoQuarantine.js';

const now = new Date('2026-09-17T00:00:00Z');
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
const hence = (d: number) => new Date(now.getTime() + d * 86_400_000);

describe('what the sweep may take', () => {
  it('takes a cleared row whose ninety days are behind it', () => {
    expect(isDueForQuarantineSweep({ status: 'cleared', expires_at: ago(1) }, now)).toBe(true);
  });

  it('leaves a cleared row that is still inside its window', () => {
    expect(isDueForQuarantineSweep({ status: 'cleared', expires_at: hence(1) }, now)).toBe(false);
  });

  it('takes a held row at its ninety days when nothing keeps it', () => {
    expect(isDueForQuarantineSweep({ status: 'held', expires_at: ago(1) }, now)).toBe(true);
    expect(isOverdueInQuarantine({ status: 'held', expires_at: ago(1) }, now)).toBe(false);
  });

  it('leaves a held row that is still inside its window, whatever it is', () => {
    expect(isDueForQuarantineSweep({ status: 'held', expires_at: hence(1) }, now)).toBe(false);
    expect(isOverdueInQuarantine({ status: 'held', expires_at: hence(1), hash_match: true }, now)).toBe(false);
  });

  it('keeps a held row past expiry for a person when anything names it', () => {
    const kept: Array<Partial<Parameters<typeof isDueForQuarantineSweep>[0]>> = [
      { hash_match: true },
      { has_report: true },
      { has_safety_flag: true },
      { has_ledger_hold: true },
      { preserved_until: hence(30) },
    ];
    for (const k of kept) {
      const row = { status: 'held', expires_at: ago(400), ...k };
      expect(isDueForQuarantineSweep(row, now), JSON.stringify(k)).toBe(false);
      expect(isOverdueInQuarantine(row, now), JSON.stringify(k)).toBe(true);
    }
  });

  it('a lawful hold that has run out keeps nothing', () => {
    const row = { status: 'held', expires_at: ago(10), preserved_until: ago(1) };
    expect(isDueForQuarantineSweep(row, now)).toBe(true);
  });

  it('NEVER takes a referred row, at any age — it was referred to police', () => {
    expect(isDueForQuarantineSweep({ status: 'referred', expires_at: ago(4000) }, now)).toBe(false);
    expect(isOverdueInQuarantine({ status: 'referred', expires_at: ago(4000) }, now)).toBe(false);
  });

  it('says the same thing in SQL as it says in JavaScript', () => {
    expect(QUARANTINE_SWEEP_PREDICATE).toContain(`q.status = 'cleared'`);
    expect(QUARANTINE_SWEEP_PREDICATE).toContain(`q.status = 'held' AND NOT ${QUARANTINE_KEEP_SQL}`);
    expect(QUARANTINE_SWEEP_PREDICATE).toContain('q.expires_at < now()');
    expect(QUARANTINE_DUE_SQL).toContain(QUARANTINE_SWEEP_PREDICATE);
    // Each thing that keeps a held row, in the SQL as in the JavaScript.
    expect(QUARANTINE_KEEP_SQL).toContain('q.hash_match');
    expect(QUARANTINE_KEEP_SQL).toContain('q.preserved_until >= now()');
    expect(QUARANTINE_KEEP_SQL).toMatch(/FROM reports r[\s\S]*r\.match_id = q\.match_id[\s\S]*r\.reported_account = q\.sender_account/);
    expect(QUARANTINE_KEEP_SQL).toMatch(/FROM safety_reviews s[\s\S]*s\.match_id = q\.match_id[\s\S]*s\.sender_account = q\.sender_account/);
    expect(QUARANTINE_KEEP_SQL).toMatch(/FROM ledger_entries l[\s\S]*l\.preserved_until >= now\(\)/);
    expect(QUARANTINE_OVERDUE_SQL).toContain(`q.status = 'held'`);
    expect(QUARANTINE_OVERDUE_SQL).toContain(QUARANTINE_KEEP_SQL);
    // The one thing that must not be in it, in any form.
    expect(QUARANTINE_DUE_SQL).not.toContain(`'referred'`);
  });

  it('a referred row is never due, even with nothing else keeping it', () => {
    expect(isDueForQuarantineSweep({ status: 'referred', expires_at: ago(4000), hash_match: false }, now)).toBe(false);
  });

  it('holds for the same ninety days a report and a review hold for', () => {
    expect(QUARANTINE_WINDOW_DAYS).toBe(90);
  });
});

describe('where a held object goes', () => {
  it('is the quarantine prefix, the introduction, and the name it arrived under', () => {
    expect(quarantineKey('conversation-photos/dev/ch_1/abc.jpg', 'm-1')).toBe(
      `${QUARANTINE_PREFIX}/m-1/abc.jpg`,
    );
  });

  it('files a press with no introduction behind it somewhere findable', () => {
    expect(quarantineKey('conversation-photos/dev/ch_1/abc.jpg', undefined)).toBe(
      `${QUARANTINE_PREFIX}/unknown/abc.jpg`,
    );
  });
});

describe('the sweep against a stood-in database', () => {
  let deleted: string[];
  let logged: string[];
  let removed: string[];

  const poolWith = (
    due: Array<{ id: string; bucket: string; key: string; status?: string }>,
    overdue: number,
  ) => ({
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT q.id, q.bucket, q.key')) {
        const rows = due.map((r) => ({ status: 'cleared', ...r }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('count(*)')) return { rows: [{ n: overdue }], rowCount: 1 };
      removed.push(String(params[0]));
      return { rows: [], rowCount: 1 };
    },
  });

  beforeEach(() => {
    deleted = [];
    logged = [];
    removed = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => void logged.push(String(l)));
    vi.spyOn(s3, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'DeleteObjectCommand') deleted.push(command.input.Key);
      return {} as any;
    });
  });

  it('deletes the object and the row for what it may take', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(
      poolWith([{ id: 'q-1', bucket: 'b', key: 'conversation-photos/quarantine/m/x.jpg' }], 0) as any,
    );
    const r = await sweepPhotoQuarantine();
    expect(r).toEqual({ items: 1, expired: 0, overdue: 0 });
    expect(deleted).toEqual(['conversation-photos/quarantine/m/x.jpg']);
    expect(removed).toEqual(['q-1']);
    expect(logged.join('\n')).toContain('photo-quarantine-swept');
  });

  it('deletes a held row that nothing keeps, object first, and counts it as expired', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(
      poolWith([{ id: 'q-2', bucket: 'b', key: 'conversation-photos/quarantine/m/y.jpg', status: 'held' }], 0) as any,
    );
    const r = await sweepPhotoQuarantine();
    expect(r).toEqual({ items: 1, expired: 1, overdue: 0 });
    expect(deleted).toEqual(['conversation-photos/quarantine/m/y.jpg']);
    expect(removed).toEqual(['q-2']);
  });

  it('keeps the row of a held object that would not delete, so the next tick tries again', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(
      poolWith([{ id: 'q-3', bucket: 'b', key: 'k', status: 'held' }], 0) as any,
    );
    vi.spyOn(s3, 'send').mockRejectedValue(new Error('denied'));
    const r = await sweepPhotoQuarantine();
    expect(r).toEqual({ items: 0, expired: 0, overdue: 0 });
    expect(removed).toEqual([]);
  });

  it('says overdue out loud and deletes nothing for it', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(poolWith([], 3) as any);
    const r = await sweepPhotoQuarantine();
    expect(r).toEqual({ items: 0, expired: 0, overdue: 3 });
    expect(deleted).toEqual([]);
    expect(removed).toEqual([]);
    expect(JSON.parse(logged.find((l) => l.includes('overdue'))!)).toEqual({
      event: 'photo-quarantine-overdue',
      count: 3,
    });
  });

  it('says nothing at all on a quiet day', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(poolWith([], 0) as any);
    expect(await sweepPhotoQuarantine()).toEqual({ items: 0, expired: 0, overdue: 0 });
    expect(logged).toEqual([]);
  });
});
