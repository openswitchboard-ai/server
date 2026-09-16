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
 *  - A REFUSED OBJECT IS DELETED, in the same breath as the refusal — unless
 *    the label that refused it was a SEXUAL one, in which case it is COPIED to
 *    the quarantine prefix first, the original deleted after, and a row
 *    written: s 474.25 says what must be referred must still exist. A copy that
 *    fails leaves the original alone and says so.
 *  - AN ERROR IS A HOLD. Never a pass, never a refusal: the photo stays, the
 *    sender is told, and nothing is thrown away on a call that did not come back.
 *  - THE DOORS IT DOES NOT STAND AT: no bucket in this deployment, and the
 *    presign moment where there is no object yet, both pass without a call.
 *  - THE SENTENCES ARE PLAIN. No jargon of ours reaches the sender's assistant.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rekognition, s3 } from '../../src/aws.js';
import * as db from '../../src/db.js';
import {
  OTHER_REFUSED_LABELS,
  PHOTO_BEING_LOOKED_AT,
  PHOTO_REFUSED,
  REFUSED_MODERATION_LABELS,
  SEXUAL_LABELS,
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
/** Every copy S3 was asked to make, and whether the next one is to fail. */
let copied: Array<{ from: string; to: string }>;
let copyThrows: Error | undefined;
/** Every row the quarantine table was asked to take, and every operator line. */
let rows: unknown[][];
let logged: string[];

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
  copied = [];
  copyThrows = undefined;
  rows = [];
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(String(line)));
  vi.spyOn(rekognition, 'send').mockImplementation(async (command: any) => {
    asked.push(command.input);
    if (answer.throws) throw answer.throws;
    return { ModerationLabels: answer.labels ?? [] } as any;
  });
  vi.spyOn(s3, 'send').mockImplementation(async (command: any) => {
    if (command.constructor.name === 'DeleteObjectCommand') deleted.push(command.input.Key);
    if (command.constructor.name === 'CopyObjectCommand') {
      if (copyThrows) throw copyThrows;
      copied.push({ from: command.input.CopySource, to: command.input.Key });
    }
    return {} as any;
  });
  vi.spyOn(db, 'getPool').mockReturnValue({
    query: async (_sql: string, params: unknown[] = []) => {
      rows.push(params);
      return { rows: [], rowCount: 1 };
    },
  } as any);
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

  it('deletes the object it refused for a non-sexual label, as it always did', async () => {
    answer = { labels: [{ Name: 'Hate Symbols', ParentName: '', TaxonomyLevel: 1 }] };
    const r = await photoModeration.run(item(), cfg);
    expect(copied).toEqual([]);
    expect(deleted).toEqual([KEY]);
    expect(rows).toEqual([]);
    // Nothing about the picture travels back with the refusal: no label, no key.
    expect(JSON.stringify(r)).not.toMatch(/Hate|abc\.jpg/);
    expect(r.detail).toBeUndefined();
  });

  it('keeps nothing but the reason code on a sexual label either', async () => {
    answer = { labels: [{ Name: 'Explicit', ParentName: '', TaxonomyLevel: 1 }] };
    const r = await photoModeration.run(item(), cfg);
    expect(r.plain_words).toBe(PHOTO_REFUSED);
    expect(JSON.stringify(r)).not.toMatch(/Explicit|abc\.jpg|quarantine/i);
    expect(r.detail).toBeUndefined();
  });

  it('every non-sexual label deletes, and every sexual one does not', async () => {
    for (const label of OTHER_REFUSED_LABELS) {
      copied = [];
      deleted = [];
      answer = { labels: [{ Name: label, TaxonomyLevel: 1 }] };
      await photoModeration.run(item(), cfg);
      expect(copied, label).toEqual([]);
      expect(deleted, label).toEqual([KEY]);
    }
    for (const label of SEXUAL_LABELS) {
      copied = [];
      deleted = [];
      answer = { labels: [{ Name: label, TaxonomyLevel: 1 }] };
      await photoModeration.run(item(), cfg);
      expect(copied, label).toHaveLength(1);
      // The original still goes — it goes AFTER the copy, not instead of it.
      expect(deleted, label).toEqual([KEY]);
    }
  });

  it('the two halves are the whole list, and nothing is in both', () => {
    expect([...SEXUAL_LABELS, ...OTHER_REFUSED_LABELS]).toEqual([...REFUSED_MODERATION_LABELS]);
    expect(SEXUAL_LABELS.filter((l) => OTHER_REFUSED_LABELS.includes(l))).toEqual([]);
  });
});

/**
 * THE POINT OF THE WHOLE CHANGE. Rekognition cannot tell an adult from a child,
 * and s 474.25 says a host that becomes aware of child abuse material must refer
 * it to the AFP. A delete on sight destroys what must be referred.
 */
describe('a photo refused for something sexual is held, not destroyed', () => {
  beforeEach(() => {
    answer = { labels: [{ Name: 'Explicit', ParentName: '', TaxonomyLevel: 1, Confidence: 99 }] };
  });

  it('copies to the quarantine prefix first, then deletes the original', async () => {
    const r = await photoModeration.run(item(), cfg);
    expect(r.outcome).toBe('refuse');
    expect(copied).toEqual([
      { from: `${BUCKET}/${KEY}`, to: 'conversation-photos/quarantine/m-1/abc.jpg' },
    ]);
    expect(deleted).toEqual([KEY]);
  });

  it('writes a row saying where the bytes went and which labels fired', async () => {
    await photoModeration.run(item(), cfg);
    expect(rows).toHaveLength(1);
    const params = rows[0];
    expect(params).toContain(BUCKET);
    expect(params).toContain('conversation-photos/quarantine/m-1/abc.jpg');
    expect(params).toContainEqual(['Explicit']);
    expect(params).toContain('90');
  });

  it('gives the operator two ids and nothing about the picture', async () => {
    await photoModeration.run(item(), cfg);
    const line = logged.find((l) => l.includes('photo-quarantined'));
    expect(line).toBeTruthy();
    const parsed = JSON.parse(line!);
    expect(parsed.event).toBe('photo-quarantined');
    expect(parsed.match_id).toBe('m-1');
    expect(typeof parsed.quarantine_id).toBe('string');
    expect(Object.keys(parsed).sort()).toEqual(['event', 'match_id', 'quarantine_id']);
    expect(logged.join('\n')).not.toMatch(/abc\.jpg|Explicit/);
  });

  it('refuses a finer sexual label through its parent, and holds that too', async () => {
    answer = {
      labels: [
        { Name: 'Exposed Male Genitalia', ParentName: 'Explicit', TaxonomyLevel: 2, Confidence: 88 },
      ],
    };
    await photoModeration.run(item(), cfg);
    expect(copied).toHaveLength(1);
    // The row carries the list's own name, not the finer one Rekognition used.
    expect(rows[0]).toContainEqual(['Explicit']);
  });

  it('NEVER deletes what it could not copy', async () => {
    copyThrows = new Error('AccessDenied');
    const r = await photoModeration.run(item(), cfg);
    expect(r.outcome).toBe('refuse');
    expect(r.plain_words).toBe(PHOTO_REFUSED);
    // The original is exactly where it was, and no row claims otherwise.
    expect(deleted).toEqual([]);
    expect(rows).toEqual([]);
    const line = logged.find((l) => l.includes('photo-quarantine-failed'));
    expect(JSON.parse(line!)).toEqual({ event: 'photo-quarantine-failed', match_id: 'm-1' });
  });

  it('a database that will not take the row still leaves the bytes held', async () => {
    vi.spyOn(db, 'getPool').mockImplementation(() => {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    });
    const r = await photoModeration.run(item(), cfg);
    expect(r.outcome).toBe('refuse');
    expect(copied).toHaveLength(1);
    expect(logged.join('\n')).toContain('photo-quarantine-row-failed');
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
