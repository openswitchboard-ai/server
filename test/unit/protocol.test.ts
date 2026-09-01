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
      assertOutbound('match.attributes', {
        schema_version: SCHEMA_VERSION,
        kind: 'match.attributes',
        match_id: '4b4b1f6e-3c3f-49f5-9df1-14b62ef62a1f',
        attributes: { condition: 'good' },
        price: { band: { min: 100, max: 300 }, ccy: 'AUD' },
      } as any),
    ).toThrow(/additionalProperties|price/);
  });

  it('refuses a stage-3 payload without the both-recorded opt-in attestation', () => {
    expect(() =>
      assertOutbound('match.mutual', {
        schema_version: SCHEMA_VERSION,
        kind: 'match.mutual',
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
