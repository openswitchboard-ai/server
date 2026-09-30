/**
 * THE BROWSER HALF OF SEALED CONTACT DETAILS (domain/sealedContact.ts).
 *
 * One script, served from this origin at /assets/sealed.js with a Subresource
 * Integrity hash, and never inline. The pages that type or show an address or
 * a phone number carry a stricter policy than the rest of the human pages:
 * `script-src 'self'` with no inline script at all (see app.ts, osbSealedPage),
 * so a stray bit of markup on those pages can never run.
 *
 * THE CRYPTO, in one paragraph. Each browser holds a P-256 key pair made with
 * WebCrypto; the private half is created non-extractable and lives in this
 * origin's IndexedDB, so not even a script on the page can export it. To send,
 * the sender's browser makes a fresh P-256 key for each of the recipient's
 * browser keys, derives a shared secret (ECDH), stretches it with HKDF-SHA-256
 * (salt: both public keys; info: a fixed label), and seals the details with
 * AES-256-GCM, binding the introduction and the key id in as associated data.
 * The plaintext is padded to a multiple of 256 bytes so the length says little.
 * The server only ever sees the result.
 *
 * "REMEMBER ON THIS DEVICE" keeps what was typed in the same IndexedDB,
 * sealed with an AES-GCM key that is itself non-extractable and never leaves
 * the browser. Nothing of it is ever sent anywhere.
 *
 * SEALED_CORE_JS is the crypto alone, with no page in it, so the unit suite
 * runs it under Node's WebCrypto and proves the round trip.
 */
import { createHash } from 'node:crypto';

export const SEALED_CORE_JS = String.raw`
var OSB_SEALED = (function () {
  var LABEL = 'osb-sealed-contact-v1';
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  var EC = { name: 'ECDH', namedCurve: 'P-256' };
  function b64u(buf) {
    var a = new Uint8Array(buf), s = '';
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var b = atob(s), a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a;
  }
  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }
  async function keyIdOf(raw) {
    var d = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
    var h = '';
    for (var i = 0; i < 16; i++) h += ('0' + d[i].toString(16)).slice(-2);
    return h;
  }
  /** A key pair whose private half can never be exported. */
  async function makeKeyPair() {
    var pair = await crypto.subtle.generateKey(EC, false, ['deriveBits']);
    var raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return { privateKey: pair.privateKey, publicRaw: raw, key_id: await keyIdOf(raw) };
  }
  async function aesKey(shared, epkRaw, recipRaw, usage) {
    var hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: concat(epkRaw, recipRaw), info: enc.encode(LABEL + ' aes-256-gcm') },
      hk, { name: 'AES-GCM', length: 256 }, false, [usage]);
  }
  function aad(matchId, keyId) { return enc.encode(LABEL + '|' + matchId + '|' + keyId); }
  /** JSON padded with spaces to a multiple of 256 bytes. */
  function pad(obj) {
    var b = enc.encode(JSON.stringify(obj));
    var n = Math.ceil((b.length + 1) / 256) * 256;
    var out = new Uint8Array(n).fill(0x20);
    out.set(b, 0);
    return out;
  }
  /** One sealed copy of the details, for one of the recipient's browser keys. */
  async function seal(details, recipient, matchId) {
    var recipRaw = unb64u(recipient.public_key);
    var recipKey = await crypto.subtle.importKey('raw', recipRaw, EC, false, []);
    var eph = await crypto.subtle.generateKey(EC, false, ['deriveBits']);
    var epkRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
    var shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipKey }, eph.privateKey, 256);
    var key = await aesKey(shared, epkRaw, recipRaw, 'encrypt');
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aad(matchId, recipient.key_id) }, key, pad(details));
    return { key_id: recipient.key_id, epk: b64u(epkRaw), iv: b64u(iv), ct: b64u(ct) };
  }
  /** The details back out of a copy, with this browser's own private key. */
  async function open(envelope, privateKey, publicRaw, matchId) {
    var epkRaw = unb64u(envelope.epk);
    var epk = await crypto.subtle.importKey('raw', epkRaw, EC, false, []);
    var shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, privateKey, 256);
    var key = await aesKey(shared, epkRaw, publicRaw, 'decrypt');
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(envelope.iv), additionalData: aad(matchId, envelope.key_id) }, key, unb64u(envelope.ct));
    return JSON.parse(dec.decode(pt));
  }
  /** The remembered details, sealed under a device key that never leaves. */
  async function sealLocal(obj, deviceKey) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, deviceKey, pad(obj));
    return { iv: iv, ct: new Uint8Array(ct) };
  }
  async function openLocal(box, deviceKey) {
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, deviceKey, box.ct);
    return JSON.parse(dec.decode(pt));
  }
  async function makeDeviceKey() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  return { b64u: b64u, unb64u: unb64u, keyIdOf: keyIdOf, makeKeyPair: makeKeyPair, seal: seal, open: open,
    sealLocal: sealLocal, openLocal: openLocal, makeDeviceKey: makeDeviceKey };
})();
`;

/** The page half: which page this is decides what runs. */
export const SEALED_PAGE_JS = String.raw`
(function () {
  var root = document.getElementById('sealed');
  if (!root || !window.crypto || !crypto.subtle || !window.indexedDB) {
    var ns = document.getElementById('snoscript');
    if (ns) ns.hidden = false;
    return;
  }
  var S = OSB_SEALED;
  var slot = root.getAttribute('data-slot') || '';
  var mode = root.getAttribute('data-mode');

  function db() {
    return new Promise(function (ok, no) {
      var r = indexedDB.open('osb-sealed', 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('keys')) d.createObjectStore('keys');
        if (!d.objectStoreNames.contains('remember')) d.createObjectStore('remember');
      };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { no(r.error); };
    });
  }
  function tx(store, how, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, no) {
        var t = d.transaction(store, how), st = t.objectStore(store), out;
        var req = fn(st);
        if (req) req.onsuccess = function () { out = req.result; };
        t.oncomplete = function () { ok(out); };
        t.onerror = function () { no(t.error); };
        t.onabort = function () { no(t.error); };
      });
    });
  }
  var get = function (store, k) { return tx(store, 'readonly', function (s) { return s.get(k); }); };
  var put = function (store, k, v) { return tx(store, 'readwrite', function (s) { return s.put(v, k); }); };
  var del = function (store, k) { return tx(store, 'readwrite', function (s) { return s.delete(k); }); };

  async function postJson(url, body) {
    var r = await fetch(url, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body || {}) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.error_description || j.error || ('HTTP ' + r.status)); e.code = j.error; throw e; }
    return j;
  }

  /** This browser's own key for the person signed in, made the first time. */
  async function ensureKey() {
    var k = await get('keys', slot);
    if (!k) {
      var made = await S.makeKeyPair();
      k = { key_id: made.key_id, privateKey: made.privateKey, publicRaw: made.publicRaw };
      await put('keys', slot, k);
    }
    var stamp = 'osb-sealed-touched:' + slot + ':' + k.key_id, last = 0;
    try { last = Number(localStorage.getItem(stamp) || 0); } catch (e) {}
    if (Date.now() - last > 12 * 3600 * 1000) {
      await postJson('/contact-keys', { public_key: S.b64u(k.publicRaw) });
      try { localStorage.setItem(stamp, String(Date.now())); } catch (e) {}
    }
    return k;
  }

  function say(el, text) { if (el) { el.textContent = text; el.hidden = !text; } }
  function showErr(text) {
    var box = document.getElementById('serr');
    if (!box) return;
    box.innerHTML = '';
    if (!text) return;
    var d = document.createElement('div'); d.className = 'err'; d.textContent = text; box.appendChild(d);
  }

  async function passkeyCeremony() {
    var opts = await postJson('/login/passkey/options');
    opts.challenge = S.unb64u(opts.challenge).buffer;
    (opts.allowCredentials || []).forEach(function (c) { c.id = S.unb64u(c.id).buffer; });
    var cred = await navigator.credentials.get({ publicKey: opts });
    await postJson('/login/passkey/verify', { id: cred.id, rawId: S.b64u(cred.rawId), type: cred.type,
      response: { clientDataJSON: S.b64u(cred.response.clientDataJSON),
        authenticatorData: S.b64u(cred.response.authenticatorData),
        signature: S.b64u(cred.response.signature),
        userHandle: cred.response.userHandle ? S.b64u(cred.response.userHandle) : null },
      clientExtensionResults: cred.getClientExtensionResults(), elevate_only: true });
  }

  if (mode === 'keys') { ensureKey().catch(function () {}); return; }

  if (mode === 'send') {
    var form = document.getElementById('sealedForm');
    var addr = document.getElementById('c_address');
    var phone = document.getElementById('c_phone');
    var remember = document.getElementById('c_remember');
    var pinBox = document.getElementById('c_pin');
    var sendBtn = document.getElementById('c_send');
    var pkBtn = document.getElementById('c_passkey');
    var keys = JSON.parse(root.getAttribute('data-keys') || '[]');
    var match = root.getAttribute('data-match');
    var action = root.getAttribute('data-action');
    var needsPasskey = root.getAttribute('data-passkey-only') === '1';
    form.hidden = false;
    ensureKey().catch(function () {});
    // Prefill what this browser was asked to remember, if anything.
    (async function () {
      try {
        var dk = await get('remember', slot + ':key');
        var box = await get('remember', slot + ':data');
        if (!dk || !box) return;
        var d = await S.openLocal(box, dk);
        if (d.address && !addr.value) addr.value = d.address;
        if (d.phone && !phone.value) phone.value = d.phone;
        remember.checked = true;
      } catch (e) {}
    })();

    async function send(viaPasskey) {
      showErr('');
      var a = addr.value.trim(), p = phone.value.trim();
      if (!a && !p) { showErr('Fill in your address, your phone number, or both.'); return; }
      if (a.length > 500 || p.length > 40) { showErr('That is longer than an address or a phone number.'); return; }
      if (!keys.length) { showErr('Their side is not ready to receive yet. Ask your assistant for a fresh page later.'); return; }
      sendBtn.disabled = true; if (pkBtn) pkBtn.disabled = true;
      var old = sendBtn.textContent; sendBtn.textContent = 'Sending…';
      try {
        if (viaPasskey) await passkeyCeremony();
        var details = {}; if (a) details.address = a; if (p) details.phone = p;
        var envelopes = [];
        for (var i = 0; i < keys.length; i++) envelopes.push(await S.seal(details, keys[i], match));
        if (remember.checked) {
          var dk = await get('remember', slot + ':key');
          if (!dk) { dk = await S.makeDeviceKey(); await put('remember', slot + ':key', dk); }
          await put('remember', slot + ':data', await S.sealLocal(details, dk));
        } else {
          await del('remember', slot + ':data'); await del('remember', slot + ':key');
        }
        var body = { decision: 'yes', envelopes: envelopes };
        if (!viaPasskey && pinBox && pinBox.value) body.pin = pinBox.value;
        var done = await postJson(action, body);
        addr.value = ''; phone.value = ''; if (pinBox) pinBox.value = '';
        var page = document.getElementById('page');
        page.innerHTML = '';
        var h = document.createElement('h1'); h.textContent = done.title || 'Sent'; page.appendChild(h);
        (done.lines || []).forEach(function (l) { var q = document.createElement('p'); q.textContent = l; page.appendChild(q); });
        h.setAttribute('tabindex', '-1'); h.focus();
      } catch (e) {
        if (pinBox) pinBox.value = '';
        showErr(e && e.code === 'pin_incorrect' ? 'That PIN is not right. Try again.'
          : e && e.name === 'NotAllowedError' ? "That didn't work. Try again."
          : (e && e.message) || 'That did not go through. Try again.');
        sendBtn.disabled = false; if (pkBtn) pkBtn.disabled = false; sendBtn.textContent = old;
      }
    }
    form.addEventListener('submit', function (ev) { ev.preventDefault(); send(needsPasskey); });
    if (pkBtn) pkBtn.addEventListener('click', function (ev) { ev.preventDefault(); send(true); });
    return;
  }

  if (mode === 'receive') {
    var id = root.getAttribute('data-id');
    var matchId = root.getAttribute('data-match');
    var have = JSON.parse(root.getAttribute('data-keyids') || '[]');
    var ready = document.getElementById('r_ready');
    var nokey = document.getElementById('r_nokey');
    var shown = document.getElementById('r_shown');
    var reveal = document.getElementById('r_reveal');
    (async function () {
      var k;
      try { k = await ensureKey(); } catch (e) { showErr('This browser could not get ready to open it. Try another browser.'); return; }
      if (have.indexOf(k.key_id) === -1) {
        nokey.hidden = false;
        postJson('/c/' + id + '/missed', {}).catch(function () {});
        return;
      }
      ready.hidden = false;
      reveal.addEventListener('click', async function () {
        reveal.disabled = true; showErr('');
        try {
          var got = await postJson('/c/' + id + '/open', { key_id: k.key_id });
          var d = await S.open(got.envelope, k.privateKey, k.publicRaw, matchId);
          ready.hidden = true; shown.hidden = false;
          say(document.getElementById('r_address'), d.address ? String(d.address) : '');
          say(document.getElementById('r_phone'), d.phone ? String(d.phone) : '');
          var lines = [d.address, d.phone].filter(Boolean).join('\n');
          var copy = document.getElementById('r_copy');
          if (copy && navigator.clipboard) {
            copy.hidden = false;
            copy.addEventListener('click', function () {
              navigator.clipboard.writeText(lines).then(function () { copy.textContent = 'Copied'; }, function () {});
            });
          }
        } catch (e) {
          showErr((e && e.message) || 'It did not open. Ask them to send it again.');
        }
      });
    })();
  }
})();
`;

/** The whole script as served. */
export const SEALED_JS = `${SEALED_CORE_JS}\n${SEALED_PAGE_JS}`;

/** Subresource Integrity for the served script. */
export const SEALED_JS_SRI = `sha384-${createHash('sha384').update(SEALED_JS, 'utf8').digest('base64')}`;

/** A short version so a new deploy is a new URL and no stale copy fails SRI. */
export const SEALED_JS_VERSION = createHash('sha256').update(SEALED_JS, 'utf8').digest('hex').slice(0, 12);

export const SEALED_JS_PATH = '/assets/sealed.js';

/** The tag every page that uses it carries. */
export const sealedScriptTag = (): string =>
  `<script src="${SEALED_JS_PATH}?v=${SEALED_JS_VERSION}" integrity="${SEALED_JS_SRI}" crossorigin="anonymous" defer></script>`;
