/**
 * A photo leaves the device with nothing in it but the picture.
 *
 * THE CODE UNDER TEST IS THE CODE THAT SHIPS. `photoScrubber()` loads
 * `PHOTO_SCRUB_JS` — the exact source inlined into the photo page — and runs it
 * here. There is no second implementation to drift.
 *
 * THE FILES ARE REAL FILES, built byte by byte in this suite rather than mocked:
 * a JPEG whose APP1 carries a TIFF block with a GPS sub-IFD holding known
 * coordinates and an orientation tag; a PNG with real chunk lengths and real
 * CRCs carrying tEXt, iTXt, eXIf and a timestamp; a WebP whose VP8X header
 * announces EXIF and XMP and whose EXIF chunk carries the same coordinates.
 * Each one is checked for its location BEFORE the scrub, by a reader written
 * here and owing nothing to the code being tested, so a pass means the block was
 * really there and is really gone.
 *
 * WHAT IS NOT PROVED HERE. The turning of the pixels happens on a canvas, and
 * there is no canvas in this process. What is proved is the arithmetic that
 * drives it: the size of the canvas and the transform set on it, checked by
 * mapping the corners of the source through the matrix by hand.
 *
 * The canvas half was run by hand in a browser on 16 September 2026, against
 * the rendered page itself: a 40×20 JPEG, left half red and right half blue,
 * given an EXIF orientation of 6, put through the page's own `osbRedraw`. It
 * came back 20×40 with red at the top and blue at the bottom, which is the
 * quarter turn clockwise that orientation asks for, and `assertClean` passed on
 * the result. That run is a note here rather than a test, because it needs a
 * browser.
 */
import { describe, expect, it } from 'vitest';
import { PHOTO_SCRUB_JS, photoScrubber } from '../../src/counter/photoScrub.js';
import { photoPage } from '../../src/counter/pages.js';
import { lintHumanCopy } from '../../src/email/lint.js';

const scrub = photoScrubber();

// ---------------------------------------------------------------------------
// Fixtures: real containers, built here.
// ---------------------------------------------------------------------------

const u8 = (...parts: (number[] | Uint8Array)[]): Uint8Array => {
  const flat: number[] = [];
  for (const p of parts) for (const b of p as Iterable<number>) flat.push(b);
  return Uint8Array.from(flat);
};
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Known coordinates, so the test can say what it went looking for: 35°17'S,
 *  149°07'E — a driveway in Canberra. */
const LAT = [35, 17, 22];
const LON = [149, 7, 44];

/**
 * A big-endian TIFF block: IFD0 carrying Orientation and a pointer to a GPS
 * sub-IFD, and the GPS sub-IFD carrying the reference letters and the two
 * rationals. The real structure, at real offsets.
 */
function tiffWithGps(orientation: number): number[] {
  const ifd0Off = 8;
  const entries0 = 2;
  const ifd0End = ifd0Off + 2 + entries0 * 12 + 4;
  const gpsOff = ifd0End;
  const entriesG = 4;
  const gpsEnd = gpsOff + 2 + entriesG * 12 + 4;
  // The rationals live after both directories: 3 pairs each, 24 bytes each.
  const latOff = gpsEnd;
  const lonOff = latOff + 24;
  const rational = (v: number[]) => v.flatMap((n) => [...be32(n), ...be32(1)]);
  return [
    ...ascii('MM'), ...be16(42), ...be32(ifd0Off),
    // IFD0
    ...be16(entries0),
    ...be16(0x0112), ...be16(3), ...be32(1), ...be16(orientation), ...be16(0), // Orientation
    ...be16(0x8825), ...be16(4), ...be32(1), ...be32(gpsOff), // GPS sub-IFD pointer
    ...be32(0),
    // GPS IFD
    ...be16(entriesG),
    ...be16(0x0001), ...be16(2), ...be32(2), ...ascii('S'), 0, 0, 0, // GPSLatitudeRef
    ...be16(0x0002), ...be16(5), ...be32(3), ...be32(latOff), // GPSLatitude
    ...be16(0x0003), ...be16(2), ...be32(2), ...ascii('E'), 0, 0, 0, // GPSLongitudeRef
    ...be16(0x0004), ...be16(5), ...be32(3), ...be32(lonOff), // GPSLongitude
    ...be32(0),
    ...rational(LAT),
    ...rational(LON),
  ];
}

function jpegSegment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...be16(payload.length + 2), ...payload];
}

/**
 * A JPEG with the segments a camera writes: JFIF, an EXIF block with GPS, a
 * quantisation table, a frame header, a Huffman table, a scan with entropy
 * bytes, the end marker — and, as a phone often adds, a trailer bolted on
 * behind the end marker.
 */
function jpegWithGps(opts: { orientation?: number; trailer?: boolean; xmp?: boolean } = {}) {
  const exif = [...ascii('Exif'), 0, 0, ...tiffWithGps(opts.orientation ?? 1)];
  const quant = [0, ...Array.from({ length: 64 }, (_, i) => (i % 16) + 1)];
  const frame = [8, ...be16(200), ...be16(100), 1, 1, 0x11, 0];
  const huff = [0x00, ...Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : 0)), 0x05];
  const scanHeader = [1, 1, 0x00, 0, 63, 0];
  const entropy = [0xa5, 0x5a, 0xff, 0x00, 0x12, 0xff, 0xd0, 0x34];
  return u8(
    [0xff, 0xd8],
    jpegSegment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, ...be16(72), ...be16(72), 0, 0]),
    jpegSegment(0xe1, exif),
    opts.xmp ? jpegSegment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/'), 0, ...ascii('<x:xmpmeta/>')]) : [],
    jpegSegment(0xfe, ascii('taken at home')),
    jpegSegment(0xdb, quant),
    jpegSegment(0xc0, frame),
    jpegSegment(0xc4, huff),
    jpegSegment(0xda, scanHeader),
    entropy,
    [0xff, 0xd9],
    opts.trailer ? ascii('MAKERNOTE-SECONDARY-IMAGE') : [],
  );
}

/** PNG chunk CRCs, done properly, so the fixture is a file a decoder would take. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: number[]): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: number[]): number[] {
  const body = [...ascii(type), ...data];
  return [...be32(data.length), ...body, ...be32(crc32(body))];
}

function pngWithText() {
  return u8(
    [0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk('IHDR', [...be32(1), ...be32(1), 8, 6, 0, 0, 0]),
    pngChunk('tEXt', [...ascii('Comment'), 0, ...ascii('taken at 35 17 S 149 07 E')]),
    pngChunk('iTXt', [...ascii('XML:com.adobe.xmp'), 0, 0, 0, 0, 0, ...ascii('<x:xmpmeta/>')]),
    pngChunk('eXIf', tiffWithGps(1)),
    pngChunk('tIME', [...be16(2026), 9, 16, 9, 30, 0]),
    pngChunk('IDAT', [0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]),
    pngChunk('IEND', []),
  );
}

function webpChunk(fourcc: string, data: number[]): number[] {
  const pad = data.length & 1 ? [0] : [];
  return [...ascii(fourcc), ...le32(data.length), ...data, ...pad];
}

/** A WebP whose VP8X announces a colour profile, EXIF and XMP, and carries all
 *  three. Alpha and animation bits are set too, so the test can watch them
 *  survive while the other three are cleared. */
function webpWithExif(orientation = 1) {
  const vp8x = webpChunk('VP8X', [0x2c | 0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const body = [
    ...vp8x,
    ...webpChunk('ICCP', ascii('a colour profile')),
    ...webpChunk('VP8 ', [0x11, 0x22, 0x33, 0x44, 0x55]),
    ...webpChunk('EXIF', [...ascii('Exif'), 0, 0, ...tiffWithGps(orientation)]),
    ...webpChunk('XMP ', ascii('<x:xmpmeta/>')),
  ];
  return u8(ascii('RIFF'), le32(body.length + 4), ascii('WEBP'), body);
}

// ---------------------------------------------------------------------------
// An independent reader: does this file carry a location, and which way up is it?
// Owes nothing to the code under test.
// ---------------------------------------------------------------------------

const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/** True where the bytes hold a GPS sub-IFD pointer or the coordinates written
 *  into the fixture, wherever in the file they are hiding. */
function carriesLocation(b: Uint8Array): boolean {
  if (text(b).includes('Exif')) return true;
  const gpsTag = Buffer.from([0x88, 0x25]);
  if (Buffer.from(b).includes(gpsTag)) return true;
  const coords = Buffer.from([...be32(LAT[0]), ...be32(1), ...be32(LAT[1])]);
  return Buffer.from(b).includes(coords);
}

/** Every JPEG marker in the file, as a list of marker bytes. */
function jpegMarkers(b: Uint8Array): number[] {
  const out: number[] = [];
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) break;
    const m = b[i + 1];
    out.push(m);
    if (m === 0xd9) break;
    if (m === 0xda) {
      let p = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
      while (p + 1 < b.length) {
        if (b[p] === 0xff && b[p + 1] !== 0x00 && b[p + 1] !== 0xff && !(b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7)) break;
        p++;
      }
      i = p;
      continue;
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return out;
}

function pngChunkTypes(b: Uint8Array): string[] {
  const out: string[] = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    out.push(text(b.subarray(i + 4, i + 8)));
    i += 12 + len;
  }
  return out;
}

function webpChunkTypes(b: Uint8Array): string[] {
  const out: string[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const cc = text(b.subarray(i, i + 4));
    const size = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
    out.push(cc);
    i += 8 + size + (size & 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
describe('a JPEG off a phone', () => {
  it('goes in carrying a location and comes out with no EXIF at all', () => {
    const before = jpegWithGps();
    // The fixture really does carry it, on a reader that knows nothing of the scrub.
    expect(carriesLocation(before)).toBe(true);
    expect(jpegMarkers(before)).toContain(0xe1);

    const after = scrub.scrub(before);

    expect(carriesLocation(after.bytes)).toBe(false);
    expect(text(after.bytes)).not.toContain('Exif');
    expect(text(after.bytes)).not.toContain('taken at home');
    // No APPn and no comment survives: EXIF, XMP, JFIF, the lot.
    for (const m of jpegMarkers(after.bytes)) {
      expect(m >= 0xe0 && m <= 0xef, `APP${m - 0xe0} survived`).toBe(false);
      expect(m).not.toBe(0xfe);
    }
    // What draws the picture is all still there, in order.
    expect(jpegMarkers(after.bytes)).toEqual([0xdb, 0xc0, 0xc4, 0xda, 0xd9]);
    expect(after.type).toBe('image/jpeg');
    expect(after.removed).toContain('app1');
  });

  it('drops XMP as well as EXIF', () => {
    const after = scrub.scrub(jpegWithGps({ xmp: true }));
    expect(text(after.bytes)).not.toContain('ns.adobe.com');
  });

  it('drops a trailer bolted on behind the end of the picture', () => {
    const before = jpegWithGps({ trailer: true });
    expect(text(before)).toContain('MAKERNOTE-SECONDARY-IMAGE');
    const after = scrub.scrub(before);
    expect(text(after.bytes)).not.toContain('MAKERNOTE');
    expect(after.removed).toContain('trailer');
  });

  it('keeps the entropy bytes of the scan exactly as they were', () => {
    const after = scrub.scrub(jpegWithGps());
    expect(Buffer.from(after.bytes).includes(Buffer.from([0xa5, 0x5a, 0xff, 0x00]))).toBe(true);
  });
});

describe('the way up is read out before it is thrown away', () => {
  it('reads the orientation a sideways phone wrote', () => {
    expect(scrub.scrub(jpegWithGps({ orientation: 6 })).orientation).toBe(6);
    expect(scrub.scrub(jpegWithGps({ orientation: 1 })).orientation).toBe(1);
    expect(scrub.scrub(webpWithExif(8)).orientation).toBe(8);
  });

  it('turns a portrait photo instead of leaving it on its side', () => {
    // A phone held sideways: 200 wide by 100 tall in the file, orientation 6,
    // which means the picture is meant to be seen 100 wide by 200 tall.
    const plan = scrub.drawPlan(6, 200, 100);
    expect(plan.redraw).toBe(true);
    expect([plan.width, plan.height]).toEqual([100, 200]);

    // The transform, checked by putting the corners through it by hand. A
    // quarter turn clockwise: the top-left of the file lands top-right, and the
    // bottom-left of the file lands top-left.
    const at = ([a, b, c, d, e, f]: number[], x: number, y: number) => [a * x + c * y + e, b * x + d * y + f];
    expect(at(plan.transform, 0, 0)).toEqual([100, 0]);
    expect(at(plan.transform, 0, 100)).toEqual([0, 0]);
    expect(at(plan.transform, 200, 100)).toEqual([0, 200]);
    expect(at(plan.transform, 200, 0)).toEqual([100, 200]);
  });

  it('leaves an upright photo alone', () => {
    const plan = scrub.drawPlan(1, 200, 100);
    expect(plan.redraw).toBe(false);
    expect([plan.width, plan.height]).toEqual([200, 100]);
    expect(plan.transform).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('gives every one of the eight a canvas the right way round', () => {
    for (const o of [1, 2, 3, 4]) expect(scrub.drawPlan(o, 200, 100).width).toBe(200);
    for (const o of [5, 6, 7, 8]) expect(scrub.drawPlan(o, 200, 100).width).toBe(100);
  });
});

describe('a PNG', () => {
  it('loses its text chunks, its timestamp and its eXIf block', () => {
    const before = pngWithText();
    expect(pngChunkTypes(before)).toEqual(expect.arrayContaining(['tEXt', 'iTXt', 'eXIf', 'tIME']));
    expect(carriesLocation(before)).toBe(true);

    const after = scrub.scrub(before);

    expect(pngChunkTypes(after.bytes)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(carriesLocation(after.bytes)).toBe(false);
    expect(text(after.bytes)).not.toContain('taken at');
    expect(after.type).toBe('image/png');
  });
});

describe('a WebP', () => {
  it('loses EXIF, XMP and the colour profile, and stops announcing them', () => {
    const before = webpWithExif();
    expect(webpChunkTypes(before)).toEqual(expect.arrayContaining(['EXIF', 'XMP ', 'ICCP']));
    expect(carriesLocation(before)).toBe(true);

    const after = scrub.scrub(before);

    expect(webpChunkTypes(after.bytes)).toEqual(['VP8X', 'VP8 ']);
    expect(carriesLocation(after.bytes)).toBe(false);
    // The VP8X flag byte: the three announcements cleared, alpha and animation
    // left alone.
    const flags = after.bytes[20];
    expect(flags & 0x2c).toBe(0);
    expect(flags & 0x12).toBe(0x12);
    // The RIFF length is rewritten to the file that actually exists.
    const riff = after.bytes[4] | (after.bytes[5] << 8) | (after.bytes[6] << 16) | (after.bytes[7] << 24);
    expect(riff).toBe(after.bytes.length - 8);
  });
});

describe('the proof before the upload', () => {
  it('passes on bytes that have been through the scrub', () => {
    for (const f of [jpegWithGps(), pngWithText(), webpWithExif()]) {
      expect(scrub.assertClean(scrub.scrub(f).bytes)).toBe(true);
    }
  });

  it('throws on the original file, which is what stops it being uploaded', () => {
    expect(() => scrub.assertClean(jpegWithGps())).toThrow();
    expect(() => scrub.assertClean(pngWithText())).toThrow();
    expect(() => scrub.assertClean(webpWithExif())).toThrow();
  });

  it('is idempotent: a second scrub changes nothing', () => {
    for (const f of [jpegWithGps(), pngWithText(), webpWithExif()]) {
      const once = scrub.scrub(f).bytes;
      const twice = scrub.scrub(once).bytes;
      expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true);
    }
  });
});

describe('a file it cannot account for is refused rather than guessed at', () => {
  it('refuses anything that is not one of the three', () => {
    expect(() => scrub.scrub(Uint8Array.from(ascii('GIF89a' + 'x'.repeat(40))))).toThrow(
      /JPEG, a PNG or a WebP/,
    );
    expect(() => scrub.scrub(Uint8Array.from(ascii('#!/bin/sh\necho hi\n')))).toThrow();
  });

  it('refuses a JPEG that stops in the middle of a segment', () => {
    const whole = jpegWithGps();
    expect(() => scrub.scrub(whole.subarray(0, 40))).toThrow(/could not be cleaned/);
  });

  it('refuses a JPEG with no end marker', () => {
    const whole = jpegWithGps();
    expect(() => scrub.scrub(whole.subarray(0, whole.length - 2))).toThrow(/could not be cleaned/);
  });

  it('refuses a PNG whose chunk length runs off the end', () => {
    const b = pngWithText();
    b[8] = 0x7f; // IHDR length, absurd
    expect(() => scrub.scrub(b)).toThrow(/could not be cleaned/);
  });

  it('refuses a WebP with nothing in it to draw', () => {
    const body = [...webpChunk('EXIF', [...ascii('Exif'), 0, 0, ...tiffWithGps(1)])];
    const bad = u8(ascii('RIFF'), le32(body.length + 4), ascii('WEBP'), body);
    expect(() => scrub.scrub(bad)).toThrow(/could not be cleaned/);
  });

  it('goes by the bytes rather than the name a file arrived under', () => {
    // A PNG saved as .jpg is a PNG, and is cleaned as one.
    expect(scrub.sniff(pngWithText())).toBe('image/png');
    expect(scrub.scrub(pngWithText()).type).toBe('image/png');
  });
});

describe('the page the sender reads', () => {
  const page = () =>
    photoPage({
      token: 'tok-1',
      who: 'Sam',
      thing: 'mountain bike',
      maxMb: 10,
      ttlDays: 14,
      captionMax: 200,
    });

  it('carries the scrub itself, so the cleaning happens before the upload', () => {
    const html = page();
    expect(html).toContain(PHOTO_SCRUB_JS);
    // The upload is of the cleaned bytes, and the claim rides with the presign.
    expect(html).toContain('metadata_removed: true');
    expect(html).toContain('__osbPhotoScrub.assertClean(clean.bytes)');
    expect(html).toContain('body: clean.bytes');
  });

  it('ships a script that parses, which is the whole of whether it can clean anything', () => {
    // Nothing else in this suite executes the page's own half of the script, so
    // at the least it is parsed here: a syntax error would mean a page that
    // uploads nothing at all, quietly.
    const src = page()
      .split('<script>')
      .map((s) => s.split('</script>')[0])
      .find((s) => s.includes('__osbPhotoScrub'))!;
    expect(() => new Function(src)).not.toThrow();
    expect(src.length).toBeGreaterThan(PHOTO_SCRUB_JS.length);
  });

  it('says what is taken out and what is kept', () => {
    const html = page();
    expect(html).toMatch(/where the photo was taken/);
    expect(html).toMatch(/the phone that took it/);
    expect(html).toMatch(/The picture itself is kept, the right way up/);
    expect(html).toMatch(/What is in shot crosses as it is/);
  });

  it('no longer claims no machine reads the file', () => {
    expect(page()).not.toContain('No machine reads it either');
    expect(page()).toContain('Nothing here opens the picture.');
  });

  it('tells a browser that cannot do it that nothing can be sent', () => {
    const html = page();
    expect(html).toContain('<noscript>');
    expect(html).toMatch(/A browser that cannot do the cleaning is refused/);
    expect(html).toContain('id="sendBtn" disabled');
  });

  it('keeps the house voice', () => {
    expect(lintHumanCopy(page())).toEqual([]);
  });
});
