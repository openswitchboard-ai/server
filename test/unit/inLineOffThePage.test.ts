/**
 * THE PAGE NEVER SHOWS AN INTRODUCTION STILL IN LINE (28 September 2026).
 *
 * The fit sequencer (domain/sequencer.ts) says only LIVE introductions surface
 * to the holder; the rest are in line and "the holder is never shown them at
 * all". On dev a want with one slot showed three "Share your name" boxes on
 * the main page, two of them for introductions still in line (live = false),
 * because the read behind that box had no live filter. What is asserted here:
 *
 *  - every read that feeds the main page, the match page and the ledger's
 *    counts carries the live filter;
 *  - the main page's second wall drops everything on an in-line introduction
 *    before it is grouped, so one live introduction makes one box;
 *  - the story read answers nothing for an in-line introduction, so neither
 *    the box nor the match page can be drawn for one;
 *  - the line that tells two boxes apart is read from the details payload the
 *    assistant sees, and says nothing that payload does not;
 *  - "Keep them all" and "Keep it" renew exactly what they say.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
  decryptFields: vi.fn(async () => ({})),
}));

import { writeConsentEvent } from '../../src/crypto.js';
import * as db from '../../src/db.js';
import * as ops from '../../src/domain/counterOps.js';
import { readStoryFacts, theirThingLine } from '../../src/domain/matchStory.js';
import { dropInLine, groupWaitingByMatch, matchBoxHtml } from '../../src/counter/matchStory.js';
import type { Config } from '../../src/config.js';

const ME = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const LIVE = '11111111-0000-4000-8000-000000000001';
const LINE_A = '11111111-0000-4000-8000-000000000002';
const LINE_B = '11111111-0000-4000-8000-000000000003';

/** A pool that records every statement and answers from a table of prefixes. */
function recordingPool(answers: [RegExp, any[]][] = []) {
  const sql: string[] = [];
  const params: any[][] = [];
  const pool = {
    query: async (q: string, p: any[] = []) => {
      sql.push(q.replace(/\s+/g, ' ').trim());
      params.push(p);
      for (const [re, rows] of answers) if (re.test(q)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
  };
  vi.spyOn(db, 'getPool').mockReturnValue(pool as any);
  return { sql, params };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(writeConsentEvent).mockClear();
});

describe('every read behind the page carries the live filter', () => {
  it('the names question: an in-line introduction never asks to share a name', async () => {
    const { sql } = recordingPool();
    await ops.pendingDisclosures(ME);
    expect(sql[0]).toContain("m.state = 'open' AND m.live");
  });

  it('offers waiting, messages waiting and deals agreed', async () => {
    const { sql } = recordingPool();
    await ops.pendingOffers(ME);
    await ops.messagesWaitingFor(ME);
    await ops.agreedOnMatches(ME);
    expect(sql[0]).toContain("m.state = 'open' AND m.live");
    expect(sql[1]).toContain(ops.NOT_IN_LINE_SQL);
    expect(sql[2]).toContain(ops.NOT_IN_LINE_SQL);
  });

  it('the match page: an in-line introduction is not one the person can open', async () => {
    const { sql } = recordingPool();
    expect(await ops.matchForHuman(ME, LINE_A)).toBeUndefined();
    expect(sql[0]).toContain(ops.NOT_IN_LINE_SQL);
  });

  it('the ledger counts introductions that reached the person, not the line', async () => {
    const { sql } = recordingPool([[/SELECT \* FROM accounts/, [{ id: ME, data_key_enc: null }]]]);
    await ops.ledgerCards({} as Config, ME);
    const ledger = sql.find((q) => q.startsWith('SELECT c.*'));
    expect(ledger).toContain(ops.SURFACED_SQL);
  });

  it('the predicate itself: an open row out of a slot is in line; a closed row is not', () => {
    expect(ops.NOT_IN_LINE_SQL).toBe("(m.state <> 'open' OR m.live)");
    expect(ops.SURFACED_SQL).toBe('(m.live OR m.live_at IS NOT NULL)');
  });

  it('inLineMatchIds reads exactly the open rows out of a slot', async () => {
    const { sql } = recordingPool([[/NOT \(m\.state/, [{ id: LINE_A }, { id: LINE_B }]]]);
    const ids = await ops.inLineMatchIds(ME);
    expect([...ids].sort()).toEqual([LINE_A, LINE_B]);
    expect(sql[0]).toContain(`AND NOT ${ops.NOT_IN_LINE_SQL}`);
  });
});

describe('the main page draws one box for one live introduction', () => {
  // The dev case: a want with slots = 1, three introductions, one live.
  const waiting = () => ({
    openLinks: [
      { id: 'l1', action: 'stage3-disclosure', ref_id: LINE_A, match_id: LINE_A } as any,
    ],
    offers: [],
    disclosures: [{ match_id: LIVE }, { match_id: LINE_A }, { match_id: LINE_B }],
    settlements: [],
    messages: [{ match_id: LINE_B, count: 2 }],
  });

  it('without the wall, three boxes asked to share a name', () => {
    const { byMatch } = groupWaitingByMatch(waiting());
    expect(byMatch.size).toBe(3);
  });

  it('with it, one box, and nothing about the two in line', () => {
    const w = dropInLine(waiting(), new Set([LINE_A, LINE_B]));
    const { byMatch, otherLinks } = groupWaitingByMatch(w);
    expect([...byMatch.keys()]).toEqual([LIVE]);
    expect(byMatch.get(LIVE)!.actions.map((a) => a.label)).toEqual(['Share your name']);
    // No open link for an in-line introduction falls through to a loose tile.
    expect(otherLinks).toEqual([]);
    expect(w.messages).toEqual([]);
  });

  it('a link that belongs to no introduction is left alone', () => {
    const w = dropInLine(
      { ...waiting(), openLinks: [{ id: 'l2', action: 'shelf-pick', ref_id: 'card-1' } as any] },
      new Set([LINE_A]),
    );
    expect(w.openLinks).toHaveLength(1);
  });
});

describe('the story read answers nothing for an introduction in line', () => {
  it('so neither a box nor the match page can be drawn for one', async () => {
    const { sql } = recordingPool([
      [
        /FROM matches m\s+LEFT JOIN cards c/,
        [
          {
            id: LINE_A,
            state: 'open',
            live: false,
            stage: 2,
            created_at: new Date(),
            account_want: ME,
            account_have: 'other',
            category: 'goods.bicycle.mountain',
          },
        ],
      ],
    ]);
    expect(await readStoryFacts(ME, LINE_A)).toBeUndefined();
    // Nothing past the match row was read: no opt-ins, no offers, no names.
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('m.live');
  });
});

describe('telling two boxes apart', () => {
  const payload = (over: any = {}) => ({
    schema_version: 'x',
    kind: 'intro.attributes',
    intro_id: LIVE,
    attributes: { brand: 'Trek', model: 'Marlin 5' },
    notes: [
      { text: 'Everything under attributes here is the other side’s own words.', provenance: 'switchboard-system' },
      { text: 'Trek Marlin 5 mountain bike', provenance: 'counterparty-untrusted' },
      { text: 'hardtail', provenance: 'counterparty-untrusted' },
    ],
    ask: { amount: 620, ccy: 'AUD' },
    ...over,
  });

  it('their own word for their thing, and the asking figure they chose to show', () => {
    expect(theirThingLine(payload())).toBe('Theirs: Trek Marlin 5 mountain bike · asking $620 AUD');
  });

  it('no ask, no asking; nothing to say, no line', () => {
    expect(theirThingLine(payload({ ask: undefined }))).toBe('Theirs: Trek Marlin 5 mountain bike');
    expect(theirThingLine(payload({ ask: undefined, notes: [] }))).toBeUndefined();
  });

  it('reads nothing the details step does not carry, and no private band even if one were there', () => {
    const line = theirThingLine(payload({ price: { band: { min: 500, max: 700 } } }))!;
    expect(line).not.toContain('500');
    expect(line).not.toContain('700');
    // The switchboard's own note is not their words.
    expect(line).not.toContain('Everything under attributes');
  });

  it('the box carries it under the title, escaped, and no "waiting for you" badge', () => {
    const html = matchBoxHtml({
      head: { matchId: LIVE, thing: 'hardtail mountain bike', theirs: 'Theirs: <b>Trek</b>' },
      steps: [{ at: new Date(), text: 'You were introduced' }],
      actions: [{ href: '/approvals/match/x', label: 'Share your name' }],
    });
    expect(html).toContain('<h3 class="mb-title"');
    expect(html).toContain('<p class="mb-theirs">Theirs: &lt;b&gt;Trek&lt;/b&gt;</p>');
    expect(html).not.toContain('WAITING FOR YOU');
  });
});

describe('keeping what is lapsing', () => {
  it('"Keep them all" renews exactly the lapsing ones, consent first', async () => {
    const { sql } = recordingPool([
      [/^\s*SELECT id FROM cards/, [{ id: 'c1' }]],
      [/UPDATE cards/, [{ id: 'c1', type: 'WANT', category: 'x', expires_at: new Date() }]],
    ]);
    const out = await ops.renewAllCards(ME, 'counter', 'lapsing');
    expect(out).toHaveLength(1);
    expect(sql[0]).toContain(`expires_at <= now() + interval '${ops.LAPSING_DAYS} days'`);
    expect(sql[1]).toContain(`expires_at <= now() + interval '${ops.LAPSING_DAYS} days'`);
    expect(vi.mocked(writeConsentEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cards-renewed', card_ids: ['c1'], recorded_via: 'counter' }),
    );
  });

  it('"Keep it" renews one, by id, and only the account\'s own', async () => {
    const { sql, params } = recordingPool([[/^\s*SELECT id FROM cards/, []]]);
    expect(await ops.renewAllCards(ME, 'counter', { cardId: 'c9' })).toEqual([]);
    expect(sql[0]).toContain('account_id = $1');
    expect(sql[0]).toContain('AND id = $2');
    expect(params[0]).toEqual([ME, 'c9']);
    // Nothing to renew: no consent event, no update.
    expect(vi.mocked(writeConsentEvent)).not.toHaveBeenCalled();
    expect(sql).toHaveLength(1);
  });

  it('the token route still renews everything open, as the email promised', async () => {
    const { sql } = recordingPool();
    await ops.renewAllCards(ME, 'email-renew-all-link');
    expect(sql[0]).not.toContain('interval');
    expect(sql[0]).not.toContain('id = $2');
  });
});
