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
  // THE TOKEN IS AFTER A DOT, AND THE DOT WAS NOT IN THE CLASS. A page address
  // is /a/<id>.<token>, and this pattern stopped at the dot: it handed back
  // the id alone, which is not a link, and the press came home "404 Not a
  // valid link". It only ever bit where the harness presses by fetching a URL
  // it read out of a reply — the photo step — because the human simulator's
  // own [[PRESS …]] marker is parsed by a different pattern that allows dots.
  // Stage 4 failed on it twice on 22 September 2026 and read, both times, as
  // an assistant handing over a broken link (see checks S4.link, S4.sent).
  // Trailing punctuation is trimmed rather than matched, so a link at the end
  // of a sentence does not carry the full stop with it.
  const m = text.match(/https?:\/\/[^\s)>\]"']+\/a\/[A-Za-z0-9_.-]+/)?.[0];
  return m?.replace(/[.,;:]+$/, '');
}

export interface PressOutcome {
  status: number;
  /** The page's words with the markup taken out, trimmed. For evidence only. */
  body: string;
  /** What the page asked before it was pressed, where that matters. */
  asked?: boolean;
}

/**
 * A page's words, for evidence. STYLE AND SCRIPT GO FIRST, because their
 * contents are not markup and survived the tag strip: every failure this
 * returned came back as two hundred characters of CSS about PIN boxes, and
 * the sentence that said what had actually gone wrong was never in the part
 * we kept (22 September 2026).
 */
const strip = (html: string) =>
  html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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

/** Accept a figure that is on the table, on the human's own main page. */
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
 * A PICTURE OF A SPRING, drawn here with the sharp the repository already
 * depends on: a steel-coloured coil lying on a plain wooden surface. No text,
 * no faces, nothing of anybody's, nothing a moderation model has anything to
 * say about.
 *
 * WHY NOT A GREY SQUARE ANY MORE. It was one, and on 24 September 2026 the
 * buyer's assistant opened it and told its human "it looks like a
 * placeholder/blank image on my end" — which IS describing a picture, and
 * which a grey square practically asks for, because it looks like an upload
 * that went wrong. A test photo that looks broken gives an assistant a good
 * reason to comment on it. A plausible photo of the thing on offer leaves it
 * only the reason the rule is about.
 */
export async function plainShapePng(): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  // A coil, as a run of ellipse loops along a diagonal, over a warm plain board.
  const loops = Array.from({ length: 9 }, (_, i) => {
    const cx = 110 + i * 22;
    const cy = 200 - i * 8;
    return `<ellipse cx="${cx}" cy="${cy}" rx="14" ry="46" fill="none" stroke="#8d949c" stroke-width="7"/>` +
      `<ellipse cx="${cx}" cy="${cy}" rx="14" ry="46" fill="none" stroke="#c7ccd1" stroke-width="2"/>`;
  }).join('');
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
      '<rect width="480" height="360" fill="#b98b5e"/>' +
      '<rect y="0" width="480" height="360" fill="#a97b50" opacity="0.35"/>' +
      '<ellipse cx="200" cy="262" rx="130" ry="16" fill="#6e4f33" opacity="0.35"/>' +
      loops +
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
