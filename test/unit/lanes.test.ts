/**
 * THE TWO LANES, and the guards that keep them the only place a promise is
 * decided.
 *
 * An assistant either runs between conversations or exists only while its
 * human is typing to it, and what it may promise turns entirely on which. Two
 * rehearsals in two days turned up the same defect in different sentences —
 * "I'll let you know the moment someone comes forward", said with nothing
 * saved and no way to wake up — so the fix is a table (src/domain/lanes.ts)
 * rather than a branch per sentence.
 *
 * The three tests that make that hold are the point of the file:
 *  - every entry carries both lanes and both autonomous cases;
 *  - `runs_on_its_own` and `check_every_minutes` are read nowhere in the
 *    domain or the tool layer except lanes.ts, arrangement.ts and the tool
 *    schema, so a future sentence cannot branch quietly;
 *  - no sentence anywhere else promises to come back, so a future sentence
 *    cannot promise quietly either.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import * as db from '../../src/db.js';
import { arrangementOrNothing, type Arrangement } from '../../src/domain/arrangement.js';
import {
  SENTENCES,
  SENTENCE_IDS,
  laneFor,
  say,
  sayFor,
  type Lane,
  type SentenceId,
} from '../../src/domain/lanes.js';
import { lintHumanCopy } from '../../src/email/lint.js';

/** Enough context to fill every wording in the table. */
const CTX = {
  thing: 'the mountain bike you are after',
  added: 'I have added the other way they say it.',
};

/** The three arrangements a sentence is ever written for. */
const AGREED: Arrangement = { runs_on_its_own: true, check_every_minutes: 60 };
const NOT_YET: Arrangement = { runs_on_its_own: true };
const NOTHING: Arrangement = {};

const everyWording = (id: SentenceId): { name: string; text: string }[] => [
  { name: 'autonomous, rhythm agreed', text: say(id, 'autonomous', AGREED, CTX) },
  { name: 'autonomous, nothing agreed', text: say(id, 'autonomous', NOT_YET, CTX) },
  { name: 'prompted', text: say(id, 'prompted', NOTHING, CTX) },
];

// ---------------------------------------------------------------------------
describe('which lane an arrangement puts an agent in', () => {
  it('is autonomous only where the agent has said it runs between conversations', () => {
    expect(laneFor({ runs_on_its_own: true })).toBe('autonomous');
    expect(laneFor({ runs_on_its_own: true, check_every_minutes: 60 })).toBe('autonomous');
    expect(laneFor({})).toBe('prompted');
    expect(laneFor({ runs_on_its_own: false })).toBe('prompted');
    // A cadence with nobody to keep it is a schedule nobody keeps. The
    // validator refuses one; a row that somehow holds it is still prompted.
    expect(laneFor({ check_every_minutes: 60 })).toBe('prompted');
  });

  it('reads an unreadable account as prompted, which promises the least', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async () => {
        throw new Error('the database is not there');
      },
    } as any);
    const a = await arrangementOrNothing('nobody');
    expect(a).toEqual({});
    expect(laneFor(a)).toBe('prompted');
    for (const id of SENTENCE_IDS) {
      expect(sayFor(id, a, CTX), id).toBe(say(id, 'prompted', NOTHING, CTX));
    }
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
describe('every sentence in the table', () => {
  it('has both lanes filled, and both cases of the autonomous one', () => {
    expect(SENTENCE_IDS.length).toBeGreaterThan(0);
    for (const id of SENTENCE_IDS) {
      const s = SENTENCES[id];
      expect(s.about.length, id).toBeGreaterThan(10);
      expect(s.budget, id).toBeGreaterThan(0);
      for (const { name, text } of everyWording(id)) {
        expect(text.length, `${id} — ${name}`).toBeGreaterThan(40);
      }
      // And the three are genuinely three, rather than one wording repeated.
      const said = everyWording(id).map((w) => w.text);
      expect(new Set(said).size, id).toBe(3);
    }
  });

  it('is in the house register and inside its own budget', () => {
    for (const id of SENTENCE_IDS) {
      for (const { name, text } of everyWording(id)) {
        expect(lintHumanCopy(text), `${id} — ${name}`).toEqual([]);
        expect(text.length, `${id} — ${name}`).toBeLessThanOrEqual(SENTENCES[id].budget);
        // No machinery word a human would be read out, and no figure of
        // speech for what the switchboard does under the covers.
        expect(text, `${id} — ${name}`).not.toMatch(/\bmatch(es|ed|ing)?\b|\bscore\b|\bcard\b/i);
      }
    }
  });

  it('says the agreed rhythm back in plain words, and only on the agreed wording', () => {
    for (const id of SENTENCE_IDS) {
      const twiceADay = { runs_on_its_own: true, check_every_minutes: 720 };
      expect(say(id, 'autonomous', twiceADay, CTX), id).toContain('every 12 hours');
      expect(say(id, 'autonomous', AGREED, CTX), id).toContain('every hour');
      expect(say(id, 'autonomous', NOT_YET, CTX), id).not.toContain('every hour');
      expect(say(id, 'prompted', NOTHING, CTX), id).not.toContain('every hour');
    }
  });

  it('asks for the rhythm where the agent can keep one and none is agreed', () => {
    for (const id of SENTENCE_IDS) {
      const text = say(id, 'autonomous', NOT_YET, CTX);
      expect(text, id).toMatch(/standing_arrangement/);
      expect(text, id).toMatch(/hourly|every hour|how often/i);
    }
  });

  it('never lets a prompted agent offer to come back', () => {
    for (const id of SENTENCE_IDS) {
      const text = say(id, 'prompted', NOTHING, CTX);
      expect(text, id).not.toMatch(/I'?ll tell you|I will tell you|I will bring|I'?ll bring/i);
      expect(text, id).not.toMatch(/you will bring them|keep an eye out|keep an ear out/i);
    }
  });

  it('flips on the one setting, with nothing else to do', () => {
    // A human turning autonomy on or off on their own page is the whole of it:
    // the lane is read per answer, so every sentence changes at once.
    for (const id of SENTENCE_IDS) {
      const on = sayFor(id, AGREED, CTX);
      const off = sayFor(id, NOTHING, CTX);
      expect(on, id).not.toBe(off);
    }
  });
});

// ---------------------------------------------------------------------------
// THE SOURCE SWEEPS. Both read the shipped source with comments and string
// literals stripped or kept as the rule needs, so a sentence added tomorrow
// has to go through the table or fail here.
// ---------------------------------------------------------------------------

const ROOTS = ['src/domain', 'src/mcp'];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  for (const r of ROOTS) walk(r);
  return out.sort();
}

/** Block and line comments gone; string and template literals emptied. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** Block and line comments gone; string and template literals kept. */
function prose(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

describe('nothing outside the table decides which lane an agent is in', () => {
  /** Where the two field names may legitimately be read. */
  const MAY_READ = ['src/domain/lanes.ts', 'src/domain/arrangement.ts'];
  /** The tool schema names the two fields as its own input properties. */
  const SCHEMA_KEY = /^\s*(runs_on_its_own|check_every_minutes)\?*:\s*\{\s*$/;

  it('reads runs_on_its_own and check_every_minutes only in lanes.ts and arrangement.ts', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (MAY_READ.includes(file)) continue;
      const code = codeOnly(readFileSync(file, 'utf8'));
      code.split('\n').forEach((line, i) => {
        if (!/runs_on_its_own|check_every_minutes/.test(line)) return;
        // The tool schema declares them as input properties, which is the one
        // other honest reason to write either name.
        if (file === 'src/mcp/tools.ts' && SCHEMA_KEY.test(line)) return;
        offenders.push(`${file}:${i + 1} ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'a sentence that branches on the arrangement itself belongs in domain/lanes.ts',
    ).toEqual([]);
  });
});

describe('nothing outside the table promises to come back', () => {
  /**
   * The phrasings an assistant used in a rehearsal, and their near neighbours.
   * A sentence the switchboard hands an agent may carry one of these only
   * where it came out of SENTENCES, because only there is it written against
   * the lane the agent is actually in.
   */
  const PROMISES = [
    /let you know/i,
    /I'?ll tell you|I will tell you/i,
    /I'?ll bring|I will bring/i,
    /keep an eye out/i,
    /keep an ear out/i,
    /come back to you/i,
    /I will email you|I'?ll email you/i,
    /check back/i,
  ];

  /**
   * The manual is prose about the rules rather than a sentence handed over
   * mid-work, and it quotes these phrasings on purpose — as the thing an
   * assistant said in a rehearsal and must not say again.
   */
  const NOT_HANDED_OVER = ['src/mcp/instructions.ts'];

  it('carries a promise phrase only in lanes.ts', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === 'src/domain/lanes.ts' || NOT_HANDED_OVER.includes(file)) continue;
      const text = prose(readFileSync(file, 'utf8'));
      text.split('\n').forEach((line, i) => {
        if (PROMISES.some((p) => p.test(line))) offenders.push(`${file}:${i + 1} ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'a sentence that promises to come back belongs in domain/lanes.ts, where it is written per lane',
    ).toEqual([]);
  });

  it('and every promise phrase in lanes.ts sits in a wording the table produced', () => {
    const everything = new Set<string>();
    for (const id of SENTENCE_IDS) for (const w of everyWording(id)) everything.add(w.text);
    const said = [...everything].join('\n');
    const lines = prose(readFileSync('src/domain/lanes.ts', 'utf8')).split('\n');
    const loose: string[] = [];
    for (const [i, line] of lines.entries()) {
      if (!PROMISES.some((p) => p.test(line))) continue;
      // Every promise phrase written in the file has to turn up in something
      // `say` actually returns; a phrase in a helper nobody reaches is the
      // shape the next defect would take.
      const phrase = PROMISES.find((p) => p.test(line))!;
      if (!phrase.test(said)) loose.push(`${i + 1} ${line.trim()}`);
    }
    expect(loose, 'a promise phrase nothing serves').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('the wordings themselves, one sentence at a time', () => {
  const cases: [SentenceId, RegExp, RegExp, RegExp][] = [
    // id, agreed, not_yet, prompted
    [
      'after_posting',
      /already agreed you look every hour/,
      /have not agreed how often you check/,
      /the switchboard will email you when someone comes forward/,
    ],
    [
      'just_posted',
      /look again a few minutes from now/,
      /Agree how often you look with your human/,
      /check with you after that/,
    ],
    [
      'waiting_on_their_go_ahead',
      /bring them their go-ahead/,
      /save it with standing_arrangement/,
      /check with you whenever they like/,
    ],
    [
      'awaiting_their_go_ahead',
      /bring them their go-ahead/,
      /save it with standing_arrangement/,
      /check with you whenever they like/,
    ],
    [
      'in_line',
      /bring them their turn the moment it comes/,
      /how often you should look/,
      /emails them when their turn comes/,
    ],
    [
      'awaiting_other_side',
      /bring them their reply/,
      /suggest hourly/,
      /never say you will come back on your own/,
    ],
    [
      'refined',
      /bring them anyone who comes forward/,
      /standing_arrangement/,
      /emails them when somebody comes forward/,
    ],
    [
      'nothing_waiting',
      /bring them whatever arrives/,
      /standing_arrangement/,
      /emails them when something arrives/,
    ],
    [
      'offer_on_the_table',
      /bring them their answer/,
      /standing_arrangement/,
      /check with you whenever they like/,
    ],
    [
      'verdict_good',
      /bring them more like it/,
      /standing_arrangement/,
      /emails them when somebody comes forward/,
    ],
    [
      'manual_lane',
      /your human has agreed you look every hour/,
      /no rhythm is agreed yet/,
      /Nothing on this account says you run between conversations/,
    ],
  ];

  it('covers every id in the table, so a new one cannot arrive untested', () => {
    expect(cases.map((c) => c[0]).sort()).toEqual([...SENTENCE_IDS].sort());
  });

  for (const [id, agreed, notYet, prompted] of cases) {
    it(`${id}: says the rhythm where one is agreed`, () => {
      expect(say(id, 'autonomous', AGREED, CTX)).toMatch(agreed);
    });
    it(`${id}: asks for a rhythm where the agent runs on its own and none is agreed`, () => {
      expect(say(id, 'autonomous', NOT_YET, CTX)).toMatch(notYet);
    });
    it(`${id}: promises nothing where the agent only wakes when spoken to`, () => {
      expect(say(id, 'prompted', NOTHING, CTX)).toMatch(prompted);
    });
  }
});

// ---------------------------------------------------------------------------
describe('what a caller passes', () => {
  it('takes the lane it was given rather than working it out again', () => {
    // The caller reads the arrangement once for the whole answer and hands
    // both over; `say` never reads anything itself.
    const lanes: Lane[] = ['autonomous', 'prompted'];
    for (const lane of lanes) {
      expect(say('in_line', lane, AGREED)).toBe(
        lane === 'autonomous'
          ? say('in_line', 'autonomous', AGREED)
          : say('in_line', 'prompted', NOTHING),
      );
    }
  });
});
