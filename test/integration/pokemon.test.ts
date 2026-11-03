/**
 * Pokémon cards, against a LIVE deployment (default dev). Run:
 *   AWS_PROFILE=openswitchboard npm run test:integration -- test/integration/pokemon.test.ts
 *
 * Trading-card collectors are the first people the switchboard is for, and
 * their errand is the one the lists rehearsal plays out with two assistants
 * (internal: test/rehearsal/scenarios/cards.ts). This holds the same errand
 * without the assistants, so the release gate sees it on every run:
 *
 *  (a) a collector's spares go up as one sale list, read back once as a
 *      figure summary: a name for each card, its printed number as an
 *      identifier, the condition from the export, a price only where she gave
 *      one. The same card in two conditions is two items. A graded card whose
 *      detail carries the grading certificate number is turned back, because
 *      that number belongs to one slab (manual 1b, domain/identifiers.ts);
 *  (b) every item passes the real screen, and the certificate number is
 *      nowhere on the board;
 *  (c) a buyer after one card, named the way people name it ("the Charizard
 *      ex from Obsidian Flames, number 125"), is introduced to that card as
 *      sure, on the strength of the number. Another Charizard ex on the list
 *      may come through as possible, never as sure: an identifier only ever
 *      lifts a pair and two different numbers do not count against one
 *      (domain/matchTiers.ts, IT NEVER COUNTS AGAINST A PAIR).
 *
 * The cards are real cards, so their numbers are the same on every run. A
 * run keeps to its own list and its own buyer: every assertion is about this
 * list's items, so a leftover from another run cannot change what it proves.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_TTL_DAYS,
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

const BUCKET = `pk_${randomBytes(3).toString('hex')}`;
const SHELF = 'goods.toys-games.trading-cards';
const CERT = '104882913';

const card = (name: string, number: string, details: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  name,
  identifiers: [{ kind: 'card number', value: number }],
  details,
  ...extra,
});

/** Mia's spares, as her collection app exports them. Index 3 is the graded card. */
const SPARES = [
  card('Charizard ex', '125/197', { set: 'Obsidian Flames', condition: 'near mint' }, { open_to_offers: true }),
  card('Charizard ex', '199/165', { set: '151', condition: 'near mint' }, { price: 250 }),
  card('Charizard ex', '006/165', { set: '151', condition: 'lightly played' }, { open_to_offers: true }),
  card('Pikachu ex', '238/191', { set: 'Surging Sparks', condition: 'PSA 10', psa_cert: CERT }, { price: 420 }),
  card('Snorlax', '143/165', { set: '151', condition: 'near mint' }, { quantity: 2, open_to_offers: true }),
  card('Snorlax', '143/165', { set: '151', condition: 'moderately played' }, { open_to_offers: true }),
];

/** Poll read_lists until every item on the list has left the screen. */
async function waitForListScreened(token: string, listId: string): Promise<any> {
  return poll(
    async () => {
      const r = await mcpCall(token, 'read_lists', { list_id: listId });
      if (r.isError || !r.result?.list_items) {
        throw new Error(`read_lists failed while waiting: ${JSON.stringify(r.result).slice(0, 300)}`);
      }
      return r.result.list_items.some((i: any) => i.state === 'PENDING_SCREENING') ? undefined : r.result;
    },
    `list ${listId} to leave the screen`,
    240_000,
    10_000,
  );
}

d('Pokémon cards', () => {
  let mia: TestActor;
  let dan: TestActor;
  let listId = '';
  let danWant = '';

  beforeAll(async () => {
    [mia, dan] = await Promise.all([bootstrapActor('Mia', 'Corrimal'), bootstrapActor('Dan', 'Belconnen')]);
  }, 600_000);

  afterAll(async () => {
    if (listId) await mcpCall(mia.accessToken, 'withdraw_list', { list_id: listId }).catch(() => {});
    if (danWant) await mcpCall(dan.accessToken, 'withdraw_intent', { intent_id: danWant }).catch(() => {});
  });

  it('(a) a collector\'s spares go up as one sale list, and the graded card\'s certificate number is turned back', async () => {
    const args = {
      shared: {
        side: 'offering',
        category: SHELF,
        geo: { bucket: BUCKET, reach: 'country' },
        deal: 'sale',
        currency: 'AUD',
        ttl_days: FIXTURE_TTL_DAYS,
      },
      items: SPARES,
    };
    // The two asking prices are read back once, as a summary, before anything
    // goes up; the market prices in her export were never sent as figures.
    const first = await mcpCall(mia.accessToken, 'publish_list', args, { confirmedFigure: true });
    expect(first.result.what_happened, JSON.stringify(first.result)).toBe('confirm_figure');
    const second = await mcpCall(mia.accessToken, 'publish_list', { ...args, reference: first.result.reference }, { confirmedFigure: true });
    expect(second.isError, JSON.stringify(second.result)).toBe(false);
    listId = second.result.list_id;

    // Five go up: the two Snorlax rows are one card in two conditions, so two
    // items. The graded Pikachu comes back with the one fix that matters.
    expect(second.result.added).toBe(5);
    expect(second.result.refused_items).toEqual([expect.objectContaining({ index: 3, reason: 'details' })]);
    expect(second.result.refused_items[0].fix).toContain('belongs to one object');
  });

  it('(b) every card passes the real screen, and the certificate number is nowhere on the board', async () => {
    const read = await waitForListScreened(mia.accessToken, listId);
    expect(read.list_items.map((i: any) => i.state)).toEqual(Array(5).fill('PUBLISHED'));
    const leaked = await dbExec(
      `SELECT count(*) FROM cards
        WHERE account_id = :a::uuid
          AND (attributes::text LIKE :c OR coalesce(screened_content::text, '') LIKE :c)`,
      [
        { name: 'a', value: mia.accountId },
        { name: 'c', value: `%${CERT}%` },
      ],
    );
    expect(Number(leaked[0][0])).toBe(0);
  });

  it('(c) a buyer after one Charizard ex is introduced to that card as sure, and to no other card as sure', async () => {
    const want = await mcpCall(dan.accessToken, 'publish_intent', {
      listing: {
        schema_version: SCHEMA_VERSION,
        type: 'looking_for',
        category: SHELF,
        kind: 'Charizard ex',
        attributes: { set: 'Obsidian Flames' },
        geo: { bucket: BUCKET, reach: 'country' },
        ttl_days: FIXTURE_TTL_DAYS,
      },
      // Spaced the way a person reads it off the card: compared normalised.
      identifiers: [{ kind: 'card number', value: '125 / 197' }],
    });
    expect(want.isError, JSON.stringify(want.result)).toBe(false);
    danWant = want.result.intent_id;
    expect(await waitForCardState(dan.accessToken, danWant, ['PUBLISHED', 'SCREENING_REJECTED'])).toBe('PUBLISHED');

    /** Each introduction to an item on Mia's list: its printed number and how sure. */
    const introductions = async (): Promise<[string, string][]> => {
      const rows = await dbExec(
        `SELECT h.identifiers->0->>'value', m.certainty FROM matches m
           JOIN cards h ON h.id = m.card_have
          WHERE m.card_want = :w::uuid AND h.list_id = :l::uuid`,
        [
          { name: 'w', value: danWant },
          { name: 'l', value: listId },
        ],
      );
      return rows.map((r) => [String(r[0]), String(r[1])]);
    };
    await poll(
      async () => ((await introductions()).some(([n]) => n === '125/197') ? true : undefined),
      'the introduction between the want and the Charizard ex 125/197',
      180_000,
    );
    const got = await introductions();
    expect(got).toContainEqual(['125/197', 'sure']);
    expect(got.filter(([n, c]) => n !== '125/197' && c === 'sure')).toEqual([]);
  });
});
