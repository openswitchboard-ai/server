/**
 * A photo crosses inside the conversation, and nowhere else (phase 1.J).
 *
 * The rules asserted here, against the real domain code and the real SQL it
 * issues (a small in-memory Postgres and a stubbed S3 stand in, so the
 * statements and the signed calls are themselves under test):
 *
 *  - AN AGENT CANNOT UPLOAD. Nothing on the tool surface takes bytes, a
 *    filename, a content type or an image of any kind; the one photo action an
 *    agent has mints a link and returns it, and changes nothing.
 *  - THE LINK IS BOUND TO THE CONVERSATION when it is minted, and the press
 *    reads the conversation off the signed row. A photo uploaded against one
 *    introduction cannot be sent on another, and a stranger is told nothing.
 *  - LIMITS, twice each: the presign refuses a type that is not one of the
 *    three, a video, an oversized file and a missing hash; and the same numbers
 *    live in one named place.
 *  - WORDS ARE STILL WORDS: a caption carrying a money figure is refused, and so
 *    is a filename carrying one, on the same rule a message is held to.
 *  - COLLECTION SPENDS IT. Collecting hands back a short-lived link and marks
 *    the row collected; a second collection comes back empty; the sweep then
 *    deletes the object and the row together once the handed-over link is dead.
 *  - EXPIRY: a photo nobody ever collected is deleted with its object at its
 *    expiry, and the expiry is the relay's own 14 days.
 *  - THE COLLECTING AGENT IS TOLD. The sentence that rides back with an empty
 *    batch of words still accounts for a photo that is waiting.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateChannelKey: vi.fn(async (channelId: string) => Buffer.from(`ckey:${channelId}`)),
  encryptForChannel: vi.fn(async (channelId: string, key: Buffer, plaintext: string) => {
    expect(key.toString('utf8')).toBe(`ckey:${channelId}`);
    return Buffer.from(`sealed:${plaintext}`, 'utf8');
  }),
  decryptForChannel: vi.fn(async (_c: string, _k: Buffer, blob: Buffer) =>
    blob.toString('utf8').replace(/^sealed:/, ''),
  ),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: any, opts: any) => {
    const kind = command.constructor.name;
    signed.push({ kind, input: command.input, expiresIn: opts?.expiresIn });
    return `https://bucket.test/${encodeURIComponent(command.input.Key)}?sig=1&kind=${kind}`;
  }),
}));

import * as db from '../../src/db.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { s3 } from '../../src/aws.js';
import * as photo from '../../src/domain/channelPhoto.js';
import * as channel from '../../src/domain/channel.js';
import { photoLink } from '../../src/domain/humanLinks.js';
import { TOOLS } from '../../src/mcp/tools.js';
import { photoPage } from '../../src/counter/pages.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

/** Every URL the presigner was asked to sign, in order. */
let signed: { kind: string; input: any; expiresIn?: number }[] = [];

const cfg = {
  envName: 'dev',
  photoBucket: 'osb-dev-conversation-photos',
  counterOrigin: 'https://my.test',
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_MATCH = 'dddddddd-4444-4444-8444-dddddddddddd';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc';
const STRANGER = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const CHANNEL = 'ch_11111111-2222-4333-8444-555555555555';

const SHA = 'A'.repeat(43) + '=';
const jpeg = (over = false) => ({
  filename: 'bike.jpg',
  content_type: 'image/jpeg',
  size: over ? photo.MAX_PHOTO_BYTES + 1 : 2_000_000,
  sha256_b64: SHA,
});

interface Pic {
  id: string;
  channel_id: string;
  match_id: string;
  sender_account: string;
  recipient_account: string;
  s3_key: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  caption_enc: Buffer | null;
  created_at: Date;
  sent_at: Date | null;
  collected_at: Date | null;
  expires_at: Date;
}

interface World {
  stage: number;
  state: 'open' | 'declined';
  channel_id: string | null;
  photos: Pic[];
  messages: any[];
  /** Keys S3 currently holds, and what was deleted from it. */
  objects: Set<string>;
  deleted: string[];
  links: any[];
  clockSkewMs: number;
}

let world: World;
const nowMs = () => Date.now() + world.clockSkewMs;

const theMatch = (id: string) => ({
  id,
  card_want: 'card-w',
  card_have: 'card-h',
  account_want: ANA,
  account_have: BEPPE,
  category: 'goods.bicycle.mountain',
  stage: world.stage,
  state: world.state,
  channel_id: world.channel_id,
  channel_key_enc: Buffer.from(`ckey:${world.channel_id}`),
});

function run(sql: string, params: any[] = []) {
  const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return rows([]);
  if (/^\s*SELECT \* FROM matches WHERE id/.test(sql)) {
    return rows(params[0] === MATCH || params[0] === OTHER_MATCH ? [theMatch(params[0])] : []);
  }
  if (/SELECT channel_key_enc FROM matches/.test(sql)) {
    return rows([{ channel_key_enc: Buffer.from(`ckey:${world.channel_id}`) }]);
  }
  if (/^\s*SELECT \* FROM cards WHERE id/.test(sql)) {
    return rows([{ id: params[0], lifecycle_state: 'PUBLISHED' }]);
  }
  // --- the photo table -----------------------------------------------------
  if (/SELECT channel_id, count\(\*\)::int AS n FROM conversation_photos/.test(sql)) {
    const counts = new Map<string, number>();
    for (const p of world.photos) {
      if (p.recipient_account !== params[0] || !p.sent_at || p.collected_at) continue;
      if (!(params[1] as string[]).includes(p.channel_id)) continue;
      counts.set(p.channel_id, (counts.get(p.channel_id) ?? 0) + 1);
    }
    return rows([...counts].map(([channel_id, n]) => ({ channel_id, n })));
  }
  if (/count\(\*\)::int AS n FROM conversation_photos/.test(sql)) {
    const n = world.photos.filter(
      (p) =>
        p.channel_id === params[0] &&
        p.sender_account === params[1] &&
        ((p.sent_at && !p.collected_at) ||
          (!p.sent_at && p.created_at.getTime() > nowMs() - 3_600_000)),
    ).length;
    return rows([{ n }]);
  }
  if (/INSERT INTO conversation_photos/.test(sql)) {
    const row: Pic = {
      id: randomUUID(),
      channel_id: params[0],
      match_id: params[1],
      sender_account: params[2],
      recipient_account: params[3],
      s3_key: params[4],
      content_type: params[5],
      size_bytes: params[6],
      sha256: params[7],
      caption_enc: null,
      created_at: new Date(nowMs() + world.photos.length),
      sent_at: null,
      collected_at: null,
      expires_at: new Date(nowMs() + Number(params[8]) * 86_400_000),
    };
    world.photos.push(row);
    return rows([{ id: row.id }]);
  }
  if (/SELECT id, s3_key, channel_id FROM conversation_photos/.test(sql)) {
    return rows(
      world.photos
        .filter(
          (p) =>
            p.id === params[0] &&
            p.sender_account === params[1] &&
            p.match_id === params[2] &&
            !p.sent_at,
        )
        .map((p) => ({ id: p.id, s3_key: p.s3_key, channel_id: p.channel_id })),
    );
  }
  if (/UPDATE conversation_photos SET sent_at/.test(sql)) {
    const p = world.photos.find((x) => x.id === params[0]);
    if (p) {
      p.sent_at = new Date(nowMs());
      p.caption_enc = params[1] ?? null;
    }
    return rows(p ? [{ id: p.id }] : []);
  }
  if (/UPDATE conversation_photos SET collected_at/.test(sql)) {
    const claimed = world.photos
      .filter(
        (p) =>
          p.recipient_account === params[0] &&
          p.channel_id === params[1] &&
          p.sent_at &&
          !p.collected_at,
      )
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    for (const p of claimed) p.collected_at = new Date(nowMs());
    return rows(
      claimed.map((p) => ({
        id: p.id,
        s3_key: p.s3_key,
        content_type: p.content_type,
        size_bytes: p.size_bytes,
        caption_enc: p.caption_enc,
        sent_at: p.sent_at,
      })),
    );
  }
  if (/SELECT id, s3_key FROM conversation_photos/.test(sql)) {
    const graceMs = Number(params[0]) * 1000;
    return rows(
      world.photos
        .filter(
          (p) =>
            p.expires_at.getTime() < nowMs() ||
            (p.collected_at && p.collected_at.getTime() < nowMs() - graceMs),
        )
        .map((p) => ({ id: p.id, s3_key: p.s3_key })),
    );
  }
  if (/DELETE FROM conversation_photos/.test(sql)) {
    const ids: string[] = params[0];
    const before = world.photos.length;
    world.photos = world.photos.filter((p) => !ids.includes(p.id));
    return { rows: [], rowCount: before - world.photos.length };
  }
  // --- the message table, for the collection answer ------------------------
  if (/SELECT id, created_at, body_enc FROM channel_messages/.test(sql)) return rows([]);
  if (/SELECT 1 FROM channel_messages/.test(sql)) return rows([]);
  if (/INSERT INTO approval_links/.test(sql)) {
    const row = {
      id: randomUUID(),
      account_id: params[0],
      action: params[1],
      ref_id: params[2],
      amount: params[3],
      ccy: params[4],
      counterparty_account: params[5],
      payload: params[6],
    };
    world.links.push(row);
    return rows([{ id: row.id }]);
  }
  if (/UPDATE approval_links SET token_hash/.test(sql)) return rows([]);
  return rows([]);
}

const client = { query: async (sql: string, params: any[] = []) => run(sql, params), release() {} };

beforeEach(async () => {
  signed = [];
  world = {
    stage: 4,
    state: 'open',
    channel_id: CHANNEL,
    photos: [],
    messages: [],
    objects: new Set<string>(),
    deleted: [],
    links: [],
    clockSkewMs: 0,
  };
  vi.spyOn(db, 'getPool').mockReturnValue({
    query: async (sql: string, params: any[] = []) => run(sql, params),
    connect: async () => client,
  } as any);
  // A stand-in S3: HEAD answers for keys the world holds, and a delete records
  // the keys it was asked for.
  vi.spyOn(s3, 'send').mockImplementation(async (command: any) => {
    const kind = command.constructor.name;
    if (kind === 'HeadObjectCommand') {
      if (!world.objects.has(command.input.Key)) throw new Error('NotFound');
      return { ContentLength: 2_000_000 } as any;
    }
    if (kind === 'DeleteObjectsCommand') {
      for (const o of command.input.Delete.Objects) {
        world.objects.delete(o.Key);
        world.deleted.push(o.Key);
      }
      return {} as any;
    }
    return {} as any;
  });
  // Link signing needs a key; the real one comes from Secrets Manager.
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
});

/** The whole of one human's part: presign, the browser's PUT, the press. */
async function sendPhoto(
  from = ANA,
  matchId = MATCH,
  caption?: string,
  input = jpeg(),
): Promise<string> {
  const p = await photo.presignPhotoUpload(cfg, from, matchId, input);
  world.objects.add(p.key); // the browser's PUT lands
  await photo.markPhotoSent(cfg, from, matchId, p.photo_id, caption);
  return p.photo_id;
}

// ---------------------------------------------------------------------------
// The agent's part, which is to hand over a link and nothing else
// ---------------------------------------------------------------------------
describe('an agent cannot upload', () => {
  it('has nowhere on the tool surface to put an image', () => {
    const strings = (node: any, out: string[] = []): string[] => {
      if (Array.isArray(node)) node.forEach((n) => strings(n, out));
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          out.push(k);
          strings(v, out);
        }
      }
      return out;
    };
    const fields = new Set(TOOLS.flatMap((t) => strings(t.inputSchema)));
    for (const banned of [
      'photo',
      'image',
      'file',
      'bytes',
      'content_type',
      'filename',
      'attachment',
      'url',
      'data',
    ]) {
      expect(fields.has(banned), `an agent may send ${banned}`).toBe(false);
    }
  });

  it('offers the photo step as a link action, beside the other three', () => {
    const respond = TOOLS.find((t) => t.name === 'respond')!;
    expect(respond.inputSchema.properties.action.enum).toContain('request_photo');
    // And the description says whose job it is, in so many words.
    expect(respond.description).toMatch(/YOU CANNOT SEND AN IMAGE/);
    expect(TOOLS.find((t) => t.name === 'send_message')!.description).toMatch(
      /no way to attach an image here/,
    );
  });

  it('mints a link bound to that one conversation and changes nothing', async () => {
    const link = await photoLink(cfg, ANA, MATCH);
    expect(link.link).toContain('https://my.test/a/');
    expect(link.expires_in_minutes).toBe(15);
    expect(world.links).toHaveLength(1);
    expect(world.links[0]).toMatchObject({
      account_id: ANA,
      action: 'conversation-photo',
      ref_id: MATCH, // the conversation, decided here and never on the page
      counterparty_account: BEPPE,
    });
    expect(world.photos).toHaveLength(0);
  });

  it('refuses to mint one where there is no open conversation', async () => {
    world.stage = 3;
    world.channel_id = null;
    const e = await photoLink(cfg, ANA, MATCH).catch((x) => x);
    expect(e).toBeInstanceOf(OsbError);
    expect(e.payload.code).toBe('NOT_UNLOCKED_YET');
  });

  it('says so plainly where photos are not switched on in this deployment', async () => {
    const off = { ...cfg, photoBucket: undefined } as unknown as Config;
    const e = await photoLink(off, ANA, MATCH).catch((x) => x);
    expect(e).toBeInstanceOf(OsbError);
    expect(e.payload.human_action).toMatch(/not switched on/);
  });
});

// ---------------------------------------------------------------------------
// Who may put a photo where
// ---------------------------------------------------------------------------
describe('the photo is bound to the conversation', () => {
  it('tells a stranger nothing beyond "not found"', async () => {
    await expect(
      photo.presignPhotoUpload(cfg, STRANGER, MATCH, jpeg()),
    ).rejects.toMatchObject({ notFound: true });
  });

  it('refuses a conversation that is not open', async () => {
    world.state = 'declined';
    const e = await photo.presignPhotoUpload(cfg, ANA, MATCH, jpeg()).catch((x) => x);
    expect(e).toBeInstanceOf(OsbError);
    expect(e.payload.code).toBe('NOT_UNLOCKED_YET');
  });

  it('will not send a photo uploaded here on a different introduction', async () => {
    const p = await photo.presignPhotoUpload(cfg, ANA, MATCH, jpeg());
    world.objects.add(p.key);
    await expect(
      photo.markPhotoSent(cfg, ANA, OTHER_MATCH, p.photo_id),
    ).rejects.toMatchObject({ validation: true });
    // Nor on behalf of the other person.
    await expect(photo.markPhotoSent(cfg, BEPPE, MATCH, p.photo_id)).rejects.toMatchObject({
      validation: true,
    });
  });

  it('files it under the conversation it was minted for, and signs the size and the bytes', async () => {
    const p = await photo.presignPhotoUpload(cfg, ANA, MATCH, jpeg());
    expect(p.key.startsWith(`conversation-photos/dev/${CHANNEL}/`)).toBe(true);
    const put = signed.find((s) => s.kind === 'PutObjectCommand')!;
    expect(put.input).toMatchObject({
      ContentType: 'image/jpeg',
      ContentLength: 2_000_000,
      ChecksumSHA256: SHA,
    });
    expect(put.expiresIn).toBe(photo.UPLOAD_URL_TTL_S);
    // Written pending: not collectable until the human presses Send.
    expect(world.photos[0].sent_at).toBeNull();
    const got = await photo.collectPhotos(cfg, BEPPE, MATCH, CHANNEL);
    expect(got).toEqual([]);
  });

  it('refuses to mark one sent when the bytes never landed', async () => {
    const p = await photo.presignPhotoUpload(cfg, ANA, MATCH, jpeg());
    await expect(photo.markPhotoSent(cfg, ANA, MATCH, p.photo_id)).rejects.toMatchObject({
      validation: true,
    });
  });
});

// ---------------------------------------------------------------------------
// The limits, and the one place they live
// ---------------------------------------------------------------------------
describe('limits', () => {
  it('takes three image types and nothing else', async () => {
    expect(Object.keys(photo.ALLOWED_PHOTO_TYPES)).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
    for (const type of ['image/gif', 'image/heic', 'video/mp4', 'application/pdf', '']) {
      await expect(
        photo.presignPhotoUpload(cfg, ANA, MATCH, { ...jpeg(), content_type: type }),
      ).rejects.toMatchObject({ validation: true });
    }
    // And nothing was written or signed on the way to any of those refusals.
    expect(world.photos).toHaveLength(0);
    expect(signed).toHaveLength(0);
  });

  it('refuses an oversized file, and the cap is ten megabytes', async () => {
    expect(photo.MAX_PHOTO_BYTES).toBe(10 * 1024 * 1024);
    const e = await photo.presignPhotoUpload(cfg, ANA, MATCH, jpeg(true)).catch((x) => x);
    expect(e.validation).toBe(true);
    expect(e.message).toMatch(/10 MB or smaller/);
    expect(signed).toHaveLength(0);
  });

  it('refuses an upload with no hash to bind the bytes to', async () => {
    for (const sha256_b64 of ['', 'nonsense', 'A'.repeat(44)]) {
      await expect(
        photo.presignPhotoUpload(cfg, ANA, MATCH, { ...jpeg(), sha256_b64 }),
      ).rejects.toMatchObject({ validation: true });
    }
  });

  it('stops a conversation being used as storage', async () => {
    for (let i = 0; i < photo.MAX_WAITING_PHOTOS; i++) await sendPhoto();
    await expect(photo.presignPhotoUpload(cfg, ANA, MATCH, jpeg())).rejects.toMatchObject({
      validation: true,
    });
    // Collecting clears the way again: what is waiting is what counts.
    await photo.collectPhotos(cfg, BEPPE, MATCH, CHANNEL);
    await expect(photo.presignPhotoUpload(cfg, ANA, MATCH, jpeg())).resolves.toBeTruthy();
  });

  it('counts presigns nobody sent against the same cap', async () => {
    // One link is one send, but the presign behind it is a fetch: a script on
    // the page must not be able to sign URL after URL for bytes nobody comes
    // for.
    for (let i = 0; i < photo.MAX_WAITING_PHOTOS; i++) {
      await photo.presignPhotoUpload(cfg, ANA, MATCH, jpeg());
    }
    await expect(photo.presignPhotoUpload(cfg, ANA, MATCH, jpeg())).rejects.toMatchObject({
      validation: true,
    });
    // An hour later those stale ones stop counting.
    world.clockSkewMs = 3_700_000;
    await expect(photo.presignPhotoUpload(cfg, ANA, MATCH, jpeg())).resolves.toBeTruthy();
  });

  it('waits exactly as long as a message does', () => {
    expect(photo.PHOTO_TTL_DAYS).toBe(channel.MESSAGE_TTL_DAYS);
  });
});

// ---------------------------------------------------------------------------
// Words that ride along with a picture are still words
// ---------------------------------------------------------------------------
describe('a figure never travels in the words', () => {
  it('refuses a caption carrying one', async () => {
    for (const caption of ['$450 for it', 'four hundred and fifty', 'how about 400']) {
      const e = await (async () => photo.checkCaption(caption))().catch((x) => x);
      expect(e, caption).toBeInstanceOf(OsbError);
      expect(e.payload.code).toBe('CONSENT_REQUIRED');
    }
  });

  it('leaves an ordinary line beside a photo alone', () => {
    expect(photo.checkCaption('the scratch on the down tube')).toBe(
      'the scratch on the down tube',
    );
    expect(photo.checkCaption('29 inch wheels, 21 speed')).toBe('29 inch wheels, 21 speed');
    expect(photo.checkCaption('   ')).toBeUndefined();
    expect(photo.checkCaption(undefined)).toBeUndefined();
  });

  it('caps the line beside it', () => {
    expect(photo.MAX_CAPTION_CHARS).toBe(200);
    expect(() => photo.checkCaption('x'.repeat(201))).toThrow(/200 characters/);
  });

  it('refuses a filename carrying one, and nothing is signed or written', async () => {
    await expect(
      photo.presignPhotoUpload(cfg, ANA, MATCH, { ...jpeg(), filename: 'bike-450-firm.jpg' }),
    ).rejects.toBeInstanceOf(OsbError);
    expect(signed).toHaveLength(0);
    expect(world.photos).toHaveLength(0);
    // The extension itself is not a price: "photo-4.jpg" is not 4.jp.
    await expect(
      photo.presignPhotoUpload(cfg, ANA, MATCH, { ...jpeg(), filename: 'photo-4.jpg' }),
    ).resolves.toBeTruthy();
  });

  it('carries a caption encrypted under the conversation key, and hands it back labelled', async () => {
    await sendPhoto(ANA, MATCH, 'the scratch on the down tube');
    expect(world.photos[0].caption_enc?.toString('utf8')).toBe(
      'sealed:the scratch on the down tube',
    );
    const got = await photo.collectPhotos(cfg, BEPPE, MATCH, CHANNEL);
    expect(got[0].caption).toEqual({
      text: 'the scratch on the down tube',
      provenance: 'counterparty-untrusted',
    });
  });
});

// ---------------------------------------------------------------------------
// Handed over once, and then gone
// ---------------------------------------------------------------------------
describe('collection spends it', () => {
  it('hands back a short-lived link, once', async () => {
    await sendPhoto();
    const got = await photo.collectPhotos(cfg, BEPPE, MATCH, CHANNEL);
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe('conversation.photo');
    expect(got[0].conversation_id).toBe(CHANNEL);
    expect(got[0].url).toContain('kind=GetObjectCommand');
    expect(got[0].expires_in_minutes).toBe(15);
    const get = signed.find((s) => s.kind === 'GetObjectCommand')!;
    expect(get.expiresIn).toBe(photo.VIEW_URL_TTL_S);
    // Spent: a second collection finds nothing, and so does the sender.
    expect(await photo.collectPhotos(cfg, BEPPE, MATCH, CHANNEL)).toEqual([]);
    expect(await photo.collectPhotos(cfg, ANA, MATCH, CHANNEL)).toEqual([]);
  });

  it('never hands one to the person who sent it', async () => {
    await sendPhoto(ANA);
    expect(await photo.collectPhotos(cfg, ANA, MATCH, CHANNEL)).toEqual([]);
    expect(await photo.collectPhotos(cfg, BEPPE, MATCH, CHANNEL)).toHaveLength(1);
  });

  it('deletes the bytes and the row once the link handed over has run out', async () => {
    await sendPhoto();
    const key = world.photos[0].s3_key;
    await photo.collectPhotos(cfg, BEPPE, MATCH, CHANNEL);
    // While the link is still live, the bytes are still there.
    expect(await photo.sweepConversationPhotos(cfg)).toEqual({ photos: 0 });
    expect(world.objects.has(key)).toBe(true);
    // Past it, both go, in the same pass.
    world.clockSkewMs = (photo.COLLECTED_GRACE_S + 60) * 1000;
    expect(await photo.sweepConversationPhotos(cfg)).toEqual({ photos: 1 });
    expect(world.deleted).toEqual([key]);
    expect(world.objects.has(key)).toBe(false);
    expect(world.photos).toHaveLength(0);
  });

  it('deletes one nobody ever came for, at its expiry', async () => {
    await sendPhoto();
    const key = world.photos[0].s3_key;
    world.clockSkewMs = (photo.PHOTO_TTL_DAYS - 1) * 86_400_000;
    expect(await photo.sweepConversationPhotos(cfg)).toEqual({ photos: 0 });
    world.clockSkewMs = (photo.PHOTO_TTL_DAYS + 1) * 86_400_000;
    expect(await photo.sweepConversationPhotos(cfg)).toEqual({ photos: 1 });
    expect(world.deleted).toEqual([key]);
    expect(world.photos).toHaveLength(0);
  });

  it('clears a photo that was picked and never sent', async () => {
    const p = await photo.presignPhotoUpload(cfg, ANA, MATCH, jpeg());
    world.objects.add(p.key);
    world.clockSkewMs = (photo.PHOTO_TTL_DAYS + 1) * 86_400_000;
    expect(await photo.sweepConversationPhotos(cfg)).toEqual({ photos: 1 });
    expect(world.objects.size).toBe(0);
  });

  it('sweeps nothing where photos are not switched on', async () => {
    const off = { ...cfg, photoBucket: undefined } as unknown as Config;
    await expect(photo.sweepConversationPhotos(off)).resolves.toEqual({ photos: 0 });
  });
});

// ---------------------------------------------------------------------------
// What the collecting agent is told
// ---------------------------------------------------------------------------
describe('the sentence that rides back', () => {
  it('never answers "nothing" while a photo is waiting', async () => {
    await sendPhoto();
    const got = await channel.receiveMessages(BEPPE, MATCH, cfg);
    expect(got.messages).toEqual([]);
    expect(got.photos).toHaveLength(1);
    expect(got.note.text).toMatch(/photo has come through/);
    expect(got.note.text).toMatch(/link/);
    expect(got.note.text).not.toMatch(/Nothing has come through/);
  });

  it('answers plainly when there really is nothing', async () => {
    const got = await channel.receiveMessages(BEPPE, MATCH, cfg);
    expect(got.photos).toBeUndefined();
    expect(got.note.text).toMatch(/Nothing has come through/);
  });

  it('counts a waiting photo in the check-in sweep', async () => {
    await sendPhoto();
    const counts = await channel.pendingCounts(BEPPE, [CHANNEL]);
    expect(counts.get(CHANNEL)).toBe(1);
    await photo.collectPhotos(cfg, BEPPE, MATCH, CHANNEL);
    expect((await channel.pendingCounts(BEPPE, [CHANNEL])).get(CHANNEL)).toBeUndefined();
  });

  it('still hands the words over when the photos cannot be signed', async () => {
    await sendPhoto();
    vi.mocked(
      (await import('@aws-sdk/s3-request-presigner')).getSignedUrl,
    ).mockRejectedValueOnce(new Error('kms unavailable'));
    const got = await channel.receiveMessages(BEPPE, MATCH, cfg);
    expect(got.photos).toBeUndefined();
    expect(got.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What the page says, and what it does not ask
// ---------------------------------------------------------------------------
describe('the page the human is handed', () => {
  const page = () =>
    photoPage({
      token: 'tok-1',
      who: 'Sam',
      thing: 'mountain bike',
      maxMb: Math.round(photo.MAX_PHOTO_BYTES / (1024 * 1024)),
      ttlDays: photo.PHOTO_TTL_DAYS,
      captionMax: photo.MAX_CAPTION_CHARS,
    });

  it('names the one person it goes to, and offers no choice of anybody else', () => {
    const html = page();
    expect(html).toContain('Send Sam a photo of the mountain bike.');
    // Nothing on the page picks a recipient or a conversation: the link did.
    expect(html).not.toMatch(/<select/i);
    expect(html).not.toMatch(/name="intro|name="conversation|name="to"/i);
  });

  it('says plainly that nobody looks at the picture', () => {
    expect(page()).toMatch(/Nobody here looks at your photo\. No machine reads it either/);
  });

  it('takes the three types and nothing else, and says the cap and the days', () => {
    const html = page();
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toMatch(/10 MB/);
    expect(html).toMatch(/14 days/);
  });

  it('cannot be pressed until a photo has actually landed', () => {
    expect(page()).toContain('id="sendBtn" disabled');
  });
});
