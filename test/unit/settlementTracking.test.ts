/**
 * A tracking reference is a record, and the terms say where records live.
 *
 * The public terms promise that handover and return records — tracking numbers
 * and photos alike — are kept in a store that cannot be altered for ninety
 * days. The photos and the handover manifest always were. The two tracking
 * references were not: they were plain columns on `settlements`, which is to
 * say a thing an operator with a database console could quietly change, on the
 * one field the default rule turns on.
 *
 * WHAT IS PROVED HERE, with no database, no AWS and no Stripe:
 *   - every recorded reference is written into the Object-Lock evidence
 *     bucket, under the settlement's own prefix, as a JSON record carrying who
 *     recorded it and when;
 *   - the frozen record lands BEFORE the column that points at it, so a bucket
 *     that refuses the write leaves nothing recorded anywhere rather than a
 *     reference with no record behind it;
 *   - a second reference is a second object, never an edit of the first;
 *   - the key of the frozen record is what the column beside the reference
 *     holds, and the consent event names it too;
 *   - tracking already on the row at handover rides into the manifest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../../src/db.js';
import * as crypto from '../../src/crypto.js';
import { s3 } from '../../src/aws.js';
import * as settlements from '../../src/domain/settlements.js';
import { freezeTrackingRecord, writeEvidenceManifest } from '../../src/domain/evidence.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  evidenceBucket: 'osb-evidence-dev',
  settlementAutoReleaseDays: 7,
  settlementDisputeDeadlockDays: 14,
  settlementReturnSilenceDays: 7,
  settlementTrackingGraceDays: 7,
} as unknown as Config;

const SID = '7a2e5c1d-9f4b-4c8a-b3e6-2d1f0a9b8c7d';
const MID = '0d9f2c1e-7b4a-4f7e-9c2d-1a2b3c4d5e6f';

const row = (over: Record<string, any> = {}): any => ({
  id: SID,
  match_id: MID,
  proposer_account: 'buyer-acct',
  buyer_account: 'buyer-acct',
  seller_account: 'seller-acct',
  amount: '87.65',
  ccy: 'AUD',
  state: 'disputed',
  dispute_ground: 'not_as_described',
  delivery_tracking: null,
  delivery_tracking_key: null,
  return_tracking: null,
  return_tracking_key: null,
  returned_at: null,
  ...over,
});

/** Every S3 call the code under test made, in order. */
let puts: { key: string; body: any; contentType?: string; checksum?: string }[];
let heads: string[];
/** Every UPDATE the code under test ran, with its parameters. */
let updates: { sql: string; params: any[] }[];
let consent: Record<string, any>[];

function mockS3(putFails = false) {
  return vi.spyOn(s3, 'send').mockImplementation(async (cmd: any) => {
    const name = cmd.constructor.name;
    if (name === 'HeadObjectCommand') {
      heads.push(cmd.input.Key);
      return { ContentLength: 1234, ETag: '"abc"' } as any;
    }
    if (putFails) throw new Error('bucket said no');
    puts.push({
      key: cmd.input.Key,
      body: cmd.input.Body,
      contentType: cmd.input.ContentType,
      checksum: cmd.input.ChecksumSHA256,
    });
    return {} as any;
  });
}

function fakePool(world: any[], evidenceRows: any[] = []) {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/^SELECT \* FROM settlements WHERE id/.test(sql.trim())) {
        return rows(world.filter((s) => s.id === params[0]));
      }
      if (/FROM settlement_evidence/.test(sql)) return rows(evidenceRows);
      if (/^UPDATE settlements/.test(sql.trim())) {
        updates.push({ sql, params });
        const found = world.find((s) => s.id === params[0]);
        return rows(found ? [found] : []);
      }
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  puts = [];
  heads = [];
  updates = [];
  consent = [];
  vi.spyOn(crypto, 'writeConsentEvent').mockImplementation(async (e: any) => {
    consent.push(e);
    return 'consent-key';
  });
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('the frozen record itself', () => {
  it('writes one JSON object under the settlement prefix, checksummed', async () => {
    mockS3();
    const key = await freezeTrackingRecord(cfg, row(), {
      kind: 'delivery',
      reference: 'AP 7XY4410092',
      recordedBy: 'seller-acct',
    });
    expect(puts).toHaveLength(1);
    expect(key).toBe(puts[0].key);
    // Beside the manifest, under the same prefix the photos use: one settlement,
    // one place, and the bucket's Object Lock covers all of it.
    expect(key.startsWith(`settlement-evidence/dev/${SID}/tracking-delivery-`)).toBe(true);
    expect(key.endsWith('.json')).toBe(true);
    expect(puts[0].contentType).toBe('application/json');
    // Object Lock demands a checksum on every write, the same as a photo.
    expect(puts[0].checksum).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    const record = JSON.parse(String(puts[0].body));
    expect(record).toMatchObject({
      record: 'settlement-tracking-record',
      env: 'dev',
      settlement_id: SID,
      match_id: MID,
      kind: 'delivery',
      reference: 'AP 7XY4410092',
      recorded_by: 'seller-acct',
    });
    expect(Date.parse(record.recorded_at)).toBeGreaterThan(0);
  });

  it('gives a corrected reference its own key, so nothing is ever overwritten', async () => {
    mockS3();
    const first = await freezeTrackingRecord(cfg, row(), {
      kind: 'return',
      reference: 'AP 1',
      recordedBy: 'buyer-acct',
    });
    const second = await freezeTrackingRecord(cfg, row(), {
      kind: 'return',
      reference: 'AP 2',
      recordedBy: 'buyer-acct',
    });
    expect(second).not.toBe(first);
    expect(puts.map((p) => p.key)).toEqual([first, second]);
    expect(JSON.parse(String(puts[0].body)).reference).toBe('AP 1');
    expect(JSON.parse(String(puts[1].body)).reference).toBe('AP 2');
  });

  it('refuses to pretend on a deployment with no bucket configured', async () => {
    mockS3();
    await expect(
      freezeTrackingRecord({ ...cfg, evidenceBucket: undefined } as Config, row(), {
        kind: 'delivery',
        reference: 'AP 1',
        recordedBy: 'seller-acct',
      }),
    ).rejects.toThrow(/evidence bucket/);
    expect(puts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("the seller's tracking", () => {
  it('freezes the reference and keeps the key beside the column', async () => {
    mockS3();
    const world = [row({ state: 'funded' })];
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool(world));
    await settlements.addDeliveryTracking(
      settlements.counterAction('seller-acct'),
      cfg,
      SID,
      '  AP  7XY4410092 ',
    );
    expect(puts).toHaveLength(1);
    const record = JSON.parse(String(puts[0].body));
    // The reference is frozen exactly as the column records it: tidied once,
    // in one place, so the two can never disagree.
    expect(record.reference).toBe('AP 7XY4410092');
    expect(record.kind).toBe('delivery');
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(/delivery_tracking_key = \$3/);
    expect(updates[0].params).toEqual([SID, 'AP 7XY4410092', puts[0].key]);
    // The consent chain names the frozen record too, so the hash-chained
    // history and the bucket point at each other.
    expect(consent[0]).toMatchObject({
      event: 'settlement-delivery-tracking-added',
      tracking: 'AP 7XY4410092',
      record_key: puts[0].key,
    });
  });

  it('records nothing at all when the bucket refuses the write', async () => {
    mockS3(true);
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool([row({ state: 'funded' })]));
    await expect(
      settlements.addDeliveryTracking(settlements.counterAction('seller-acct'), cfg, SID, 'AP 1'),
    ).rejects.toThrow(/bucket said no/);
    // No column write, and no consent event: the reference was never recorded,
    // rather than recorded in the one place that can be edited.
    expect(updates).toEqual([]);
    expect(consent).toEqual([]);
  });

  it('freezes nothing for a hand that is not the seller', async () => {
    mockS3();
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool([row({ state: 'funded' })]));
    await expect(
      settlements.addDeliveryTracking(settlements.counterAction('buyer-acct'), cfg, SID, 'AP 1'),
    ).rejects.toThrow();
    expect(puts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("the buyer's return", () => {
  it('freezes the reference and keeps the key beside the column', async () => {
    mockS3();
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool([row()]));
    await settlements.markReturned(
      settlements.counterAction('buyer-acct'),
      cfg,
      SID,
      'AP 9ZZ1',
    );
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0].body))).toMatchObject({
      kind: 'return',
      reference: 'AP 9ZZ1',
      recorded_by: 'buyer-acct',
    });
    expect(updates[0].sql).toMatch(/return_tracking_key = \$3/);
    expect(updates[0].params).toEqual([SID, 'AP 9ZZ1', puts[0].key]);
    expect(consent[0]).toMatchObject({ event: 'settlement-returned', record_key: puts[0].key });
  });

  it('records nothing at all when the bucket refuses the write', async () => {
    mockS3(true);
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool([row()]));
    await expect(
      settlements.markReturned(settlements.counterAction('buyer-acct'), cfg, SID, 'AP 9ZZ1'),
    ).rejects.toThrow(/bucket said no/);
    expect(updates).toEqual([]);
    expect(consent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('the handover manifest', () => {
  it('carries the tracking the seller had already added', async () => {
    mockS3();
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool([], []));
    const { manifestKey } = await writeEvidenceManifest(
      cfg,
      row({
        state: 'funded',
        delivery_tracking: 'AP 7XY4410092',
        delivery_tracking_key: `settlement-evidence/dev/${SID}/tracking-delivery-1.json`,
      }),
      'seller-acct',
    );
    const manifest = JSON.parse(String(puts.find((p) => p.key === manifestKey)!.body));
    expect(manifest.delivery_tracking).toEqual({
      reference: 'AP 7XY4410092',
      record_key: `settlement-evidence/dev/${SID}/tracking-delivery-1.json`,
    });
  });

  it('says nothing about tracking on a handover that had none', async () => {
    mockS3();
    vi.spyOn(db, 'getPool').mockReturnValue(fakePool([], []));
    const { manifestKey } = await writeEvidenceManifest(cfg, row({ state: 'funded' }), 'seller-acct');
    const manifest = JSON.parse(String(puts.find((p) => p.key === manifestKey)!.body));
    expect('delivery_tracking' in manifest).toBe(false);
    // The handover still freezes: photos are optional and the declaration is
    // the point.
    expect(manifest.kind).toBe('settlement-evidence-manifest');
  });
});
