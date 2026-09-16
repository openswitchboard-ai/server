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
 * labels, not the key, not the caption. The row behind it is left unsent for the
 * sweep.
 *
 * AND WHAT HAPPENS TO THE BYTES DEPENDS ON WHICH FAMILY REFUSED THEM. A photo
 * refused for violence, hate or drugs is deleted in the same breath, as it
 * always was: the switchboard has no reason to keep it. A photo refused for
 * anything on the SEXUAL list is NOT deleted — it is moved to a quarantine
 * prefix (src/safety/photoQuarantine.ts). Rekognition says "Explicit"; it does
 * not say "a child", and it cannot. Under s 474.25 of the Criminal Code (Cth) a
 * host that becomes aware of child abuse material must refer it to the
 * Australian Federal Police, and a delete on sight destroys the referrable
 * thing fastest in exactly the cases where that is worst. A person decides
 * afterwards; the machine only holds.
 *
 * THE SENDER READS THE SAME SENTENCE EITHER WAY. Nothing about quarantine
 * reaches any user, on either side. There is one refusal here, not two.
 */
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { DetectModerationLabelsCommand } from '@aws-sdk/client-rekognition';
import { rekognition, s3 } from '../../aws.js';
import { quarantinePhoto } from '../../safety/photoQuarantine.js';
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
 *
 * THE LIST IS IN TWO HALVES, AND THE HALVES ARE NOT A MATTER OF DEGREE. They
 * decide what happens to the bytes: the sexual half is quarantined, everything
 * else is deleted. See the note at the top of this file and s 474.25.
 */
export const SEXUAL_LABELS: readonly string[] = [
  // Sexual and nude, in every name the taxonomy has used for it.
  'Explicit',
  'Explicit Nudity',
  'Non-Explicit Nudity of Intimate parts and Kissing',
  'Suggestive',
  'Sexual Activity',
  'Swimwear or Underwear',
];

/** The rest: refused just as hard, and deleted on refusal as they always were. */
export const OTHER_REFUSED_LABELS: readonly string[] = [
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

/** Everything that sends a photo back, for the callers that want the whole list. */
export const REFUSED_MODERATION_LABELS: readonly string[] = [
  ...SEXUAL_LABELS,
  ...OTHER_REFUSED_LABELS,
];

const SEXUAL = new Set(SEXUAL_LABELS.map((l) => l.toLowerCase()));
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

/**
 * Which names on the list this answer hit, canonicalised to the list's own
 * spelling. The quarantine row wants them (an operator deciding what to do
 * needs to know what fired); the refusal itself still carries none of them.
 */
export function matchedLabels(
  labels: { Name?: string; ParentName?: string }[],
): string[] {
  const out = new Set<string>();
  for (const l of labels) {
    for (const candidate of [l.Name, l.ParentName]) {
      const lower = String(candidate ?? '').toLowerCase();
      if (!lower || !REFUSED.has(lower)) continue;
      out.add(REFUSED_MODERATION_LABELS.find((n) => n.toLowerCase() === lower)!);
    }
  }
  return [...out];
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
    const hits = matchedLabels(labels);
    if (!hits.length) return passed('photoModeration');

    // THE FORK. Anything sexual is held; everything else goes, as before.
    if (hits.some((l) => SEXUAL.has(l.toLowerCase()))) {
      await quarantinePhoto({
        bucket,
        key,
        match_id: item.match_id,
        sender_account: item.sender_account,
        labels: hits,
      });
    } else {
      await forget(bucket, key);
    }
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
