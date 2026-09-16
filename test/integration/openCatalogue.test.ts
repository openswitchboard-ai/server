/**
 * THE CATALOGUE IS A DENY LIST, against a LIVE deployment (default dev). Run:
 *   AWS_PROFILE=openswitchboard npm run test:integration
 *
 * One thing, end to end, because it is the thing the whole change rests on: a
 * want filed under a leaf nobody has ever written down GOES UP. Not validated
 * and refused, not accepted and then rejected at screening — published, with
 * the words its agent chose for it stored beside it and written down on the
 * growth list for the next taxonomy release.
 *
 * Three refusals ride along, because "everything goes up" would be the wrong
 * lesson to draw: a reserved family is still refused, an unknown child of a
 * reserved family is refused with it, and an unknown leaf with no plain words
 * for the thing is refused for the missing words rather than for the category.
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_TTL_DAYS,
  SCHEMA_VERSION,
  TestActor,
  bootstrapActor,
  dbExec,
  mcpCall,
  waitForCardState,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

const runTag = randomBytes(3).toString('hex');
const BUCKET = `oc_${runTag}`;
// A leaf the taxonomy has never heard of and never will while this runs: the
// run tag is in the path, so nothing else on the shared dev database can have
// posted under it.
const UNKNOWN_LEAF = `services.repairs.vintage-synth-${runTag}`;

let mo: TestActor;

d('an unknown leaf goes up', () => {
  beforeAll(async () => {
    mo = await bootstrapActor('Mo', 'Braddon');
  }, 400_000);

  it('publishes, screens and reaches PUBLISHED under a leaf nobody wrote down', async () => {
    const r = await mcpCall(mo.accessToken, 'publish_intent', {
      listing: {
        schema_version: SCHEMA_VERSION,
        type: 'looking_for',
        category: UNKNOWN_LEAF,
        kind: 'vintage synth repair',
        geo: { bucket: BUCKET, radius_km: 25 },
        ttl_days: FIXTURE_TTL_DAYS,
      },
    });
    expect(r.isError, JSON.stringify(r.result)).toBe(false);
    const intentId = r.result.intent_id as string;
    expect(r.result.state).toBe('PENDING_SCREENING');

    // The whole point: it comes out the far side of the same screening the
    // known leaves go through, published rather than held back.
    const state = await waitForCardState(mo.accessToken, intentId, [
      'PUBLISHED',
      'SCREENING_REJECTED',
    ]);
    expect(state).toBe('PUBLISHED');

    // The agent's own words are stored, and read back on its own list.
    const rows = await dbExec('SELECT kind FROM cards WHERE id = :id::uuid', [
      { name: 'id', value: intentId },
    ]);
    expect(rows[0]?.kind).toBe('vintage synth repair');
    const list = await mcpCall(mo.accessToken, 'list_intents', {});
    const mine = list.result.intents.find((i: any) => i.intent_id === intentId);
    expect(mine.listing.kind).toBe('vintage synth repair');

    // And the gap is on the growth list, with the words beside it — written
    // because the posting went UP, not because anything was refused.
    const misses = await dbExec(
      'SELECT requested, kind FROM category_misses WHERE requested = :c',
      [{ name: 'c', value: UNKNOWN_LEAF }],
    );
    expect(misses).toHaveLength(1);
    expect(misses[0].kind).toBe('vintage synth repair');
  }, 400_000);

  it('still refuses a reserved family, and an unknown leaf inside one', async () => {
    for (const category of ['social.dating', `social.dating.speed-nights-${runTag}`]) {
      const r = await mcpCall(mo.accessToken, 'publish_intent', {
        listing: {
          schema_version: SCHEMA_VERSION,
          type: 'looking_for',
          category,
          kind: 'someone to go out with',
          geo: { bucket: BUCKET, radius_km: 25 },
          ttl_days: FIXTURE_TTL_DAYS,
        },
      });
      expect(JSON.stringify(r.result), category).toContain('CATEGORY_PROHIBITED');
    }
  }, 200_000);

  it('refuses an unknown leaf that never says what the thing is', async () => {
    const r = await mcpCall(mo.accessToken, 'publish_intent', {
      listing: {
        schema_version: SCHEMA_VERSION,
        type: 'looking_for',
        category: `goods.mystery-object-${runTag}`,
        geo: { bucket: BUCKET, radius_km: 25 },
        ttl_days: FIXTURE_TTL_DAYS,
      },
    });
    // The category was fine; the posting was short of a field, so it is not
    // the category's refusal that comes back.
    const said = JSON.stringify(r.result);
    expect(said).not.toContain('CATEGORY_PROHIBITED');
    expect(said).toMatch(/no leaf for that category/i);
  }, 200_000);
});
