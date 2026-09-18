/**
 * IS THIS PICTURE ONE THAT HAS ALREADY BEEN FOUND?
 * (src/safety/photodna.ts; docs/trust-and-safety.md, "A known-image match").
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
 * photo refused by Rekognition first would never have been hashed at all.
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
 *              the matching service's tracking id, which is what a referral
 *              quotes.
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
 * BEING SWITCHED OFF IS NOT AN ERROR, AND IT PASSES. A deployment without the
 * licensed files or without a subscription key has no hash matching at all,
 * and holding every photo in that state would mean no deployment could carry a
 * photo until somebody at Microsoft had answered an email. It passes with a
 * detail saying so, the pipe carries on, and Rekognition still screens every
 * picture. Photos are dev-only today, which is what makes that trade
 * acceptable; an operator who wants the opposite in prod changes the one
 * branch below, and the boot line says which deployments are in that state.
 *
 * WHAT IS WRITTEN DOWN: the reason code, and the tracking id on the review
 * row. NEVER THE HASH. A hash is a handle on one specific picture, a log line
 * is the one thing in this system that is read casually, and there is nothing
 * an operator does with a hash that the tracking id does not do better.
 */
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../../aws.js';
import { edgeHashes, matchHashes, photoDnaAvailable } from '../../safety/photodna.js';
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

/** The detail that says this deployment has no hash matching in it. */
export const PHOTODNA_OFF_DETAIL = 'photodna_off';

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
    if (!(await photoDnaAvailable(cfg))) {
      return passed('photoHashMatch', { detail: PHOTODNA_OFF_DETAIL });
    }
    const { bucket, key } = item.object;

    let outcome: Awaited<ReturnType<typeof matchHashes>>;
    try {
      const bytes = await fetchBytes(bucket, key);
      // One or two, because the picture is hashed with its border taken off as
      // well: a cropped or letterboxed copy of a known image is exactly what a
      // single hash would miss.
      outcome = await matchHashes(await edgeHashes(bytes, cfg), cfg);
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

    if (!outcome.match) return passed('photoHashMatch');

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
        tracking_id: outcome.trackingId,
      });
    } catch {
      /* the refusal stands; the quarantine row is still there to be found */
    }
    try {
      await suspendAccount(item.sender_account, KNOWN_ABUSE_IMAGE_SUSPENSION, cfg);
    } catch {
      /* the refusal stands; an operator suspends by hand from the review */
    }

    // The reason code and nothing else: no hash, no source, no key.
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
