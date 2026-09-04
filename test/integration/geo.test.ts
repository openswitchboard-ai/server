/**
 * Location gate against a LIVE deployment (default dev). Run with:
 *   AWS_PROFILE=openswitchboard npm run test:integration
 *
 * Proves the thing the 0.3.0 location work exists for: two agents describing
 * one city in two different ways land in the same place and find each other.
 * One says "Canberra", the other says "AU-ACT" — two strings that could never
 * be equal — and the pair still meets.
 *
 * Also proves, against the real service, what the switchboard will not guess
 * at: a street address, a name the gazetteer cannot place, a bare state and a
 * bare country all come back as LOCATION_UNRESOLVED, and a name several
 * cities answer to comes back as LOCATION_AMBIGUOUS with the candidates
 * spelled out. What it does place, it says out loud — in the publish
 * response, and on the ledger page its owner reads.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  FIXTURE_TTL_DAYS,
  SCHEMA_VERSION,
  TestActor,
  bootstrapActor,
  counterFetch,
  dbExec,
  mcpCall,
  poll,
  waitForCardState,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

let alice: TestActor; // says "Canberra"
let bob: TestActor; // says "AU-ACT"
let seller: TestActor; // Canberra, posts anywhere in Australia
let buyer: TestActor; // Perth, happy to have it posted
let wantId: string;
let haveId: string;

/**
 * Every account this file needs, made before the file publishes anything.
 *
 * Accounts are bootstrapped over the shared ops queue, and that queue also
 * carries a summons for every match. A card posted in a real city meets
 * whatever else is in that city, so a few publishes can put dozens of
 * summonses in front of the next create-account and starve it. Asking for
 * the accounts first costs nothing and takes them out of that race.
 */
if (RUN) {
  beforeAll(async () => {
    [alice, bob, seller, buyer] = await Promise.all([
      bootstrapActor('Alice', 'Canberra'),
      bootstrapActor('Bob', 'Canberra'),
      bootstrapActor('Sam', 'Canberra'),
      bootstrapActor('Pia', 'Perth'),
    ]);
  }, 300_000);
}

const card = (type: 'WANT' | 'HAVE', place: string) => ({
  schema_version: SCHEMA_VERSION,
  type,
  category: 'goods.bicycle.mountain',
  geo: { place, radius_km: 25 },
  attributes: { condition: 'good', frame_size: 'L' },
  ttl_days: FIXTURE_TTL_DAYS,
});

d('one city, two spellings, one match', () => {
  beforeAll(async () => {
    const w = await mcpCall(alice.accessToken, 'publish_intent', {
      listing: card('WANT', 'Canberra'),
    });
    expect(w.isError, JSON.stringify(w.result)).toBe(false);
    wantId = w.result.intent_id;
    const h = await mcpCall(bob.accessToken, 'publish_intent', {
      listing: card('HAVE', 'AU-ACT'),
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
    // The poll is budgeted for three minutes, because the matcher waits behind
    // whatever the shared dev queues are carrying. The test's own timeout has
    // to be longer than its poll, or the failure it reports is a stopwatch
    // rather than the thing the test is about (it was 120s against a 180s
    // poll, and the poll never got to say what it had not found).
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
      expect(ours.signal.kind).toBe('match.signal');
      expect(ours.signal.category).toBe('goods.bicycle.mountain');
      expect(ours.signal.score).toBeGreaterThanOrEqual(0.75);
    }
  }, 240_000);

  it('refuses a bare state or territory, and says to name a town in it', async () => {
    // A card posted as "ACT" once resolved to Waco, Texas, on an airport code
    // the source data hangs off the city. The switchboard now refuses the
    // shorthand outright and asks for a real place inside it.
    const r = await mcpCall(alice.accessToken, 'publish_intent', {
      listing: card('WANT', 'ACT'),
    });
    expect(r.isError, JSON.stringify(r.result)).toBe(true);
    expect(r.result.code, JSON.stringify(r.result)).toBe('LOCATION_UNRESOLVED');
    expect(r.result.human_action).toMatch(/state or territory/i);
    expect(r.result.human_action).toContain('Australian Capital Territory');
  });

  it('refuses a bare country, names it, and says where nationwide lives', async () => {
    // The second incident: a card posted as "AU" sat on the centroid of the
    // continent, 476 km from the city it belonged to. An agent writing "AU"
    // usually means a card that REACHES Australia, so the refusal now names
    // the field that says so.
    const r = await mcpCall(alice.accessToken, 'publish_intent', {
      listing: card('WANT', 'AU'),
    });
    expect(r.isError, JSON.stringify(r.result)).toBe(true);
    expect(r.result.code, JSON.stringify(r.result)).toBe('LOCATION_UNRESOLVED');
    expect(r.result.human_action).toMatch(/whole country/i);
    expect(r.result.human_action).toContain('Australia');
    expect(r.result.human_action).toMatch(/reach to "country"/);
  });

  it('refuses a name several cities answer to, and lists them', async () => {
    const r = await mcpCall(alice.accessToken, 'publish_intent', {
      listing: card('WANT', 'Perth'),
    });
    expect(r.isError, JSON.stringify(r.result)).toBe(true);
    expect(r.result.code, JSON.stringify(r.result)).toBe('LOCATION_AMBIGUOUS');
    const displays = (r.result.candidates ?? []).map((c: any) => c.display);
    expect(displays, JSON.stringify(r.result)).toContain('Perth, Western Australia, AU');
    expect(displays, JSON.stringify(r.result)).toContain('Perth, Scotland, GB');

    // The candidate's own string is what the agent reposts with, and the card
    // lands where that one is.
    const chosen = (r.result.candidates as any[]).find((c) => c.display.endsWith('GB'));
    const again = await mcpCall(alice.accessToken, 'publish_intent', {
      listing: card('WANT', chosen.place),
    });
    expect(again.isError, JSON.stringify(again.result)).toBe(false);
    expect(again.result.location_resolved.display).toContain('Scotland');
  });

  it('says where it put the card, and shows the same place on the ledger', async () => {
    const r = await mcpCall(alice.accessToken, 'publish_intent', {
      listing: card('WANT', 'Canberra'),
    });
    expect(r.isError, JSON.stringify(r.result)).toBe(false);
    expect(r.result.location_resolved, JSON.stringify(r.result)).toBeTruthy();
    expect(r.result.location_resolved.display).toContain('Australian Capital Territory');
    expect(r.result.location_resolved.radius_km).toBeGreaterThan(0);

    // The same place, written out, on the page where the person who lives
    // there would notice it was wrong.
    const page = await counterFetch(alice.jar, '/ledger');
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('Canberra, Australian Capital Territory, Australia');
    expect(body).toMatch(/matching within \d+ km/);
  });

  it('says the reach back, in the same words, for all three forms', async () => {
    for (const [geo, expected] of [
      [{ place: 'Canberra', reach: 'country' }, 'reaching all of Australia'],
      [{ place: 'Canberra', reach: 'anywhere' }, 'reaching anywhere'],
      [{ place: 'Canberra', radius_km: 25 }, 'matching within 25 km'],
    ] as [any, string][]) {
      const r = await mcpCall(alice.accessToken, 'publish_intent', {
        listing: { ...card('WANT', 'Canberra'), geo },
      });
      expect(r.isError, JSON.stringify(r.result)).toBe(false);
      expect(r.result.location_resolved.display, JSON.stringify(r.result)).toBe(
        `Canberra, Australian Capital Territory, Australia — ${expected}`,
      );
      // Three cards for one assertion would eat the open-intent quota, and
      // the echo is all this test wanted.
      await mcpCall(alice.accessToken, 'withdraw_intent', { intent_id: r.result.intent_id });
    }
  });

  it('refuses a street address, and a name nothing answers to', async () => {
    // A leading street number never gets past the protocol schema itself.
    const numbered = await mcpCall(alice.accessToken, 'publish_intent', {
      listing: card('WANT', '12 Smith St'),
    });
    expect(numbered.isError).toBe(true);
    expect(JSON.stringify(numbered.result)).toContain('/geo/place');

    // Shapes the schema pattern allows are refused by the server.
    for (const [place, hint] of [
      ['Unit 5, 12 Smith St', /street address/i],
      ['Nowhereville', /nearest city|region/i],
    ] as [string, RegExp][]) {
      const r = await mcpCall(alice.accessToken, 'publish_intent', {
        listing: card('WANT', place),
      });
      expect(r.isError, `${place}: ${JSON.stringify(r.result)}`).toBe(true);
      expect(r.result.code, JSON.stringify(r.result)).toBe('LOCATION_UNRESOLVED');
      expect(r.result.human_action).toMatch(hint);
    }
  });
});

/**
 * Reach, against the live service. Canberra to Perth is about 3,100 km — no
 * radius the protocol allows gets anywhere near it, and before reach existed
 * this pair could not have met however willing both people were. Both cards
 * still name a real town; what changed is that both say they would cross the
 * country for it.
 */
d('a card that reaches a whole country', () => {
  let nationwideHave: string;
  let farWant: string;

  const laptop = (type: 'WANT' | 'HAVE', geo: any) => ({
    schema_version: SCHEMA_VERSION,
    type,
    category: 'goods.electronics.laptop',
    geo,
    attributes: { brand: 'apple', model: 'macbook air', condition: 'good' },
    ttl_days: FIXTURE_TTL_DAYS,
  });

  beforeAll(async () => {
    const h = await mcpCall(seller.accessToken, 'publish_intent', {
      listing: laptop('HAVE', { place: 'Canberra', reach: 'country' }),
    });
    expect(h.isError, JSON.stringify(h.result)).toBe(false);
    expect(h.result.location_resolved.display).toBe(
      'Canberra, Australian Capital Territory, Australia — reaching all of Australia',
    );
    nationwideHave = h.result.intent_id;

    // A modest radius, because Pia is not driving anywhere — and a reach that
    // says she will take it in the post.
    const w = await mcpCall(buyer.accessToken, 'publish_intent', {
      listing: laptop('WANT', { place: 'Perth, Western Australia', radius_km: 25, reach: 'country' }),
    });
    expect(w.isError, JSON.stringify(w.result)).toBe(false);
    expect(w.result.location_resolved.display).toContain('reaching all of Australia');
    farWant = w.result.intent_id;

    await Promise.all([
      waitForCardState(seller.accessToken, nationwideHave, ['PUBLISHED']),
      waitForCardState(buyer.accessToken, farWant, ['PUBLISHED']),
    ]);
    // Two cards behind whatever the suite above left on the shared queues —
    // the match notices from the first pair take their turn in front of
    // these. The default hook window is not enough for that.
  }, 300_000);

  it('stores the reach on the card and the country it resolved to', async () => {
    const rows = await dbExec(
      `SELECT id::text, geo::text, geo_country, geo_radius_km::text
         FROM cards WHERE id IN (:h::uuid, :w::uuid)`,
      [
        { name: 'h', value: nationwideHave },
        { name: 'w', value: farWant },
      ],
    );
    expect(rows).toHaveLength(2);
    for (const [, geo, country] of rows) {
      expect(JSON.parse(String(geo)).reach, geo).toBe('country');
      expect(country).toBe('AU');
    }
  });

  it('the pair meets across the country', async () => {
    const matchId = await poll(
      async () => {
        const rows = await dbExec(
          `SELECT id::text FROM matches WHERE card_want = :w::uuid AND card_have = :h::uuid`,
          [
            { name: 'w', value: farWant },
            { name: 'h', value: nationwideHave },
          ],
        );
        return (rows[0]?.[0] as string) ?? undefined;
      },
      'a match between the Canberra nationwide HAVE and the Perth WANT',
      180_000,
    );
    const r = await mcpCall(buyer.accessToken, 'check_matches', {});
    const ours = (r.result.matches ?? []).find((m: any) => m.match_id === matchId);
    expect(ours, JSON.stringify(r.result)).toBeTruthy();
    expect(ours.signal.category).toBe('goods.electronics.laptop');
  }, 240_000);

  it('the same two places, without the reach, stay apart', async () => {
    // The control: nothing about the distance changed, only what the two
    // people said they would do about it.
    const local = await mcpCall(buyer.accessToken, 'publish_intent', {
      listing: laptop('WANT', { place: 'Perth, Western Australia', radius_km: 25 }),
    });
    expect(local.isError, JSON.stringify(local.result)).toBe(false);
    const localWant = local.result.intent_id;
    await waitForCardState(buyer.accessToken, localWant, ['PUBLISHED']);
    // Give the matcher the same window the designed pair got, then assert the
    // absence: a radius WANT is not covered by anyone's nationwide reach.
    await new Promise((r) => setTimeout(r, 20_000));
    const rows = await dbExec(
      `SELECT id::text FROM matches WHERE card_want = :w::uuid AND card_have = :h::uuid`,
      [
        { name: 'w', value: localWant },
        { name: 'h', value: nationwideHave },
      ],
    );
    expect(rows).toHaveLength(0);
  });

  it('the ledger says where the card is and how far it goes', async () => {
    const page = await counterFetch(seller.jar, '/ledger');
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('Canberra, Australian Capital Territory, Australia');
    expect(body).toContain('reaching all of Australia');
  });
});
