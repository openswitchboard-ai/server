/**
 * THE THINGS ONLY A PERSON MAY DO.
 *
 * The switchboard's whole design rests on a handful of presses an assistant may
 * not make: sharing a first name and a suburb, accepting a figure, sending a
 * photo, reporting somebody. The simulated human cannot open a browser, so the
 * harness presses those pages AS that human — their own signed-in counter
 * session, their own PIN — exactly as test/duet does.
 *
 * NO ASSISTANT EVER SEES A PIN. The PIN lives in the TestActor the harness
 * minted and goes nowhere but into a form POST to the deployment under test. It
 * is never put in a transcript, a report, a log line or an utterance.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { counterFetch, type Jar, type TestActor } from '../integration/helpers.js';

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

/** The first switchboard link in something the assistant said. */
export function linkIn(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s)>\]"']+\/a\/[A-Za-z0-9_-]+/)?.[0];
}

export interface PressOutcome {
  status: number;
  /** The page's words with the markup taken out, trimmed. For evidence only. */
  body: string;
  /** What the page asked before it was pressed, where that matters. */
  asked?: boolean;
}

const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Press a one-question page: the names step, the report, the keep-talking
 * renewal. Reads the page first, the way a person does, and sends the PIN only
 * where the page asks for one.
 */
export async function pressOneQuestion(
  actor: TestActor,
  link: string,
  fields: Record<string, string> = {},
): Promise<PressOutcome> {
  const ask = await counterFetch(actor.jar, link);
  const askBody = await ask.text();
  if (ask.status !== 200) {
    return { status: ask.status, body: strip(askBody).slice(0, 200), asked: false };
  }
  const needsPin = askBody.includes('name="pin"');
  const res = await counterFetch(
    actor.jar,
    link,
    form({ decision: 'yes', ...(needsPin ? { pin: actor.pin } : {}), ...fields }),
  );
  return {
    status: res.status,
    body: strip(await res.text()).slice(0, 300),
    asked: askBody.includes('name="first_name"'),
  };
}

/**
 * Type a figure on the human's own offer page and send it.
 *
 * This is the ONE opinionated thing the harness does, and it is opinionated
 * because the product insists on it: every posting sits on "Pass on", where no
 * assistant may author a figure at all, so a best-offer sale cannot move until
 * a person types a number. The number is the fact sheet's, never a judgement —
 * Tony's $25 ceiling, said only because he was asked for it.
 */
export async function typeFigure(
  jar: Jar,
  matchId: string,
  amount: number,
  ccy = 'AUD',
): Promise<PressOutcome> {
  const res = await counterFetch(
    jar,
    `/matches/${matchId}/offer`,
    form({ amount: String(amount), ccy, good_for: '7' }),
  );
  return { status: res.status, body: strip(await res.text()).slice(0, 300) };
}

/** Accept a figure that is on the table, on the human's own approval page. */
export async function acceptOffer(actor: TestActor, offerId: string): Promise<PressOutcome> {
  const res = await counterFetch(
    actor.jar,
    '/approve',
    form({ action: 'offer-accept', ref_id: offerId, decision: 'approve', pin: actor.pin }),
  );
  return { status: res.status, body: strip(await res.text()).slice(0, 300) };
}

/**
 * Send a photo through the page, the way the page does it: ask for a presigned
 * URL, PUT the bytes straight to S3, then press the form with the photo_id.
 *
 * The picture is generated here and is a plain shape on a plain background —
 * no real image, nothing a moderation model could have anything to say about,
 * nothing of anybody's.
 */
export async function sendPhoto(
  actor: TestActor,
  link: string,
  png: Buffer,
  caption?: string,
): Promise<PressOutcome & { photoId?: string }> {
  const page = await counterFetch(actor.jar, link);
  if (page.status !== 200) {
    return { status: page.status, body: strip(await page.text()).slice(0, 200) };
  }
  const sha256B64 = createHash('sha256').update(png).digest('base64');
  const presign = await counterFetch(actor.jar, `${link}/photo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: 'shape.png',
      content_type: 'image/png',
      size: png.length,
      sha256_b64: sha256B64,
      metadata_removed: true,
    }),
  });
  if (presign.status !== 200) {
    return { status: presign.status, body: strip(await presign.text()).slice(0, 200) };
  }
  const { url, photo_id: photoId } = (await presign.json()) as { url: string; photo_id: string };
  const put = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'image/png', 'x-amz-checksum-sha256': sha256B64 },
    body: new Uint8Array(png),
  });
  if (!put.ok) {
    return { status: put.status, body: `upload to storage failed: ${put.status}`, photoId };
  }
  const pressed = await counterFetch(
    actor.jar,
    link,
    form({ decision: 'yes', photo_id: photoId, ...(caption ? { caption } : {}) }),
  );
  return { status: pressed.status, body: strip(await pressed.text()).slice(0, 300), photoId };
}

/**
 * A small PNG of a plain shape, made with the sharp the repository already
 * depends on. Deliberately dull: a grey square on white, no text, no faces,
 * nothing that could trip a moderation model and nothing that belongs to
 * anybody.
 */
export async function plainShapePng(): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">' +
      '<rect width="320" height="320" fill="#ffffff"/>' +
      '<rect x="80" y="80" width="160" height="160" rx="16" fill="#9aa3ad"/>' +
      '</svg>',
  );
  return sharp(svg).png().toBuffer();
}

/** For a dry run: a PNG read off disk is not wanted either, so this is the
 *  smallest valid one, inline, and it never leaves the process. */
export const DRY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Unused by the run; here so a caller can point at a file if it ever wants to. */
export function pngFromFile(path: string): Buffer {
  return readFileSync(path);
}
