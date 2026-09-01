/** Counter pages: dashboard, ledger, card edit, settings. */
import {
  SUGGESTION_APPETITES,
  arrangementInPlainWords,
  isEmpty as arrangementIsEmpty,
  INTERRUPT_ITEM_MAX,
  NOTES_MAX,
  SHORT_FIELD_MAX,
  type Arrangement,
} from '../domain/arrangement.js';
import { esc, errBox, layout, sharedFieldsFieldset } from './pages.js';

/**
 * What you share on a match. Two boxes, viewable and changeable whenever the
 * person likes — a signed-in session is enough, because typing a suburb into
 * a form tells nobody anything. The disclosure it feeds still waits for a
 * match, both opt-ins, and a PIN.
 */
export function sharedProfilePage(
  v: { firstName: string; locality: string },
  opts: { error?: string; notice?: string } = {},
): string {
  const filled = v.firstName && v.locality;
  return layout('What you share on a match', `
<h1>What you share on a match.</h1>
<p>When you and someone else have both said yes, you each see a first name and
a rough area. That is the whole of what crosses — your email, your cards and
your prices stay on your side.</p>
${errBox(opts.error)}
${opts.notice ? `<div class="note">${esc(opts.notice)}</div>` : ''}
${
  filled
    ? ''
    : `<div class="note">Nothing is filled in yet. Until it is, a match can get to
the point of swapping details and then stall there.</div>`
}
<form method="POST" action="/counter/profile">
  ${sharedFieldsFieldset(v)}
  <button type="submit">Save</button>
</form>
<p class="small muted">A first name and a suburb is all this page wants. Keep phone numbers,
addresses and links out of it — you can swap those in the channel once you have both agreed.</p>
<a class="btn secondary" href="/counter">Back to your approval page</a>`);
}

// ---------------------------------------------------------------------------
// How your agents behave (1.D). The account-level standing arrangement, shown
// back in plain words and editable here. An agent can write one too — it is
// the agent that hears "check twice a day" mid-conversation — and this page is
// what keeps that honest: the human reads the whole of it and has the last
// word on every line.
// ---------------------------------------------------------------------------

const APPETITE_LABELS: Record<string, string> = {
  keen: 'Bring me anything you spot',
  occasional: 'Mention something now and then',
  'big-things-only': 'Only the big ones',
  never: 'Never suggest anything on your own',
};

export function arrangementPage(
  a: Arrangement,
  opts: { error?: string; notice?: string; updated?: string } = {},
): string {
  const lines = arrangementInPlainWords(a);
  const plain = lines.length
    ? `<div class="facts">${lines
        .map((l) => `<div class="fact"><div class="k">${esc(l.k)}</div><div class="v" style="font-size:1.05rem">${esc(l.v)}</div></div>`)
        .join('')}</div>${opts.updated ? `<p class="small muted">Last changed ${esc(opts.updated)}.</p>` : ''}`
    : `<div class="note">Nothing is set yet. Until it is, each agent works this
out with you again from scratch every time it starts up.</div>`;

  const appetite = ['', ...SUGGESTION_APPETITES]
    .map(
      (v) =>
        `<option value="${esc(v)}"${v === (a.suggestion_appetite ?? '') ? ' selected' : ''}>${
          v ? esc(APPETITE_LABELS[v]) : 'No preference set'
        }</option>`,
    )
    .join('');

  return layout('How your agents behave', `
<h1>How your agents behave.</h1>
<p>This is the standing arrangement your agents work to. Every agent you
connect is handed it each time it checks the switchboard, so an agent that has
never met you still knows how often to check, what to wake you for, and when to
leave you alone. Change it here and every one of them picks the change up.</p>
${errBox(opts.error)}
${opts.notice ? `<div class="note">${esc(opts.notice)}</div>` : ''}
${plain}
<h2>Change it</h2>
<form method="POST" action="/counter/arrangement">
  <label for="check_cadence">How often should your agents check?</label>
  <input id="check_cadence" name="check_cadence" type="text" maxlength="${SHORT_FIELD_MAX}"
    value="${esc(a.check_cadence ?? '')}" placeholder="twice a day">
  <label for="interrupt_for">What is worth interrupting you for? One per line.</label>
  <textarea id="interrupt_for" name="interrupt_for" placeholder="a new match&#10;a message on a match we are talking on&#10;anything waiting on my approval page">${esc((a.interrupt_for ?? []).join('\n'))}</textarea>
  <label for="summarize">Everything else waits for&hellip;</label>
  <input id="summarize" name="summarize" type="text" maxlength="${SHORT_FIELD_MAX}"
    value="${esc(a.summarize ?? '')}" placeholder="a round-up on Sunday evening">
  <label for="quiet_hours">Quiet hours</label>
  <input id="quiet_hours" name="quiet_hours" type="text" maxlength="${SHORT_FIELD_MAX}"
    value="${esc(a.quiet_hours ?? '')}" placeholder="after 9pm and before 7am">
  <label for="suggestion_appetite">How keen should they be with suggestions?</label>
  <select id="suggestion_appetite" name="suggestion_appetite">${appetite}</select>
  <label for="notes">Anything else standing</label>
  <textarea id="notes" name="notes" maxlength="${NOTES_MAX}">${esc(a.notes ?? '')}</textarea>
  <button type="submit">Save</button>
</form>
${
  arrangementIsEmpty(a)
    ? ''
    : `<form method="POST" action="/counter/arrangement/clear">
  <button type="submit" class="secondary">Clear the whole arrangement</button>
</form>`
}
<p class="small muted">Preferences only, please: how you want to be treated,
never who you are. Emails, phone numbers and web addresses are turned away, and
each line stays under ${INTERRUPT_ITEM_MAX}&ndash;${NOTES_MAX} characters.</p>
<p class="small muted">One thing an arrangement can never do is approve
something for you. Sharing your details, accepting an offer and confirming a
payment come to this page every single time, whatever any agent has agreed.</p>
<a class="btn secondary" href="/counter">Back to your approval page</a>`);
}

export interface PendingApprovalItem {
  href: string;
  label: string;
  amount?: string;
}

export interface DashboardMatchItem {
  matchId: string;
  category: string;
  score: number;
  verdict?: string;
}

export interface DashboardWindowItem {
  cardId: string;
  category: string;
  type: string;
  until: string;
  interestedParties: number;
}

export interface DashboardView {
  firstName?: string;
  /** "Ana, Fremantle" — what a stage-3 match would see. Absent = not set yet. */
  sharedProfile?: string;
  /** Set when a permanent bounce flagged the account's address unreachable. */
  emailUnreachable?: boolean;
  /** One line of the standing arrangement. Absent = nothing set yet. */
  arrangementSummary?: string;
  killSwitchOn: boolean;
  cardCounts: { total: number; published: number; pending: number };
  pendingApprovals: PendingApprovalItem[];
  matches: DashboardMatchItem[];
  collectionWindows: DashboardWindowItem[];
}

export function dashboardPage(v: DashboardView): string {
  const kill = v.killSwitchOn
    ? `<div class="kill">
<h2 style="margin-top:0">Everything is paused.</h2>
<p class="small">The kill switch is ON: cards are excluded from matching and your
agents' tokens are suspended. Turning back on needs your PIN.</p>
<form method="POST" action="/counter/kill/off">
  <label for="pin">PIN</label>
  <input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6,12}" maxlength="12" required>
  <button type="submit">Turn everything back on</button>
</form></div>`
    : `<div class="kill">
<h2 style="margin-top:0">Kill switch</h2>
<p class="small">One tap: every card paused, every agent token suspended,
confirmation email sent. Un-pausing needs your PIN.</p>
<form method="POST" action="/counter/kill">
  <button type="submit" class="danger">Pause everything now</button>
</form></div>`;

  const approvals = v.pendingApprovals.length
    ? v.pendingApprovals
        .map(
          (a) => `<div class="card-row"><div class="top">
<span class="badge match">WAITING FOR YOU</span></div>
<div class="kv">${esc(a.label)}${a.amount ? ` — <strong>${esc(a.amount)}</strong>` : ''}</div>
<div class="row-actions"><a class="btn" href="${esc(a.href)}">Review &amp; decide</a></div></div>`,
        )
        .join('')
    : `<p class="muted small">Nothing is waiting for you.</p>`;

  // Collection windows: HOLDER-only view. Rivals' pages never render this.
  const windows = v.collectionWindows.length
    ? `<h2>Collecting interest</h2>` +
      v.collectionWindows
        .map(
          (w) => `<div class="card-row"><div class="top">
<span class="badge ${w.type === 'WANT' ? 'want' : 'have'}">${esc(w.type)}</span>
<span class="cat">${esc(w.category)}</span></div>
<div class="kv">${w.interestedParties} interested ${w.interestedParties === 1 ? 'party' : 'parties'} so far
 — window open until ${esc(w.until)}. Offers and interest keep arriving until then.</div>
<form method="POST" action="/counter/collect/${esc(w.cardId)}/close">
  <button type="submit" class="secondary">Close early &amp; choose now</button>
</form></div>`,
        )
        .join('')
    : '';

  const matchRows = v.matches.length
    ? `<h2>Your matches</h2><p class="small muted">Was the switchboard right to
introduce this? One tap tunes your matching. "Not for me" also mutes the
pairing — no reason is ever sent to the other side.</p>` +
      v.matches
        .map(
          (m) => `<div class="card-row"><div class="top">
<span class="badge match">MATCH</span>
<span class="cat">${esc(m.category)}</span>
<span class="badge state">score ${(m.score * 100).toFixed(0)}%</span></div>
${
  m.verdict
    ? `<div class="kv">Your call: <strong>${esc(m.verdict)}</strong></div>`
    : `<div class="row-actions">
<form method="POST" action="/counter/verdict" style="display:inline">
  <input type="hidden" name="match_id" value="${esc(m.matchId)}">
  <input type="hidden" name="verdict" value="good-call">
  <button type="submit" class="secondary">Good call</button>
</form>
<form method="POST" action="/counter/verdict" style="display:inline">
  <input type="hidden" name="match_id" value="${esc(m.matchId)}">
  <input type="hidden" name="verdict" value="not-for-me">
  <button type="submit" class="secondary">Not for me</button>
</form></div>`
}
</div>`,
        )
        .join('')
    : '';

  const emailBanner = v.emailUnreachable
    ? `<div class="err"><strong>Email to you is bouncing.</strong>
An email we sent to your address came back undeliverable, so all email is on
hold. Re-verify your address to switch it back on.
<form method="POST" action="/counter/reverify"><button type="submit">Re-verify my email</button></form></div>`
    : '';

  return layout('Your approval page', `
<h1>${v.firstName ? `G'day${esc(v.firstName ? ', ' + v.firstName : '')}.` : 'Your approval page.'}</h1>
${emailBanner}
<h2>Waiting for you</h2>
${approvals}
${windows}
${matchRows}
<h2>Your ledger</h2>
<p class="small muted">${v.cardCounts.total} card${v.cardCounts.total === 1 ? '' : 's'}
 — ${v.cardCounts.published} live, ${v.cardCounts.pending} in screening.</p>
<a class="btn secondary" href="/counter/ledger">Open the ledger</a>
<h2>What you share on a match</h2>
<p class="small muted">${
    v.sharedProfile
      ? `A match that gets that far sees ${esc(v.sharedProfile)}.`
      : 'A match that gets that far sees a first name and a rough area. Yours are empty.'
  }</p>
<a class="btn secondary" href="/counter/profile">What you share on a match</a>
<h2>How your agents behave</h2>
<p class="small muted">${
    v.arrangementSummary
      ? `Every agent you connect is told: ${esc(v.arrangementSummary)}`
      : 'Nothing is set yet, so each agent works out how often to check and when to leave you alone from scratch every time it starts.'
  }</p>
<a class="btn secondary" href="/counter/arrangement">How your agents behave</a>
<a class="btn secondary" href="/counter/agent-keys">Agent keys</a>
<a class="btn secondary" href="/counter/settings">Settings</a>
${kill}
<form method="POST" action="/counter/logout"><button class="secondary" type="submit">Sign out</button></form>`);
}

export interface LedgerCardView {
  id: string;
  type: 'WANT' | 'HAVE';
  category: string;
  state: string;
  status: string;
  expiresAt: string;
  priceBand?: string; // decrypted server-side, audit-logged
  ask?: string;
  matchSummary: string;
  attributes?: string;
}

export function ledgerPage(cards: LedgerCardView[], notice?: string): string {
  const rows = cards.length
    ? cards
        .map(
          (c) => `<div class="card-row" data-card-id="${esc(c.id)}">
<div class="top">
  <span class="badge ${c.type === 'WANT' ? 'want' : 'have'}">${c.type}</span>
  <span class="cat">${esc(c.category)}</span>
  <span class="badge state">${esc(c.state)}${c.status === 'latent' ? ' · paused' : ''}</span>
</div>
${c.attributes ? `<div class="kv">${esc(c.attributes)}</div>` : ''}
<div class="kv">${c.priceBand ? `private band ${esc(c.priceBand)} · ` : ''}${c.ask ? `ask ${esc(c.ask)} · ` : ''}until ${esc(c.expiresAt)}</div>
<div class="kv">${esc(c.matchSummary)}</div>
${
  c.state === 'WITHDRAWN' || c.state === 'EXPIRED'
    ? ''
    : `<div class="row-actions">
  <a class="btn secondary" href="/counter/ledger/${esc(c.id)}/edit">Edit</a>
  <form method="POST" action="/counter/ledger/${esc(c.id)}/withdraw"><button type="submit" class="secondary">Withdraw</button></form>
</div>`
}
</div>`,
        )
        .join('')
    : `<p class="muted">No cards yet. Your agent posts them; they all show up here.</p>`;
  return layout('Ledger', `
<h1>Your ledger.</h1>
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
<p class="small muted">Every card your agent has posted for you. Private price
bands are shown to you only — never to a counterparty. Edits go back through
screening; withdrawal is immediate.</p>
${rows}
<a class="btn secondary" href="/counter">Back</a>`);
}

export interface CardEditView {
  id: string;
  type: string;
  category: string;
  urgency: string;
  status: string;
  ttlDays: number;
  attributesJson: string;
  askAmount?: string;
  askCcy?: string;
  bandMin?: string;
  bandMax?: string;
  bandCcy?: string;
  collectWindowMinutes?: string;
  /** default window (minutes) for this card's urgency; overrides may only shorten */
  collectWindowDefault: number;
}

export function cardEditPage(c: CardEditView, error?: string): string {
  const opt = (v: string, cur: string) =>
    `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`;
  return layout('Edit card', `
<h1>Edit this card.</h1>
<div class="top" style="display:flex;gap:.6rem;align-items:center;margin-bottom:1rem">
  <span class="badge ${c.type === 'WANT' ? 'want' : 'have'}">${esc(c.type)}</span>
  <span class="cat">${esc(c.category)}</span>
</div>
<p class="small muted">Saving sends the card back through screening before it
returns to the network.</p>
${errBox(error)}
<form method="POST" action="/counter/ledger/${esc(c.id)}/edit">
  <label for="attributes">Attributes (JSON)</label>
  <textarea id="attributes" name="attributes">${esc(c.attributesJson)}</textarea>
  ${
    c.type === 'HAVE'
      ? `<label for="ask_amount">Ask (visible to a matched counterparty)</label>
  <input id="ask_amount" name="ask_amount" type="number" step="0.01" min="0" value="${esc(c.askAmount ?? '')}" placeholder="amount">
  <label for="ask_ccy">Ask currency</label>
  <input id="ask_ccy" name="ask_ccy" type="text" maxlength="3" pattern="[A-Z]{3}" value="${esc(c.askCcy ?? '')}" placeholder="AUD">`
      : ''
  }
  <label for="band_min">Private band — ${c.type === 'WANT' ? 'up to' : 'no less than'} (never disclosed)</label>
  <input id="band_min" name="band_min" type="number" step="0.01" min="0" value="${esc(c.bandMin ?? '')}" placeholder="min">
  <input id="band_max" name="band_max" type="number" step="0.01" min="0" value="${esc(c.bandMax ?? '')}" placeholder="max" style="margin-top:.5rem">
  <label for="band_ccy">Band currency</label>
  <input id="band_ccy" name="band_ccy" type="text" maxlength="3" pattern="[A-Z]{3}" value="${esc(c.bandCcy ?? '')}" placeholder="AUD">
  <label for="urgency">Urgency</label>
  <select id="urgency" name="urgency">${['none', 'days', 'today'].map((u) => opt(u, c.urgency)).join('')}</select>
  <label for="collect_window">Collection window, minutes (optional — when several parties
match this card at once, interest is collected this long before you choose;
may only be SHORTER than the default ${c.collectWindowDefault})</label>
  <input id="collect_window" name="collect_window" type="number" min="1" max="${c.collectWindowDefault}"
   value="${esc(c.collectWindowMinutes ?? '')}" placeholder="${c.collectWindowDefault}">
  <label for="status">Visibility</label>
  <select id="status" name="status">${opt('active', c.status)}${opt('latent', c.status)}</select>
  <label for="ttl_days">Days until expiry</label>
  <input id="ttl_days" name="ttl_days" type="number" min="1" max="365" value="${esc(String(c.ttlDays))}">
  <button type="submit">Save &amp; re-screen</button>
</form>
<a class="btn secondary" href="/counter/ledger">Cancel</a>`);
}

export interface EmailSettingsView {
  blindMode: boolean;
  freqMatches: string;
  freqDigests: string;
  complaintSuppressed: boolean;
  emailUnreachable: boolean;
}

const FREQ_OPTIONS: { value: string; label: string }[] = [
  { value: 'immediate', label: 'Straight away' },
  { value: 'daily', label: 'Once a day' },
  { value: 'weekly', label: 'Once a week' },
  { value: 'off', label: 'Never' },
];

function freqSelect(name: string, current: string): string {
  return `<select name="${name}">${FREQ_OPTIONS.map(
    (o) => `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`,
  ).join('')}</select>`;
}

export function settingsPage(v: EmailSettingsView, notice?: string): string {
  const complaint = v.complaintSuppressed
    ? `<div class="err">You marked one of our emails as spam, so everything
except sign-in codes, approvals and security notices is on hold. Changing the
dials below does nothing while the hold is on.
<form method="POST" action="/counter/settings/email-resume">
  <button type="submit" class="secondary">Start emailing me again</button>
</form></div>`
    : '';
  const unreachable = v.emailUnreachable
    ? `<div class="err">Email to your address is bouncing — all email is on
hold. Re-verify from the <a href="/counter">front page</a>.</div>`
    : '';
  return layout('Settings', `
<h1>Settings.</h1>
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${unreachable}${complaint}
<h2>Email frequency</h2>
<p class="small muted">How often the switchboard may email you. Sign-in codes,
approval requests and security notices always send.
Changes apply immediately and land in your consent log.</p>
<form method="POST" action="/counter/settings/frequency">
  <label for="freq_matches">Match summons</label>
  ${freqSelect('freq_matches', v.freqMatches)}
  <label for="freq_digests">Activity digest &amp; renewals</label>
  ${freqSelect('freq_digests', v.freqDigests)}
  <button type="submit" class="secondary">Save frequency</button>
</form>
<h2>Blind mode</h2>
<p class="small muted">When on, every email we send you becomes a content-free
pointer — "something needs your decision" — with all detail kept here.</p>
<form method="POST" action="/counter/settings/blind-mode">
  <input type="hidden" name="blind_mode" value="${v.blindMode ? 'off' : 'on'}">
  <button type="submit" class="secondary">${v.blindMode ? 'Turn blind mode off' : 'Turn blind mode on'}</button>
</form>
<p class="small muted">Blind mode is ${v.blindMode ? '<strong>on</strong>' : 'off'}.</p>
<a class="btn secondary" href="/counter">Back</a>`);
}

// ---------------------------------------------------------------------------
// Agent keys (1.C). A key is a long password an agent sends with every
// request, for the agents that cannot do a browser sign-in. Issued here by
// hand, PIN-confirmed, shown once.
// ---------------------------------------------------------------------------

export interface AgentKeyItem {
  keyId: string;
  name: string;
  created: string;
  lastUsed?: string;
  expires: string;
}

export interface AgentKeysView {
  keys: AgentKeyItem[];
  /** True inside a PIN or passkey ceremony's window: the form stops asking. */
  elevated: boolean;
  atLimit: boolean;
}

export function agentKeysPage(v: AgentKeysView, notice?: string, error?: string): string {
  const rows = v.keys.length
    ? v.keys
        .map(
          (k) => `<div class="card-row"><div class="top">
<span class="badge state">KEY</span><span class="cat">${esc(k.name)}</span></div>
<div class="kv">made ${esc(k.created)} · ${k.lastUsed ? `last used ${esc(k.lastUsed)}` : 'never used yet'} · lapses ${esc(k.expires)}</div>
<div class="row-actions">
<form method="POST" action="/counter/agent-keys/revoke">
  <input type="hidden" name="key_id" value="${esc(k.keyId)}">
  <button type="submit" class="secondary">Revoke</button>
</form></div></div>`,
        )
        .join('')
    : `<p class="muted small">You have no keys yet.</p>`;

  const pinBlock = v.elevated
    ? `<input type="hidden" name="pin" value="">`
    : `<label for="pin">Confirm with your PIN</label>
  <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6,12}" maxlength="12" required>`;

  const createForm = v.atLimit
    ? `<p class="muted small">You are holding as many keys as we allow at once.
Revoke one you have finished with to make room.</p>`
    : `<form method="POST" action="/counter/agent-keys">
  <label for="name">What is this key for?</label>
  <input id="name" name="name" type="text" maxlength="60" required placeholder="the laptop agent">
  ${pinBlock}
  <button type="submit">Make a key</button>
</form>`;

  return layout('Agent keys', `
<h1>Agent keys.</h1>
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${errBox(error)}
<p>Most agents sign in through your browser the first time they call the
switchboard. A few cannot do that. Give one of those a key instead: a long
password it sends with every request.</p>
<p class="small muted">Anyone holding a key can post cards and negotiate as your
agent. It still cannot approve anything — approvals only ever happen here, on
this page, with your PIN. Keep a key somewhere private, and revoke it the
moment you have finished with it. Keys lapse after 90 days, and the kill
switch stops them dead along with everything else.</p>
<h2>Your keys</h2>
${rows}
<h2>Make a new one</h2>
${createForm}
<a class="btn secondary" href="/counter">Back</a>`);
}

/** The one and only sighting of the plaintext key. */
export function agentKeyCreatedPage(v: { name: string; token: string; expires: string }): string {
  return layout('Your new agent key', `
<h1>Here is your key.</h1>
<p>Copy it now and paste it into your agent's configuration. This page is the
only place it is ever shown — we keep a fingerprint of it and nothing more, so
if it gets away from you, revoke it and make another.</p>
<div class="fact"><div class="k">${esc(v.name)}</div><div class="v" id="keybox">${esc(v.token)}</div></div>
<button type="button" id="copybtn" class="approve">Copy the key</button>
<p class="small muted">Your agent sends it as a header:</p>
<div class="fact"><div class="k">Header</div><div class="v">Authorization: Bearer ${esc(v.token.slice(0, 11))}…</div></div>
<p class="small muted">It lapses on ${esc(v.expires)}. Revoke it any time from
your keys page.</p>
<a class="btn secondary" href="/counter/agent-keys">Back to my keys</a>
<script>
document.getElementById('copybtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(${JSON.stringify(v.token)});
    document.getElementById('copybtn').textContent = 'Copied';
  } catch {}
});
</script>`);
}

// ---------------------------------------------------------------------------
// "Still true?" renewal review (reached from the renewal email's signed link).
// ---------------------------------------------------------------------------
export interface RenewCardView {
  type: string;
  category: string;
  /** The card's own attributes, summarised — what tells two same-category cards apart. */
  attributes?: string;
  expires: string;
  expiringSoon: boolean;
}

export function renewPage(cards: RenewCardView[], token: string): string {
  const rows = cards
    .map(
      (c) => `<div class="card-row"><div class="top">
<span class="badge ${c.type === 'WANT' ? 'want' : 'have'}">${esc(c.type)}</span>
<span class="cat">${esc(c.category)}</span>
${c.expiringSoon ? '<span class="badge state">lapses within a week</span>' : ''}</div>
${c.attributes ? `<div class="kv">${esc(c.attributes)}</div>` : ''}
<div class="kv">lapses ${esc(c.expires)}</div></div>`,
    )
    .join('');
  return layout('Still true?', `
<h1>Still true?</h1>
<p>Cards lapse on their own — that rule keeps every want and have honest.
These are your open cards. One tap restarts each card's own clock.</p>
${rows}
<form method="POST" action="/counter/renew">
  <input type="hidden" name="t" value="${esc(token)}">
  <button type="submit">Still true — keep them all</button>
</form>
<a class="btn secondary" href="/counter/ledger">Review one by one instead</a>`);
}

// ---------------------------------------------------------------------------
// Unsubscribe (footer link lands here; the POST is also the RFC 8058 target).
// ---------------------------------------------------------------------------
export function unsubPage(token: string): string {
  return layout('Unsubscribe', `
<h1>Fewer emails.</h1>
<p>This switches off match summons and activity digests. Sign-in codes,
approval requests and security notices keep sending.</p>
<form method="POST" action="/counter/email/unsub">
  <input type="hidden" name="t" value="${esc(token)}">
  <button type="submit">Unsubscribe me</button>
</form>
<p class="small muted">You can turn anything back on any time in
<a href="/counter/settings">settings</a>.</p>`);
}

// ---------------------------------------------------------------------------
// Email re-verification after a hard bounce.
// ---------------------------------------------------------------------------
export function reverifyCodePage(verificationId: string, error?: string): string {
  return layout('Re-verify your email', `
<h1>Check your inbox.</h1>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<p>We sent a fresh code to your address. Enter it here and email switches back
on. If it never arrives, the address itself is the problem — your mailbox is
full, or the address no longer exists.</p>
<form method="POST" action="/counter/reverify/verify">
  <input type="hidden" name="verification_id" value="${esc(verificationId)}">
  <label for="code">Code</label>
  <input id="code" name="code" class="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autofocus>
  <button type="submit">Verify</button>
</form>`);
}
