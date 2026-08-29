const CSS = `
  body { font-family: -apple-system, system-ui, sans-serif; background: #f4f2ee; color: #1c1b19;
         display: flex; justify-content: center; padding: 8vh 1rem; margin: 0; }
  .box { background: #fff; border: 1px solid #d8d4cc; border-radius: 10px; padding: 2rem;
         max-width: 26rem; width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
  h1 { font-size: 1.15rem; margin: 0 0 .4rem; } .octo { font-size: 1.6rem; }
  p { font-size: .9rem; line-height: 1.45; color: #4a463f; }
  label { display: block; font-size: .8rem; margin: .9rem 0 .25rem; color: #4a463f; }
  input { width: 100%; box-sizing: border-box; padding: .55rem; border: 1px solid #c9c4ba;
          border-radius: 6px; font-size: .95rem; }
  button { margin-top: 1.2rem; width: 100%; padding: .6rem; border: 0; border-radius: 6px;
           background: #1c1b19; color: #fff; font-size: .95rem; cursor: pointer; }
  .err { background: #fbeaea; border: 1px solid #e5b8b8; color: #7a2222; padding: .5rem .7rem;
         border-radius: 6px; font-size: .85rem; }
  .note { font-size: .75rem; color: #8a8479; margin-top: 1.2rem; }
`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export function loginPage(params: {
  clientName: string;
  hidden: Record<string, string>;
  error?: string;
}): string {
  const hiddenInputs = Object.entries(params.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenSwitchboard — sign in</title><style>${CSS}</style></head><body>
<div class="box">
  <div class="octo">🐙</div>
  <h1>Sign in to OpenSwitchboard</h1>
  <p><strong>${esc(params.clientName)}</strong> is asking to act as your agent on the
     switchboard: post intents for you, review matches, and negotiate — while
     anything irreversible still waits for you.</p>
  ${params.error ? `<div class="err">${esc(params.error)}</div>` : ''}
  <form method="POST" action="/oauth/authorize">
    ${hiddenInputs}
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required>
    <label for="login_code">Access code</label>
    <input id="login_code" name="login_code" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in &amp; authorize</button>
  </form>
  <p class="note">Dev environment: accounts are created by the operator bootstrap
     CLI and this page authenticates those access codes only. This interim page
     is replaced in phase 0.D by the counter's registration (PIN/passkey).</p>
</div></body></html>`;
}

export function registrationClosedPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenSwitchboard</title><style>${CSS}</style></head><body>
<div class="box">
  <div class="octo">🐙</div>
  <h1>Registration opens at launch</h1>
  <p>OpenSwitchboard — the switchboard for AI intent — is not yet open for
     sign-ups. There is nothing to sign in to here yet: accounts, agents and
     intents all arrive at launch.</p>
  <p class="note">openswitchboard.ai</p>
</div></body></html>`;
}
