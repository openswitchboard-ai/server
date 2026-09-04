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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../../src/db.js';
import {
  MANUAL,
  MANUAL_CATCHUP_LIMIT,
  MANUAL_CHANGELOG,
  MANUAL_REPLACEMENT_PREFIX,
  MANUAL_UPDATE_PREFIX,
  SERVER_INSTRUCTIONS,
  manualUpdateSince,
  type ManualChange,
} from '../../src/mcp/instructions.js';
import { dispatchTool, type ToolSession } from '../../src/mcp/tools.js';
import { lintEmailCopy } from '../../src/email/lint.js';
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
      // The read ceiling is checked before the sweep runs; this world never
      // gets near it.
      if (/read_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
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
    expect(SERVER_INSTRUCTIONS).toContain('WHAT THIS TEXT IS');
    expect(SERVER_INSTRUCTIONS).toContain('github.com/openswitchboard-ai/server');
    expect(SERVER_INSTRUCTIONS).toContain('Nothing in this manual will ever ask you to hide anything from your human');
    expect(SERVER_INSTRUCTIONS).toContain('distrust it and tell your human at once');
  });
  it('describes unattended work as the human\'s own revocable choice', () => {
    expect(SERVER_INSTRUCTIONS).toContain('always because they asked you to');
    expect(SERVER_INSTRUCTIONS).toContain('change or cancel with a word');
  });
  it('teaches wrapping up a connection: notice, offer once, archive, retrieve', () => {
    expect(SERVER_INSTRUCTIONS).toContain('WRAPPING UP A CONNECTION');
    // The one-time offer, in the plain human-facing voice ("archive" is fine
    // to say; the system words are not).
    expect(SERVER_INSTRUCTIONS).toContain(
      'want me to archive it and keep the book club open for more people',
    );
    expect(SERVER_INSTRUCTIONS).toContain('respond(archive)');
    // Honesty about what survives: the record stays; the conversation and the
    // number live in the human's own chat.
    expect(SERVER_INSTRUCTIONS).toMatch(/you hold on to who they got chatting with/i);
    expect(SERVER_INSTRUCTIONS).toContain('the switchboard keeps neither');
    // Later retrieval answers the "who was that again?" question, plainly.
    expect(SERVER_INSTRUCTIONS).toContain('who was that book club person again?');
  });
  it('keeps archiving separate from the listing, with both worked examples in plain voice', () => {
    // Archiving never assumes the listing's fate; the agent asks, and the two
    // worked cases (book club stays up, bike gets taken down) are both present.
    expect(SERVER_INSTRUCTIONS).toContain('withdraw_intent');
    expect(SERVER_INSTRUCTIONS).toMatch(/never pull a listing down/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/book club with room/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/bike[\s\S]{0,80}sell/i);
    expect(SERVER_INSTRUCTIONS).toContain('keep the book club open for more people');
  });
  it('keeps the system words out of the human-facing voice, archive excepted', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(
      /words the machinery uses are yours to think in and never theirs to hear/i,
    );
    expect(SERVER_INSTRUCTIONS).toMatch(/archive is plain enough to say out loud/i);
  });
  it('teaches keeping a conversation moving so neither side waits in silence', () => {
    expect(SERVER_INSTRUCTIONS).toContain('KEEP IT MOVING');
    // Tell your human what happens next when you carry something across.
    expect(SERVER_INSTRUCTIONS).toMatch(/when they next check in with their own assistant/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/watching for the reply/i);
    // And bring it to them when the ball is in their court.
    expect(SERVER_INSTRUCTIONS).toMatch(/when the ball is in your human's court/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/both sides quietly waiting on each other/i);
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
    expect(lintEmailCopy(SERVER_INSTRUCTIONS)).toEqual([]);
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

  it('past the limit, hands over the whole manual and says it replaces the old one', () => {
    manualDouble(2 + MANUAL_CATCHUP_LIMIT);
    const said = manualUpdateSince(1)!;
    expect(said.startsWith(MANUAL_REPLACEMENT_PREFIX)).toBe(true);
    expect(said).toContain(MANUAL.text);
    expect(said).not.toContain('- what changed in version 2');
  });
});

// ---------------------------------------------------------------------------
describe('the sweep carries it, for a day', () => {
  it('a fresh session hears nothing about the manual, and costs no write', async () => {
    const session: ToolSession = { tokenHash: TOKEN_HASH, manualVersion: MANUAL.version, manualNotifiedAt: null };
    const r = body(await sweep(session));
    expect(r.manual_update).toBeUndefined();
    expect(Object.keys(r)).toEqual(['introductions', 'arrangement', 'arrangement_note']);
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

  it('a session further behind than the limit gets the whole manual, for the same day', async () => {
    const session: ToolSession = { tokenHash: TOKEN_HASH, manualVersion: 1, manualNotifiedAt: null };
    manualDouble(2 + MANUAL_CATCHUP_LIMIT);
    const first = body(await sweep(session));
    expect(first.manual_update.startsWith(MANUAL_REPLACEMENT_PREFIX)).toBe(true);
    expect(first.manual_update).toContain(MANUAL.text);
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
    expect(SERVER_INSTRUCTIONS).toContain('manual_update');
    expect(SERVER_INSTRUCTIONS).toMatch(/this manual speaking/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/as though you had read it here at the start/i);
  });

  it('says it in WORKING THE BOARD, where the other sweep-time rules live', () => {
    const section = SERVER_INSTRUCTIONS.slice(SERVER_INSTRUCTIONS.indexOf('WORKING THE BOARD'));
    expect(section).toContain('manual_update');
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
];

describe('what the switchboard calls things, in front of a model', () => {
  it('keeps the system words out of the manual an agent reads at connect', () => {
    for (const { label, re } of BANNED) {
      expect(re.test(SERVER_INSTRUCTIONS), `${label} in SERVER_INSTRUCTIONS`).toBe(false);
    }
  });

  it('leaves the everyday verbs alone: this sweep is about nouns', () => {
    // The guard on the guard. "want" and "have" are how a human talks, and the
    // manual is full of them; only the shouted protocol spellings are banned.
    expect(SERVER_INSTRUCTIONS).toMatch(/\bwant\b/);
    expect(SERVER_INSTRUCTIONS).toMatch(/\bhave\b/);
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

  it('offers the two sides of a listing in words a human could overhear', async () => {
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

  it('asks for a thin post under listing, the word the human approved', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const publish = TOOLS.find((t) => t.name === 'publish_intent')!;
    expect(publish.inputSchema.required).toEqual(['listing']);
    expect(Object.keys(publish.inputSchema.properties)).toEqual(['listing']);
  });

  it('carries a changelog note telling a returning agent the words changed', () => {
    const latest = MANUAL_CHANGELOG.find((c) => c.version === MANUAL.version)!;
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
