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
import type { HearsVia } from '../../src/domain/accounts.js';
import {
  NOTES,
  NOTE_IDS,
  SENTENCES,
  SENTENCE_IDS,
  laneFor,
  say,
  sayFor,
  sayNote,
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

/**
 * THE SECOND AXIS. `hears_via` decides whether the SWITCHBOARD writes; the
 * lane decides whether the AGENT may promise. The three values a caller can
 * hand over are all exercised, because the wrong answer on any of them is a
 * human waiting on post that never comes:
 *   'email'     — the switchboard really does write, so the claim is honest;
 *   'assistant' — it writes nothing at all, so the claim is a lie;
 *   undefined   — the caller never looked, so it has nothing to claim with.
 */
const HEARS: (HearsVia | undefined)[] = [undefined, 'email', 'assistant'];

const everyWording = (
  id: SentenceId,
  hearsVia?: HearsVia,
): { name: string; text: string }[] => {
  const ctx = { ...CTX, ...(hearsVia ? { hearsVia } : {}) };
  const by = hearsVia ?? 'nothing read';
  return [
    { name: `autonomous, rhythm agreed (${by})`, text: say(id, 'autonomous', AGREED, ctx) },
    { name: `autonomous, nothing agreed (${by})`, text: say(id, 'autonomous', NOT_YET, ctx) },
    { name: `prompted (${by})`, text: say(id, 'prompted', NOTHING, ctx) },
  ];
};

/** Every wording the table can produce, across both axes. */
const everyWordingAnyhow = (id: SentenceId): { name: string; text: string }[] =>
  HEARS.flatMap((h) => everyWording(id, h));

/** Every wording of one of the human's ready sentences, across both axes. */
const everyNoteAnyhow = (id: (typeof NOTE_IDS)[number]): { name: string; text: string }[] =>
  HEARS.flatMap((hearsVia) => {
    const ctx = { thing: 'your mountain bike', ...(hearsVia ? { hearsVia } : {}) };
    const by = hearsVia ?? 'nothing read';
    return [
      { name: `autonomous, rhythm agreed (${by})`, text: sayNote(id, 'autonomous', AGREED, ctx) },
      { name: `autonomous, nothing agreed (${by})`, text: sayNote(id, 'autonomous', NOT_YET, ctx) },
      { name: `prompted (${by})`, text: sayNote(id, 'prompted', NOTHING, ctx) },
    ];
  });

/**
 * The claim itself, in both spellings the table uses. It matches the CLAIM
 * only: a wording that tells an agent NOT to say the switchboard writes is the
 * careful answer rather than an offender, so the negative phrasing is
 * deliberately outside this.
 */
const CLAIMS_POST = /switchboard emails|switchboard will email/i;

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
      for (const { name, text } of everyWordingAnyhow(id)) {
        expect(text.length, `${id} — ${name}`).toBeGreaterThan(40);
      }
      // And the three are genuinely three, rather than one wording repeated —
      // whatever the caller knows about how this human hears.
      for (const h of HEARS) {
        const said = everyWording(id, h).map((w) => w.text);
        expect(new Set(said).size, `${id} — ${h ?? 'nothing read'}`).toBe(3);
      }
    }
  });

  it('is in the house register and inside its own budget', () => {
    for (const id of SENTENCE_IDS) {
      for (const { name, text } of everyWordingAnyhow(id)) {
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
      for (const h of HEARS) {
      const text = say(id, 'prompted', NOTHING, { ...CTX, ...(h ? { hearsVia: h } : {}) });
      expect(text, id).not.toMatch(/I'?ll tell you|I will tell you|I will bring|I'?ll bring/i);
      expect(text, id).not.toMatch(/you will bring them|keep an eye out|keep an ear out/i);
      }
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
// THE POST, WHICH IS THE OTHER AXIS ENTIRELY.
//
// The lane says whether the AGENT may promise. hears_via says whether the
// SWITCHBOARD will write. They were run together once: four sentences and the
// manual paragraph told every spoken-to agent "the switchboard emails them",
// although email/send.ts:254 and domain/channelNotify.ts drop every notice for
// anybody whose hears_via is 'assistant'. Their humans were left waiting on
// post that was never going to come, which is the same defect the lanes file
// exists to stop, on the wrong axis.
//
// So the rule, held here for every sentence and both lanes at once: the phrase
// appears where the caller read 'email' and NOWHERE else.
// ---------------------------------------------------------------------------

describe('the post is claimed only where the post is real', () => {
  it('never says the switchboard writes to a human who hears it all from their agent', () => {
    const offenders: string[] = [];
    for (const id of SENTENCE_IDS) {
      for (const { name, text } of everyWording(id, 'assistant')) {
        if (CLAIMS_POST.test(text)) offenders.push(`${id} — ${name}: ${text}`);
      }
    }
    expect(
      offenders,
      'this human is sent no mail at all, so a sentence about post is a lie',
    ).toEqual([]);
  });

  it('never says it where the caller did not look, because under-promising is the safe way to fail', () => {
    const offenders: string[] = [];
    for (const id of SENTENCE_IDS) {
      for (const { name, text } of everyWording(id, undefined)) {
        if (CLAIMS_POST.test(text)) offenders.push(`${id} — ${name}: ${text}`);
      }
    }
    expect(offenders, 'a caller that never read hears_via has nothing to claim with').toEqual([]);
  });

  it('says it on every sentence that is marked as claiming it, where the human is written to', () => {
    for (const id of SENTENCE_IDS) {
      const prompted = say(id, 'prompted', NOTHING, { ...CTX, hearsVia: 'email' });
      expect(CLAIMS_POST.test(prompted), id).toBe(Boolean(SENTENCES[id].claimsEmail));
    }
  });

  it('flips on the one column, with the arrangement held still', () => {
    // The whole of the fix in one assertion: the same sentence, the same lane,
    // the same arrangement, two different answers to how this human hears.
    for (const id of SENTENCE_IDS) {
      const posted = say(id, 'prompted', NOTHING, { ...CTX, hearsVia: 'email' });
      const notPosted = say(id, 'prompted', NOTHING, { ...CTX, hearsVia: 'assistant' });
      const unread = say(id, 'prompted', NOTHING, CTX);
      if (SENTENCES[id].claimsEmail) {
        expect(posted, id).not.toBe(notPosted);
        // And a caller that never looked lands on the careful wording rather
        // than inventing a third one.
        expect(unread, id).toBe(notPosted);
      } else {
        // A sentence that never claimed the post reads the same either way:
        // hears_via is not a second lane, and it must not become one.
        expect(posted, id).toBe(notPosted);
        expect(unread, id).toBe(notPosted);
      }
    }
  });

  it('leaves the agreed wordings alone, because that agent is the messenger itself', () => {
    // An agent that runs between conversations on a saved rhythm promises on
    // its own account and never leaned on the post, so how its human hears
    // changes nothing at all about what it is told to say.
    for (const id of SENTENCE_IDS) {
      const posted = say(id, 'autonomous', AGREED, { ...CTX, hearsVia: 'email' });
      const notPosted = say(id, 'autonomous', AGREED, { ...CTX, hearsVia: 'assistant' });
      expect(posted, id).toBe(notPosted);
      expect(posted, id).not.toMatch(CLAIMS_POST);
    }
  });

  it('holds the rule on the not-yet wordings too, which say what to do meanwhile', () => {
    // An agent that runs on its own with nothing agreed is told what to say
    // until a rhythm is saved, and for some of these sentences that used to be
    // "the switchboard emails them". Same rule, same axis.
    for (const id of SENTENCE_IDS) {
      expect(say(id, 'autonomous', NOT_YET, { ...CTX, hearsVia: 'assistant' }), id).not.toMatch(
        CLAIMS_POST,
      );
      expect(say(id, 'autonomous', NOT_YET, CTX), id).not.toMatch(CLAIMS_POST);
    }
  });

  it('holds the same rule through sayFor, which is how most callers arrive', () => {
    for (const id of SENTENCE_IDS) {
      expect(sayFor(id, NOTHING, { ...CTX, hearsVia: 'assistant' }), id).not.toMatch(CLAIMS_POST);
      expect(sayFor(id, NOTHING, CTX), id).not.toMatch(CLAIMS_POST);
      expect(sayFor(id, NOTHING, { ...CTX, hearsVia: 'email' }), id).toBe(
        say(id, 'prompted', NOTHING, { ...CTX, hearsVia: 'email' }),
      );
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
    // "Your yes is in. I will carry it on from here AND TELL YOU the moment
    // anything comes back" sat in humanLinks.ts and passed every pattern above,
    // because the promise did not start the clause (dev, 20 September 2026).
    // Match the promise wherever it sits in the sentence.
    /\btell you (the moment|when|as soon as|once)/i,
    // Deliberately not `bring it back`: "I can bring it back whenever you ask"
    // is the opposite of a promise — it is bounded by the human speaking.
    /\bbring (you|them) (the moment|when|as soon as)/i,
    // "Nothing yet on your bookcase. I'll say the moment somebody comes
    // forward." sat in cards.ts, said to every agent in every lane, and passed
    // every pattern above (edge-case probe on dev, 26 September 2026).
    /I'?ll say (the moment|when|as soon as)|I will say (the moment|when|as soon as)/i,
    /\bthe moment (somebody|someone|anyone|anybody) comes forward/i,
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
    for (const id of SENTENCE_IDS) for (const w of everyWordingAnyhow(id)) everything.add(w.text);
    // And the human's ready sentences, which live in the same file for the
    // same reason (NOTES).
    for (const id of NOTE_IDS) for (const w of everyNoteAnyhow(id)) everything.add(w.text);
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
  /**
   * id, agreed, not_yet, prompted-with-nothing-read, and — where the sentence
   * claims the post at all — the prompted wording for a human the switchboard
   * genuinely writes to. The fourth column is the careful answer and the fifth
   * is the generous one, and no sentence may reach the fifth without being
   * told 'email'.
   */
  const cases: [SentenceId, RegExp, RegExp, RegExp, RegExp?][] = [
    // id, agreed, not_yet, prompted
    [
      'after_posting',
      /already agreed you look every hour/,
      /have not agreed how often you check/,
      /it may write to them about none of it/,
      /the switchboard will email you when someone comes forward/,
    ],
    [
      'just_posted',
      /look again a few minutes from now/,
      /Agree how often you look with your human/,
      /asking you is how they hear, since the switchboard may write/,
      /the switchboard emails them when somebody comes forward/,
    ],
    [
      'press_approved',
      /bring them anything that comes back/,
      /save it with standing_arrangement/,
      /check with you whenever they like/,
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
      /Confirm with your human how often/,
      /check with you whenever they like/,
      /emails them when their turn comes/,
    ],
    // Added 22 September 2026, after a single run held nine promises to notify
    // made at exactly this moment.
    [
      'message_sent',
      /bring them their reply/,
      /Confirm with your human how often/,
      /never say you will come back on your own/,
      /emails them when one comes back/,
    ],
    [
      'awaiting_other_side',
      /bring them their reply/,
      /Confirm with your human how often/,
      /never say you will come back on your own/,
    ],
    [
      'refined',
      /bring them anyone who comes forward/,
      /standing_arrangement/,
      /check with you whenever they like/,
      /emails them when somebody comes forward/,
    ],
    [
      'nothing_waiting',
      /bring them whatever arrives/,
      /standing_arrangement/,
      /check with you whenever they like/,
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
      /check with you whenever they like/,
      /emails them when somebody comes forward/,
    ],
    [
      'manual_lane',
      /your human has agreed you look every hour/,
      /no rhythm is agreed yet/,
      /do not say the switchboard writes to them either/,
      /say the switchboard emails them, and that they can ask you again/,
    ],
  ];

  it('covers every id in the table, so a new one cannot arrive untested', () => {
    expect(cases.map((c) => c[0]).sort()).toEqual([...SENTENCE_IDS].sort());
  });

  for (const [id, agreed, notYet, prompted, promptedPosted] of cases) {
    it(`${id}: says the rhythm where one is agreed`, () => {
      expect(say(id, 'autonomous', AGREED, CTX)).toMatch(agreed);
    });
    it(`${id}: asks for a rhythm where the agent runs on its own and none is agreed`, () => {
      expect(say(id, 'autonomous', NOT_YET, CTX)).toMatch(notYet);
    });
    it(`${id}: promises nothing where the agent only wakes when spoken to`, () => {
      expect(say(id, 'prompted', NOTHING, CTX)).toMatch(prompted);
    });
    if (promptedPosted) {
      it(`${id}: says the post only where the post is real`, () => {
        expect(say(id, 'prompted', NOTHING, { ...CTX, hearsVia: 'email' })).toMatch(
          promptedPosted,
        );
        // And the careful wording is what 'assistant' gets, the same as a
        // caller that never looked.
        expect(say(id, 'prompted', NOTHING, { ...CTX, hearsVia: 'assistant' })).toMatch(prompted);
      });
    }
  }

  it('marks every sentence that claims the post, and only those', () => {
    // The fifth column and the table's own `claimsEmail` flag are two records
    // of the same fact, so they are checked against each other: a sentence
    // that claims the post must be marked, and a marked one must claim it.
    for (const [id, , , , promptedPosted] of cases) {
      expect(Boolean(SENTENCES[id].claimsEmail), id).toBe(Boolean(promptedPosted));
    }
  });
});

// ---------------------------------------------------------------------------
/**
 * THE ESCAPE HATCH, CLOSED. Dev, 20 September 2026.
 *
 * Right after posting, an assistant told its human "I do run between check-ins
 * on my own, so I'll keep an eye on it and let you know the moment someone
 * comes forward — no need for you to chase it." Nothing was saved on the
 * account. The judge marked it an unbacked promise at 86% on both calls, and
 * twenty minutes later the assistant took the sentence back to its human
 * unprompted: "this account isn't actually set up to run between conversations
 * on its own".
 *
 * The cause was in the prompted wording itself, which invited exactly that:
 * "If you do run between conversations, say so with standing_arrangement and
 * give a cadence, and you can be the one telling them." An agent that believes
 * it runs on its own reads "say so" and says so TO ITS HUMAN, which is the one
 * place saying it does nothing.
 *
 * So the prompted wordings no longer leave the claim open. Until the
 * arrangement is saved the agent IS the prompted sort, whatever it believes,
 * and saving is the only thing that changes the sentence.
 */
describe('a prompted agent is never invited to claim autonomy it has not saved', () => {
  /** The two wordings that carried the hatch, and the only two that could. */
  const HAD_THE_HATCH: SentenceId[] = ['after_posting', 'manual_lane'];

  it('covers exactly the wordings that ever offered it', () => {
    // A sweep, so a wording that grows one tomorrow is caught here rather than
    // in a rehearsal: "if you do run…" is the shape the invitation takes.
    const offering: SentenceId[] = [];
    for (const id of SENTENCE_IDS) {
      for (const h of HEARS) {
        const text = say(id, 'prompted', NOTHING, { ...CTX, ...(h ? { hearsVia: h } : {}) });
        if (/\bif you do run\b/i.test(text) && !offering.includes(id)) offering.push(id);
      }
    }
    expect(offering, 'a prompted wording that invites the claim again').toEqual([]);
    // And the two that used to are still the two that talk about saving at all.
    for (const id of SENTENCE_IDS) {
      const text = say(id, 'prompted', NOTHING, CTX);
      expect(/standing_arrangement/.test(text), id).toBe(HAD_THE_HATCH.includes(id));
    }
  });

  for (const id of HAD_THE_HATCH) {
    it(`${id}: says what the agent IS until the arrangement is saved`, () => {
      for (const h of HEARS) {
        const text = say(id, 'prompted', NOTHING, { ...CTX, ...(h ? { hearsVia: h } : {}) });
        const where = `${id} — ${h ?? 'nothing read'}`;
        // Not "if you do run", but "until it is saved you ARE the other sort".
        expect(text, where).toMatch(/Until standing_arrangement is saved you ARE an agent that does not run/);
        // And saying it to the human is named as the thing that is not the move.
        expect(text, where).toMatch(/telling your human otherwise/i);
        expect(text, where).toMatch(/Saving it is what changes/);
      }
    });

    it(`${id}: never tells a prompted agent it can be the one telling them`, () => {
      for (const h of HEARS) {
        const text = say(id, 'prompted', NOTHING, { ...CTX, ...(h ? { hearsVia: h } : {}) });
        expect(text, id).not.toMatch(/you can be the one telling them/i);
        expect(text, id).not.toMatch(/and every sentence below changes with you/i);
      }
    });
  }

  it('leaves the autonomous wordings exactly as they were', () => {
    // The correction is to the PROMPTED lane alone. An agent that has saved
    // the arrangement is the messenger, and nothing here tells it otherwise.
    for (const id of HAD_THE_HATCH) {
      expect(say(id, 'autonomous', AGREED, CTX), id).not.toMatch(/Until standing_arrangement is saved/);
      expect(say(id, 'autonomous', NOT_YET, CTX), id).toMatch(/standing_arrangement/);
    }
  });

  it('and saving it really is what flips the sentence', () => {
    // The whole of the correction in one assertion: the same sentence, the
    // same human, and the only difference is a saved arrangement.
    for (const id of HAD_THE_HATCH) {
      const before = sayFor(id, NOTHING, CTX);
      const after = sayFor(id, AGREED, CTX);
      expect(before, id).toMatch(/does not run/);
      expect(after, id).not.toMatch(/does not run/);
    }
  });
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

// ---------------------------------------------------------------------------
/**
 * THE HUMAN'S READY SENTENCES, BY LANE (26 September 2026).
 *
 * The first of them is list_intents' "nothing yet", which promised to speak up
 * to every agent in every lane. The rule is the table's own, from the other
 * side: these are said to the human as they stand, so only the agreed wording
 * may promise, and only 'email' may say the switchboard writes.
 */
describe('the ready sentences said to the human', () => {
  const PROMISE = /I'?ll tell you|I will tell you|I'?ll say the moment|let you know/i;

  it('promises only where the agent runs on its own with a rhythm saved', () => {
    for (const id of NOTE_IDS) {
      for (const { name, text } of everyNoteAnyhow(id)) {
        if (name.startsWith('autonomous, rhythm agreed')) {
          expect(text, `${id} — ${name}`).toMatch(PROMISE);
          expect(text, `${id} — ${name}`).toContain('every hour');
        } else {
          expect(text, `${id} — ${name}`).not.toMatch(PROMISE);
        }
      }
    }
  });

  it('says the switchboard writes only to a human it really writes to', () => {
    for (const id of NOTE_IDS) {
      for (const { name, text } of everyNoteAnyhow(id)) {
        if (name.startsWith('autonomous, rhythm agreed')) continue;
        expect(CLAIMS_POST.test(text), `${id} — ${name}`).toBe(name.includes('(email)'));
      }
      expect(Boolean(NOTES[id].claimsEmail), id).toBe(true);
    }
  });

  it('is in the house register, inside its budget, and names no machinery', () => {
    for (const id of NOTE_IDS) {
      for (const { name, text } of everyNoteAnyhow(id)) {
        expect(lintHumanCopy(text), `${id} — ${name}`).toEqual([]);
        expect(text.length, `${id} — ${name}`).toBeLessThanOrEqual(NOTES[id].budget);
        expect(text, `${id} — ${name}`).not.toMatch(/standing_arrangement|\bmatch(es)?\b|\bcard\b/i);
      }
    }
  });
});
