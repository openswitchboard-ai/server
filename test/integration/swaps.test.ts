/**
 * SWAPS against a LIVE deployment (default dev). Run:
 *   AWS_PROFILE=openswitchboard RUN_INTEGRATION=1 npx vitest run test/integration/swaps.test.ts
 *
 * WRITTEN 26 September 2026 AND NOT YET RUN: it needs the swap change and
 * migration 053 deployed to dev first. Rewritten the same day for the general
 * complement rule (domain/swaps.ts): the offer now goes in `offers`, as the
 * manual (v70) asks, and swaps reach the services shelves too. The unit suite (test/unit/swaps.test.ts)
 * pins the rules; this evidences them through the real product path (OAuth +
 * MCP publish + screening + embedding + matcher worker):
 *   - the pair from the first production test — one person after Spanish who
 *     speaks English, one after English who speaks Spanish, both wants — is
 *     introduced, ONCE, as a swap, in canonical order;
 *   - both people read it as somebody looking too, with no figure possible;
 *   - two identical "after Spanish, offer English" wants are not introduced;
 *   - two wants on goods are never introduced to each other;
 *   - on services, two wants that each offer what the other is after (guitar
 *     lessons for piano lessons) are introduced as a swap, and two people who
 *     both want a house cleaned and offer nothing are never introduced.
 *
 * Every posting gets a RUN-UNIQUE opaque bucket and radius reach, so leftovers
 * in the shared dev DB cannot pollute the assertions.
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
  poll,
  waitForCardStates,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

const runTag = randomBytes(3).toString('hex');
const LANG_B = `sw_${runTag}`;
const SAME_B = `ss_${runTag}`;
const GOODS_B = `sg_${runTag}`;
const SERV_B = `sv_${runTag}`;
const NONE_B = `sn_${runTag}`;

const want = (category: string, bucket: string, kind: string, attributes: Record<string, unknown>) => ({
  schema_version: SCHEMA_VERSION,
  type: 'WANT',
  category,
  kind,
  attributes,
  geo: { bucket, radius_km: 25, reach: category.startsWith('goods') ? 'country' : 'radius' },
  ttl_days: FIXTURE_TTL_DAYS,
});

async function publish(actor: TestActor, c: any): Promise<string> {
  const r = await mcpCall(actor.accessToken, 'publish_intent', { listing: c });
  expect(r.isError, JSON.stringify(r.result)).toBe(false);
  expect(r.result?.intent_id, JSON.stringify(r.result).slice(0, 600)).toBeTruthy();
  return r.result.intent_id as string;
}

async function rowsBetween(a: string, b: string): Promise<any[]> {
  return dbExec(
    `SELECT id, card_want::text, card_have::text, swap FROM matches
      WHERE (card_want = :a::uuid AND card_have = :b::uuid)
         OR (card_want = :b::uuid AND card_have = :a::uuid)`,
    [
      { name: 'a', value: a },
      { name: 'b', value: b },
    ],
  );
}

let ana: TestActor; // after Spanish, offers English
let beto: TestActor; // after English, offers Spanish
let cleo: TestActor; // after Spanish, offers English (same as ana)
let dora: TestActor; // after Spanish, offers English (same as cleo)
let eli: TestActor; // goods want
let fay: TestActor; // goods want
let gus: TestActor; // services: after guitar lessons, offers piano lessons
let hana: TestActor; // services: after piano lessons, offers guitar lessons
let ivo: TestActor; // services: after house cleaning, offers nothing
let jo: TestActor; // services: after house cleaning, offers nothing

let anaWant = '';
let betoWant = '';
let cleoWant = '';
let doraWant = '';
let eliWant = '';
let fayWant = '';
let gusWant = '';
let hanaWant = '';
let ivoWant = '';
let joWant = '';

d('swaps: two wants on social or services meet, once', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    const mk = (n: string) => bootstrapActor(n, 'Fixtureville');
    [ana, beto, cleo, dora, eli, fay, gus, hana, ivo, jo] = await Promise.all([
      mk('Ana'), mk('Beto'), mk('Cleo'), mk('Dora'), mk('Eli'), mk('Fay'),
      mk('Gus'), mk('Hana'), mk('Ivo'), mk('Jo'),
    ]);
    const tandem = 'social.language-exchange.tandem';
    [anaWant, betoWant, cleoWant, doraWant, eliWant, fayWant, gusWant, hanaWant, ivoWant, joWant] = await Promise.all([
      publish(ana, want(tandem, LANG_B, 'Spanish conversation partner', {
        language: 'Spanish', offers: 'English', format: 'online',
      })),
      publish(beto, want(tandem, LANG_B, 'English practice partner', {
        language: 'English', offers: 'Spanish', format: 'online',
      })),
      publish(cleo, want(tandem, SAME_B, 'Spanish conversation partner', {
        language: 'Spanish', offers: 'English', format: 'online',
      })),
      publish(dora, want(tandem, SAME_B, 'Spanish conversation partner', {
        language: 'Spanish', offers: 'English', format: 'online',
      })),
      publish(eli, want('goods.bicycle.mountain', GOODS_B, 'mountain bike', {
        brand: 'trek', model: 'marlin 7', condition: 'good',
      })),
      publish(fay, want('goods.bicycle.mountain', GOODS_B, 'mountain bike', {
        brand: 'trek', model: 'marlin 7', condition: 'good',
      })),
      publish(gus, want('services.lessons.guitar', SERV_B, 'guitar lessons', {
        offers: 'piano lessons', format: 'in-person',
      })),
      publish(hana, want('services.lessons.piano', SERV_B, 'piano lessons', {
        offers: 'guitar lessons', format: 'in-person',
      })),
      publish(ivo, want('services.home.cleaning', NONE_B, 'house cleaning', {
        frequency: 'fortnightly', format: 'in-person',
      })),
      publish(jo, want('services.home.cleaning', NONE_B, 'house cleaning', {
        frequency: 'fortnightly', format: 'in-person',
      })),
    ]);
    await Promise.all(
      (
        [
          [ana, anaWant],
          [beto, betoWant],
          [cleo, cleoWant],
          [dora, doraWant],
          [eli, eliWant],
          [fay, fayWant],
          [gus, gusWant],
          [hana, hanaWant],
          [ivo, ivoWant],
          [jo, joWant],
        ] as const
      ).map(([actor, id]) => waitForCardStates(actor.accessToken, [id], ['PUBLISHED'])),
    );
  }, 290_000);

  it('introduces the language pair once, as a swap, in canonical order', async () => {
    const rows = await poll(
      async () => {
        const r = await rowsBetween(anaWant, betoWant);
        return r.length ? r : undefined;
      },
      'the swap introduction',
    );
    // Both publishes ran matching; still exactly one row.
    await new Promise((r) => setTimeout(r, 5_000));
    const again = await rowsBetween(anaWant, betoWant);
    expect(again).toHaveLength(1);
    const [, cardWant, cardHave, swap] = rows[0];
    expect(swap).toBe(true);
    expect([cardWant, cardHave]).toEqual([anaWant, betoWant].sort());
  });

  it('both people read it as somebody looking too, and no figure can go on it', async () => {
    const [[matchId]] = await rowsBetween(anaWant, betoWant);
    for (const actor of [ana, beto]) {
      const r = await mcpCall(actor.accessToken, 'check_in', {});
      const entry = r.result.introductions.find((m: any) => m.intro_id === matchId);
      expect(entry).toBeTruthy();
      // Live for both, or in line for one: either way nothing says "offering".
      if (entry.state === 'open') {
        expect(entry.swap).toBe(true);
        expect(entry.signal.counterparty_type).toBe('looking_for');
        expect(entry.note.text).toContain('too');
        const offer = await mcpCall(actor.accessToken, 'respond', {
          action: 'propose_offer',
          intro_id: matchId,
          offer: { amount: 20, ccy: 'AUD', expiry: new Date(Date.now() + 86_400_000).toISOString() },
        });
        expect(offer.result.code).toBe('NOT_UNLOCKED_YET');
        expect(JSON.stringify(offer.result)).toContain('no money changes hands');
      }
    }
  });

  it('does not introduce two identical "after Spanish, offer English" wants', async () => {
    await new Promise((r) => setTimeout(r, 10_000));
    expect(await rowsBetween(cleoWant, doraWant)).toHaveLength(0);
  });

  it('never introduces two wants on goods to each other', async () => {
    await new Promise((r) => setTimeout(r, 5_000));
    expect(await rowsBetween(eliWant, fayWant)).toHaveLength(0);
  });

  it('introduces a services swap where each offers what the other is after', async () => {
    const rows = await poll(
      async () => {
        const r = await rowsBetween(gusWant, hanaWant);
        return r.length ? r : undefined;
      },
      'the services swap introduction',
    );
    expect(rows).toHaveLength(1);
    const [, cardWant, cardHave, swap] = rows[0];
    expect(swap).toBe(true);
    expect([cardWant, cardHave]).toEqual([gusWant, hanaWant].sort());
  });

  it('never introduces two services wants that offer nothing', async () => {
    await new Promise((r) => setTimeout(r, 5_000));
    expect(await rowsBetween(ivoWant, joWant)).toHaveLength(0);
  });
});
