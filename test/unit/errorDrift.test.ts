/**
 * Every refusal this server can raise, checked against the published error
 * document (schema 0.17.0 and later).
 *
 * In prod a payload that drifts from the document is logged under
 * 'schema-drift' and sent anyway (protocol.ts, strictErrorChecks), so drift
 * has to be caught here instead. Each code below is built the way the server
 * builds it: its real sentence where the sentence is a shared constant, and
 * every extra field it carries. A scan of src/ makes sure a code the server
 * starts raising cannot go unchecked.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OsbError, strictErrorChecks, validatePayload } from '../../src/protocol.js';
import { PLACE_NOT_FULL } from '../../src/geo/normalise.js';
import { SUSPENDED_WORDS } from '../../src/intake/checks/suspended.js';
import { CONVERSATION_PAUSED_WORDS } from '../../src/domain/conversationWindow.js';
import * as detail from '../../src/domain/postingDetail.js';
import { FIGURE_HUMAN_ACTION, figureQuestions } from '../../src/domain/postingFigure.js';
import * as cards from '../../src/domain/cards.js';
import { SHELF_PICK_ACTION } from '../../src/domain/shelfPick.js';
import { FIGURE_IN_WORDS_ACTION, FIGURE_IN_OFFER_NOTE_ACTION } from '../../src/domain/moneyInWords.js';
import { NAMES_GATE_ACTION, SHARED_PROFILE_ACTION, COUNTERPARTY_PROFILE_ACTION } from '../../src/domain/profile.js';
import { RELAY_ACTION, NO_MANDATE_ACTION } from '../../src/domain/negotiation.js';
import { OFFER_EXPIRED_WORDS } from '../../src/domain/offers.js';
import { REPORT_CEILING_WORDS } from '../../src/safety/reports.js';

const REF = '7f0c2a4e-1b9d-4c55-9a8e-3d2f6b1c0e91';
// As long as a real link: origin, /a/, a uuid, a dot and a 43-character MAC.
const LINK = `https://my.dev.openswitchboard.ai/a/${REF}.${'x'.repeat(43)}`;

/** One or more builds per code, each the way the server builds it. */
const BUILDS: Record<string, () => OsbError[]> = {
  CONSENT_REQUIRED: () => [
    new OsbError('CONSENT_REQUIRED', { human_action: `${NAMES_GATE_ACTION} ${LINK}`, press_id: REF }),
    new OsbError('CONSENT_REQUIRED', { human_action: SHARED_PROFILE_ACTION }),
    new OsbError('CONSENT_REQUIRED', { human_action: COUNTERPARTY_PROFILE_ACTION }),
    new OsbError('CONSENT_REQUIRED', { human_action: FIGURE_IN_WORDS_ACTION }),
    new OsbError('CONSENT_REQUIRED', { human_action: FIGURE_IN_OFFER_NOTE_ACTION }),
    new OsbError('CONSENT_REQUIRED', { human_action: RELAY_ACTION, press_id: REF }),
    new OsbError('CONSENT_REQUIRED', { human_action: NO_MANDATE_ACTION }),
  ],
  SCHEMA_VERSION_UNSUPPORTED: () => [
    new OsbError('SCHEMA_VERSION_UNSUPPORTED', { human_action: 'Upgrade your agent to @openswitchboard/schema 0.17.0.' }),
  ],
  QUOTA_EXCEEDED: () => [
    new OsbError('QUOTA_EXCEEDED', {
      retry_after: 3600,
      human_action: "That is the day's posting done. Try again in about an hour — nothing your human needs to do, and no clock time to pass on.",
    }),
    new OsbError('QUOTA_EXCEEDED', { retry_after: 3600, human_action: REPORT_CEILING_WORDS }),
  ],
  CATEGORY_PROHIBITED: () => [
    new OsbError('CATEGORY_PROHIBITED', {
      human_action: "That category is reserved and can't be posted yet.",
      suggestions: ['goods.electronics.laptop', 'goods.electronics.tablet', 'goods.electronics.desktop', 'goods.electronics.monitor'],
    }),
  ],
  NOT_UNLOCKED_YET: () => [
    new OsbError('NOT_UNLOCKED_YET', { human_action: OFFER_EXPIRED_WORDS }),
    new OsbError('NOT_UNLOCKED_YET', { human_action: 'Their go-ahead has not come yet.' }),
  ],
  INTENT_EXPIRED: () => [new OsbError('INTENT_EXPIRED', { human_action: 'That want or have has run out.' })],
  SCREENING_REJECTED: () => [new OsbError('SCREENING_REJECTED')],
  RATE_LIMITED: () => [
    new OsbError('RATE_LIMITED', {
      retry_after: 1200,
      human_action: 'That is a great deal of activity on this account in one hour, so the switchboard is pacing it. Come back in about twenty minutes — nothing your human needs to do.',
    }),
  ],
  RATE_LIMITED_OFFERS: () => [
    new OsbError('RATE_LIMITED_OFFERS', {
      retry_after: 3600,
      human_action: 'Offers are paced. Send the next one in about an hour — nothing your human needs to do.',
    }),
  ],
  SETTLEMENT_UNAVAILABLE: () => [
    new OsbError('SETTLEMENT_UNAVAILABLE', { human_action: 'Paying through the switchboard is not on here yet.' }),
  ],
  LOCATION_UNRESOLVED: () => [
    new OsbError('LOCATION_UNRESOLVED', {
      human_action: `The switchboard does not know '${'x'.repeat(79)}…'. Check the town, state and country, or name the nearest town, written the same way.`,
    }),
  ],
  LOCATION_AMBIGUOUS: () => [
    new OsbError('LOCATION_AMBIGUOUS', {
      human_action: "'Richmond, Victoria, Australia' names more than one place. Ask your human which, then post it exactly as written here: Richmond, Victoria, Australia.",
      candidates: [
        { display: 'Richmond, Victoria, Australia', place: 'Richmond, Victoria, Australia' },
        { display: 'Richmond (suburb), Victoria, Australia', place: 'Richmond (suburb), Victoria, Australia' },
      ],
    }),
  ],
  LOCATION_NOT_FULL: () => [new OsbError('LOCATION_NOT_FULL', { human_action: PLACE_NOT_FULL })],
  SUSPENDED: () => [new OsbError('SUSPENDED', { human_action: SUSPENDED_WORDS })],
  CONVERSATION_PAUSED: () => [new OsbError('CONVERSATION_PAUSED', { human_action: CONVERSATION_PAUSED_WORDS })],
  NEEDS_DETAIL: () =>
    [
      detail.DETAIL_HUMAN_ACTION,
      detail.DETAIL_AND_RADIUS_HUMAN_ACTION,
      detail.DETAIL_CONTEXT_HUMAN_ACTION,
      detail.DETAIL_RECOGNISE_HUMAN_ACTION,
      detail.DETAIL_UNKNOWN_UNMATCHED,
    ].map(
      (human_action) =>
        new OsbError('NEEDS_DETAIL', {
          human_action,
          questions: ['What make and model is it?', 'What condition is it in?', 'What comes with it?', 'Would you post it to someone, or is it pick-up only?', 'One too many?'],
          reference: REF,
        }),
    ),
  CONFIRM_FIGURE: () => [
    new OsbError('CONFIRM_FIGURE', {
      human_action: `${FIGURE_HUMAN_ACTION}${cards.FIGURE_RADIUS_TAIL}`,
      questions: figureQuestions([
        { what: 'asking price', amount: 99_999_999_999, currency: 'AUD' },
        { what: 'the least they will take', amount: 380, currency: 'AUD' },
      ]),
      figures: [
        { what: 'asking price', amount: 99_999_999_999, currency: 'AUD' },
        { what: 'the least they will take', amount: 380, currency: 'AUD' },
      ],
      reference: REF,
    }),
  ],
  SHELF_UNCLEAR: () => [
    new OsbError('SHELF_UNCLEAR', {
      human_action: cards.shelfUnclearAction(),
      candidates: [
        { category: 'goods.motoring.parts', words: 'car parts' },
        { category: 'goods.electronics.console', words: 'game consoles and accessories' },
        { category: 'goods.sports.cycling', words: 'cycling gear' },
        { category: 'goods.tools.power', words: 'power tools' },
        { category: 'none_of_these', words: 'none of these' },
      ],
    }),
  ],
  SHELF_PICK: () => [new OsbError('SHELF_PICK', { human_action: `${SHELF_PICK_ACTION} ${LINK}`, press_id: REF })],
  FLOOR_IS_PRIVATE: () => [new OsbError('FLOOR_IS_PRIVATE', { human_action: cards.FLOOR_IS_PRIVATE_ACTION })],
};

/** Every code the server's own source raises. */
function codesRaisedInSrc(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) {
        for (const m of readFileSync(path, 'utf8').matchAll(/new OsbError\(\s*'([A-Z_]+)'/g)) found.add(m[1]);
      }
    }
  };
  walk(join(__dirname, '../../src'));
  return found;
}

describe('every refusal validates against the published error document', () => {
  it('covers every code the server raises', () => {
    const raised = codesRaisedInSrc();
    expect(raised.size).toBeGreaterThanOrEqual(19);
    for (const code of raised) expect(Object.keys(BUILDS), code).toContain(code);
  });

  for (const [code, build] of Object.entries(BUILDS)) {
    it(code, () => {
      for (const e of build()) {
        expect(e.payload.code).toBe(code);
        const r = validatePayload('error', e.payload);
        expect(r.valid, `${code}: ${r.reasons.join('; ')}`).toBe(true);
      }
    });
  }
});

describe('a payload that drifts', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST, OSB_ENV: process.env.OSB_ENV };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it('throws under test and on dev', () => {
    expect(strictErrorChecks()).toBe(true);
    expect(() => new OsbError('NEEDS_DETAIL', { human_action: 'x'.repeat(301) })).toThrow(/error validation/);
  });

  it('is logged as schema-drift and sent anyway on prod', () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    process.env.OSB_ENV = 'prod';
    expect(strictErrorChecks()).toBe(false);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = 'y'.repeat(301);
    const e = new OsbError('NEEDS_DETAIL', { human_action: secret });
    expect(e.payload.code).toBe('NEEDS_DETAIL');
    expect(e.payload.human_action).toBe(secret);
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(log.mock.calls[0][0]));
    expect(line).toMatchObject({ level: 'error', tag: 'schema-drift', code: 'NEEDS_DETAIL' });
    expect(line.paths.join(' ')).toContain('/human_action');
    // The path and the rule only: never the words themselves.
    expect(String(log.mock.calls[0][0])).not.toContain('yyyy');
  });
});
