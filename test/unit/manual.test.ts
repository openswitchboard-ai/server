/**
 * The manual reaches agents that never reconnect.
 *
 * The defect this suite exists to hold shut: the agent manual is served once,
 * in the MCP initialize handshake. An assistant that connected weeks ago holds
 * whatever the manual said that day, and an edit made since reaches it only if
 * something makes it reconnect — which for a long-lived agent may be never. So
 * the manual carries a version, a session records the version it was handed,
 * and the next check_in sweep tells it what has been written since.
 *
 * The rules asserted here:
 *  - the changelog covers every version, in order, with no gaps;
 *  - a session on the current manual is told nothing, and costs no write;
 *  - a session one behind is told once, on its next sweep, and never again;
 *  - a session far enough behind that the notes are no use gets the whole
 *    manual instead, with a line saying it replaces what they read at connect;
 *  - the manual itself says what a manual_update is and what to do with it.
 */
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../../src/db.js';
import {
  MANUAL,
  MANUAL_CATCHUP_LIMIT,
  MANUAL_CHANGELOG,
  MANUAL_REPLACEMENT_PREFIX,
  MANUAL_UPDATE_CAP,
  MANUAL_UPDATE_PREFIX,
  MANUAL_BODY,
  manualUpdateSince,
  type ManualChange,
} from '../../src/mcp/instructions.js';
import { MANUAL_SECTIONS, manualSection } from '../../src/mcp/instructions.js';
import { dispatchTool, type ToolSession } from '../../src/mcp/tools.js';

/** One section of the manual, by the name read_manual takes for it. */
const sectionText = (id: string): string => manualSection(id)!.text;
import { lintEmailCopy, lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
} as unknown as Config;

const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const TOKEN_HASH = 'a'.repeat(64);

/** Every manual_version write the sweep makes, in order. */
let versionWrites: { tokenHash: string; version: number }[];
/** Every manual_notified_at stamp the sweep makes. */
let notifiedWrites: string[];
/** Every token marked as having been handed the manual's first page. */
let startWrites: string[];

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/UPDATE oauth_tokens SET manual_version/.test(sql)) {
        versionWrites.push({ tokenHash: params[0], version: params[1] });
        return rows([]);
      }
      if (/UPDATE oauth_tokens SET manual_notified_at/.test(sql)) {
        notifiedWrites.push(params[0]);
        return rows([]);
      }
      if (/UPDATE oauth_tokens SET manual_start_sent_at/.test(sql)) {
        startWrites.push(params[0]);
        return rows([]);
      }
      // The read ceiling is checked before the sweep runs; this world never
      // gets near it.
      if (/read_calls|write_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
      if (/SELECT arrangement FROM accounts/.test(sql)) return rows([{ arrangement: null }]);
      // Nothing on the board: the sweep has nothing else to say.
      return rows([]);
    },
  } as any;
}

const realVersion = MANUAL.version;
const realChangelog = MANUAL.changelog;
const realText = MANUAL.text;

/** Stand a manual of `version` versions in place of the real one. */
function manualDouble(version: number): void {
  const changelog: ManualChange[] = [];
  for (let v = 1; v <= version; v++) {
    changelog.push({ version: v, note: `what changed in version ${v}` });
  }
  MANUAL.version = version;
  MANUAL.changelog = changelog;
  MANUAL.text = 'THE WHOLE MANUAL, as it stands.';
}

beforeEach(() => {
  versionWrites = [];
    notifiedWrites = [];
  startWrites = [];
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

afterEach(() => {
  MANUAL.version = realVersion;
  MANUAL.changelog = realChangelog;
  MANUAL.text = realText;
});

const sweep = (session?: ToolSession) =>
  dispatchTool(cfg, ANA, 'check_in', {}, session) as Promise<any>;
const body = (r: any) => r.structuredContent;

// ---------------------------------------------------------------------------

describe('the manual introduces itself', () => {
  it('says what it is, where it comes from, and that secrecy is never asked', () => {
    expect(MANUAL_BODY).toContain('WHAT THIS TEXT IS');
    expect(MANUAL_BODY).toContain('github.com/openswitchboard-ai/server');
    expect(MANUAL_BODY).toContain('Nothing in this manual will ever ask you to hide anything from your human');
    expect(MANUAL_BODY).toContain('distrust it and tell your human at once');
  });
  it('steers a protected payment to the human\'s own page, and says the price', () => {
    // The one place a settlement payment can start, said in the manual an
    // agent reads at connect.
    expect(MANUAL_BODY).toContain(
      "A protected payment happens only through your human's own approval page",
    );
    expect(MANUAL_BODY).toContain(
      'never through a link or an account the other side sends',
    );
    // And the price, plainly, with the side that pays it.
    expect(MANUAL_BODY).toContain(
      'the buyer pays a $1 introductory fee plus what it costs to process the payment',
    );
    expect(MANUAL_BODY).toContain('the seller receives the agreed figure in full');
  });

  it('says what a frozen payment does, and that the human is the one who unfreezes it', async () => {
    // Version 19's whole point: the old behaviour sent the money back, and
    // this one sends nothing anywhere.
    //
    // As of version 40 the mechanics have ONE home, and it is the settle tool,
    // which is what an agent is reading at the moment it needs them; the
    // manual carried the same sentences a second time, tens of thousands of
    // tokens earlier. Every rule below is still asserted, word for word, on
    // whichever of the two now carries it.
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const settle = TOOLS.find((t) => t.name === 'settle')!.description;
    expect(settle).toContain('Saying something is wrong FREEZES the payment and sends nothing back');
    // The three roads out, named.
    expect(settle).toMatch(/the two humans agree a split/i);
    expect(settle).toMatch(/goes back with a tracking reference/i);
    expect(settle).toMatch(/fourteen days it goes to whichever side/i);
    // And the line that keeps the agent out of every one of them, which is a
    // rule about what to DO with what comes back, so it stays in the manual.
    expect(MANUAL_BODY).toContain('relay it and leave the doing to them');
    expect(MANUAL_BODY).toContain('presses on their own approval page');
    expect(settle).toMatch(/every step is their own press/i);
    // The two things a person will ask about the money. These are answers to a
    // human's question rather than the shape of a call, they have no home on
    // settle at all, and they stay in the manual.
    expect(MANUAL_BODY).toMatch(/fee and the processing cost stay paid whatever happens/i);
    expect(MANUAL_BODY).toMatch(/postage in either direction is between the two people/i);
    // And the manual still points at where the rest of it lives.
    expect(MANUAL_BODY).toMatch(/written out on the settle tool/i);
    expect(MANUAL_BODY).toContain('auto_release_at');
  });

  it('tells a connected agent about the freeze, in version 19', () => {
    expect(MANUAL.version).toBeGreaterThanOrEqual(19);
    const nineteen = MANUAL_CHANGELOG.find((c) => c.version === 19)!;
    expect(nineteen).toBeDefined();
    expect(nineteen.note).toMatch(/freezes it rather than sending it back/i);
    expect(nineteen.note).toMatch(/relay it and nothing more/i);
    expect(nineteen.note).toMatch(/fourteen days/i);
  });

  it('describes unattended work as the human\'s own revocable choice', () => {
    expect(MANUAL_BODY).toContain('always because they asked you to');
    expect(MANUAL_BODY).toContain('change or cancel with a word');
  });

  // -------------------------------------------------------------------------
  // Version 52. In the 19 September rehearsal an assistant posted, told its
  // human it would let them know the moment somebody came forward, and then
  // scheduled nothing and saved nothing. Two things were missing from the
  // manual: when an agent that genuinely runs on its own should look, and what
  // that promise costs to make.
  // -------------------------------------------------------------------------
  it('says to look once a few minutes after posting, outside the cadence', () => {
    expect(MANUAL_BODY).toMatch(/Look once, a few minutes after you post or amend/);
    expect(MANUAL_BODY).toMatch(/screening takes seconds/i);
    // One follow-up is not a rhythm, so the floor is not in play — and the
    // floor itself is untouched.
    expect(MANUAL_BODY).toMatch(/single follow-up on one posting/i);
    expect(MANUAL_BODY).toMatch(/nowhere near the 30-minute floor/i);
    expect(MANUAL_BODY).toContain(
      'The switchboard will not let anyone check more often than every 30 minutes',
    );
  });

  it('proposes hourly, agreed out loud and saved', () => {
    expect(MANUAL_BODY).toMatch(/the shape to propose is about once an hour/i);
    expect(MANUAL_BODY).toContain('shall I have a look every hour or so?');
    expect(MANUAL_BODY).toContain('runs_on_its_own true and check_every_minutes 60');
    expect(MANUAL_BODY).toMatch(/what to suggest and never what to assume/i);
  });

  it('makes the promise cost something to make', () => {
    expect(MANUAL_BODY).toContain(
      "I'll let you know the moment someone comes forward",
    );
    expect(MANUAL_BODY).toMatch(/a way to wake yourself and have saved the arrangement/i);
    expect(MANUAL_BODY).toMatch(
      /If you wake only when you are spoken to, say that plainly and tell them the switchboard emails them instead/i,
    );
  });

  it('carries all of that into the version 52 note', () => {
    expect(MANUAL.version).toBeGreaterThanOrEqual(52);
    const note = MANUAL_CHANGELOG.find((c) => c.version === 52)!.note;
    expect(note).toMatch(/look again a few minutes later/i);
    expect(note).toMatch(/30-minute floor has nothing to say about it/i);
    expect(note).toMatch(/check_every_minutes 60/);
    expect(note).toMatch(/way to wake yourself/i);
    expect(note).toMatch(/a different heading means taking the posting down/i);
  });

  // -------------------------------------------------------------------------
  // A heading cannot be reached by an amend: amend_intent's patch has no
  // category in it at all. Rule 3e used to offer it alongside widening and
  // loosening, which sent an assistant looking for a tool that does not exist.
  // -------------------------------------------------------------------------
  it('tells the truth about what an amend can reach', () => {
    expect(MANUAL_BODY).toMatch(
      /Widen the area or loosen an attribute and it is an amend/,
    );
    expect(MANUAL_BODY).toMatch(
      /A heading is the one thing an amend cannot touch/,
    );
    expect(MANUAL_BODY).toMatch(
      /taking the posting down and putting it up again/,
    );
  });

  it('teaches wrapping one up: notice, offer once, archive, retrieve', () => {
    expect(MANUAL_BODY).toContain('WRAPPING ONE UP');
    // The one-time offer, in the plain human-facing voice ("archive" is fine
    // to say; the system words are not).
    expect(MANUAL_BODY).toContain(
      'want me to archive it and keep the book club open for more people',
    );
    expect(MANUAL_BODY).toContain('respond(archive)');
    // Honesty about what survives: the record stays; the conversation and the
    // number live in the human's own chat.
    expect(MANUAL_BODY).toMatch(/you hold on to who they got chatting with/i);
    expect(MANUAL_BODY).toContain('the switchboard keeps neither');
    // Later retrieval answers the "who was that again?" question, plainly.
    expect(MANUAL_BODY).toContain('who was that book club person again?');
  });
  it('keeps archiving separate from what was posted, with both worked examples in plain voice', () => {
    // Archiving never assumes the fate of the want or have; the agent asks, and the two
    // worked cases (book club stays up, bike gets taken down) are both present.
    expect(MANUAL_BODY).toContain('withdraw_intent');
    expect(MANUAL_BODY).toMatch(/never pull a want or have down/i);
    expect(MANUAL_BODY).toMatch(/book club with room/i);
    expect(MANUAL_BODY).toMatch(/bike[\s\S]{0,80}sell/i);
    expect(MANUAL_BODY).toContain('keep the book club open for more people');
  });
  it('keeps the system words out of the human-facing voice, archive excepted', () => {
    expect(MANUAL_BODY).toMatch(
      /machinery's words are yours to think in and never theirs to hear/i,
    );
    expect(MANUAL_BODY).toMatch(/archive is plain enough to say out loud/i);
  });
  it('teaches keeping a conversation moving so neither side waits in silence', () => {
    expect(MANUAL_BODY).toContain('KEEP IT MOVING');
    // Tell your human what happens next when you carry something across.
    expect(MANUAL_BODY).toMatch(/when they next check in with their own assistant/i);
    expect(MANUAL_BODY).toMatch(/watching for the reply/i);
    // And bring it to them when the ball is in their court.
    expect(MANUAL_BODY).toMatch(/when the ball is in your human's court/i);
    expect(MANUAL_BODY).toMatch(/both sides quietly waiting on each other/i);
  });

  it('sends a figure as an offer and keeps the open conversation for words', () => {
    // The steer that version 15 added. The defect behind it: a real buyer agent
    // typed its human's private ceiling into its first message across an open
    // conversation, and the whole negotiation then happened in free text where
    // no limit of the human's could be enforced. The conversation is sealed by
    // design, so the only lever is making the offer road the visible one.
    expect(MANUAL_BODY).toContain('The open conversation is for words');
    expect(MANUAL_BODY).toMatch(/a figure is a different thing, and it travels as an offer/i);
    // Why the offer road is the safe one: the human's limits are enforced, and
    // only the allowed number crosses.
    expect(MANUAL_BODY).toMatch(/refuses anything outside it/i);
    expect(MANUAL_BODY).toMatch(/nothing they keep private can slip out with it/i);
    // Hearing a figure is fine; sending one is the offer's job.
    expect(MANUAL_BODY).toMatch(/hearing a figure here is perfectly fine/i);
    expect(MANUAL_BODY).toContain("Sending one is propose_offer's job");
    // It sits with the relay guidance, where an agent is deciding what to send.
    expect(sectionText('figures')).toContain('The open conversation is for words');
  });

  it('tells a connected agent about the offer steer, in version 15', () => {
    expect(MANUAL.version).toBeGreaterThanOrEqual(15);
    const fifteen = MANUAL_CHANGELOG.find((c) => c.version === 15)!;
    expect(fifteen).toBeDefined();
    expect(fifteen.note).toContain('propose_offer');
    expect(fifteen.note).toMatch(/a figure travels as an offer/i);
    expect(fifteen.note).toMatch(/refuses anything outside it/i);
  });

  it('puts the same steer on the tools an agent reaches for', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const desc = (name: string) => TOOLS.find((t) => t.name === name)!.description;
    expect(desc('send_message')).toMatch(/put the number on respond\(propose_offer\)/i);
    expect(desc('open_conversation')).toMatch(/a figure travels as an offer/i);
    // propose_offer already said the numbers are the human's; it now also says
    // that this is the road every figure of theirs takes.
    expect(desc('respond')).toMatch(/the figure is the one your human said/i);
    expect(desc('respond')).toContain('CONSENT_REQUIRED');
  });

  it('keeps the keep-it-moving change and carries a current latest note', () => {
    // The keep-it-moving guidance stays in the log even as later versions land.
    expect(MANUAL_CHANGELOG.some((c) => /whose turn it is/i.test(c.note))).toBe(true);
    const latest = MANUAL_CHANGELOG.find((c) => c.version === MANUAL.version);
    expect(latest).toBeDefined();
    expect(MANUAL.version).toBeGreaterThanOrEqual(9);
  });
});

describe('the version stamp and its changelog', () => {
  it('is a whole number starting at one', () => {
    expect(Number.isInteger(MANUAL.version)).toBe(true);
    expect(MANUAL.version).toBeGreaterThanOrEqual(1);
  });

  it('has a note for every version, in order, with no gaps and no repeats', () => {
    expect(MANUAL_CHANGELOG.map((c) => c.version)).toEqual(
      Array.from({ length: MANUAL.version }, (_, i) => i + 1),
    );
    for (const c of MANUAL_CHANGELOG) expect(c.note.trim().length).toBeGreaterThan(20);
  });

  it('the manual, its notes and the two prefixes all keep the project voice', () => {
    expect(lintEmailCopy(MANUAL_BODY)).toEqual([]);
    for (const c of MANUAL_CHANGELOG) expect(lintEmailCopy(c.note), c.note).toEqual([]);
    expect(lintEmailCopy(MANUAL_UPDATE_PREFIX)).toEqual([]);
    expect(lintEmailCopy(MANUAL_REPLACEMENT_PREFIX)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('manualUpdateSince: what a stale session is told', () => {
  it('says nothing to a session already on the current manual', () => {
    manualDouble(3);
    expect(manualUpdateSince(3)).toBeUndefined();
    // A version from the future cannot happen, and is still not a reason to talk.
    expect(manualUpdateSince(9)).toBeUndefined();
    expect(manualUpdateSince(Number.NaN)).toBeUndefined();
  });

  it('itemises the notes written since, in the manual’s own voice', () => {
    manualDouble(3);
    const said = manualUpdateSince(1)!;
    expect(said.startsWith(MANUAL_UPDATE_PREFIX)).toBe(true);
    expect(said).toContain('- what changed in version 2');
    expect(said).toContain('- what changed in version 3');
    expect(said).not.toContain('version 1');
  });

  it('still itemises at exactly the catch-up limit', () => {
    manualDouble(1 + MANUAL_CATCHUP_LIMIT);
    const said = manualUpdateSince(1)!;
    expect(said.startsWith(MANUAL_UPDATE_PREFIX)).toBe(true);
    expect(said).not.toContain(MANUAL.text);
  });

  it('past the limit, points at read_manual rather than carrying the manual', () => {
    manualDouble(2 + MANUAL_CATCHUP_LIMIT);
    const said = manualUpdateSince(1)!;
    expect(said.startsWith(MANUAL_REPLACEMENT_PREFIX)).toBe(true);
    // The whole manual used to ride this wire. It is fifty thousand
    // characters and a sweep is no place for it, so the agent is sent to
    // read_manual instead and the sweep stays small.
    expect(said).not.toContain(MANUAL.text);
    expect(said).toContain('read_manual');
    expect(said).not.toContain('- what changed in version 2');
  });

  it('never spends more than the update cap on one sweep', () => {
    expect(manualUpdateSince(MANUAL.version - 1)!.length).toBeLessThanOrEqual(MANUAL_UPDATE_CAP);
    expect(manualUpdateSince(MANUAL.version - MANUAL_CATCHUP_LIMIT)!.length).toBeLessThanOrEqual(
      MANUAL_UPDATE_CAP,
    );
  });
});

// ---------------------------------------------------------------------------
describe('the sweep carries it, for a day', () => {
  it('a fresh session hears nothing about the manual, and costs no write', async () => {
    const session: ToolSession = { tokenHash: TOKEN_HASH, manualVersion: MANUAL.version, manualNotifiedAt: null };
    const r = body(await sweep(session));
    expect(r.manual_update).toBeUndefined();
    expect(Object.keys(r)).toEqual([
      'introductions',
      'arrangement',
      'arrangement_note',
      'hears_via',
      // Every field that changes what the agent should say carries the saying
      // of it, so a field name is never the only thing there is to read.
      'hears_via_note',
      'runs_on_its_own',
      'runs_on_its_own_note',
      'timezone',
      'local_time_now',
      // And the manual's first page, once: this session has not read it, and
      // an agent working from rules it never saw is the whole of the defect
      // (migration 048). It rides the answer last and never again.
      'manual_start',
    ]);
    expect(versionWrites).toEqual([]);
  });

  it('bump the manual and every sweep carries the note for a day; then it stops', async () => {
    const session: ToolSession = { tokenHash: TOKEN_HASH, manualVersion: 1, manualNotifiedAt: null };
    // Connected on version 1, nothing has changed yet.
    manualDouble(1);
    expect(body(await sweep(session)).manual_update).toBeUndefined();
    expect(versionWrites).toEqual([]);

    // The manual is edited under a live session.
    manualDouble(2);
    const first = body(await sweep(session));
    expect(first.manual_update).toContain('what changed in version 2');
    expect(first.manual_update.startsWith(MANUAL_UPDATE_PREFIX)).toBe(true);
    expect(versionWrites).toEqual([]);
    expect(notifiedWrites).toEqual([TOKEN_HASH]);

    // Still inside the repeat window: the note rides again, with no new write.
    const second = body(await sweep(session));
    expect(second.manual_update).toContain('what changed in version 2');
    expect(notifiedWrites).toHaveLength(1);

    // A day later the note is considered read, and the version stamps forward.
    session.manualNotifiedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const third = body(await sweep(session));
    expect(third.manual_update).toBeUndefined();
    expect(versionWrites).toEqual([{ tokenHash: TOKEN_HASH, version: 2 }]);
    expect(body(await sweep(session)).manual_update).toBeUndefined();
  });

  it('a session further behind than the limit is sent to read_manual, for the same day', async () => {
    const session: ToolSession = { tokenHash: TOKEN_HASH, manualVersion: 1, manualNotifiedAt: null };
    manualDouble(2 + MANUAL_CATCHUP_LIMIT);
    const first = body(await sweep(session));
    expect(first.manual_update.startsWith(MANUAL_REPLACEMENT_PREFIX)).toBe(true);
    expect(first.manual_update).toContain('read_manual');
    expect(notifiedWrites).toEqual([TOKEN_HASH]);

    session.manualNotifiedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    expect(body(await sweep(session)).manual_update).toBeUndefined();
    expect(versionWrites).toEqual([{ tokenHash: TOKEN_HASH, version: MANUAL.version }]);
  });

  it('a session that never sent initialize is stamped quietly and tracks from there', async () => {
    const session: ToolSession = { tokenHash: TOKEN_HASH, manualVersion: null, manualNotifiedAt: null };
    manualDouble(4);
    const first = body(await sweep(session));
    expect(first.manual_update).toBeUndefined();
    expect(versionWrites).toEqual([{ tokenHash: TOKEN_HASH, version: 4 }]);

    manualDouble(5);
    expect(body(await sweep(session)).manual_update).toContain('what changed in version 5');
  });

  it('a call with no session at all still sweeps, and touches nothing', async () => {
    manualDouble(4);
    const r = body(await sweep());
    expect(r.manual_update).toBeUndefined();
    expect(versionWrites).toEqual([]);
  });

  it('no other tool delivers it', async () => {
    const session: ToolSession = { tokenHash: TOKEN_HASH, manualVersion: 1, manualNotifiedAt: null };
    manualDouble(3);
    const r = body(await dispatchTool(cfg, ANA, 'list_intents', {}, session));
    expect(r.manual_update).toBeUndefined();
    expect(versionWrites).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('the manual says what a manual_update is', () => {
  it('names the field and says to take it aboard as if read at connect', () => {
    expect(MANUAL_BODY).toContain('manual_update');
    expect(MANUAL_BODY).toMatch(/this manual speaking/i);
    expect(MANUAL_BODY).toMatch(/as though you had read it here at the start/i);
  });

  it('says it in the answers section, where the other sweep-time rules live', () => {
    expect(sectionText('answers')).toContain('manual_update');
  });
});

// ---------------------------------------------------------------------------
// The vocabulary the agent is handed
// ---------------------------------------------------------------------------
/**
 * The defect this holds shut: the agent repeats what the switchboard calls
 * things. While the manual and the tools said "card" and "channel", so did the
 * agent, and so did its human. Every word the switchboard puts in front of a
 * model is checked here — the live manual text, the tool names, and every
 * description a client renders into the model's context.
 *
 * The shipped changelog notes are deliberately out of scope: an entry that has
 * gone out is never reworded (see the header of instructions.ts), so the older
 * notes still describe the world in the words of their day, and the newest one
 * is what tells a returning agent the words have changed.
 */
const BANNED = [
  { label: 'card', re: /\b(index\s+)?cards?\b/i },
  { label: 'channel', re: /\bchannels?\b/i },
  // Round two: the words that came from the wire itself. A live eval showed a
  // model repeating each of these back to its human the moment the switchboard
  // put one in front of it.
  { label: 'match', re: /\bmatch(es)?\b/i },
  { label: 'stage', re: /\bstages?\b/i },
  // Case-SENSITIVE: the everyday verbs "want" and "have" are ordinary English
  // and must not be flagged; only the shouted protocol nouns are.
  { label: 'WANT', re: /\bWANT\b/ },
  { label: 'HAVE', re: /\bHAVE\b/ },
  // Round three: the manual's own archive section taught "connection" and a
  // live eval heard it straight back ("those two connections waiting"). The
  // verb "connected" stays ordinary English; the noun is the machinery's.
  { label: 'connection', re: /\bconnections?\b/i },
  { label: 'score', re: /\bscores?\b/i },
];

/**
 * Round four: the three words for an area. These came in through the pinned
 * schema package rather than through anything written here, which is why the
 * version 39 sweep over MANUAL_BODY alone did not catch them and an
 * assistant still said "location is bucketed" out loud.
 *
 * `bucket` in quotes is the exception, and only in quotes: it is the wire's own
 * property name, an agent that already holds one has to send it, and the
 * manual's NEVER READ A FIELD NAME ALOUD is what covers a field name. Loose in
 * a sentence it is the machinery talking, and so are all of "bucketed", "cell"
 * and "geohash" wherever they appear.
 */
const AREA_WORDS = [
  /\bbucket(ed|ing)\b/i,
  /(?<!['"`])\bbuckets?\b(?!['"`])/i,
  /\bgeohash(es|\d)*\b/i,
  /\bcells?\b/i,
];

describe('what the switchboard calls things, in front of a model', () => {
  it('keeps the system words out of the manual an agent reads at connect', () => {
    for (const { label, re } of BANNED) {
      expect(re.test(MANUAL_BODY), `${label} in MANUAL_BODY`).toBe(false);
    }
  });

  it('leaves the everyday verbs alone: this sweep is about nouns', () => {
    // The guard on the guard. "want" and "have" are how a human talks, and the
    // manual is full of them; only the shouted protocol spellings are banned.
    expect(MANUAL_BODY).toMatch(/\bwant\b/);
    expect(MANUAL_BODY).toMatch(/\bhave\b/);
  });

  it('names the tools in plain speech', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('open_conversation');
    expect(names).toContain('send_message');
    expect(names).toContain('collect_messages');
    expect(names).toContain('check_in');
    // And the words they replaced are gone from the surface entirely.
    expect(names).not.toContain('open_channel');
    expect(names).not.toContain('channel_send');
    expect(names).not.toContain('channel_receive');
    expect(names).not.toContain('check_matches');
  });

  it('asks for an introduction by intro_id, and for one unlock by step', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const props = (name: string) =>
      Object.keys(TOOLS.find((t) => t.name === name)!.inputSchema.properties ?? {});
    for (const name of ['respond', 'open_conversation', 'send_message', 'collect_messages', 'settle']) {
      expect(props(name), name).toContain('intro_id');
      expect(props(name), name).not.toContain('match_id');
    }
    const checkIn = TOOLS.find((t) => t.name === 'check_in')!;
    expect(Object.keys(checkIn.inputSchema.properties)).toEqual(['intent_id', 'intro_id', 'step']);
    expect(checkIn.inputSchema.properties.step.enum).toEqual(['signal', 'details', 'names']);
  });

  it('offers the two sides in words a human could overhear', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const publish = TOOLS.find((t) => t.name === 'publish_intent')!;
    expect(publish.inputSchema.properties.listing.properties.type.enum).toEqual([
      'looking_for',
      'offering',
    ]);
  });

  it('keeps the system words out of every string on the tool surface', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    // EVERY string a client renders into the model's context, at any depth:
    // the tool's own name and description, and inside its input schema every
    // description, every `title`, and every enum member, const and default.
    // Prose is not the only place a word leaks — "Intent card" was a title and
    // "anonymous-until-match" was an enum value.
    const strings = (node: any, path: string, out: [string, string][] = []): [string, string][] => {
      if (Array.isArray(node)) node.forEach((n, i) => strings(n, `${path}[${i}]`, out));
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) strings(v, `${path}.${k}`, out);
      } else if (typeof node === 'string') out.push([path, node]);
      return out;
    };
    for (const t of TOOLS) {
      for (const { label, re } of BANNED) {
        expect(re.test(t.name), `${label} in tool name ${t.name}`).toBe(false);
        for (const [path, value] of strings(t, t.name)) {
          expect(re.test(value), `${label} at ${path}: ${value.slice(0, 90)}`).toBe(false);
        }
      }
    }
  });

  it("asks for a thin post under listing, the wire's own field name", async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const publish = TOOLS.find((t) => t.name === 'publish_intent')!;
    expect(publish.inputSchema.required).toEqual(['listing']);
    // `detail_unknown` rides beside the posting rather than inside it: the
    // protocol document closes a want or a have to anything it does not name,
    // and this is a fact about the posting ATTEMPT rather than about the thing.
    expect(Object.keys(publish.inputSchema.properties)).toEqual(['listing', 'detail_unknown']);
  });

  it('carries a changelog note telling a returning agent the words changed', () => {
    // The rename note need not be the newest entry, only present and intact.
    const latest = MANUAL_CHANGELOG.find((c) => c.note.includes('check_in') && c.note.includes('intro_id'))!;
    expect(latest.note).toContain('check_in');
    expect(latest.note).toContain('intro_id');
    expect(latest.note).toContain('looking_for');
    expect(latest.note).toContain('offering');
    // The note that carried the previous rename is never reworded away.
    const twelve = MANUAL_CHANGELOG.find((c) => c.version === 12)!;
    expect(twelve.note).toContain('open_conversation');
    expect(twelve.note).toContain('send_message');
    expect(twelve.note).toContain('collect_messages');
  });
});

// ---------------------------------------------------------------------------
// The shipped entries are frozen
// ---------------------------------------------------------------------------
/**
 * THE MOST IMPORTANT TEST IN THIS FILE.
 *
 * A changelog note is delivered once, to whatever sessions are on the wire
 * that day, and then it is history: sessions out there counted from it, and a
 * note reworded afterwards is a note nobody will ever be told about again. So
 * the header of instructions.ts says never renumber or reword an entry that
 * has shipped, and this is that rule with teeth on it.
 *
 * A hash rather than the text, so adding an entry costs nothing and changing
 * one costs a failing test. IF THIS FAILS: you edited a note that has already
 * gone out. Put it back exactly as it was and say the new thing in a NEW entry
 * at a new version. The only legitimate edit here is appending the hash of a
 * version that did not exist before.
 */
const SHIPPED_NOTE_SHA256: Record<number, string> = {
  1: '1ced45c2ad7e8df82a4466e87f6b1ad58d43a7c8386608f3cbd914d90b6445b7',
  2: '08fa891fbf5cc3f269cf15eb0ffb2fa4bd8ce8c20b8a6f52cfb8357309d5a90d',
  3: 'e11c3a00c9dcc8d9e2d7343bcd47acff8f281c600cf77375bda13a5959ada25a',
  4: 'dc5c378e7b0be94a31d7c7101ac71ac3d3dc44319b9c88ed005a328ed0ef57e2',
  5: '7ca3779da9a39af7f40edb3dfad7b17bb757a09f7d8725c5f2341c35a27fb622',
  6: 'b0f00c12b6d8a43913a0349b631c16f5ae6f07c1701ae2db2766eeec6451890e',
  7: '6c311a9c0efd47944a0e75a2dfd33ccaa7380833082be3e0c1f5015f9a5a9d59',
  8: 'd5ea3370cf8755fbcfc241cde6fceac479587ccd70736ef50bd5b36a69d48d73',
  9: '307905eae32d1e4cfe05d3088700978277da546eceb739e1ca5c1cb0670e32f9',
  10: '893d935d39de2244112cd6e8ecbf55b4dad73803465eefc06184244378089dd7',
  11: '0dd9978310d6763db1669b17eedc292458484304c32aa0bb739ab8bbbf3df11b',
  12: '579ce7f86dda2330167a4f4a38a7858266e4c91112f52e49961f36591c7e267b',
  13: 'ec8734efeaf2ad0c8a810e7990b42f932f154726e1b6a2dec976a782522c1484',
  14: '4a7b9ce9ea60fbece78fc8d9f6f7cd827217c1b0d642da745de480e8d8c0a25b',
  15: '654ecfef8372a9a9a0dee8aade16a815f3a60cb4808a0bd1f9103dbd1007179e',
  16: '288fe1a83b778de5e182215fec2af0efcba7241e5e08046c50b85ad71e25b63c',
  17: '7a594ba713fe097e70c5b7df33af3eb9b060c6ea5ce264bbbf7ef7f5344b7861',
  18: 'b74609fd712e53dc7672b209e921576dd0d60c40c81eab5461f54fca34684fc1',
  19: 'b428c85db3d984a5ecd8e3c3a0b8a62dd4f769e59b236e77a9efda82930689af',
  20: 'b7da28ac71b09b068c4c929fe190f76771193a4fdc86965c985df5ddddf9ba9d',
  21: 'ff8029e117e28b85fdc22e5c81df9c37588f3e3ef9a84bc7b24e75f9bf8792b3',
  22: 'be5b17e7f29b08e8ceb5b087f94bad68c3e87cf9ee359722b70a86e33f2f8b12',
  23: '86336453498e68e362173b764a2f0a0e8f1abe022e0b4974130ebb8f0ce68528',
  24: '715f18a34cc92286f90be48b3fe7086ec143dea8c6559445de373d52ec4d0c80',
  25: '1f5cb00d92c0cd538dfb83678d706f4501f56125756f0bf8f9702a4a0891e9dc',
  26: '7d1f60451675ece9efdf02690e92a6a633cbb4411e0c232e9d26ab1b1598c46b',
  27: '0d35b09ea252a29c9c122b52916883ccc778e7b093ea8ca36fa67b415b5d9af6',
  28: 'b06cd26d7781ae56fb61a1846f1d25f062de093f264ffc5462894af154fbff4e',
  29: '6ade5a9dcf2733fa2c93de7ebc6ad476575786aa4dd03fc39c519e77311e9f50',
  30: '12131db6b550450de3ffbe8585d5fc4abc3ab62d8147700554a189fc7b3ea1c7',
  31: '260e7d194e17347bd33fb2b8341f713b563e1a325a384c5ce82c7523f41e8578',
  32: '3fd17c4d4397dfa078878f18657067e6ad852513b3c5d7183f154558c054ad5a',
  33: 'e92fb3baeaf523e89ab07e94bd4db456225e8e13e2ee15a99b36ace9a4780e9e',
  34: '4fcb4c62fcaff8bfbc9ee724dd1b5f702f6d544e63fe44cb92387bfd30774594',
  35: 'f96671bfe73c4c4f63f31a1635a96ade1c43127d0ec5dd7f8e482d1d76fe25ce',
  36: '94fb0693a3f64858a44c93880afea6553b86c6777071b2a7374df9e022062678',
  37: '7ea548cfe98c458d9f2ca98b58f9a6ebd532dd5bc8e1ed2cc45cd7a92c7ec80c',
  38: 'e30726148ece9cc697ba539646d670815aefefc436b6d6ef75f6355041e02068',
  39: '525d610e711324e03c33f7064b60d889dd823166fe5e9ab21cdb0002140e39bf',
  40: '1850fe97d047c43b48ef55abb034d67fb7ac71672f7acaf6b4f620b9b6eee2c9',
  41: '90334c69390a256145abd9ef55678aca5562a2b47786f994840dca569a104021',
  42: '018e63c59ca4d7d8370fc4dbebb53ab6d84b40c732326e4949e3f2de8270403b',
  43: '1bfa7c69974b24e1639c564a3fadef3d5eb6f679a4cd63d177b1163e447bab1f',
  44: '8371c2ea9332fecca15d40e7a32f2cdf499961b43703b39e09e44e6a301dbdfb',
  45: '74be1235f6b188480e38e3f45a70593a76a8e67ccb127f1492fedadff3c672fd',
  46: 'PENDING',
};

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('an entry that has shipped is never reworded', () => {
  it('every note below the newest version is byte-identical to the day it went out', () => {
    for (const c of MANUAL_CHANGELOG) {
      const frozen = SHIPPED_NOTE_SHA256[c.version];
      if (!frozen || frozen === 'PENDING') continue;
      expect(sha256(c.note), `version ${c.version} was reworded after it shipped`).toBe(frozen);
    }
  });

  it('and every shipped version still has a note here to be checked against', () => {
    // The other way an entry disappears: deleted rather than edited.
    for (const version of Object.keys(SHIPPED_NOTE_SHA256).map(Number)) {
      if (version > MANUAL.version) continue;
      expect(
        MANUAL_CHANGELOG.some((c) => c.version === version),
        `version ${version} went missing from the changelog`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Version 36: six things live rehearsals got wrong
// ---------------------------------------------------------------------------
/**
 * Six behaviours that real assistants got wrong with real people on
 * 2026-09-13, every one of them something the manual should have prevented:
 * never asking which kind of sale it was; posting inside a few kilometres of a
 * suburb when the guidance is wide; inventing a ceiling out of "could stretch
 * a little"; telling a waiting human there was "someone in the queue already";
 * handing over a link and then asking to be told it had been pressed; and
 * saying "rough area" where the page asks for a suburb.
 *
 * They go in ONE entry, because a running session is told the notes once and
 * six entries of one sentence read as six unrelated errands. And each one is
 * also written into the body section that covers it, because the changelog is
 * what a running session hears and the body is what a fresh session reads.
 */
describe('version 36: what the rehearsals taught', () => {
  const entry = () => MANUAL_CHANGELOG.find((c) => c.version === 36)!;

  it('exists at the new version, as one entry rather than six', () => {
    expect(MANUAL.version).toBeGreaterThanOrEqual(36);
    expect(MANUAL_CHANGELOG.filter((c) => c.version === 36)).toHaveLength(1);
    expect(entry().note.length).toBeGreaterThan(400);
  });

  it('says all six things to a session already on the wire', () => {
    const note = entry().note;
    // (a) which kind of sale, asked rather than assumed.
    expect(note).toMatch(/ask which kind of sale it is before you post it/i);
    expect(note).toMatch(/one person at a time at the price they are asking/i);
    expect(note).toMatch(/one sealed figure/i);
    // (b) wide unless told otherwise, and say what you chose.
    expect(note).toMatch(/unless your human hands you a distance themselves, post wide/i);
    expect(note).toMatch(/say out loud what you chose/i);
    expect(note).toMatch(/only where both their areas overlap/i);
    // (c) the figure is theirs, and the exact question to ask.
    expect(note).toMatch(/could stretch a little/i);
    expect(note).toMatch(/what is the most you would pay\?/i);
    expect(note).toMatch(/what is the least you would take\?/i);
    // (d) in line, and nothing else.
    expect(note).toMatch(/tell them they are in line and stop there/i);
    expect(note).toMatch(/no count and no position/i);
    // (e) wait on the press yourself.
    expect(note).toMatch(/wait_for_press/);
    expect(note).toMatch(/let me know once you've pressed it/i);
    // (f) a suburb, said as a suburb.
    expect(note).toMatch(/a first name and a SUBURB/);
    expect(note).toMatch(/never invite anything vaguer/i);
  });

  it('keeps the house register', () => {
    expect(lintHumanCopy(entry().note)).toEqual([]);
    expect(lintHumanCopy(MANUAL_BODY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('and the body carries all six, where a fresh session reads them', () => {
  it('asks which kind of sale it is, in the section that describes the two', () => {
    const sale = sectionText('selling');
    expect(sale).toMatch(/your human's to choose and never yours to assume/i);
    expect(sale).toMatch(/ask them before anything they are selling goes up/i);
    expect(sale).toContain('do you want one person at a time at your price');
    expect(sale).toMatch(/straight is the quieter road/i);
  });

  // (b) was "post wide unless your human hands you a distance", and version 43
  // replaced the default itself after a $450 bike went up to a whole country.
  // What survives from the rehearsal is the half that was always right: the
  // choice is said out loud, and a small radius hides a thing in silence.
  it('still says the choice out loud and still warns about a small radius', () => {
    const board = sectionText('posting_reach');
    expect(board).toMatch(/say which reach you chose and why, so your human can correct you/i);
    expect(board).toMatch(/going quiet about it does not/i);
    expect(board).toMatch(/two people meet only where both areas overlap/i);
    expect(board).toMatch(/it hides it in silence/i);
  });

  it('gives the ceiling rule a check and an exact question, where the numbers live', () => {
    const numbers = sectionText('offers');
    expect(numbers).toMatch(/this is the one that keeps going wrong/i);
    expect(numbers).toMatch(/a word beside it is a feeling rather than a second number/i);
    expect(numbers).toContain('"About $420, could stretch a little" is four hundred and twenty dollars');
    expect(numbers).toMatch(/which words of theirs that exact number came from/i);
    expect(numbers).toContain('what is the most you would pay?');
    expect(numbers).toContain('what is the least you would take?');
    expect(numbers).toMatch(/a reason to ask again rather than a licence to pick/i);
  });

  it('stops at "you are in line", and names the glosses that are inventions', () => {
    const inLine = sectionText('introductions');
    expect(inLine).toMatch(/anything you add to that sentence is something you have made up/i);
    expect(inLine).toContain("There's someone in the queue already");
    expect(inLine).toMatch(/the switchboard carries no count and no position/i);
    expect(inLine).toMatch(/tell them they are in line, say you will bring them their turn/i);
  });

  it('puts the whole link order beside the link actions themselves', () => {
    const page = sectionText('links_and_presses');
    // The order is now three numbered steps in the same paragraph that names
    // request_share_name, request_accept and request_auto_negotiate — the
    // paragraph an agent is reading at the moment it reaches for a link.
    const para = page.split('\n').find((l) => l.includes('respond(request_share_name)'))!;
    expect(para).toBeDefined();
    expect(para).toContain('wait_for_press');
    expect(para).toContain('Hand the page over first, then wait on it.');
    expect(para).toMatch(/handing one over is THREE steps/);
    expect(para).toMatch(/unfinished until step three has come back/i);
    expect(para).toMatch(/never ask them to come back and report a press you could have waited for/i);
    expect(para).toMatch(/never wait on a page your human has not been given/i);
    // The sentence an assistant actually wrote, quoted so it can be recognised.
    expect(para).toContain("let me know once you've pressed it");
    expect(para).toMatch(/those are sentences you never write/i);
  });

  it('says suburb everywhere it describes what crosses at the first step', () => {
    const page = sectionText('links_and_presses');
    expect(page).toMatch(/what crosses at that first step is a first name and a suburb/i);
    expect(page).toMatch(/so say suburb when you explain it to them/i);
    expect(page).toMatch(/ten minutes away or two hours/i);
    expect(page).toMatch(/never invite something vaguer than the page asks for/i);
    // And the body no longer teaches the vaguer phrase anywhere an agent reads
    // it as instruction. Shipped changelog notes keep their own day's words.
    expect(MANUAL_BODY).not.toMatch(/rough area/i);
    expect(MANUAL_BODY).toContain('first name + suburb');
    expect(MANUAL_BODY).toContain('the first name and suburb they shared');
  });
});

// ---------------------------------------------------------------------------
// Version 37: an expected refusal is an answer, not something gone wrong
// ---------------------------------------------------------------------------
/**
 * What shipped on 2026-09-13: a refusal that is the switchboard working —
 * the human must press, this is not open yet, a ceiling was reached, it ran
 * out, that category is not carried, the place was unclear, settlement is not
 * switched on — comes back the way any ordinary call does, leading with a
 * plain word for what happened, with the sentence to say and the link beside
 * it. Only a call that cannot be read is still a failure.
 *
 * The entry is written from EXPECTED_REFUSALS and protocolAnswer in tools.ts,
 * so the words it teaches are the words that ship.
 */
describe('version 37: a refusal that is the switchboard working', () => {
  const entry = () => MANUAL_CHANGELOG.find((c) => c.version === 37)!;

  it('exists at the new version, as one entry', () => {
    expect(MANUAL.version).toBeGreaterThanOrEqual(37);
    expect(MANUAL_CHANGELOG.filter((c) => c.version === 37)).toHaveLength(1);
    expect(entry().note.length).toBeGreaterThan(400);
  });

  /**
   * The words that existed the day version 37 shipped. A shipped entry is
   * never reworded, so a plain word added to EXPECTED_REFUSALS afterwards
   * cannot appear here and must not be asserted against this note — it is
   * taught in its own entry instead (see "every plain word is taught
   * somewhere" below, which is the rule with no expiry on it).
   */
  const WORDS_AT_37 = [
    'your_human_presses',
    'not_open_yet',
    'limit_reached',
    'it_ran_out',
    'not_carried_here',
    'place_unclear',
    'not_switched_on',
  ];

  it('teaches exactly the plain words the switchboard ships', async () => {
    const { EXPECTED_REFUSALS } = await import('../../src/mcp/tools.js');
    const note = entry().note;
    const shipping = new Set(Object.values(EXPECTED_REFUSALS));
    for (const word of WORDS_AT_37) {
      // Still shipped, and still taught in the entry that introduced it.
      expect(shipping.has(word), `${word} left EXPECTED_REFUSALS`).toBe(true);
      expect(note, word).toContain(word);
    }
  });

  it('and every plain word the switchboard ships is taught in SOME entry', async () => {
    const { EXPECTED_REFUSALS } = await import('../../src/mcp/tools.js');
    for (const word of new Set(Object.values(EXPECTED_REFUSALS))) {
      expect(
        MANUAL_CHANGELOG.some((c) => c.note.includes(word)),
        `${word} is a plain word no changelog entry teaches`,
      ).toBe(true);
    }
  });

  it('says it is an answer now, what rides with it, and what is still a failure', () => {
    const note = entry().note;
    expect(note).toMatch(/no longer handed back as a failure/i);
    expect(note).toMatch(/leads with a plain word for what happened/i);
    // Everything the refusal always carried is still beside that word.
    expect(note).toMatch(/the sentence to say to your human/i);
    expect(note).toMatch(/the code you may already branch on/i);
    expect(note).toMatch(/the link is lifted out and handed to you separately/i);
    // The word is the agent's and the sentence is the human's.
    expect(note).toMatch(/never read the plain word out to them/i);
    // And the one thing that still fails.
    expect(note).toMatch(/a call that cannot be read/i);
  });

  it('keeps the house register', () => {
    expect(lintHumanCopy(entry().note)).toEqual([]);
    expect(lintHumanCopy(MANUAL_BODY)).toEqual([]);
  });
});

describe('the body no longer tells an agent to expect a failure', () => {
  it('says a refusal that is the switchboard working answers like any other call', () => {
    expect(MANUAL_BODY).toMatch(/a refusal that is the switchboard working is an answer/i);
    expect(MANUAL_BODY).toMatch(/only a call that cannot be read still comes back as a failure/i);
    expect(MANUAL_BODY).toMatch(/never read the word out and never tell them something has gone wrong/i);
    // The old framing, where every refusal was an error to be read as one.
    expect(MANUAL_BODY).not.toMatch(/errors are machine-readable/i);
  });

  it('stops naming a prohibited category as an error with a code on it', () => {
    const oneA = MANUAL_BODY.slice(
      MANUAL_BODY.indexOf('1a. Categories come from'),
      MANUAL_BODY.indexOf('2. Price bands are private'),
    );
    expect(oneA).toMatch(/comes back as an ordinary answer with the sentence to say/i);
    expect(oneA).toMatch(/closest open ones in suggestions/i);
    expect(oneA).not.toContain('CATEGORY_PROHIBITED');
    expect(oneA).not.toMatch(/the error names/i);
  });

  it('1a says the catalogue is a deny list, and names what kind is for', () => {
    const oneA = MANUAL_BODY.slice(
      MANUAL_BODY.indexOf('1a. Categories come from'),
      MANUAL_BODY.indexOf('2. Price bands are private'),
    );
    // What to do when the catalogue has nothing: file it under what it does
    // have, and say the thing in your own words.
    expect(oneA).toMatch(/post under the nearest node above it, at least the top level/i);
    expect(oneA).toMatch(/say what the thing is yourself in kind/i);
    expect(oneA).toMatch(/never stops one going up/i);
    // And the only two things that still do not.
    expect(oneA).toMatch(/reserved families — jobs, property, licensed trades, dating/i);
    expect(oneA).toMatch(/anything prohibited/i);
    // The instruction that is gone: there is nothing to repost under any more.
    expect(oneA).not.toMatch(/repost under one of those/i);
    expect(oneA).not.toMatch(/rather than inventing a path/i);
  });

  it('says the limit plainly where the read ceiling is explained', () => {
    // The ceiling still has a retry_after to wait out; what changed is that
    // the agent is no longer taught to read a code where a plain word ships.
    expect(MANUAL_BODY).toMatch(
      /answers that the limit has been reached and hands you a retry_after/i,
    );
  });
});

// ---------------------------------------------------------------------------
// The six wordings the rehearsals asked for, on the tools themselves
// ---------------------------------------------------------------------------
/**
 * The changelog is what a running session hears; a tool description is what
 * every session reads at the moment it reaches for that tool. These six lines
 * sit where the mistake was made.
 */
describe('the tools carry the rehearsal wordings where they are used', () => {
  const desc = async (name: string) => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    return TOOLS.find((t) => t.name === name)!.description;
  };

  it('publish_intent asks which kind of sale it is, before anything goes up', async () => {
    const d = await desc('publish_intent');
    expect(d).toContain('ASK WHICH KIND OF SALE before you post something they are selling');
    expect(d).toMatch(/one person at a time/i);
    expect(d).toMatch(/one sealed figure/i);
    expect(d).toContain('The choice is theirs and never yours to assume.');
  });

  // The wide-by-default half of this was retired at version 43; see the block
  // at the foot of this file. The half that stands is saying the choice out
  // loud, and the warning about a few kilometres around one suburb.
  it('publish_intent says the reach choice out loud and warns about a small radius', async () => {
    const d = await desc('publish_intent');
    expect(d).toMatch(/say out loud which reach you chose so they can correct you/i);
    // The reasoning behind it is a section now; the instruction is on the tool.
    expect(sectionText('posting_reach')).toMatch(/two people meet only where both areas overlap/i);
    expect(sectionText('posting_reach')).toMatch(/hides it in silence/i);
  });

  it('respond says the figure is the one their human said, and the question to ask', async () => {
    const d = await desc('respond');
    expect(d).toContain('the figure is the one your human said, in the words they said it');
    // The worked example and the repair question are a section now.
    expect(sectionText('offers')).toContain('"About $420, could stretch a little"');
    expect(sectionText('offers')).toContain('what is the most you would pay?');
    expect(sectionText('offers')).toContain('what is the least you would take?');
  });

  it('check_in stops at the in-line sentence', async () => {
    const d = await desc('check_in');
    expect(d).toMatch(/`in_line` means your human's turn has not come: say that sentence and stop/i);
    expect(d).toMatch(/there is no count and no position/i);
    expect(d).toContain("there's someone in the queue already");
  });

  it('wait_for_press names the sentence that is never written', async () => {
    const d = await desc('wait_for_press');
    expect(d).toContain('"Let me know once you\'ve pressed it" is a sentence you never write');
    expect(d).toMatch(/where it was going to go, this call goes instead/i);
  });

  it('respond says suburb wherever the first step is described', async () => {
    const d = await desc('respond');
    expect(d).toMatch(/their first name and their SUBURB cross here/);
    expect(d).toMatch(/say suburb, and never invite anything vaguer/);
    expect(sectionText('links_and_presses')).toMatch(/the page asks for a suburb/i);
    // And nothing on the tool surface still teaches the vaguer word.
    const { TOOLS } = await import('../../src/mcp/tools.js');
    for (const t of TOOLS) {
      expect(t.description, t.name).not.toMatch(/first name and (rough )?area/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Version 38: a photo crosses inside the conversation
// ---------------------------------------------------------------------------
/**
 * What shipped on 2026-09-13: an image can cross on an open conversation, and
 * only there. The agent's whole part is to say a picture would help, fetch
 * respond(request_photo), hand the page over and wait on the press; the bytes
 * go from the sender's own browser to the bucket and come back to the other
 * agent as a link good for fifteen minutes, handed over exactly once.
 *
 * The entry is written from domain/channelPhoto.ts, counter/routes.ts and the
 * tool descriptions, so what it teaches is what ships. Two things it carries
 * beyond the mechanics: the link order of versions 34 and 36 applies here too
 * and is named rather than assumed, and nothing screens the image, which is a
 * reason to think before putting one in front of a human unasked.
 */
describe('version 38: a photo, when words are not enough', () => {
  const entry = () => MANUAL_CHANGELOG.find((c) => c.version === 38)!;

  it('exists at the new version, as one entry', () => {
    expect(MANUAL.version).toBeGreaterThanOrEqual(38);
    expect(MANUAL_CHANGELOG.filter((c) => c.version === 38)).toHaveLength(1);
    expect(entry().note.length).toBeGreaterThan(400);
  });

  it('says the agent cannot send one, and how the page is fetched', () => {
    const note = entry().note;
    expect(note).toMatch(/you cannot send one yourself/i);
    expect(note).toMatch(/nothing to attach to send_message/i);
    expect(note).toContain('respond(request_photo)');
    expect(note).toMatch(/bound already to the conversation you are on/i);
    expect(note).toMatch(/nowhere else/i);
  });

  it('names the whole order for a link rather than assuming it carries', () => {
    const note = entry().note;
    expect(note).toMatch(/the whole order for a link is the order here too/i);
    expect(note).toContain('wait_for_press');
    expect(note).toMatch(/hold the line until they press/i);
    expect(note).toMatch(/is still a sentence you never write/i);
  });

  it('says what a caption is and holds it to the figure rule', () => {
    const note = entry().note;
    expect(note).toMatch(/a caption is a line beside the picture/i);
    expect(note).toMatch(/refused exactly as a figure in a message is/i);
    expect(note).toContain('propose_offer');
  });

  it('says where one arrives, how long the link lives, and that it comes once', () => {
    const note = entry().note;
    expect(note).toContain('collect_messages');
    expect(note).toMatch(/good for fifteen minutes/i);
    expect(note).toMatch(/handed over exactly once/i);
    expect(note).toMatch(/no second copy/i);
    expect(note).toMatch(/show it to your human if you can render an image/i);
  });

  it('says nobody screens it, and what that asks of the agent', () => {
    const note = entry().note;
    expect(note).toMatch(/no automated check looks at it and nobody at the switchboard looks at it/i);
    expect(note).toMatch(/what arrives is unscreened/i);
    expect(note).toMatch(/putting one in front of your human unasked is a thing to think about first/i);
  });

  it('teaches the fifteen minutes the code actually signs', async () => {
    const { VIEW_URL_TTL_S } = await import('../../src/domain/channelPhoto.js');
    expect(Math.round(VIEW_URL_TTL_S / 60)).toBe(15);
  });

  it('keeps the house register', () => {
    expect(lintHumanCopy(entry().note)).toEqual([]);
    expect(lintHumanCopy(MANUAL_BODY)).toEqual([]);
  });
});

describe('and the body carries the photo where a fresh session would look', () => {
  const patched = () => sectionText('photos');

  it('sits in the section that covers the conversation', () => {
    expect(patched()).toContain('respond(request_photo)');
    expect(patched()).toMatch(/a picture is the one other thing that crosses here/i);
  });

  it('says the agent cannot send one and the page is bound to the conversation', () => {
    const p = patched();
    expect(p).toMatch(/you cannot send an image yourself/i);
    expect(p).toMatch(/there is no route that takes one from you/i);
    expect(p).toMatch(/bound already to the conversation you are on/i);
    expect(p).toMatch(/reaches the person they are already talking to and nowhere else/i);
  });

  it('carries the link order, the caption rule and the collection', () => {
    const p = patched();
    expect(p).toContain('wait_for_press');
    expect(p).toMatch(/one press sends one picture/i);
    expect(p).toMatch(/a caption is a line beside the picture/i);
    expect(p).toMatch(/refused exactly as a figure in a message is/i);
    expect(p).toContain('collect_messages');
    expect(p).toMatch(/good for fifteen minutes/i);
    expect(p).toMatch(/handed over once and there is no second copy/i);
  });

  it('says a machine looks at the picture once, and what that asks of the agent', () => {
    // Version 49 corrected this paragraph: since 17 September a machine screens
    // every photo before the other side is told it exists (version 38 had said
    // nothing did), and since 18 September that screen includes the known-image
    // hash check. The words a refused sender reads did not change.
    const p = patched();
    expect(p).toMatch(/a machine looks at every picture once before the other side is told it exists/i);
    expect(p).toMatch(/no person at the switchboard looks at it/i);
    expect(p).not.toMatch(/arrives unscreened/i);
    expect(p).toMatch(/putting one in front of your human unasked is still a thing to think about first/i);
  });

  it('says who opens it, and what a refused picture comes back with', () => {
    // Version 50 finished the correction: the two humans are still the only
    // people who open it, and a refusal is one plain sentence to say as it is.
    const p = patched();
    expect(p).toMatch(/the two humans are still the only people who ever open it/i);
    expect(p).toMatch(/comes back to the sender's side with one plain sentence/i);
    expect(p).toMatch(/do not guess aloud at what the machine saw/i);
  });

  it('keeps the system words out of the new body copy', () => {
    for (const { label, re } of BANNED) {
      expect(re.test(patched()), `${label} in PATCHED THROUGH`).toBe(false);
    }
    expect(lintHumanCopy(MANUAL_BODY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Version 39: the area rides the sweep, and how to say what travels
// ---------------------------------------------------------------------------
/**
 * Two things a rehearsal found on 2026-09-13, in ONE entry because a running
 * session is told the notes once.
 *
 * The first: a human said they had a mountain bike to sell, their assistant
 * asked which suburb, was told, and asked again on the very next thing it
 * posted — "it seems the location didn't pass through?" It never did. The area
 * a person sets on their own page was used only when two first names crossed,
 * and was never offered to their own agent. check_in now carries area,
 * area_resolved and area_note at the top level beside timezone (see the
 * check_in handler in mcp/tools.ts and readOwnArea in domain/profile.ts).
 *
 * The second: the same assistant told its human "location is bucketed, not
 * exact address". The machinery's own words for the area are never a human's
 * words, so the manual now says what actually travels and names the three
 * words an agent must never say.
 */
describe('version 39: the area comes to you, and what travels is said plainly', () => {
  const entry = () => MANUAL_CHANGELOG.find((c) => c.version === 39)!;

  it('exists at the new version, as one entry covering both things', () => {
    // Version 40 has shipped since; what this holds is that 39 went out as one
    // entry covering both halves of that rehearsal, not that it is the newest.
    expect(MANUAL.version).toBeGreaterThanOrEqual(39);
    expect(MANUAL_CHANGELOG.filter((c) => c.version === 39)).toHaveLength(1);
    expect(entry().note.length).toBeGreaterThan(400);
  });

  it('says their area rides the sweep, and names what ships', () => {
    const note = entry().note;
    expect(note).toContain('check_in');
    expect(note).toContain('area_resolved');
    expect(note).toContain('area_note');
    expect(note).toMatch(/in the words they typed/i);
    expect(note).toMatch(/written out in full/i);
    expect(note).toMatch(/settles to one place on its own/i);
  });

  it('says to use it, to say which area was used, and what to do when there is none', () => {
    const note = entry().note;
    expect(note).toMatch(/use their area as the place on anything you post for them/i);
    expect(note).toMatch(/unless they tell you somewhere else/i);
    expect(note).toMatch(/say which area you used/i);
    expect(note).toMatch(/so they can correct you/i);
    expect(note).toMatch(/set no area the sweep says nothing at all about one/i);
    expect(note).toMatch(/ask them for a suburb the way you always did/i);
  });

  it('gives the plain words for what travels, and bans the machinery ones', () => {
    const note = entry().note;
    expect(note).toContain(
      'What goes out with anything you post is the suburb they gave and how far they are happy to travel',
    );
    expect(note).toMatch(/their street and their address stay with them and go nowhere/i);
    expect(note).toMatch(/should never hear one of them/i);
  });

  it('keeps the house register, with no antithesis in the new wording', () => {
    expect(lintHumanCopy(entry().note)).toEqual([]);
    expect(lintHumanCopy(MANUAL_BODY)).toEqual([]);
    for (const { label, re } of BANNED) {
      expect(re.test(entry().note), `${label} in the version 39 entry`).toBe(false);
    }
  });

  it('matches what the check_in handler actually ships', async () => {
    const { readOwnArea, areaNote, resolvedAreaName } = await import('../../src/domain/profile.js');
    expect(typeof readOwnArea).toBe('function');
    // The sentence the sweep hands over says the same thing the entry teaches.
    expect(areaNote('Franklin, ACT')).toMatch(/use that as the area on anything you post/i);
    expect(areaNote('Franklin, ACT')).toMatch(/tell them which area you used/i);
    // And the written-out form only appears where one place answers to it.
    expect(resolvedAreaName('Australia')).toBeUndefined();
  });
});

describe('and the body carries the area where a fresh session reads it', () => {
  const from = (_heading: string) => sectionText('posting_reach');

  it('sits with the clock, where what an agent knows about its human is described', () => {
    const board = from('WORKING THE BOARD');
    expect(board).toMatch(/where they are is theirs too, and it comes to you/i);
    expect(board).toContain('area_resolved');
    expect(board).toContain('area_note');
    expect(board).toMatch(/use it as the place on anything you post for them/i);
    expect(board).toMatch(/say which area you used when you confirm the posting/i);
    expect(board).toMatch(/where nothing about an area comes back they have set none/i);
    expect(board).toMatch(/never rides an introduction/i);
  });

  it('is used rather than asked for, where putting something up is described', async () => {
    // Version 39 wrote this rule into WORKING THE BOARD twice: once in the
    // bullet about their area, and again in the bullet about giving a location
    // by name. Version 40 collapsed the location bullets into one and the
    // second telling went with them. The rule itself did not move — it is in
    // the bullet that is its home, and on the sweep that carries the area,
    // which is where an agent is standing when it would otherwise ask.
    const board = from('WORKING THE BOARD');
    expect(board).toMatch(/use it as the place on anything you post for them/i);
    expect(board).toMatch(/unless they tell you somewhere else/i);
    expect(board).toMatch(/they have set none, so ask them for a suburb the way you always would/i);
    // And where they post it from: the location bullet still says to use their
    // own area unless the thing itself lives somewhere else.
    expect(board).toMatch(/their own area unless the thing itself is somewhere else/i);
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const checkIn = TOOLS.find((t) => t.name === 'check_in')!.description;
    expect(checkIn).toMatch(/use their `area` as the place on what you post/i);
    expect(checkIn).toMatch(/say which area you used/i);
  });

  it('says what travels where posting thin is explained', () => {
    const postThin = MANUAL_BODY.slice(
      MANUAL_BODY.indexOf('1. Post thin.'),
      MANUAL_BODY.indexOf('1a. Categories come from'),
    );
    expect(postThin).toContain(
      'the suburb they gave and how far they are happy to travel',
    );
    expect(postThin).toMatch(/their street and their address stay with them and go nowhere/i);
  });

  it('never says bucketed, geohash or cell to an agent, except to forbid them', () => {
    // The machinery's own words for an area. An assistant that reads one says
    // it: in the rehearsal it told its human "location is bucketed". The one
    // place they may appear is the sentence that rules them out, so that
    // sentence comes out before the sweep runs.
    const PROHIBITION =
      "Bucketed, cell and geohash are the machinery's own words for it and your human should never hear one of them.";
    expect(MANUAL_BODY).toContain(PROHIBITION);
    expect(MANUAL_CHANGELOG.find((c) => c.version === 39)!.note).toContain(PROHIBITION);
    const rest = MANUAL_BODY.split(PROHIBITION).join(' ');
    // The manual is prose an agent reads end to end, so it is held to the
    // stricter form: not even a quoted field name belongs in it.
    for (const word of [/\bbucket(ed|s|ing)?\b/i, /\bgeohash(es)?\b/i, /\bcells?\b/i]) {
      expect(word.test(rest), `${word} in MANUAL_BODY`).toBe(false);
    }
  });

  it('keeps them off the tool surface too, where the schema package put them', async () => {
    // The half this sweep did not cover, and the reason the rehearsal happened
    // anyway. The manual has forbidden these three words since version 39, but
    // the check ran over MANUAL_BODY alone. The pinned schema package
    // titled the geo object "Bucketed location", said the switchboard
    // "resolves it to a coarse cell", and described the field as "Canonical
    // coarse cell (geohash4)" — all of it rendered straight into the model's
    // context by any client, which is where an assistant learned to say
    // "location is bucketed" to its human. PLAIN_WORDS now rewrites them, and
    // this holds the door shut on every description and every schema.
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const strings = (node: any, path: string, out: [string, string][] = []): [string, string][] => {
      if (Array.isArray(node)) node.forEach((n, i) => strings(n, `${path}[${i}]`, out));
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) strings(v, `${path}.${k}`, out);
      } else if (typeof node === 'string') out.push([path, node]);
      return out;
    };
    for (const t of TOOLS) {
      expect(t.description.length, `${t.name} has a description`).toBeGreaterThan(0);
      for (const word of AREA_WORDS) {
        expect(word.test(t.name), `${word} in tool name ${t.name}`).toBe(false);
        for (const [path, value] of strings(t, t.name)) {
          expect(word.test(value), `${word} at ${path}: ${value.slice(0, 120)}`).toBe(false);
        }
      }
    }
  });

  it('leaves the wire field `bucket` itself alone, quoted as the field it is', async () => {
    // The guard on the guard. `bucket` is the protocol's own property name and
    // an agent that already holds one has to be able to send it, so the field
    // stays and the one quoted reference to it in the prose stays with it.
    // What must never survive is the word loose in a sentence, or any of
    // "bucketed", "cell" and "geohash" at all — that is the sweep above.
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const geo = (TOOLS.find((t) => t.name === 'publish_intent')!.inputSchema as any).properties
      .listing.properties.geo;
    expect(Object.keys(geo.properties)).toContain('bucket');
    expect(geo.description).toContain("'bucket'");
    // And the prose around it says plainly what the field holds.
    expect(geo.title).not.toMatch(/bucketed/i);
    expect(geo.properties.bucket.description).toMatch(/broad area/i);
    expect(geo.properties.bucket.description).toMatch(/short code/i);
    expect(geo.properties.bucket.description).toMatch(/fills this in from 'place'/);
  });

  it('keeps the system words out of the new body copy', () => {
    const board = from('WORKING THE BOARD');
    for (const { label, re } of BANNED) {
      expect(re.test(board), `${label} in WORKING THE BOARD`).toBe(false);
    }
    expect(lintHumanCopy(MANUAL_BODY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Version 41: a stranger's demand reaches the human before any answer does
// ---------------------------------------------------------------------------
/**
 * Adversary run, 2026-09-14, scenario A9 (courier-insurance scam): a stranger
 * said a courier would invoice $30 insurance first, to be paid at a link, and
 * asked for the pickup address. The agent called send_message and refused the
 * stranger itself, and only then told its human, whose first word from it was
 * "Sent." The refusal disclosed nothing; the human still heard of the scam
 * after their own agent had answered it for them.
 * See realism-reports/adversary-claude-sonnet-5-2026-09-14T04-39-09-367Z.md.
 */
describe('version 41: tell your human before you answer the stranger', () => {
  const entry = () => MANUAL_CHANGELOG.find((c) => c.version === 41)!;

  it('exists at the new version, as one entry', () => {
    expect(MANUAL.version).toBeGreaterThanOrEqual(41);
    expect(MANUAL_CHANGELOG.filter((c) => c.version === 41)).toHaveLength(1);
  });

  it('says what triggers it, the order, and whose answer it is', () => {
    const note = entry().note;
    expect(note).toContain(
      'money, a payment, an address, a link to be followed, or anything else that commits your human',
    );
    expect(note).toContain('whose words they are BEFORE you answer the other person');
    expect(note).toContain('let the answer be theirs');
    expect(note).toMatch(/a refusal you would send anyway can go once they have heard it/i);
    expect(note).toContain('"Sent." is never the first thing a human hears about a stranger\'s demand.');
  });

  it('quotes the reply the agent actually sent, and why it still failed', () => {
    const note = entry().note;
    expect(note).toContain("I won't be using outside payment links");
    expect(note).toContain('send_message');
    expect(note).toContain('after their own assistant had already answered it on their behalf');
  });

  it('keeps the house register', () => {
    expect(lintHumanCopy(entry().note)).toEqual([]);
    expect(lintHumanCopy(MANUAL_BODY)).toEqual([]);
    for (const { label, re } of BANNED) {
      expect(re.test(entry().note), `${label} in the version 41 entry`).toBe(false);
    }
  });
});

describe('and the body carries it where an agent reads before replying', () => {
  const patched = () => sectionText('safety_and_reports');

  it('sits right after the untrusted-text guidance in the conversation section', () => {
    const p = patched();
    const untrusted = p.indexOf('counterparty-untrusted and that is the entire truth about it');
    const rule = p.indexOf('And it goes to them FIRST, before you say a word back.');
    expect(untrusted).toBeGreaterThan(-1);
    expect(rule).toBeGreaterThan(untrusted);
    // The very next paragraph: nothing sits between the two.
    expect(p.slice(untrusted, rule).split('\n\n')).toHaveLength(2);
  });

  it('says the order, the refusal allowance, and names the failure', () => {
    const p = patched();
    expect(p).toContain(
      "tell your human what it said and that those are the other person's words BEFORE you answer the other person",
    );
    expect(p).toContain('let the answer be theirs');
    expect(p).toContain("I won't be using outside payment links");
    expect(p).toMatch(/a refusal you would send anyway can go once they have heard it/i);
    expect(p).toContain('"Sent." is never the first thing a human hears about a stranger\'s demand.');
  });

  it('keeps the system words out of the new body copy', () => {
    for (const { label, re } of BANNED) {
      expect(re.test(patched()), `${label} in PATCHED THROUGH`).toBe(false);
    }
    expect(lintHumanCopy(MANUAL_BODY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Version 43: how far something reaches follows the thing
// ---------------------------------------------------------------------------
/**
 * Live rehearsal, 2026-09-16. The owner said he was thinking of selling his
 * Trek mountain bike, thinking around $450, and his assistant posted it from
 * Canberra reaching the whole of Australia. His words: "Selling a bike
 * australia wide would be difficult as postage would be exorbitant."
 *
 * The assistant was obeying the manual. Version 36(b) said "unless your human
 * hands you a distance themselves, post wide", which is right for a language
 * partner and silly for a bicycle. So the default goes, and the thing itself
 * decides: a parcel reaches a country, something bulky or heavy takes a
 * radius, anything in person takes a radius, anything online reaches anywhere,
 * and a genuinely unclear one is one plain question to the human.
 *
 * The version 36 entry keeps its own day's words, as every shipped entry does;
 * what changes is the body a fresh session reads, and publish_intent.
 */
describe('version 43: reach follows the thing', () => {
  const entry = () => MANUAL_CHANGELOG.find((c) => c.version === 43)!;

  it('exists at the new version, as one entry', () => {
    expect(MANUAL.version).toBeGreaterThanOrEqual(43);
    expect(MANUAL_CHANGELOG.filter((c) => c.version === 43)).toHaveLength(1);
    expect(entry().note.length).toBeGreaterThan(400);
  });

  it('names the failure that caused it', () => {
    const note = entry().note;
    expect(note).toMatch(/trek mountain bike/i);
    expect(note).toContain('$450');
    expect(note).toMatch(/canberra reaching the whole of australia/i);
    expect(note).toMatch(/postage would be exorbitant/i);
  });

  it('carries all four cases, and the question for an unclear one', () => {
    const note = entry().note;
    // Goes in a parcel: country, and posting is said out loud.
    expect(note).toMatch(/goes in a parcel/i);
    expect(note).toContain('reach "country"');
    expect(note).toMatch(/posting is how it would get there/i);
    expect(note).toMatch(/if they will not post it/i);
    // Bulky or heavy: a radius, because the postage beats the price.
    expect(note).toMatch(/bulky or heavy/i);
    expect(note).toMatch(/postage would cost more than the thing/i);
    // In person: a radius, always.
    expect(note).toMatch(/happens in person/i);
    expect(note).toMatch(/is a radius, always/i);
    // Online: anywhere, and distance stops mattering.
    expect(note).toMatch(/happens online/i);
    expect(note).toContain('reach "anywhere"');
    expect(note).toMatch(/distance means nothing to it at all/i);
    // And the unclear one is a question rather than a guess.
    expect(note).toMatch(/genuinely unclear/i);
    expect(note).toMatch(/ask your human one plain question rather than guessing/i);
  });

  it('keeps the rule that the choice is said out loud', () => {
    expect(entry().note).toMatch(/say which reach you chose and why/i);
  });

  it('keeps the house register', () => {
    expect(lintHumanCopy(entry().note)).toEqual([]);
    expect(lintHumanCopy(MANUAL_BODY)).toEqual([]);
    for (const { label, re } of BANNED) {
      expect(re.test(entry().note), `${label} in the version 43 entry`).toBe(false);
    }
  });
});

describe('and the body teaches the new rule where a fresh session reads it', () => {
  const board = () => sectionText('posting_reach');

  it('no longer teaches post-wide-by-default anywhere in the manual body', () => {
    // The shipped version 30 and version 36 entries keep their own words; the
    // body is what a session reads fresh, and it must not teach the old rule.
    for (const old of [
      /post wide/i,
      /wide is what you post/i,
      /widest reach/i,
      /hands you a distance themselves/i,
      /since it posts easily/i,
    ]) {
      expect(old.test(board()), `${old} still in WORKING THE BOARD`).toBe(false);
    }
  });

  it('teaches the four cases instead', () => {
    const b = board();
    expect(b).toMatch(/how far something reaches follows the thing itself/i);
    expect(b).toMatch(/goes in a parcel/i);
    expect(b).toContain('reach "country"');
    expect(b).toMatch(/posting is how it would get there/i);
    expect(b).toMatch(/bulky or heavy/i);
    expect(b).toMatch(/postage would cost more than the thing/i);
    expect(b).toMatch(/happens in person/i);
    expect(b).toMatch(/is a radius, always/i);
    expect(b).toMatch(/happens online/i);
    expect(b).toContain('reach "anywhere"');
    expect(b).toMatch(/ask your human one plain question rather than guessing/i);
  });

  it('names the bike in the body too, so the reason travels with the rule', () => {
    expect(board()).toMatch(/\$450 Trek mountain bike/);
    expect(board()).toMatch(/postage would be exorbitant/i);
  });

  it('keeps the system words out of the new body copy', () => {
    for (const { label, re } of BANNED) {
      expect(re.test(board()), `${label} in WORKING THE BOARD`).toBe(false);
    }
    expect(lintHumanCopy(MANUAL_BODY)).toEqual([]);
  });
});

describe('publish_intent carries the rule where the posting is made', () => {
  const desc = async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    return TOOLS.find((t) => t.name === 'publish_intent')!.description;
  };

  it('says the thing decides, and gives the four cases', async () => {
    const d = await desc();
    expect(d).toContain('`reach` follows the THING');
    expect(d).toMatch(/goes in a parcel/i);
    expect(d).toMatch(/posting is how it would get there/i);
    expect(d).toMatch(/bulky or done in person/i);
    expect(d).toMatch(/"anywhere" for what happens online/i);
    // The four cases in full, and why each one is what it is, are the section
    // an agent reads when the thing in front of it is not obvious.
    const reach = sectionText('posting_reach');
    expect(reach).toMatch(/postage would cost more than the thing/i);
    expect(reach).toMatch(/happens in person.*is a radius, always/i);
    expect(reach).toMatch(/ask your human one plain question rather than guessing/i);
  });

  it('tells the agent to say which reach it chose and why', async () => {
    const d = await desc();
    expect(d).toMatch(/say out loud which reach you chose so they can correct you/i);
    // The bike that taught it keeps its place in the manual.
    expect(sectionText('posting_reach')).toMatch(/\$450 Trek mountain bike/i);
  });

  it('stays consistent with the reach enum the schema package ships', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const geo = (TOOLS.find((t) => t.name === 'publish_intent')!.inputSchema as any).properties
      .listing.properties.geo;
    expect(geo.properties.reach.enum).toEqual(['radius', 'country', 'anywhere']);
    expect(geo.properties.reach.default).toBe('radius');
    // The field's own prose carries the same four cases in one line.
    expect(geo.properties.reach.description).toMatch(/a parcel is 'country'/);
    expect(geo.properties.reach.description).toMatch(/anything bulky or heavy is a radius/);
    expect(geo.properties.reach.description).toMatch(/anything in person is a radius/);
    expect(geo.properties.reach.description).toMatch(/anything done online is 'anywhere'/);
  });

  it('keeps the house register', async () => {
    expect(lintHumanCopy(await desc())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Version 45: reporting somebody, and an account that has been stopped
// ---------------------------------------------------------------------------
/**
 * What shipped on 2026-09-17 (docs/trust-and-safety.md, steps 5 and 6). Two
 * things in ONE entry, because a running session is told the notes once and
 * they are the same subject from two ends: somebody behaving badly, and what
 * the switchboard does about it.
 *
 * The body carries both as well, each in the section that covers it — the
 * report beside the rest of the conversation, the suspension beside the rest
 * of what the switchboard refuses — because the changelog is what a running
 * session hears and the body is what a fresh session reads.
 */
describe('version 45: reporting, and an account that has been stopped', () => {
  const entry = () => MANUAL_CHANGELOG.find((c) => c.version === 45)!;

  it('exists at the new version, as one entry rather than two', () => {
    expect(MANUAL.version).toBeGreaterThanOrEqual(45);
    expect(MANUAL_CHANGELOG.filter((c) => c.version === 45)).toHaveLength(1);
    expect(entry().note.length).toBeGreaterThan(400);
  });

  it('teaches the report: the action, the order, and what the press does', () => {
    const note = entry().note;
    expect(note).toContain('respond(request_report)');
    expect(note).toContain('wait_for_press');
    expect(note).toMatch(/a box for a line in their own words and one press/i);
    expect(note).toMatch(/never put together again/i);
    expect(note).toMatch(/kept for somebody here to look at/i);
    // The words to listen for, and the things the agent must not do.
    expect(note).toContain('"report this person"');
    expect(note).toMatch(/never talk your human out of it/i);
    expect(note).toMatch(/never report anybody off your own bat/i);
  });

  it('teaches what the other side is told, and what it is never told', () => {
    const note = entry().note;
    expect(note).toMatch(/told only that the switchboard has closed the conversation/i);
    expect(note).toMatch(/never that they were reported, never by whom, never what was said/i);
  });

  it('teaches the suspension: the word, the connect block, and remembering it', () => {
    const note = entry().note;
    expect(note).toContain('account_suspended');
    expect(note).toMatch(/the very first thing you are handed at connect/i);
    expect(note).toMatch(/there is no retry and no other call that works/i);
    expect(note).toMatch(/keep the fact in your own memory/i);
  });

  it('keeps the house register', () => {
    expect(lintHumanCopy(entry().note)).toEqual([]);
    expect(lintHumanCopy(MANUAL_BODY)).toEqual([]);
  });
});

describe('and the body carries both, where a fresh session reads them', () => {
  const from = (_heading: string) => sectionText('safety_and_reports');

  it('puts the report in the section about the conversation', () => {
    const patched = from('PATCHED THROUGH');
    expect(patched).toContain('respond(request_report)');
    expect(patched).toMatch(/sometimes the person on the other side is the problem/i);
    expect(patched).toMatch(/the words are "report this person"/i);
    expect(patched).toMatch(/never report anybody yourself/i);
    // And the promise made to the person on the other end.
    expect(patched).toMatch(
      /never that they were reported, by whom, or what was said/i,
    );
  });

  it('puts the suspension beside what the switchboard refuses', () => {
    const limits = sectionText('answers');
    expect(limits).toContain('account_suspended');
    expect(limits).toMatch(/posts, sends, collects and offers nothing/i);
    expect(limits).toMatch(/keep the fact in your own memory/i);
    expect(limits).toMatch(/there is no retry/i);
    // And the half about the other side, which is the half an agent would
    // otherwise invent an explanation for.
    expect(limits).toMatch(/you are told nothing/i);
    expect(limits).toMatch(/closed by the switchboard/i);
  });

  it('says on the tool itself what the manual says in prose', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const respond = TOOLS.find((t) => t.name === 'respond')!;
    expect(respond.description).toContain('request_report');
    expect(respond.description).toMatch(/never talk them out of it/i);
    expect((respond.inputSchema as any).properties.action.enum).toContain('request_report');
  });
});

// ---------------------------------------------------------------------------
/**
 * THE FIRST ANSWER CARRIES THE START PAGE.
 *
 * The connect page has ended "Call read_manual with section start before you
 * use any of this" since version 54. The tool-call log of a live session on
 * 19 September reads: check_in, check_in, publish, publish, publish. The
 * instruction appeared in exactly one place, at the one moment a client is
 * free to truncate it — and an agent-key client whose harness sends no
 * initialize is served no connect text at all.
 *
 * So the first tool answer of a session that has not read the manual carries
 * the page itself. Once, marked on the token row the manual fields already
 * live on, so a restart and a second process agree it has been done.
 */
describe('the first answer of a session that has not read the manual', () => {
  const fresh = (): ToolSession => ({
    tokenHash: TOKEN_HASH,
    manualVersion: MANUAL.version,
    manualNotifiedAt: null,
    manualStartSentAt: null,
  });

  it('hands over the start section, with its version and its provenance', async () => {
    const r = body(await sweep(fresh()));
    expect(r.manual_start.version).toBe(MANUAL.version);
    expect(r.manual_start.provenance).toBe('switchboard-system');
    expect(r.manual_start.text).toBe(sectionText('start'));
    expect(r.manual_start.text).toContain('THE RULES THAT NEVER BEND');
    expect(startWrites).toEqual([TOKEN_HASH]);
  });

  it('hands it over once and never again', async () => {
    const session = fresh();
    expect(body(await sweep(session)).manual_start).toBeDefined();
    expect(body(await sweep(session)).manual_start).toBeUndefined();
    expect(body(await sweep(session)).manual_start).toBeUndefined();
    // One write, however many calls followed it.
    expect(startWrites).toEqual([TOKEN_HASH]);
  });

  it('says nothing to a session that already has it', async () => {
    const session = { ...fresh(), manualStartSentAt: new Date() };
    expect(body(await sweep(session)).manual_start).toBeUndefined();
    expect(startWrites).toEqual([]);
  });

  it('does not tell an agent that just read the manual to read the manual', async () => {
    const session = fresh();
    // read_manual answers with the section it was asked for and nothing else
    // folded on: the page IS the answer.
    const read = body(await dispatchTool(cfg, ANA, 'read_manual', { section: 'posting' }, session));
    expect(read.manual_start).toBeUndefined();
    expect(read.section).toBe('posting');
    // And the sweep after it says nothing either, because the mark is set.
    expect(body(await sweep(session)).manual_start).toBeUndefined();
    expect(startWrites).toEqual([TOKEN_HASH]);
  });

  it('rides a refusal as readily as an answer, since a refusal is an answer here', async () => {
    const session = fresh();
    // An unreadable call is the one thing here that is still a failure, and
    // even that one should not swallow the rules the agent has never read.
    const r = body(await dispatchTool(cfg, ANA, 'respond', { action: 'nonsense' }, session));
    expect(r.manual_start).toBeDefined();
  });

  it('leaves a caller with no session exactly as it was', async () => {
    const r = body(await sweep(undefined));
    expect(r.manual_start).toBeUndefined();
    expect(startWrites).toEqual([]);
  });
});
