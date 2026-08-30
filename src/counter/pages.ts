/**
 * The counter — server-rendered pages. One column, generous spacing,
 * phone-first. Brand: Sora (display) / Newsreader (body) / IBM Plex Mono
 * (data), light + dark both designed. Patch the octopus appears small and
 * tasteful in the header.
 */

export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export const CONSENT_STATEMENT =
  'My agent may store wants & haves as cards on my behalf. I can see, edit, or withdraw everything at the counter.';

const CSS = `
:root {
  --paper:#F6F8F7; --ink:#1C2523; --line:#D3DBD8;
  --want:#B45309; --have:#0E7268; --match:#6D28D9;
  --muted:#5c6a66; --card:#FFFFFF; --danger:#a3271f; --danger-ink:#ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper:#101614; --ink:#E6ECE9; --line:#2A3733;
    --want:#E0A24A; --have:#45B8A9; --match:#A78BFA;
    --muted:#93a49f; --card:#161d1b; --danger:#e2564c; --danger-ink:#14100f;
  }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--paper); color:var(--ink);
  font-family:'Newsreader', Georgia, serif; font-size:1.06rem; line-height:1.55;
  -webkit-font-smoothing:antialiased; }
.wrap { max-width: 30rem; margin: 0 auto; padding: 1.25rem 1.25rem 4rem; }
header.site { display:flex; align-items:baseline; gap:.55rem; padding:1.1rem 0 1.6rem; }
header.site .octo { font-size:1rem; }
header.site a { color:var(--ink); text-decoration:none; }
header.site .brand { font-family:'Sora',sans-serif; font-weight:700; font-size:.95rem; letter-spacing:.01em; }
header.site .sub { color:var(--muted); font-size:.8rem; font-family:'Sora',sans-serif; font-weight:600; }
h1 { font-family:'Sora',sans-serif; font-weight:700; font-size:1.55rem; line-height:1.2; margin:0 0 .8rem; }
h2 { font-family:'Sora',sans-serif; font-weight:600; font-size:1.02rem; margin:2.2rem 0 .6rem; }
p { margin:.5rem 0 1rem; } .muted { color:var(--muted); } .small { font-size:.86rem; }
a { color:var(--match); }
form { margin:1.2rem 0 0; }
label { display:block; font-family:'Sora',sans-serif; font-weight:600; font-size:.82rem; margin:1.1rem 0 .35rem; }
input[type=email], input[type=text], input[type=password], input[type=number], select, textarea {
  width:100%; padding:.7rem .75rem; font-size:1.05rem; color:var(--ink);
  background:var(--card); border:1px solid var(--line); border-radius:10px;
  font-family:'IBM Plex Mono',monospace; }
textarea { min-height:6rem; }
input.code { font-size:1.7rem; letter-spacing:.45em; text-align:center; }
button, .btn { display:block; width:100%; margin-top:1.3rem; padding:.85rem 1rem; border:0;
  border-radius:12px; background:var(--ink); color:var(--paper);
  font-family:'Sora',sans-serif; font-weight:600; font-size:1rem; cursor:pointer; text-align:center;
  text-decoration:none; }
button.secondary, .btn.secondary { background:transparent; color:var(--ink); border:1.5px solid var(--line); }
button.danger { background:var(--danger); color:var(--danger-ink); }
button.approve { background:var(--have); color:#fff; }
.err { background:color-mix(in srgb, var(--danger) 12%, var(--paper)); border:1px solid var(--danger);
  border-radius:10px; padding:.65rem .8rem; font-size:.92rem; margin:1rem 0; }
.note { border:1px solid var(--line); border-radius:10px; padding:.65rem .8rem; font-size:.9rem;
  color:var(--muted); margin:1rem 0; }
.facts { margin:1.6rem 0; }
.fact { border:1px solid var(--line); background:var(--card); border-radius:14px;
  padding:1rem 1.1rem; margin:.7rem 0; }
.fact .k { font-family:'Sora',sans-serif; font-weight:600; font-size:.78rem; color:var(--muted);
  text-transform:uppercase; letter-spacing:.06em; }
.fact .v { font-family:'IBM Plex Mono',monospace; font-size:1.45rem; margin-top:.15rem; overflow-wrap:anywhere; }
.anomaly { border:2px solid var(--want); background:color-mix(in srgb, var(--want) 12%, var(--paper));
  border-radius:14px; padding:1rem 1.1rem; margin:.7rem 0;
  font-family:'Sora',sans-serif; font-weight:700; font-size:1.15rem; }
.anomaly .k { font-size:.78rem; letter-spacing:.06em; text-transform:uppercase; font-weight:600; }
.card-row { border:1px solid var(--line); background:var(--card); border-radius:14px;
  padding:1rem 1.1rem; margin: .8rem 0; }
.card-row .top { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; }
.badge { font-family:'Sora',sans-serif; font-weight:700; font-size:.72rem; letter-spacing:.05em;
  padding:.18rem .5rem; border-radius:999px; color:#fff; }
.badge.want { background:var(--want); } .badge.have { background:var(--have); }
.badge.state { background:transparent; color:var(--muted); border:1px solid var(--line); font-weight:600; }
.badge.match { background:var(--match); }
.cat { font-family:'IBM Plex Mono',monospace; font-size:.95rem; overflow-wrap:anywhere; }
.kv { font-family:'IBM Plex Mono',monospace; font-size:.85rem; color:var(--muted); margin-top:.4rem; overflow-wrap:anywhere; }
.row-actions { display:flex; gap:.7rem; margin-top:.8rem; }
.row-actions form { margin:0; flex:1; } .row-actions .btn, .row-actions button { margin-top:0; padding:.55rem; font-size:.88rem; }
.consent-box { border:1.5px solid var(--line); background:var(--card); border-radius:14px; padding:1rem 1.1rem; margin:1rem 0; }
.consent-box label { display:flex; gap:.7rem; align-items:flex-start; margin:.4rem 0; font-family:'Newsreader',serif;
  font-weight:400; font-size:1rem; line-height:1.5; }
.consent-box input { width:1.15rem; height:1.15rem; margin-top:.2rem; flex:none; }
.kill { border:2px solid var(--danger); border-radius:14px; padding:1rem 1.1rem; margin:2rem 0; }
hr { border:0; border-top:1px solid var(--line); margin:2rem 0; }
footer { margin-top:3rem; color:var(--muted); font-size:.8rem; font-family:'Sora',sans-serif; }
`;

export function layout(title: string, body: string, opts: { head?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — OpenSwitchboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style>${opts.head ?? ''}</head><body>
<div class="wrap">
<header class="site"><span class="octo">🐙</span>
  <a href="/counter"><span class="brand">OpenSwitchboard</span></a>
  <span class="sub">the counter</span></header>
${body}
<footer>Everything agents must never do, you do here.<br>openswitchboard.ai</footer>
</div></body></html>`;
}

export const errBox = (msg?: string) => (msg ? `<div class="err">${esc(msg)}</div>` : '');

// ---------------------------------------------------------------------------

export function landingPage(): string {
  return layout('The counter', `
<h1>The counter.</h1>
<p>Your agent works the switchboard — posting wants &amp; haves, checking matches,
negotiating. The counter is the one place where <em>you</em> do everything it
never can: open the account, set your PIN, approve what gets shared or paid,
see the ledger, pull the plug.</p>
<a class="btn" href="/counter/register">Open an account</a>
<a class="btn secondary" href="/counter/login">Sign in</a>`);
}

export function registerEmailPage(error?: string): string {
  return layout('Open an account', `
<h1>Open an account.</h1>
<p>We'll email you a six-digit code to prove this address is yours.</p>
${errBox(error)}
<form method="POST" action="/counter/register">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required autofocus>
  <button type="submit">Email me a code</button>
</form>
<p class="small muted">Already have an account? <a href="/counter/login">Sign in</a>.</p>`);
}

export function codeEntryPage(params: {
  verificationId: string;
  action: string; // form target
  error?: string;
  heading?: string;
}): string {
  return layout('Enter your code', `
<h1>${esc(params.heading ?? 'Check your email.')}</h1>
<p>Enter the six-digit code we just sent. It works once and expires in 15 minutes.</p>
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
<p>Six or more digits. Your PIN approves the sensitive stuff — disclosures,
settlements, turning things back on. It never touches your agent.</p>
${errBox(error)}
<form method="POST" action="/counter/pin/set">
  <label for="pin">PIN (6+ digits)</label>
  <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{6,12}" minlength="6" maxlength="12" required autofocus>
  <label for="pin2">PIN again</label>
  <input id="pin2" name="pin2" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{6,12}" minlength="6" maxlength="12" required>
  <button type="submit">Set PIN</button>
</form>`);
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
<p>Optional, recommended: sign in and approve with Face&nbsp;ID, a fingerprint,
or your device passcode instead of email codes.</p>
<div id="pkerr"></div>
<button id="enrol">Add a passkey</button>
<form method="POST" action="/counter/passkey/skip"><button class="secondary" type="submit">Skip for now</button></form>
${WEBAUTHN_HELPERS}
<script>
document.getElementById('enrol').addEventListener('click', async () => {
  try {
    const opts = await postJson('/counter/passkey/options');
    opts.challenge = b64uToBuf(opts.challenge);
    opts.user.id = b64uToBuf(opts.user.id);
    (opts.excludeCredentials||[]).forEach(c=>c.id=b64uToBuf(c.id));
    const cred = await navigator.credentials.create({ publicKey: opts });
    const body = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON),
                  attestationObject: bufToB64u(cred.response.attestationObject),
                  transports: cred.response.getTransports ? cred.response.getTransports() : [] },
      clientExtensionResults: cred.getClientExtensionResults() };
    await postJson('/counter/passkey/verify', body);
    location.href = '/counter/consent';
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
<form method="POST" action="/counter/consent">
  <div class="consent-box">
    <label><input type="checkbox" name="adult" value="yes" required>
      I am 18 or older.</label>
    <label><input type="checkbox" name="consent" value="yes" required>
      ${esc(CONSENT_STATEMENT)}</label>
  </div>
  <button type="submit">Open my account</button>
</form>
<p class="small muted">Both statements are recorded in a tamper-evident consent log.</p>`);
}

export function loginEmailPage(error?: string): string {
  return layout('Sign in', `
<h1>Sign in.</h1>
${errBox(error)}
<div id="pkerr"></div>
<button id="pk" class="secondary">Sign in with a passkey</button>
<form method="POST" action="/counter/login">
  <label for="email">Or use email</label>
  <input id="email" name="email" type="email" autocomplete="email" required>
  <button type="submit">Email me a code</button>
</form>
<p class="small muted">New here? <a href="/counter/register">Open an account</a>.</p>
${WEBAUTHN_HELPERS}
<script>
document.getElementById('pk').addEventListener('click', async () => {
  try {
    const opts = await postJson('/counter/login/passkey/options');
    opts.challenge = b64uToBuf(opts.challenge);
    (opts.allowCredentials||[]).forEach(c=>c.id=b64uToBuf(c.id));
    const cred = await navigator.credentials.get({ publicKey: opts });
    const body = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON),
                  authenticatorData: bufToB64u(cred.response.authenticatorData),
                  signature: bufToB64u(cred.response.signature),
                  userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : null },
      clientExtensionResults: cred.getClientExtensionResults() };
    const r = await postJson('/counter/login/passkey/verify', body);
    location.href = r.next || '/counter';
  } catch (e) {
    document.getElementById('pkerr').innerHTML = '<div class="err">Passkey sign-in failed: '
      + String(e.message||e).replace(/[<>&]/g,'') + '</div>';
  }
});
</script>`);
}

export function messagePage(title: string, html: string, backHref = '/counter', backLabel = 'Back to the counter'): string {
  return layout(title, `<h1>${esc(title)}</h1>${html}
<a class="btn secondary" href="${esc(backHref)}">${esc(backLabel)}</a>`);
}

export function linkDeadPage(reason: 'used' | 'expired' | 'invalid'): string {
  const text = {
    used: `<p>This approval link has already been used. Each link works exactly once.</p>
<p class="muted small">If you still have something waiting, it's listed on your counter.</p>`,
    expired: `<p>This approval link has expired — links live for 15 minutes.</p>
<p class="muted small">Anything still waiting for you is listed on your counter.</p>`,
    invalid: `<p>This approval link isn't valid.</p>`,
  }[reason];
  const title = { used: 'Already used', expired: 'Link expired', invalid: 'Not a valid link' }[reason];
  return layout(title, `<h1>${esc(title)}.</h1>${text}
<a class="btn" href="/counter">Go to the counter</a>`);
}

export interface ApprovalView {
  action: 'offer-accept' | 'stage3-disclosure';
  refId: string;
  facts: { k: string; v: string }[]; // the three facts, big
  anomalies: string[];
  hasPasskey: boolean;
  elevated: boolean;
  postPath: string; // decision endpoint
}

export function approvalPage(v: ApprovalView, error?: string): string {
  const title = v.action === 'offer-accept' ? 'Approve this settlement?' : 'Share your details?';
  const anomalyHtml = v.anomalies
    .map((a) => `<div class="anomaly"><div class="k">Worth a second look</div>${esc(a)}</div>`)
    .join('');
  const facts = v.facts
    .map((f) => `<div class="fact"><div class="k">${esc(f.k)}</div><div class="v">${esc(f.v)}</div></div>`)
    .join('');
  const pinBlock = v.elevated
    ? `<input type="hidden" name="pin" value="">`
    : `<label for="pin">Confirm with your PIN</label>
       <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6,12}" maxlength="12" required>`;
  const passkeyBtn = v.hasPasskey && !v.elevated
    ? `<div id="pkerr"></div><button type="button" id="pkapprove" class="secondary">Approve with passkey instead</button>`
    : '';
  return layout(title, `
<h1>${esc(title)}</h1>
${errBox(error)}
<div class="facts">${anomalyHtml}${facts}</div>
<form method="POST" action="${esc(v.postPath)}" id="approveForm">
  <input type="hidden" name="ref_id" value="${esc(v.refId)}">
  <input type="hidden" name="action" value="${esc(v.action)}">
  ${pinBlock}
  <button type="submit" name="decision" value="approve" class="approve">Approve</button>
  <button type="submit" name="decision" value="decline" class="secondary">Decline — nothing ${v.action === 'offer-accept' ? 'is accepted' : 'is shared'}</button>
</form>
${passkeyBtn}
<p class="small muted">Approve needs your PIN${v.hasPasskey ? ' or passkey' : ''}. Decline shares nothing and carries no reason.</p>
${v.hasPasskey && !v.elevated ? WEBAUTHN_HELPERS + `<script>
document.getElementById('pkapprove').addEventListener('click', async () => {
  try {
    const opts = await postJson('/counter/login/passkey/options');
    opts.challenge = b64uToBuf(opts.challenge);
    (opts.allowCredentials||[]).forEach(c=>c.id=b64uToBuf(c.id));
    const cred = await navigator.credentials.get({ publicKey: opts });
    const body = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON),
                  authenticatorData: bufToB64u(cred.response.authenticatorData),
                  signature: bufToB64u(cred.response.signature),
                  userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : null },
      clientExtensionResults: cred.getClientExtensionResults(), elevate_only: true };
    await postJson('/counter/login/passkey/verify', body);
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
<div class="fact"><div class="k">Agent</div><div class="v">${esc(clientName)}</div></div>
<p>It can post wants &amp; haves as cards, review matches, and negotiate.
Anything irreversible — sharing your details, accepting an offer — still
waits for you, here at the counter.</p>
<form method="POST" action="${esc(postPath)}">
${hiddenInputs}
  <button type="submit" name="decision" value="approve">Authorize</button>
  <button type="submit" name="decision" value="deny" class="secondary">Cancel</button>
</form>`);
}

export function registrationClosedPage(): string {
  return layout('Registration opens at launch', `
<h1>Registration opens at launch.</h1>
<p>OpenSwitchboard — the switchboard for AI intent — is not yet open for
sign-ups. Accounts, agents and intents all arrive at launch.</p>`);
}
