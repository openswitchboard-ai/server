/**
 * The eval harnesses' OUTSIDER GUARD (test/realism/outsiderGuard.ts).
 *
 * The evals post real cards on the shared dev board and let the LIVE matcher
 * pair them, so the matcher sometimes pairs an eval account with a REAL one and
 * the driven agent greets a real person. The guard severs those pairs
 * permanently through `match_mutes`, the account-pair mute table the matcher's
 * candidate prefilter already reads.
 *
 * The DB half of that is integration-grade and deliberately thin. What is
 * asserted here is the half that decides WHO gets muted and WHAT is written —
 * the part where a mistake is expensive in both directions: mute too little and
 * a real person keeps getting greeted; mute too much and the eval agent is
 * permanently severed from her own scripted counterpart, quietly breaking every
 * later run.
 *
 * A fake exec stands in for dbExec (the RDS Data API door), in the spirit of
 * the fake pool the domain unit tests use: the statements and their bound
 * parameters are the things under test.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMuteInsert,
  buildOutsiderQuery,
  chunk,
  classifyCrossings,
  muteOutsiders,
  mutePairs,
  normaliseIds,
  outsidersOf,
  OutsiderGuard,
  type Exec,
  type MatchRow,
} from '../realism/outsiderGuard.js';

const NAGATHA = '411af5b9-b2a9-4126-83f8-73bf4934f5dd'; // the driven agent
const CP = 'cccccccc-1111-4111-8111-cccccccccccc'; // the scripted counterpart
const REAL_A = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa'; // a real person's account
const REAL_B = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';

const row = (matchId: string, want: string, have: string): MatchRow => ({
  matchId,
  accountWant: want,
  accountHave: have,
});

/** A recording stand-in for dbExec. `rows` answers the SELECT. */
function fakeExec(rows: any[][] = []): Exec & {
  calls: { sql: string; parameters: { name: string; value: any }[] }[];
} {
  const calls: { sql: string; parameters: { name: string; value: any }[] }[] = [];
  const exec = (async (sql: string, parameters: { name: string; value: any }[] = []) => {
    calls.push({ sql, parameters });
    if (/^\s*WITH run/.test(sql)) return rows;
    // An INSERT ... RETURNING answers with one row per row actually written.
    const written = (sql.match(/\(:a\d+::uuid/g) ?? []).length;
    return Array.from({ length: written }, () => ['ok']);
  }) as Exec & { calls: typeof calls };
  exec.calls = calls;
  return exec;
}

// ---------------------------------------------------------------------------
describe('which matches are the guard\'s business', () => {
  it('a match with exactly one run account on it is a crossing', () => {
    const crossings = classifyCrossings([row('m1', NAGATHA, REAL_A)], [NAGATHA, CP]);
    expect(crossings).toEqual([
      { matchId: 'm1', runAccountId: NAGATHA, outsiderAccountId: REAL_A },
    ]);
  });

  it('reads the crossing whichever side the run account is on', () => {
    const crossings = classifyCrossings([row('m1', REAL_A, CP)], [NAGATHA, CP]);
    expect(crossings[0]).toMatchObject({ runAccountId: CP, outsiderAccountId: REAL_A });
  });

  it('THE EVAL\'S OWN PAIRING IS LEFT ALONE: both sides in the run is not a crossing', () => {
    expect(classifyCrossings([row('m1', NAGATHA, CP)], [NAGATHA, CP])).toEqual([]);
  });

  it('a match between two strangers is none of our business', () => {
    expect(classifyCrossings([row('m1', REAL_A, REAL_B)], [NAGATHA, CP])).toEqual([]);
  });

  it('distinct outsiders are reported once, in first-seen order', () => {
    const crossings = classifyCrossings(
      [row('m1', NAGATHA, REAL_B), row('m2', CP, REAL_A), row('m3', REAL_B, CP)],
      [NAGATHA, CP],
    );
    expect(crossings).toHaveLength(3);
    expect(outsidersOf(crossings)).toEqual([REAL_B, REAL_A]);
  });

  it('ids are compared case-insensitively and untrimmed input does not slip through', () => {
    const crossings = classifyCrossings(
      [row('m1', ` ${NAGATHA.toUpperCase()} `, REAL_A)],
      [` ${NAGATHA} `],
    );
    expect(crossings[0]).toMatchObject({ runAccountId: NAGATHA, outsiderAccountId: REAL_A });
    expect(normaliseIds([NAGATHA, NAGATHA.toUpperCase(), '', undefined, null])).toEqual([NAGATHA]);
  });
});

// ---------------------------------------------------------------------------
describe('the rows a mute writes', () => {
  it('is both directions, every run account against every outsider', () => {
    expect(mutePairs([NAGATHA, CP], [REAL_A])).toEqual([
      [NAGATHA, REAL_A],
      [REAL_A, NAGATHA],
      [CP, REAL_A],
      [REAL_A, CP],
    ]);
  });

  it('never writes a self-mute, and never the same key twice in one statement', () => {
    const pairs = mutePairs([NAGATHA, CP, NAGATHA], [REAL_A, REAL_A, NAGATHA]);
    expect(pairs.some(([a, b]) => a === b)).toBe(false);
    expect(new Set(pairs.map((p) => p.join('|'))).size).toBe(pairs.length);
  });

  it('binds every id as a parameter and never inlines one into the SQL', () => {
    const { sql, parameters } = buildMuteInsert([
      [NAGATHA, REAL_A],
      [REAL_A, NAGATHA],
    ]);
    expect(sql).toContain('INSERT INTO match_mutes (account_id, muted_account)');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain('(:a0::uuid, :b0::uuid), (:a1::uuid, :b1::uuid)');
    expect(sql).not.toContain(NAGATHA);
    expect(parameters).toEqual([
      { name: 'a0', value: NAGATHA },
      { name: 'b0', value: REAL_A },
      { name: 'a1', value: REAL_A },
      { name: 'b1', value: NAGATHA },
    ]);
  });

  it('the lookup asks only for the window, the ids, and the exactly-one-side rule', () => {
    const { sql, parameters } = buildOutsiderQuery([NAGATHA, CP], '2026-09-05T00:00:00.000Z');
    expect(sql).toContain('FROM matches m');
    expect(sql).toMatch(/account_want IN \(SELECT id FROM run\)\)\s*<>/);
    expect(sql).toContain('m.created_at > :since::timestamptz');
    // Ids and the window are bound, and nothing personal is selected.
    expect(parameters).toEqual([
      { name: 'ids', value: `${NAGATHA},${CP}` },
      { name: 'since', value: '2026-09-05T00:00:00.000Z' },
    ]);
    expect(sql).not.toMatch(/first_name|email|locality|attributes/);
  });

  it('chunks so one statement never carries an unbounded parameter list', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('muteOutsiders end to end, over a fake DB door', () => {
  it('mutes each outsider and declines only the crossings the run controls', async () => {
    const exec = fakeExec([
      ['m1', NAGATHA, REAL_A], // agent side: mute only, no fabricated decline
      ['m2', CP, REAL_B], // counterpart side: ours to decline honestly
      ['m3', NAGATHA, CP], // the eval's own pairing (the SQL would not return it)
    ]);
    const declined: string[] = [];
    const r = await muteOutsiders([NAGATHA, CP], '2026-09-05T00:00:00.000Z', {
      exec,
      declinable: [CP],
      decline: async (id) => {
        declined.push(id);
        return true;
      },
      logLine: () => undefined,
    });

    expect(r.muted).toEqual([REAL_A, REAL_B]);
    expect(declined).toEqual(['m2']);
    expect(r.declined).toBe(1);

    // Mute first, decline second: the pair is severed before anything else can fail.
    const insert = exec.calls.find((c) => c.sql.includes('INSERT INTO match_mutes'))!;
    const written = new Set(
      insert.parameters
        .filter((p) => p.name.startsWith('a'))
        .map((p, i) => `${p.value}|${insert.parameters.filter((q) => q.name.startsWith('b'))[i].value}`),
    );
    expect(written).toEqual(
      new Set([
        `${NAGATHA}|${REAL_A}`,
        `${REAL_A}|${NAGATHA}`,
        `${CP}|${REAL_A}`,
        `${REAL_A}|${CP}`,
        `${NAGATHA}|${REAL_B}`,
        `${REAL_B}|${NAGATHA}`,
        `${CP}|${REAL_B}`,
        `${REAL_B}|${CP}`,
      ]),
    );
  });

  it('a decline that errors is swallowed; the mute still stands', async () => {
    const exec = fakeExec([['m2', CP, REAL_B]]);
    const r = await muteOutsiders([NAGATHA, CP], 'since', {
      exec,
      declinable: [CP],
      decline: async () => {
        throw new Error('respond refused');
      },
      logLine: () => undefined,
    });
    expect(r.muted).toEqual([REAL_B]);
    expect(r.declined).toBe(0);
    expect(exec.calls.some((c) => c.sql.includes('INSERT INTO match_mutes'))).toBe(true);
  });

  it('no crossings means no write at all', async () => {
    const exec = fakeExec([]);
    const r = await muteOutsiders([NAGATHA, CP], 'since', { exec, logLine: () => undefined });
    expect(r).toEqual({ muted: [], declined: 0 });
    expect(exec.calls.filter((c) => c.sql.includes('INSERT'))).toHaveLength(0);
  });

  it('writes nothing at all when the run has no accounts yet', async () => {
    const exec = fakeExec([['m1', NAGATHA, REAL_A]]);
    expect(await muteOutsiders([], 'since', { exec })).toEqual({ muted: [], declined: 0 });
    expect(exec.calls).toHaveLength(0);
  });

  it('touches match_mutes and nothing else', async () => {
    const exec = fakeExec([['m1', NAGATHA, REAL_A]]);
    await muteOutsiders([NAGATHA, CP], 'since', { exec, logLine: () => undefined });
    for (const c of exec.calls) {
      expect(c.sql).not.toMatch(/\b(UPDATE|DELETE)\b/);
      const inserts = c.sql.match(/INSERT INTO (\w+)/g) ?? [];
      for (const i of inserts) expect(i).toBe('INSERT INTO match_mutes');
    }
  });
});

// ---------------------------------------------------------------------------
describe('the run-scoped guard', () => {
  const opts = (exec: Exec) => ({
    since: '2026-09-05T00:00:00.000Z',
    runAccountIds: [CP],
    exec,
    logLine: () => undefined,
  });

  it('IS DISARMED until the driven agent\'s account is known', async () => {
    // Before her id is learned, an agent-vs-counterpart match is indistinguishable
    // from a counterpart-vs-outsider one — sweeping here would mute the agent
    // against her own counterpart and break every later run.
    const exec = fakeExec([['m1', CP, NAGATHA]]);
    const guard = new OutsiderGuard(opts(exec));
    expect(guard.armed).toBe(false);
    expect(await guard.sweep('too early')).toEqual({ muted: [], declined: 0 });
    expect(exec.calls).toHaveLength(0);
  });

  it('arms on the agent account and then leaves that pairing alone', async () => {
    const exec = fakeExec([['m1', CP, NAGATHA], ['m2', NAGATHA, REAL_A]]);
    const guard = new OutsiderGuard(opts(exec));
    guard.setAgentAccount(NAGATHA);
    expect(guard.armed).toBe(true);
    const r = await guard.sweep('after post');
    expect(r.muted).toEqual([REAL_A]);
  });

  it('never throws when the DB refuses — a guard failure must not fail a run', async () => {
    const guard = new OutsiderGuard({
      since: 'since',
      runAccountIds: [CP],
      exec: async () => {
        throw new Error('rds is having a day');
      },
      logLine: () => undefined,
    });
    guard.setAgentAccount(NAGATHA);
    await expect(guard.sweep('boom')).resolves.toEqual({ muted: [], declined: 0 });
    await expect(guard.flush()).resolves.toEqual({ muted: [], declined: 0 });
  });

  it('flush cancels a scheduled sweep and does one final pass', async () => {
    const exec = fakeExec([['m1', NAGATHA, REAL_A]]);
    const guard = new OutsiderGuard(opts(exec));
    guard.setAgentAccount(NAGATHA);
    guard.sweepSoon('scheduled', 60_000);
    const r = await guard.flush();
    expect(r.muted).toEqual([REAL_A]);
    // The 60s timer was cleared, so exactly one lookup happened.
    expect(exec.calls.filter((c) => c.sql.includes('FROM matches m'))).toHaveLength(1);
  });
});
