/**
 * THE HIDDEN DETAILS COME OUT OF EVERY PHOTO BEFORE IT CROSSES
 * (domain/channelPhoto.ts holds the long account).
 *
 * Two moments, and only the second one is a guarantee:
 *
 *  - AT PRESIGN, the sender's browser says it stripped the file
 *    (counter/photoScrub.ts). That is a boolean anybody can send, so it is a
 *    HINT: a page that says it could not strip is refused early, before an
 *    upload link exists, and a page that says it did proves nothing.
 *
 *  - AT SEND, the server has read the object, re-encoded it with nothing but
 *    its pixels, and written it back (stripPhotoInPlace). The item carries an
 *    `object` at this step, and the gate passes only on the server's own
 *    record that it did that — `metadata_stripped_by_server`, set by
 *    markPhotoSent and never by anything a request carries. The browser's
 *    claim counts for nothing here (2026-09-28 review: it used to be the whole
 *    of the check).
 */
import { passed, type Check } from '../types.js';

/** The sentence the person at the keyboard reads. Unchanged since 16 Sep 2026. */
export const METADATA_NOT_REMOVED =
  'this page could not take the hidden details out of the picture, so nothing was uploaded. Open the link again in a browser that runs scripts.';

/** The send step found no record of the server's own strip. */
export const METADATA_NOT_STRIPPED_BY_SERVER =
  'the hidden details could not be taken out of that picture, so it has not gone. Try sending it again.';

export const photoMetadata: Check = {
  name: 'photoMetadata',
  doors: ['photo'],
  async run(item) {
    if (item.object) {
      if (item.fields?.metadata_stripped_by_server === 'true') return passed('photoMetadata');
      return {
        name: 'photoMetadata',
        outcome: 'refuse',
        reason_code: 'metadata-not-stripped-by-server',
        plain_words: METADATA_NOT_STRIPPED_BY_SERVER,
      };
    }
    if (item.fields?.metadata_removed === 'true') return passed('photoMetadata');
    return {
      name: 'photoMetadata',
      outcome: 'refuse',
      reason_code: 'metadata-not-removed',
      plain_words: METADATA_NOT_REMOVED,
    };
  },
};
