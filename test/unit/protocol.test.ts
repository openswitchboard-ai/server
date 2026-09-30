import { describe, expect, it } from 'vitest';
import {
  OsbError,
  SCHEMA_VERSION,
  assertOutbound,
  bundledSchema,
  checkSchemaVersion,
  validatePayload,
} from '../../src/protocol.js';

describe('outbound payload enforcement (no-leak rule)', () => {
  it('refuses to emit a stage-2 payload carrying a price band', () => {
    expect(() =>
      assertOutbound('intro.attributes', {
        schema_version: SCHEMA_VERSION,
        kind: 'intro.attributes',
        match_id: '4b4b1f6e-3c3f-49f5-9df1-14b62ef62a1f',
        attributes: { condition: 'good' },
        price: { band: { min: 100, max: 300 }, ccy: 'AUD' },
      } as any),
    ).toThrow(/additionalProperties|price/);
  });

  it('refuses a stage-3 payload without the both-recorded opt-in attestation', () => {
    expect(() =>
      assertOutbound('intro.mutual', {
        schema_version: SCHEMA_VERSION,
        kind: 'intro.mutual',
        match_id: '4b4b1f6e-3c3f-49f5-9df1-14b62ef62a1f',
        counterparty: { first_name: 'Ana', locality: 'Fremantle' },
      } as any),
    ).toThrow(/optin/);
  });

  it('refuses an offer with an agent-level accepted state', () => {
    expect(() =>
      assertOutbound('offer', {
        schema_version: SCHEMA_VERSION,
        kind: 'offer',
        offer_id: '4b4b1f6e-3c3f-49f5-9df1-14b62ef62a1f',
        match_id: '4b4b1f6e-3c3f-49f5-9df1-14b62ef62a1f',
        amount: 100,
        ccy: 'AUD',
        expiry: new Date().toISOString(),
        state: 'accepted',
      } as any),
    ).toThrow(/enum/);
  });

  it('refuses a decline carrying a reason', () => {
    expect(() =>
      assertOutbound('offer', {
        schema_version: SCHEMA_VERSION,
        kind: 'offer',
        offer_id: '4b4b1f6e-3c3f-49f5-9df1-14b62ef62a1f',
        match_id: '4b4b1f6e-3c3f-49f5-9df1-14b62ef62a1f',
        amount: 100,
        ccy: 'AUD',
        expiry: new Date().toISOString(),
        state: 'declined',
        reason: 'too low',
      } as any),
    ).toThrow(/additionalProperties/);
  });
});

describe('protocol errors', () => {
  it('OsbError payloads validate against error.json', () => {
    const e = new OsbError('QUOTA_EXCEEDED', { retry_after: 3600 });
    expect(validatePayload('error', e.payload).valid).toBe(true);
    expect(e.payload.docs_url).toContain('QUOTA_EXCEEDED');
  });
  it('carries category suggestions, capped at three', () => {
    const e = new OsbError('CATEGORY_PROHIBITED', {
      human_action:
        "That category isn't in the taxonomy. Closest open ones: goods.electronics.laptop, goods.electronics.tablet, goods.electronics.desktop.",
      suggestions: [
        'goods.electronics.laptop',
        'goods.electronics.tablet',
        'goods.electronics.desktop',
        'goods.electronics.monitor',
      ],
    });
    expect(validatePayload('error', e.payload).valid).toBe(true);
    expect(e.payload.suggestions).toEqual([
      'goods.electronics.laptop',
      'goods.electronics.tablet',
      'goods.electronics.desktop',
    ]);
  });
  it('leaves suggestions off when there are none', () => {
    const e = new OsbError('CATEGORY_PROHIBITED', { suggestions: [] });
    expect(validatePayload('error', e.payload).valid).toBe(true);
    expect(e.payload.suggestions).toBeUndefined();
  });
  it('every code the server sends validates, with its real sentence (schema 0.17.0)', async () => {
    const { PLACE_NOT_FULL } = await import('../../src/geo/normalise.js');
    const { SUSPENDED_WORDS } = await import('../../src/intake/checks/suspended.js');
    const { CONVERSATION_PAUSED_WORDS } = await import('../../src/domain/conversationWindow.js');
    const detail = await import('../../src/domain/postingDetail.js');
    const { FIGURE_HUMAN_ACTION } = await import('../../src/domain/postingFigure.js');
    const cards = await import('../../src/domain/cards.js');
    const { SHELF_PICK_ACTION } = await import('../../src/domain/shelfPick.js');
    const ref = '7f0c2a4e-1b9d-4c55-9a8e-3d2f6b1c0e91';
    // A link as long as a real one: origin, /a/, a uuid, a dot and a 43-character MAC.
    const link = `https://my.dev.openswitchboard.ai/a/${ref}.${'x'.repeat(43)}`;
    const built = [
      new OsbError('LOCATION_NOT_FULL', { human_action: PLACE_NOT_FULL }),
      new OsbError('SUSPENDED', { human_action: SUSPENDED_WORDS }),
      new OsbError('CONVERSATION_PAUSED', { human_action: CONVERSATION_PAUSED_WORDS }),
      ...[
        detail.DETAIL_HUMAN_ACTION,
        detail.DETAIL_AND_RADIUS_HUMAN_ACTION,
        detail.DETAIL_CONTEXT_HUMAN_ACTION,
        detail.DETAIL_RECOGNISE_HUMAN_ACTION,
        detail.DETAIL_UNKNOWN_UNMATCHED,
      ].map(
        (human_action) =>
          new OsbError('NEEDS_DETAIL', { human_action, questions: ['What make and model is it?'], reference: ref }),
      ),
      new OsbError('CONFIRM_FIGURE', {
        human_action: `${FIGURE_HUMAN_ACTION}${cards.FIGURE_RADIUS_TAIL}`,
        questions: ['Is $420 AUD the figure you gave as your asking price, or is it one I put there myself?'],
        figures: [{ what: 'asking price', amount: 420, currency: 'AUD' }],
        reference: ref,
      }),
      new OsbError('SHELF_UNCLEAR', {
        human_action: cards.shelfUnclearAction(),
        candidates: [
          { category: 'goods.motoring.parts', words: 'car parts' },
          { category: 'none_of_these', words: 'none of these' },
        ],
      }),
      new OsbError('SHELF_PICK', { human_action: `${SHELF_PICK_ACTION} ${link}`, press_id: ref }),
      new OsbError('FLOOR_IS_PRIVATE', { human_action: cards.FLOOR_IS_PRIVATE_ACTION }),
    ];
    for (const e of built) {
      expect(validatePayload('error', e.payload).valid, e.payload.code).toBe(true);
    }
  });
  it('rejects unknown major schema versions', () => {
    expect(() => checkSchemaVersion('99.0.0')).toThrow('SCHEMA_VERSION_UNSUPPORTED');
    expect(() => checkSchemaVersion(SCHEMA_VERSION)).not.toThrow();
  });
});

describe('bundled tool schemas', () => {
  it('bundles intent-card self-contained (no cross-file refs)', () => {
    const b = bundledSchema('intent-card');
    expect(JSON.stringify(b)).not.toContain('common.json');
    expect(b.$defs.priceBand).toBeDefined();
  });
});
