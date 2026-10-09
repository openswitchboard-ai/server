/**
 * Identifiers on a posting (migration 067), against a LIVE deployment
 * (default dev). Run:
 *   AWS_PROFILE=openswitchboard npm run test:integration
 *
 * First run green against dev on 9 October 2026. It needs a deployment with
 * migration 067 applied, the dev database and AWS credentials. The unit suite
 * (test/unit/identifiers.test.ts) holds every rule against a board in memory;
 * this holds the parts only a real database and a real screen can show:
 *
 *  (a) the doors: a posting goes up with its identifiers and they come back
 *      on list_intents as given; a contact detail and a one-object number are
 *      refused before anything is stored;
 *  (b) the columns and the index: both forms are on the row, written together;
 *  (c) the screen: a product's own number passes the model screen;
 *  (d) the exact-match path: a thin want and a full have for the same product
 *      meet as a sure introduction, and the details step says they carry the
 *      same identifier without ever carrying the identifier;
 *  (e) an amend replaces the set and sends the posting back to the screen.
 *
 * Each run uses its own geo bucket, so leftovers in the shared dev database
 * cannot reach these assertions.
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
  waitForCardState,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

const runTag = randomBytes(3).toString('hex');
const BUCKET = `id_${runTag}`;
// Unique to this run, so no other posting on the board can share it.
const MODEL = `ZX-${runTag.toUpperCase()}-900`;
const MODEL_NORM = `zx${runTag}900`;
const SHARED_SENTENCE =
  'Both postings carry the same identifier, the number or code that tells one product or edition from another.';

const listing = (type: 'looking_for' | 'offering', extra: Record<string, unknown>) => ({
  schema_version: SCHEMA_VERSION,
  type,
  category: 'goods.electronics.audio.headphones',
  geo: { bucket: BUCKET, radius_km: 25, reach: 'radius' },
  ttl_days: FIXTURE_TTL_DAYS,
  ...extra,
});

d('identifiers on a posting', () => {
  let ana: TestActor;
  let beppe: TestActor;
  let want: string;
  let have: string;

  beforeAll(async () => {
    [ana, beppe] = await Promise.all([bootstrapActor('Ana', 'Holt'), bootstrapActor('Beppe', 'Bruce')]);
  }, 600_000);

  it('(a) refuses a contact detail and a one-object number, and stores nothing', async () => {
    for (const identifiers of [
      [{ kind: 'model number', value: '0412 345 678' }],
      [{ kind: 'serial number', value: `SN-${runTag}-7781` }],
    ]) {
      const r = await mcpCall(
        ana.accessToken,
        'publish_intent',
        { listing: listing('looking_for', { kind: 'wireless headphones', attributes: { brand: 'Zenix' } }), identifiers },
        { answeredDetail: true },
      );
      expect(r.isError, JSON.stringify(r.result)).toBe(true);
      expect(r.result.error).toBe('invalid_input');
      expect(r.result.field).toBe('identifiers');
    }
    const rows = await dbExec(`SELECT count(*) FROM cards WHERE geo->>'bucket' = :b`, [{ name: 'b', value: BUCKET }]);
    expect(Number(rows[0][0])).toBe(0);
  });

  it('(a,b,c) posts both sides with the identifier, through the real screen, with both forms on the row', async () => {
    const posted = await mcpCall(
      ana.accessToken,
      'publish_intent',
      {
        listing: listing('looking_for', { kind: 'Zenix headphones', attributes: { brand: 'Zenix' } }),
        // Punctuated differently on each side: they are one identifier.
        identifiers: [{ kind: 'model number', value: MODEL.replace(/-/g, ' ') }],
      },
    );
    expect(posted.isError, JSON.stringify(posted.result)).toBe(false);
    want = posted.result.intent_id;
    expect(posted.result.identifiers).toEqual([{ kind: 'model number', value: MODEL.replace(/-/g, ' ') }]);

    const offered = await mcpCall(
      beppe.accessToken,
      'publish_intent',
      {
        listing: listing('offering', {
          kind: 'Zenix wireless noise cancelling headphones',
          attributes: { brand: 'Zenix', colour: 'black', condition: 'good', includes: 'case and cable' },
        }),
        identifiers: [{ kind: 'Model No.', value: MODEL }],
      },
    );
    expect(offered.isError, JSON.stringify(offered.result)).toBe(false);
    have = offered.result.intent_id;

    expect(await waitForCardState(ana.accessToken, want, ['PUBLISHED', 'SCREENING_REJECTED'])).toBe('PUBLISHED');
    expect(await waitForCardState(beppe.accessToken, have, ['PUBLISHED', 'SCREENING_REJECTED'])).toBe('PUBLISHED');

    const rows = await dbExec(
      `SELECT identifiers::text, array_to_string(identifier_norms, ','), screened_content->'identifiers'->0->>'norm'
         FROM cards WHERE id = :id::uuid`,
      [{ name: 'id', value: have }],
    );
    expect(JSON.parse(rows[0][0])).toEqual([{ kind: 'Model No.', value: MODEL, norm: MODEL_NORM }]);
    // The plain form comes first; an unpadded form follows it only where the
    // run tag happens to carry a padded run of digits.
    expect(rows[0][1].split(',')[0]).toBe(MODEL_NORM);
    expect(rows[0][2]).toBe(MODEL_NORM);

    const mine = await mcpCall(beppe.accessToken, 'list_intents', {});
    const entry = mine.result.intents.find((i: any) => i.intent_id === have);
    expect(entry.identifiers).toEqual([{ kind: 'Model No.', value: MODEL }]);
  });

  it('(d) introduces the two as sure, and says they carry the same identifier without carrying it', async () => {
    const match = await poll(async () => {
      const rows = await dbExec(
        `SELECT id, certainty FROM matches WHERE card_want = :w::uuid AND card_have = :h::uuid`,
        [
          { name: 'w', value: want },
          { name: 'h', value: have },
        ],
      );
      return rows[0];
    }, 'the introduction between the two postings', 120_000);
    expect(match[1]).toBe('sure');

    for (const actor of [ana, beppe]) {
      const r = await mcpCall(actor.accessToken, 'check_in', { intro_id: match[0], step: 'details' });
      expect(r.isError, JSON.stringify(r.result)).toBe(false);
      const text = JSON.stringify(r.result);
      expect(text).toContain(SHARED_SENTENCE);
      expect(text.toLowerCase()).not.toContain(MODEL.toLowerCase());
      expect(text.toLowerCase()).not.toContain(MODEL_NORM);
    }
  });

  it('(e) an amend replaces the set, and the posting goes back through the screen', async () => {
    const other = `QR-${runTag.toUpperCase()}-17`;
    const r = await mcpCall(beppe.accessToken, 'amend_intent', {
      intent_id: have,
      patch: {},
      identifiers: [{ kind: 'part number', value: other }],
    });
    expect(r.isError, JSON.stringify(r.result)).toBe(false);
    expect(r.result.state).toBe('PENDING_SCREENING');
    expect(r.result.identifiers).toEqual([{ kind: 'part number', value: other }]);
    expect(await waitForCardState(beppe.accessToken, have, ['PUBLISHED', 'SCREENING_REJECTED'])).toBe('PUBLISHED');
    const rows = await dbExec(
      `SELECT array_to_string(identifier_norms, ',') FROM cards WHERE id = :id::uuid`,
      [{ name: 'id', value: have }],
    );
    expect(rows[0][0].split(',')[0]).toBe(`qr${runTag}17`);
  });

  it('(f) a padded number meets a bare one, and a thirteen-digit code passes the real screen', async () => {
    const n = parseInt(runTag, 16);
    const a = 100 + (n % 900);
    const b = 1000 + (Math.floor(n / 900) % 9000);
    const code13 = `978${String(n).padStart(10, '0')}`;
    const wanted = await mcpCall(ana.accessToken, 'publish_intent', {
      listing: listing('looking_for', { kind: 'Orlin studio headphones', attributes: { brand: 'Orlin' } }),
      identifiers: [{ kind: 'catalogue number', value: `0${a}/${b}` }],
    });
    expect(wanted.isError, JSON.stringify(wanted.result)).toBe(false);
    const offered = await mcpCall(beppe.accessToken, 'publish_intent', {
      listing: listing('offering', {
        kind: 'Orlin studio headphones',
        attributes: { brand: 'Orlin', colour: 'silver', condition: 'good' },
      }),
      identifiers: [
        { kind: 'catalogue number', value: `${a}/${b}` },
        { kind: 'barcode', value: code13 },
      ],
    });
    expect(offered.isError, JSON.stringify(offered.result)).toBe(false);
    const w = wanted.result.intent_id;
    const h = offered.result.intent_id;
    expect(await waitForCardState(ana.accessToken, w, ['PUBLISHED', 'SCREENING_REJECTED'])).toBe('PUBLISHED');
    expect(await waitForCardState(beppe.accessToken, h, ['PUBLISHED', 'SCREENING_REJECTED'])).toBe('PUBLISHED');

    const forms = await dbExec(`SELECT array_to_string(identifier_norms, ',') FROM cards WHERE id = :id::uuid`, [
      { name: 'id', value: w },
    ]);
    expect(forms[0][0]).toBe(`0${a}${b},${a}${b}`);

    const match = await poll(async () => {
      const rows = await dbExec(
        `SELECT id, certainty FROM matches WHERE card_want = :w::uuid AND card_have = :h::uuid`,
        [
          { name: 'w', value: w },
          { name: 'h', value: h },
        ],
      );
      return rows[0];
    }, 'the introduction between the padded and the bare number', 120_000);
    expect(match[1]).toBe('sure');
    const r = await mcpCall(ana.accessToken, 'check_in', { intro_id: match[0], step: 'details' });
    expect(JSON.stringify(r.result)).toContain(SHARED_SENTENCE);
  });
});
