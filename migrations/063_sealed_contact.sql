-- SEALED CONTACT DETAILS (1 October 2026; src/domain/sealedContact.ts).
--
-- An address or a phone number goes from one person's browser to the other
-- person's browser, scrambled so only the recipient's browser can read it.
-- Neither assistant ever sees it, and this database never holds it readably.
--
-- 1. THE RECIPIENT KEYS. Each signed-in browser makes its own P-256 key pair
-- with WebCrypto. The private half is made non-extractable and stays in that
-- browser's IndexedDB; only the public half comes here, tied to the account.
-- One row per account and browser. key_id is the first 32 hex characters of
-- the SHA-256 of the raw public key, worked out here from the bytes rather
-- than taken from the browser. A handful per account at most: the oldest is
-- dropped when a new browser arrives past the cap.
CREATE TABLE IF NOT EXISTS contact_keys (
  account_id   uuid        NOT NULL REFERENCES accounts(id),
  key_id       text        NOT NULL CHECK (key_id ~ '^[0-9a-f]{32}$'),
  public_key   bytea       NOT NULL CHECK (octet_length(public_key) = 65),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key_id)
);
COMMENT ON TABLE contact_keys IS
  'Public halves of the per-browser keys that sealed contact details are scrambled to. The private halves never leave the browser. Safe to hold: a public key opens nothing.';

-- 2. ONE SEND. Who sent to whom on which introduction, and when. It never
-- holds the details themselves, readable or otherwise: the scrambled copies
-- live in the next table and are deleted the moment one is opened.
CREATE TABLE IF NOT EXISTS sealed_contacts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id          uuid        NOT NULL REFERENCES matches(id),
  sender_account    uuid        NOT NULL REFERENCES accounts(id),
  recipient_account uuid        NOT NULL REFERENCES accounts(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  -- Set the moment the recipient's page takes its scrambled copy. The copies
  -- are deleted in the same statement.
  opened_at         timestamptz,
  -- Set when the recipient opened the page on a browser holding no key the
  -- details were scrambled to. The sender's side is told so it can send again.
  missed_at         timestamptz,
  -- Set when a newer send on the same introduction replaced this one.
  replaced_at       timestamptz
);
CREATE INDEX IF NOT EXISTS sealed_contacts_recipient_idx
  ON sealed_contacts (recipient_account, match_id) WHERE opened_at IS NULL;
CREATE INDEX IF NOT EXISTS sealed_contacts_expires_idx ON sealed_contacts (expires_at);
COMMENT ON TABLE sealed_contacts IS
  'One row per contact-details send: who, to whom, on which introduction, when. Never the details. Swept a day after expiry.';

-- 3. THE SCRAMBLED COPIES, one per recipient key. ECDH P-256 with a fresh
-- key per copy, HKDF-SHA-256, AES-256-GCM. This server has no private key
-- that opens any of them. Deleted when the recipient opens one, and by the
-- ttl-expiry sweep at seven days otherwise.
CREATE TABLE IF NOT EXISTS sealed_contact_copies (
  sealed_id  uuid  NOT NULL REFERENCES sealed_contacts(id) ON DELETE CASCADE,
  key_id     text  NOT NULL CHECK (key_id ~ '^[0-9a-f]{32}$'),
  epk        bytea NOT NULL CHECK (octet_length(epk) = 65),
  iv         bytea NOT NULL CHECK (octet_length(iv) = 12),
  ct         bytea NOT NULL CHECK (octet_length(ct) BETWEEN 17 AND 8208),
  PRIMARY KEY (sealed_id, key_id)
);
COMMENT ON TABLE sealed_contact_copies IS
  'Scrambled contact details, readable only by the recipient''s own browser. Deleted on open, or at seven days.';

-- 4. The send page is a link action like every other page a human presses,
-- so the check on approval_links.action learns its name. Rewritten in full, as
-- 049 did; test/unit/linkActionsMigrated.test.ts holds this list to the one in
-- src/counter/links.ts.
ALTER TABLE approval_links DROP CONSTRAINT IF EXISTS approval_links_action_check;
ALTER TABLE approval_links ADD CONSTRAINT approval_links_action_check
  CHECK (action IN (
    'offer-accept',
    'stage3-disclosure',
    'settlement-approve',
    'offer-send',
    'collection-close',
    'negotiation-auto',
    'conversation-photo',
    'report',
    'conversation-renew',
    'shelf-pick',
    'contact-send'
  ));
