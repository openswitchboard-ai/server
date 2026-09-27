/**
 * THE LEAN SWEEP says the same things with fewer copies (domain/leanSweep.ts).
 *
 * A small local model took three minutes to read one sweep on 27 September
 * 2026. The fix is allowed to take out repeats and nothing else, so what is
 * held here is that promise: every sentence arrives byte for byte as it did,
 * every field agent-facing text names is still there with its sentence, the
 * compact form of a quiet, finished introduction still carries what to do and
 * what to say, and with the flag off nothing about the answer changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cryptoMock, fakeSweepPool, fixtureCfg, representativeWorld, ANA, M } from './sweepFixture.js';

vi.mock('../../src/crypto.js', (orig) => cryptoMock(orig as any));

import * as db from '../../src/db.js';
import { leanSweepFrom } from '../../src/config.js';
import { compactCandidate, leanEntry } from '../../src/domain/leanSweep.js';
import { POSSIBLE_NOTE_SENTENCE } from '../../src/domain/matches.js';
import { TOOLS, dispatchTool } from '../../src/mcp/tools.js';

let world = representativeWorld();

beforeEach(() => {
  world = representativeWorld();
  vi.spyOn(db, 'getPool').mockReturnValue(fakeSweepPool(world));
});

async function sweep(lean: boolean | undefined, args: Record<string, unknown> = {}): Promise<any> {
  vi.useFakeTimers({ now: world.now, toFake: ['Date'] });
  try {
    const cfg = lean === undefined ? fixtureCfg : ({ ...fixtureCfg, leanSweep: lean } as any);
    return await dispatchTool(cfg, ANA, 'check_in', args);
  } finally {
    vi.useRealTimers();
  }
}

/** Every `text` anywhere under a value, in order. */
function texts(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) texts(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'text' && typeof x === 'string') out.push(x);
      else texts(x, out);
    }
  } else if (typeof v === 'string' && v.length > 60) out.push(v); // what_to_do is a bare string
  return out;
}

/** The field names the check_in description and the manual tell an agent to read. */
const NAMED_FIELDS = [
  'note',
  'offer_note',
  'taken_down',
  'taken_down_note',
  'possible_note',
  'offers',
  'offer_message',
  'line',
  'next',
  'mutual',
  'conversation',
  'what_to_do',
];
const NAMED_ACCOUNT_FIELDS = [
  'hears_via',
  'hears_via_note',
  'runs_on_its_own',
  'runs_on_its_own_note',
  'timezone',
  'time_note',
  'area',
  'area_resolved',
  'area_note',
  'arrangement',
  'arrangement_note',
];

describe('the flag', () => {
  it('is on in dev and off in prod unless LEAN_SWEEP says otherwise', () => {
    expect(leanSweepFrom(undefined, 'dev')).toBe(true);
    expect(leanSweepFrom('', 'dev')).toBe(true);
    expect(leanSweepFrom(undefined, 'prod')).toBe(false);
    expect(leanSweepFrom('on', 'prod')).toBe(true);
    expect(leanSweepFrom('off', 'dev')).toBe(false);
    expect(() => leanSweepFrom('maybe', 'dev')).toThrow(/LEAN_SWEEP/);
  });

  it('off, the answer is exactly what it was: same fields, same envelopes, pretty text', async () => {
    const unset = await sweep(undefined);
    const off = await sweep(false);
    expect(off.structuredContent).toEqual(unset.structuredContent);
    expect(off.content[0].text).toBe(unset.content[0].text);
    expect(off.content[0].text).toBe(JSON.stringify(off.structuredContent, null, 2));
    const e = off.structuredContent.introductions.find((x: any) => x.intro_id === M(4));
    expect(e.signal.kind).toBe('intro.signal');
    expect(e.attributes.schema_version).toBeDefined();
    expect(off.structuredContent.schema_version).toBeUndefined();
  });

  it('off, intro_id without a step is ignored as it always was', async () => {
    const off = await sweep(false, { intro_id: M(4) });
    expect(off.structuredContent.introductions).toHaveLength(8);
  });
});

describe('lean: nothing said differently, nothing named taken away', () => {
  it('every sentence is byte-identical, and only a compact entry loses the details’ own', async () => {
    const full = (await sweep(false)).structuredContent;
    const lean = (await sweep(true)).structuredContent;
    expect(lean.introductions.map((e: any) => e.intro_id)).toEqual(
      full.introductions.map((e: any) => e.intro_id),
    );
    full.introductions.forEach((f: any, i: number) => {
      const l = lean.introductions[i];
      const fullTexts = new Set(texts(f));
      const leanTexts = new Set(texts(l));
      // Nothing new, nothing reworded.
      for (const t of leanTexts) expect(fullTexts.has(t), `${f.intro_id}: ${t}`).toBe(true);
      // Nothing lost, except what lived only in the details of a compact one.
      const onlyInDetails = new Set(texts(f.attributes));
      for (const t of fullTexts) {
        if (!leanTexts.has(t)) {
          expect(l.attributes, `${f.intro_id} lost "${t}"`).toBeUndefined();
          expect(onlyInDetails.has(t), `${f.intro_id} lost "${t}"`).toBe(true);
        }
      }
    });
    // The account-level sentences are the same objects.
    for (const k of NAMED_ACCOUNT_FIELDS) expect(lean[k], k).toEqual(full[k]);
  });

  it('every field agent-facing text names is still on the entry that had it', async () => {
    const desc = TOOLS.find((t) => t.name === 'check_in')!.description;
    // The fields the description itself names are in the list checked here.
    for (const f of ['note', 'offer_note', 'taken_down_note', 'offers', 'possible_note', 'line']) {
      expect(desc).toContain(f);
      expect(NAMED_FIELDS).toContain(f);
    }
    const full = (await sweep(false)).structuredContent;
    const lean = (await sweep(true)).structuredContent;
    full.introductions.forEach((f: any, i: number) => {
      const l = lean.introductions[i];
      for (const k of NAMED_FIELDS) {
        if (f[k] === undefined) continue;
        if (k === 'mutual') {
          // The names block loses only the envelope the entry already carries.
          const { schema_version: _v, kind: _k, intro_id: _i, ...rest } = f[k];
          expect(l[k], `${f.intro_id} ${k}`).toEqual(rest);
        } else expect(l[k], `${f.intro_id} ${k}`).toEqual(f[k]);
      }
      // And every other field, bar the two a compact entry leaves for check_in({intro_id}).
      for (const k of Object.keys(f)) {
        if (k === 'signal' || k === 'attributes') continue;
        expect(l[k], `${f.intro_id} ${k}`).toBeDefined();
      }
    });
    for (const k of NAMED_ACCOUNT_FIELDS) {
      if (full[k] !== undefined) expect(lean[k], k).toBeDefined();
    }
  });

  it('drops the repeated envelope and keeps one schema_version for the answer', async () => {
    const lean = (await sweep(true)).structuredContent;
    expect(typeof lean.schema_version).toBe('string');
    for (const e of lean.introductions) {
      for (const k of ['signal', 'attributes', 'mutual']) {
        if (!e[k]) continue;
        expect(e[k].schema_version, `${e.intro_id} ${k}`).toBeUndefined();
        expect(e[k].kind, `${e.intro_id} ${k}`).toBeUndefined();
        expect(e[k].intro_id, `${e.intro_id} ${k}`).toBeUndefined();
      }
    }
    const fresh = lean.introductions.find((e: any) => e.intro_id === M(1));
    expect(fresh.signal).toEqual({ category: 'goods.bicycle.parts', counterparty_type: 'offering' });
    const talking = lean.introductions.find((e: any) => e.intro_id === M(2));
    expect(talking.mutual.counterparty).toEqual({ first_name: 'Beppe', locality: 'Trastevere' });
  });

  it('says a maybe once, on possible_note, and keeps the other notes in the details', async () => {
    const full = (await sweep(false)).structuredContent.introductions[0];
    const lean = (await sweep(true)).structuredContent.introductions[0];
    expect(full.attributes.notes.map((n: any) => n.text)).toContain(POSSIBLE_NOTE_SENTENCE);
    expect(lean.possible_note).toEqual(full.possible_note);
    expect(lean.possible_note.text).toBe(POSSIBLE_NOTE_SENTENCE);
    expect(lean.attributes.notes.map((n: any) => n.text)).not.toContain(POSSIBLE_NOTE_SENTENCE);
    expect(lean.attributes.notes).toEqual(
      full.attributes.notes.filter((n: any) => n.text !== POSSIBLE_NOTE_SENTENCE),
    );
    // The other side's own words keep their own label.
    expect(lean.attributes.notes).toContainEqual({ text: 'road bike wheels', provenance: 'counterparty-untrusted' });
  });

  it('keeps the other side’s words with a figure on offer_message and the table, and the figure on offer', async () => {
    const lean = (await sweep(true)).structuredContent.introductions[1];
    expect(lean.offer).toEqual({ amount: 180, ccy: 'AUD' });
    expect(lean.offer_message).toEqual({ text: 'Can do Saturday morning if that suits.', provenance: 'counterparty-untrusted' });
    expect(lean.offers[0].message).toEqual(lean.offer_message);
    expect(lean.offer_message_note).toBeDefined();
  });

  it('hands the text over unindented, the same object as the structured answer', async () => {
    const r = await sweep(true);
    expect(r.content[0].text).toBe(JSON.stringify(r.structuredContent));
    expect(r.content[0].text).not.toContain('\n  ');
  });
});

describe('lean: a quiet, finished introduction comes back compact', () => {
  it('carries intro_id, state, next, note and the taken-down sentence, without the details', async () => {
    const lean = (await sweep(true)).structuredContent.introductions;
    const quiet = lean.find((e: any) => e.intro_id === M(4));
    expect(quiet.state).toBe('open');
    expect(quiet.next).toBe('ready_to_talk');
    expect(quiet.note.text).toMatch(/taken down/);
    expect(quiet.taken_down).toBe('theirs');
    expect(quiet.taken_down_note.text).toMatch(/taken down/);
    expect(quiet.conversation.conversation_id).toBe('ch_4');
    expect(quiet.mutual.counterparty.first_name).toBe('Beppe');
    expect(quiet.signal).toBeUndefined();
    expect(quiet.attributes).toBeUndefined();

    // An agreed deal keeps its figure, its sentence and what comes after.
    const agreed = lean.find((e: any) => e.intro_id === M(3));
    expect(agreed.next).toBe('deal_agreed');
    expect(agreed.note.text).toContain('415 AUD');
    expect(agreed.offer_note).toEqual(agreed.note);
    expect(agreed.offers).toHaveLength(1);
    expect(agreed.what_to_do).toMatch(/respond\(verdict\)/);
    expect(agreed.attributes).toBeUndefined();
  });

  it('is never used for one that moved inside the quiet window', async () => {
    const lean = (await sweep(true)).structuredContent.introductions;
    const recent = lean.find((e: any) => e.intro_id === M(5));
    expect(recent.taken_down).toBe('theirs');
    expect(recent.attributes).toBeDefined();
    expect(recent.signal).toBeDefined();
  });

  it('is never used for anything that could need this human', () => {
    const quiet = {
      intro_id: 'x',
      state: 'open',
      next: 'ready_to_talk',
      taken_down: 'theirs',
      conversation: { conversation_id: 'c', messages_waiting: 0 },
    };
    expect(compactCandidate(quiet)).toBe(true);
    expect(compactCandidate({ ...quiet, taken_down: 'yours' })).toBe(false);
    expect(compactCandidate({ ...quiet, taken_down: undefined })).toBe(false);
    expect(compactCandidate({ ...quiet, conversation: { conversation_id: 'c', messages_waiting: 1 } })).toBe(false);
    expect(compactCandidate({ ...quiet, next: 'awaiting_your_human' })).toBe(false);
    expect(compactCandidate({ ...quiet, offer: { amount: 1, ccy: 'AUD' } })).toBe(false);
    expect(compactCandidate({ ...quiet, offers: [{ state: 'proposed' }] })).toBe(false);
    expect(compactCandidate({ ...quiet, offers: [{ state: 'awaiting-human' }] })).toBe(false);
    expect(compactCandidate({ ...quiet, offers: [{ state: 'accepted-by-human' }] })).toBe(true);
    expect(compactCandidate({ ...quiet, settlement: {} })).toBe(false);
    expect(compactCandidate({ ...quiet, mutual_blocked: {} })).toBe(false);
    expect(compactCandidate({ ...quiet, line: { in_line: 1 } })).toBe(false);
    expect(compactCandidate({ ...quiet, state: 'archived' })).toBe(false);
  });

  it('check_in with that intro_id brings it back in full', async () => {
    const one = (await sweep(true, { intro_id: M(4) })).structuredContent;
    expect(one.introductions).toHaveLength(1);
    const e = one.introductions[0];
    expect(e.intro_id).toBe(M(4));
    expect(e.attributes.attributes).toEqual({ size: '100 x 120 cm', condition: 'used', fold: 'taco' });
    expect(e.signal.category).toBe('goods.sports.climbing');
    // The rest of the answer rides as it always does.
    expect(one.hears_via_note).toBeDefined();
  });
});

describe('leanEntry leaves alone what is not its own', () => {
  it('keeps a nested block that names a different introduction', () => {
    const e = { intro_id: 'a', signal: { schema_version: '1', kind: 'intro.signal', intro_id: 'b', category: 'c' } };
    expect(leanEntry(e).signal).toEqual(e.signal);
  });
  it('keeps offer.message when it is not the same as offer_message', () => {
    const e = {
      intro_id: 'a',
      offer: { amount: 1, ccy: 'AUD', message: { text: 'x', provenance: 'counterparty-untrusted' } },
      offer_message: { text: 'y', provenance: 'counterparty-untrusted' },
    };
    expect(leanEntry(e).offer.message).toEqual(e.offer.message);
  });
});
