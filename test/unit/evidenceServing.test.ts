/**
 * Settlement evidence is served as the image it was declared to be
 * (2026-09-28 review).
 *
 * The upload link signs the size and the bytes' hash; the content type rides
 * beside them. So the manifest leaves out an object stored under any other
 * type (or over the cap), and every view link overrides the served type and
 * disposition from the row's allow-listed type.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signed: { kind: string; input: any }[] = [];
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: any) => {
    signed.push({ kind: command.constructor.name, input: command.input });
    return `https://bucket.test/${encodeURIComponent(command.input.Key)}`;
  }),
}));

import * as db from '../../src/db.js';
import { s3 } from '../../src/aws.js';
import {
  MAX_EVIDENCE_BYTES,
  evidenceViewLinks,
  objectAsDeclared,
  writeEvidenceManifest,
} from '../../src/domain/evidence.js';
import type { Config } from '../../src/config.js';

const cfg = { envName: 'dev', evidenceBucket: 'osb-evidence-dev' } as unknown as Config;
const SID = '7a2e5c1d-9f4b-4c8a-b3e6-2d1f0a9b8c7d';

let rows: any[];
let deleted: string[];
let heads: Record<string, any>;
let puts: { key: string; body: any }[];

beforeEach(() => {
  signed.length = 0;
  deleted = [];
  puts = [];
  rows = [
    { s3_key: 'k/good.jpg', content_type: 'image/jpeg', size_bytes: 1000, sha256: 'x' },
    { s3_key: 'k/html.jpg', content_type: 'image/jpeg', size_bytes: 1000, sha256: 'y' },
    { s3_key: 'k/huge.png', content_type: 'image/png', size_bytes: 1000, sha256: 'z' },
  ];
  heads = {
    'k/good.jpg': { ContentType: 'image/jpeg', ContentLength: 1000, ETag: '"a"' },
    'k/html.jpg': { ContentType: 'text/html', ContentLength: 1000, ETag: '"b"' },
    'k/huge.png': { ContentType: 'image/png', ContentLength: MAX_EVIDENCE_BYTES + 1, ETag: '"c"' },
  };
  vi.spyOn(db, 'getPool').mockReturnValue({
    query: async (sql: string, params: any[] = []) => {
      if (/^SELECT s3_key, content_type/.test(sql.trim())) return { rows, rowCount: rows.length };
      if (/^DELETE FROM settlement_evidence/.test(sql.trim())) {
        deleted.push(params[0]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any);
  vi.spyOn(s3, 'send').mockImplementation(async (cmd: any) => {
    if (cmd.constructor.name === 'HeadObjectCommand') return heads[cmd.input.Key] as any;
    puts.push({ key: cmd.input.Key, body: cmd.input.Body });
    return {} as any;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('settlement evidence is what it was declared to be', () => {
  it('the manifest names only objects stored under their row\'s type and inside the cap', async () => {
    const { objects } = await writeEvidenceManifest(
      cfg,
      { id: SID, match_id: 'm', delivery_tracking: null } as any,
      'seller-acct',
    );
    expect(objects.map((o) => o.key)).toEqual(['k/good.jpg']);
    expect(deleted.sort()).toEqual(['k/html.jpg', 'k/huge.png']);
  });

  it('objectAsDeclared refuses a type off the allowlist even when the two agree', () => {
    expect(objectAsDeclared({ ContentType: 'text/html', ContentLength: 10 }, 'text/html')).toBe(false);
    expect(objectAsDeclared({ ContentType: 'IMAGE/JPEG', ContentLength: 10 }, 'image/jpeg')).toBe(true);
    expect(objectAsDeclared({ ContentType: 'image/jpeg' }, 'image/jpeg')).toBe(false);
  });

  it('every view link is served as the row\'s type, inline, under a fixed name', async () => {
    rows = [
      { s3_key: 'k/a.jpg', content_type: 'image/jpeg' },
      { s3_key: 'k/b.webp', content_type: 'image/webp' },
      { s3_key: 'k/c.html', content_type: 'text/html' },
    ];
    const links = await evidenceViewLinks(cfg, SID);
    expect(links).toHaveLength(2);
    expect(signed.map((s) => [s.input.ResponseContentType, s.input.ResponseContentDisposition])).toEqual([
      ['image/jpeg', 'inline; filename="photo.jpg"'],
      ['image/webp', 'inline; filename="photo.webp"'],
    ]);
  });
});
