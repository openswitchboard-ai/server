/**
 * Reports and safety flags go at twelve months (src/safety/retention.ts;
 * founder decision, 28 September 2026), unless referred to police, under a
 * lawful hold, or belonging to an active suspension.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as db from '../../../src/db.js';
import {
  KEPT_PAST_RETENTION_SQL,
  REPORTS_SWEEP_SQL,
  REPORT_KEEP_SQL,
  REVIEWS_SWEEP_SQL,
  REVIEW_KEEP_SQL,
  SAFETY_RECORD_RETENTION_MONTHS,
  isSafetyRecordDue,
  markReferred,
  preserveSafetyRecord,
  retentionCutoff,
  sweepSafetyRecords,
} from '../../../src/safety/retention.js';

const now = new Date('2027-10-01T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const hence = (d: number) => new Date(now.getTime() + d * 86_400_000);

describe('what the twelve months mean', () => {
  it('is twelve months', () => {
    expect(SAFETY_RECORD_RETENTION_MONTHS).toBe(12);
    expect(retentionCutoff(now).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('leaves a row inside its twelve months', () => {
    expect(isSafetyRecordDue({ created_at: daysAgo(300) }, now)).toBe(false);
  });

  it('takes a row past its twelve months that nothing keeps', () => {
    expect(isSafetyRecordDue({ created_at: daysAgo(400) }, now)).toBe(true);
  });

  it('keeps a row past its twelve months when anything holds it', () => {
    const kept = [
      { referred_at: daysAgo(200) },
      { photo_referred: true },
      { preserved_until: hence(10) },
      { has_ledger_hold: true },
      { active_suspension: true },
    ];
    for (const k of kept) {
      expect(isSafetyRecordDue({ created_at: daysAgo(4000), ...k }, now), JSON.stringify(k)).toBe(false);
    }
  });

  it('a hold that has run out keeps nothing', () => {
    expect(isSafetyRecordDue({ created_at: daysAgo(400), preserved_until: daysAgo(1) }, now)).toBe(true);
  });
});

describe('the SQL says the same thing', () => {
  it('deletes by age and never what is kept, in batches', () => {
    expect(REPORTS_SWEEP_SQL).toContain(`r.created_at < now() - interval '12 months'`);
    expect(REPORTS_SWEEP_SQL).toContain(`NOT ${REPORT_KEEP_SQL}`);
    expect(REVIEWS_SWEEP_SQL).toContain(`s.created_at < now() - interval '12 months'`);
    expect(REVIEWS_SWEEP_SQL).toContain(`NOT ${REVIEW_KEEP_SQL}`);
    for (const sql of [REPORTS_SWEEP_SQL, REVIEWS_SWEEP_SQL]) expect(sql).toContain('LIMIT 1000');
  });

  it('keeps a referral, a lawful hold and an active suspension, on both tables', () => {
    for (const [keep, a] of [
      [REPORT_KEEP_SQL, 'r'],
      [REVIEW_KEEP_SQL, 's'],
    ] as const) {
      expect(keep).toContain(`${a}.referred_at IS NOT NULL`);
      expect(keep).toContain(`q.status = 'referred'`);
      expect(keep).toContain(`${a}.preserved_until >= now()`);
      expect(keep).toMatch(/FROM ledger_entries l[\s\S]*l\.preserved_until >= now\(\)/);
      expect(keep).toContain('a.suspended_at IS NOT NULL');
    }
    expect(REPORT_KEEP_SQL).toContain('r.reported_account, r.reporter_account');
    expect(REVIEW_KEEP_SQL).toContain('a.id = s.sender_account');
    expect(KEPT_PAST_RETENTION_SQL).toContain(REPORT_KEEP_SQL);
    expect(KEPT_PAST_RETENTION_SQL).toContain(REVIEW_KEEP_SQL);
  });

  it('the migration adds every column the sweep reads', () => {
    const sql = readFileSync(new URL('../../../migrations/059_safety_retention.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/ALTER TABLE photo_quarantine ADD COLUMN IF NOT EXISTS preserved_until/);
    for (const t of ['reports', 'safety_reviews']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS referred_at`));
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS preserved_until`));
    }
  });
});

describe('the sweep against a stood-in database', () => {
  let asked: string[];
  let logged: string[];
  beforeEach(() => {
    asked = [];
    logged = [];
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation((l: string) => void logged.push(String(l)));
  });

  const poolWith = (reports: number, reviews: number, kept = { reports: 0, reviews: 0 }) => ({
    query: async (sql: string) => {
      asked.push(sql);
      if (sql === REPORTS_SWEEP_SQL) return { rows: [], rowCount: reports };
      if (sql === REVIEWS_SWEEP_SQL) return { rows: [], rowCount: reviews };
      if (sql === KEPT_PAST_RETENTION_SQL) return { rows: [kept], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  });

  it('deletes from both tables and counts what it kept', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(poolWith(2, 3, { reports: 1, reviews: 0 }) as any);
    expect(await sweepSafetyRecords()).toEqual({ reports: 2, reviews: 3, kept_reports: 1, kept_reviews: 0 });
    expect(asked).toEqual([REPORTS_SWEEP_SQL, REVIEWS_SWEEP_SQL, KEPT_PAST_RETENTION_SQL]);
    expect(logged.map((l) => JSON.parse(l))).toEqual([
      { event: 'safety-records-swept', reports: 2, reviews: 3 },
      { event: 'safety-records-kept', reports: 1, reviews: 0 },
    ]);
  });

  it('says nothing on a quiet day', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(poolWith(0, 0) as any);
    expect(await sweepSafetyRecords()).toEqual({ reports: 0, reviews: 0, kept_reports: 0, kept_reviews: 0 });
    expect(logged).toEqual([]);
  });

  it('the two marks move a date or write down a referral, on the named table only', async () => {
    const params: unknown[][] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string, p: unknown[]) => {
        asked.push(sql);
        params.push(p);
        return { rows: [], rowCount: 1 };
      },
    } as any);
    expect(await markReferred('reports', 'r-1')).toBe(true);
    expect(asked[0]).toMatch(/^UPDATE reports SET referred_at = now\(\)/);
    const until = hence(365);
    expect(await preserveSafetyRecord('safety_reviews', 's-1', until)).toBe(true);
    expect(asked[1]).toMatch(/^UPDATE safety_reviews SET preserved_until = \$2/);
    expect(params[1]).toEqual(['s-1', until]);
  });
});

describe('it rides the daily ops tick', () => {
  it('the ttl-expiry case runs the safety record sweep', () => {
    const src = readFileSync(new URL('../../../src/workers/opsWorker.ts', import.meta.url), 'utf8');
    const tick = src.slice(src.indexOf("case 'ttl-expiry'"), src.indexOf("case 'sequencer-tick'"));
    expect(tick).toContain('await sweepSafetyRecords()');
    expect(tick).toContain('await sweepPhotoQuarantine()');
  });
});
