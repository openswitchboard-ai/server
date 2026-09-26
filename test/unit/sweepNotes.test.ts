/**
 * Never read a field name aloud — held shut mechanically.
 *
 * The defect this suite exists to hold shut, from the 2026-09-12 rehearsal: an
 * assistant read `taken_down` and `hears_via` out to its human as the words on
 * the wire. The manual asks agents not to, and asking is not enough. The rule
 * with teeth is the other way round: every field in the sweep that changes
 * what the agent should say carries the saying of it, so there is always a
 * sentence to lead with and never a reason to name the machinery.
 *
 * The fields audited here are the five from run 7 — taken_down, the line of
 * people waiting on the caller's own want or have, timezone, hears_via,
 * runs_on_its_own — and the rule asserted is that each one has a
 * switchboard-authored sentence beside it. (The fifth was the collection
 * window when this suite was written; migration 030 replaced it with the
 * line, and the rule about it is exactly the same.)
 *
 * The taken_down case is the one that was actually broken: its sentence
 * existed only on the branch where the two were simply talking, so a sweep
 * that had anything else to say (a figure on the table, a deal agreed) handed
 * the bare field across with no words for it at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v.toString('utf8').replace(/^enc:/, '')]),
    ),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

import * as db from '../../src/db.js';
import { hearsViaNote } from '../../src/domain/accounts.js';
import { runsOnItsOwnNote } from '../../src/domain/arrangement.js';
import { checkMatches } from '../../src/domain/matches.js';
import { TOOLS, dispatchTool } from '../../src/mcp/tools.js';
import { lintEmailCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

interface World {
  hearsVia: 'email' | 'assistant';
  arrangement: Record<string, unknown> | null;
  timezone: string | null;
  /** Which side's want or have has been taken down, if either. */
  withdrawn: 'none' | 'yours' | 'theirs';
  /** An accepted figure on the table, which owns the entry's main sentence. */
  dealAgreed: boolean;
  /** People waiting behind this one on the caller's own want or have. */
  collecting: boolean;
  /** The area this human set on their own page, if any. */
  locality: string;
}
let world: World;

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/^\s*SELECT m\.\*[^;]*FROM matches m/.test(sql)) {
        return rows([
          {
            id: MATCH,
            card_want: CARD_W,
            card_have: CARD_H,
            account_want: ANA,
            account_have: BEPPE,
            score: 0.8,
            category: 'goods.bicycle.mountain',
            stage: 4,
            interest_want: true,
            interest_have: true,
            state: 'open',
            channel_id: 'ch_1',
            opened_at: new Date('2026-09-09T00:00:00Z'),
          },
        ]);
      }
      // The line behind this one, read for the holder only.
      if (/count\(\*\)::int AS n FROM matches m/.test(sql)) {
        return rows([{ n: world.collecting ? 3 : 0 }]);
      }
      if (/FROM cards c/.test(sql)) return rows([]);
      if (/^\s*SELECT \* FROM cards WHERE id/.test(sql)) {
        const mine = params[0] === CARD_W;
        const down =
          world.withdrawn === 'yours' ? mine : world.withdrawn === 'theirs' ? !mine : false;
        return rows([
          {
            id: params[0],
            type: mine ? 'WANT' : 'HAVE',
            category: 'goods.bicycle.mountain',
            attributes: {},
            ask: null,
            lifecycle_state: down ? 'WITHDRAWN' : 'PUBLISHED',
            account_id: mine ? ANA : BEPPE,
          },
        ]);
      }
      // Both sides' figures. One accepted figure makes the deal the entry's
      // main sentence, which is what used to leave taken_down speechless.
      if (/FROM offers/.test(sql) && /state IN \('proposed', 'awaiting-human', 'accepted/.test(sql)) {
        return world.dealAgreed
          ? rows([
              {
                id: 'o-1',
                proposer_account: ANA,
                amount: '415',
                ccy: 'AUD',
                state: 'accepted-by-human',
                message: null,
                authored_by: 'human',
                created_at: new Date('2026-09-10T00:00:00Z'),
              },
            ])
          : rows([]);
      }
      if (/count\(DISTINCT account_id\)/.test(sql)) return rows([{ n: 0 }]);
      if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: world.hearsVia }]);
      if (/SELECT timezone FROM accounts/.test(sql)) return rows([{ timezone: world.timezone }]);
      if (/SELECT arrangement FROM accounts/.test(sql)) {
        return rows([{ arrangement: world.arrangement }]);
      }
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
        return rows([
          {
            id: params[0],
            status: 'active',
            data_key_enc: Buffer.from('wrapped'),
            first_name_enc: Buffer.from(params[0] === ANA ? 'enc:Ana' : 'enc:Beppe'),
            locality_enc: Buffer.from(
              `enc:${params[0] === ANA ? world.locality : 'Trastevere'}`,
            ),
          },
        ]);
      }
      if (/read_calls|write_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  world = {
    hearsVia: 'email',
    arrangement: null,
    timezone: 'Australia/Perth',
    withdrawn: 'none',
    dealAgreed: false,
    collecting: false,
    locality: 'Fremantle',
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

const isNote = (n: any) =>
  !!n && typeof n.text === 'string' && n.text.trim().length > 20 && n.provenance === 'switchboard-system';

// ---------------------------------------------------------------------------
describe('taken_down never travels bare', () => {
  it('carries its own sentence when the sweep has something else to say', async () => {
    world.withdrawn = 'yours';
    world.dealAgreed = true;
    const [entry]: any = await checkMatches(cfg, ANA);
    // The entry's own sentence is about the figure, as it should be.
    expect(entry.next).toBe('deal_agreed');
    expect(entry.note.text).toMatch(/415/);
    // And the taken-down fact still has words of its own.
    expect(entry.taken_down).toBe('yours');
    expect(isNote(entry.taken_down_note)).toBe(true);
    expect(entry.taken_down_note.text).toMatch(/has been taken down/);
    expect(entry.taken_down_note.text).toMatch(/what your human put up/i);
  });

  it('says whose it was, from the reading side', async () => {
    world.withdrawn = 'theirs';
    const [entry]: any = await checkMatches(cfg, ANA);
    expect(entry.taken_down).toBe('theirs');
    expect(entry.taken_down_note.text).toMatch(/what they put up/i);
  });

  it('says nothing at all when nothing has been taken down', async () => {
    const [entry]: any = await checkMatches(cfg, ANA);
    expect(entry.taken_down).toBeUndefined();
    expect(entry.taken_down_note).toBeUndefined();
    expect(entry.note.text).toMatch(/connected now/i);
  });
});

// ---------------------------------------------------------------------------
describe('the whole sweep: every field that changes what to say has a sentence', () => {
  it('holds for the five fields from run 7', async () => {
    world.withdrawn = 'theirs';
    world.collecting = true;
    const r: any = await dispatchTool(cfg, ANA, 'check_in', {});
    const body = r.structuredContent;
    const [entry] = body.introductions;

    expect(isNote(body.hears_via_note)).toBe(true);
    expect(isNote(body.runs_on_its_own_note)).toBe(true);
    expect(isNote(body.time_note)).toBe(true);
    expect(isNote(entry.taken_down_note)).toBe(true);
    expect(isNote(entry.line.note)).toBe(true);

    // The fields themselves are still there for the agent to act on.
    expect(body.hears_via).toBe('email');
    expect(body.runs_on_its_own).toBe(false);
    expect(body.timezone).toBe('Australia/Perth');
    expect(entry.taken_down).toBe('theirs');
    expect(entry.line.in_line).toBe(3);
  });

  it('the sweep never leaves the clock without words either', async () => {
    world.timezone = null;
    const r: any = await dispatchTool(cfg, ANA, 'check_in', {});
    // No zone on file, so there is nothing to say about the clock and the
    // field is null rather than a bare instant with no sentence.
    expect(r.structuredContent.timezone).toBeNull();
    expect(r.structuredContent.time_note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("the human's own area rides the sweep", () => {
  // Run 8, 13 September 2026: "I've got a mountain bike to sell." The
  // assistant asked which suburb, was given the bike, and asked again. "It
  // seems the location didn't pass through?" It never did — the area sat on
  // the account and was read only when first names crossed.
  it('hands the agent its own human area, written out, with the sentence', async () => {
    const r: any = await dispatchTool(cfg, ANA, 'check_in', {});
    const body = r.structuredContent;
    expect(body.area).toBe('Fremantle');
    expect(body.area_resolved).toBe('Fremantle, Western Australia, Australia');
    expect(isNote(body.area_note)).toBe(true);
    expect(body.area_note.text).toContain('Fremantle, Western Australia, Australia');
    // Never silently: it says to tell the human which area was used.
    expect(body.area_note.text).toMatch(/tell them which area/i);
    expect(lintEmailCopy(body.area_note.text)).toEqual([]);
  });

  it('says nothing at all when no area is set, so the agent asks as it does today', async () => {
    world.locality = '';
    const r: any = await dispatchTool(cfg, ANA, 'check_in', {});
    expect(r.structuredContent.area).toBeUndefined();
    expect(r.structuredContent.area_resolved).toBeUndefined();
    expect(r.structuredContent.area_note).toBeUndefined();
  });

  it('keeps an area the gazetteer cannot settle as the words the human typed', async () => {
    for (const typed of ['behind the servo', 'Perth', 'Western Australia']) {
      world.locality = typed;
      const r: any = await dispatchTool(cfg, ANA, 'check_in', {});
      expect(r.structuredContent.area, typed).toBe(typed);
      // Nothing is claimed as settled that the posting path would refuse or
      // ask about: a name several cities answer to, and a whole state.
      expect(r.structuredContent.area_resolved, typed).toBeUndefined();
      expect(r.structuredContent.area_note.text, typed).toContain(typed);
      // And the sentence says to ask for it in full, because the bare words
      // would be refused on a posting (26 September 2026).
      expect(r.structuredContent.area_note.text, typed).toMatch(/town, state and country/);
      expect(r.structuredContent.area_note.text, typed).not.toMatch(/use that as the area/i);
    }
  });

  it('goes to this human alone and never into an introduction', async () => {
    const r: any = await dispatchTool(cfg, ANA, 'check_in', {});
    const entries = JSON.stringify(r.structuredContent.introductions);
    expect(entries).not.toContain('Fremantle');
    expect(entries).not.toContain('area_note');
  });
});

// ---------------------------------------------------------------------------
describe('the two sentences the sweep grew', () => {
  it('hears_via says what it changes about how to talk to them', () => {
    expect(hearsViaNote('email').text).toMatch(/emailed about anything that needs them/i);
    expect(hearsViaNote('assistant').text).toMatch(/you are the one who brings/i);
    for (const v of ['email', 'assistant'] as const) {
      expect(lintEmailCopy(hearsViaNote(v).text)).toEqual([]);
    }
  });

  it('runs_on_its_own says whether you may go and look on your own', () => {
    expect(runsOnItsOwnNote(true).text).toMatch(/you may look again on your own/i);
    expect(runsOnItsOwnNote(false).text).toMatch(/no oftener/i);
    for (const v of [true, false]) {
      expect(lintEmailCopy(runsOnItsOwnNote(v).text)).toEqual([]);
    }
  });

  it('check_in tells the agent the rule and names the sentences', () => {
    const desc = TOOLS.find((t) => t.name === 'check_in')!.description;
    expect(desc).toContain('NEVER READ A FIELD NAME ALOUD');
    for (const field of [
      'taken_down_note',
      'hears_via_note',
      'runs_on_its_own_note',
      'time_note',
      'area_note',
      'arrangement_note',
    ]) {
      expect(desc, field).toContain(field);
    }
  });
});
