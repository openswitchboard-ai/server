/**
 * The standing arrangement — the account-level note saying how a human wants
 * their agents to behave, and the one thing on this network that is designed
 * to outlive the agent that wrote it.
 *
 * The defect this suite exists to hold shut: an agent and its human agree a
 * cadence ("check twice a day, wake me for a match, leave me alone after
 * nine"), and then the session ends, or the model changes, or the human opens
 * a different client, and the agreement is gone. Nobody notices it is gone;
 * the new agent simply starts asking again, or worse, starts pinging at
 * midnight. Held on the account and handed back on every sweep, the agreement
 * is the network's to remember rather than any one agent's.
 *
 * The rules asserted here:
 *  - the shape is validated, capped, and free of anything shaped like a way to
 *    reach someone — which is what earns the plaintext column;
 *  - a set through the agent surface round-trips to a get;
 *  - every check_in sweep carries the current object, so an agent that
 *    has never spoken to this human still learns how they want to be treated;
 *  - each set writes one WORM event naming the fields and none of the words;
 *  - the human's page shows it in plain words and can edit or clear it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  encryptField: vi.fn(async (_a: string, _k: Buffer, plaintext: string) =>
    Buffer.from(`enc:${plaintext}`),
  ),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v.toString('utf8').replace(/^enc:/, '')]),
    ),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

import { writeConsentEvent } from '../../src/crypto.js';
import * as db from '../../src/db.js';
import * as arrangement from '../../src/domain/arrangement.js';
import * as home from '../../src/counter/pagesHome.js';
import { TOOLS, dispatchTool } from '../../src/mcp/tools.js';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.js';
import { lintEmailCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  legacyCounterHosts: ['counter.test'],
  publicOrigin: 'https://mcp.test',
} as unknown as Config;

const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

interface World {
  stored: Record<string, unknown> | null;
  updatedAt: Date | null;
}
let world: World;

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/SELECT arrangement FROM accounts/.test(sql)) {
        return rows([{ arrangement: world.stored }]);
      }
      if (/SELECT arrangement_updated_at FROM accounts/.test(sql)) {
        return rows([{ arrangement_updated_at: world.updatedAt }]);
      }
      if (/UPDATE accounts SET arrangement/.test(sql)) {
        world.stored = JSON.parse(params[1]);
        world.updatedAt = new Date('2026-09-02T04:00:00.000Z');
        return rows([]);
      }
      // The read ceiling is checked before the sweep runs; this world never
      // gets near it.
      if (/read_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
      // No matches, no cards: the sweep is empty and the arrangement is the
      // only thing it has to say.
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  world = { stored: null, updatedAt: null };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.mocked(writeConsentEvent).mockClear();
});

const FULL: arrangement.Arrangement = {
  check_every_minutes: 720,
  interrupt_for: ['a new match', 'a message on a match we are talking on'],
  summarize: 'a round-up on Sunday evening',
  suggestion_appetite: 'occasional',
  quiet_hours: 'after 9pm and before 7am',
  notes: 'weekends are fine, weekdays before lunch are not great',
};

// ---------------------------------------------------------------------------
describe('validateArrangement: the shape', () => {
  it('accepts the whole object and trims every field', () => {
    const r = arrangement.validateArrangement({
      ...FULL,
      interrupt_for: [' a new match ', 'a message on a match we are talking on'],
    });
    expect(r).toEqual({ ok: true, value: FULL });
  });

  it('an absent, empty or null arrangement is the empty one', () => {
    for (const input of [undefined, null, {}]) {
      expect(arrangement.validateArrangement(input)).toEqual({ ok: true, value: {} });
    }
    expect(arrangement.isEmpty({})).toBe(true);
    expect(arrangement.isEmpty(FULL)).toBe(false);
  });

  it('drops blank fields rather than storing empty strings', () => {
    const r = arrangement.validateArrangement({
      check_every_minutes: '',
      interrupt_for: ['', '  '],
      notes: 'once a week is plenty',
    });
    expect(r).toEqual({ ok: true, value: { notes: 'once a week is plenty' } });
  });

  it('refuses a field that is not part of an arrangement', () => {
    const r = arrangement.validateArrangement({ check_every_minutes: 720, email: 'a@b.com' });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('email');
  });

  it('refuses something that is not an object at all', () => {
    for (const bad of ['daily', 42, ['daily']]) {
      expect(arrangement.validateArrangement(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  it('holds suggestion_appetite to the four words', () => {
    for (const a of arrangement.SUGGESTION_APPETITES) {
      expect(arrangement.validateArrangement({ suggestion_appetite: a })).toMatchObject({ ok: true });
    }
    expect(arrangement.validateArrangement({ suggestion_appetite: 'sometimes' })).toMatchObject({
      ok: false,
    });
  });

  it('wants a list for interrupt_for', () => {
    expect(arrangement.validateArrangement({ interrupt_for: 'a new match' })).toMatchObject({
      ok: false,
    });
  });
});

// ---------------------------------------------------------------------------
describe('validateArrangement: the caps', () => {
  it('holds each short field to its own ceiling', () => {
    const at = 'x'.repeat(arrangement.SHORT_FIELD_MAX);
    const past = 'x'.repeat(arrangement.SHORT_FIELD_MAX + 1);
    for (const field of ['summarize', 'quiet_hours']) {
      expect(arrangement.validateArrangement({ [field]: at }), field).toMatchObject({ ok: true });
      expect(arrangement.validateArrangement({ [field]: past }), field).toMatchObject({ ok: false });
    }
    expect(
      arrangement.validateArrangement({ notes: 'x'.repeat(arrangement.NOTES_MAX) }),
    ).toMatchObject({ ok: true });
    expect(
      arrangement.validateArrangement({ notes: 'x'.repeat(arrangement.NOTES_MAX + 1) }),
    ).toMatchObject({ ok: false });
  });

  it('holds the interrupt list to its length and its item size', () => {
    const many = Array.from({ length: arrangement.INTERRUPT_MAX_ITEMS + 1 }, (_, i) => `thing ${i}`);
    expect(arrangement.validateArrangement({ interrupt_for: many })).toMatchObject({ ok: false });
    expect(
      arrangement.validateArrangement({
        interrupt_for: ['x'.repeat(arrangement.INTERRUPT_ITEM_MAX + 1)],
      }),
    ).toMatchObject({ ok: false });
  });

  it('holds the whole object to 2000 characters', () => {
    expect(arrangement.ARRANGEMENT_TOTAL_MAX).toBe(2000);
    const big = {
      // The total is measured on the stored JSON, so a character that has to
      // be escaped costs two. Quotes are allowed in an arrangement and this is
      // the only way to sit inside every field cap and still be too big.
      notes: '"'.repeat(arrangement.NOTES_MAX),
      interrupt_for: Array.from({ length: arrangement.INTERRUPT_MAX_ITEMS }, () =>
        'z'.repeat(arrangement.INTERRUPT_ITEM_MAX),
      ),
      check_every_minutes: 720,
      summarize: 'b'.repeat(arrangement.SHORT_FIELD_MAX),
      quiet_hours: 'c'.repeat(arrangement.SHORT_FIELD_MAX),
    };
    // Every field is inside its own cap, and the total is what refuses it.
    const r = arrangement.validateArrangement(big);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('2000');
  });
});

// ---------------------------------------------------------------------------
describe('validateArrangement: nothing shaped like a way to reach someone', () => {
  it('turns away emails, phones and web addresses in every field', () => {
    for (const bad of [
      { summarize: 'ping ana@example.com twice a day' },
      { summarize: 'send it to https://example.com/inbox' },
      { quiet_hours: 'call 0412 345 678 outside these' },
      { notes: 'reach me on +61 400 000 000' },
      { notes: 'my page is www.example.com' },
      { notes: 'see example.com for the roster' },
      { interrupt_for: ['text 0412345678'] },
    ]) {
      expect(arrangement.validateArrangement(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  it('lets the times and shapes a real arrangement needs through', () => {
    for (const good of [
      { quiet_hours: '22:00 to 07:00' },
      { quiet_hours: 'after 9pm and before 7am' },
      { check_every_minutes: arrangement.CHECK_EVERY_MINUTES_MIN },
      { check_every_minutes: arrangement.CHECK_EVERY_MINUTES_MAX },
      { summarize: 'Sunday 18:00' },
      { notes: 'I travel a lot; timezone AEST' },
    ]) {
      expect(arrangement.validateArrangement(good), JSON.stringify(good)).toMatchObject({ ok: true });
    }
  });

  it('refuses control characters and angle brackets', () => {
    expect(arrangement.validateArrangement({ notes: 'daily <script>x()</script>' })).toMatchObject({
      ok: false,
    });
  });
});

// ---------------------------------------------------------------------------
describe('storage', () => {
  it('an untouched account reads back empty', async () => {
    expect(await arrangement.readArrangement(ANA)).toEqual({});
  });

  it('saves and reads back the same object', async () => {
    await arrangement.saveArrangement(ANA, FULL, 'counter');
    expect(await arrangement.readArrangement(ANA)).toEqual(FULL);
  });

  it('filters anything already stored that the current rules would refuse', async () => {
    world.stored = { check_cadence: 'daily', mystery_field: 'from an older shape' };
    expect(await arrangement.readArrangement(ANA)).toEqual({});
  });

  it('writes one WORM event naming the fields and none of the words', async () => {
    await arrangement.saveArrangement(ANA, FULL, 'counter');
    expect(vi.mocked(writeConsentEvent)).toHaveBeenCalledTimes(1);
    const event: any = vi.mocked(writeConsentEvent).mock.calls[0][0];
    expect(event).toMatchObject({
      event: 'arrangement-updated',
      account_id: ANA,
      recorded_via: 'counter',
      cleared: false,
    });
    expect(event.fields.sort()).toEqual(
      ['check_every_minutes', 'interrupt_for', 'notes', 'quiet_hours', 'suggestion_appetite', 'summarize'],
    );
    // Not one word of what the arrangement actually says reaches the log.
    const serialised = JSON.stringify(event);
    for (const word of [
      'twice a day',
      'a new match',
      'Sunday',
      'after 9pm',
      'occasional',
      'weekends',
    ]) {
      expect(serialised, word).not.toContain(word);
    }
  });

  it('records a clear as a clear', async () => {
    await arrangement.saveArrangement(ANA, FULL, 'counter');
    vi.mocked(writeConsentEvent).mockClear();
    await arrangement.saveArrangement(ANA, {}, 'counter');
    expect(vi.mocked(writeConsentEvent).mock.calls[0][0]).toMatchObject({
      event: 'arrangement-updated',
      fields: [],
      cleared: true,
    });
    expect(await arrangement.readArrangement(ANA)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
describe('how often to check is a number of minutes, with a floor', () => {
  it('takes a whole number between the floor and a week', () => {
    for (const m of [30, 31, 120, 720, 1440, 10080]) {
      expect(arrangement.validateArrangement({ check_every_minutes: m }), String(m)).toEqual({
        ok: true,
        value: { check_every_minutes: m },
      });
    }
  });

  it('refuses anything oftener than every 30 minutes, and names the floor', () => {
    for (const m of [1, 5, 29]) {
      const r = arrangement.validateArrangement({ check_every_minutes: m });
      expect(r, String(m)).toMatchObject({ ok: false });
      if (!r.ok) expect(r.error).toContain('No more often than every 30 minutes');
    }
  });

  it('refuses a fraction and anything past a week', () => {
    for (const bad of [45.5, 10081, 'often']) {
      expect(
        arrangement.validateArrangement({ check_every_minutes: bad }),
        String(bad),
      ).toMatchObject({ ok: false });
    }
  });

  it('says a number of minutes back the way a person would say it', () => {
    expect(arrangement.cadenceInPlainWords(30)).toBe('every 30 minutes');
    expect(arrangement.cadenceInPlainWords(60)).toBe('every hour');
    expect(arrangement.cadenceInPlainWords(120)).toBe('every 2 hours');
    expect(arrangement.cadenceInPlainWords(90)).toBe('every 90 minutes');
    expect(arrangement.cadenceInPlainWords(1440)).toBe('once a day');
    expect(arrangement.cadenceInPlainWords(2880)).toBe('every 2 days');
    expect(arrangement.cadenceInPlainWords(10080)).toBe('once a week');
  });

  it('the tool description and schema say minutes and say the floor', () => {
    const t = TOOLS.find((x) => x.name === 'standing_arrangement')!;
    const field = t.inputSchema.properties.arrangement.properties.check_every_minutes;
    expect(field.type).toBe('integer');
    expect(field.minimum).toBe(30);
    expect(field.maximum).toBe(10080);
    expect(field.description).toMatch(/minutes/i);
    expect(field.description).toMatch(/30/);
    expect(t.description).toMatch(/30-minute floor/i);
  });

  it('the page offers a minutes box and the same sentence the server refuses with', () => {
    const page = home.arrangementPage({ check_every_minutes: 720 });
    expect(page).toContain('name="check_every_minutes"');
    expect(page).toContain('type="number"');
    expect(page).toContain('min="30"');
    expect(page).toContain('max="10080"');
    expect(page).toContain('No more often than every 30 minutes');
    expect(page).toContain('a few times a day is plenty');
  });

  it('the sweep note tells the agent the cadence its human asked for', () => {
    expect(arrangement.arrangementNote({ check_every_minutes: 720 }).text).toContain(
      'every 12 hours',
    );
    expect(arrangement.arrangementNote({ notes: 'x' }).text).toMatch(/no checking cadence/i);
  });

  it('reads as the human\'s reflected settings, not a command from the system', () => {
    for (const a of [{}, { check_every_minutes: 720 }, { notes: 'x' }]) {
      const t = arrangement.arrangementNote(a).text;
      // No bare imperatives that a defensive agent reads as injection.
      expect(t).not.toMatch(/\bHonour it\b/);
      expect(t).toMatch(/saved preferences|saved any standing preferences|has not saved/i);
    }
  });

  it('the manual says the cadence is minutes with a 30-minute floor', () => {
    expect(SERVER_INSTRUCTIONS).toContain('check_every_minutes');
    expect(SERVER_INSTRUCTIONS).toMatch(/more often than every 30 minutes/i);
  });
});

describe('the standing_arrangement tool', () => {
  const call = (args: any) => dispatchTool(cfg, ANA, 'standing_arrangement', args);
  const body = (r: any) => r.structuredContent;

  it('is on the surface, and its schema survives the grammar-friendly pass', () => {
    const t = TOOLS.find((x) => x.name === 'standing_arrangement')!;
    expect(t).toBeTruthy();
    expect(Object.keys(t.inputSchema.properties)).toEqual(['action', 'arrangement']);
    expect(t.inputSchema.properties.action.enum).toEqual(['get', 'set']);
    // The description says the two things an agent must know before writing.
    expect(t.description).toMatch(/replaces the whole/i);
    expect(t.description).toMatch(/never pre-approves a consent gate/i);
  });

  it('get on a fresh account comes back empty, with the note that says to settle one', async () => {
    const r = body(await call({ action: 'get' }));
    expect(r.arrangement).toEqual({});
    expect(r.note.provenance).toBe('switchboard-system');
    expect(r.note.text).toContain('standing_arrangement');
  });

  it('set then get round-trips the whole object', async () => {
    const set = body(await call({ action: 'set', arrangement: FULL }));
    expect(set.saved).toBe(true);
    expect(set.arrangement).toEqual(FULL);
    expect(body(await call({ action: 'get' })).arrangement).toEqual(FULL);
  });

  it('a second set overwrites rather than merges', async () => {
    await call({ action: 'set', arrangement: FULL });
    await call({ action: 'set', arrangement: { check_every_minutes: 10080 } });
    expect(body(await call({ action: 'get' })).arrangement).toEqual({ check_every_minutes: 10080 });
  });

  it('refuses a bad arrangement without writing anything', async () => {
    const r: any = await call({ action: 'set', arrangement: { notes: 'ring me on 0412 345 678' } });
    expect(r.isError).toBe(true);
    expect(vi.mocked(writeConsentEvent)).not.toHaveBeenCalled();
    expect(await arrangement.readArrangement(ANA)).toEqual({});
  });

  it('a set below the floor is refused, and the refusal names the floor', async () => {
    const r: any = await call({ action: 'set', arrangement: { check_every_minutes: 5 } });
    expect(r.isError).toBe(true);
    const said = JSON.parse(r.content[0].text).message;
    expect(said).toContain('No more often than every 30 minutes');
    expect(vi.mocked(writeConsentEvent)).not.toHaveBeenCalled();
    expect(await arrangement.readArrangement(ANA)).toEqual({});
  });

  it('refuses an action it does not have', async () => {
    const r: any = await call({ action: 'delete' });
    expect(r.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('every check_in sweep carries it', () => {
  it('hands back the current arrangement alongside the introductions', async () => {
    await arrangement.saveArrangement(ANA, FULL, 'counter');
    const r: any = await dispatchTool(cfg, ANA, 'check_in', {});
    expect(r.structuredContent.introductions).toEqual([]);
    expect(r.structuredContent.arrangement).toEqual(FULL);
    expect(r.structuredContent.arrangement_note.provenance).toBe('switchboard-system');
  });

  it('says so when there is none yet, so a fresh agent knows to ask', async () => {
    const r: any = await dispatchTool(cfg, ANA, 'check_in', {});
    expect(r.structuredContent.arrangement).toEqual({});
    expect(r.structuredContent.arrangement_note.text).toMatch(/has not saved any standing preferences|no standing preferences/i);
  });

  it('a second agent on a fresh connection reads back what the first one saved', async () => {
    await dispatchTool(cfg, ANA, 'standing_arrangement', { action: 'set', arrangement: FULL });
    // A different call with nothing in common but the account id.
    const r: any = await dispatchTool(cfg, ANA, 'check_in', {});
    expect(r.structuredContent.arrangement).toEqual(FULL);
  });
});

// ---------------------------------------------------------------------------
describe('the page the human reads it on', () => {
  it('says it back in plain words', () => {
    const page = home.arrangementPage(FULL, { updated: '2026-09-02 04:00 UTC' });
    expect(page).toContain('How your agents behave');
    expect(page).toContain('every 12 hours');
    expect(page).toContain('a new match');
    expect(page).toContain('Mention something now and then');
    expect(page).toContain('Last changed 2026-09-02 04:00 UTC');
  });

  it('says when nothing is set, and offers no clear control then', () => {
    const empty = home.arrangementPage({});
    expect(empty).toContain('Nothing is set yet');
    expect(empty).not.toContain('/arrangement/clear');
    expect(home.arrangementPage(FULL)).toContain('/arrangement/clear');
  });

  it('carries every setting into the edit form, one interruption per line', () => {
    const page = home.arrangementPage(FULL);
    for (const name of [
      'check_every_minutes',
      'interrupt_for',
      'summarize',
      'quiet_hours',
      'suggestion_appetite',
      'notes',
    ]) {
      expect(page, name).toContain(`name="${name}"`);
    }
    expect(page).toContain('a new match\na message on a match we are talking on');
    expect(page).toContain('value="occasional" selected');
  });

  it('restates the floor: an arrangement approves nothing', () => {
    const page = home.arrangementPage(FULL);
    expect(page).toMatch(/never approve|can never do is approve/i);
    expect(page).toContain('every single time');
  });

  it('escapes what the human typed back into the boxes', () => {
    const nasty = home.arrangementPage({ notes: '"><script>x()</script>' });
    expect(nasty).not.toContain('<script>x()');
    expect(nasty).toContain('&lt;script&gt;');
  });

  it('the dashboard links to it and says when it is empty', () => {
    const base = {
      killSwitchOn: false,
      cardCounts: { total: 0, published: 0, pending: 0 },
      pendingApprovals: [],
      matches: [],
      collectionWindows: [],
    };
    const empty = home.dashboardPage(base);
    expect(empty).toContain('/arrangement');
    expect(empty).toContain('Nothing is set yet');
    const filled = home.dashboardPage({
      ...base,
      arrangementSummary: 'how often your agents check — twice a day (and 5 more)',
    });
    expect(filled).toContain('twice a day (and 5 more)');
  });

  it('passes the banned-phrase lint and never says "the counter"', () => {
    for (const [name, htmlBody] of [
      ['arrangement-empty', home.arrangementPage({})],
      ['arrangement-filled', home.arrangementPage(FULL, { updated: '2026-09-02 04:00 UTC' })],
      ['arrangement-notice', home.arrangementPage(FULL, { notice: 'Saved.' })],
      ['arrangement-error', home.arrangementPage({}, { error: 'Quiet hours runs past 120 characters. A short line is enough.' })],
    ] as const) {
      expect(lintEmailCopy(htmlBody), name).toEqual([]);
      expect(htmlBody.toLowerCase(), name).not.toContain('the counter');
      expect(htmlBody.toLowerCase(), name).not.toContain('your counter');
    }
  });
});

// ---------------------------------------------------------------------------
describe('the manual section for agents that can act unattended', () => {
  const section = SERVER_INSTRUCTIONS.slice(
    SERVER_INSTRUCTIONS.indexOf('WHEN YOU CAN ACT ON YOUR OWN'),
    SERVER_INSTRUCTIONS.indexOf('WORKING THE BOARD'),
  );

  it('sits after the patch-through section and before working the board', () => {
    expect(SERVER_INSTRUCTIONS.indexOf('PATCHED THROUGH')).toBeLessThan(
      SERVER_INSTRUCTIONS.indexOf('WHEN YOU CAN ACT ON YOUR OWN'),
    );
    expect(section.length).toBeGreaterThan(800);
  });

  it('addresses the agent by what it can do, naming no product', () => {
    expect(section).toContain('act on a schedule');
    expect(section).toContain('wake yourself');
    expect(section).toContain('reach your human outside this conversation');
  });

  it('says to settle the arrangement with the human and then save it', () => {
    expect(section).toContain('standing_arrangement');
    expect(section).toContain('check_in hands it back on every sweep');
    expect(section).toMatch(/restart/);
    expect(section).toMatch(/change of model/);
  });

  it('names what interrupts and what waits', () => {
    expect(section).toContain('someone newly come forward');
    expect(section).toContain('patched through');
    expect(section).toContain('approval page');
  });

  it('gives the chat-only agent the exact words about email', () => {
    expect(section).toContain('"when I\'m not being asked to check"');
  });

  it('gives the out-of-band agent the offer to make', () => {
    expect(section).toContain('out-of-band');
    expect(section).toMatch(/backup/);
  });

  it('makes a recorded "back off" permanent', () => {
    expect(section).toContain('"Back off" is a setting');
    expect(section).toMatch(/honoured from then on/);
  });

  it('restates the floor in one line', () => {
    expect(section).toContain('No arrangement pre-approves anything');
    expect(section).toContain('every single time');
  });

  it('asks for polite polling and says what makes it real', () => {
    expect(section).toMatch(/check less often/);
    expect(section).toMatch(/Quotas/);
  });

  it('keeps the whole manual clean of the banned constructions', () => {
    expect(lintEmailCopy(SERVER_INSTRUCTIONS)).toEqual([]);
  });
});
