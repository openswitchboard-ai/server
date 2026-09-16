/**
 * THE SWITCHBOARD LOOKS AT THE PICTURE BEFORE THE OTHER PERSON CAN
 * (docs/trust-and-safety.md, step four of the build sequence).
 *
 * Until now the honest statement in domain/channelPhoto.ts was that no machine
 * looked at an image at all. This is what changes it, and it changes only that:
 * Amazon Rekognition's DetectModerationLabels is asked about the object that
 * already sits in the photo bucket, by reference, at the SEND step — after the
 * bytes have landed, before the other side is ever told there is anything to
 * fetch. The service still never holds an image: it hands S3 a bucket and a key
 * and gets back label names.
 *
 * WHERE IT SITS IN THE PHOTO'S LIFE. The EXIF gate (photoMetadata.ts) runs at
 * presign, because a page that cannot strip a file should never get a URL. This
 * one cannot run there — there is nothing to look at until the browser's PUT has
 * happened — so it runs at the press that would deliver it. Both are the photo
 * door; the difference is whether `object` is set on the item.
 *
 * THE THRESHOLD IS "ANY LABEL ON THE LIST", NOT "PROBABLY ILLEGAL". A photo
 * here exists to show the thing itself: a bike, a ladder, a scratch on a down
 * tube. There is no legitimate sexual image on this switchboard, so nothing
 * sexual or nude passes at any confidence the service will report, and neither
 * does violence, a hate symbol or drugs. MinConfidence is 50, Rekognition's own
 * default, which is the strict end: a higher number would let more through.
 *
 * AN ERROR IS A HOLD, NEVER A PASS. A call that did not come back has not said
 * the photo is fine. The photo stays where it is, the sender is told it is being
 * looked at, and the line goes to the operator's log.
 *
 * WHAT IS WRITTEN DOWN ON A REFUSAL: the reason code, and nothing else. Not the
 * labels, not the key, not the caption. The object is deleted in the same breath
 * — the switchboard has no reason to keep a picture it has just refused, and the
 * row behind it is left unsent for the sweep.
 */
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { DetectModerationLabelsCommand } from '@aws-sdk/client-rekognition';
import { rekognition, s3 } from '../../aws.js';
import { passed, type Check, type CheckResult } from '../types.js';

/**
 * THE LABELS THAT SEND A PHOTO BACK. Top-level (taxonomy level 1) category
 * names from Rekognition's moderation taxonomy. BOTH GENERATIONS OF THE NAMES
 * ARE HERE on purpose: the newer taxonomy renamed several categories
 * ("Explicit Nudity" became "Explicit"; "Suggestive" was split into
 * "Non-Explicit Nudity of Intimate parts and Kissing" and "Swimwear or
 * Underwear"; "Drugs" and "Tobacco" were merged), and a list that carried only
 * one generation would silently stop refusing the day the service moved. An
 * unknown name costs nothing; a missing one costs everything.
 *
 * What is deliberately NOT here: Alcohol, Gambling and Rude Gestures. A bottle
 * of wine or a poker set is a thing somebody may lawfully be handing over, and
 * this check is not a taste filter.
 */
export const REFUSED_MODERATION_LABELS: readonly string[] = [
  // Sexual and nude, in every name the taxonomy has used for it.
  'Explicit',
  'Explicit Nudity',
  'Non-Explicit Nudity of Intimate parts and Kissing',
  'Suggestive',
  'Sexual Activity',
  'Swimwear or Underwear',
  // Violence and the images that go with it.
  'Violence',
  'Visually Disturbing',
  'Graphic Violence Or Gore',
  // Hate.
  'Hate Symbols',
  // Drugs, in both the split and the merged form.
  'Drugs & Tobacco',
  'Drugs',
  'Tobacco',
];

const REFUSED = new Set(REFUSED_MODERATION_LABELS.map((l) => l.toLowerCase()));

/** Rekognition's own default. Lower than this is not offered; higher lets more through. */
export const MIN_CONFIDENCE = 50;

/**
 * The sentence the sender's assistant reads when a photo is sent back. It says
 * what happened and what a photo is for, and it does not describe what was
 * seen — nobody needs their picture recited back at them.
 */
export const PHOTO_REFUSED =
  'that photo did not go through. A photo here is for showing the thing itself.';

/** And when the look could not be made. The photo is still there; it just has not gone. */
export const PHOTO_BEING_LOOKED_AT =
  'that photo is being looked at before it goes any further, so it has not gone yet. Try again shortly.';

/** Counts and codes only, the same rule every other line in this service follows. */
function moderationLog(event: string, fields: Record<string, string | number>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/**
 * A refused photo is deleted, not kept. Best-effort on purpose: a delete that
 * fails must not turn a refusal into something softer, and the sweep in
 * domain/channelPhoto.ts comes past for anything left behind.
 */
async function forget(bucket: string, key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    /* the refusal stands; the sweep will come past */
  }
}

export const photoModeration: Check = {
  name: 'photoModeration',
  doors: ['photo'],
  async run(item, cfg): Promise<CheckResult> {
    // Photos are off in a deployment without a bucket, and there is nothing to
    // look at at the presign door, where no object exists yet.
    if (!cfg?.photoModeration || !item.object) return passed('photoModeration');
    const { bucket, key } = item.object;

    let labels: { Name?: string; ParentName?: string; TaxonomyLevel?: number }[];
    try {
      const r = await rekognition.send(
        new DetectModerationLabelsCommand({
          Image: { S3Object: { Bucket: bucket, Name: key } },
          MinConfidence: MIN_CONFIDENCE,
        }),
      );
      labels = r.ModerationLabels ?? [];
    } catch (e: any) {
      // NEVER A PASS. The operator gets the line; the sender gets the sentence.
      moderationLog('photo-moderation-unavailable', {
        reason_code: 'photo-moderation-unavailable',
        detail: e?.name ? String(e.name) : 'the call did not come back',
      });
      return {
        name: 'photoModeration',
        outcome: 'hold',
        reason_code: 'photo-moderation-unavailable',
        plain_words: PHOTO_BEING_LOOKED_AT,
        error: e,
      };
    }

    // A top-level name, or the top-level parent of a finer one: Rekognition
    // returns the parent alongside the child, and reading both means a renamed
    // child under a known parent is still caught.
    const hit = labels.some(
      (l) =>
        REFUSED.has(String(l.Name ?? '').toLowerCase()) ||
        REFUSED.has(String(l.ParentName ?? '').toLowerCase()),
    );
    if (!hit) return passed('photoModeration');

    await forget(bucket, key);
    // The reason code and nothing else: no label, no key, no picture.
    moderationLog('photo-refused', { reason_code: 'sexual-or-prohibited-image' });
    return {
      name: 'photoModeration',
      outcome: 'refuse',
      reason_code: 'sexual-or-prohibited-image',
      plain_words: PHOTO_REFUSED,
    };
  },
};
