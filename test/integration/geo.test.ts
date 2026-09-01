/**
 * Location gate against a LIVE deployment (default dev). Run with:
 *   AWS_PROFILE=openswitchboard npm run test:integration
 *
 * Proves the thing the 0.3.0 location work exists for: two agents describing
 * one city in two different ways land in the same place and find each other.
 * One says "Canberra", the other says "AU-ACT" — two strings that could never
 * be equal — and the pair still meets.
 *
 * Also proves, against the real service, that a street address and a name the
 * gazetteer cannot place are both refused with LOCATION_UNRESOLVED.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  SCHEMA_VERSION,
  TestActor,
  bootstrapActor,
  dbExec,
  mcpCall,
  poll,
  waitForCardState,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

let alice: TestActor; // says "Canberra"
let bob: TestActor; // says "AU-ACT"
let wantId: string;
let haveId: string;

const card = (type: 'WANT' | 'HAVE', place: string) => ({
  schema_version: SCHEMA_VERSION,
  type,
  category: 'goods.bicycle.mountain',
  geo: { place, radius_km: 25 },
  attributes: { condition: 'good', frame_size: 'L' },
});

d('one city, two spellings, one match', () => {
  beforeAll(async () => {
    [alice, bob] = await Promise.all([
      bootstrapActor('Alice', 'Canberra'),
      bootstrapActor('Bob', 'Canberra'),
    ]);
    const w = await mcpCall(alice.accessToken, 'publish_intent', {
      card: card('WANT', 'Canberra'),
    });
    expect(w.isError, JSON.stringify(w.result)).toBe(false);
    wantId = w.result.intent_id;
    const h = await mcpCall(bob.accessToken, 'publish_intent', {
      card: card('HAVE', 'AU-ACT'),
    });
    expect(h.isError, JSON.stringify(h.result)).toBe(false);
    haveId = h.result.intent_id;

    await Promise.all([
      waitForCardState(alice.accessToken, wantId, ['PUBLISHED']),
      waitForCardState(bob.accessToken, haveId, ['PUBLISHED']),
    ]);
  });

  it('both cards are placed, and their centres sit within a few km', async () => {
    const rows = await dbExec(
      `SELECT id::text, geo::text, geo_lat::text, geo_lon::text, geo_radius_km::text
         FROM cards WHERE id IN (:w::uuid, :h::uuid)`,
      [
        { name: 'w', value: wantId },
        { name: 'h', value: haveId },
      ],
    );
    expect(rows).toHaveLength(2);
    for (const [, geo, lat, lon] of rows) {
      const parsed = JSON.parse(String(geo));
      expect(parsed.place, geo).toBeTruthy();
      // The switchboard wrote the canonical cell itself.
      expect(parsed.bucket, geo).toMatch(/^[0-9bcdefghjkmnpqrstuvwxyz]{4}$/);
      expect(Number(lat)).toBeGreaterThan(-36);
      expect(Number(lat)).toBeLessThan(-34);
      expect(Number(lon)).toBeGreaterThan(148);
      expect(Number(lon)).toBeLessThan(150);
    }
    const [[km]] = await dbExec(
      `SELECT round((6371 * 2 * asin(sqrt(
          power(sin(radians(b.geo_lat - a.geo_lat) / 2), 2) +
          cos(radians(a.geo_lat)) * cos(radians(b.geo_lat)) *
          power(sin(radians(b.geo_lon - a.geo_lon) / 2), 2))))::numeric, 3)::text
         FROM cards a, cards b WHERE a.id = :w::uuid AND b.id = :h::uuid`,
      [
        { name: 'w', value: wantId },
        { name: 'h', value: haveId },
      ],
    );
    expect(Number(km)).toBeLessThan(50);
  });

  it('the pair meets, and both sides get the stage-1 signal', async () => {
    const matchId = await poll(
      async () => {
        const rows = await dbExec(
          `SELECT id::text FROM matches WHERE card_want = :w::uuid AND card_have = :h::uuid`,
          [
            { name: 'w', value: wantId },
            { name: 'h', value: haveId },
          ],
        );
        return (rows[0]?.[0] as string) ?? undefined;
      },
      'a match between the Canberra card and the AU-ACT card',
      180_000,
    );
    for (const actor of [alice, bob]) {
      const r = await mcpCall(actor.accessToken, 'check_matches', {});
      const ours = (r.result.matches ?? []).find((m: any) => m.match_id === matchId);
      expect(ours, JSON.stringify(r.result)).toBeTruthy();
      expect(ours.category).toBe('goods.bicycle.mountain');
      expect(ours.score).toBeGreaterThanOrEqual(0.75);
    }
  });

  it('refuses a street address, and a name nothing answers to', async () => {
    // A leading street number never gets past the protocol schema itself.
    const numbered = await mcpCall(alice.accessToken, 'publish_intent', {
      card: card('WANT', '12 Smith St'),
    });
    expect(numbered.isError).toBe(true);
    expect(JSON.stringify(numbered.result)).toContain('/geo/place');

    // Shapes the schema pattern allows are refused by the server.
    for (const [place, hint] of [
      ['Unit 5, 12 Smith St', /street address/i],
      ['Nowhereville', /nearest city|region/i],
    ] as [string, RegExp][]) {
      const r = await mcpCall(alice.accessToken, 'publish_intent', {
        card: card('WANT', place),
      });
      expect(r.isError, `${place}: ${JSON.stringify(r.result)}`).toBe(true);
      expect(r.result.code, JSON.stringify(r.result)).toBe('LOCATION_UNRESOLVED');
      expect(r.result.human_action).toMatch(hint);
    }
  });
});
