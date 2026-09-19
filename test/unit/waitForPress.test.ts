/**
 * Waiting for the press.
 *
 * The defect this closes: every one-question link used to end with the human
 * going back to the chat and typing "done". People forget, and word it oddly
 * when they do, so the agent guessed. Now the agent hands the link over and
 * holds the line, and the switchboard answers the moment the button goes down.
 *
 * What is asserted here:
 *  - a link already pressed answers straight away, approved or declined;
 *  - a wait that is still waiting when the cap comes answers plainly, and the
 *    cap is real: the hold ends inside fifty seconds, well short of the load
 *    balancer's sixty;
 *  - a link that runs out while the line is held says so;
 *  - a press id belonging to somebody else is not found rather than waited on;
 *  - every sentence is in the house register.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import * as db from '../../src/db.js';
import {
  PRESS_POLL_MS,
  PRESS_SENTENCES,
  PRESS_WAIT_CAP_MS,
  PRESS_WHAT_TO_DO,
  waitForPress,
} from '../../src/domain/humanLinks.js';
import { signLink } from '../../src/counter/links.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { dispatchTool, TOOLS } from '../../src/mcp/tools.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
} as unknown as Config;

const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc';
const PRESS = '11111111-0000-4000-8000-000000000001';

interface LinkRow {
  id: string;
  account_id: string;
  action: string;
  ref_id: string;
  amount: string | null;
  ccy: string | null;
  counterparty_account: string;
  payload: string | null;
  used_at: Date | null;
  decision: 'approved' | 'declined' | null;
  expires_at: Date;
}

let links: LinkRow[];
/** Where the fake clock stood when a wait began; every elapsed check is
 *  against this, and nothing in this file sleeps for real. */
let started = 0;
/** How many times the row has been re-read while the line was held. */
let reads: number;

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      if (/FROM approval_links/.test(sql)) {
        reads += 1;
        const row = links.find((l) => l.id === params[0] && l.account_id === params[1]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

/** One live link of Ana's, fifteen minutes old at most and unpressed. */
const theLink = (over: Partial<LinkRow> = {}): LinkRow => ({
  id: PRESS,
  account_id: ANA,
  action: 'stage3-disclosure',
  ref_id: '22222222-0000-4000-8000-000000000002',
  amount: null,
  ccy: null,
  counterparty_account: BEPPE,
  payload: null,
  used_at: null,
  decision: null,
  expires_at: new Date(Date.now() + 15 * 60_000),
  ...over,
});

/** The page a given row was minted as, worked out the way the counter does. */
const pageOf = (row: LinkRow) => `${cfg.counterOrigin}/a/${encodeURIComponent(signLink(row))}`;

beforeEach(async () => {
  links = [theLink()];
  reads = 0;
  vi.spyOn(db, 'getPool').mockImplementation(() => fakePool());
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
});

afterEach(() => {
  vi.useRealTimers();
});

const isNote = (n: any) =>
  !!n && typeof n.text === 'string' && n.text.length > 0 && n.provenance === 'switchboard-system';

// ---------------------------------------------------------------------------
// Already pressed: there is nothing to wait for.
// ---------------------------------------------------------------------------
describe('a link already pressed answers straight away', () => {
  it('says the yes is in, on the first look', async () => {
    links = [theLink({ used_at: new Date(), decision: 'approved' })];
    const r = await waitForPress(cfg, ANA, PRESS);
    expect(r).toMatchObject({ pressed: true, decision: 'approved' });
    expect(isNote(r.note)).toBe(true);
    expect(r.note.text).toBe(PRESS_SENTENCES.approved);
    expect(r.expired).toBeUndefined();
    // Nothing left to press, so nothing to hand over.
    expect(r.link).toBeUndefined();
    expect(r.what_to_do).toBeUndefined();
    expect(reads).toBe(1); // one read, no waiting at all
  });

  it('says nothing went ahead, when they pressed Not now', async () => {
    links = [theLink({ used_at: new Date(), decision: 'declined' })];
    const r = await waitForPress(cfg, ANA, PRESS);
    expect(r).toMatchObject({ pressed: true, decision: 'declined' });
    expect(r.note.text).toBe(PRESS_SENTENCES.declined);
    expect(r.link).toBeUndefined();
    expect(r.what_to_do).toBeUndefined();
    expect(reads).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Holding the line. Fake clock throughout: nothing here sleeps.
// ---------------------------------------------------------------------------
describe('holding the line', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    started = Date.now();
  });

  it('answers the moment they press, part-way through the wait', async () => {
    const waiting = waitForPress(cfg, ANA, PRESS);
    await vi.advanceTimersByTimeAsync(PRESS_POLL_MS * 3);
    // The press lands between two looks.
    links[0].used_at = new Date();
    links[0].decision = 'approved';
    await vi.advanceTimersByTimeAsync(PRESS_POLL_MS);
    const r = await waiting;
    expect(r).toMatchObject({ pressed: true, decision: 'approved' });
    // Answered on the look after the press, not at the cap.
    expect(Date.now() - started).toBeLessThan(PRESS_POLL_MS * 6);
  });

  it('says it is still waiting when the cap comes, and lets go of the line', async () => {
    const waiting = waitForPress(cfg, ANA, PRESS);
    await vi.advanceTimersByTimeAsync(PRESS_WAIT_CAP_MS);
    const r = await waiting;
    expect(r.pressed).toBe(false);
    expect(r.decision).toBeUndefined();
    expect(r.expired).toBeUndefined();
    expect(isNote(r.note)).toBe(true);
    // The page itself rides back with it, so even an agent that waited before
    // it handed anything over ends the turn holding the link.
    expect(r.link).toBe(pageOf(links[0]));
    expect(r.note.text).toBe(`${PRESS_SENTENCES.waiting} ${r.link}`);
    expect(r.note.text).toMatch(/here is the page again/i);
    // It puts the page in front of the human rather than reporting a state,
    // and it reads sanely whether or not they were handed it a minute ago.
    expect(r.note.text).toContain('nothing has come through yet');
    // And the half that is for the agent says what to do with it.
    expect(r.what_to_do).toBe(PRESS_WHAT_TO_DO.waiting);
    expect(r.what_to_do).toMatch(/put that page in front of your human/i);
  });

  it('hands back the very link that was minted, never a new one', async () => {
    // Re-derived from the stored row, so it is the page they already have:
    // nothing is minted here, and the single-use link stays single-use.
    const waiting = waitForPress(cfg, ANA, PRESS);
    await vi.advanceTimersByTimeAsync(PRESS_WAIT_CAP_MS);
    const first = await waiting;
    reads = 0;
    const again = waitForPress(cfg, ANA, PRESS);
    await vi.advanceTimersByTimeAsync(PRESS_WAIT_CAP_MS);
    const second = await again;
    expect(second.link).toBe(first.link);
    expect(first.link).toContain('https://my.test/a/');
    expect(first.link).toContain(encodeURIComponent(signLink(links[0])));
  });

  it('holds for its fifty seconds and not a moment past them', async () => {
    // The load balancer gives up at sixty, so the cap is well under it.
    expect(PRESS_WAIT_CAP_MS).toBe(50_000);
    let finishedAt = -1;
    const waiting = waitForPress(cfg, ANA, PRESS).then((r) => {
      finishedAt = Date.now() - started;
      return r;
    });
    // A whole minute of fake clock: the wait must have ended on its own well
    // before it, rather than run on to the balancer's timeout.
    await vi.advanceTimersByTimeAsync(60_000);
    await waiting;
    expect(finishedAt).toBeGreaterThan(PRESS_WAIT_CAP_MS - PRESS_POLL_MS * 2);
    expect(finishedAt).toBeLessThanOrEqual(PRESS_WAIT_CAP_MS);
    // And it looked about as often as a poll of a second and a half implies.
    expect(reads).toBeGreaterThan(20);
    expect(reads).toBeLessThan(40);
  });

  it('says the page has run out when the link expires while the line is held', async () => {
    links = [theLink({ expires_at: new Date(Date.now() + PRESS_POLL_MS * 2) })];
    const waiting = waitForPress(cfg, ANA, PRESS);
    await vi.advanceTimersByTimeAsync(PRESS_POLL_MS * 4);
    const r = await waiting;
    expect(r).toMatchObject({ pressed: false, expired: true });
    expect(r.note.text).toBe(PRESS_SENTENCES.expired);
    expect(r.note.text).toMatch(/fresh one/);
    // A dead page is not handed over, and nothing is minted in its place: the
    // answer says plainly that a fresh link is the way out.
    expect(r.link).toBeUndefined();
    expect(r.what_to_do).toBe(PRESS_WHAT_TO_DO.expired);
    expect(r.what_to_do).toMatch(/fetch a fresh link/i);
    // It let go early rather than holding to the cap for a dead page.
    expect(Date.now() - started).toBeLessThan(PRESS_WAIT_CAP_MS);
  });

  it('answers a link that was already dead on the first look', async () => {
    links = [theLink({ expires_at: new Date(Date.now() - 1000) })];
    const r = await waitForPress(cfg, ANA, PRESS);
    expect(r).toMatchObject({ pressed: false, expired: true });
    expect(r.link).toBeUndefined();
    expect(reads).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A press belongs to one person.
// ---------------------------------------------------------------------------
describe('a press id is only ever your own', () => {
  it('is not found when the link belongs to the other side', async () => {
    await expect(waitForPress(cfg, BEPPE, PRESS)).rejects.toThrow(/NOT_FOUND/);
    expect(reads).toBe(1); // asked once and refused; no line held
  });

  it('is not found when there is no such press at all', async () => {
    await expect(
      waitForPress(cfg, ANA, '99999999-0000-4000-8000-000000000009'),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  it('answers NOT_FOUND through the tool, without waiting', async () => {
    const r: any = await dispatchTool(cfg, BEPPE, 'wait_for_press', { press_id: PRESS });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content[0].text)).toContain('NOT_FOUND');
  });

  it('says what is missing when no press id came with the call', async () => {
    const r: any = await dispatchTool(cfg, ANA, 'wait_for_press', {});
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content[0].text)).toContain('press_id');
  });
});

// ---------------------------------------------------------------------------
// The tool itself.
// ---------------------------------------------------------------------------
describe('the tool an agent reads', () => {
  it('hands the answer back through dispatch, sentence and all', async () => {
    links = [theLink({ used_at: new Date(), decision: 'approved' })];
    const r: any = await dispatchTool(cfg, ANA, 'wait_for_press', { press_id: PRESS });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ pressed: true, decision: 'approved' });
    expect(isNote(r.structuredContent.note)).toBe(true);
  });

  it('tells the agent to call again, and how long the page is good for', () => {
    const tool = TOOLS.find((t) => t.name === 'wait_for_press')!;
    expect(tool).toBeDefined();
    expect(tool.description).toMatch(/call it again/i);
    expect(tool.description).toContain('15 minutes');
    expect(tool.description).toContain('50 seconds');
    expect(tool.inputSchema.required).toEqual(['press_id']);
  });

  it('tells the respond tool to hand over the link and then wait on the line', () => {
    const respond = TOOLS.find((t) => t.name === 'respond')!;
    expect(respond.description).toContain('press_id');
    expect(respond.description).toContain('wait_for_press');
    expect(respond.description).toMatch(/is a sentence you never write/i);
  });
});

// ---------------------------------------------------------------------------
// The voice. Same rules as everything else a person hears.
// ---------------------------------------------------------------------------
describe('the sentences are in the house register', () => {
  /** The nouns that belong to the machinery, from manual.test.ts. */
  const BANNED = [
    { label: 'card', re: /\b(index\s+)?cards?\b/i },
    { label: 'channel', re: /\bchannels?\b/i },
    { label: 'match', re: /\bmatch(es)?\b/i },
    { label: 'stage', re: /\bstages?\b/i },
    { label: 'WANT', re: /\bWANT\b/ },
    { label: 'HAVE', re: /\bHAVE\b/ },
    { label: 'connection', re: /\bconnections?\b/i },
    { label: 'score', re: /\bscores?\b/i },
  ];

  it('passes the lint every email and page passes', () => {
    for (const [name, text] of Object.entries(PRESS_SENTENCES)) {
      expect(lintHumanCopy(text), name).toEqual([]);
    }
  });

  it('says none of the words that belong to the machinery', () => {
    for (const [name, text] of Object.entries(PRESS_SENTENCES)) {
      for (const { label, re } of BANNED) {
        expect(re.test(text), `${label} in ${name}: ${text}`).toBe(false);
      }
    }
  });

  it('reads as one plain sentence apiece, with no field names in it', () => {
    for (const [name, text] of Object.entries(PRESS_SENTENCES)) {
      expect(text.length, name).toBeLessThan(140);
      expect(text, name).not.toMatch(/press_id|used_at|decision|approval_link/);
      // The waiting one ends on a colon because the page follows it; the rest
      // are whole sentences on their own.
      expect(text.trim().endsWith(name === 'waiting' ? ':' : '.'), name).toBe(true);
    }
  });

  it('holds the agent-facing half to the same register', () => {
    for (const [name, text] of Object.entries(PRESS_WHAT_TO_DO)) {
      expect(lintHumanCopy(text), name).toEqual([]);
      expect(text, name).not.toMatch(/press_id|used_at|decision|approval_link/);
      for (const { label, re } of BANNED) {
        expect(re.test(text), `${label} in ${name}: ${text}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The token goes to the agent and nowhere else.
// ---------------------------------------------------------------------------
describe('the token is never logged', () => {
  it('says nothing to the console while it holds the line or answers', async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = methods.map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: any[]) => {
        said.push(a.map((x) => String(x)).join(' '));
      }),
    );
    const waiting = waitForPress(cfg, ANA, PRESS);
    await vi.advanceTimersByTimeAsync(PRESS_WAIT_CAP_MS);
    const r = await waiting;
    for (const sp of spies) sp.mockRestore();
    const token = signLink(links[0]);
    expect(r.link).toContain(encodeURIComponent(token));
    expect(said.join('\n')).not.toContain(token);
    expect(said.join('\n')).not.toContain(token.split('.')[1]);
    expect(said).toEqual([]);
  });

  it('keeps the signature out of the source that does the waiting', async () => {
    // The belt to the braces above: no logging call anywhere in the file that
    // now handles the token.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/domain/humanLinks.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/console\.(log|info|warn|error|debug)/);
    expect(src).not.toMatch(/\breq\.log\b|\blogger\b/);
  });
});

// ---------------------------------------------------------------------------
// What an agent is told about the order of things.
// ---------------------------------------------------------------------------
describe('hand it over, then wait', () => {
  it('says the order plainly in the tool description', () => {
    const tool = TOOLS.find((t) => t.name === 'wait_for_press')!;
    expect(tool.description).toMatch(/already handed them/i);
    expect(tool.description).toMatch(/hand the link over[^.]*and only then wait/i);
    expect(tool.description).toMatch(/never wait on a page your human has not been given/i);
    expect(tool.description).toMatch(/hands you the page again/i);
    // The other half of the same order: having handed it over, you wait rather
    // than asking them to come back and say they pressed it.
    expect(tool.description).toMatch(/never hand a link over and then ask your human to come back/i);
  });

  it('carries one new note in the manual, at the version it was written for', async () => {
    const { MANUAL, MANUAL_CHANGELOG, MANUAL_BODY } = await import(
      '../../src/mcp/instructions.js'
    );
    // Version 34 is where this note shipped; later versions are welcome to
    // stack on top of it, so the floor is what this asserts.
    expect(MANUAL.version).toBeGreaterThanOrEqual(34);
    const entry = MANUAL_CHANGELOG.find((c) => c.version === 34)!;
    expect(entry).toBeDefined();
    expect(entry.note).toMatch(/wait_for_press/);
    expect(entry.note).toMatch(/never wait on a page they have not been given/i);
    expect(entry.note).toMatch(/never ask them to come back and report a press you could have waited for/i);
    expect(entry.note).toMatch(/hands you the page again/i);
    // Nothing that shipped before it was touched.
    expect(MANUAL_CHANGELOG.filter((c) => c.version === 33)).toHaveLength(1);
    // And the manual itself carries the rule, for an agent connecting fresh.
    expect(MANUAL_BODY).toContain('Hand the page over first, then wait on it.');
    expect(MANUAL_BODY).toMatch(
      /never ask them to come back and report a press you could have waited for/i,
    );
  });

  it('writes both of them in the house register', async () => {
    const { MANUAL_CHANGELOG } = await import('../../src/mcp/instructions.js');
    const entry = MANUAL_CHANGELOG.find((c) => c.version === 34)!;
    const tool = TOOLS.find((t) => t.name === 'wait_for_press')!;
    for (const text of [entry.note, tool.description]) {
      expect(lintHumanCopy(text)).toEqual([]);
    }
  });
});
