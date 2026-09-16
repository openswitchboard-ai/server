/**
 * Taking the location out of a photo, in the one place it can be taken out.
 *
 * WHY THIS EXISTS (16 September 2026). Photos shipped two days ago with a hole
 * in them. The bytes go from the sender's own browser straight into the bucket
 * on a presigned PUT and out again to the other side's agent, so the service
 * never holds an image — which was the point, and which meant nothing anywhere
 * stripped EXIF. A photo taken on a phone carries the coordinates of the place
 * it was taken. A human who has released a suburb was releasing their front
 * door, while the page told them nobody here looks at their photo.
 *
 * THE FIX IS IN THE BROWSER, because the browser is the only place the bytes
 * exist outside the sender's phone and the bucket. The three options were: strip
 * here; strip on the way through the service, which would mean the service holds
 * the bytes and gives up the one property the design is built on; or parse the
 * file to refuse geotagged ones, which needs the bytes read somewhere anyway and
 * ends with a human whose camera roll is refused and no way to send a picture.
 * The first is the only one that keeps the service out of the image and still
 * fixes the leak.
 *
 * SO THIS FILE IS THE SCRIPT ITSELF. `PHOTO_SCRUB_JS` is the exact source that
 * is inlined into the photo page and runs on the sender's device. It is a string
 * so that there is ONE copy of it: the unit suite loads this same source and
 * runs it over real files, which means the code under test is the code that
 * ships, down to the byte. Nothing in it touches the DOM, so it runs in a test
 * the same way it runs on a phone.
 *
 * WHAT IT DOES TO A FILE. It rebuilds the container and keeps only the parts
 * that draw the picture.
 *
 *  - JPEG: every APPn segment and every comment goes. That is EXIF (GPS, the
 *    time, the phone, the serial number), XMP, the ICC profile, the Adobe and
 *    JFIF blocks, and the small preview thumbnail that lives inside EXIF and can
 *    show what the picture looked like before it was cropped. Anything appended
 *    after the end-of-image marker goes too — some phones park a second copy of
 *    the picture and a pile of maker notes down there.
 *  - PNG: an allowlist of the chunks that draw the image and its colours. The
 *    text chunks go, and so does the eXIf chunk PNG has carried since 2017.
 *  - WebP: the EXIF, XMP and colour-profile chunks go, and the flag bits in the
 *    VP8X header that announce them are cleared, so the file does not claim to
 *    carry what it no longer carries.
 *
 * ORIENTATION IS THE TRAP. A phone held sideways writes the pixels sideways and
 * an EXIF tag saying which way up it goes. Drop that tag and every portrait
 * photo lands on its side. So the orientation is read out BEFORE the metadata is
 * dropped, and where it says anything other than "upright" the page redraws the
 * pixels the right way round through a canvas and scrubs the result again. The
 * tag is gone either way, and the picture is the right way up because the pixels
 * themselves were turned.
 *
 * IT REFUSES RATHER THAN GUESSES. A file whose structure it cannot account for
 * byte by byte throws, and a throw means no presigned URL is ever asked for and
 * nothing is uploaded. `assertClean` runs the whole scan again over the finished
 * bytes and throws unless the second pass has nothing left to remove and nothing
 * left over, so the page only ever uploads a file it has proved clean.
 *
 * WHAT THE SERVER CAN AND CANNOT DO ABOUT IT. The presign refuses unless the
 * caller states the metadata was removed (`metadata_removed`), so a page that
 * cannot run the script gets no URL to upload with. That is a claim the browser
 * makes, and the server cannot check it without reading the bytes, which is the
 * thing it must not do. What it buys is real all the same: the shipped page can
 * only make the claim after `assertClean` passed, and a browser that runs no
 * script at all cannot upload or press Send.
 */

/**
 * The scrub, exactly as the sender's browser runs it. Plain ES5-ish script on
 * purpose: it is inlined into a page that has to work on an old phone.
 *
 * Ends by defining `__osbPhotoScrub`, which the page script and the test both
 * use. Keep it free of DOM calls — the canvas redraw lives in the page, and
 * everything decidable lives here where a test can reach it.
 */
export const PHOTO_SCRUB_JS = String.raw`
var OSB_SCRUB_UNREADABLE =
  'this picture could not be cleaned of where it was taken, so nothing was uploaded. Sending it as a plain JPEG or PNG from your camera roll usually works.';
var OSB_SCRUB_NOT_IMAGE = 'a photo here is a JPEG, a PNG or a WebP. Nothing else crosses, and no video.';

function osbScrubFail(message) {
  var e = new Error(message);
  e.photoRefused = true;
  return e;
}

function osbStr(b, i, n) {
  var s = '';
  for (var k = 0; k < n; k++) s += String.fromCharCode(b[i + k]);
  return s;
}
function osbBe16(b, i) { return ((b[i] << 8) | b[i + 1]) >>> 0; }
function osbBe32(b, i) { return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }
function osbLe32(b, i) { return ((b[i]) | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

/** JPEG, PNG or WebP, decided by the bytes themselves. The name a file arrived
 *  under is a guess; this is what it actually is. */
function osbSniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && osbStr(b, 1, 3) === 'PNG' && b[4] === 0x0d &&
      b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length > 12 && osbStr(b, 0, 4) === 'RIFF' && osbStr(b, 8, 4) === 'WEBP') return 'image/webp';
  return '';
}

/**
 * Which way up the camera was held, read out of a TIFF block before that block
 * is thrown away. 0 where there is no answer, which is treated as upright.
 */
function osbOrientation(b, off, end) {
  if (off + 8 > end) return 0;
  var le;
  if (b[off] === 0x49 && b[off + 1] === 0x49) le = true;
  else if (b[off] === 0x4d && b[off + 1] === 0x4d) le = false;
  else return 0;
  var r16 = function (i) { return le ? ((b[i] | (b[i + 1] << 8)) >>> 0) : osbBe16(b, i); };
  var r32 = function (i) { return le ? osbLe32(b, i) : osbBe32(b, i); };
  if (r16(off + 2) !== 42) return 0;
  var ifd = off + r32(off + 4);
  if (ifd + 2 > end || ifd < off) return 0;
  var n = r16(ifd);
  for (var k = 0; k < n; k++) {
    var e = ifd + 2 + k * 12;
    if (e + 12 > end) return 0;
    if (r16(e) === 0x0112) {
      var v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

function osbJoin(b, ranges) {
  var total = 0;
  var k;
  for (k = 0; k < ranges.length; k++) total += ranges[k][1] - ranges[k][0];
  var out = new Uint8Array(total);
  var at = 0;
  for (k = 0; k < ranges.length; k++) {
    out.set(b.subarray(ranges[k][0], ranges[k][1]), at);
    at += ranges[k][1] - ranges[k][0];
  }
  return out;
}

/**
 * JPEG. Walk the marker stream and keep the parts that draw: the tables, the
 * frame headers, the scans and their entropy bytes, and the end marker. Every
 * APPn and every comment is dropped, and the walk stops at the end marker, so a
 * trailer bolted on behind it is dropped with them.
 */
function osbScrubJpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw osbScrubFail(OSB_SCRUB_UNREADABLE);
  var ranges = [[0, 2]];
  var removed = [];
  var orientation = 0;
  var i = 2;
  var ended = false;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) throw osbScrubFail(OSB_SCRUB_UNREADABLE);
    while (b[i + 1] === 0xff && i + 2 < b.length) i++;
    var m = b[i + 1];
    if (m === 0xd9) { ranges.push([i, i + 2]); ended = true; break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { ranges.push([i, i + 2]); i += 2; continue; }
    if (i + 4 > b.length) throw osbScrubFail(OSB_SCRUB_UNREADABLE);
    var len = osbBe16(b, i + 2);
    var segEnd = i + 2 + len;
    if (len < 2 || segEnd > b.length) throw osbScrubFail(OSB_SCRUB_UNREADABLE);
    if (m === 0xda) {
      ranges.push([i, segEnd]);
      var p = segEnd;
      while (p + 1 < b.length) {
        if (b[p] === 0xff && b[p + 1] !== 0x00 && b[p + 1] !== 0xff &&
            !(b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7)) break;
        p++;
      }
      if (p + 1 >= b.length) throw osbScrubFail(OSB_SCRUB_UNREADABLE);
      ranges.push([segEnd, p]);
      i = p;
      continue;
    }
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      if (m === 0xe1 && segEnd - i > 10 && osbStr(b, i + 4, 4) === 'Exif') {
        orientation = osbOrientation(b, i + 10, segEnd) || orientation;
      }
      removed.push(m === 0xfe ? 'comment' : 'app' + (m - 0xe0));
    } else {
      ranges.push([i, segEnd]);
    }
    i = segEnd;
  }
  if (!ended) throw osbScrubFail(OSB_SCRUB_UNREADABLE);
  if (i + 2 < b.length) removed.push('trailer');
  return { bytes: osbJoin(b, ranges), removed: removed, orientation: orientation };
}

/**
 * PNG. An allowlist: the header, the palette, the transparency, the pixels, the
 * colour intent, the animation frames, the end. Everything else goes, which is
 * every text chunk, the timestamp, the embedded colour profile and eXIf.
 */
var OSB_PNG_KEEP = {
  IHDR: 1, PLTE: 1, tRNS: 1, IDAT: 1, IEND: 1,
  sRGB: 1, gAMA: 1, cHRM: 1, sBIT: 1,
  acTL: 1, fcTL: 1, fdAT: 1
};

function osbScrubPng(b) {
  var ranges = [[0, 8]];
  var removed = [];
  var i = 8;
  var ended = false;
  while (i + 12 <= b.length) {
    var len = osbBe32(b, i);
    var type = osbStr(b, i + 4, 4);
    var end = i + 12 + len;
    if (len > 0x7fffffff || end > b.length) throw osbScrubFail(OSB_SCRUB_UNREADABLE);
    if (OSB_PNG_KEEP[type] === 1) ranges.push([i, end]);
    else removed.push(type);
    i = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended) throw osbScrubFail(OSB_SCRUB_UNREADABLE);
  if (i < b.length) removed.push('trailer');
  return { bytes: osbJoin(b, ranges), removed: removed, orientation: 0 };
}

/**
 * WebP. Keep the picture chunks and drop EXIF, XMP and the colour profile. The
 * VP8X header carries flag bits announcing those three, so they are cleared as
 * well: a file that still claimed to hold EXIF would be a lie about itself and
 * would confuse a strict reader.
 */
var OSB_WEBP_KEEP = { 'VP8 ': 1, VP8L: 1, VP8X: 1, ALPH: 1, ANIM: 1, ANMF: 1 };
var OSB_WEBP_ANNOUNCE = 0x2c; // colour profile, EXIF, XMP

function osbScrubWebp(b) {
  var riffEnd = 8 + osbLe32(b, 4);
  if (riffEnd > b.length) riffEnd = b.length;
  if (riffEnd < 12) throw osbScrubFail(OSB_SCRUB_UNREADABLE);
  var parts = [];
  var removed = [];
  var orientation = 0;
  var i = 12;
  while (i + 8 <= riffEnd) {
    var fourcc = osbStr(b, i, 4);
    var size = osbLe32(b, i + 4);
    var dataEnd = i + 8 + size;
    if (size > 0x7fffffff || dataEnd > riffEnd) throw osbScrubFail(OSB_SCRUB_UNREADABLE);
    var next = dataEnd + (size & 1);
    if (OSB_WEBP_KEEP[fourcc] === 1) {
      parts.push({ fourcc: fourcc, from: i, to: next > riffEnd ? riffEnd : next });
    } else {
      removed.push(fourcc);
      if (fourcc === 'EXIF') {
        var o = i + 8;
        if (osbStr(b, o, 4) === 'Exif') o += 6;
        orientation = osbOrientation(b, o, dataEnd) || orientation;
      }
    }
    i = next;
  }
  if (!parts.length) throw osbScrubFail(OSB_SCRUB_UNREADABLE);
  if (i < b.length) removed.push('trailer');
  var body = 0;
  var k;
  for (k = 0; k < parts.length; k++) body += parts[k].to - parts[k].from;
  var out = new Uint8Array(12 + body);
  out.set(b.subarray(0, 12), 0);
  var at = 12;
  for (k = 0; k < parts.length; k++) {
    out.set(b.subarray(parts[k].from, parts[k].to), at);
    if (parts[k].fourcc === 'VP8X') out[at + 8] = out[at + 8] & ~OSB_WEBP_ANNOUNCE;
    at += parts[k].to - parts[k].from;
  }
  var riffSize = out.length - 8;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >>> 8) & 0xff;
  out[6] = (riffSize >>> 16) & 0xff;
  out[7] = (riffSize >>> 24) & 0xff;
  return { bytes: out, removed: removed, orientation: orientation };
}

/**
 * The whole scrub. Hands back the cleaned bytes, the type the bytes actually
 * are, which way up the camera was held, and the list of what was taken out.
 * Throws where the file is not one of the three, or where its structure cannot
 * be accounted for.
 */
function osbScrub(input) {
  var b = input instanceof Uint8Array ? input : new Uint8Array(input);
  var type = osbSniff(b);
  if (!type) throw osbScrubFail(OSB_SCRUB_NOT_IMAGE);
  var r = type === 'image/jpeg' ? osbScrubJpeg(b) : type === 'image/png' ? osbScrubPng(b) : osbScrubWebp(b);
  return { bytes: r.bytes, type: type, orientation: r.orientation, removed: r.removed };
}

/**
 * The proof, run over the finished bytes before anything is uploaded. A second
 * pass has to find nothing left to take out and has to come back the same
 * length. Throws otherwise, and a throw means no upload.
 */
function osbAssertClean(bytes) {
  var again = osbScrub(bytes);
  if (again.removed.length || again.bytes.length !== bytes.length || again.orientation > 1) {
    throw osbScrubFail(OSB_SCRUB_UNREADABLE);
  }
  return true;
}

/**
 * How to redraw a sideways picture the right way up: the size of the canvas and
 * the transform to set on it before the image is drawn at 0,0. Pure arithmetic,
 * so the turning is decided here where a test can check it and merely performed
 * by the page.
 */
function osbDrawPlan(orientation, w, h) {
  var t = {
    1: [1, 0, 0, 1, 0, 0],
    2: [-1, 0, 0, 1, w, 0],
    3: [-1, 0, 0, -1, w, h],
    4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0],
    6: [0, 1, -1, 0, h, 0],
    7: [0, -1, -1, 0, h, w],
    8: [0, -1, 1, 0, 0, w]
  }[orientation] || [1, 0, 0, 1, 0, 0];
  var turned = orientation >= 5 && orientation <= 8;
  return {
    width: turned ? h : w,
    height: turned ? w : h,
    transform: t,
    redraw: orientation > 1
  };
}

var __osbPhotoScrub = {
  scrub: osbScrub,
  assertClean: osbAssertClean,
  drawPlan: osbDrawPlan,
  sniff: osbSniff
};
`;

/** What one scrub comes back with. */
export interface ScrubResult {
  bytes: Uint8Array;
  /** What the bytes actually are, decided by the bytes rather than the name. */
  type: string;
  /** Which way up the camera was held: 1 upright, 0 where the file never said. */
  orientation: number;
  /** What was taken out, in the order it was found. */
  removed: string[];
}

export interface DrawPlan {
  width: number;
  height: number;
  transform: [number, number, number, number, number, number];
  redraw: boolean;
}

export interface PhotoScrubber {
  scrub(bytes: Uint8Array): ScrubResult;
  assertClean(bytes: Uint8Array): boolean;
  drawPlan(orientation: number, w: number, h: number): DrawPlan;
  sniff(bytes: Uint8Array): string;
}

let cached: PhotoScrubber | undefined;

/**
 * The same script, loaded here so it can be run outside a browser. This is the
 * unit suite's door onto the shipped source: there is no second implementation
 * to drift, because there is no second implementation.
 */
export function photoScrubber(): PhotoScrubber {
  if (!cached) {
    cached = new Function(`${PHOTO_SCRUB_JS}\nreturn __osbPhotoScrub;`)() as PhotoScrubber;
  }
  return cached;
}
