/** Counter pages: dashboard, ledger, card edit, settings. */
import { esc, errBox, layout } from './pages.js';

export interface PendingApprovalItem {
  href: string;
  label: string;
  amount?: string;
}

export interface DashboardView {
  firstName?: string;
  killSwitchOn: boolean;
  cardCounts: { total: number; published: number; pending: number };
  pendingApprovals: PendingApprovalItem[];
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

  return layout('The counter', `
<h1>${v.firstName ? `G'day${esc(v.firstName ? ', ' + v.firstName : '')}.` : 'Your counter.'}</h1>
<h2>Waiting for you</h2>
${approvals}
<h2>Your ledger</h2>
<p class="small muted">${v.cardCounts.total} card${v.cardCounts.total === 1 ? '' : 's'}
 — ${v.cardCounts.published} live, ${v.cardCounts.pending} in screening.</p>
<a class="btn secondary" href="/counter/ledger">Open the ledger</a>
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
  <select id="urgency" name="urgency">${['none', 'low', 'medium', 'high'].map((u) => opt(u, c.urgency)).join('')}</select>
  <label for="status">Visibility</label>
  <select id="status" name="status">${opt('active', c.status)}${opt('latent', c.status)}</select>
  <label for="ttl_days">Days until expiry</label>
  <input id="ttl_days" name="ttl_days" type="number" min="1" max="365" value="${esc(String(c.ttlDays))}">
  <button type="submit">Save &amp; re-screen</button>
</form>
<a class="btn secondary" href="/counter/ledger">Cancel</a>`);
}

export function settingsPage(v: { blindMode: boolean }, notice?: string): string {
  return layout('Settings', `
<h1>Settings.</h1>
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
<h2>Blind mode</h2>
<p class="small muted">When on, every email we send you becomes a content-free
pointer — "something at the counter needs you" — with all detail kept here.</p>
<form method="POST" action="/counter/settings/blind-mode">
  <input type="hidden" name="blind_mode" value="${v.blindMode ? 'off' : 'on'}">
  <button type="submit" class="secondary">${v.blindMode ? 'Turn blind mode off' : 'Turn blind mode on'}</button>
</form>
<p class="small muted">Blind mode is ${v.blindMode ? '<strong>on</strong>' : 'off'}.</p>
<h2>Match frequency</h2>
<p class="small muted">How often the switchboard may nudge you. Full controls
arrive in the next update.</p>
<select disabled><option>Balanced (default)</option></select>
<a class="btn secondary" href="/counter">Back</a>`);
}
