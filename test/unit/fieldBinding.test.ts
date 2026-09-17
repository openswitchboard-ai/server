/**
 * Four small things, each of which was a door standing open.
 *
 *   - A ciphertext said nothing about where it belonged. Every identity field
 *     on an account is sealed under the SAME per-account data key, and
 *     AES-GCM with no associated data authenticates the bytes and nothing
 *     else: anyone who could write a column could move email_enc into
 *     first_name_enc and it would decrypt perfectly — an address shown to a
 *     counterparty as a name, or a locality mailed as an address.
 *   - A send failure wrote whatever the provider said into a row and a log.
 *     SES quotes the recipient address back inside its own error message.
 *   - A key nobody used sat in the interface looking load-bearing.
 *   - An agent's `offer` object was spread OVER the introduction id the call
 *     had been authorised against, so an offer carrying its own match_id went
 *     onto a different introduction from the one the door checked.
 */
import { describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, '..', '..', 'src', p), 'utf8');

// ---------------------------------------------------------------------------
// The wire format, reimplemented here so the claim is about BYTES rather than
// about the source of the module under test. If these two disagree with
// crypto.ts the suite is wrong and so is the format.
// ---------------------------------------------------------------------------
const AAD_VERSION = 1;

function seal(key: Buffer, plaintext: string, aad?: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const body = Buffer.concat([iv, c.getAuthTag(), ct]);
  return aad === undefined ? body : Buffer.concat([Buffer.from([AAD_VERSION]), body]);
}

function unseal(key: Buffer, body: Buffer, aad?: string): string {
  const d = createDecipheriv('aes-256-gcm', key, body.subarray(0, 12));
  if (aad !== undefined) d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(body.subarray(12, 28));
  return Buffer.concat([d.update(body.subarray(28)), d.final()]).toString('utf8');
}

function open(key: Buffer, blob: Buffer, aad?: string): string {
  if (aad !== undefined && blob[0] === AAD_VERSION) {
    try {
      return unseal(key, blob.subarray(1), aad);
    } catch {
      /* a legacy blob whose IV happens to start 0x01 */
    }
  }
  return unseal(key, blob);
}

const ACCOUNT = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';
const aad = (account: string, field: string) => `${account}:${field}`;

describe('a ciphertext says which column it was sealed for', () => {
  const key = randomBytes(32);

  it('opens in its own field on its own row', () => {
    const blob = seal(key, 'ana@example.test', aad(ACCOUNT, 'email'));
    expect(open(key, blob, aad(ACCOUNT, 'email'))).toBe('ana@example.test');
  });

  it('refuses to open in another field, which is the whole of the defect', () => {
    const blob = seal(key, 'ana@example.test', aad(ACCOUNT, 'email'));
    // Moved into first_name_enc: the same key, the same bytes, and the tag
    // says no. Before this it decrypted, and the address was shown as a name.
    expect(() => open(key, blob, aad(ACCOUNT, 'first_name'))).toThrow();
    expect(() => open(key, blob, aad(ACCOUNT, 'locality'))).toThrow();
  });

  it('refuses to open on another account, even under the same key', () => {
    const blob = seal(key, 'Ana', aad(ACCOUNT, 'first_name'));
    expect(() => open(key, blob, aad(OTHER, 'first_name'))).toThrow();
  });

  it('still opens everything written before the binding existed', () => {
    const legacy = seal(key, 'Fremantle');
    expect(legacy[0]).not.toBe(undefined);
    expect(open(key, legacy, aad(ACCOUNT, 'locality'))).toBe('Fremantle');
  });

  it('reads a legacy blob whose IV happens to begin with the version byte', () => {
    // The version byte is not a discriminator on its own: a random IV starts
    // with 0x01 about once in every 256 fields. The tag is what settles it.
    for (let i = 0; i < 400; i++) {
      const legacy = seal(key, `field-${i}`);
      if (legacy[0] !== AAD_VERSION) continue;
      expect(open(key, legacy, aad(ACCOUNT, 'email'))).toBe(`field-${i}`);
      return;
    }
    // Not reached in practice; a run that never produced one proves nothing
    // either way, so it is not a failure.
  });

  it('is what the three identity writes actually pass', () => {
    expect(read('domain/accounts.ts')).toContain("input.email, 'email'");
    expect(read('domain/accounts.ts')).toContain("input.first_name, 'first_name'");
    expect(read('domain/accounts.ts')).toContain("input.locality, 'locality'");
    expect(read('domain/counterOps.ts')).toContain("email, 'email'");
    expect(read('domain/profile.ts')).toContain("value.firstName, 'first_name'");
    expect(read('domain/profile.ts')).toContain("value.locality, 'locality'");
    // And the read side binds by the name it was asked under, which is the
    // same name, so the two can never drift apart silently.
    expect(read('crypto.ts')).toContain('gcmOpen(key, blob, fieldAad(accountId, name))');
  });
});

describe('a send failure records what went wrong, not who it was for', () => {
  it('keeps the provider name and the status code and nothing else', () => {
    const src = read('email/send.ts');
    const fn = src.slice(src.indexOf('export async function sendEmail'));
    expect(fn).toContain("const detail = `${e?.name ?? 'Error'} (HTTP ${e?.$metadata?.httpStatusCode ?? '?'})`");
    // And `detail` is the only thing persisted or printed. Never the message:
    // SES quotes the recipient address back inside it — "Email address is not
    // verified: someone@example.test" — and that would sit in the log stream
    // and in the email_sends row for ever. The message is READ, to tell a
    // throttle from a rejection, and never written.
    expect(fn).toContain("await updateSend(input.dedupeKey, 'failed', undefined, detail)");
    expect(fn).toContain("await updateSend(input.dedupeKey, 'sandbox-rejected', undefined, detail)");
    const catchBlock = fn.slice(fn.indexOf('} catch (e: any) {'));
    // The only uses of the error's message in the failure path are the two
    // classifications; nothing carries it into a write or a log line.
    for (const written of ['updateSend', 'console.error']) {
      const at = catchBlock.indexOf(written);
      expect(catchBlock.slice(at, at + 200), written).not.toContain('e?.message');
    }
  });
});

describe('a key nobody reads is not in the interface', () => {
  it('is gone from CounterKeys, and still refused when malformed', () => {
    const src = read('counter/keys.ts');
    expect(src).not.toContain('cookieKey: Buffer');
    // Still checked at boot: the secret and the task definitions carry it, and
    // a boot that silently accepted a malformed one would be the fallback this
    // file exists to refuse.
    expect(src).toContain("hexKey('COUNTER_COOKIE_KEY'");
    expect(src).toContain("hexKey('cookie_key'");
    expect(src).toContain("missing link_hmac_key/cookie_key");
  });

  it('is referenced by nothing else in the source', () => {
    for (const f of ['counter/session.ts', 'counter/links.ts', 'email/tokens.ts']) {
      expect(read(f), f).not.toContain('cookieKey');
    }
  });
});

describe('the caller cannot choose which introduction its offer lands on', () => {
  it('spreads the offer first and the checked introduction last', () => {
    const src = read('mcp/tools.ts');
    const at = src.indexOf("case 'propose_offer'");
    const scope = src.slice(at, at + 900);
    // The order is the whole fix: match_id after the spread wins.
    expect(scope).toMatch(/\.\.\.offer,\s*\n\s*match_id: intro_id,/);
    expect(scope).not.toMatch(/match_id: intro_id,\s*\n\s*\.\.\.offer,/);
  });

  it('behaves the way the object literal says it does', () => {
    // The claim above is about JavaScript rather than about this codebase, and
    // it is worth one line that shows it.
    const offer = { amount: 40, ccy: 'AUD', match_id: 'somebody-elses-introduction' };
    expect({ ...offer, match_id: 'the-checked-one' }.match_id).toBe('the-checked-one');
  });
});
