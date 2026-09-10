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
.row-actions .btn, .row-actions button { margin-top:0; padding:.5rem .7rem; font-size:var(--t-sm);
  white-space:nowrap; }

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

/* ---- Past connections: finished, filed away, kept for retrieval ---- */
.past-connections { border-top:1px solid var(--line); margin:var(--s5) 0 0; padding-top:var(--s4); }
.small-head { font-family:var(--sans); font-weight:700; font-size:var(--t-md); margin:0 0 var(--s2); }
.card-row.past { background:transparent; border-style:dashed; opacity:.85; }

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
/* The same two options side by side once there is room for them. */
.modegrid { display:grid; grid-template-columns:1fr; gap:var(--s2); }
.modegrid label.modeopt { margin:0; }
@media (min-width: 27rem) { .modegrid { grid-template-columns:1fr 1fr; } }

/* ---- The kill switch keeps its own frame ---- */
.kill { border:2px solid var(--danger); border-radius:var(--r); padding:var(--s4); margin:var(--s6) 0 0; }
.kill h2 { margin-top:0; }
`;

/**
 * Every <time data-local> the pages print starts as UTC and ends up in the
 * reader's own timezone here. No suffix is added: once it is their clock, the
 * words are theirs too.
 */
const LOCAL_TIME_SCRIPT = `<script>
(function () {
  var shapes = {
    minute: { dateStyle: 'medium', timeStyle: 'short' },
    day: { weekday: 'long', day: 'numeric', month: 'long' }
  };
  var nodes = document.querySelectorAll('time[data-local]');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var at = new Date(el.getAttribute('datetime'));
    if (isNaN(at.getTime())) continue;
    try {
      el.textContent = new Intl.DateTimeFormat(
        undefined,
        shapes[el.getAttribute('data-local')] || shapes.minute
      ).format(at);
    } catch (e) {}
  }
})();
</script>`;

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
</div>
${LOCAL_TIME_SCRIPT}</body></html>`;
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
  <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore pattern="[0-9]{6,12}" minlength="6" maxlength="12" required autofocus>
  <label for="pin2">PIN again</label>
  <input id="pin2" name="pin2" type="password" inputmode="numeric" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore pattern="[0-9]{6,12}" minlength="6" maxlength="12" required>
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
  <input id="note" name="note" type="text" maxlength="${MANDATE_NOTE_MAX}" value="${esc(opts.note ?? '')}" placeholder="A line to go with it, e.g. can collect Saturday">
  <p class="field-help">About the terms. Keep ways of reaching you out of it.</p>
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

export function authorizePage(clientName: string, postPath: string, hidden: Record<string, string>, clientId = ''): string {
  const hiddenInputs = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n');
  return layout('Authorize your agent', `
<h1>Let this agent work the switchboard for you?</h1>
<div class="headline"><div class="k">Agent</div><div class="v">${esc(clientName)}</div></div>
<form method="POST" action="${esc(postPath)}" id="authorize-form" data-client="${esc(clientId)}">
${hiddenInputs}
  <div class="actions">
  <button type="submit" name="decision" value="approve" formtarget="_blank">Authorize</button>
  <button type="submit" name="decision" value="deny" class="secondary">Cancel</button>
  </div>
</form>
<p class="small muted">It can post wants &amp; haves as cards, review matches, and negotiate.
Anything irreversible — sharing your details, accepting an offer — still
waits for you, here on your approval page.</p>
<p class="small muted">Authorising hands the agent its key in a new tab, which you can close;
this tab comes back to your approval page.</p>
<script>
// The agent's callback (often a localhost page the agent is listening on)
// lands in the new tab the Authorize button opens; this tab has nothing left
// to show, so it goes home. Cancel stays in this tab.
document.getElementById('authorize-form').addEventListener('submit', function (e) {
  if (e.submitter && e.submitter.value === 'approve') {
    var id = this.getAttribute('data-client') || '';
    setTimeout(function () { location.assign('/?authorized=' + encodeURIComponent(id)); }, 400);
  }
});
</script>`);
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
  amount: string; // rendered "600 AUD" — what the seller receives, in full
  /** Our introductory fee, rendered "1.00 AUD". The buyer pays it. */
  fee: string;
  /** Card processing at Stripe's standard rate, rendered "10.52 AUD". */
  processing: string;
  /** The three lines added up: what the buyer is charged. */
  buyerTotal: string;
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
  /** buyer, state confirmed: the release did not go through, send it again */
  canRetryRelease: boolean;
  /** either side, funded/evidence-locked */
  canDispute: boolean;
  /** buyer, evidence-locked+: presigned links to the frozen evidence */
  evidence: { label: string; url: string }[];
  hasPasskey: boolean;
  elevated: boolean;
  /** SETTLEMENT_AUTO_RELEASE_DAYS: how long the buyer's window runs. */
  autoReleaseDays: number;
  /** The window ran out and the clock released this payment, rather than the
   *  buyer confirming. Changes what the retry block says. */
  autoReleased?: boolean;
  /** evidence-locked: the seller's handover and the clock it started. Both
   *  sides see the same two dates.
   *
   *  Every "…Day" field on this view is localTime(d, 'day') output — a
   *  <time data-local="day"> element the browser rewrites into the reader's
   *  own clock — so the page inserts them without esc(). */
  handover?: {
    /** The seller's first name where it is known, "The seller" otherwise. */
    sellerName: string;
    /** The day the seller declared the handover, as a localised <time>. */
    onDay: string;
    /** The day the payment goes on its own, as a localised <time>. */
    byDay: string;
  };
  // --- the frozen half -----------------------------------------------------
  /** The payment is frozen while the two of them sort it out. */
  inDispute: boolean;
  /** Which of the two things went wrong, in the disputer's words. */
  disputeGround?: 'not_arrived' | 'not_as_described';
  /** seller: the tracking reference can go on now. */
  canAddTracking: boolean;
  deliveryTracking?: string;
  /** buyer, in dispute, nothing sent back yet. */
  canMarkReturned: boolean;
  returnTracking?: string;
  returnedOnDay?: string;
  /** When silence sends the money back anyway, as a localised <time>. */
  returnSilenceByDay?: string;
  /** seller: the buyer says it is back with them. */
  canConfirmReturn: boolean;
  /** The seller's last day to add tracking on a dispute that says nothing
   *  arrived, as a localised <time>. */
  trackingGraceByDay?: string;
  /** The day the default rule decides, as a localised <time>. */
  deadlockByDay?: string;
  /** The split on the table, and who has said yes to it. */
  split?: {
    refundMinor: number;
    releaseMinor: number;
    refund: string;
    release: string;
    mine: boolean;
    theirs: boolean;
  };
  canProposeSplit: boolean;
  canApproveSplit: boolean;
  /** The whole of what is held, in minor units, for the split form's sums. */
  agreedMinor: number;
  ccy: string;
}

/** "Saturday 13 September" — a date a person reads without decoding it. */
export function plainDay(d: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * A moment on a human page, in the reader's own clock. The browser rewrites
 * the text on load (see layout()); what the server prints inside is the
 * fallback, so a page read with no JavaScript still says a true thing, in UTC.
 *
 * Returns trusted, server-built HTML: put it into a template directly, never
 * through esc(). Agent-facing wording stays plain text elsewhere.
 */
export function localTime(d: Date | string, mode: 'minute' | 'day' = 'minute'): string {
  const at = d instanceof Date ? d : new Date(d);
  const iso = at.toISOString();
  const fallback = mode === 'minute' ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : plainDay(at);
  return `<time datetime="${iso}" data-local="${mode}">${esc(fallback)}</time>`;
}

const STATE_LINES: Record<string, string> = {
  proposed: 'Waiting for both of you to approve.',
  'approved-by-buyer': 'The buyer has approved. Waiting on the seller.',
  'approved-by-seller': 'The seller has approved. Waiting on the buyer.',
  approved: 'Both approved. The buyer pays next; the money is then held.',
  funded: 'The payment is held in safe hands.',
  'evidence-locked': 'Handed over. The buyer confirms receipt next.',
  confirmed: 'Receipt confirmed. The release is on its way.',
  disputed: 'On hold. The payment stays put while the two of you sort this out.',
  'resolution-proposed': 'A way to settle this is on the table, waiting for the other side.',
  resolved: 'Agreed. The money is moving now.',
  released: 'Complete. The payment was released to the seller.',
  refunded: 'Closed. The agreed amount went back to the buyer.',
  'settled-split': 'Closed. You divided it between you, and the money has moved.',
  declined: 'Declined. Nothing was paid.',
};

/**
 * The PIN box, or the hidden field an already-elevated session needs. Every
 * money-moving button on this page carries one.
 *
 * `which` makes the id unique, because two of these can stand on one page: a
 * seller looking at a returned item they can close AND a split the buyer has
 * put up are both money-moving and both theirs to press. Two inputs sharing an
 * id would leave the second one's label pointing at the first one's box.
 */
function pinField(elevated: boolean, which: string): string {
  return elevated
    ? `<input type="hidden" name="pin" value="">`
    : `<label for="pin-${which}">Confirm with your PIN</label>
         <input id="pin-${which}" name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6,12}" maxlength="12" required>`;
}

export function settlementPage(v: SettlementView, error?: string, notice?: string): string {
  // `raw` marks a value the server built as HTML (a localised <time>); every
  // other value is escaped as before.
  const factRows: { k: string; v: string; raw?: boolean }[] = [
    { k: 'For', v: v.category },
    { k: 'State', v: v.state },
    { k: 'Your side', v: v.role === 'buyer' ? 'you pay' : 'you are paid' },
    { k: 'The buyer pays', v: `${v.buyerTotal} in three lines` },
    { k: 'What you agreed', v: v.amount },
    { k: 'Introductory fee', v: `${v.fee}, paid by the buyer` },
    { k: 'Card processing', v: `${v.processing}, at Stripe's standard rate` },
    // While the payment is frozen, what the seller ends up with is the whole
    // question, so the page stops answering it in advance.
    ...(v.inDispute
      ? [{ k: 'Held', v: `${v.amount}, and nothing else` }]
      : [{ k: 'The seller receives', v: `${v.amount} in full` }]),
    ...(v.handover
      ? [
          { k: 'Handed over', v: v.handover.onDay, raw: true },
          { k: 'Releases on its own', v: v.handover.byDay, raw: true },
        ]
      : []),
    ...(v.disputeGround
      ? [
          {
            k: 'What went wrong',
            v: v.disputeGround === 'not_arrived' ? 'It never arrived' : 'Something is wrong with it',
          },
        ]
      : []),
    ...(v.deliveryTracking ? [{ k: 'Sent with tracking', v: v.deliveryTracking }] : []),
    ...(v.returnTracking ? [{ k: 'Sent back with tracking', v: v.returnTracking }] : []),
    ...(v.deadlockByDay && v.inDispute
      ? [{ k: 'The rule decides on', v: v.deadlockByDay, raw: true }]
      : []),
  ];
  const facts = factRows
    .map(
      (f) =>
        `<div class="fact"><div class="k">${esc(f.k)}</div><div class="v">${f.raw ? f.v : esc(f.v)}</div></div>`,
    )
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
<p class="small muted">Your payment details go to Stripe only. Stripe's page shows you
three lines before you pay: ${esc(v.amount)} for what you agreed, an introductory fee of
${esc(v.fee)}, and ${esc(v.processing)} for card processing at Stripe's standard rate.
That comes to ${esc(v.buyerTotal)}. The money is held here and moves to the seller after
you confirm receipt; the seller receives the ${esc(v.amount)} you agreed, in full.</p>`);
  }
  if (v.canRetryRelease) {
    const pinBlock = pinField(v.elevated, 'retry');
    blocks.push(`<h2>Send the release again</h2>
<p>${
      v.autoReleased
        ? `The window ran out and this payment is due to the seller. It has not gone
through yet, and the switchboard tries again by itself every hour`
        : `Your receipt is confirmed and the payment to the seller has not gone through
yet`
    }. Nothing has moved, and sending it again is safe: the seller can only ever
be paid once for this settlement.</p>
<form method="POST" action="/settlements/${esc(v.id)}/confirm">
  ${pinBlock}
  <button type="submit" class="approve">Send the release again</button>
</form>`);
  }
  // The handover notice: the same two dates for both sides, above whatever
  // each of them can do about it.
  if (v.handover) {
    const h = v.handover;
    blocks.push(
      v.role === 'buyer'
        ? `<p class="lead">${esc(h.sellerName)} says it was handed over on ${h.onDay}.
Say it arrived as agreed when you're happy, or say something is wrong. If you do neither, the
payment releases to ${esc(h.sellerName)} on its own on ${h.byDay}.</p>`
        : `<p class="lead">You declared the handover on ${h.onDay}. The buyer has until
${h.byDay} to say it arrived as agreed or that something is wrong; if they do neither, the
payment is released to you on that day.</p>`,
    );
  }
  if (v.canConfirm) {
    blocks.push(`<h2>It arrived as agreed</h2>
<p>Saying so releases ${esc(v.amount)} to the seller — the whole of what you agreed.
The introductory fee and the card processing were separate lines on your payment, so
nothing comes off the seller's side. Do this once the goods are in your hands and as
described.</p>
<form method="POST" action="/settlements/${esc(v.id)}/confirm">
  ${pinField(v.elevated, 'confirm')}
  <button type="submit" class="approve">It arrived as agreed — release the payment</button>
</form>`);
  }
  if (v.canLockEvidence) {
    blocks.push(`<h2>Handed over</h2>
<p>Say that it has changed hands, and the buyer is asked to confirm receipt. From that
moment they have ${esc(String(v.autoReleaseDays))} days to say it arrived as agreed or that
something is wrong, and the payment is released to you on the
${esc(String(v.autoReleaseDays))}th day if they do neither.</p>
<p>Posted it? Add the tracking above. Every rule here comes out in favour of the person who can
show where the parcel went.</p>
<p>Photos are optional and worth adding. Anything you add is frozen in write-once storage
and shown to the buyer alongside the confirmation request.</p>
<div id="evlist" class="note" style="display:none"></div>
<div id="everr"></div>
<label for="evfile">Photos of the handover (optional)</label>
<input type="file" id="evfile" accept="image/jpeg,image/png,image/webp" multiple>
<form method="POST" action="/settlements/${esc(v.id)}/evidence/lock" id="lockForm">
<button type="submit" id="lockBtn">Handed over — start the buyer's ${esc(String(v.autoReleaseDays))} days</button></form>
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
  // ---- while the payment is frozen -----------------------------------------
  // Everything in this stretch is one of the two people acting on a payment
  // that is sitting still. Ordered the way a person meets them: what is
  // happening now, then what they can do about it.
  if (v.inDispute) {
    const clock = v.deadlockByDay
      ? ` If neither of you does anything, the payment goes on ${v.deadlockByDay} to whichever
side can show where the item went: the seller with tracking that shows it was delivered and
nothing sent back, the buyer if it went back tracked, and the buyer if neither of you has
tracking.`
      : '';
    blocks.push(`<p class="lead">The payment is on hold. Nothing has moved and nothing moves until
the two of you agree how to settle it, the item goes back, or the rule below decides.${clock}</p>`);
  }
  if (v.trackingGraceByDay) {
    blocks.push(
      v.role === 'seller'
        ? `<p class="lead">The buyer says it never arrived. Add the tracking that shows it was
delivered by ${v.trackingGraceByDay}; with nothing added by then, the agreed amount goes back
to them.</p>`
        : `<p class="lead">You have said it never arrived. The seller has until
${v.trackingGraceByDay} to add tracking showing it was delivered; with nothing added by then,
${esc(v.amount)} comes back to you.</p>`,
    );
  }
  if (v.canAddTracking) {
    blocks.push(`<h2>Add tracking</h2>
<p>The reference from whoever you posted it with. Both of you can see it, and it is what the
rule looks at if the two of you never agree.${
      v.deliveryTracking ? ` You have ${esc(v.deliveryTracking)} on here now.` : ''
    }</p>
<form method="POST" action="/settlements/${esc(v.id)}/tracking">
  <label for="tracking">Tracking reference</label>
  <input id="tracking" name="tracking" type="text" maxlength="200" required
         value="${esc(v.deliveryTracking ?? '')}">
  <button type="submit">Add tracking</button>
</form>`);
  }
  if (v.canMarkReturned) {
    blocks.push(`<h2>I've sent it back</h2>
<p>Send it back with tracking and put the reference here. When the seller says they have it,
${esc(v.amount)} comes back to you; if they say nothing for a week after that, it comes back
anyway. Postage is between the two of you — the only money held here is ${esc(v.amount)}.</p>
<form method="POST" action="/settlements/${esc(v.id)}/returned">
  <label for="rtracking">Tracking reference</label>
  <input id="rtracking" name="tracking" type="text" maxlength="200" required>
  <button type="submit">I've sent it back</button>
</form>`);
  }
  if (v.returnedOnDay && !v.canMarkReturned) {
    blocks.push(
      `<p class="lead">Sent back on ${v.returnedOnDay}${
        v.returnTracking ? `, tracking ${esc(v.returnTracking)}` : ''
      }.${
        v.returnSilenceByDay
          ? ` If the seller says nothing by ${v.returnSilenceByDay}, ${esc(v.amount)} goes back to the buyer anyway.`
          : ''
      }</p>`,
    );
  }
  if (v.canConfirmReturn) {
    blocks.push(`<h2>I've got it back</h2>
<p>Saying so sends ${esc(v.amount)} back to the buyer and closes this. The introductory fee and
the card processing stay paid, because the card processor keeps its own fee on a refund.</p>
<form method="POST" action="/settlements/${esc(v.id)}/return-received">
  ${pinField(v.elevated, 'return')}
  <button type="submit" class="approve">I've got it back — send the payment back</button>
</form>`);
  }
  if (v.split && v.inDispute) {
    const yours = v.split.mine ? 'You have agreed to this.' : 'You have not agreed to this yet.';
    const them = v.split.theirs ? 'The other side has agreed.' : 'The other side has not agreed yet.';
    blocks.push(`<h2>On the table</h2>
<p>${esc(v.split.refund)} back to the buyer and ${esc(v.split.release)} to the seller.
${esc(yours)} ${esc(them)} The money moves when you both agree to the same two figures.</p>${
      v.canApproveSplit
        ? `
<form method="POST" action="/settlements/${esc(v.id)}/resolution/approve">
  <input type="hidden" name="refund_minor" value="${esc(String(v.split.refundMinor))}">
  <input type="hidden" name="release_minor" value="${esc(String(v.split.releaseMinor))}">
  ${pinField(v.elevated, 'split')}
  <button type="submit" class="approve">Agree to this split</button>
</form>`
        : ''
    }`);
  }
  if (v.canProposeSplit) {
    const held = v.amount;
    blocks.push(`<h2>Propose a split</h2>
<p>Say how the ${esc(held)} being held should be divided. The two figures have to add up to
exactly that, because that is all there is: the introductory fee and the card processing are
already paid and sit outside this. A seller who wants to cover return postage can offer a figure
that allows for it, and postage itself is between the two of you.</p>
<p class="small muted">${
      v.split ? 'Putting up different figures replaces what is on the table now.' : ''
    }</p>
<form method="POST" action="/settlements/${esc(v.id)}/resolution">
  <label for="refund_to_buyer">Back to the buyer (${esc(v.ccy)})</label>
  <input id="refund_to_buyer" name="refund_to_buyer" type="number" step="0.01" min="0" required>
  <label for="release_to_seller">To the seller (${esc(v.ccy)})</label>
  <input id="release_to_seller" name="release_to_seller" type="number" step="0.01" min="0" required>
  <button type="submit">Propose this split</button>
</form>`);
  }
  // Raising it in the first place stays folded away at the bottom, under the
  // things this person is more likely to want.
  const dispute = v.canDispute
    ? foldedDetail(
        'Something is wrong',
        `<p class="small">This freezes the payment where it is. Nothing goes anywhere: the two of
you then have this page to agree a split on, or to send the item back on, and after fourteen
days the payment goes to whichever side can show where the item went.${
          v.handover
            ? ` It also stops the clock, so nothing is released on ${v.handover.byDay}.`
            : ''
        } The introductory fee and the card processing stay paid whatever happens, because the card
processor keeps its own fee on a refund.</p>
<form method="POST" action="/settlements/${esc(v.id)}/dispute">
  <label for="ground">What went wrong</label>
  <div class="choice">
    <label><input type="radio" name="ground" value="not_arrived"> It never arrived</label>
    <label><input type="radio" name="ground" value="not_as_described" checked> It arrived and something is wrong with it</label>
  </div>
  <p class="small muted">Picked it up in person? That is the second one — there is no parcel to go astray.</p>
  <button type="submit" class="danger">Something is wrong — hold the payment</button>
</form>`,
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
