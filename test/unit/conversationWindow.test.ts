/**
 * The conversation budget: one human's press, and how long it lasts.
 *
 * The rule (Lachlan, 2026-09-18): consent to talk runs out. Each press grants
 * THAT human's agent so many messages sent by THAT side of one introduction, or
 * so many days, whichever ends first. When it is spent, that side's
 * send_message carries nothing and answers conversation_paused.
 *
 * What is asserted here:
 *  - the arithmetic: every send spends one, the last one inside the budget goes
 *    and the next does not, and a window older than the days is spent whatever
 *    its count says;
 *  - the answer: an ordinary answer rather than a failure, leading with the
 *    plain word conversation_paused and carrying the sentence that says what
 *    to do about it;
 *  - NOTHING IS LOST. A paused side can still collect everything the other side
 *    has sent, and the other side is unaffected: its sends still go, it is
 *    never told anything, and nothing about its own window crosses;
 *  - a spend is one statement, so the budget cannot be walked past by two calls
 *    racing each other;
 *  - a message refused by the intake pipe still spends one, the same way the
 *    hourly slot is spent by the attempt;
 *  - renewal starts a fresh window, and renewing EARLY does too;
 *  - the sweep says so: paused on the caller's own side, how many are left when
 *    the end is near, and nothing whatever about the other side's window;
 *  - migration 044 creates what the code's SQL reads, and backfills the
 *    conversations that are already open so nothing live pauses on deploy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateChannelKey: vi.fn(async (channelId: string) => Buffer.from(`ckey:${channelId}`)),
  encryptForChannel: vi.fn(async (_c: string, _k: Buffer, plaintext: string) =>
    Buffer.from(`sealed:${plaintext}`, 'utf8'),
  ),
  decryptForChannel: vi.fn(async (_c: string, _k: Buffer, blob: Buffer) =>
    blob.toString('utf8').replace(/^sealed:/, ''),
  ),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v.toString('utf8').replace(/^enc:/, '')]),
    ),
  ),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
}));

import * as db from '../../src/db.js';
import * as channel from '../../src/domain/channel.js';
import * as cw from '../../src/domain/conversationWindow.js';
import { dispatchTool } from '../../src/mcp/tools.js';
import { OsbError } from '../../src/protocol.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc';
const CHANNEL = 'ch_11111111-2222-4333-8444-555555555555';

/** A small budget, so a test can spend a whole window in a few lines. */
const cfg = {
  envName: 'dev',
  publicOrigin: 'https://mcp.test',
  conversationBudgetMessages: 3,
  conversationBudgetDays: 7,
} as unknown as Config;

interface Window {
  started_at: Date;
  messages_sent: number;
  granted_via: string;
}
interface Msg {
  id: string;
  channel_id: string;
  sender_account: string;
  recipient_account: string;
  body_enc: Buffer;
  created_at: Date;
}

interface World {
  windows: Map<string, Window>;
  messages: Msg[];
  /** The opt-in each side's press recorded, which is what a lazy window is
   *  dated from. */
  optinAt: Map<string, Date>;
}
let world: World;

const key = (account: string) => `${MATCH}|${account}`;

const theMatch = () => ({
  id: MATCH,
  card_want: 'card-w',
  card_have: 'card-h',
  account_want: ANA,
  account_have: BEPPE,
  score: 0.8,
  category: 'goods.bicycle.mountain',
  stage: 4,
  interest_want: true,
  interest_have: true,
  state: 'open',
  channel_id: CHANNEL,
  channel_key_enc: Buffer.from(`ckey:${CHANNEL}`),
  opened_at: new Date('2026-09-01T00:00:00Z'),
});

function run(sql: string, params: any[] = []) {
  const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return rows([]);

  // ---- the window itself. The WHERE clause IS the budget, so the stand-in
  // applies both halves of it: the count and the days.
  if (/UPDATE conversation_windows/.test(sql)) {
    const w = world.windows.get(`${params[0]}|${params[1]}`);
    if (!w) return rows([]);
    const cutoff = Date.now() - Number(params[3]) * 86_400_000;
    if (w.messages_sent >= Number(params[2]) || w.started_at.getTime() <= cutoff) return rows([]);
    w.messages_sent += 1;
    return rows([{ messages_sent: w.messages_sent }]);
  }
  if (/INSERT INTO conversation_windows/.test(sql)) {
    const k = `${params[0]}|${params[1]}`;
    const renewal = /DO UPDATE SET started_at = now\(\)/.test(sql);
    if (renewal || !world.windows.has(k)) {
      world.windows.set(k, {
        // The lazy open is dated from that side's own opt-in; the renewal is
        // dated from the press that just happened.
        started_at: renewal ? new Date() : (world.optinAt.get(params[1]) ?? new Date()),
        messages_sent: 0,
        granted_via: String(params[2]),
      });
    }
    return rows([]);
  }
  if (/FROM conversation_windows WHERE match_id/.test(sql)) {
    const w = world.windows.get(`${params[0]}|${params[1]}`);
    if (!w) return rows([]);
    return rows([
      {
        messages_sent: w.messages_sent,
        in_time: w.started_at.getTime() > Date.now() - Number(params[2]) * 86_400_000,
      },
    ]);
  }

  // ---- everything else the transport touches ----
  if (/SELECT channel_key_enc FROM matches/.test(sql)) {
    return rows([{ channel_key_enc: Buffer.from(`ckey:${CHANNEL}`) }]);
  }
  if (/^\s*SELECT \* FROM matches WHERE id/.test(sql)) {
    return rows(params[0] === MATCH ? [theMatch()] : []);
  }
  if (/^\s*SELECT \* FROM cards WHERE id/.test(sql)) {
    return rows([{ id: params[0], lifecycle_state: 'PUBLISHED' }]);
  }
  if (/INSERT INTO channel_send_rate/.test(sql)) return rows([{ n: 1 }]);
  if (/INSERT INTO channel_messages/.test(sql)) {
    const row: Msg = {
      id: randomUUID(),
      channel_id: params[0],
      sender_account: params[2],
      recipient_account: params[3],
      body_enc: params[4],
      created_at: new Date(Date.now() + world.messages.length),
    };
    world.messages.push(row);
    return rows([{ id: row.id, created_at: row.created_at }]);
  }
  if (/SELECT id, created_at, body_enc FROM channel_messages/.test(sql)) {
    return rows(
      world.messages
        .filter((m) => m.recipient_account === params[0] && m.channel_id === params[1])
        .slice(0, params[2])
        .map((m) => ({ id: m.id, created_at: m.created_at, body_enc: m.body_enc })),
    );
  }
  if (/DELETE FROM channel_messages WHERE id = ANY/.test(sql)) {
    const ids: string[] = params[0];
    world.messages = world.messages.filter((m) => !ids.includes(m.id));
    return rows([]);
  }
  if (/SELECT 1 FROM channel_messages/.test(sql)) return rows([]);
  if (/SELECT channel_id, count\(\*\)::int AS n FROM channel_messages/.test(sql)) {
    const counts = new Map<string, number>();
    for (const m of world.messages) {
      if (m.recipient_account !== params[0]) continue;
      counts.set(m.channel_id, (counts.get(m.channel_id) ?? 0) + 1);
    }
    return rows([...counts].map(([channel_id, n]) => ({ channel_id, n })));
  }
  if (/read_calls|write_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);

  // ---- what the sweep walks. The one introduction this world holds, at the
  // stage where the two of them are already talking.
  if (/^\s*SELECT m\.\*[^;]*FROM matches m/.test(sql)) return rows([theMatch()]);
  if (/FROM cards c/.test(sql)) return rows([]);
  if (/count\(DISTINCT account_id\)/.test(sql)) return rows([{ n: 2 }]);
  if (/max\(recorded_at\)/.test(sql)) return rows([{ at: '2026-09-01T00:00:00.000Z' }]);
  if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
    return rows([
      {
        id: params[0],
        data_key_enc: Buffer.from('wrapped'),
        first_name_enc: Buffer.from(params[0] === ANA ? 'enc:Ana' : 'enc:Beppe'),
        locality_enc: Buffer.from('enc:Newtown'),
        status: 'active',
      },
    ]);
  }
  if (/SELECT arrangement FROM accounts/.test(sql)) return rows([{ arrangement: null }]);
  return rows([]);
}

const client = { query: async (sql: string, p: any[] = []) => run(sql, p), release() {} };

/** A side that has just pressed the names page: a full window, from now. */
const freshWindow = (): Window => ({
  started_at: new Date(),
  messages_sent: 0,
  granted_via: 'names-press',
});

beforeEach(() => {
  world = {
    windows: new Map([
      [key(ANA), freshWindow()],
      [key(BEPPE), freshWindow()],
    ]),
    messages: [],
    optinAt: new Map(),
  };
  vi.spyOn(db, 'getPool').mockReturnValue({
    query: async (sql: string, p: any[] = []) => run(sql, p),
    connect: async () => client,
  } as any);
});

const send = (who: string, text = 'Saturday morning works') =>
  channel.sendMessage(who, MATCH, text, cfg);

// ---------------------------------------------------------------------------
describe('the arithmetic of one window', () => {
  it('spends one per message and stops on the one past the budget', async () => {
    for (let i = 0; i < 3; i++) await expect(send(ANA)).resolves.toBeTruthy();
    expect(world.windows.get(key(ANA))!.messages_sent).toBe(3);

    const e = await send(ANA).catch((x) => x);
    expect(e).toBeInstanceOf(OsbError);
    expect(e.payload.code).toBe('CONVERSATION_PAUSED');
    // Nothing was carried, and the count did not creep past the budget.
    expect(world.messages).toHaveLength(3);
    expect(world.windows.get(key(ANA))!.messages_sent).toBe(3);
  });

  it('is spent by the days as well, however few messages have gone', async () => {
    world.windows.set(key(ANA), {
      started_at: new Date(Date.now() - 8 * 86_400_000),
      messages_sent: 0,
      granted_via: 'names-press',
    });
    await expect(send(ANA)).rejects.toMatchObject({ payload: { code: 'CONVERSATION_PAUSED' } });
    expect(world.messages).toHaveLength(0);
  });

  it('is one statement, so two sends racing cannot both take the last one', async () => {
    world.windows.get(key(ANA))!.messages_sent = 2; // one left
    const both = await Promise.allSettled([send(ANA), send(ANA)]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(world.messages).toHaveLength(1);
  });

  it('spends one on a message the intake pipe refuses, the way the hourly slot is spent', async () => {
    await send(ANA, 'Happy to do $420 for it').catch(() => {});
    expect(world.windows.get(key(ANA))!.messages_sent).toBe(1);
    expect(world.messages).toHaveLength(0);
  });

  it('opens a window for a side that has none, dated from that human own press', async () => {
    world.windows.delete(key(ANA));
    world.optinAt.set(ANA, new Date(Date.now() - 2 * 86_400_000));
    await expect(send(ANA)).resolves.toBeTruthy();
    expect(world.windows.get(key(ANA))!.messages_sent).toBe(1);

    // And one whose opt-in is older than the days is paused on sight: the
    // clock has been running since that press, and a lazy row must not wind it
    // back to now.
    world.windows.delete(key(BEPPE));
    world.optinAt.set(BEPPE, new Date(Date.now() - 30 * 86_400_000));
    await expect(send(BEPPE)).rejects.toMatchObject({
      payload: { code: 'CONVERSATION_PAUSED' },
    });
  });
});

// ---------------------------------------------------------------------------
describe('what a paused side is told, and what it can still do', () => {
  const spend = async (who: string) => {
    for (let i = 0; i < 3; i++) await send(who);
  };

  it('answers ordinarily, with the plain word and the sentence to act on', async () => {
    await spend(ANA);
    const r: any = await dispatchTool(cfg, ANA, 'send_message', {
      intro_id: MATCH,
      text: 'one more thing',
    });
    // An answer rather than a failure: the agent has done nothing wrong.
    expect(r.isError).toBe(false);
    const said = r.structuredContent;
    expect(said.what_happened).toBe('conversation_paused');
    expect(said.code).toBe('CONVERSATION_PAUSED');
    expect(said.human_action).toBe(cw.CONVERSATION_PAUSED_WORDS);
    expect(said.human_action).toContain('paused on your side');
    expect(said.human_action).toContain('request_keep_talking');
    expect(said.human_action).toContain('Nothing is lost');
  });

  it('can still collect everything the other side has sent', async () => {
    await send(BEPPE, 'can you do Saturday?');
    await spend(ANA);
    await expect(send(ANA)).rejects.toBeInstanceOf(OsbError);

    const got = await channel.receiveMessages(ANA, MATCH, cfg);
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0].body.text).toContain('Saturday');
  });

  it('leaves the other side alone, and tells it nothing', async () => {
    await spend(ANA);
    await expect(send(ANA)).rejects.toBeInstanceOf(OsbError);

    // Their sends still go, and still wait to be collected.
    await expect(send(BEPPE, 'still there?')).resolves.toBeTruthy();
    expect(world.windows.get(key(BEPPE))!.messages_sent).toBe(1);

    // And nothing in their sweep says a word about the far side's window.
    const r: any = await dispatchTool(cfg, BEPPE, 'check_in', {});
    const entry = r.structuredContent.introductions.find((m: any) => m.intro_id === MATCH);
    expect(JSON.stringify(entry)).not.toContain('paused');
  });
});

// ---------------------------------------------------------------------------
describe('starting a fresh window', () => {
  it('lets a paused side carry on again', async () => {
    for (let i = 0; i < 3; i++) await send(ANA);
    await expect(send(ANA)).rejects.toBeInstanceOf(OsbError);

    await cw.startFreshWindow(MATCH, ANA, 'renewal-press');
    expect(world.windows.get(key(ANA))!.messages_sent).toBe(0);
    expect(world.windows.get(key(ANA))!.granted_via).toBe('renewal-press');
    await expect(send(ANA)).resolves.toBeTruthy();
  });

  it('may be done EARLY, and simply starts the window again', async () => {
    await send(ANA);
    expect(world.windows.get(key(ANA))!.messages_sent).toBe(1);
    await cw.startFreshWindow(MATCH, ANA, 'renewal-press');
    // The whole budget is there again, rather than what was left of the old one.
    expect(world.windows.get(key(ANA))!.messages_sent).toBe(0);
    for (let i = 0; i < 3; i++) await expect(send(ANA)).resolves.toBeTruthy();
  });

  it('grants nothing to the other side', async () => {
    world.windows.get(key(BEPPE))!.messages_sent = 3;
    await cw.startFreshWindow(MATCH, ANA, 'renewal-press');
    expect(world.windows.get(key(BEPPE))!.messages_sent).toBe(3);
    await expect(send(BEPPE)).rejects.toMatchObject({
      payload: { code: 'CONVERSATION_PAUSED' },
    });
  });
});

// ---------------------------------------------------------------------------
describe('what the sweep says about it', () => {
  const sweepEntry = async (who: string) => {
    const r: any = await dispatchTool(cfg, who, 'check_in', {});
    return r.structuredContent.introductions.find((m: any) => m.intro_id === MATCH);
  };

  it('says the caller own side is paused, in plain words', async () => {
    for (let i = 0; i < 3; i++) await send(ANA);
    const entry = await sweepEntry(ANA);
    expect(entry.conversation.your_side).toBe('paused');
    expect(entry.conversation.window_note.text).toBe(cw.PAUSED_SWEEP_SENTENCE);
    expect(entry.conversation.window_note.provenance).toBe('switchboard-system');
  });

  it('says how many are left once the end is near, so the agent can ask ahead', async () => {
    await send(ANA);
    const entry = await sweepEntry(ANA);
    expect(entry.conversation.messages_left).toBe(2);
    expect(entry.conversation.window_note.text).toContain('2 more messages');
    expect(entry.conversation.window_note.text).toContain('keep going');
  });

  it('says nothing at all while there is plenty of room', async () => {
    const roomy = { ...cfg, conversationBudgetMessages: 100 } as unknown as Config;
    const r: any = await dispatchTool(roomy, ANA, 'check_in', {});
    const entry = r.structuredContent.introductions.find((m: any) => m.intro_id === MATCH);
    expect(entry.conversation.window_note).toBeUndefined();
    expect(entry.conversation.messages_left).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('the sentences a human hears about it', () => {
  it('keep the house register', () => {
    expect(lintHumanCopy(cw.CONVERSATION_PAUSED_WORDS)).toEqual([]);
    expect(lintHumanCopy(cw.PAUSED_SWEEP_SENTENCE)).toEqual([]);
    expect(lintHumanCopy(cw.remainingSentence(1))).toEqual([]);
    expect(lintHumanCopy(cw.remainingSentence(6))).toEqual([]);
  });

  it('count one as one', () => {
    expect(cw.remainingSentence(1)).toContain('One more message');
    expect(cw.remainingSentence(4)).toContain('4 more messages');
  });
});

// ---------------------------------------------------------------------------
// The migration behind all of it. The unit suite never reaches Postgres, so
// the statements the code issues are held to the table the migration writes:
// a column the code reads and the migration never created is a green suite and
// a broken deployment (see test/unit/linkActionsMigrated.test.ts, which exists
// for exactly that reason).
describe('migration 044', () => {
  const sql = readFileSync(
    join(__dirname, '..', '..', 'migrations', '044_conversation_windows.sql'),
    'utf8',
  );

  it('creates the table with every column the code reads and writes', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS conversation_windows/);
    for (const column of ['match_id', 'account_id', 'started_at', 'messages_sent', 'granted_via']) {
      expect(sql, `${column} is read by the code and missing from the migration`).toContain(column);
    }
    expect(sql).toMatch(/PRIMARY KEY \(match_id, account_id\)/);
    expect(sql).toMatch(/messages_sent integer NOT NULL DEFAULT 0/);
  });

  it('backfills every open conversation, so nothing live pauses on deploy', () => {
    expect(sql).toMatch(/INSERT INTO conversation_windows/);
    expect(sql).toMatch(/WHERE m\.channel_id IS NOT NULL/);
    expect(sql).toMatch(/ON CONFLICT \(match_id, account_id\) DO NOTHING/);
    // Both parties of each one, not just whichever side happens to send first.
    expect(sql).toContain('m.account_want');
    expect(sql).toContain('m.account_have');
  });

  it('lets the database accept the renewal link the code mints', () => {
    expect(sql).toContain("'conversation-renew'");
    expect(sql).toMatch(/approval_links_action_check/);
  });
});
