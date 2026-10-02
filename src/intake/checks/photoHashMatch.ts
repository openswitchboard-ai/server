/**
 * IS THIS PICTURE ONE THAT HAS ALREADY BEEN FOUND?
 * (src/safety/knownImageCheck.ts; docs/trust-and-safety.md, "A known-image match").
 *
 * OpenSwitchboard uses PhotoDNA technology licensed by Microsoft at no cost.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE CHECK AFTER IT. photoModeration.ts asks a
 * machine what a picture appears to be, and the answer is a category at a
 * confidence. This asks whether the picture is a specific one that has already
 * been found, identified and hashed by the organisations that do that work.
 * The first is an opinion; the second is an identification. They are not two
 * strengths of the same thing, and almost everything below follows from that.
 *
 * SO IT RUNS FIRST, at the same door and the same moment: the send press, once
 * the bytes have landed and before the other side has been told there is
 * anything to fetch. Running it ahead of the moderation call is not about
 * cost. It is that a match must not depend on a second machine's opinion, and a
 * photo refused by Rekognition first would never have been checked at all.
 *
 * WHAT A MATCH DOES, in one act:
 *
 *   REFUSE     the photo does not go, with the SAME sentence the sexual-label
 *              refusal uses. Word for word, deliberately. There is one refusal
 *              at this door, not two, and a sender who could tell the
 *              difference would be a sender who had been told they were
 *              matched — which is a thing to tell police, not the person
 *              holding the picture.
 *   QUARANTINE the bytes move rather than die, exactly as they do for the
 *              sexual family and for the same reason in law, with the row
 *              marked as a hash match so the queue can tell the two apart.
 *   REVIEW     a safety review is opened, flagged known_abuse_image, carrying
 *              the answer's reference, which is what a referral quotes.
 *   SUSPEND    the sender's account is stopped: every door shut, every posting
 *              down, every open conversation severed, every credential pulled
 *              back. This is the one check on this switchboard that suspends
 *              on its own. A model's opinion about a message never should;
 *              an identified image is not an opinion.
 *
 * AND THE PERSON ON THE OTHER SIDE IS TOLD NOTHING, because they were never
 * told there was a photo.
 *
 * AN ERROR IS A HOLD, NEVER A PASS — the same rule as the check after it. A
 * call that did not come back has not said the picture is unknown.
 *
 * BEING SWITCHED OFF IS NOT AN ERROR, AND IT PASSES. A deployment with no
 * secret configured has no known-image check at all (a checkout without a
 * module), and it passes with a detail saying so; the pipe carries on and
 * Rekognition still screens every picture.
 *
 * BUT A DEPLOYMENT THAT IS MEANT TO MATCH AND CANNOT HOLDS (2026-09-28
 * review). Where the secret IS configured and the module did not come up,
 * this used to pass every photo as "off" for the life of the process. Now it
 * holds, with PHOTOS_PAUSED, and the loader tries again a minute later
 * (safety/knownImageCheck.ts, knownImageState).
 *
 * WHAT IS WRITTEN DOWN: the reason code, and the answer's reference on the
 * review row. NOTHING THAT IDENTIFIES THE PICTURE. A log line is the one
 * thing in this system that is read casually, and there is nothing an
 * operator needs that the reference does not give.
 */
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../../aws.js';
import { checkKnownImage, knownImageState, type KnownImageOutcome } from '../../safety/knownImageCheck.js';
import { quarantinePhoto } from '../../safety/photoQuarantine.js';
import { KNOWN_ABUSE_IMAGE_FLAG, openKnownImageReview } from '../../safety/reviews.js';
import { suspendAccount } from '../../safety/suspend.js';
import { PHOTO_BEING_LOOKED_AT, PHOTO_REFUSED } from './photoModeration.js';
import { passed, type Check, type CheckResult } from '../types.js';

/**
 * The reason code a match refuses under. It is on the ledger entry and in the
 * operator's line, and it is the one code in this system that means a person
 * has to do something today.
 */
export const KNOWN_ABUSE_IMAGE_REASON = 'KNOWN_ABUSE_IMAGE';

/** The reason the account is stopped, on the account row. */
export const KNOWN_ABUSE_IMAGE_SUSPENSION = 'known_abuse_image';

/** The detail that says this deployment has no known-image check in it. */
export const KNOWN_IMAGE_OFF_DETAIL = 'known_image_off';

/** The reason code a photo holds under while the check is meant to be on and
 *  is not up yet. */
export const KNOWN_IMAGE_NOT_LOADED = 'known-image-not-loaded';

/** The sentence a sender reads while the check is meant to be on and is not
 *  up yet. */
export const PHOTOS_PAUSED = 'photos are paused for a moment; try again shortly.';

/** Counts and codes only, the same rule every other line in this service follows. */
function hashLog(event: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/** The object's bytes. This is the one check that has to hold an image. */
async function fetchBytes(bucket: string, key: string): Promise<Uint8Array> {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = r.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) throw new Error('the object had no body');
  return body.transformToByteArray();
}

export const photoHashMatch: Check = {
  name: 'photoHashMatch',
  doors: ['photo'],
  async run(item, cfg): Promise<CheckResult> {
    // Nothing to look at at the presign door, where no object exists yet, and
    // nothing at all in a deployment that carries no photos.
    if (!cfg?.photoModeration || !item.object) return passed('photoHashMatch');
    const state = await knownImageState(cfg);
    if (state === 'off') {
      return passed('photoHashMatch', { detail: KNOWN_IMAGE_OFF_DETAIL });
    }
    if (state === 'unavailable') {
      hashLog('photo-hash-match-unavailable', {
        reason_code: KNOWN_IMAGE_NOT_LOADED,
      });
      return {
        name: 'photoHashMatch',
        outcome: 'hold',
        reason_code: KNOWN_IMAGE_NOT_LOADED,
        plain_words: PHOTOS_PAUSED,
      };
    }

    const { bucket, key } = item.object;

    let outcome: KnownImageOutcome;
    try {
      outcome = await checkKnownImage(await fetchBytes(bucket, key), cfg);
    } catch (e: any) {
      // NEVER A PASS. No detail from the error beyond its name: the messages
      // on this path can carry a key or an object key.
      hashLog('photo-hash-match-unavailable', {
        reason_code: 'photo-hash-match-unavailable',
        detail: e?.name ? String(e.name) : 'the call did not come back',
      });
      return {
        name: 'photoHashMatch',
        outcome: 'hold',
        reason_code: 'photo-hash-match-unavailable',
        plain_words: PHOTO_BEING_LOOKED_AT,
        error: e,
      };
    }

    if (!outcome.matched) return passed('photoHashMatch');

    // THE THREE ACTS BEHIND THE REFUSAL. None of them may stop it: the verdict
    // is already reached, and a database that will not take a row is not a
    // reason to carry a known abuse image to another person.
    try {
      await quarantinePhoto({
        bucket,
        key,
        match_id: item.match_id,
        sender_account: item.sender_account,
        labels: [],
        hash_match: true,
        hash_sources: outcome.sources,
      });
    } catch {
      /* the refusal stands; the sweep will come past */
    }
    try {
      await openKnownImageReview({
        match_id: item.match_id,
        sender_account: item.sender_account,
        tracking_id: outcome.ref,
      });
    } catch {
      /* the refusal stands; the quarantine row is still there to be found */
    }
    try {
      await suspendAccount(item.sender_account, KNOWN_ABUSE_IMAGE_SUSPENSION, cfg);
    } catch {
      /* the refusal stands; an operator suspends by hand from the review */
    }

    // The reason code and nothing else: no source, no reference, no key.
    hashLog('photo-refused', { reason_code: KNOWN_ABUSE_IMAGE_REASON });
    return {
      name: 'photoHashMatch',
      outcome: 'refuse',
      reason_code: KNOWN_ABUSE_IMAGE_REASON,
      // The detail is internal and never reaches a sender. It is the flag the
      // review carries, so the two line up when a person reads both.
      detail: KNOWN_ABUSE_IMAGE_FLAG,
      // THE SAME SENTENCE THE OTHER REFUSAL USES. See the note at the top.
      plain_words: PHOTO_REFUSED,
    };
  },
};
