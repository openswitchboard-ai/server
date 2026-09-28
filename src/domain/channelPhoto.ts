/**
 * A photo on an open conversation: the one place an image crosses.
 *
 * WHY THIS EXISTS (the owner, 13 September 2026). Two people reach an agreed
 * price on a second-hand bike having never seen it. That is the one place this
 * switchboard is worse than the marketplace it replaces. What it will not do
 * is put images on the postings: a posting is public-ish and thin, and an image
 * carries a face, a number plate, a house. Inside the conversation both humans
 * have already pressed to be there, so that argument is spent, and the handling
 * is the handling a message already gets — held encrypted, handed over once,
 * and gone.
 *
 * THE AGENT CANNOT UPLOAD. Not "should not": there is no route on the agent
 * surface that takes bytes. The agent's whole part is to tell its human a photo
 * would help and hand them a link (domain/humanLinks.ts, photoLink), which is
 * the same one-question shape every other human step uses. The link is BOUND TO
 * THE CONVERSATION when it is minted — the person never picks a recipient on
 * the page, because a page that asks "which conversation?" is a page that can
 * be answered wrongly, and every other link here is bound the same way.
 *
 * THE BYTES DO NOT PASS THROUGH THIS SERVICE ON THE WAY IN OR OUT. A presigned
 * PUT carries them from the sender's own browser into the photo bucket,
 * encrypted there with the bucket's own key; a presigned GET carries them to
 * the other side's agent, reached through a short link on this service's own
 * host that signs it and redirects (collectPhotos, openPhotoLink). The server
 * signs URLs, keeps a row, and HEADs an object to check it landed. Two checks read the object once at the send
 * step, and only then: Rekognition by reference (intake/checks/
 * photoModeration.ts), and the known-image hash check, which fetches the
 * bytes into memory long enough to hash them and keeps neither the bytes nor
 * the hash (intake/checks/photoHashMatch.ts, since 18 September 2026).
 *
 * THE FILE IS STRIPPED BEFORE IT LEAVES THE DEVICE (16 September 2026). The
 * bytes never touching this service is also why this service cannot take the
 * GPS out of a photo, and a photo off a phone carries the coordinates of the
 * place it was taken. So the stripping happens in the one other place the bytes
 * exist: the sender's own browser, in counter/photoScrub.ts, which rebuilds the
 * file with every metadata block dropped, turns a sideways picture the right way
 * up first, and proves the result before an upload link is asked for. The
 * presign refuses anything that does not state it was stripped, which is a claim
 * the browser makes and this service cannot check — checking would mean holding
 * the image. What it buys is that a page that cannot strip gets no URL.
 *
 * AND THE SERVER STRIPS IT AGAIN, AND THAT IS THE ONE THAT COUNTS (28 September
 * 2026 review). The browser's claim is a boolean anybody can send, so it is now
 * a hint and nothing more. At the send press — after the upload, before any
 * check looks at the picture — the server reads the object once, re-encodes it
 * with sharp (upright, same format, and sharp writes no metadata unless asked
 * to), writes it back over the same key with the same type, and records on the
 * row that it did. The metadata gate at the send step passes only on that
 * record (intake/checks/photoMetadata.ts). A file sharp cannot decode, or one
 * whose bytes are not the type it was declared as, is refused in plain words.
 * The bytes are held in memory for the length of the re-encode and never
 * written anywhere else, which is the same footing the known-image hash check
 * already stands on.
 *

 * THE IMAGE IS SCREENED, BY MACHINE, BEFORE IT IS DELIVERED (17 September
 * 2026, docs/trust-and-safety.md step four). Until this date the honest
 * statement here was that nothing looked at an image at all. What looks at it
 * now is Rekognition, asked about the object in the bucket by reference at the
 * send press, and it refuses anything sexual, nude, violent, hateful or drugged
 * outright (intake/checks/photoModeration.ts holds the list and the reasoning).
 * Everything else about the statement stands: no person at the switchboard sees
 * it, the bytes still never pass through this process, the same two humans are
 * the only ones who can ever open it, and it deletes itself. The manual (versions
 * 49 and 50), the sender's page, the description the collecting agent reads and
 * the link text now say the same thing; docs/manual-inventory.md and
 * docs/release-readiness.md still describe the older sentence.
 *
 * WHAT IS CHECKED. A caption, and the filename that rides along with the
 * upload, are WORDS — so they go through carriesMoneyFigure exactly as a
 * message does (domain/moneyInWords.ts): a figure never travels in the words,
 * and "bike_450_firm.jpg" is the words. What a figure written on a whiteboard
 * inside the image says is not something this can detect, and it does not
 * pretend to.
 *
 * DELETE ON COLLECTION, honestly stated. A message row is deleted in the same
 * transaction that reads it, because the words are handed over inside the
 * answer. A photo is handed over as a LINK to the bytes, so bytes deleted at
 * that instant would be a dead link. The row is spent at collection instead —
 * collected once, never again, never re-fetchable — and the sweep deletes the
 * object and the row together once the handed-over link has run out. The bytes
 * outlive the collection by the life of one short link and no longer.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from '../aws.js';
import { getPool } from '../db.js';
import { decryptForChannel, encryptForChannel } from '../crypto.js';
import { OsbError } from '../protocol.js';
import { FIGURE_IN_WORDS_ACTION, carriesMoneyFigure } from './moneyInWords.js';
import { MESSAGE_TTL_DAYS, ensureChannelKey, loadOpenChannel } from './channel.js';
import { runIntake } from '../intake/pipe.js';
import type { Config } from '../config.js';

// ---------------------------------------------------------------------------
// THE NUMBERS, in one place, each one with the reason it is that number.
// ---------------------------------------------------------------------------

/**
 * The image types that cross, and the extension each one lands under. Three,
 * and the same three the settlement evidence vault takes, so there is one
 * answer in this codebase to "what is an image here".
 *
 * NO VIDEO, and nothing else either: the list is an allowlist, so a type that
 * is not on it is refused rather than guessed at. The `accept` attribute on the
 * page makes a phone hand over a JPEG when someone takes a picture on the spot.
 */
export const ALLOWED_PHOTO_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * 10 MB. A full-resolution photo off a modern phone is 3-6 MB, so this clears
 * the thing it is for with room to spare, and it stops a camera roll's worth of
 * raw being pushed through a link meant for one picture of a bike. It is SIGNED
 * INTO the presigned URL as well as checked here, so the browser cannot send a
 * byte more than it declared.
 */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * A caption is a line beside the picture — "the scratch on the down tube" —
 * rather than a second message channel, so it is short. Long enough for a
 * sentence, short enough that nobody mistakes it for somewhere to talk.
 */
export const MAX_CAPTION_CHARS = 200;

/**
 * How many sent-but-uncollected photos one person may have waiting on one
 * conversation. Every single one of them costs that human a press on their own
 * page, which is the real rate limit; this is the backstop that stops a
 * conversation being used as storage.
 */
export const MAX_WAITING_PHOTOS = 12;

/**
 * How many times one uploaded photo may be sent. See markPhotoSent: sending is
 * where the picture is screened, and a screen is a model call.
 */
export const MAX_SEND_ATTEMPTS = 3;

/** A photo waits exactly as long as a message does: the relay's own number. */
export const PHOTO_TTL_DAYS = MESSAGE_TTL_DAYS;

/** The upload link's life. The same ten minutes the evidence vault uses. */
export const UPLOAD_URL_TTL_S = 10 * 60;

/**
 * The collecting agent's link. Fifteen minutes — the life of every link a
 * human is handed here — which is long enough to render it or pass it on, and
 * short enough that a link copied out of an agent's context is dead by the time
 * anyone reads it back.
 */
export const VIEW_URL_TTL_S = 15 * 60;

/**
 * How long after a collection the bytes are swept. Exactly the life of the link
 * handed over, so nothing is deleted while the link still works and nothing
 * survives past it. The sweep runs on the existing expiry tick, so in practice
 * an object dies at the first tick after that — stated plainly rather than
 * dressed up as a guarantee of the minute.
 */
export const COLLECTED_GRACE_S = VIEW_URL_TTL_S;

function mustBucket(cfg: Config): string {
  if (!cfg.photoBucket) {
    throw new OsbError('NOT_UNLOCKED_YET', {
      human_action:
        'Photos are not switched on here yet. Say what the thing looks like in words for now.',
    });
  }
  return cfg.photoBucket;
}

/** Photos are off unless this deployment has a bucket to put them in. */
export function photosConfigured(cfg: Config): boolean {
  return !!cfg.photoBucket;
}

/**
 * Counts and ids only — never a key, never a caption, never a size that could
 * fingerprint one image. The same rule the relay's own log lines follow.
 */
function photoLog(event: string, fields: Record<string, string | number>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

const validation = (message: string) =>
  Object.assign(new Error(message), { validation: true });

/**
 * A caption, checked the way a message is checked. Returns the text to store,
 * or refuses. Empty is fine and common: most photos are the whole of what
 * somebody wanted to say.
 */
export function checkCaption(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  if (text.length > MAX_CAPTION_CHARS) {
    throw validation(`a line beside a photo can be up to ${MAX_CAPTION_CHARS} characters`);
  }
  // A FIGURE NEVER TRAVELS IN THE WORDS, and a caption is words.
  if (carriesMoneyFigure(text)) {
    throw new OsbError('CONSENT_REQUIRED', { human_action: FIGURE_IN_WORDS_ACTION });
  }
  return text;
}

/**
 * The filename rides along with the upload, and people write things in
 * filenames: "bike-450-firm.jpg" is a price in front of a stranger by another
 * road. Checked on the same rule, with the extension taken off first so that a
 * ".webp" or a "4.jpg" is not read as a decimal price.
 */
export function checkFilename(raw: unknown): void {
  const name = String(raw ?? '').trim();
  if (!name) return;
  const words = name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[_\-]+/g, ' ');
  if (carriesMoneyFigure(words)) {
    throw new OsbError('CONSENT_REQUIRED', { human_action: FIGURE_IN_WORDS_ACTION });
  }
}

/** The file could not be read as the picture it said it was. */
export const PHOTO_UNREADABLE =
  'that picture could not be opened as a JPEG, a PNG or a WebP, so it has not gone. Take it again, or save it as a JPEG and try once more.';

/** What landed is not what the upload link was signed for. */
export const PHOTO_NOT_AS_DECLARED =
  'what arrived is not the picture the upload link was made for, so it has not gone. Upload it again from the page.';

/** sharp's name for each allowed type. */
const SHARP_FORMAT: Record<string, 'jpeg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * THE SERVER'S OWN STRIP. Reads the object, re-encodes it with sharp — upright
 * first, because the orientation tag is one of the things that goes — in the
 * same format it was declared as, and writes it back over the same key with
 * the same content type. sharp copies no EXIF, XMP, ICC or IPTC into its
 * output unless withMetadata()/keepMetadata() is called, and neither is.
 *
 * Refuses, in plain words, bytes sharp cannot decode, bytes whose real format
 * is not the declared one, and anything over the cap on either side of the
 * re-encode. Returns the new size.
 *
 * Exported so the suite can drive it against real images.
 */
export async function stripPhotoInPlace(
  bucket: string,
  key: string,
  contentType: string,
): Promise<{ size_bytes: number }> {
  const format = SHARP_FORMAT[contentType];
  if (!format) throw validation(PHOTO_NOT_AS_DECLARED);
  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body: any = got.Body;
  if (!body?.transformToByteArray) throw validation(PHOTO_UNREADABLE);
  const input = Buffer.from(await body.transformToByteArray());
  if (!input.length || input.length > MAX_PHOTO_BYTES) throw validation(PHOTO_NOT_AS_DECLARED);
  const out = await reencodeWithoutMetadata(input, format);
  if (out.length > MAX_PHOTO_BYTES) {
    throw validation(
      `a photo has to be ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))} MB or smaller`,
    );
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: out,
      ContentType: contentType,
      ContentLength: out.length,
    }),
  );
  return { size_bytes: out.length };
}

/**
 * The re-encode alone, on bytes in memory: decode, turn upright, encode in the
 * declared format with nothing but the pixels. Refuses bytes that are not the
 * format they claim.
 */
export async function reencodeWithoutMetadata(
  input: Buffer,
  format: 'jpeg' | 'png' | 'webp',
): Promise<Buffer> {
  // Imported here for the reason photodna.ts gives: a native module that a
  // process which never sees a photo should not pay to open.
  const { default: sharp } = await import('sharp');
  let actual: string | undefined;
  try {
    actual = (await sharp(input).metadata()).format;
  } catch {
    throw validation(PHOTO_UNREADABLE);
  }
  if (actual !== format) throw validation(PHOTO_NOT_AS_DECLARED);
  try {
    const upright = sharp(input).rotate();
    const encoded =
      format === 'jpeg'
        ? upright.jpeg({ quality: 90, mozjpeg: true })
        : format === 'png'
          ? upright.png({ compressionLevel: 9 })
          : upright.webp({ quality: 90 });
    return await encoded.toBuffer();
  } catch {
    throw validation(PHOTO_UNREADABLE);
  }
}

export interface PresignedPhoto {
  photo_id: string;
  url: string;
  key: string;
}

/**
 * Presign one upload, for one photo, on one conversation.
 *
 * Everything is checked HERE, before a URL exists: the caller is a party to an
 * open conversation, the type is on the list, the size is inside the cap, the
 * caption and the filename carry no figure, and this sender is not already
 * holding a pile of uncollected photos. The row is written pending — `sent_at`
 * null — so bytes that land and are never sent are nothing to anybody and the
 * sweep clears them.
 */
export async function presignPhotoUpload(
  cfg: Config,
  accountId: string,
  matchId: string,
  input: {
    filename?: string;
    content_type: string;
    size: number;
    sha256_b64: string;
    metadata_removed?: unknown;
  },
): Promise<PresignedPhoto> {
  const bucket = mustBucket(cfg);
  // NO URL FOR A PAGE THAT CANNOT CLEAN THE FILE. The stripping happens in the
  // sender's browser (counter/photoScrub.ts) because that is the only place the
  // bytes exist that is not this service, and the shipped page can only say this
  // after its own second pass came back with nothing left to remove. The check
  // itself, and the long account of why the server cannot make the claim for
  // the browser, are in intake/checks/photoMetadata.ts — everything a person
  // hands over is asked of the one pipe (docs/trust-and-safety.md). The claim
  // arrives as a string at the door because a claim is all it is.
  const intake = await runIntake(cfg, {
    door: 'photo',
    sender_account: accountId,
    match_id: matchId,
    fields: { metadata_removed: String(input.metadata_removed === true) },
  });
  if (intake.outcome === 'refuse') {
    throw validation(intake.plain_words!);
  }
  const ext = ALLOWED_PHOTO_TYPES[String(input.content_type)];
  if (!ext) {
    throw validation('a photo here is a JPEG, a PNG or a WebP. Nothing else crosses, and no video.');
  }
  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_PHOTO_BYTES) {
    throw validation(
      `a photo has to be ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))} MB or smaller`,
    );
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(String(input.sha256_b64 ?? ''))) {
    throw validation('each upload carries its SHA-256, base64-encoded');
  }
  checkFilename(input.filename);

  const ch = await loadOpenChannel(matchId, accountId);
  // What counts against the cap: photos waiting to be picked up, AND photos
  // presigned and never sent. The second half is what stops a script on the
  // page signing URL after URL for bytes nobody will ever collect — one link is
  // one send, but the presign behind it is a fetch.
  //
  // AN HOUR IS NOT A BOUND (2026-09-17 audit). The unsent half used to count
  // only the last hour, which made the cap a cap on an hour rather than on
  // anything: a script pausing between bursts presigned for ever and left an
  // unbounded tail of rows behind it, each one a row in the table and a signed
  // PUT into the bucket. An unsent row is an unsent row however old it is, and
  // the sweep is what clears them.
  const waiting = await getPool().query(
    `SELECT count(*)::int AS n FROM conversation_photos
      WHERE channel_id = $1 AND sender_account = $2
        AND ((sent_at IS NOT NULL AND collected_at IS NULL)
          OR sent_at IS NULL)`,
    [ch.channelId, accountId],
  );
  if (waiting.rows[0].n >= MAX_WAITING_PHOTOS) {
    throw validation(
      `there are already ${MAX_WAITING_PHOTOS} photos waiting to be picked up on this one. They go as soon as the other side looks.`,
    );
  }

  const key = `conversation-photos/${cfg.envName}/${ch.channelId}/${randomUUID()}.${ext}`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: String(input.content_type),
      ContentLength: size, // signed: the browser cannot send a different size
      ChecksumSHA256: String(input.sha256_b64), // signed: nor different bytes
    }),
    {
      expiresIn: UPLOAD_URL_TTL_S,
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      // Signed, so S3 refuses a PUT whose type is not the allow-listed one
      // (2026-09-28 review). The send / manifest step checks it again on the
      // stored object, and every GET overrides it from the row regardless.
      signableHeaders: new Set(['content-type']),
    },
  );
  const r = await getPool().query(
    `INSERT INTO conversation_photos
       (channel_id, match_id, sender_account, recipient_account, s3_key, content_type,
        size_bytes, sha256, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' days')::interval)
     RETURNING id`,
    [
      ch.channelId,
      matchId,
      accountId,
      ch.counterpartyAccount,
      key,
      String(input.content_type),
      size,
      String(input.sha256_b64),
      String(PHOTO_TTL_DAYS),
    ],
  );
  return { photo_id: r.rows[0].id as string, url, key };
}

/**
 * The human pressed Send. The object is HEADed first — a row marked sent with
 * nothing behind it would be a photo the other side is told about and cannot
 * open — and only then does it become collectable.
 *
 * Bound to the sender and to the conversation the link was minted for, so a
 * press can only ever send a photo this person uploaded on this conversation.
 *
 * The caption is checked by the caller before the link is burnt and encrypted
 * here, under the same channel key a message body uses: it is words on this
 * conversation and it is stored the way words are.
 */
export async function markPhotoSent(
  cfg: Config,
  accountId: string,
  matchId: string,
  photoId: string,
  caption?: string,
): Promise<{ photo_id: string }> {
  const bucket = mustBucket(cfg);
  // EACH ATTEMPT IS COUNTED, AND THERE ARE THREE (2026-09-17 audit). Sending is
  // where the picture is looked at, and that is a model call over an object in
  // a bucket. Nothing counted the attempts, so the same uploaded photo could be
  // sent again and again — each refusal leaving the row unsent and ready for
  // another go — and one upload bought an unlimited number of screenings. Three
  // is more than a flaky connection needs and fewer than a loop wants.
  //
  // The count goes up BEFORE the work, so an attempt that fails anywhere —
  // including inside the pipe — is still an attempt. The claim is one statement
  // with the attempt check in it, so two calls arriving together cannot both
  // read two and both spend a screen.
  const r = await getPool().query(
    `UPDATE conversation_photos SET send_attempts = send_attempts + 1
      WHERE id = $1 AND sender_account = $2 AND match_id = $3 AND sent_at IS NULL
        AND send_attempts < $4
      RETURNING id, s3_key, channel_id, content_type, size_bytes, send_attempts`,
    [photoId, accountId, matchId, MAX_SEND_ATTEMPTS],
  );
  const row = r.rows[0];
  if (!row) {
    const spent = await getPool().query(
      `SELECT send_attempts FROM conversation_photos
        WHERE id = $1 AND sender_account = $2 AND match_id = $3 AND sent_at IS NULL`,
      [photoId, accountId, matchId],
    );
    if (spent.rows[0] && spent.rows[0].send_attempts >= MAX_SEND_ATTEMPTS) {
      throw validation(
        'that photo has been tried enough times. Upload it again if it still needs to go.',
      );
    }
    throw validation('that photo is not waiting to be sent.');
  }
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: row.s3_key }));
  } catch {
    throw validation('that photo never finished uploading.');
  }
  // WHAT LANDED IS WHAT WAS SIGNED FOR (2026-09-28 review). The upload link
  // signs the size and the bytes' hash, but the type the browser sends rides
  // beside them, and an object stored as text/html would be served as text/html.
  // So the type on the object must be the allow-listed one on the row, and the
  // size inside the cap, or it does not go.
  if (
    String(head.ContentType ?? '').toLowerCase() !== String(row.content_type).toLowerCase() ||
    !Number.isFinite(Number(head.ContentLength)) ||
    Number(head.ContentLength) <= 0 ||
    Number(head.ContentLength) > MAX_PHOTO_BYTES
  ) {
    photoLog('conversation-photo-not-relayed', {
      channel_id: row.channel_id,
      outcome: 'refuse',
      reason_code: 'object-not-as-declared',
    });
    throw validation(PHOTO_NOT_AS_DECLARED);
  }
  // THE SERVER STRIPS IT, before anything looks at it, and records that it did.
  // Every attempt strips again: the bytes under the key are whatever is there
  // now, and the record is only true of bytes this code wrote.
  const stripped = await stripPhotoInPlace(bucket, row.s3_key as string, row.content_type as string);
  await getPool().query(
    'UPDATE conversation_photos SET metadata_stripped_at = now(), size_bytes = $2 WHERE id = $1',
    [row.id, stripped.size_bytes],
  );
  // THE PICTURE IS LOOKED AT HERE, and this is the only moment it can be: the
  // bytes exist now and the other side has not been told about them yet. The
  // object goes to the same pipe every other thing a person hands over goes to
  // (docs/trust-and-safety.md), by reference — a bucket and a key, never bytes
  // through this process. A refusal has already deleted the object and the row
  // is left unsent for the sweep; a hold leaves both alone and says so.
  const intake = await runIntake(cfg, {
    door: 'photo',
    sender_account: accountId,
    match_id: matchId,
    // The browser's claim was checked at presign, as a hint. What the gate
    // passes on here is the server's own record, written a moment ago by the
    // strip above.
    fields: { metadata_removed: 'true', metadata_stripped_by_server: 'true' },
    object: {
      bucket,
      key: row.s3_key as string,
      content_type: row.content_type as string,
    },
  });
  if (intake.outcome !== 'pass') {
    photoLog('conversation-photo-not-relayed', {
      channel_id: row.channel_id,
      outcome: intake.outcome,
      reason_code: intake.reason_code ?? 'unknown',
    });
    throw validation(intake.plain_words ?? 'that photo has not gone.');
  }
  const captionEnc = caption
    ? await encryptForChannel(
        row.channel_id as string,
        await ensureChannelKey(matchId, row.channel_id as string),
        caption,
      )
    : null;
  await getPool().query(
    'UPDATE conversation_photos SET sent_at = now(), caption_enc = $2 WHERE id = $1',
    [row.id, captionEnc],
  );
  photoLog('conversation-photo-relayed', {
    channel_id: row.channel_id,
    direction: 'accepted',
    count: 1,
  });
  return { photo_id: row.id as string };
}

/** What an agent is handed when it collects a photo. */
export interface CollectedPhoto {
  kind: 'conversation.photo';
  conversation_id: string;
  photo_id: string;
  sent_at: string;
  content_type: string;
  size_bytes: number;
  /**
   * A short link on the switchboard's own host, good for VIEW_URL_TTL_S from
   * collection and then dead. Opening it signs a fresh S3 GET and redirects.
   */
  url: string;
  expires_in_minutes: number;
  /** The sender's own line beside it, when they typed one. */
  caption?: { text: string; provenance: 'counterparty-untrusted' };
}

/**
 * THE SHORT LINK (27 September 2026). The collecting agent used to be handed
 * the presigned S3 GET itself: about 1,500 characters on an amazonaws.com host,
 * with a signature and a session token in it. A small local model could not
 * copy it out whole, and its human never saw the picture. So the agent is now
 * handed `${counterOrigin}/p/<token>`, 22 characters of token, and nothing
 * about the bucket, the key or the credentials ever reaches agent-facing
 * output. Opening it signs a GET for whatever is left of the same fifteen
 * minutes and redirects there, so the bytes still never pass through this
 * service.
 *
 * The rules are the rules the presigned URL had, on purpose: a bearer link
 * (the recipient's assistant may open it itself to render the picture, and an
 * assistant holds no session), good for fifteen minutes from collection and
 * openable as often as the old URL was within them, and handed over once. Only
 * the SHA-256 of the token is stored.
 */
export const PHOTO_LINK_TOKEN_BYTES = 16;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** The shape of a short photo token: 16 random bytes, base64url, no padding. */
export const PHOTO_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export const photoLinkUrl = (cfg: Config, token: string) => `${cfg.counterOrigin}/p/${token}`;

/**
 * Collect the photos waiting for this human, and spend them.
 *
 * There is no schema document for this on the wire yet, so it is NOT run
 * through assertOutbound — stating that here rather than inventing a name the
 * schema package does not carry. The shape above is the contract, and the unit
 * suite holds it.
 *
 * Each row is claimed with a conditional UPDATE, so two agents collecting at
 * once cannot both be handed the same photo. The short link's hash is written
 * in that same statement, so a row is never spent without its link. Delivery
 * is AT-MOST-ONCE, the same as the words are: an agent that dies between the
 * claim and its own handling of the answer has lost that photo, and there is
 * nowhere to fetch it from again.
 */
export async function collectPhotos(
  cfg: Config,
  accountId: string,
  matchId: string,
  channelId: string,
): Promise<CollectedPhoto[]> {
  if (!photosConfigured(cfg)) return [];
  mustBucket(cfg);
  // One token for each row this claim could take, in the order it takes them.
  const tokens = Array.from({ length: MAX_WAITING_PHOTOS }, () =>
    randomBytes(PHOTO_LINK_TOKEN_BYTES).toString('base64url'),
  );
  const claimed = await getPool().query(
    `WITH locked AS (
       SELECT id, created_at FROM conversation_photos
        WHERE recipient_account = $1 AND channel_id = $2
          AND sent_at IS NOT NULL AND collected_at IS NULL
        ORDER BY created_at ASC
        LIMIT ${MAX_WAITING_PHOTOS}
        FOR UPDATE SKIP LOCKED
     ), picked AS (
       SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC)::int AS n FROM locked
     )
     UPDATE conversation_photos p SET collected_at = now(), view_token_hash = ($3::text[])[picked.n]
       FROM picked
      WHERE p.id = picked.id
      RETURNING p.id, p.content_type, p.size_bytes, p.caption_enc, p.sent_at, p.created_at, picked.n`,
    [accountId, channelId, tokens.map(sha256hex)],
  );
  if (!claimed.rowCount) return [];
  const rows = [...claimed.rows].sort((a: any, b: any) => Number(a.n) - Number(b.n));
  const wrappedKey = await ensureChannelKey(matchId, channelId);
  const out: CollectedPhoto[] = [];
  for (const row of rows) {
    const caption = row.caption_enc
      ? await decryptForChannel(channelId, wrappedKey, row.caption_enc as Buffer)
      : undefined;
    out.push({
      kind: 'conversation.photo',
      conversation_id: channelId,
      photo_id: row.id as string,
      sent_at: new Date(row.sent_at).toISOString(),
      content_type: row.content_type as string,
      size_bytes: Number(row.size_bytes),
      url: photoLinkUrl(cfg, tokens[Number(row.n) - 1]),
      expires_in_minutes: Math.round(VIEW_URL_TTL_S / 60),
      // The other side's human wrote it, through their own page. Labelled the
      // way every other thing they say is labelled.
      ...(caption ? { caption: { text: caption, provenance: 'counterparty-untrusted' as const } } : {}),
    });
  }
  photoLog('conversation-photo-relayed', {
    channel_id: channelId,
    direction: 'collected',
    count: out.length,
  });
  return out;
}

/**
 * Open a short photo link: a presigned GET for whatever is left of the
 * fifteen minutes since collection, or null once there is nothing to open.
 * Null covers a token that never existed, one whose window has passed, and one
 * whose row the sweep has already taken, and they are not told apart.
 */
export async function openPhotoLink(cfg: Config, token: string): Promise<{ url: string } | null> {
  if (!photosConfigured(cfg) || !PHOTO_TOKEN_RE.test(token)) return null;
  const bucket = mustBucket(cfg);
  const r = await getPool().query(
    `SELECT s3_key, content_type,
            ceil(extract(epoch FROM (collected_at + ($2 || ' seconds')::interval - now())))::int AS left_s

       FROM conversation_photos
      WHERE view_token_hash = $1 AND collected_at IS NOT NULL
        AND collected_at > now() - ($2 || ' seconds')::interval`,
    [sha256hex(token), String(VIEW_URL_TTL_S)],
  );
  const row = r.rows[0];
  if (!row) return null;
  const left = Math.min(VIEW_URL_TTL_S, Math.max(1, Number(row.left_s)));
  // SERVED AS THE TYPE ON THE ROW, NOT THE TYPE ON THE OBJECT (2026-09-28
  // review). The row's type came off the allowlist; the object's came from
  // whoever PUT it. The GET overrides both headers, so whatever is stored the
  // browser is told it is an image, shown inline, under a name nobody chose.
  const type = ALLOWED_PHOTO_TYPES[String(row.content_type)] ? String(row.content_type) : undefined;
  if (!type) return null;
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: row.s3_key,
      ResponseContentType: type,
      ResponseContentDisposition: `inline; filename="photo.${ALLOWED_PHOTO_TYPES[type]}"`,
    }),
    { expiresIn: left },
  );
  return { url };
}

/** How many photos are waiting for an account on each of the given conversations. */
export async function pendingPhotoCounts(
  accountId: string,
  channelIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!channelIds.length) return out;
  const r = await getPool().query(
    `SELECT channel_id, count(*)::int AS n FROM conversation_photos
      WHERE recipient_account = $1 AND channel_id = ANY($2::text[])
        AND sent_at IS NOT NULL AND collected_at IS NULL
      GROUP BY channel_id`,
    [accountId, channelIds],
  );
  for (const row of r.rows) out.set(row.channel_id as string, row.n as number);
  return out;
}

/**
 * The sweep, on the existing expiry tick. Two kinds of row go, and the bytes go
 * with them in the same pass:
 *
 *  - collected, past the life of the link that was handed over;
 *  - anything at all past its expiry, collected or not, sent or not — which
 *    covers a photo nobody ever came for and one that was uploaded and never
 *    sent.
 *
 * The rows are deleted only after S3 says the objects are gone, so a failed
 * delete leaves a row to try again on rather than an orphaned object nothing
 * remembers.
 */
export async function sweepConversationPhotos(cfg: Config): Promise<{ photos: number }> {
  if (!photosConfigured(cfg)) return { photos: 0 };
  const bucket = mustBucket(cfg);
  const due = await getPool().query(
    `SELECT id, s3_key FROM conversation_photos
      WHERE expires_at < now()
         OR (collected_at IS NOT NULL AND collected_at < now() - ($1 || ' seconds')::interval)
      LIMIT 1000`,
    [String(COLLECTED_GRACE_S)],
  );
  if (!due.rowCount) return { photos: 0 };
  let gone = 0;
  // In batches of a thousand, which is S3's own limit for one delete call.
  const keys = due.rows.map((r: any) => ({ Key: r.s3_key as string }));
  await s3.send(
    new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
  );
  const r = await getPool().query('DELETE FROM conversation_photos WHERE id = ANY($1::uuid[])', [
    due.rows.map((x: any) => x.id),
  ]);
  gone = r.rowCount ?? 0;
  if (gone) photoLog('conversation-photo-swept', { count: gone });
  return { photos: gone };
}
