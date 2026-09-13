import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { TOOLS } from '../../src/mcp/tools.js';

/**
 * `amend_intent.patch` used to restate nine of `publish_intent`'s property
 * schemas byte for byte — 4,820 characters of identical JSON in one
 * `tools/list` response, the largest single lump of pure duplication in what
 * the switchboard hands an agent at connect. The prose is gone from the copy
 * and the shape is not.
 *
 * Two things are held here, and they are the whole of the claim:
 *
 *  1. Every type, pattern, bound, enum, default and `required` on the patch is
 *     still exactly what publish_intent carries. Only `description` and
 *     `title` came off.
 *  2. What validates did not move. A patch that was accepted before is still
 *     accepted, and one that was refused is still refused — checked against
 *     the schema as it is actually serialised to a client.
 *
 * The server never validates an amend against this schema at all (it rebuilds
 * the whole want or have and checks it against the protocol's own intent-card
 * document, in domain/cards.ts), so a strict client's decoder is the only
 * thing reading it, and a decoder reads shape.
 */
const publish = TOOLS.find((t) => t.name === 'publish_intent')!;
const amend = TOOLS.find((t) => t.name === 'amend_intent')!;
const listing = (publish.inputSchema as any).properties.listing;
const patch = (amend.inputSchema as any).properties.patch;

const AMENDABLE = [
  'geo',
  'attributes',
  'ask',
  'urgency',
  'status',
  'ttl_days',
  'price',
  'slots',
  'sale',
];

/** The same node with every description and title taken off it. */
const bare = (node: any): any => {
  if (Array.isArray(node)) return node.map(bare);
  if (node === null || typeof node !== 'object') return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'description' || k === 'title') continue;
    out[k] = bare(v);
  }
  return out;
};

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
const accepts = ajv.compile({ ...patch, $schema: undefined } as any);
const valid = (p: unknown) => accepts(p) === true;

/**
 * The patch schema exactly as it was built before this change: the nine
 * properties copied off the posting schema whole, prose and all. It is the
 * control the differential below is run against.
 */
const acceptedBefore = ajv.compile({
  type: 'object',
  properties: Object.fromEntries(AMENDABLE.map((k) => [k, listing.properties[k]])),
  additionalProperties: false,
} as any);

describe('amend_intent carries publish_intent shape without publish_intent prose', () => {
  it('offers exactly the nine amendable fields', () => {
    expect(Object.keys(patch.properties)).toEqual(AMENDABLE);
    expect(patch.additionalProperties).toBe(false);
  });

  it('keeps every type, bound, enum and default the posting schema has', () => {
    for (const k of AMENDABLE) {
      expect(patch.properties[k], k).toEqual(bare(listing.properties[k]));
    }
  });

  it('carries no prose of its own beyond one pointer at the field itself', () => {
    const prose = (node: any, out: string[] = []): string[] => {
      if (Array.isArray(node)) node.forEach((n) => prose(n, out));
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if ((k === 'description' || k === 'title') && typeof v === 'string') out.push(v);
          else prose(v, out);
        }
      }
      return out;
    };
    expect(prose(patch.properties)).toEqual([]);
    expect(patch.description).toContain('publish_intent');
    expect(patch.description.length).toBeLessThan(200);
  });

  it('is markedly smaller than the posting schema it copies from', () => {
    // The saving is the point of the change; if a later edit puts the prose
    // back this is what says so.
    expect(JSON.stringify(patch).length).toBeLessThan(2500);
  });
});

const SAMPLES: unknown[] = [
  {},
  { geo: { place: 'Canberra' } },
  { geo: { place: 'Newtown, NSW', reach: 'country' } },
  { geo: { place: 'Canberra', reach: 'radius', radius_km: 30 } },
  { geo: { place: 'Sydney', reach: 'anywhere' } },
  { geo: { bucket: 'r3dp' } },
  { geo: {} },
  { geo: { place: 'Canberra', lat: -35.28 } },
  { geo: { place: 'Canberra', reach: 'nationwide' } },
  { geo: { place: 'Canberra', reach: 'radius', radius_km: 5000 } },
  { geo: { place: 'Canberra', reach: 'radius', radius_km: 0 } },
  { geo: { place: 'C' } },
  { geo: { place: '12 Mort Street' } },
  { ask: { amount: 420, ccy: 'AUD' } },
  { ask: { amount: '420', ccy: 'AUD' } },
  { ask: { amount: 420, ccy: 'aud' } },
  { ask: { amount: 0, ccy: 'AUD' } },
  { ask: { amount: 420, ccy: 'AUD', hidden: true } },
  { ask: { ccy: 'AUD' } },
  { price: { band: { min: 100, max: 420 }, ccy: 'AUD' } },
  { price: { band: { min: -1, max: 420 }, ccy: 'AUD' } },
  { price: { ccy: 'AUD' } },
  { urgency: 'none' },
  { urgency: 'days' },
  { urgency: 'today' },
  { urgency: 'high' },
  { urgency: 'immediately' },
  { urgency: 3 },
  { status: 'active' },
  { status: 'latent' },
  { status: 'sold' },
  { ttl_days: 1 },
  { ttl_days: 30 },
  { ttl_days: 90 },
  { ttl_days: 91 },
  { ttl_days: 0 },
  { ttl_days: '30' },
  { ttl_days: 30.5 },
  { slots: 1 },
  { slots: 4 },
  { slots: 10 },
  { slots: 11 },
  { slots: 0 },
  { slots: 'four' },
  { sale: 'straight' },
  { sale: 'best-offer' },
  { sale: 'auction' },
  { attributes: {} },
  { attributes: { language: 'italian' } },
  { attributes: { brand: 'Apple', model: 'MacBook Air' } },
  { type: 'offering' },
  { category: 'goods.bicycle.mountain' },
  { schema_version: '0.14.0' },
  { visibility: 'anonymous-until-introduced' },
  { geo: { place: 'Canberra' }, slots: 2, sale: 'straight' },
  { geo: { place: 'Canberra' }, slots: 2, type: 'offering' },
];

describe('what the patch schema validates is unchanged', () => {
  it('gives the same verdict as the full-prose schema on every sample', () => {
    // The whole claim of this change, checked rather than asserted: the schema
    // as it was built before, and the schema as it ships now, agree on every
    // one of these — the valid ones and the invalid ones alike. Descriptions
    // never constrained anything, and now there is a test that says so.
    expect(SAMPLES.length).toBeGreaterThan(50);
    for (const sample of SAMPLES) {
      expect(accepts(sample), JSON.stringify(sample)).toBe(acceptedBefore(sample));
    }
    // The control is doing work: the samples are not all valid, nor all not.
    expect(SAMPLES.some((s) => acceptedBefore(s) === true)).toBe(true);
    expect(SAMPLES.some((s) => acceptedBefore(s) === false)).toBe(true);
  });

  // Each of these was accepted by the schema before the prose came off, and
  // each is accepted now. Descriptions never constrained anything.
  it('still accepts the patches that were valid', () => {
    expect(valid({})).toBe(true);
    expect(valid({ geo: { place: 'Canberra' } })).toBe(true);
    expect(valid({ geo: { place: 'Newtown, NSW', reach: 'country' } })).toBe(true);
    expect(valid({ geo: { place: 'Canberra', reach: 'radius', radius_km: 30 } })).toBe(true);
    expect(valid({ geo: { bucket: 'r3dp' } })).toBe(true);
    expect(valid({ ask: { amount: 420, ccy: 'AUD' } })).toBe(true);
    expect(valid({ price: { band: { min: 100, max: 420 }, ccy: 'AUD' } })).toBe(true);
    expect(valid({ urgency: 'today' })).toBe(true);
    expect(valid({ status: 'active' })).toBe(true);
    expect(valid({ ttl_days: 30 })).toBe(true);
    expect(valid({ slots: 4 })).toBe(true);
    expect(valid({ sale: 'best-offer' })).toBe(true);
    expect(valid({ attributes: { language: 'italian' } })).toBe(true);
    expect(valid({ geo: { place: 'Canberra' }, slots: 2, sale: 'straight' })).toBe(true);
  });

  it('still refuses the patches that were invalid', () => {
    // A field that is not amendable at all.
    expect(valid({ type: 'offering' })).toBe(false);
    expect(valid({ category: 'goods.bicycle.mountain' })).toBe(false);
    // Enum members that do not exist.
    expect(valid({ urgency: 'immediately' })).toBe(false);
    expect(valid({ urgency: 'high' })).toBe(false);
    expect(valid({ sale: 'auction' })).toBe(false);
    expect(valid({ status: 'sold' })).toBe(false);
    expect(valid({ geo: { place: 'Canberra', reach: 'nationwide' } })).toBe(false);
    // Wrong types.
    expect(valid({ slots: 'four' })).toBe(false);
    expect(valid({ ttl_days: '30' })).toBe(false);
    expect(valid({ ask: { amount: '420', ccy: 'AUD' } })).toBe(false);
    // Bounds and patterns.
    expect(valid({ ask: { amount: 420, ccy: 'aud' } })).toBe(false);
    expect(valid({ geo: { place: 'Canberra', reach: 'radius', radius_km: 5000 } })).toBe(false);
    expect(valid({ slots: 0 })).toBe(false);
    // Something extra inside a copied object.
    expect(valid({ geo: { place: 'Canberra', lat: -35.28 } })).toBe(false);
    expect(valid({ ask: { amount: 420, ccy: 'AUD', hidden: true } })).toBe(false);
  });
});
