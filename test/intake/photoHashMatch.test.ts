/**
 * What a known-image match does, and what the rest of the door does around it
 * (src/intake/checks/photoHashMatch.ts).
 *
 * The known-image check is stood in for here: a checker that answers what the
 * test tells it to. Nothing in this file talks to any outside service or reads
 * a picture, and no module is involved (src/safety/knownImageCheck.ts).
 *
 * What is asserted:
 *
 *  - A MATCH REFUSES, with the reason code KNOWN_ABUSE_IMAGE and the SAME
 *    plain sentence the sexual-label refusal uses — word for word, so that a
 *    sender can never tell the two apart.
 *  - AND THE THREE ACTS HAPPEN BEHIND IT: the object is quarantined marked as
 *    a match with the source names, a review is opened flagged
 *    known_abuse_image carrying the answer's reference, and the sender is
 *    suspended.
 *  - NONE OF THEM CAN UNDO THE REFUSAL. A database that will not take a row is
 *    not a reason to carry a known abuse image to another person.
 *  - AN ERROR IS A HOLD, at every step: the fetch and the check.
 *  - NO MATCH PASSES, and OFF PASSES with the detail that says so, so the pipe
 *    carries on to the moderation call either way.
 *  - NOTHING WRITTEN DOWN IDENTIFIES THE PICTURE. Not the operator's line,
 *    not the verdict, not a row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  available: true,
  /** Set to say the secret is configured and the module did not come up. */
  unloaded: false,
  outcome: { matched: false, sources: [] as string[], ref: undefined as string | undefined },
  checkThrows: undefined as Error | undefined,
  checkedBytes: [] as number[],
}));

vi.mock('../../src/safety/knownImageCheck.js', () => ({
  knownImageState: async () => (fake.unloaded ? 'unavailable' : fake.available ? 'ready' : 'off'),
  checkKnownImage: async (bytes: Uint8Array) => {
    fake.checkedBytes.push(bytes.length);
    if (fake.checkThrows) throw fake.checkThrows;
    return fake.outcome;
  },
}));

const suspended = vi.hoisted(() => ({ calls: [] as Array<[string, string]>, throws: undefined as Error | undefined }));
vi.mock('../../src/safety/suspend.js', () => ({
  suspendAccount: async (accountId: string, reason: string) => {
    suspended.calls.push([accountId, reason]);
    if (suspended.throws) throw suspended.throws;
    return { account_id: accountId, newly_suspended: true };
  },
}));

const { s3 } = await import('../../src/aws.js');
const db = await import('../../src/db.js');
const {
  KNOWN_ABUSE_IMAGE_REASON,
  KNOWN_ABUSE_IMAGE_SUSPENSION,
  KNOWN_IMAGE_OFF_DETAIL,
  photoHashMatch,
} = await import('../../src/intake/checks/photoHashMatch.js');
const { PHOTO_BEING_LOOKED_AT, PHOTO_REFUSED } = await import(
  '../../src/intake/checks/photoModeration.js'
);
const { KNOWN_ABUSE_IMAGE_FLAG } = await import('../../src/safety/reviews.js');
import type { IntakeItem } from '../../src/intake/types.js';
import type { Config } from '../../src/config.js';

const cfg = { photoBucket: 'osb-dev-photos', photoModeration: true } as unknown as Config;
const BUCKET = 'osb-dev-photos';
const KEY = 'conversation-photos/dev/ch_1/abc.jpg';
const SENDER = '11111111-1111-4111-8111-111111111111';
const MATCH = '22222222-2222-4222-8222-222222222222';

/** Every statement the database was asked for, and every operator line. */
let queries: Array<{ sql: string; params: unknown[] }>;
let logged: string[];
let warned: string[];
let getThrows: Error | undefined;
let insertThrows: Error | undefined;
let copied: Array<{ from: string; to: string }>;

const item = (over: Partial<IntakeItem> = {}): IntakeItem => ({
  door: 'photo',
  sender_account: SENDER,
  match_id: MATCH,
  fields: { metadata_removed: 'true', metadata_stripped_by_server: 'true' },
  object: { bucket: BUCKET, key: KEY, content_type: 'image/jpeg' },
  ...over,
});

beforeEach(() => {
  fake.available = true;
  fake.unloaded = false;
  fake.outcome = { matched: false, sources: [], ref: undefined };
  fake.checkThrows = undefined;
  fake.checkedBytes = [];
  suspended.calls = [];
  suspended.throws = undefined;
  queries = [];
  logged = [];
  warned = [];
  getThrows = undefined;
  insertThrows = undefined;
  copied = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(String(line)));
  vi.spyOn(console, 'warn').mockImplementation((line: string) => void warned.push(String(line)));
  vi.spyOn(s3, 'send').mockImplementation(async (command: any) => {
    const name = command.constructor.name;
    if (name === 'GetObjectCommand') {
      if (getThrows) throw getThrows;
      return {
        Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3, 4, 5]) },
      } as any;
    }
    if (name === 'CopyObjectCommand') {
      copied.push({ from: command.input.CopySource, to: command.input.Key });
    }
    return {} as any;
  });
  vi.spyOn(db, 'getPool').mockReturnValue({
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (insertThrows && /INSERT INTO safety_reviews/.test(sql)) throw insertThrows;
      if (/RETURNING id/.test(sql)) {
        return { rows: [{ id: '33333333-3333-4333-8333-333333333333' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  } as any);
});

const matched = () => {
  fake.outcome = { matched: true, sources: ['Test', 'NCMEC'], ref: 'ref_track_1' };
};

describe('a picture that matched nothing', () => {
  it('passes, having handed the bytes over and asked once', async () => {
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('pass');
    expect(fake.checkedBytes).toEqual([5]);
    expect(suspended.calls).toEqual([]);
    expect(copied).toEqual([]);
  });
});

describe('a picture that matched', () => {
  beforeEach(matched);

  it('refuses, with the same sentence the other photo refusal uses', async () => {
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('refuse');
    expect(r.reason_code).toBe(KNOWN_ABUSE_IMAGE_REASON);
    expect(r.reason_code).toBe('KNOWN_ABUSE_IMAGE');
    // WORD FOR WORD. There is one refusal at this door, not two.
    expect(r.plain_words).toBe(PHOTO_REFUSED);
    expect(r.plain_words).not.toMatch(/hash|match|known|abuse|police/i);
  });

  it('quarantines the object, marked as a hash match, with the source names', async () => {
    await photoHashMatch.run(item(), cfg);
    expect(copied).toHaveLength(1);
    expect(copied[0].to).toContain('conversation-photos/quarantine');
    const insert = queries.find((q) => /INSERT INTO photo_quarantine/.test(q.sql));
    expect(insert).toBeTruthy();
    expect(insert!.params).toContain(true);
    expect(insert!.params).toContainEqual(['Test', 'NCMEC']);
    // No moderation label fired; the labels column stays empty.
    expect(insert!.params).toContainEqual([]);
  });

  it('opens a review flagged known_abuse_image, carrying the reference', async () => {
    await photoHashMatch.run(item(), cfg);
    const insert = queries.find((q) => /INSERT INTO safety_reviews/.test(q.sql));
    expect(insert).toBeTruthy();
    expect(insert!.params).toContainEqual([KNOWN_ABUSE_IMAGE_FLAG]);
    expect(insert!.params).toContain('ref_track_1');
    expect(insert!.sql).toContain('tracking_id');
    // One line at warn with two ids, exactly as a flagged message gets.
    expect(warned).toHaveLength(1);
    expect(JSON.parse(warned[0])).toEqual({
      event: 'safety-review',
      review_id: '33333333-3333-4333-8333-333333333333',
      match_id: MATCH,
    });
  });

  it('suspends the sender', async () => {
    await photoHashMatch.run(item(), cfg);
    expect(suspended.calls).toEqual([[SENDER, KNOWN_ABUSE_IMAGE_SUSPENSION]]);
    expect(KNOWN_ABUSE_IMAGE_SUSPENSION).toBe('known_abuse_image');
  });

  it('still refuses when the review will not insert', async () => {
    insertThrows = new Error('no');
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('refuse');
    // And the other two acts still happened.
    expect(copied).toHaveLength(1);
    expect(suspended.calls).toHaveLength(1);
  });

  it('still refuses when the suspension throws', async () => {
    suspended.throws = new Error('no');
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('refuse');
  });

  it('writes down the reason code and nothing about the picture', async () => {
    await photoHashMatch.run(item(), cfg);
    const everything = [...logged, ...warned].join('\n');
    expect(logged.some((l) => l.includes('"reason_code":"KNOWN_ABUSE_IMAGE"'))).toBe(true);
    for (const secret of ['ref_track_1', 'NCMEC', KEY, 'abc.jpg']) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('an answer that did not come back', () => {
  it('holds when the object will not fetch', async () => {
    getThrows = Object.assign(new Error('nope'), { name: 'NoSuchKey' });
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('hold');
    expect(r.plain_words).toBe(PHOTO_BEING_LOOKED_AT);
    expect(suspended.calls).toEqual([]);
    expect(copied).toEqual([]);
  });

  it('holds when the check throws', async () => {
    fake.checkThrows = new Error('the module could not read the picture');
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('hold');
    expect(r.reason_code).toBe('photo-hash-match-unavailable');
  });

  it('holds when the answer does not come back, and never on a pass', async () => {
    fake.checkThrows = new Error('the service answered 503');
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('hold');
    expect(r.outcome).not.toBe('pass');
  });

  it('says nothing in the line beyond the error name', async () => {
    fake.checkThrows = Object.assign(new Error('key sk_live_abcdef leaked into a message'), {
      name: 'TimeoutError',
    });
    await photoHashMatch.run(item(), cfg);
    expect(logged.join('\n')).toContain('TimeoutError');
    expect(logged.join('\n')).not.toContain('sk_live_abcdef');
  });
});

describe('the doors and deployments it does not stand at', () => {
  it('passes at presign, where there is no object yet, without hashing', async () => {
    const r = await photoHashMatch.run(item({ object: undefined }), cfg);
    expect(r.outcome).toBe('pass');
    expect(fake.checkedBytes).toEqual([]);
  });

  it('passes where the deployment carries no photos', async () => {
    const r = await photoHashMatch.run(item(), { photoModeration: false } as unknown as Config);
    expect(r.outcome).toBe('pass');
    expect(fake.checkedBytes).toEqual([]);
  });

  it('passes with a detail saying so where the check is off, so the pipe carries on', async () => {
    fake.available = false;
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('pass');
    expect(r.detail).toBe(KNOWN_IMAGE_OFF_DETAIL);
    expect(r.detail).toBe('known_image_off');
    // Nothing was fetched and nothing was asked.
    expect(fake.checkedBytes).toEqual([]);
    // And no sender is stopped for a deployment's missing licence.
    expect(suspended.calls).toEqual([]);
  });

  it('HOLDS, never passes, where a secret is configured and the module did not come up', async () => {
    const { PHOTOS_PAUSED } = await import('../../src/intake/checks/photoHashMatch.js');
    fake.available = false;
    fake.unloaded = true;
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('hold');
    expect(r.reason_code).toBe('known-image-not-loaded');
    expect(r.plain_words).toBe(PHOTOS_PAUSED);
    expect(PHOTOS_PAUSED).toBe('photos are paused for a moment; try again shortly.');
    expect(fake.checkedBytes).toEqual([]);
    expect(suspended.calls).toEqual([]);
  });
});

