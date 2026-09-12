/**
 * How it went, in the three words a person says.
 *
 * The defect this suite exists to hold shut, from the 2026-09-12 rehearsal:
 * the one-tap call took two answers, spelled 'good-call' and 'not-for-me', and
 * an assistant read one of those hyphenated spellings straight out to its
 * human. Two answers was also one short. An introduction that was simply all
 * right had nowhere to go but in with the rejections, and a rejection mutes
 * the pairing for good.
 *
 * The rules asserted here:
 *  - the wire takes 'good', 'fine' and 'bad', and nothing else;
 *  - 'bad' keeps every effect the old rejection had: the pairing is muted, an
 *    open introduction is declined, and the threshold is nudged up;
 *  - 'good' relaxes the threshold, as it always did;
 *  - 'fine' is recorded and does nothing else at all — no mute, no decline,
 *    and neutral in the reliability signal;
 *  - the two old words still answer, for one manual version, and neither of
 *    them is ever stored;
 *  - the agent is told to ask in plain words and is never handed a spelling
 *    to read out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../../src/db.js';
import { readVerdict, recordVerdict } from '../../src/domain/matches.js';
import { TOOLS, dispatchTool } from '../../src/mcp/tools.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side

interface World {
  stored: { verdict: string; via: string }[];
  mutes: [string, string][];
  declined: string[];
  bumpUp: number;
  bumpDown: number;
}
let world: World;

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/FROM matches/.test(sql) && /^\s*SELECT/.test(sql)) {
        return rows([
          {
            id: MATCH,
            card_want: 'card-w',
            card_have: 'card-h',
            account_want: ANA,
            account_have: BEPPE,
            score: 0.8,
            category: 'goods.bicycle.mountain',
            stage: 2,
            interest_want: true,
            interest_have: true,
            state: 'open',
            channel_id: null,
            opened_at: null,
          },
        ]);
      }
      if (/INSERT INTO match_verdicts/.test(sql)) {
        world.stored.push({ verdict: params[2], via: params[3] });
        return rows([]);
      }
      if (/INSERT INTO match_mutes/.test(sql)) {
        world.mutes.push([params[0], params[1]]);
        return rows([]);
      }
      if (/UPDATE matches SET state = 'declined'/.test(sql)) {
        world.declined.push(params[0]);
        return rows([]);
      }
      if (/UPDATE reputation SET threshold_bump = LEAST/.test(sql)) {
        world.bumpUp += 1;
        return rows([]);
      }
      if (/UPDATE reputation SET threshold_bump = GREATEST/.test(sql)) {
        world.bumpDown += 1;
        return rows([]);
      }
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  world = { stored: [], mutes: [], declined: [], bumpUp: 0, bumpDown: 0 };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

// ---------------------------------------------------------------------------
describe('the three answers', () => {
  it('bad does everything the old rejection did', async () => {
    await recordVerdict(MATCH, ANA, 'bad', 'counter');
    expect(world.stored).toEqual([{ verdict: 'bad', via: 'counter' }]);
    expect(world.mutes).toEqual([[ANA, BEPPE]]); // the pairing never comes back
    expect(world.declined).toEqual([MATCH]); // reasonless, as all declines are
    expect(world.bumpUp).toBe(1);
    expect(world.bumpDown).toBe(0);
  });

  it('good relaxes the threshold, so more like it come through', async () => {
    await recordVerdict(MATCH, ANA, 'good', 'counter');
    expect(world.stored).toEqual([{ verdict: 'good', via: 'counter' }]);
    expect(world.mutes).toEqual([]);
    expect(world.declined).toEqual([]);
    expect(world.bumpDown).toBe(1);
    expect(world.bumpUp).toBe(0);
  });

  it('fine is recorded and does nothing else at all', async () => {
    const r = await recordVerdict(MATCH, ANA, 'fine', 'counter');
    expect(r).toEqual({ intro_id: MATCH, verdict: 'fine' });
    expect(world.stored).toEqual([{ verdict: 'fine', via: 'counter' }]);
    // Neutral in the reliability signal, both ways, and nothing is shut down.
    expect(world.mutes).toEqual([]);
    expect(world.declined).toEqual([]);
    expect(world.bumpUp).toBe(0);
    expect(world.bumpDown).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the two old words, for one manual version', () => {
  it('reads each of them as the word that replaced it', () => {
    expect(readVerdict('good-call')).toBe('good');
    expect(readVerdict('not-for-me')).toBe('bad');
    expect(readVerdict('good')).toBe('good');
    expect(readVerdict('fine')).toBe('fine');
    expect(readVerdict('bad')).toBe('bad');
  });

  it('reads anything else as nothing', () => {
    for (const said of ['ok', 'GOOD', 'not for me', '', undefined, null, 3]) {
      expect(readVerdict(said), String(said)).toBeUndefined();
    }
  });

  it('stores the new word when an older agent sends an old one', async () => {
    const r: any = await dispatchTool(cfg, ANA, 'respond', {
      intro_id: MATCH,
      action: 'verdict',
      verdict: 'not-for-me',
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.verdict).toBe('bad');
    expect(world.stored).toEqual([{ verdict: 'bad', via: 'agent' }]);
    expect(world.mutes).toEqual([[ANA, BEPPE]]); // every effect it always had
  });

  it('takes the plain words through the tool too', async () => {
    const r: any = await dispatchTool(cfg, ANA, 'respond', {
      intro_id: MATCH,
      action: 'verdict',
      verdict: 'fine',
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.verdict).toBe('fine');
  });

  it('refuses a word that is neither, naming the three', async () => {
    const r: any = await dispatchTool(cfg, ANA, 'respond', {
      intro_id: MATCH,
      action: 'verdict',
      verdict: 'meh',
    });
    expect(r.isError).toBe(true);
    const said = JSON.parse(r.content[0].text);
    expect(said.message).toContain("'good', 'fine' or 'bad'");
    expect(world.stored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('what the agent is offered', () => {
  const respond = () => TOOLS.find((t) => t.name === 'respond')!;

  it('offers the three plain words and neither old spelling', () => {
    expect(respond().inputSchema.properties.verdict.enum).toEqual(['good', 'fine', 'bad']);
    const every = JSON.stringify(respond());
    expect(every).not.toContain('good-call');
    expect(every).not.toContain('not-for-me');
  });

  it('tells the agent to ask in plain words, and that fine is a real answer', () => {
    expect(respond().description).toContain('how was that: good, fine or bad?');
    expect(respond().description).toMatch(/never read the word back off the wire/i);
    expect(respond().inputSchema.properties.verdict.description).toMatch(
      /fine is a real answer/i,
    );
  });
});
