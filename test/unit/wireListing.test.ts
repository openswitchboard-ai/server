import { describe, expect, it } from 'vitest';
import { wireListing } from '../../src/mcp/tools.js';
import { validatePayload } from '../../src/protocol.js';

// Regression for the round-2 outage: the tool boundary once translated the
// side TOWARD the domain's WANT/HAVE before validation, and the 0.12.0
// protocol document admits only the wire words — so every publish failed,
// whichever words the agent used. The order is load-bearing: lift to wire
// words first, validate, and only then let the domain translate for its rows.

const listing = (over: Record<string, unknown>) => ({
  schema_version: '0.12.0',
  type: 'looking_for',
  category: 'goods.bicycle.mountain',
  geo: { place: 'Canberra', reach: 'radius', radius_km: 30 },
  ...over,
});

describe('wireListing lifts a posted listing to the wire words', () => {
  it('passes the wire words through untouched', () => {
    expect(wireListing(listing({})).type).toBe('looking_for');
    expect(wireListing(listing({ type: 'offering' })).type).toBe('offering');
  });

  it('lifts legacy WANT/HAVE to the wire words', () => {
    expect(wireListing(listing({ type: 'WANT' })).type).toBe('looking_for');
    expect(wireListing(listing({ type: 'HAVE' })).type).toBe('offering');
  });

  it('lifts the old visibility spelling', () => {
    expect(wireListing(listing({ visibility: 'anonymous-until-match' })).visibility).toBe(
      'anonymous-until-introduced',
    );
  });

  it('leaves an unrecognised side for validation to refuse', () => {
    expect(wireListing(listing({ type: 'NEED' })).type).toBe('NEED');
  });
});

describe('the protocol document admits exactly the wire words', () => {
  it('accepts what wireListing emits, for both sides and a legacy posting', () => {
    for (const type of ['looking_for', 'offering', 'WANT', 'HAVE']) {
      const lifted = wireListing(listing({ type }));
      expect(validatePayload('intent-card', lifted).valid, `side ${type}`).toBe(true);
    }
  });

  it("refuses the domain's own WANT/HAVE, proving the lift must come first", () => {
    expect(validatePayload('intent-card', listing({ type: 'WANT' })).valid).toBe(false);
  });
});
