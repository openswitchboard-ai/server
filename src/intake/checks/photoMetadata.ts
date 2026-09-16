/**
 * NO UPLOAD LINK FOR A PAGE THAT CANNOT CLEAN THE FILE (domain/channelPhoto.ts
 * holds the long account of why). The hidden details come out of a picture in
 * the sender's own browser, because that is the only place the bytes exist
 * that is not this service. The browser then says it did it, and this refuses
 * anything that does not say so — a claim this service cannot check without
 * holding the image, which is the one thing it must never do.
 *
 * What it buys: a page too old or too plain to strip is refused here instead of
 * quietly uploading a photo with the coordinates of a house in it.
 */
import { passed, type Check } from '../types.js';

/** The sentence the person at the keyboard reads. Unchanged since 16 Sep 2026. */
export const METADATA_NOT_REMOVED =
  'this page could not take the hidden details out of the picture, so nothing was uploaded. Open the link again in a browser that runs scripts.';

export const photoMetadata: Check = {
  name: 'photoMetadata',
  doors: ['photo'],
  async run(item) {
    if (item.fields?.metadata_removed === 'true') return passed('photoMetadata');
    return {
      name: 'photoMetadata',
      outcome: 'refuse',
      reason_code: 'metadata-not-removed',
      plain_words: METADATA_NOT_REMOVED,
    };
  },
};
