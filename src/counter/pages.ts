/**
 * The approval pages — server-rendered HTML, no framework, no build step.
 *
 * PHONE FIRST. Almost everyone who lands here has tapped a link in an email on
 * a phone, and they are here to make one decision. So every page in this file
 * follows the same shape:
 *
 *   ask → act → detail
 *
 * The ask is one short heading saying what is being decided. The act is one or
 * two full-width buttons, close enough to the top of a 375px screen that the
 * thumb reaches them without a scroll. The supporting detail sits underneath,
 * and anything that is genuinely secondary goes inside a <details>.
 *
 * The visual system lives in one CSS block below: a spacing scale, a type
 * scale, one accent (Patch's purple), and four buttons — primary, secondary,
 * approve and danger. Every page shares the same header and the same footer,
 * and the header carries Patch himself (see patchAsset.ts) rather than an
 * emoji standing in for him.
 *
 * Brand: Sora (display) / Newsreader (body) / IBM Plex Mono (data), light and
 * dark both designed, aligned with the public site's tokens.
 */
import { MANDATE_NOTE_MAX } from '../domain/negotiation.js';

export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export const CONSENT_STATEMENT =
  'My agent may store wants & haves as cards on my behalf. I can see, edit, or withdraw everything on my approval page.';

/** Where the two Patch images are served from. Long-cached and immutable. */
export const PATCH_HEADER_URL = '/assets/patch.png';
export const PATCH_FAVICON_URL = '/assets/favicon.png';

const CSS = `
:root {
  /* Palette — the public site's tokens, light first. */
  --paper:#F6F8F7; --ink:#1C2523; --line:#D3DBD8; --wash:#ECEFEE;
  --want:#B45309; --have:#0E7268; --accent:#6D28D9; --match:#6D28D9;
  --muted:#5C6A66; --card:#FFFFFF; --danger:#A3271F;
  --on-solid:#FFFFFF;
  /* Spacing scale. */
  --s1:.25rem; --s2:.5rem; --s3:.75rem; --s4:1rem; --s5:1.5rem; --s6:2rem; --s7:3rem;
  /* Type scale. */
  --t-xs:.78rem; --t-sm:.88rem; --t-md:1rem; --t-lg:1.18rem; --t-xl:1.5rem; --t-2xl:1.9rem;
  /* Shape. */
  --r-sm:10px; --r:14px; --r-pill:999px;
  --sans:'Sora',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
  --serif:'Newsreader',ui-serif,Georgia,'Times New Roman',serif;
  --mono:'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper:#101614; --ink:#E6ECE9; --line:#2A3733; --wash:#141C19;
    --want:#E0A24A; --have:#45B8A9; --accent:#A78BFA; --match:#A78BFA;
    --muted:#93A49F; --card:#17201D; --danger:#E2564C;
    --on-solid:#0F1412;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; background: var(--paper); }
body {
  margin:0; background:var(--paper); color:var(--ink);
  font-family:var(--serif); font-size:1.06rem; line-height:1.55;
  -webkit-font-smoothing:antialiased;
  overflow-wrap:break-word;
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration:.01ms !important; animation-duration:.01ms !important; }
}
.wrap { max-width: 30rem; margin: 0 auto; padding: var(--s4) var(--s4) var(--s7); }

/* ---- Header & footer, the same on every page ---- */
header.site { display:flex; align-items:center; gap:var(--s3); padding: var(--s3) 0 var(--s6); }
header.site img.patch { width:63px; height:48px; flex:none; display:block; }
header.site a { color:var(--ink); text-decoration:none; display:block; }
header.site a:hover .brand { text-decoration:underline; text-underline-offset:3px; }
header.site .brand { font-family:var(--sans); font-weight:700; font-size:var(--t-md); letter-spacing:.01em; display:block; }
header.site .sub { color:var(--muted); font-size:var(--t-xs); font-family:var(--sans); font-weight:600;
  display:block; text-transform:uppercase; letter-spacing:.07em; margin-top:1px; }
footer { margin-top:var(--s7); padding-top:var(--s4); border-top:1px solid var(--line);
  color:var(--muted); font-size:var(--t-xs); font-family:var(--sans); line-height:1.5; }

/* ---- Type ---- */
h1 { font-family:var(--sans); font-weight:700; font-size:var(--t-2xl); line-height:1.15;
  letter-spacing:-.015em; margin:0 0 var(--s3); text-wrap:balance; }
h2 { font-family:var(--sans); font-weight:600; font-size:var(--t-lg); line-height:1.25;
  margin:var(--s6) 0 var(--s3); }
h3 { font-family:var(--sans); font-weight:600; font-size:var(--t-sm); text-transform:uppercase;
  letter-spacing:.07em; color:var(--muted); margin:var(--s5) 0 var(--s2); }
p { margin:var(--s2) 0 var(--s4); }
.muted { color:var(--muted); } .small { font-size:var(--t-sm); }
.lead { font-size:var(--t-lg); line-height:1.4; }
a { color:var(--accent); text-underline-offset:3px; }
:focus-visible { outline:3px solid var(--accent); outline-offset:2px; border-radius:4px; }
hr { border:0; border-top:1px solid var(--line); margin:var(--s6) 0; }

/* ---- Forms ---- */
form { margin:var(--s5) 0 0; }
label { display:block; font-family:var(--sans); font-weight:600; font-size:var(--t-sm);
  margin:var(--s4) 0 var(--s2); }
input[type=email], input[type=text], input[type=password], input[type=number], input[type=file],
select, textarea {
  width:100%; padding:.7rem .75rem; font-size:1.05rem; color:var(--ink);
  background:var(--card); border:1.5px solid var(--line); border-radius:var(--r-sm);
  font-family:var(--mono); }
input:focus-visible, select:focus-visible, textarea:focus-visible { border-color:var(--accent); }
textarea { min-height:6rem; line-height:1.5; }
input.code { font-size:1.7rem; letter-spacing:.4em; text-align:center; }
.field-help { font-size:var(--t-sm); color:var(--muted); margin:var(--s2) 0 0; }

/* ---- Buttons: primary, secondary, approve, danger ---- */
button, .btn { display:block; width:100%; margin-top:var(--s4); padding:.85rem 1rem;
  border:1.5px solid var(--ink); border-radius:var(--r-pill); background:var(--ink); color:var(--paper);
  font-family:var(--sans); font-weight:600; font-size:var(--t-md); line-height:1.3;
  cursor:pointer; text-align:center; text-decoration:none; }
button:hover, .btn:hover { opacity:.88; }
button.secondary, .btn.secondary { background:transparent; color:var(--ink); border-color:var(--line); }
button.danger, .btn.danger { background:var(--danger); color:var(--on-solid); border-color:var(--danger); }
button.approve, .btn.approve { background:var(--have); color:var(--on-solid); border-color:var(--have); }
.btn.quiet { background:transparent; color:var(--ink); border-color:transparent;
  text-align:left; padding:.7rem 0; font-weight:600; }
.actions { display:flex; flex-direction:column; gap:var(--s2); margin:var(--s5) 0 0; }
.actions > form { margin:0; } .actions button, .actions .btn { margin-top:0; }

/* ---- Boxes ---- */
.err { background:color-mix(in srgb, var(--danger) 12%, var(--paper)); border:1.5px solid var(--danger);
  border-radius:var(--r-sm); padding:var(--s3) var(--s4); font-size:var(--t-sm); margin:var(--s4) 0; }
.note { border:1px solid var(--line); background:var(--wash); border-radius:var(--r-sm);
  padding:var(--s3) var(--s4); font-size:var(--t-sm); color:var(--muted); margin:var(--s4) 0; }
.note strong, .err strong { color:var(--ink); }
.panel { border:1px solid var(--line); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s4) 0; }

/* ---- Facts: the numbers a decision turns on ---- */
.facts { margin:var(--s5) 0; }
.fact { border:1px solid var(--line); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s3) 0; }
.fact .k { font-family:var(--sans); font-weight:600; font-size:var(--t-xs); color:var(--muted);
  text-transform:uppercase; letter-spacing:.06em; }
.fact .v { font-family:var(--mono); font-size:1.4rem; margin-top:2px; overflow-wrap:anywhere; }
.headline { border:2px solid var(--accent); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s4) 0; }
.headline .k { font-family:var(--sans); font-weight:600; font-size:var(--t-xs); color:var(--muted);
  text-transform:uppercase; letter-spacing:.06em; }
.headline .v { font-family:var(--mono); font-size:2rem; line-height:1.15; margin-top:var(--s1);
  overflow-wrap:anywhere; }
.anomaly { border:2px solid var(--want); background:color-mix(in srgb, var(--want) 12%, var(--paper));
  border-radius:var(--r); padding:var(--s4); margin:var(--s3) 0;
  font-family:var(--sans); font-weight:700; font-size:1.05rem; line-height:1.35; }
.anomaly .k { font-size:var(--t-xs); letter-spacing:.06em; text-transform:uppercase; font-weight:600;
  color:var(--want); margin-bottom:2px; }

/* ---- Rows: cards, keys, offers ---- */
.card-row { border:1px solid var(--line); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s3) 0; }
.card-row .top { display:flex; gap:var(--s2); align-items:center; flex-wrap:wrap; }
.badge { font-family:var(--sans); font-weight:700; font-size:.7rem; letter-spacing:.05em;
  padding:.2rem .55rem; border-radius:var(--r-pill); color:var(--on-solid); white-space:nowrap; }
.badge.want { background:var(--want); } .badge.have { background:var(--have); }
.badge.state { background:transparent; color:var(--muted); border:1px solid var(--line); font-weight:600; }
.badge.match { background:var(--accent); }
.cat { font-family:var(--mono); font-size:var(--t-sm); overflow-wrap:anywhere; min-width:0; }
.kv { font-family:var(--mono); font-size:var(--t-sm); color:var(--muted); margin-top:var(--s2);
  overflow-wrap:anywhere; }
.row-actions { display:flex; gap:var(--s2); margin-top:var(--s3); flex-wrap:wrap; }
.row-actions form { margin:0; flex:1 1 7rem; }
.row-actions > .btn { flex:1 1 7rem; }
.row-actions .btn, .row-actions button { margin-top:0; padding:.5rem .7rem; font-size:var(--t-sm); }

/* ---- Waiting-on-you action cards (the dashboard's first screen) ---- */
.todo { display:block; border:1.5px solid var(--line); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s3) 0; text-decoration:none; color:var(--ink); }
.todo:hover { border-color:var(--accent); }
.todo.urgent { border-color:var(--accent); }
.todo .what { font-family:var(--sans); font-weight:600; font-size:var(--t-md); line-height:1.35;
  margin-top:var(--s2); }
.todo .figure { font-family:var(--mono); font-size:1.35rem; margin-top:var(--s1); }
.todo .go { font-family:var(--sans); font-weight:600; font-size:var(--t-sm); color:var(--accent);
  margin-top:var(--s3); }
.todo .go::after { content:' →'; }
.empty { color:var(--muted); font-size:var(--t-sm); border:1px dashed var(--line);
  border-radius:var(--r); padding:var(--s4); margin:var(--s3) 0; }

/* ---- Quiet navigation, below the decisions ---- */
.navlist { border-top:1px solid var(--line); margin:var(--s5) 0 0; }
.navlist a { display:block; border-bottom:1px solid var(--line); padding:var(--s3) 0;
  text-decoration:none; color:var(--ink); }
.navlist a:hover .nav-t { text-decoration:underline; text-underline-offset:3px; }
.navlist .nav-t { display:block; font-family:var(--sans); font-weight:600; font-size:var(--t-md); }
.navlist .nav-t::after { content:' →'; color:var(--muted); }
.navlist .nav-d { display:block; font-size:var(--t-sm); color:var(--muted); margin-top:2px; line-height:1.4; }

/* ---- Collapsible supporting detail ---- */
details.more { border:1px solid var(--line); border-radius:var(--r); background:var(--card);
  margin:var(--s4) 0; }
details.more > summary { font-family:var(--sans); font-weight:600; font-size:var(--t-sm);
  padding:var(--s3) var(--s4); cursor:pointer; list-style:none; }
details.more > summary::-webkit-details-marker { display:none; }
details.more > summary::after { content:' +'; color:var(--muted); }
details.more[open] > summary::after { content:' –'; }
details.more > .inner { padding:0 var(--s4) var(--s4); }
details.more > .inner > :first-child { margin-top:0; }
details.more form { margin-top:var(--s3); }

/* ---- Consent checkboxes ---- */
.consent-box { border:1.5px solid var(--line); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s4) 0; }
.consent-box label { display:flex; gap:var(--s3); align-items:flex-start; margin:var(--s3) 0;
  font-family:var(--serif); font-weight:400; font-size:var(--t-md); line-height:1.5; }
.consent-box input { width:1.2rem; height:1.2rem; margin-top:.25rem; flex:none; }

/* ---- Radio options (negotiation mode) ---- */
label.modeopt { display:grid; grid-template-columns:1.2rem 1fr; gap:var(--s2) var(--s3);
  align-items:start; border:1.5px solid var(--line); background:var(--card);
  border-radius:var(--r); padding:var(--s4); margin:var(--s3) 0; font-weight:400; }
label.modeopt input { width:1.2rem; height:1.2rem; margin:.2rem 0 0; grid-row:span 2; }
label.modeopt strong { font-family:var(--sans); font-size:var(--t-md); }
label.modeopt span { grid-column:2; }

/* ---- The kill switch keeps its own frame ---- */
.kill { border:2px solid var(--danger); border-radius:var(--r); padding:var(--s4); margin:var(--s6) 0 0; }
.kill h2 { margin-top:0; }
`;

export function layout(title: string, body: string, opts: { head?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — OpenSwitchboard</title>
<link rel="icon" type="image/png" href="${PATCH_FAVICON_URL}">
<link rel="apple-touch-icon" href="${PATCH_FAVICON_URL}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style>${opts.head ?? ''}</head><body>
<div class="wrap">
<header class="site">
  <img class="patch" src="${PATCH_HEADER_URL}" width="63" height="48" alt="" aria-hidden="true">
  <a href="/"><span class="brand">OpenSwitchboard</span><span class="sub">your approval page</span></a>
</header>
${body}
<footer>Everything agents must never do, you do here.<br>openswitchboard.ai</footer>
</div></body></html>`;
}

export const errBox = (msg?: string) => (msg ? `<div class="err">${esc(msg)}</div>` : '');

/** Supporting detail, folded away until someone wants it. */
export function foldedDetail(summary: string, inner: string, open = false): string {
  return `<details class="more"${open ? ' open' : ''}>
  <summary>${esc(summary)}</summary>
  <div class="inner">${inner}</div>
</details>`;
}

// ---------------------------------------------------------------------------

export function landingPage(): string {
  return layout('Your approval page', `
<h1>Your approval page.</h1>
<p class="lead">Your agent works the switchboard. This page is where you do
everything it never can.</p>
<div class="actions">
  <a class="btn" href="/register">Open an account</a>
  <a class="btn secondary" href="/login">Sign in</a>
</div>
${foldedDetail(
  'What happens here',
  `<p class="small">Your agent posts wants &amp; haves as cards, checks matches and
negotiates. Opening the account, setting your PIN, approving what gets shared
or paid, reading the ledger and pulling the plug all happen on this page, with
you signed in.</p>`,
)}`);
}

export function registerEmailPage(error?: string): string {
  return layout('Open an account', `
<h1>Open an account.</h1>
<p class="lead">We'll email you a six-digit code to prove this address is yours.</p>
${errBox(error)}
<form method="POST" action="/register">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required autofocus>
  <button type="submit">Email me a code</button>
</form>
<p class="small muted">Already have an account? <a href="/login">Sign in</a>.</p>`);
}

export function codeEntryPage(params: {
  verificationId: string;
  action: string; // form target
  error?: string;
  heading?: string;
}): string {
  return layout('Enter your code', `
<h1>${esc(params.heading ?? 'Check your email.')}</h1>
<p class="lead">Enter the six-digit code we just sent. It works once and expires in 15 minutes.</p>
${errBox(params.error)}
<form method="POST" action="${esc(params.action)}">
  <input type="hidden" name="verification_id" value="${esc(params.verificationId)}">
  <label for="code">Code</label>
  <input id="code" name="code" type="text" class="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
  <button type="submit">Continue</button>
</form>`);
}

export function pinSetPage(error?: string): string {
  return layout('Set your PIN', `
<h1>Set your PIN.</h1>
<p class="lead">Six or more digits. Your PIN approves the sensitive stuff.</p>
${errBox(error)}
<form method="POST" action="/pin/set">
  <label for="pin">PIN (6+ digits)</label>
  <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{6,12}" minlength="6" maxlength="12" required autofocus>
  <label for="pin2">PIN again</label>
  <input id="pin2" name="pin2" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{6,12}" minlength="6" maxlength="12" required>
  <button type="submit">Set PIN</button>
</form>
<p class="small muted">Disclosures, settlements and turning things back on all ask
for it. It never touches your agent.</p>`);
}

const WEBAUTHN_HELPERS = `<script>
function b64uToBuf(s){s=s.replace(/-/g,'+').replace(/_/g,'/');const p=s.length%4?4-(s.length%4):0;
  const b=atob(s+'='.repeat(p));const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a.buffer;}
function bufToB64u(b){const a=new Uint8Array(b);let s='';for(const x of a)s+=String.fromCharCode(x);
  return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
async function postJson(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify(body||{}),credentials:'same-origin'});
  if(!r.ok)throw new Error((await r.text())||('HTTP '+r.status));return r.json();}
</script>`;

export function passkeyOfferPage(): string {
  return layout('Add a passkey', `
<h1>Add a passkey?</h1>
<p class="lead">Optional, recommended: sign in and approve with Face&nbsp;ID, a
fingerprint, or your device passcode instead of email codes.</p>
<div id="pkerr"></div>
<div class="actions">
  <button id="enrol">Add a passkey</button>
  <form method="POST" action="/passkey/skip"><button class="secondary" type="submit">Skip for now</button></form>
</div>
${WEBAUTHN_HELPERS}
<script>
document.getElementById('enrol').addEventListener('click', async () => {
  try {
    const opts = await postJson('/passkey/options');
    opts.challenge = b64uToBuf(opts.challenge);
    opts.user.id = b64uToBuf(opts.user.id);
    (opts.excludeCredentials||[]).forEach(c=>c.id=b64uToBuf(c.id));
    const cred = await navigator.credentials.create({ publicKey: opts });
    const body = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON),
                  attestationObject: bufToB64u(cred.response.attestationObject),
                  transports: cred.response.getTransports ? cred.response.getTransports() : [] },
      clientExtensionResults: cred.getClientExtensionResults() };
    await postJson('/passkey/verify', body);
    location.href = '/consent';
  } catch (e) {
    document.getElementById('pkerr').innerHTML = '<div class="err">Passkey enrolment failed: '
      + String(e.message||e).replace(/[<>&]/g,'') + '</div>';
  }
});
</script>`);
}

export function consentPage(error?: string): string {
  return layout('One last thing', `
<h1>One last thing.</h1>
${errBox(error)}
<form method="POST" action="/consent">
  <div class="consent-box">
    <label><input type="checkbox" name="adult" value="yes" required>
      I am 18 or older.</label>
    <label><input type="checkbox" name="consent" value="yes" required>
      ${esc(CONSENT_STATEMENT)}</label>
  </div>
  <button type="submit">Open my account</button>
</form>
<p class="small muted">Both statements are recorded in a tamper-evident consent log.</p>
<p class="small muted">If a match ever gets as far as swapping details, we ask you then for a
first name and a rough area, and those are the only things that cross.</p>`);
}

export function loginEmailPage(error?: string): string {
  return layout('Sign in', `
<h1>Sign in.</h1>
${errBox(error)}
<div id="pkerr"></div>
<button id="pk" class="secondary">Sign in with a passkey</button>
<form method="POST" action="/login">
  <label for="email">Or use email</label>
  <input id="email" name="email" type="email" autocomplete="email" required>
  <button type="submit">Email me a code</button>
</form>
<p class="small muted">New here? <a href="/register">Open an account</a>.</p>
${WEBAUTHN_HELPERS}
<script>
document.getElementById('pk').addEventListener('click', async () => {
  try {
    const opts = await postJson('/login/passkey/options');
    opts.challenge = b64uToBuf(opts.challenge);
    (opts.allowCredentials||[]).forEach(c=>c.id=b64uToBuf(c.id));
    const cred = await navigator.credentials.get({ publicKey: opts });
    const body = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON),
                  authenticatorData: bufToB64u(cred.response.authenticatorData),
                  signature: bufToB64u(cred.response.signature),
                  userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : null },
      clientExtensionResults: cred.getClientExtensionResults() };
    const r = await postJson('/login/passkey/verify', body);
    location.href = r.next || '/';
  } catch (e) {
    document.getElementById('pkerr').innerHTML = '<div class="err">Passkey sign-in failed: '
      + String(e.message||e).replace(/[<>&]/g,'') + '</div>';
  }
});
</script>`);
}

export function messagePage(title: string, html: string, backHref = '/', backLabel = 'Back to your approval page'): string {
  return layout(title, `<h1>${esc(title)}</h1>${html}
<a class="btn secondary" href="${esc(backHref)}">${esc(backLabel)}</a>`);
}

export function linkDeadPage(reason: 'used' | 'expired' | 'invalid'): string {
  const text = {
    used: `<p class="lead">This approval link has already been used. Each link works exactly once.</p>
<p class="muted small">If you still have something waiting, it's listed on your approval page.</p>`,
    expired: `<p class="lead">This approval link has expired — links live for 15 minutes.</p>
<p class="muted small">Anything still waiting for you is listed on your approval page.</p>`,
    invalid: `<p class="lead">This approval link isn't valid.</p>`,
  }[reason];
  const title = { used: 'Already used', expired: 'Link expired', invalid: 'Not a valid link' }[reason];
  return layout(title, `<h1>${esc(title)}.</h1>${text}
<a class="btn" href="/">Go to your approval page</a>`);
}

export interface ApprovalView {
  action: 'offer-accept' | 'stage3-disclosure' | 'settlement-approve';
  refId: string;
  facts: { k: string; v: string }[]; // the three facts, big
  anomalies: string[];
  /** Set on a stage-3 approval when this account has no first name / area on
   *  file yet: the page asks for them right here, and approving stores them. */
  collectProfile?: { firstName: string; locality: string };
  hasPasskey: boolean;
  elevated: boolean;
  postPath: string; // decision endpoint
  /** Set on an offer approval: the match to reply on, and the offer's currency.
   *  Answering with a figure of your own is a third door out of this page,
   *  beside approve and decline, and it needs no PIN because it binds nothing. */
  counterOffer?: { matchId: string; ccy: string };
  /** A figure this person's agent tried to send on their behalf and was
   *  refused for, waiting here to be checked and sent. */
  draft?: OfferDraftView;
}

/** A number the agent brought back, ready for its human to check and send. */
export interface OfferDraftView {
  amount: string;
  ccy: string;
  note?: string;
}

/** The one line that says where a prefilled figure came from. */
export const DRAFT_LINE = 'Your agent brought this number from you — check it and send.';

/**
 * Reply with your own number. This control is where a human's side of a
 * negotiation comes from on a card set to Pass on, and it is deliberately
 * lighter than approving: a proposal binds nothing, so a signed-in session is
 * enough, while accepting one still asks for a PIN or a passkey.
 */
export function counterOfferForm(
  matchId: string,
  opts: { ccy?: string; amount?: string; note?: string; heading?: string; draft?: boolean } = {},
): string {
  const heading = opts.heading ?? 'Reply with your number';
  return `${heading ? `<h2>${esc(heading)}</h2>` : ''}
${opts.draft ? `<div class="note"><strong>${esc(DRAFT_LINE)}</strong></div>` : ''}
<p class="small muted">What you type here goes to the other side as your offer.
It binds nothing — either of you can still say no — and accepting anything
still comes back to this page.</p>
<form method="POST" action="/matches/${esc(matchId)}/offer">
  <label for="amount">Your number</label>
  <input id="amount" name="amount" type="number" step="0.01" min="0" required value="${esc(opts.amount ?? '')}" placeholder="amount">
  <label for="ccy">Currency</label>
  <input id="ccy" name="ccy" type="text" maxlength="3" pattern="[A-Za-z]{3}" required value="${esc(opts.ccy ?? 'AUD')}">
  <label for="note">A line to go with it (optional)</label>
  <input id="note" name="note" type="text" maxlength="${MANDATE_NOTE_MAX}" value="${esc(opts.note ?? '')}" placeholder="about the terms — keep ways of reaching you out of it">
  <label for="good_for">Good for</label>
  <select id="good_for" name="good_for">
    <option value="3">3 days</option>
    <option value="7" selected>7 days</option>
    <option value="14">14 days</option>
  </select>
  <button type="submit">Send this number</button>
</form>`;
}

/** The two boxes that make up everything a match ever sees about a person. */
export function sharedFieldsFieldset(v: { firstName: string; locality: string }): string {
  return `<label for="first_name">First name</label>
  <input id="first_name" name="first_name" type="text" maxlength="40" autocomplete="given-name"
    value="${esc(v.firstName)}" required>
  <label for="locality">Suburb or area</label>
  <input id="locality" name="locality" type="text" maxlength="60" autocomplete="address-level2"
    value="${esc(v.locality)}" required>`;
}

export function approvalPage(v: ApprovalView, error?: string): string {
  const title = {
    'offer-accept': 'Approve this settlement?',
    'stage3-disclosure': 'Share your details?',
    'settlement-approve': 'Approve this payment?',
  }[v.action];
  const anomalyHtml = v.anomalies
    .map((a) => `<div class="anomaly"><div class="k">Worth a second look</div>${esc(a)}</div>`)
    .join('');
  // The first fact is what the decision turns on, so it leads at full size and
  // the rest sit under the buttons.
  const [headline, ...rest] = v.facts;
  const headlineHtml = headline
    ? `<div class="headline"><div class="k">${esc(headline.k)}</div><div class="v">${esc(headline.v)}</div></div>`
    : '';
  const restHtml = rest.length
    ? `<div class="facts">${rest
        .map((f) => `<div class="fact"><div class="k">${esc(f.k)}</div><div class="v">${esc(f.v)}</div></div>`)
        .join('')}</div>`
    : '';
  const pinBlock = v.elevated
    ? `<input type="hidden" name="pin" value="">`
    : `<label for="pin">Confirm with your PIN</label>
       <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6,12}" maxlength="12" required>`;
  const passkeyBtn = v.hasPasskey && !v.elevated
    ? `<div id="pkerr"></div><button type="button" id="pkapprove" class="secondary">Approve with passkey instead</button>`
    : '';
  // First time through: the page collects the two things it is about to
  // share. They are stored under this account's own key when you approve.
  const collect = v.collectProfile
    ? `<h2>What should we share?</h2>
  <p class="small">Your match sees a first name and a rough area. That is the whole of it.
  You can change both any time on <a href="/profile">what you share on a match</a>.</p>
  ${sharedFieldsFieldset(v.collectProfile)}`
    : '';
  const declineTail = {
    'offer-accept': 'is accepted',
    'stage3-disclosure': 'is shared',
    'settlement-approve': 'is paid',
  }[v.action];
  return layout(title, `
<h1>${esc(title)}</h1>
${errBox(error)}
${anomalyHtml}
${headlineHtml}
<form method="POST" action="${esc(v.postPath)}" id="approveForm">
  <input type="hidden" name="ref_id" value="${esc(v.refId)}">
  <input type="hidden" name="action" value="${esc(v.action)}">
  ${collect}
  ${pinBlock}
  <div class="actions">
  <button type="submit" name="decision" value="approve" class="approve">Approve</button>
  <button type="submit" name="decision" value="decline" class="secondary" formnovalidate>Decline — nothing ${declineTail}</button>
  </div>
</form>
${passkeyBtn}
<p class="small muted">Approve needs your PIN${v.hasPasskey ? ' or passkey' : ''}. Decline shares nothing and carries no reason.</p>
${restHtml}
${
  v.counterOffer
    ? foldedDetail(
        'Or reply with a number of your own',
        counterOfferForm(v.counterOffer.matchId, {
          ccy: v.draft?.ccy ?? v.counterOffer.ccy,
          amount: v.draft?.amount,
          note: v.draft?.note,
          // The fold's own summary is the heading here.
          heading: '',
          draft: !!v.draft,
        }),
        !!v.draft,
      )
    : ''
}
${v.hasPasskey && !v.elevated ? WEBAUTHN_HELPERS + `<script>
document.getElementById('pkapprove').addEventListener('click', async () => {
  try {
    const opts = await postJson('/login/passkey/options');
    opts.challenge = b64uToBuf(opts.challenge);
    (opts.allowCredentials||[]).forEach(c=>c.id=b64uToBuf(c.id));
    const cred = await navigator.credentials.get({ publicKey: opts });
    const body = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON),
                  authenticatorData: bufToB64u(cred.response.authenticatorData),
                  signature: bufToB64u(cred.response.signature),
                  userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : null },
      clientExtensionResults: cred.getClientExtensionResults(), elevate_only: true };
    await postJson('/login/passkey/verify', body);
    const f = document.getElementById('approveForm');
    const i = document.createElement('input'); i.type='hidden'; i.name='decision'; i.value='approve';
    f.appendChild(i); f.querySelector('#pin')?.removeAttribute('required'); f.submit();
  } catch (e) {
    document.getElementById('pkerr').innerHTML = '<div class="err">Passkey ceremony failed: '
      + String(e.message||e).replace(/[<>&]/g,'') + '</div>';
  }
});
</script>` : ''}`);
}

export function authorizePage(clientName: string, postPath: string, hidden: Record<string, string>): string {
  const hiddenInputs = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n');
  return layout('Authorize your agent', `
<h1>Let this agent work the switchboard for you?</h1>
<div class="headline"><div class="k">Agent</div><div class="v">${esc(clientName)}</div></div>
<form method="POST" action="${esc(postPath)}">
${hiddenInputs}
  <div class="actions">
  <button type="submit" name="decision" value="approve">Authorize</button>
  <button type="submit" name="decision" value="deny" class="secondary">Cancel</button>
  </div>
</form>
<p class="small muted">It can post wants &amp; haves as cards, review matches, and negotiate.
Anything irreversible — sharing your details, accepting an offer — still
waits for you, here on your approval page.</p>`);
}

export function registrationClosedPage(): string {
  return layout('Registration opens at launch', `
<h1>Registration opens at launch.</h1>
<p class="lead">OpenSwitchboard — the switchboard for AI intent — is not yet open
for sign-ups. Accounts, agents and intents all arrive at launch.</p>`);
}

// ---------------------------------------------------------------------------
// Settlement page (phase 1.A safe hands). One page per settlement; the
// blocks that render depend on the viewer's side and the state. Money-moving
// buttons post to session-authenticated routes; confirm-receipt needs the
// PIN/passkey ceremony like every approval.
// ---------------------------------------------------------------------------
export interface SettlementView {
  id: string;
  role: 'buyer' | 'seller';
  state: string;
  amount: string; // rendered "600 AUD"
  category: string;
  descriptionText?: string;
  myApprovalPending: boolean;
  /** buyer, state approved: hosted payment can start */
  canPay: boolean;
  /** seller, state approved: payment setup incomplete */
  needsPaymentSetup: boolean;
  /** seller, state funded: evidence upload + lock */
  canLockEvidence: boolean;
  /** buyer, state evidence-locked: confirm ceremony */
  canConfirm: boolean;
  /** either side, funded/evidence-locked */
  canDispute: boolean;
  /** buyer, evidence-locked+: presigned links to the frozen evidence */
  evidence: { label: string; url: string }[];
  hasPasskey: boolean;
  elevated: boolean;
}

const STATE_LINES: Record<string, string> = {
  proposed: 'Waiting for both of you to approve.',
  'approved-by-buyer': 'The buyer has approved. Waiting on the seller.',
  'approved-by-seller': 'The seller has approved. Waiting on the buyer.',
  approved: 'Both approved. The buyer pays next; the money is then held.',
  funded: 'The payment is held in safe hands.',
  'evidence-locked': 'Handover evidence is frozen. The buyer confirms receipt next.',
  confirmed: 'Receipt confirmed. The release is on its way.',
  disputed: 'Disputed. The held payment goes back to the buyer.',
  released: 'Complete. The payment was released to the seller.',
  refunded: 'Closed. The payment went back to the buyer.',
  declined: 'Declined. Nothing was paid.',
};

export function settlementPage(v: SettlementView, error?: string, notice?: string): string {
  const facts = [
    { k: 'For', v: v.category },
    { k: 'State', v: v.state },
    { k: 'Your side', v: v.role === 'buyer' ? 'you pay' : 'you are paid' },
  ]
    .map((f) => `<div class="fact"><div class="k">${esc(f.k)}</div><div class="v">${esc(f.v)}</div></div>`)
    .join('');
  // What the person can do right now, above everything describing it.
  const blocks: string[] = [];
  if (v.myApprovalPending) {
    blocks.push(`<a class="btn" href="/approvals/settlement/${esc(v.id)}">Review and decide</a>`);
  }
  if (v.needsPaymentSetup) {
    blocks.push(`<form method="POST" action="/settlements/${esc(v.id)}/payment-setup">
<button type="submit">Finish payment setup with Stripe</button></form>
<p class="small muted">Stripe collects your payout details directly; the switchboard never sees them.</p>`);
  }
  if (v.canPay) {
    blocks.push(`<form method="POST" action="/settlements/${esc(v.id)}/pay">
<button type="submit" class="approve">Pay on Stripe's secure page</button></form>
<p class="small muted">Your card details go to Stripe only. The money is held and moves to the seller
after you confirm receipt.</p>`);
  }
  if (v.canConfirm) {
    const pinBlock = v.elevated
      ? `<input type="hidden" name="pin" value="">`
      : `<label for="pin">Confirm with your PIN</label>
         <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6,12}" maxlength="12" required>`;
    blocks.push(`<h2>Confirm receipt</h2>
<p>Confirming releases the held payment to the seller. Do this once the goods
are in your hands and as described.</p>
<form method="POST" action="/settlements/${esc(v.id)}/confirm">
  ${pinBlock}
  <button type="submit" class="approve">Confirm receipt — release the payment</button>
</form>`);
  }
  if (v.canLockEvidence) {
    blocks.push(`<h2>Handover evidence</h2>
<p>Add photos of the handover, then lock them. Locked evidence is frozen in
write-once storage and shown to the buyer with the confirmation request.</p>
<div id="evlist" class="note" style="display:none"></div>
<div id="everr"></div>
<label for="evfile">Photos of the handover</label>
<input type="file" id="evfile" accept="image/jpeg,image/png,image/webp" multiple>
<form method="POST" action="/settlements/${esc(v.id)}/evidence/lock" id="lockForm">
<button type="submit" id="lockBtn" disabled>Lock evidence</button></form>
<script>
const evfile = document.getElementById('evfile');
const evlist = document.getElementById('evlist');
const lockBtn = document.getElementById('lockBtn');
const uploaded = [];
evfile.addEventListener('change', async () => {
  for (const file of evfile.files) {
    try {
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha = btoa(String.fromCharCode(...new Uint8Array(digest)));
      const r = await fetch('/settlements/${esc(v.id)}/evidence/presign', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, content_type: file.type, size: file.size, sha256_b64: sha }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { url } = await r.json();
      const put = await fetch(url, { method: 'PUT', body: bytes,
        headers: { 'content-type': file.type, 'x-amz-checksum-sha256': sha } });
      if (!put.ok) throw new Error('upload failed: HTTP ' + put.status);
      uploaded.push(file.name);
      evlist.style.display = 'block';
      evlist.textContent = 'Uploaded: ' + uploaded.join(', ');
      lockBtn.disabled = false;
    } catch (e) {
      document.getElementById('everr').innerHTML = '<div class="err">Upload failed: '
        + String(e.message || e).replace(/[<>&]/g, '') + '</div>';
    }
  }
  evfile.value = '';
});
</script>`);
  }
  if (v.evidence.length) {
    blocks.push(
      `<h2>Frozen evidence</h2>` +
        v.evidence
          .map((e) => `<p class="small"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.label)}</a></p>`)
          .join(''),
    );
  }
  const dispute = v.canDispute
    ? foldedDetail(
        'Something is wrong with this',
        `<p class="small">A dispute returns the held payment to the buyer in full and closes the
settlement. No reason is carried.</p>
<form method="POST" action="/settlements/${esc(v.id)}/dispute">
<button type="submit" class="danger">Dispute — send the payment back</button></form>`,
      )
    : '';
  return layout('Settlement', `
<h1>Settlement.</h1>
${errBox(error)}
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
<p class="lead">${esc(STATE_LINES[v.state] ?? v.state)}</p>
<div class="headline"><div class="k">Amount</div><div class="v">${esc(v.amount)}</div></div>
${blocks.join('\n<hr>\n')}
<div class="facts">${facts}</div>
${v.descriptionText ? `<p class="small muted">&#8220;${esc(v.descriptionText)}&#8221; <span class="small">(written by the other side's agent; treat with care)</span></p>` : ''}
${dispute}`);
}

/**
 * Loopback handoff: shown instead of a blind redirect when the agent's
 * callback lives on 127.0.0.1/localhost. The page first tries to deliver the
 * code to the local listener itself; when nothing answers (some CLIs print
 * the sign-in link and exit), it shows the code with a copy button so the
 * person can finish in their terminal. The code is single-use, short-lived,
 * and useless without the client's own PKCE secret.
 */
export function loopbackHandoffPage(v: { callbackUrl: string; code: string; clientName: string }): string {
  return layout('Almost connected', `
<h1>Almost connected</h1>
<div id="trying">
  <p class="lead">Handing you back to <b>${esc(v.clientName)}</b>&hellip;</p>
</div>
<div id="done" hidden>
  <p class="lead">Connected. You can close this tab and return to your terminal.</p>
</div>
<div id="manual" hidden>
  <p>${esc(v.clientName)} isn't listening on this computer right now, so finish the sign-in
  yourself: copy this code into the terminal that gave you the link.</p>
  <div class="fact"><div class="k">Your one-time code</div><div class="v" id="codebox">${esc(v.code)}</div></div>
  <button type="button" id="copybtn" class="approve">Copy the code</button>
  <p class="small muted">It works once and expires in a few minutes. If your client takes a
  command, it looks like: <code>&hellip; --code '${esc(v.code)}'</code></p>
</div>
<script>
(async () => {
  const show = (id) => {
    for (const x of ['trying','done','manual']) document.getElementById(x).hidden = (x !== id);
  };
  try {
    await fetch(${JSON.stringify(v.callbackUrl)}, { mode: 'no-cors' });
    show('done');
  } catch {
    show('manual');
  }
})();
document.getElementById('copybtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(${JSON.stringify(v.code)});
    document.getElementById('copybtn').textContent = 'Copied';
  } catch {}
});
</script>
`);
}
