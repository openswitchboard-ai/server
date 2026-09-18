/**
 * What a known-image match does, and what the rest of the door does around it
 * (src/intake/checks/photoHashMatch.ts).
 *
 * Both halves of the machinery are stood in for here: a hasher that answers
 * what the test tells it to, and a match client that says match or no match.
 * Nothing in this file talks to Microsoft, hashes anything, or reads a picture,
 * and no licensed file is involved.
 *
 * What is asserted:
 *
 *  - A MATCH REFUSES, with the reason code KNOWN_ABUSE_IMAGE and the SAME
 *    plain sentence the sexual-label refusal uses — word for word, so that a
 *    sender can never tell the two apart.
 *  - AND THE THREE ACTS HAPPEN BEHIND IT: the object is quarantined marked as
 *    a hash match with the source names, a review is opened flagged
 *    known_abuse_image carrying the tracking id, and the sender is suspended.
 *  - NONE OF THEM CAN UNDO THE REFUSAL. A database that will not take a row is
 *    not a reason to carry a known abuse image to another person.
 *  - AN ERROR IS A HOLD, at every step: the fetch, the hash and the match.
 *  - NO MATCH PASSES, and OFF PASSES with the detail that says so, so the pipe
 *    carries on to the moderation call either way.
 *  - NOTHING WRITTEN DOWN CARRIES A HASH. Not the operator's line, not the
 *    verdict, not a row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  available: true,
  hashes: ['hash-one', 'hash-two'],
  outcome: { match: false, sources: [] as string[], trackingId: undefined as string | undefined },
  hashThrows: undefined as Error | undefined,
  matchThrows: undefined as Error | undefined,
  hashedBytes: [] as number[],
  matched: [] as string[][],
}));

vi.mock('../../src/safety/photodna.js', () => ({
  photoDnaAvailable: async () => fake.available,
  edgeHashes: async (bytes: Uint8Array) => {
    fake.hashedBytes.push(bytes.length);
    if (fake.hashThrows) throw fake.hashThrows;
    return fake.hashes;
  },
  matchHashes: async (hashes: string[]) => {
    fake.matched.push(hashes);
    if (fake.matchThrows) throw fake.matchThrows;
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
  PHOTODNA_OFF_DETAIL,
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
  fields: { metadata_removed: 'true' },
  object: { bucket: BUCKET, key: KEY, content_type: 'image/jpeg' },
  ...over,
});

beforeEach(() => {
  fake.available = true;
  fake.hashes = ['hash-one', 'hash-two'];
  fake.outcome = { match: false, sources: [], trackingId: undefined };
  fake.hashThrows = undefined;
  fake.matchThrows = undefined;
  fake.hashedBytes = [];
  fake.matched = [];
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
  fake.outcome = { match: true, sources: ['Test', 'NCMEC'], trackingId: 'EUS_track_1' };
};

describe('a picture that matched nothing', () => {
  it('passes, having hashed the bytes and asked once', async () => {
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('pass');
    expect(fake.hashedBytes).toEqual([5]);
    // Both hashes of the one picture go in one request.
    expect(fake.matched).toEqual([['hash-one', 'hash-two']]);
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

  it('opens a review flagged known_abuse_image, carrying the tracking id', async () => {
    await photoHashMatch.run(item(), cfg);
    const insert = queries.find((q) => /INSERT INTO safety_reviews/.test(q.sql));
    expect(insert).toBeTruthy();
    expect(insert!.params).toContainEqual([KNOWN_ABUSE_IMAGE_FLAG]);
    expect(insert!.params).toContain('EUS_track_1');
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
    for (const secret of ['hash-one', 'hash-two', KEY, 'abc.jpg']) {
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

  it('holds when the hashing fails', async () => {
    fake.hashThrows = new Error('photodna hashing failed: Image is flat');
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('hold');
    expect(r.reason_code).toBe('photo-hash-match-unavailable');
  });

  it('holds when the match call fails, and never on a pass', async () => {
    fake.matchThrows = new Error('photodna match answered 503');
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('hold');
    expect(r.outcome).not.toBe('pass');
  });

  it('says nothing in the line beyond the error name', async () => {
    fake.matchThrows = Object.assign(new Error('key sk_live_abcdef leaked into a message'), {
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
    expect(fake.hashedBytes).toEqual([]);
  });

  it('passes where the deployment carries no photos', async () => {
    const r = await photoHashMatch.run(item(), { photoModeration: false } as unknown as Config);
    expect(r.outcome).toBe('pass');
    expect(fake.hashedBytes).toEqual([]);
  });

  it('passes with a detail saying so where PhotoDNA is off, so the pipe carries on', async () => {
    fake.available = false;
    const r = await photoHashMatch.run(item(), cfg);
    expect(r.outcome).toBe('pass');
    expect(r.detail).toBe(PHOTODNA_OFF_DETAIL);
    expect(r.detail).toBe('photodna_off');
    // Nothing was fetched and nothing was asked.
    expect(fake.hashedBytes).toEqual([]);
    expect(fake.matched).toEqual([]);
    // And no sender is stopped for a deployment's missing licence.
    expect(suspended.calls).toEqual([]);
  });
});
