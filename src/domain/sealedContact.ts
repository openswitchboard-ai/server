/**
 * SEALED CONTACT DETAILS (1 October 2026).
 *
 * The goal, in one line: an address or a phone number goes from one person to
 * the other without either assistant ever seeing it, and without this server
 * ever holding it readably.
 *
 * HOW IT WORKS.
 *
 *  1. Every browser a person signs in on makes its own P-256 key pair with
 *     WebCrypto (counter/sealedScript.ts). The private half is created
 *     non-extractable and kept in that browser's IndexedDB; the public half is
 *     registered here, against the account. registerContactKey below.
 *
 *  2. The sender's assistant fetches a page (respond(request_send_contact),
 *     domain/humanLinks.ts). On it the SENDER types their details into boxes
 *     that have no form names, so nothing readable is ever submitted. Their
 *     browser scrambles the details once for each of the recipient's public
 *     keys — a fresh ECDH key per copy, HKDF-SHA-256, AES-256-GCM, with the
 *     introduction and the key id bound in as associated data — and posts only
 *     the scrambled copies. assertSealedBody refuses anything else outright.
 *
 *  3. The recipient's assistant is told a page is waiting (check_in,
 *     collect_messages). The page is the recipient's own, signed in as the
 *     person: no assistant holds that session. Their browser asks for the copy
 *     made for its own key, and the server hands it over and deletes every copy
 *     in the same statement (openSealed). The browser unscrambles it and shows
 *     it once. Unopened copies go at seven days on the ttl-expiry sweep.
 *
 * WHAT THIS SERVER KNOWS: who sent contact details to whom, on which
 * introduction, and when (and the safety ledger records the same, for thirty
 * days). It never knows what they were.
 *
 * WHAT IT CANNOT PROMISE, said plainly for whoever reads this next: the page
 * that does the scrambling is served by this server. A server changed to lie
 * could serve a page that does something else. What this design removes is the
 * readable copy: nothing here, in the logs, in either assistant or in a backup
 * holds the details, so there is nothing to leak, subpoena or read later.
 */
import { createHash, webcrypto } from 'node:crypto';
import { getPool } from '../db.js';

/** How long a scrambled copy waits to be opened. */
export const SEALED_TTL_DAYS = 7;
/** The row saying a send happened outlives its copies by this much, so the
 *  sender's side can still be told the recipient could not open it. */
export const SEALED_ROW_GRACE_DAYS = 1;
/** Browsers per account. A new one past this drops the least recently seen. */
export const MAX_KEYS_PER_ACCOUNT = 6;
/** Copies per send: one per recipient browser, never more than the cap. */
export const MAX_COPIES = MAX_KEYS_PER_ACCOUNT;
/** Largest scrambled copy accepted, in bytes (the plaintext is padded to a
 *  multiple of 256 and capped at 8 KiB on the page; +16 for the GCM tag). */
export const MAX_CT_BYTES = 8192 + 16;

/** Associated data every copy is bound to. The page builds the same string. */
export const SEALED_AAD_PREFIX = 'osb-sealed-contact-v1';
export const sealedAad = (matchId: string, keyId: string): string =>
  `${SEALED_AAD_PREFIX}|${matchId}|${keyId}`;

const B64U_RE = /^[A-Za-z0-9_-]+$/;

export class SealedRefusal extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SealedRefusal';
  }
}

function b64uToBytes(s: unknown, what: string): Buffer {
  if (typeof s !== 'string' || !s || s.length > 12_000 || !B64U_RE.test(s)) {
    throw new SealedRefusal('bad_envelope', `${what} is not scrambled data`);
  }
  return Buffer.from(s, 'base64url');
}

/** The id of a public key: the first 32 hex characters of its SHA-256. */
export function keyIdOf(raw: Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * The per-account slot a browser files its key under, so two people sharing a
 * browser do not share a key. Not a secret: it only says which of the keys in
 * this browser belongs to the person signed in.
 */
export function keySlot(accountId: string): string {
  return createHash('sha256').update(`osb-contact-slot|${accountId}`).digest('hex').slice(0, 24);
}

/** A raw public key that really is a point on P-256, or a refusal. */
export async function checkPublicKey(b64u: unknown): Promise<Buffer> {
  const raw = b64uToBytes(b64u, 'the key');
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new SealedRefusal('bad_key', 'the key is not a P-256 public key');
  }
  try {
    await webcrypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  } catch {
    throw new SealedRefusal('bad_key', 'the key is not a P-256 public key');
  }
  return raw;
}

/** Register (or touch) one browser's public key for this account. */
export async function registerContactKey(
  accountId: string,
  publicKey: unknown,
): Promise<{ key_id: string }> {
  const raw = await checkPublicKey(publicKey);
  const keyId = keyIdOf(raw);
  const pool = getPool();
  await pool.query(
    `INSERT INTO contact_keys (account_id, key_id, public_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id, key_id) DO UPDATE SET last_seen_at = now()`,
    [accountId, keyId, raw],
  );
  // The cap: the least recently seen browsers past it are forgotten.
  await pool.query(
    `DELETE FROM contact_keys WHERE account_id = $1 AND key_id IN (
       SELECT key_id FROM contact_keys WHERE account_id = $1
        ORDER BY last_seen_at DESC OFFSET $2)`,
    [accountId, MAX_KEYS_PER_ACCOUNT],
  );
  return { key_id: keyId };
}

export interface PublicContactKey {
  key_id: string;
  /** base64url of the 65-byte uncompressed point. */
  public_key: string;
}

/** Every browser key this account has registered, newest first. */
export async function contactKeysFor(accountId: string): Promise<PublicContactKey[]> {
  const r = await getPool().query(
    `SELECT key_id, public_key FROM contact_keys WHERE account_id = $1
      ORDER BY last_seen_at DESC LIMIT $2`,
    [accountId, MAX_KEYS_PER_ACCOUNT],
  );
  return r.rows.map((row: any) => ({
    key_id: String(row.key_id),
    public_key: Buffer.from(row.public_key).toString('base64url'),
  }));
}

export interface Envelope {
  key_id: string;
  epk: Buffer;
  iv: Buffer;
  ct: Buffer;
}

/** The only fields a send may carry. Anything else is refused unread. */
const SEND_FIELDS = new Set(['decision', 'pin', 'envelopes']);
const ENVELOPE_FIELDS = new Set(['key_id', 'epk', 'iv', 'ct']);

/**
 * Bytes that read as ordinary text are not ciphertext. AES-GCM output is
 * uniformly random, so a copy of any real length is almost never mostly
 * printable; a string of words that somebody base64-encoded is.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length < 24) return false;
  let printable = 0;
  for (const b of bytes) if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09) printable++;
  return printable / bytes.length > 0.85;
}

/**
 * THE DOOR THAT REFUSES PLAINTEXT. A send carries a decision, the PIN where
 * one is typed, and scrambled copies addressed to keys the recipient really
 * has. Any other field — an `address`, a `phone`, anything at all — is refused
 * before anything is stored or read, and the refusal names the rule and never
 * the value. Nothing here is logged.
 */
export function assertSealedBody(
  body: unknown,
  recipientKeyIds: readonly string[],
): { envelopes: Envelope[]; pin: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SealedRefusal('bad_request', 'a send is a JSON object');
  }
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!SEND_FIELDS.has(k)) {
      throw new SealedRefusal('plaintext_refused', 'only scrambled copies are accepted here');
    }
  }
  if (b.decision !== 'yes') throw new SealedRefusal('bad_request', 'a send says yes');
  const pin = b.pin === undefined ? '' : typeof b.pin === 'string' ? b.pin : '';
  if (pin && !/^[0-9]{6,12}$/.test(pin)) throw new SealedRefusal('bad_request', 'a PIN is digits');
  const list = b.envelopes;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_COPIES) {
    throw new SealedRefusal('bad_envelope', 'a send carries one scrambled copy per device');
  }
  const known = new Set(recipientKeyIds);
  const seen = new Set<string>();
  const envelopes: Envelope[] = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new SealedRefusal('bad_envelope', 'a copy is an object');
    }
    for (const k of Object.keys(e)) {
      if (!ENVELOPE_FIELDS.has(k)) {
        throw new SealedRefusal('plaintext_refused', 'only scrambled copies are accepted here');
      }
    }
    const env = e as Record<string, unknown>;
    const keyId = typeof env.key_id === 'string' ? env.key_id : '';
    if (!/^[0-9a-f]{32}$/.test(keyId) || !known.has(keyId) || seen.has(keyId)) {
      throw new SealedRefusal('unknown_key', 'a copy is for a device the recipient does not have');
    }
    seen.add(keyId);
    const epk = b64uToBytes(env.epk, 'a copy');
    const iv = b64uToBytes(env.iv, 'a copy');
    const ct = b64uToBytes(env.ct, 'a copy');
    if (epk.length !== 65 || epk[0] !== 0x04) throw new SealedRefusal('bad_envelope', 'a copy is malformed');
    if (iv.length !== 12) throw new SealedRefusal('bad_envelope', 'a copy is malformed');
    if (ct.length < 17 || ct.length > MAX_CT_BYTES) {
      throw new SealedRefusal('bad_envelope', 'a copy is the wrong size');
    }
    if (looksLikeText(ct)) {
      throw new SealedRefusal('plaintext_refused', 'only scrambled copies are accepted here');
    }
    envelopes.push({ key_id: keyId, epk, iv, ct });
  }
  return { envelopes, pin };
}

/**
 * Store one send. A newer send on the same introduction to the same person
 * replaces an older one nobody has opened: its copies go now.
 */
export async function storeSealed(input: {
  matchId: string;
  senderAccount: string;
  recipientAccount: string;
  envelopes: Envelope[];
}): Promise<{ id: string; expires_at: Date }> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const older = await client.query(
      `UPDATE sealed_contacts SET replaced_at = now()
        WHERE match_id = $1 AND sender_account = $2 AND recipient_account = $3
          AND opened_at IS NULL AND replaced_at IS NULL
        RETURNING id`,
      [input.matchId, input.senderAccount, input.recipientAccount],
    );
    if (older.rowCount) {
      await client.query('DELETE FROM sealed_contact_copies WHERE sealed_id = ANY($1::uuid[])', [
        older.rows.map((r: any) => r.id),
      ]);
    }
    const r = await client.query(
      `INSERT INTO sealed_contacts (match_id, sender_account, recipient_account, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => ${SEALED_TTL_DAYS}))
       RETURNING id, expires_at`,
      [input.matchId, input.senderAccount, input.recipientAccount],
    );
    const id = String(r.rows[0].id);
    for (const e of input.envelopes) {
      await client.query(
        `INSERT INTO sealed_contact_copies (sealed_id, key_id, epk, iv, ct) VALUES ($1,$2,$3,$4,$5)`,
        [id, e.key_id, e.epk, e.iv, e.ct],
      );
    }
    await client.query('COMMIT');
    return { id, expires_at: r.rows[0].expires_at };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface SealedRow {
  id: string;
  match_id: string;
  sender_account: string;
  recipient_account: string;
  created_at: Date;
  expires_at: Date;
  opened_at: Date | null;
  missed_at: Date | null;
  replaced_at: Date | null;
}

/** One send, as its recipient may see it, or nothing. */
export async function sealedForRecipient(
  recipientAccount: string,
  id: string,
): Promise<(SealedRow & { key_ids: string[] }) | undefined> {
  const r = await getPool().query(
    `SELECT s.*, COALESCE(array_agg(c.key_id) FILTER (WHERE c.key_id IS NOT NULL), '{}') AS key_ids
       FROM sealed_contacts s
       JOIN matches m ON m.id = s.match_id AND m.state IN ('open', 'archived')
       LEFT JOIN sealed_contact_copies c ON c.sealed_id = s.id
      WHERE s.id = $1 AND s.recipient_account = $2
      GROUP BY s.id`,
    [id, recipientAccount],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  return { ...row, key_ids: (row.key_ids ?? []) as string[] };
}

export type SealedState = 'waiting' | 'opened' | 'expired' | 'replaced' | 'gone';

export function sealedState(row: SealedRow & { key_ids: string[] }, now = new Date()): SealedState {
  if (row.opened_at) return 'opened';
  if (row.replaced_at) return 'replaced';
  if (new Date(row.expires_at).getTime() <= now.getTime()) return 'expired';
  if (!row.key_ids.length) return 'gone';
  return 'waiting';
}

/**
 * THE ONE READ, AND THE DELETE IN THE SAME BREATH. The copy made for this
 * browser's key is handed over and every copy of this send is deleted in the
 * same transaction, so a second open finds nothing and the database holds no
 * copy from this moment on. Where this browser holds none of the keys the
 * details were scrambled to, nothing is deleted: another of the person's
 * devices may still open it.
 */
export async function openSealed(
  recipientAccount: string,
  id: string,
  keyId: string,
): Promise<
  | { ok: true; envelope: { key_id: string; epk: string; iv: string; ct: string }; match_id: string }
  | { ok: false; reason: 'not_found' | 'opened' | 'expired' | 'no_key' }
> {
  if (!/^[0-9a-f]{32}$/.test(keyId)) return { ok: false, reason: 'no_key' };
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // The introduction has to still stand: one closed by a report or a
    // decline opens nothing, so a reporter's details never reach the person
    // they reported.
    const s = await client.query(
      `SELECT s.* FROM sealed_contacts s JOIN matches m ON m.id = s.match_id
        WHERE s.id = $1 AND s.recipient_account = $2 AND m.state IN ('open', 'archived')
        FOR UPDATE OF s`,
      [id, recipientAccount],
    );
    const row = s.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (row.opened_at || row.replaced_at) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'opened' };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'expired' };
    }
    const c = await client.query(
      `SELECT key_id, epk, iv, ct FROM sealed_contact_copies WHERE sealed_id = $1 AND key_id = $2`,
      [id, keyId],
    );
    const copy = c.rows[0];
    if (!copy) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'no_key' };
    }
    await client.query('DELETE FROM sealed_contact_copies WHERE sealed_id = $1', [id]);
    await client.query('UPDATE sealed_contacts SET opened_at = now() WHERE id = $1', [id]);
    await client.query('COMMIT');
    return {
      ok: true,
      match_id: String(row.match_id),
      envelope: {
        key_id: String(copy.key_id),
        epk: Buffer.from(copy.epk).toString('base64url'),
        iv: Buffer.from(copy.iv).toString('base64url'),
        ct: Buffer.from(copy.ct).toString('base64url'),
      },
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** The recipient opened the page on a browser that holds none of the keys. */
export async function markMissed(recipientAccount: string, id: string): Promise<void> {
  await getPool().query(
    `UPDATE sealed_contacts SET missed_at = COALESCE(missed_at, now())
      WHERE id = $1 AND recipient_account = $2 AND opened_at IS NULL`,
    [id, recipientAccount],
  );
}

export interface SweepContact {
  /** For the recipient: a page is waiting. */
  waiting?: { id: string; sender_account: string; expires_at: Date };
  /** For the sender: the other person could not open the last one. */
  missed?: { id: string; recipient_account: string };
}

/**
 * What a sweep says about contact details on these introductions, for this
 * account: a page waiting for them, or a send of theirs the other side could
 * not open. One query for the whole sweep.
 */
export async function contactsForSweep(
  accountId: string,
  matchIds: readonly string[],
): Promise<Map<string, SweepContact>> {
  const out = new Map<string, SweepContact>();
  if (!matchIds.length) return out;
  const r = await getPool().query(
    `SELECT s.id, s.match_id, s.sender_account, s.recipient_account, s.expires_at, s.missed_at
       FROM sealed_contacts s
       JOIN matches m ON m.id = s.match_id AND m.state IN ('open', 'archived')
      WHERE s.match_id = ANY($2::uuid[])
        AND (s.recipient_account = $1 OR s.sender_account = $1)
        AND s.opened_at IS NULL AND s.replaced_at IS NULL AND s.expires_at > now()
        AND EXISTS (SELECT 1 FROM sealed_contact_copies c WHERE c.sealed_id = s.id)
      ORDER BY s.created_at DESC`,
    [accountId, matchIds],
  );
  for (const row of r.rows as any[]) {
    const m = String(row.match_id);
    const entry = out.get(m) ?? {};
    if (row.recipient_account === accountId && !entry.waiting) {
      entry.waiting = { id: String(row.id), sender_account: String(row.sender_account), expires_at: row.expires_at };
    }
    if (row.sender_account === accountId && row.missed_at && !entry.missed) {
      entry.missed = { id: String(row.id), recipient_account: String(row.recipient_account) };
    }
    out.set(m, entry);
  }
  return out;
}

/** Every page waiting for this account, for its main page. */
export async function contactsWaitingFor(
  accountId: string,
): Promise<{ id: string; match_id: string; sender_account: string; category: string; expires_at: Date }[]> {
  const r = await getPool().query(
    `SELECT s.id, s.match_id, s.sender_account, s.expires_at, m.category
       FROM sealed_contacts s JOIN matches m ON m.id = s.match_id AND m.state IN ('open', 'archived')
      WHERE s.recipient_account = $1 AND s.opened_at IS NULL AND s.replaced_at IS NULL
        AND s.expires_at > now()
        AND EXISTS (SELECT 1 FROM sealed_contact_copies c WHERE c.sealed_id = s.id)
      ORDER BY s.created_at DESC LIMIT 20`,
    [accountId],
  );
  return r.rows.map((row: any) => ({
    id: String(row.id),
    match_id: String(row.match_id),
    sender_account: String(row.sender_account),
    category: String(row.category),
    expires_at: row.expires_at,
  }));
}

/**
 * The ttl-expiry sweep. Scrambled copies past their seven days go; the rows
 * that only say a send happened go a day after that. Counts only: the sweep
 * never looks at what it deletes, and could not read it if it did.
 */
export async function sweepSealedContacts(): Promise<{ copies: number; sends: number }> {
  const pool = getPool();
  const c = await pool.query(
    `DELETE FROM sealed_contact_copies WHERE sealed_id IN (
       SELECT id FROM sealed_contacts WHERE expires_at <= now())`,
  );
  const s = await pool.query(
    `DELETE FROM sealed_contacts
      WHERE expires_at <= now() - make_interval(days => ${SEALED_ROW_GRACE_DAYS})`,
  );
  return { copies: c.rowCount ?? 0, sends: s.rowCount ?? 0 };
}

/** Everything of one account's, on deletion: its keys and every send either way. */
export const ACCOUNT_DELETION_SQL = [
  'DELETE FROM contact_keys WHERE account_id = $1',
  `DELETE FROM sealed_contact_copies WHERE sealed_id IN (
     SELECT id FROM sealed_contacts WHERE sender_account = $1 OR recipient_account = $1)`,
  `UPDATE sealed_contacts SET expires_at = now()
    WHERE (sender_account = $1 OR recipient_account = $1) AND expires_at > now()`,
] as const;

/** The ready sentence for the human whose page is waiting. */
export function contactWaitingSay(who: string, link: string): string {
  const name = who ? `${who[0].toUpperCase()}${who.slice(1)}` : 'The other person';
  return `${name} has sent you their contact details. Here is your page. It shows them once, so have somewhere to write them down: ${link}`;
}

/** What the sender's agent is told when the other side could not open them. */
export function contactMissedNote(who: string): string {
  const name = who ? `${who[0].toUpperCase()}${who.slice(1)}` : 'The other person';
  return `${name} could not open your human's contact details on the browser they used. If your human still wants them to have them, fetch respond(request_send_contact) and hand over a fresh page.`;
}

/**
 * THE SWEEP'S PART (check_in). Each introduction with a page waiting for this
 * human carries `contact_details` — the page, the ready sentence for the human
 * and the lane's sentence for the agent — and the ready sentence leads the
 * entry's note, the way unread words do. A send of theirs the other side could
 * not open carries the sentence to offer a fresh page.
 */
export async function attachContactsToSweep(
  cfg: { counterOrigin: string },
  accountId: string,
  entries: any[],
  facts: { arrangement: any; hearsVia: any },
): Promise<void> {
  const ids = entries.map((m) => m?.intro_id).filter((id: unknown): id is string => typeof id === 'string');
  const found = await contactsForSweep(accountId, ids);
  if (!found.size) return;
  const { disclosedFirstName } = await import('./counterOps.js');
  const { sayFor } = await import('./lanes.js');
  for (const m of entries) {
    const c = found.get(m?.intro_id);
    if (!c) continue;
    const out: Record<string, unknown> = {};
    if (c.waiting) {
      const who =
        (await disclosedFirstName(accountId, c.waiting.sender_account, { match_id: m.intro_id }, 'contact-sweep')) ??
        '';
      const link = `${cfg.counterOrigin}/c/${c.waiting.id}`;
      const said = contactWaitingSay(who, link);
      out.waiting = true;
      out.link = link;
      out.say = said;
      out.note = {
        text: sayFor('contact_waiting', facts.arrangement, {
          hearsVia: facts.hearsVia,
          ...(who ? { who: `${who[0].toUpperCase()}${who.slice(1)}` } : {}),
        }),
        provenance: 'switchboard-system',
      };
      const behind = typeof m.note?.text === 'string' ? ` ${m.note.text}` : '';
      m.note = { text: `${said}${behind}`, provenance: 'switchboard-system' };
    }
    if (c.missed) {
      const who =
        (await disclosedFirstName(accountId, c.missed.recipient_account, { match_id: m.intro_id }, 'contact-sweep')) ??
        '';
      out.could_not_open = true;
      out.missed_note = { text: contactMissedNote(who), provenance: 'switchboard-system' };
    }
    m.contact_details = out;
  }
}
