/**
 * Counter pages: dashboard, ledger, card edit, settings.
 *
 * Same shape as pages.ts — ask, act, detail — and the same visual system. The
 * dashboard is the one page that is a list rather than a decision, so it is
 * ordered by what it is asking of the person: everything waiting on them at
 * the top as tappable cards, then quiet navigation to the things they go and
 * look at when they feel like it.
 */
import {
  SUGGESTION_APPETITES,
  arrangementInPlainWords,
  isEmpty as arrangementIsEmpty,
  CHECK_EVERY_MINUTES_HELP,
  CHECK_EVERY_MINUTES_MAX,
  CHECK_EVERY_MINUTES_MIN,
  INTERRUPT_ITEM_MAX,
  NOTES_MAX,
  SHORT_FIELD_MAX,
  type Arrangement,
} from '../domain/arrangement.js';
import {
  MODE_EXPLANATIONS,
  MODE_NAMES,
  mandateInPlainWords,
  type Mandate,
  type NegotiationMode,
} from '../domain/negotiation.js';
import {
  counterOfferForm,
  esc,
  errBox,
  foldedDetail,
  layout,
  sharedFieldsFieldset,
  DRAFT_LINE,
  type OfferDraftView,
} from './pages.js';

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
<p class="lead">When you and someone else have both said yes, you each see a
first name and a rough area.</p>
${errBox(opts.error)}
${opts.notice ? `<div class="note">${esc(opts.notice)}</div>` : ''}
${
  filled
    ? ''
    : `<div class="note">Nothing is filled in yet. Until it is, a match can get to
the point of swapping details and then stall there.</div>`
}
<form method="POST" action="/profile">
  ${sharedFieldsFieldset(v)}
  <button type="submit">Save</button>
</form>
<p class="small muted">That is the whole of what crosses — your email, your cards
and your prices stay on your side. Keep phone numbers, addresses and links out
of these two boxes; you can swap those in the channel once you have both agreed.</p>
<a class="btn secondary" href="/">Back to your approval page</a>`);
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
<p class="lead">This is the standing arrangement your agents work to. Change it
here and every one of them picks the change up.</p>
${errBox(opts.error)}
${opts.notice ? `<div class="note">${esc(opts.notice)}</div>` : ''}
${plain}
<h2>Change it</h2>
<form method="POST" action="/arrangement">
  <label for="check_every_minutes">How often should your agents check? In minutes.</label>
  <input id="check_every_minutes" name="check_every_minutes" type="number" inputmode="numeric"
    min="${CHECK_EVERY_MINUTES_MIN}" max="${CHECK_EVERY_MINUTES_MAX}" step="1"
    value="${esc(Number.isFinite(a.check_every_minutes as number) ? String(a.check_every_minutes) : '')}"
    placeholder="720">
  <p class="field-help">${esc(CHECK_EVERY_MINUTES_HELP)}</p>
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
${foldedDetail(
  'What an arrangement can and cannot do',
  `<p class="small">Every agent you connect is handed this each time it checks the
switchboard, so an agent that has never met you still knows how often to check,
what to wake you for, and when to leave you alone.</p>
<p class="small">Preferences only, please: how you want to be treated, and never
who you are. Emails, phone numbers and web addresses are turned away, and each
line stays under ${INTERRUPT_ITEM_MAX}&ndash;${NOTES_MAX} characters.</p>
<p class="small">One thing an arrangement can never do is approve something for
you. Sharing your details, accepting an offer and confirming a payment come to
this page every single time, whatever any agent has agreed.</p>`,
)}
${
  arrangementIsEmpty(a)
    ? ''
    : `<form method="POST" action="/arrangement/clear">
  <button type="submit" class="secondary">Clear the whole arrangement</button>
</form>`
}
<a class="btn secondary" href="/">Back to your approval page</a>`);
}

export interface PendingApprovalItem {
  href: string;
  label: string;
  amount?: string;
  /** Button wording. Defaults to the decide-on-something wording. */
  cta?: string;
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
  /** Cards whose clock runs out within the week, if any do. */
  lapsingSoon?: { count: number; soonest: string };
}

export function dashboardPage(v: DashboardView): string {
  const kill = v.killSwitchOn
    ? `<div class="kill">
<h2>Everything is paused.</h2>
<p class="small">The kill switch is ON: cards are excluded from matching and your
agents' tokens are suspended. Turning back on needs your PIN.</p>
<form method="POST" action="/kill/off">
  <label for="pin">PIN</label>
  <input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6,12}" maxlength="12" required>
  <button type="submit">Turn everything back on</button>
</form></div>`
    : `<div class="kill">
<h2>Kill switch</h2>
<p class="small">One tap: every card paused, every agent token suspended,
confirmation email sent. Un-pausing needs your PIN.</p>
<form method="POST" action="/kill">
  <button type="submit" class="danger">Pause everything now</button>
</form></div>`;

  // 1. Decisions. Whole card is the tap target; the wording of the button
  //    stays on the card so the person knows what they are opening.
  const approvals = v.pendingApprovals
    .map(
      (a) => `<a class="todo urgent" href="${esc(a.href)}">
<span class="badge match">WAITING FOR YOU</span>
<div class="what">${esc(a.label)}</div>
${a.amount ? `<div class="figure">${esc(a.amount)}</div>` : ''}
<div class="go">${esc(a.cta ?? 'Review & decide')}</div></a>`,
    )
    .join('');

  // 2. Windows on a clock. HOLDER-only: rivals' pages never render this.
  const windows = v.collectionWindows
    .map(
      (w) => `<div class="card-row"><div class="top">
<span class="badge ${w.type === 'WANT' ? 'want' : 'have'}">${esc(w.type)}</span>
<span class="cat">${esc(w.category)}</span></div>
<div class="kv">${w.interestedParties} interested ${w.interestedParties === 1 ? 'party' : 'parties'} so far
 — window open until ${esc(w.until)}. Offers and interest keep arriving until then.</div>
<form method="POST" action="/collect/${esc(w.cardId)}/close">
  <button type="submit" class="secondary">Close early &amp; choose now</button>
</form></div>`,
    )
    .join('');

  // 3. Cards whose clock is nearly out.
  const renewals = v.lapsingSoon?.count
    ? `<a class="todo" href="/ledger">
<span class="badge state">LAPSING</span>
<div class="what">${v.lapsingSoon.count} card${v.lapsingSoon.count === 1 ? '' : 's'} of yours
${v.lapsingSoon.count === 1 ? 'runs' : 'run'} out by ${esc(v.lapsingSoon.soonest)}</div>
<div class="go">Check they are still true</div></a>`
    : '';

  // 4. One-tap match feedback. Light, and last: nothing is blocked on it.
  const matchRows = v.matches.length
    ? `<h3>Was the switchboard right?</h3>
<p class="small muted">One tap tunes your matching. "Not for me" also mutes the
pairing, and no reason is ever sent to the other side.</p>` +
      v.matches
        .map(
          (m) => `<div class="card-row"><div class="top">
<span class="badge match">MATCH</span>
<span class="cat">${esc(m.category)}</span>
<span class="badge state">score ${(m.score * 100).toFixed(0)}%</span></div>
${
  m.verdict
    ? `<div class="kv">Your call: <strong>${esc(m.verdict)}</strong></div>`
    : ''
}
<div class="row-actions">
${
  m.verdict
    ? ''
    : `<form method="POST" action="/verdict">
  <input type="hidden" name="match_id" value="${esc(m.matchId)}">
  <input type="hidden" name="verdict" value="good-call">
  <button type="submit" class="secondary">Good call</button>
</form>
<form method="POST" action="/verdict">
  <input type="hidden" name="match_id" value="${esc(m.matchId)}">
  <input type="hidden" name="verdict" value="not-for-me">
  <button type="submit" class="secondary">Not for me</button>
</form>`
}
<a class="btn secondary" href="/matches/${esc(m.matchId)}">Offers &amp; your number</a>
</div>
</div>`,
        )
        .join('')
    : '';

  const nothingWaiting =
    !v.pendingApprovals.length && !v.collectionWindows.length && !renewals && !v.matches.length;

  const emailBanner = v.emailUnreachable
    ? `<div class="err"><strong>Email to you is bouncing.</strong>
An email we sent to your address came back undeliverable, so all email is on
hold. Re-verify your address to switch it back on.
<form method="POST" action="/reverify"><button type="submit">Re-verify my email</button></form></div>`
    : '';

  const cards = `${v.cardCounts.total} card${v.cardCounts.total === 1 ? '' : 's'} — ${v.cardCounts.published} live, ${v.cardCounts.pending} in screening.`;
  const nav = `<div class="navlist">
<a href="/ledger"><span class="nav-t">Your ledger</span><span class="nav-d">${esc(cards)}</span></a>
<a href="/profile"><span class="nav-t">What you share on a match</span><span class="nav-d">${
    v.sharedProfile
      ? `A match that gets that far sees ${esc(v.sharedProfile)}.`
      : 'A match that gets that far sees a first name and a rough area. Yours are empty.'
  }</span></a>
<a href="/arrangement"><span class="nav-t">How your agents behave</span><span class="nav-d">${
    v.arrangementSummary
      ? `Every agent you connect is told: ${esc(v.arrangementSummary)}`
      : 'Nothing is set yet, so each agent works out how often to check and when to leave you alone from scratch every time it starts.'
  }</span></a>
<a href="/agent-keys"><span class="nav-t">Agent keys</span><span class="nav-d">Long passwords for agents that cannot sign in through a browser.</span></a>
<a href="/settings"><span class="nav-t">Settings</span><span class="nav-d">How often we may email you, and blind mode.</span></a>
</div>`;

  return layout('Your approval page', `
<h1>${v.firstName ? `G'day, ${esc(v.firstName)}.` : 'Your approval page.'}</h1>
${emailBanner}
<h2>Waiting for you</h2>
${nothingWaiting ? `<div class="empty">Nothing is waiting for you.</div>` : ''}
${approvals}
${renewals}
${windows}
${matchRows}
<h2>Your switchboard</h2>
${nav}
${kill}
<form method="POST" action="/logout"><button class="secondary" type="submit">Sign out</button></form>`);
}

export interface LedgerCardView {
  id: string;
  type: 'WANT' | 'HAVE';
  category: string;
  /** Where the card sits and how far it reaches, in one line: "Canberra,
   *  Australian Capital Territory, Australia — matching within 150 km", or
   *  "— reaching all of Australia", or "— reaching anywhere". The point of
   *  showing it is that only the person who lives there can tell when it is
   *  wrong. */
  location?: string;
  state: string;
  status: string;
  expiresAt: string;
  priceBand?: string; // decrypted server-side, audit-logged
  ask?: string;
  matchSummary: string;
  attributes?: string;
  /** Who writes this card's negotiating figures. Defaults to Pass on. */
  mode: NegotiationMode;
}

/** A finished connection the human filed away — shown in a quiet "past
 *  connections" area, distinct from the live cards above it. */
export interface PastConnectionView {
  /** Leaf label of the category, e.g. "book club". */
  category: string;
  /** "Alex, Franklin" where the two reached stage-3 disclosure; absent otherwise. */
  who?: string;
  /** When it was filed away, e.g. "2026-09-03". */
  archivedOn?: string;
}

export function ledgerPage(
  cards: LedgerCardView[],
  notice?: string,
  pastConnections: PastConnectionView[] = [],
): string {
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
${c.location ? `<div class="kv">${esc(c.location)}</div>` : ''}
<div class="kv">${c.priceBand ? `private band ${esc(c.priceBand)} · ` : ''}${c.ask ? `ask ${esc(c.ask)} · ` : ''}until ${esc(c.expiresAt)}</div>
<div class="kv">${esc(c.matchSummary)} · negotiating: ${esc(MODE_NAMES[c.mode])}</div>
${
  c.state === 'WITHDRAWN' || c.state === 'EXPIRED'
    ? ''
    : `<div class="row-actions">
  <a class="btn secondary" href="/ledger/${esc(c.id)}/edit">Edit</a>
  <a class="btn secondary" href="/ledger/${esc(c.id)}/numbers">Your numbers</a>
  <form method="POST" action="/ledger/${esc(c.id)}/withdraw"><button type="submit" class="secondary">Withdraw</button></form>
</div>`
}
</div>`,
        )
        .join('')
    : `<div class="empty">No cards yet. Your agent posts them; they all show up here.</div>`;
  const past = pastConnections.length
    ? `<section class="past-connections">
<h2 class="small-head">Past connections</h2>
<p class="small">Connections you have filed away as finished. The record stays here so you can look one back up any time; the switchboard kept the first name and area they shared, what it was about, and the date. Anything you said to each other, and any number you swapped, lives in your own chat with your agent.</p>
${pastConnections
  .map(
    (p) => `<div class="card-row past">
<div class="top">
  <span class="cat">${esc(p.category)}</span>
  <span class="badge state">filed away</span>
</div>
<div class="kv">${p.who ? esc(p.who) : 'connected before details were shared'}${p.archivedOn ? ` · ${esc(p.archivedOn)}` : ''}</div>
</div>`,
  )
  .join('')}
</section>`
    : '';
  return layout('Ledger', `
<h1>Your ledger.</h1>
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${rows}
${past}
${foldedDetail(
  'How the ledger works',
  `<p class="small">Every card your agent has posted for you. Private price bands
are shown to you only and never to a counterparty. Edits go back through
screening; withdrawal is immediate.</p>
<p class="small">Every card starts on ${esc(MODE_NAMES.relay)}:
${esc(MODE_EXPLANATIONS.relay)}</p>`,
)}
<a class="btn secondary" href="/">Back</a>`);
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
  /** Present when screening turned this card away: why, in plain words. */
  screeningRejection?: { plain: string; code?: string };
}

export function cardEditPage(c: CardEditView, error?: string): string {
  const opt = (v: string, cur: string) =>
    `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`;
  // Screening's verdict, in words the person can act on. The raw code sits
  // small underneath so a support conversation has something exact to quote.
  const rejection = c.screeningRejection
    ? `<div class="err">
<strong>This card didn&#39;t pass screening.</strong>
<p style="margin:.5rem 0 0">${esc(c.screeningRejection.plain)}</p>
${c.screeningRejection.code ? `<p class="small muted" style="margin:.5rem 0 0">screening code: ${esc(c.screeningRejection.code)}</p>` : ''}
</div>`
    : '';
  return layout('Edit card', `
<h1>Edit this card.</h1>
<div class="top" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem">
  <span class="badge ${c.type === 'WANT' ? 'want' : 'have'}">${esc(c.type)}</span>
  <span class="cat">${esc(c.category)}</span>
</div>
${rejection}
${errBox(error)}
<form method="POST" action="/ledger/${esc(c.id)}/edit">
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
  <label for="band_max">Private band — the other end</label>
  <input id="band_max" name="band_max" type="number" step="0.01" min="0" value="${esc(c.bandMax ?? '')}" placeholder="max">
  <label for="band_ccy">Band currency</label>
  <input id="band_ccy" name="band_ccy" type="text" maxlength="3" pattern="[A-Z]{3}" value="${esc(c.bandCcy ?? '')}" placeholder="AUD">
  <label for="urgency">Urgency</label>
  <select id="urgency" name="urgency">${['none', 'days', 'today'].map((u) => opt(u, c.urgency)).join('')}</select>
  <label for="collect_window">Collection window, in minutes (optional)</label>
  <input id="collect_window" name="collect_window" type="number" min="1" max="${c.collectWindowDefault}"
   value="${esc(c.collectWindowMinutes ?? '')}" placeholder="${c.collectWindowDefault}">
  <p class="field-help">When several parties match this card at once, interest is
collected this long before you choose. It may only be SHORTER than the default
${c.collectWindowDefault}.</p>
  <label for="status">Visibility</label>
  <select id="status" name="status">${opt('active', c.status)}${opt('latent', c.status)}</select>
  <label for="ttl_days">Days until expiry</label>
  <input id="ttl_days" name="ttl_days" type="number" min="1" max="365" value="${esc(String(c.ttlDays))}">
  <button type="submit">Save &amp; re-screen</button>
</form>
<p class="small muted">Saving sends the card back through screening before it
returns to the network.</p>
<a class="btn secondary" href="/ledger/${esc(c.id)}/numbers">Your numbers on this card</a>
<a class="btn secondary" href="/ledger">Cancel</a>`);
}

// ---------------------------------------------------------------------------
// Your numbers (1.E). Who writes the figures this card negotiates with. Both
// modes and every number on this page are set here and nowhere else — no agent
// surface can read or change either, which is what makes "the numbers are
// yours" a fact about the software rather than a promise about behaviour.
// ---------------------------------------------------------------------------

export interface CardNumbersView {
  id: string;
  type: 'WANT' | 'HAVE';
  category: string;
  mode: NegotiationMode;
  mandate?: Mandate;
  /** Re-rendered form values after a rejected submission. */
  form?: { open?: string; limit?: string; step?: string; ccy?: string };
  /** A figure this card's agent was refused for on Pass on, waiting to be sent
   *  from the match it belongs to. */
  draft?: OfferDraftView & { matchId: string };
}

export function cardNumbersPage(v: CardNumbersView, error?: string, notice?: string): string {
  const f = v.form ?? {
    open: v.mandate?.open != null ? String(v.mandate.open) : '',
    limit: v.mandate?.limit != null ? String(v.mandate.limit) : '',
    step: v.mandate?.step != null ? String(v.mandate.step) : '',
    ccy: v.mandate?.ccy ?? '',
  };
  const selling = v.type === 'HAVE';
  const current = v.mandate
    ? `<div class="facts">${mandateInPlainWords(v.mandate, v.type)
        .map((l) => `<div class="fact"><div class="k">${esc(l.k)}</div><div class="v">${esc(l.v)}</div></div>`)
        .join('')}</div>`
    : '';
  // A number the agent carried back sits at the top of this page, because a
  // person who arrived from that refusal came here to deal with it.
  const draft = v.draft
    ? `<a class="todo urgent" href="/matches/${esc(v.draft.matchId)}">
<span class="badge match">WAITING FOR YOU</span>
<div class="what">${esc(DRAFT_LINE)}</div>
<div class="figure">${esc(v.draft.amount)} ${esc(v.draft.ccy)}</div>
${v.draft.note ? `<div class="kv">Your line: &ldquo;${esc(v.draft.note)}&rdquo;</div>` : ''}
<div class="go">Check it and send</div></a>`
    : '';
  const modeRadio = (m: NegotiationMode) =>
    `<label class="modeopt" for="mode_${m}">
  <input id="mode_${m}" name="mode" type="radio" value="${m}"${v.mode === m ? ' checked' : ''}>
  <strong>${esc(MODE_NAMES[m])}</strong>
  <span class="small muted">${esc(MODE_EXPLANATIONS[m])}</span>
</label>`;
  return layout('Your numbers', `
<h1>Your numbers on this card.</h1>
<div class="top" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem">
  <span class="badge ${selling ? 'have' : 'want'}">${esc(v.type)}</span>
  <span class="cat">${esc(v.category)}</span>
</div>
${errBox(error)}
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${draft}
<p class="lead">Every figure this card carries into a negotiation is one you
wrote. Your agent presents and advises; it never invents a price of its own.</p>
${current}
<form method="POST" action="/ledger/${esc(v.id)}/numbers">
  <h2>How this card negotiates</h2>
  ${modeRadio('relay')}
  ${modeRadio('mandate')}
  <h2>Your numbers</h2>
  <p class="small muted">These are needed for Auto-negotiate and are kept
  private the same way your band is: your agent works inside them, and the
  other side is never told any of it.</p>
  <label for="open">Open at (optional)</label>
  <input id="open" name="open" type="number" step="0.01" min="0" value="${esc(f.open ?? '')}" placeholder="amount">
  <label for="limit">${selling ? 'Take no less than' : 'Pay no more than'}</label>
  <input id="limit" name="limit" type="number" step="0.01" min="0" value="${esc(f.limit ?? '')}" placeholder="amount">
  <label for="step">Move in steps of at least (optional)</label>
  <input id="step" name="step" type="number" step="0.01" min="0" value="${esc(f.step ?? '')}" placeholder="amount">
  <label for="ccy">Currency</label>
  <input id="ccy" name="ccy" type="text" maxlength="3" pattern="[A-Za-z]{3}" value="${esc(f.ccy ?? '')}" placeholder="AUD">
  <button type="submit">Save</button>
</form>
${
  v.mandate
    ? `<form method="POST" action="/ledger/${esc(v.id)}/numbers/clear">
  <button type="submit" class="secondary">Clear my numbers and go back to Pass on</button>
</form>`
    : ''
}
<p class="small muted">Whichever way this is set, accepting an offer still
comes to you here, with your PIN. Auto-negotiate lets your agent put figures on
the table between the two you wrote; it never agrees anything.</p>
<a class="btn secondary" href="/ledger/${esc(v.id)}/edit">Back to the card</a>`);
}

// ---------------------------------------------------------------------------
// Offers on one match: the whole run of figures, and the box where this person
// types the next one. In Pass on this is where their side's numbers come from.
// ---------------------------------------------------------------------------

export interface MatchOfferItem {
  amount: string;
  mine: boolean;
  state: string;
  authoredByMe?: 'human' | 'agent';
  note?: string;
  expires: string;
}

export interface MatchOffersView {
  matchId: string;
  cardId: string;
  category: string;
  type: 'WANT' | 'HAVE';
  mode: NegotiationMode;
  offers: MatchOfferItem[];
  /** False when the match is not at a stage where offers are open. */
  canOffer: boolean;
  canOfferBlockedBecause?: string;
  form?: { amount?: string; ccy?: string; note?: string };
  /** A figure this person's agent was refused for on Pass on, prefilled into
   *  the box below so they can check it and send it. */
  draft?: OfferDraftView;
}

export function matchOffersPage(v: MatchOffersView, error?: string, notice?: string): string {
  const rows = v.offers.length
    ? v.offers
        .map(
          (o) => `<div class="card-row"><div class="top">
<span class="badge ${o.mine ? 'have' : 'want'}">${o.mine ? 'YOURS' : 'THEIRS'}</span>
<span class="badge state">${esc(o.state)}</span></div>
<div class="kv"><strong>${esc(o.amount)}</strong> — good until ${esc(o.expires)}${
            o.mine && o.authoredByMe
              ? ` · ${o.authoredByMe === 'human' ? 'you typed this one' : 'your agent sent this one from your numbers'}`
              : ''
          }</div>
${
            o.note
              ? `<div class="kv">${o.mine ? 'Your line:' : 'Their words:'} “${esc(o.note)}”</div>`
              : ''
          }
</div>`,
        )
        .join('')
    : `<div class="empty">No figures on the table yet.</div>`;
  // A resubmitted form beats a draft: what the person just typed is newer than
  // anything their agent left here.
  const useDraft = !v.form && !!v.draft;
  return layout('Offers on this match', `
<h1>Offers on this match.</h1>
<div class="top" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem">
  <span class="badge ${v.type === 'HAVE' ? 'have' : 'want'}">${esc(v.type)}</span>
  <span class="cat">${esc(v.category)}</span>
  <span class="badge state">${esc(MODE_NAMES[v.mode])}</span>
</div>
${errBox(error)}
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${
  v.canOffer
    ? counterOfferForm(v.matchId, {
        ccy: useDraft ? v.draft!.ccy : v.form?.ccy,
        amount: useDraft ? v.draft!.amount : v.form?.amount,
        note: useDraft ? v.draft!.note : v.form?.note,
        draft: useDraft,
      })
    : `<p class="note">${esc(v.canOfferBlockedBecause ?? 'Offers are not open on this match yet.')}</p>`
}
<h2>What has been offered</h2>
${rows}
<p class="small muted">${esc(MODE_NAMES[v.mode])} — ${esc(MODE_EXPLANATIONS[v.mode])}</p>
<a class="btn secondary" href="/ledger/${esc(v.cardId)}/numbers">Your numbers on this card</a>
<a class="btn secondary" href="/">Back to your approval page</a>`);
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

function freqSelect(id: string, name: string, current: string): string {
  return `<select id="${id}" name="${name}">${FREQ_OPTIONS.map(
    (o) => `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`,
  ).join('')}</select>`;
}

export function settingsPage(v: EmailSettingsView, notice?: string): string {
  const complaint = v.complaintSuppressed
    ? `<div class="err">You marked one of our emails as spam, so everything
except sign-in codes, approvals and security notices is on hold. Changing the
dials below does nothing while the hold is on.
<form method="POST" action="/settings/email-resume">
  <button type="submit" class="secondary">Start emailing me again</button>
</form></div>`
    : '';
  const unreachable = v.emailUnreachable
    ? `<div class="err">Email to your address is bouncing — all email is on
hold. Re-verify from the <a href="/">front page</a>.</div>`
    : '';
  return layout('Settings', `
<h1>Settings.</h1>
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${unreachable}${complaint}
<h2>Email frequency</h2>
<form method="POST" action="/settings/frequency">
  <label for="freq_matches">Match summons</label>
  ${freqSelect('freq_matches', 'freq_matches', v.freqMatches)}
  <label for="freq_digests">Activity digest &amp; renewals</label>
  ${freqSelect('freq_digests', 'freq_digests', v.freqDigests)}
  <button type="submit" class="secondary">Save frequency</button>
</form>
<p class="small muted">How often the switchboard may email you. Sign-in codes,
approval requests and security notices always send. Changes apply immediately
and land in your consent log.</p>
<h2>Blind mode</h2>
<p class="small muted">Blind mode is ${v.blindMode ? '<strong>on</strong>' : 'off'}. When on,
every email we send you becomes a content-free pointer — "something needs your
decision" — with all detail kept here.</p>
<form method="POST" action="/settings/blind-mode">
  <input type="hidden" name="blind_mode" value="${v.blindMode ? 'off' : 'on'}">
  <button type="submit" class="secondary">${v.blindMode ? 'Turn blind mode off' : 'Turn blind mode on'}</button>
</form>
<a class="btn secondary" href="/">Back</a>`);
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
<form method="POST" action="/agent-keys/revoke">
  <input type="hidden" name="key_id" value="${esc(k.keyId)}">
  <button type="submit" class="secondary">Revoke</button>
</form></div></div>`,
        )
        .join('')
    : `<div class="empty">You have no keys yet.</div>`;

  const pinBlock = v.elevated
    ? `<input type="hidden" name="pin" value="">`
    : `<label for="pin">Confirm with your PIN</label>
  <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6,12}" maxlength="12" required>`;

  const createForm = v.atLimit
    ? `<p class="muted small">You are holding as many keys as we allow at once.
Revoke one you have finished with to make room.</p>`
    : `<form method="POST" action="/agent-keys">
  <label for="name">What is this key for?</label>
  <input id="name" name="name" type="text" maxlength="60" required placeholder="the laptop agent">
  ${pinBlock}
  <button type="submit">Make a key</button>
</form>`;

  return layout('Agent keys', `
<h1>Agent keys.</h1>
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${errBox(error)}
<h2>Your keys</h2>
${rows}
<h2>Make a new one</h2>
${createForm}
${foldedDetail(
  'What a key can do',
  `<p class="small">Most agents sign in through your browser the first time they
call the switchboard. A few cannot do that. Give one of those a key instead: a
long password it sends with every request.</p>
<p class="small">Anyone holding a key can post cards and negotiate as your
agent. It still cannot approve anything — approvals only ever happen here, on
this page, with your PIN. Keep a key somewhere private, and revoke it the
moment you have finished with it. Keys lapse after 90 days, and the kill switch
stops them dead along with everything else.</p>`,
)}
<a class="btn secondary" href="/">Back</a>`);
}

/** The one and only sighting of the plaintext key. */
export function agentKeyCreatedPage(v: { name: string; token: string; expires: string }): string {
  return layout('Your new agent key', `
<h1>Here is your key.</h1>
<p class="lead">Copy it now and paste it into your agent's configuration. This
page is the only place it is ever shown.</p>
<div class="fact"><div class="k">${esc(v.name)}</div><div class="v" id="keybox">${esc(v.token)}</div></div>
<button type="button" id="copybtn" class="approve">Copy the key</button>
<p class="small muted">We keep a fingerprint of it and nothing more, so if it
gets away from you, revoke it and make another.</p>
<p class="small muted">Your agent sends it as a header:</p>
<div class="fact"><div class="k">Header</div><div class="v">Authorization: Bearer ${esc(v.token.slice(0, 11))}…</div></div>
<p class="small muted">It lapses on ${esc(v.expires)}. Revoke it any time from
your keys page.</p>
<a class="btn secondary" href="/agent-keys">Back to my keys</a>
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
<p class="lead">These are your open cards. One tap restarts each card's own clock.</p>
<form method="POST" action="/renew">
  <input type="hidden" name="t" value="${esc(token)}">
  <button type="submit">Still true — keep them all</button>
</form>
<a class="btn secondary" href="/ledger">Review one by one instead</a>
<h2>What you have open</h2>
${rows}
<p class="small muted">Cards lapse on their own — that rule keeps every want and
have honest.</p>`);
}

// ---------------------------------------------------------------------------
// Unsubscribe (footer link lands here; the POST is also the RFC 8058 target).
// ---------------------------------------------------------------------------
export function unsubPage(token: string): string {
  return layout('Unsubscribe', `
<h1>Fewer emails.</h1>
<p class="lead">This switches off match summons and activity digests. Sign-in
codes, approval requests and security notices keep sending.</p>
<form method="POST" action="/email/unsub">
  <input type="hidden" name="t" value="${esc(token)}">
  <button type="submit">Unsubscribe me</button>
</form>
<p class="small muted">You can turn anything back on any time in
<a href="/settings">settings</a>.</p>`);
}

// ---------------------------------------------------------------------------
// Email re-verification after a hard bounce.
// ---------------------------------------------------------------------------
export function reverifyCodePage(verificationId: string, error?: string): string {
  return layout('Re-verify your email', `
<h1>Check your inbox.</h1>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<p class="lead">We sent a fresh code to your address. Enter it here and email
switches back on.</p>
<form method="POST" action="/reverify/verify">
  <input type="hidden" name="verification_id" value="${esc(verificationId)}">
  <label for="code">Code</label>
  <input id="code" name="code" class="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autofocus>
  <button type="submit">Verify</button>
</form>
<p class="small muted">If it never arrives, the address itself is the problem —
your mailbox is full, or the address no longer exists.</p>`);
}
