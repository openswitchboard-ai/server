/**
 * Which refusals are failures, and which are answers (Lachlan, 2026-09-13).
 *
 * The defect this suite holds shut was seen twice in one day, live. A human
 * asked their assistant to post something; the switchboard said "your human
 * has to press this first", which is the switchboard working exactly as it
 * should; and because that sentence came back as a tool failure, one client
 * printed a bare failure line with no sentence under it, and another read the
 * words of a schema complaint out loud. In both, the person at the keyboard
 * had done nothing wrong, and the sentence written for them never reached
 * them.
 *
 * So: a refusal that is the switchboard working comes back the way every other
 * answer does, carrying the word for what happened, the sentence to say and
 * the link to hand over. A call an author has to fix still fails.
 *
 * The rules asserted here:
 *  - every expected refusal answers with isError false, its plain word, its
 *    sentence, and its link where the sentence carries one;
 *  - `code` still travels, so anything branching on it keeps working;
 *  - what the agent's author must fix still fails: a call that cannot be read,
 *    an unknown tool, a version this switchboard cannot speak;
 *  - the sorting covers every code the switchboard can raise, so a new one is
 *    a deliberate choice rather than a silent failure;
 *  - what comes back when a post will not go up is said in words: what is
 *    missing, what is the wrong shape, what is not taken.
 */
import { describe, expect, it, vi } from 'vitest';
import * as db from '../../src/db.js';
import {
  ErrorCode,
  OsbError,
  plainReason,
  validateOutbound,
  validatePayload,
} from '../../src/protocol.js';
import { EXPECTED_REFUSALS, dispatchTool, protocolAnswer } from '../../src/mcp/tools.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = { envName: 'dev', publicOrigin: 'https://mcp.test' } as unknown as Config;
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const answerFor = (code: ErrorCode, opts: Record<string, unknown> = {}) =>
  protocolAnswer(new OsbError(code, { human_action: 'Your human presses this.', ...opts }).payload);

// ---------------------------------------------------------------------------
describe('the refusals that are the switchboard working', () => {
  const EXPECTED = Object.keys(EXPECTED_REFUSALS) as ErrorCode[];

  it('sorts the ones a human did nothing wrong to earn', () => {
    expect(EXPECTED.sort()).toEqual(
      [
        'CATEGORY_PROHIBITED',
        'CONSENT_REQUIRED',
        'INTENT_EXPIRED',
        'LOCATION_AMBIGUOUS',
        'LOCATION_UNRESOLVED',
        'NOT_UNLOCKED_YET',
        'QUOTA_EXCEEDED',
        'RATE_LIMITED',
        'RATE_LIMITED_OFFERS',
        'SETTLEMENT_UNAVAILABLE',
        // An account the operator has stopped. The agent did nothing wrong,
        // its human is owed a sentence, and there is nothing to retry — which
        // is exactly why it must not arrive as a bare failure line.
        'SUSPENDED',
      ].sort(),
    );
  });

  it('answers each of them ordinarily, with the word, the sentence and the code', () => {
    for (const code of EXPECTED) {
      const r: any = answerFor(code);
      expect(r.isError, code).toBe(false);
      expect(r.structuredContent.what_happened, code).toBe(EXPECTED_REFUSALS[code]);
      expect(r.structuredContent.human_action, code).toBe('Your human presses this.');
      // The envelope changed; what it carries did not.
      expect(r.structuredContent.code, code).toBe(code);
      expect(r.structuredContent.docs_url, code).toContain(code);
      expect(JSON.parse(r.content[0].text).code, code).toBe(code);
    }
  });

  it('hands the link over beside the sentence it sits in', () => {
    const r: any = protocolAnswer(
      new OsbError('CONSENT_REQUIRED', {
        human_action: 'Hand them this link: https://my.test/a/abc123.',
        press_id: '11111111-1111-4111-8111-111111111111',
      }).payload,
    );
    expect(r.isError).toBe(false);
    expect(r.structuredContent.link).toBe('https://my.test/a/abc123');
    expect(r.structuredContent.press_id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('adds nothing where there is no link to add', () => {
    const r: any = answerFor('NOT_UNLOCKED_YET');
    expect(r.structuredContent.link).toBeUndefined();
  });

  it('keeps the payload inside it conformant, once the envelope is set aside', () => {
    const { what_happened, link, ...payload }: any = answerFor('QUOTA_EXCEEDED', {
      retry_after: 60,
    }).structuredContent;
    expect(what_happened).toBe('limit_reached');
    expect(link).toBeUndefined();
    expect(validateOutbound('error', payload).valid).toBe(true);
  });

  it('says every one of the words in plain speech', () => {
    for (const [code, word] of Object.entries(EXPECTED_REFUSALS)) {
      expect(word, code).toMatch(/^[a-z_]+$/);
      expect(lintHumanCopy(word!.replaceAll('_', ' ')), code).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the refusals an author has to fix', () => {
  it('keeps a version this switchboard cannot speak a failure', () => {
    const r: any = protocolAnswer(
      new OsbError('SCHEMA_VERSION_UNSUPPORTED', { human_action: 'Upgrade.' }).payload,
    );
    expect(r.isError).toBe(true);
    expect(r.structuredContent.code).toBe('SCHEMA_VERSION_UNSUPPORTED');
  });

  it('sorts every code the switchboard can raise into one pile or the other', () => {
    // The sorting is the point of the change, so an unsorted code is a defect
    // rather than a default. SCREENING_REJECTED is a state a post sits in and
    // is never raised here, so it is neither.
    const ALL: ErrorCode[] = [
      'CONSENT_REQUIRED',
      'SCHEMA_VERSION_UNSUPPORTED',
      'QUOTA_EXCEEDED',
      'CATEGORY_PROHIBITED',
      'NOT_UNLOCKED_YET',
      'INTENT_EXPIRED',
      'SCREENING_REJECTED',
      'RATE_LIMITED',
      'RATE_LIMITED_OFFERS',
      'SETTLEMENT_UNAVAILABLE',
      'LOCATION_UNRESOLVED',
      'LOCATION_AMBIGUOUS',
    ];
    for (const code of ALL) {
      const answered = code in EXPECTED_REFUSALS;
      const failure = ['SCHEMA_VERSION_UNSUPPORTED', 'SCREENING_REJECTED'].includes(code);
      expect(answered, code).toBe(!failure);
    }
  });

  it('fails a call that cannot be read, and says what is wrong', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async () => ({ rows: [], rowCount: 0 }),
    } as any);
    for (const [name, args, want] of [
      ['wait_for_press', {}, 'press_id'],
      ['no_such_tool', {}, 'no_such_tool'],
      ['respond', { intro_id: 'x', action: 'no_such_action' }, 'no_such_action'],
    ] as const) {
      const r: any = await dispatchTool(cfg, ANA, name, args as Record<string, unknown>);
      expect(r.isError, name).toBe(true);
      expect(r.structuredContent.what_happened, name).toBe('the call could not be read');
      expect(String(r.structuredContent.message), name).toContain(want);
    }
  });
});

// ---------------------------------------------------------------------------
describe('what comes back when a post will not go up', () => {
  const listing = (over: Record<string, unknown>) => ({
    schema_version: '0.12.0',
    type: 'looking_for',
    category: 'goods.bicycle.mountain',
    geo: { place: 'Canberra', reach: 'radius', radius_km: 30 },
    ...over,
  });
  const said = (card: unknown): string => validatePayload('intent-card', card).plain.join('; ');

  it('names what is missing', () => {
    const { category, ...missing } = listing({});
    expect(said(missing)).toContain('category is needed, and nothing was sent for it');
  });

  it('names a slot filled with the wrong sort of thing', () => {
    expect(said(listing({ slots: 'three' }))).toContain('slots has to be a whole number');
  });

  it('names one it does not take at all', () => {
    expect(said(listing({ colour: 'red' }))).toContain('colour is not something this takes');
  });

  it('names a nested one by where it sits', () => {
    const bad = listing({ geo: { reach: 'radius' } });
    expect(said(bad)).toContain('geo.place is needed, and nothing was sent for it');
  });

  it('says a choice as the choices', () => {
    expect(said(listing({ type: 'WANT' }))).toContain('type has to be one of:');
  });

  it('keeps the validator’s own account for the log, and says it plainly to the agent', () => {
    const r = validatePayload('intent-card', listing({ colour: 'red' }));
    expect(r.reasons.join(' ')).toContain('additionalProperties');
    expect(r.plain.join(' ')).not.toContain('additionalProperties');
  });

  it('would not embarrass anybody if a client read it out', () => {
    for (const card of [
      listing({ colour: 'red' }),
      listing({ slots: 'three' }),
      listing({ geo: { reach: 'radius' } }),
    ]) {
      for (const sentence of validatePayload('intent-card', card).plain) {
        expect(lintHumanCopy(sentence), sentence).toEqual([]);
        expect(sentence, sentence).not.toMatch(/must NOT|keyword|instancePath|\{/);
      }
    }
  });

  it('falls back to something readable for a rule with no words of its own', () => {
    expect(plainReason({ instancePath: '/ask', keyword: 'weird', message: 'must be sensible' })).toBe(
      'ask has to be sensible',
    );
  });
});
