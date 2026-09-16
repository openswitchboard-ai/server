/**
 * The one machine that looks at a picture (src/intake/checks/photoModeration.ts).
 *
 * What is asserted here, against a stood-in Rekognition and a stood-in S3:
 *
 *  - A CLEAN PHOTO PASSES, and the call it made was the cheap one: the object
 *    by reference, never bytes, at the confidence the check names.
 *  - EVERY LABEL ON THE LIST REFUSES, one test per label, with the same plain
 *    sentence and the same reason code each time — and a label that is only the
 *    PARENT of what came back refuses too.
 *  - A REFUSED OBJECT IS DELETED, in the same breath as the refusal.
 *  - AN ERROR IS A HOLD. Never a pass, never a refusal: the photo stays, the
 *    sender is told, and nothing is thrown away on a call that did not come back.
 *  - THE DOORS IT DOES NOT STAND AT: no bucket in this deployment, and the
 *    presign moment where there is no object yet, both pass without a call.
 *  - THE SENTENCES ARE PLAIN. No jargon of ours reaches the sender's assistant.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rekognition, s3 } from '../../src/aws.js';
import {
  PHOTO_BEING_LOOKED_AT,
  PHOTO_REFUSED,
  REFUSED_MODERATION_LABELS,
  MIN_CONFIDENCE,
  photoModeration,
} from '../../src/intake/checks/photoModeration.js';
import { runIntake } from '../../src/intake/pipe.js';
import type { IntakeItem } from '../../src/intake/types.js';
import type { Config } from '../../src/config.js';

const cfg = { photoBucket: 'osb-dev-photos', photoModeration: true } as unknown as Config;
const BUCKET = 'osb-dev-photos';
const KEY = 'conversation-photos/dev/ch_1/abc.jpg';

/** Whatever Rekognition is to answer next, or the error it is to throw. */
let answer: { labels?: any[]; throws?: Error };
/** Every Rekognition call, and every key S3 was asked to delete. */
let asked: any[];
let deleted: string[];

const item = (over: Partial<IntakeItem> = {}): IntakeItem => ({
  door: 'photo',
  sender_account: 'acct-1',
  match_id: 'm-1',
  fields: { metadata_removed: 'true' },
  object: { bucket: BUCKET, key: KEY, content_type: 'image/jpeg' },
  ...over,
});

beforeEach(() => {
  answer = { labels: [] };
  asked = [];
  deleted = [];
  vi.spyOn(rekognition, 'send').mockImplementation(async (command: any) => {
    asked.push(command.input);
    if (answer.throws) throw answer.throws;
    return { ModerationLabels: answer.labels ?? [] } as any;
  });
  vi.spyOn(s3, 'send').mockImplementation(async (command: any) => {
    if (command.constructor.name === 'DeleteObjectCommand') deleted.push(command.input.Key);
    return {} as any;
  });
});

describe('a photo nothing was found in', () => {
  it('passes, and was asked about by reference rather than by bytes', async () => {
    const r = await photoModeration.run(item(), cfg);
    expect(r.outcome).toBe('pass');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual({
      Image: { S3Object: { Bucket: BUCKET, Name: KEY } },
      MinConfidence: MIN_CONFIDENCE,
    });
    expect(asked[0].Image.Bytes).toBeUndefined();
    expect(deleted).toEqual([]);
  });

  it('passes on a label that is not on the list', async () => {
    answer = { labels: [{ Name: 'Alcohol', ParentName: '', TaxonomyLevel: 1, Confidence: 99 }] };
    const r = await photoModeration.run(item(), cfg);
    expect(r.outcome).toBe('pass');
  });
});

describe('every label on the list sends the photo back', () => {
  for (const label of REFUSED_MODERATION_LABELS) {
    it(`refuses ${label}`, async () => {
      answer = { labels: [{ Name: label, ParentName: '', TaxonomyLevel: 1, Confidence: 51 }] };
      const r = await photoModeration.run(item(), cfg);
      expect(r.outcome).toBe('refuse');
      expect(r.reason_code).toBe('sexual-or-prohibited-image');
      expect(r.plain_words).toBe(PHOTO_REFUSED);
    });
  }

  it('refuses a finer label whose parent is on the list', async () => {
    answer = {
      labels: [
        { Name: 'Exposed Male Genitalia', ParentName: 'Explicit', TaxonomyLevel: 2, Confidence: 88 },
      ],
    };
    const r = await photoModeration.run(item(), cfg);
    expect(r.outcome).toBe('refuse');
  });

  it('refuses at the lowest confidence the service will report', async () => {
    answer = { labels: [{ Name: 'Explicit Nudity', Confidence: MIN_CONFIDENCE }] };
    expect((await photoModeration.run(item(), cfg)).outcome).toBe('refuse');
  });

  it('deletes the object it refused, and keeps nothing but the reason code', async () => {
    answer = { labels: [{ Name: 'Explicit', ParentName: '', TaxonomyLevel: 1 }] };
    const r = await photoModeration.run(item(), cfg);
    expect(deleted).toEqual([KEY]);
    // Nothing about the picture travels back with the refusal: no label, no key.
    expect(JSON.stringify(r)).not.toMatch(/Explicit|abc\.jpg/);
    expect(r.detail).toBeUndefined();
  });
});

describe('a look that could not be made', () => {
  it('holds rather than passing, and throws nothing away', async () => {
    answer = { throws: Object.assign(new Error('unreachable'), { name: 'TimeoutError' }) };
    const r = await photoModeration.run(item(), cfg);
    expect(r.outcome).toBe('hold');
    expect(r.reason_code).toBe('photo-moderation-unavailable');
    expect(r.plain_words).toBe(PHOTO_BEING_LOOKED_AT);
    expect(deleted).toEqual([]);
  });

  it('holds through the pipe as well, so nothing is delivered on an error', async () => {
    answer = { throws: new Error('unreachable') };
    const v = await runIntake(cfg, item());
    expect(v.outcome).toBe('hold');
    expect(v.plain_words).toBe(PHOTO_BEING_LOOKED_AT);
  });
});

describe('where it does not stand', () => {
  it('passes without a call where photos are off in this deployment', async () => {
    const r = await photoModeration.run(item(), { photoModeration: false } as unknown as Config);
    expect(r.outcome).toBe('pass');
    expect(asked).toEqual([]);
  });

  it('passes without a call at the presign door, where there is no object yet', async () => {
    const r = await photoModeration.run(item({ object: undefined }), cfg);
    expect(r.outcome).toBe('pass');
    expect(asked).toEqual([]);
  });

  it('stands at the photo door and nowhere else', () => {
    expect(photoModeration.doors).toEqual(['photo']);
  });
});

describe('the sentences a sender reads', () => {
  /** The words no sentence written for a human may ever carry. */
  const BANNED = ['card', 'channel', 'match', 'stage', 'WANT', 'HAVE', 'connection', 'score'];
  for (const sentence of [PHOTO_REFUSED, PHOTO_BEING_LOOKED_AT]) {
    it(`is plain: "${sentence.slice(0, 32)}..."`, () => {
      for (const word of BANNED) {
        expect(sentence.toLowerCase()).not.toContain(word.toLowerCase());
      }
    });
  }
});
