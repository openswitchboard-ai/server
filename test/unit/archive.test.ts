/**
 * Archiving a finished connection (the success close) and keeping it
 * retrievable afterwards.
 *
 * The rules asserted here, against the real domain code and the SQL it issues
 * (a small in-memory Postgres stands in, so the statements are the things
 * under test):
 *
 *  - ARCHIVE: respond(archive) sets an OPEN match to state 'archived' and
 *    records who filed it and when (archived_by / archived_at / archived_via),
 *    and writes the WORM consent event.
 *  - PARTY ONLY: a stranger cannot archive — the match is not found for them.
 *  - IDEMPOTENT: archiving an already-archived match records nothing new and
 *    still reports it archived; a declined/closed match cannot be archived.
 *  - CHANNEL TORN DOWN: once archived, channel_send and channel_receive refuse
 *    (NOT_UNLOCKED_YET), and any uncollected message is expired for the sweep.
 *  - RETRIEVABLE (the whole point): check_in returns the archived introduction
 *    with state 'archived', its category, the archive date, and — where the
 *    two reached stage 3 — the disclosed mutual first name and area.
 *  - NOT ACTIONABLE: an archived match carries no `next` and no stage-1
 *    `signal`, so it never resurfaces as something new to act on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v.toString('utf8').replace(/^enc:/, '')]),
    ),
  ),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  generateChannelKey: vi.fn(async (channelId: string) => Buffer.from(`ckey:${channelId}`)),
}));

import * as db from '../../src/db.js';
import * as crypto from '../../src/crypto.js';
import * as matches from '../../src/domain/matches.js';
import * as channel from '../../src/domain/channel.js';
import { OsbError, validateOutbound } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const cfg = { envName: 'dev', publicOrigin: 'https://mcp.test' } as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // WANT side, the caller
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // HAVE side, counterparty
const STRANGER = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const CHANNEL = 'ch_11111111-2222-4333-8444-555555555555';

interface World {
  state: 'open' | 'declined' | 'closed' | 'archived';
  stage: number;
  archived_at: Date | null;
  archived_by: string | null;
  archived_via: string | null;
  channel_id: string | null;
  messagesExpired: boolean;
}
let world: World;

const account = (id: string, first: string, area: string) => ({
  id,
  data_key_enc: Buffer.from('dk'),
  first_name_enc: Buffer.from(`enc:${first}`, 'utf8'),
  locality_enc: Buffer.from(`enc:${area}`, 'utf8'),
});

const theMatch = () => ({
  id: MATCH,
  card_want: 'card-w',
  card_have: 'card-h',
  account_want: ANA,
  account_have: BEPPE,
  score: 0.82,
  category: 'social.book-club',
  stage: world.stage,
  interest_want: true,
  interest_have: true,
  state: world.state,
  channel_id: world.channel_id,
  opened_at: new Date('2026-09-01T00:00:00Z'),
  created_at: new Date('2026-09-01T00:00:00Z'),
  archived_at: world.archived_at,
  archived_by: world.archived_by,
  archived_via: world.archived_via,
});

function run(sql: string, params: any[] = []) {
  const rows = (r: any[]) => ({ rows: r, rowCount: r.length });

  // getMatch and the checkMatches sweep both read the match row.
  if (/^\s*SELECT \* FROM matches WHERE id/.test(sql)) {
    return rows(params[0] === MATCH ? [theMatch()] : []);
  }
  if (/SELECT m\.\* FROM matches m/.test(sql)) {
    const mine = params[0] === ANA || params[0] === BEPPE;
    return rows(mine ? [theMatch()] : []);
  }
  // archiveMatch's guarded UPDATE: only an open row transitions.
  if (/UPDATE matches\s+SET state = 'archived'/.test(sql)) {
    if (world.state !== 'open') return rows([]);
    world.state = 'archived';
    world.archived_by = params[1];
    world.archived_via = params[2];
    world.archived_at = new Date();
    return rows([{ id: MATCH }]);
  }
  // Channel teardown: expire any uncollected message.
  if (/UPDATE channel_messages SET expires_at = now\(\)/.test(sql)) {
    world.messagesExpired = true;
    return rows([{ id: 'm1' }]);
  }
  // Stage-3 gate: both opt-in tokens are on record for this pair.
  if (/count\(DISTINCT account_id\)::int AS n FROM consent_tokens/.test(sql)) {
    return rows([{ n: 2 }]);
  }
  if (/max\(recorded_at\) AS at FROM consent_tokens/.test(sql)) {
    return rows([{ at: new Date('2026-09-02T10:00:00Z') }]);
  }
  // getAccount for the counterparty (and the caller's own profile read).
  if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
    if (params[0] === BEPPE) return rows([account(BEPPE, 'Alex', 'Franklin')]);
    if (params[0] === ANA) return rows([account(ANA, 'Ana', 'Downtown')]);
    return rows([]);
  }
  // No open collection window in these scenarios.
  if (/collect_until/.test(sql)) return rows([]);
  throw new Error(`unexpected SQL in archive test: ${sql}`);
}

const fakePool = { query: async (sql: string, params?: any[]) => run(sql, params) } as any;

beforeEach(() => {
  world = {
    state: 'open',
    stage: 3,
    archived_at: null,
    archived_by: null,
    archived_via: null,
    channel_id: CHANNEL,
    messagesExpired: false,
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool);
});

describe('archiveMatch: filing a finished connection away', () => {
  it('sets an OPEN match to archived and records who and how', async () => {
    const r = await matches.archiveMatch(MATCH, ANA, 'agent-attested');
    expect(r).toMatchObject({ intro_id: MATCH, state: 'archived', already: false });
    expect(world.state).toBe('archived');
    expect(world.archived_by).toBe(ANA);
    expect(world.archived_via).toBe('agent-attested');
    expect(world.archived_at).toBeInstanceOf(Date);
    // The WORM consent event is written on the archive.
    expect(crypto.writeConsentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'match-archived', match_id: MATCH, account_id: ANA }),
    );
    // Uncollected channel messages are expired for the sweep.
    expect(world.messagesExpired).toBe(true);
  });

  it('lets only a party archive — a stranger does not find the match', async () => {
    await expect(matches.archiveMatch(MATCH, STRANGER, 'agent-attested')).rejects.toMatchObject({
      notFound: true,
    });
    expect(world.state).toBe('open');
  });

  it('is idempotent: archiving an archived match records nothing new', async () => {
    await matches.archiveMatch(MATCH, ANA, 'agent-attested');
    (crypto.writeConsentEvent as any).mockClear();
    const again = await matches.archiveMatch(MATCH, BEPPE, 'agent-attested');
    expect(again).toMatchObject({ state: 'archived', already: true });
    expect(crypto.writeConsentEvent).not.toHaveBeenCalled();
  });

  it('refuses to archive a declined match (only an open connection is filed away)', async () => {
    world.state = 'declined';
    await expect(matches.archiveMatch(MATCH, ANA, 'agent-attested')).rejects.toBeInstanceOf(
      OsbError,
    );
  });
});

describe('the channel is torn down once archived', () => {
  it('channel_send refuses on an archived match', async () => {
    await matches.archiveMatch(MATCH, ANA, 'agent-attested');
    await expect(channel.sendMessage(ANA, MATCH, 'still there?')).rejects.toMatchObject({
      payload: { code: 'NOT_UNLOCKED_YET' },
    });
  });

  it('channel_receive refuses on an archived match', async () => {
    await matches.archiveMatch(MATCH, ANA, 'agent-attested');
    await expect(channel.receiveMessages(ANA, MATCH)).rejects.toMatchObject({
      payload: { code: 'NOT_UNLOCKED_YET' },
    });
  });
});

describe('retrieval: an archived connection stays lookup-able', () => {
  it('check_in returns the archived introduction with its disclosed mutual details', async () => {
    await matches.archiveMatch(MATCH, ANA, 'agent-attested');
    const out = await matches.checkMatches(cfg, ANA);
    expect(out).toHaveLength(1);
    const entry = out[0] as any;
    expect(entry.state).toBe('archived');
    expect(entry.intro_id).toBe(MATCH);
    expect(entry.category).toBe('social.book-club');
    expect(typeof entry.archived_at).toBe('string');
    // The whole point: the disclosed first name and area come back so a human
    // can look up "you connected with Alex in Franklin".
    expect(entry.mutual.counterparty).toEqual({ first_name: 'Alex', locality: 'Franklin' });
    expect(validateOutbound('intro.mutual', entry.mutual).valid).toBe(true);
    // The recall carries a ready, jargon-free sentence the agent leads with —
    // the first name and area, plainly, with no card/match/stage/score word.
    expect(entry.note.provenance).toBe('switchboard-system');
    expect(entry.note.text).toMatch(/got chatting with Alex over in Franklin about book club/i);
    expect(entry.note.text).not.toMatch(/\b(card|match|stage|score|listing|channel|connection)\b/i);
  });

  it('an archived match is not an actionable signal — no next, no signal', async () => {
    await matches.archiveMatch(MATCH, ANA, 'agent-attested');
    const entry = (await matches.checkMatches(cfg, ANA))[0] as any;
    expect(entry.next).toBeUndefined();
    expect(entry.signal).toBeUndefined();
  });

  it('the counterparty can retrieve it too, seeing the caller as their disclosed match', async () => {
    await matches.archiveMatch(MATCH, ANA, 'agent-attested');
    const entry = (await matches.checkMatches(cfg, BEPPE))[0] as any;
    expect(entry.state).toBe('archived');
    expect(entry.mutual.counterparty).toEqual({ first_name: 'Ana', locality: 'Downtown' });
  });
});
