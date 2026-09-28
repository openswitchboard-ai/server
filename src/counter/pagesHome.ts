/**
 * Counter pages: dashboard, ledger, want/have edit, settings.
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
import { categoryPhrase, offerAmountInWords } from '../email/templates.js';
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
import * as cpages from './pages.js';
import { matchBoxHtml, timelineHtml, type MatchBoxView } from './matchStory.js';
import type { MatchStep } from '../domain/matchStory.js';

/**
 * A rendered figure ("415 AUD") said the way a person says it ("$415 AUD").
 *
 * The views on these pages carry money as text the route has already put
 * together, so this unpicks it and hands it to the one helper that decides how
 * a figure is written. Anything it cannot read goes back unchanged.
 */
function moneyPhrase(amount: string): string {
  const m = /^(-?[\d.]+)\s+([A-Za-z]{3})$/.exec(String(amount).trim());
  if (!m) return String(amount);
  return offerAmountInWords(Number(m[1]), m[2]!.toUpperCase());
}

/** The one line under the suburb box on these pages (28 September 2026). */
export const AREA_LINE = 'Pick your suburb from the list, or type a wider area if you prefer.';

/**
 * The two shared boxes as pages.ts draws them, with the long help paragraph
 * under the suburb swapped for AREA_LINE, and, where `optional`, neither box
 * required. pages.ts owns the fieldset (the approval page draws it too); this
 * only trims what these pages say under it, and a unit test pins that the
 * swap still finds its mark.
 */
export function plainSharedFields(
  v: { firstName: string; locality: string },
  opts: { optional?: boolean } = {},
): string {
  let html = sharedFieldsFieldset(v).replace(
    `<p class="field-help">${cpages.AREA_HELP}</p>`,
    `<p class="field-help">${esc(AREA_LINE)}</p>`,
  );
  if (opts.optional) html = html.replace(/ required>/g, '>');
  return html;
}

/** Shown on the profile page while nothing is filled in. */
export const PROFILE_EMPTY_NOTE = "Nothing filled in yet. You'll be asked the first time you share them.";

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
first name and a suburb.</p>
${errBox(opts.error)}
${opts.notice ? `<div class="note">${esc(opts.notice)}</div>` : ''}
${filled ? '' : `<div class="note">${esc(PROFILE_EMPTY_NOTE)}</div>`}
<form method="POST" action="/profile">
  ${plainSharedFields(v)}
  <button type="submit">Save</button>
</form>
<p class="small muted">Keep phone numbers, addresses and links out of these boxes.
Swap those in the conversation once you have both agreed.</p>
<a class="btn secondary" href="/settings">Back</a>`);
}

// ---------------------------------------------------------------------------
// How your assistant works (1.D). The account-level standing arrangement,
// shown back in plain words and editable here. An assistant can write one too
// (it is the one that hears "check twice a day" mid-conversation) and this
// page is what keeps that honest: the person reads the whole of it and has the
// last word on every line.
//
// No product names on any of these pages (28 September 2026): a person knows
// which kind of assistant they use without being handed a list of brands.
// ---------------------------------------------------------------------------

/**
 * The two-way choice, drawn once. Onboarding, settings and the arrangement
 * page all ask a question of this shape — one of two kinds, a short head and a
 * line under it — and a person meeting the second one should recognise it from
 * the first.
 */
interface ModeOption {
  value: string;
  head: string;
  rest: string;
}

function modeOptions(
  name: string,
  idPrefix: string,
  options: ModeOption[],
  current: string,
): string {
  return options
    .map(
      (o) => `<label class="modeopt" for="${idPrefix}_${o.value}">
  <input id="${idPrefix}_${o.value}" name="${name}" type="radio" value="${esc(o.value)}"${
    o.value === current ? ' checked' : ''
  }>
  <strong>${esc(o.head)}</strong>
  <span class="small muted">${esc(o.rest)}</span>
</label>`,
    )
    .join('');
}

/**
 * Whether the assistant runs between conversations (arrangement
 * runs_on_its_own). This is NOT hears_via: that one decides whether the
 * switchboard emails the person and lives on the settings page; this one
 * decides what an assistant may promise to do later. The arrangement page
 * shows hears_via as a fact with a link rather than asking it a second time.
 */
const RUNS_ON_ITS_OWN_OPTIONS: ModeOption[] = [
  {
    value: 'on',
    head: 'It runs on its own.',
    rest: 'It checks between our conversations, so it can watch for things without me asking.',
  },
  {
    value: 'off',
    head: 'It waits for me.',
    rest: 'It only acts while we are talking.',
  },
];

const APPETITE_LABELS: Record<string, string> = {
  keen: 'Bring me anything you spot',
  occasional: 'Mention something now and then',
  'big-things-only': 'Only the big ones',
  never: 'Never suggest anything on your own',
};

/**
 * The arrangement's plain-words lines are written in domain/arrangement.ts,
 * where two of the headings still say "agent". A person reads "assistant",
 * and the headings read the same as the form's labels below them, so the
 * page renames them here and passes any heading it does not know through.
 */
const ARRANGEMENT_HEADINGS: Record<string, string> = {
  'Your agent between conversations': 'Between conversations',
  'How often your agents check': 'How often it checks',
  'Worth interrupting you for': "What's worth interrupting you for",
  'Everything else waits for': 'What can wait for a round-up',
  Suggestions: 'How often it should suggest things',
  'Also standing': 'Anything else',
};

/** "Set: between conversations, how often it checks, quiet hours." Undefined when nothing is. */
export function arrangementSummaryLine(lines: { k: string }[]): string | undefined {
  if (!lines.length) return undefined;
  const heads = lines.map((l) => lowerFirst(ARRANGEMENT_HEADINGS[l.k] ?? l.k));
  return `Set: ${heads.join(', ')}.`;
}

/** The page's own wording for the cadence rule, in place of the one written for assistants. */
export const CADENCE_NEEDS_RUNS_ON_ITS_OWN_PAGE =
  'How often it checks only applies when your assistant runs on its own. Pick "It runs on its own" or leave the minutes empty.';

/** How this person hears about things, as a fact. */
export function hearsViaFact(h: HearsVia): string {
  return h === 'assistant' ? 'You hear about things through your assistant.' : 'You hear about things by email.';
}

export function arrangementPage(
  a: Arrangement,
  // `updated` is localTime() markup, not plain text: it goes in unescaped.
  opts: { error?: string; notice?: string; updated?: string; hearsVia?: HearsVia } = {},
): string {
  const lines = arrangementInPlainWords(a);
  const plain = lines.length
    ? `<div class="facts">${lines
        .map(
          (l) =>
            `<div class="fact"><div class="k">${esc(ARRANGEMENT_HEADINGS[l.k] ?? l.k)}</div><div class="v" style="font-size:1.05rem">${esc(l.v)}</div></div>`,
        )
        .join('')}</div>${opts.updated ? `<p class="small muted">Last changed ${opts.updated}.</p>` : ''}`
    : `<div class="note">Nothing set yet.</div>`;

  const appetite = ['', ...SUGGESTION_APPETITES]
    .map(
      (v) =>
        `<option value="${esc(v)}"${v === (a.suggestion_appetite ?? '') ? ' selected' : ''}>${
          v ? esc(APPETITE_LABELS[v]) : 'No preference set'
        }</option>`,
    )
    .join('');

  return layout('How your assistant works', `
<h1>How your assistant works.</h1>
<p class="lead">Every assistant you connect works to this.</p>
${errBox(opts.error)}
${opts.notice ? `<div class="note">${esc(opts.notice)}</div>` : ''}
${opts.hearsVia ? `<p class="small muted">${esc(hearsViaFact(opts.hearsVia))} <a href="/settings">Change</a></p>` : ''}
${plain}
<h2>Change it</h2>
<form method="POST" action="/arrangement">
  <h3>Does your assistant run on its own?</h3>
  ${modeOptions('runs_on_its_own', 'runs', RUNS_ON_ITS_OWN_OPTIONS, a.runs_on_its_own ? 'on' : 'off')}
  <label for="check_every_minutes">How often it checks (minutes, 30 or more)</label>
  <input id="check_every_minutes" name="check_every_minutes" type="number" inputmode="numeric"
    min="${CHECK_EVERY_MINUTES_MIN}" max="${CHECK_EVERY_MINUTES_MAX}" step="1"
    value="${esc(Number.isFinite(a.check_every_minutes as number) ? String(a.check_every_minutes) : '')}"
    placeholder="720">
  <label for="interrupt_for">What's worth interrupting you for (one per line)</label>
  <textarea id="interrupt_for" name="interrupt_for" placeholder="a new match&#10;a message on a match we are talking on&#10;anything waiting on my main page">${esc((a.interrupt_for ?? []).join('\n'))}</textarea>
  <label for="summarize">What can wait for a round-up</label>
  <input id="summarize" name="summarize" type="text" maxlength="${SHORT_FIELD_MAX}"
    value="${esc(a.summarize ?? '')}" placeholder="a round-up on Sunday evening">
  <label for="quiet_hours">Quiet hours</label>
  <input id="quiet_hours" name="quiet_hours" type="text" maxlength="${SHORT_FIELD_MAX}"
    value="${esc(a.quiet_hours ?? '')}" placeholder="after 9pm and before 7am">
  <label for="suggestion_appetite">How often it should suggest things</label>
  <select id="suggestion_appetite" name="suggestion_appetite">${appetite}</select>
  <label for="notes">Anything else</label>
  <textarea id="notes" name="notes" maxlength="${NOTES_MAX}">${esc(a.notes ?? '')}</textarea>
  <button type="submit">Save</button>
</form>
${foldedDetail(
  'What this can and cannot do',
  `<p class="small">Every assistant you connect is handed this each time it checks
the switchboard, so one that has never met you still knows how often to check,
what to wake you for, and when to leave you alone.</p>
<p class="small">Preferences only: how you want to be treated, and never who you
are. Emails, phone numbers and web addresses are turned away, and each line
stays under ${INTERRUPT_ITEM_MAX}&ndash;${NOTES_MAX} characters.</p>
<p class="small">It can never approve anything for you. Sharing your name,
accepting an offer and confirming a payment come to your main page every time.</p>`,
)}
${
  arrangementIsEmpty(a)
    ? ''
    : `<form method="POST" action="/arrangement/clear">
  <button type="submit" class="secondary">Clear all of it</button>
</form>`
}
<a class="btn secondary" href="/settings">Back</a>`);
}

export interface PendingApprovalItem {
  /** Where the tile goes. Absent for a tile that is a fact with nothing to
   *  open, such as a want or have screening turned away: the fix is the
   *  assistant's to make. */
  href?: string;
  label: string;
  /** Plain lines under the label, e.g. screening's reason and what to do. */
  lines?: string[];
  amount?: string;
  /** Button wording. Defaults to the decide-on-something wording. */
  cta?: string;
}

/**
 * One plain line for an open request, by what its page asks. The same words
 * for every kind of thing: only the shelf the posting sits on changes, and it
 * is left out where there is none.
 */
export function openRequestLabel(action: string, thing?: string): string {
  const on = thing ? ` on your ${thing} match` : '';
  switch (action) {
    case 'conversation-photo':
      return `Send a photo${on}`;
    case 'stage3-disclosure':
      return `Share your first name and suburb${on}?`;
    case 'offer-send':
      return `Send your number${on}?`;
    case 'offer-accept':
      return `Take the offer${on}?`;
    case 'negotiation-auto':
      return thing
        ? `Let your assistant talk numbers on your ${thing}?`
        : 'Let your assistant talk numbers?';
    case 'conversation-renew':
      return `Keep talking${on}?`;
    case 'report':
      return `Report the person${on}`;
    case 'shelf-pick':
      return 'Pick where your posting goes';
    default:
      return 'Something is waiting for you';
  }
}

/** The button under an open request. */
export const OPEN_REQUEST_CTA = 'Open it';

export interface DashboardView {
  /** True while an authorised agent has not yet swapped its code for a token:
   *  the page reloads itself when it regains focus and every few seconds. */
  awaitingConnect?: boolean;
  firstName?: string;
  /** One line at the top, e.g. "Google Antigravity is connected." */
  notice?: string;
  /** Set when a permanent bounce flagged the account's address unreachable. */
  emailUnreachable?: boolean;
  killSwitchOn: boolean;
  /** What a sensitive press on this page takes. Absent on the callers that
   *  render no such press; the kill switch falls back to asking for a PIN. */
  ceremony?: cpages.CeremonyView;
  cardCounts: { total: number; published: number; pending: number };
  /** One box per match with anything waiting: its story and its buttons.
   *  Drawn first under Decisions. */
  matchBoxes?: MatchBoxView[];
  /** Every other open match, one line each: its title and its latest step. */
  inProgress?: { href: string; title: string; last: string }[];
  /** The account's IANA zone, for the times in the boxes. Absent = UTC,
   *  labelled, rewritten into the reader's clock by the page. */
  timezone?: string | null;
  /** What is waiting that belongs to no match: a shelf to pick, a posting
   *  screening turned away. Plain cards, as they always were. */
  pendingApprovals: PendingApprovalItem[];
  /** Cards whose clock runs out within the week, if any do. `soonest` is
   *  localTime(…, 'day') markup, so the day reads in the person's own clock. */
  lapsingSoon?: { count: number; soonest: string };
  /** Conversations holding messages nobody has collected yet. The count and
   *  what the conversation is about; never a word of what was said. */
  messagesWaiting?: DashboardMessagesItem[];
  /** Matches where a human accepted an offer. The switchboard is finished
   *  with these, and both sides are told so in the same words. */
  agreed?: DashboardAgreedItem[];
}

export interface DashboardMessagesItem {
  matchId: string;
  /** The category's own label, e.g. "Mountain bikes". */
  category: string;
  count: number;
}

export interface DashboardAgreedItem {
  matchId: string;
  category: string;
  /** Rendered money, e.g. "415 AUD". */
  amount: string;
}

/**
 * The one-tap answers. The words stored are the words a person says, so this
 * table reads a verdict back unchanged; the two spellings the wire used before
 * run 7 are kept here for any row an older process wrote.
 */
const VERDICT_WORDS: Record<string, string> = {
  good: 'good',
  fine: 'fine',
  bad: 'bad',
  'good-call': 'good',
  'not-for-me': 'bad',
};

/**
 * What this page is for, in one line under the greeting.
 *
 * The assistant is where the conversation happens, and this page holds the
 * handful of decisions a person has to make themselves. Saying so at the top
 * is what stops the page drifting back into a dashboard.
 */
export const FRONT_PAGE_LEAD =
  'Your assistant is where the conversation happens. This page is for the decisions only you can make.';

/** What the two sides say to each other once an offer is accepted. */
export const DEAL_DONE_LINE = "Sort pickup in the conversation; the switchboard's part is done.";

export function dashboardPage(v: DashboardView): string {
  // Turning everything back on is a sensitive action, so it takes whichever
  // credential the account holds: the PIN box where there is a PIN, the
  // passkey ceremony on the button where there is no PIN.
  const c = v.ceremony ?? { hasPin: true, hasPasskey: false, elevated: false };
  const backOnWord = c.hasPin && c.hasPasskey ? 'your PIN or passkey' : c.hasPin ? 'your PIN' : 'your passkey';
  const kill = v.killSwitchOn
    ? `<div class="kill">
<h2>Everything is stopped.</h2>
<p class="small">Your wants and haves are stopped and your assistants cannot act. Turning it back on needs ${esc(backOnWord)}.</p>
<form method="POST" action="/kill/off" id="killOffForm">
  ${cpages.ceremonyField(c, 'kill')}
  ${cpages.ceremonySubmit(c, { formId: 'killOffForm', label: 'Turn everything back on', strong: true })}
</form>
${cpages.ceremonyAlt(c, 'killOffForm')}</div>`
    : // THE BRAKE IS ONE TAP. It briefly took a PIN; it does not any more
      // (2026-09-17). Somebody reaching for this is somebody who wants
      // everything to stop NOW, and the wrong end of that trade is a person
      // hunting for a credential while the thing they are frightened of carries
      // on. It is the one direction that is safe to make easy: it stops things
      // rather than starting them, and turning it back ON still asks. The
      // cross-site check on this whole page class is what stops another site
      // pressing it, and the tap is paced so it cannot be held down.
      `<div class="kill">
<form method="POST" action="/kill" id="killOnForm">
  <button type="submit" class="danger">Stop all wants and haves</button>
</form>
<p class="small muted">Your assistants are stopped too. You can turn it back on.</p></div>`;

  // 1. Decisions. Whole tile is the tap target; the wording of the button
  //    stays on the tile so the person knows what they are opening. There is
  //    no "waiting for you" badge on anything under Decisions: everything
  //    there is waiting by definition, and the accent border says so.
  const approvals = v.pendingApprovals
    .map((a) => {
      const body = `<div class="what">${esc(a.label)}</div>
${(a.lines ?? []).map((l) => `<p class="small">${esc(l)}</p>`).join('')}
${a.amount ? `<div class="figure">${esc(a.amount)}</div>` : ''}`;
      return a.href
        ? `<a class="todo urgent" href="${esc(a.href)}">${body}
<div class="go">${esc(a.cta ?? 'Review & decide')}</div></a>`
        : `<div class="todo urgent">${body}</div>`;
    })
    .join('');

  // 1a. One box per match. Everything waiting on one match sits together in
  //     one box, under a timeline of what has happened on it, so an offer and
  //     the reply to it read in the order they happened (27 September 2026).
  const boxes = (v.matchBoxes ?? []).map((b) => matchBoxHtml(b, v.timezone)).join('');
  // 1b. In progress: the open matches with nothing waiting on this person,
  //     one line each, linking to the match's page (27 September 2026).
  const inProgressHtml = v.inProgress?.length
    ? `<h2>In progress</h2>
<div class="navlist">${v.inProgress
        .map(
          (m) =>
            `<a href="${esc(m.href)}"><span class="nav-t">${esc(m.title)}</span><span class="nav-d">${esc(m.last)}</span></a>`,
        )
        .join('')}</div>`
    : '';

  // 2. There used to be a window on a clock here: a want or have that several
  //    people had come forward on froze until its timer ran out, and this card
  //    was where the holder closed it early. Nothing blocks a holder now
  //    (migration 030). People come one at a time, the rest wait in line, and
  //    there is nothing on this page for the person to do about it.

  // 2b. Messages nobody has collected. The switchboard carries a conversation
  //     without keeping it, so this block can say how many and what about, and
  //     never a word of what is in them. The assistant is the one that can
  //     read them out, so that is what the line asks for.
  const messages = (v.messagesWaiting ?? [])
    .map((m) => {
      const one = m.count === 1;
      const line =
        `${m.count} message${one ? '' : 's'} on your ${categoryPhrase(m.category)} conversation. ` +
        `Ask your assistant and it will read ${one ? 'it' : 'them'} to you.`;
      return `<div class="todo">
<span class="badge match">MESSAGES WAITING</span>
<div class="what">${esc(line)}</div></div>`;
    })
    .join('');

  // 2c. Deals done. Nothing is waiting on the switchboard once a human has
  //     accepted, so the block says what was agreed and where the rest of it
  //     happens.
  const agreed = (v.agreed ?? [])
    .map((a) => {
      const line = `Agreed at ${moneyPhrase(a.amount)} on your ${categoryPhrase(a.category)} match. ${DEAL_DONE_LINE}`;
      return `<a class="todo" href="/matches/${esc(a.matchId)}">
<span class="badge have">AGREED</span>
<div class="what">${esc(line)}</div>
<div class="go">See the offers</div></a>`;
    })
    .join('');

  // 3. Wants and haves whose clock is nearly out, with the press that keeps
  //    them (28 September 2026: the tile used to point at the ledger, which
  //    had no way to renew anything). The day is markup the reader's own
  //    clock fills in, so it goes in without esc().
  const renewals = v.lapsingSoon?.count
    ? `<div class="todo">
<span class="badge state">LAPSING</span>
<div class="what">${v.lapsingSoon.count === 1 ? 'One of your wants and haves runs' : `${v.lapsingSoon.count} of your wants and haves run`} out by ${v.lapsingSoon.soonest}.</div>
<form method="POST" action="/renew/lapsing"><button type="submit">${esc(KEEP_THEM_ALL)}</button></form>
<p class="small"><a href="/ledger">See which</a></p></div>`
    : '';

  const nothingWaiting =
    !boxes &&
    !v.pendingApprovals.length &&
    !renewals &&
    !messages &&
    !agreed;

  const emailBanner = v.emailUnreachable
    ? `<div class="err"><strong>Email to you is bouncing.</strong>
An email we sent to your address came back undeliverable, so all email is on
hold. Re-verify your address to switch it back on.
<form method="POST" action="/reverify"><button type="submit">Re-verify my email</button></form></div>`
    : '';

  const nav = `<div class="navlist">
<a href="/ledger"><span class="nav-t">Your wants and haves</span><span class="nav-d">${esc(countLine(v.cardCounts))}</span></a>
<a href="/settings"><span class="nav-t">Settings</span><span class="nav-d">What you share, how you approve things and how you hear about them.</span></a>
</div>`;

  return layout('Your main page', `
<style>.mb-theirs { color:var(--muted); font-size:var(--t-sm); margin:calc(-1 * var(--s2)) 0 var(--s3); overflow-wrap:anywhere; }</style>
<h1>${v.firstName ? `G'day, ${esc(v.firstName)}.` : 'Your main page.'}</h1>
<p class="lead">${esc(FRONT_PAGE_LEAD)}</p>
${v.notice ? `<div class="note">${esc(v.notice)}</div>` : ''}
${v.awaitingConnect ? `<script>
(function(){var again=function(){if(!document.hidden)location.reload();};
window.addEventListener('focus',again);document.addEventListener('visibilitychange',again);
var n=0,t=setInterval(function(){if(++n>40){clearInterval(t);return;}if(!document.hidden)location.reload();},4000);})();
</script>` : ''}
${emailBanner}
<h2>Decisions</h2>
${nothingWaiting ? `<div class="empty">Nothing to decide right now.</div>` : ''}
${boxes}
${approvals}
${agreed}
${messages}
${renewals}
${inProgressHtml}
<h2>Your switchboard</h2>
${nav}
${kill}
<form method="POST" action="/logout"><button class="secondary" type="submit">Sign out</button></form>
${cpages.ceremonyScript(c)}`);
}

/** Under a want or have screening turned away, after screening's reason. */
export const REJECTED_TILE_LINE =
  'Tell your assistant what to change and it will send it back to be checked.';

/**
 * Where a payment stands, as the main page's tile says it. A state with no
 * phrase here gets the bare label, never the state's own name.
 */
const SETTLEMENT_TILE_STATES: Record<string, string> = {
  approved: 'approved, waiting for payment',
  funded: 'paid, waiting for handover',
  'evidence-locked': 'handed over, waiting for receipt to be confirmed',
  confirmed: 'receipt confirmed, payment on its way',
  disputed: 'on hold',
  'resolution-proposed': 'on hold, a way to settle it is on the table',
  resolved: 'agreed, payment on its way',
  'settled-split': 'closed',
};
const SETTLEMENT_APPROVAL_STATES = ['proposed', 'approved-by-buyer', 'approved-by-seller'];

export function settlementTileLabel(thing: string, state: string, needsMyApproval: boolean): string {
  const head = `Payment on your ${thing} match`;
  const where = SETTLEMENT_APPROVAL_STATES.includes(state)
    ? needsMyApproval
      ? 'waiting for your approval'
      : 'waiting for the other side to approve'
    : Object.hasOwn(SETTLEMENT_TILE_STATES, state)
      ? SETTLEMENT_TILE_STATES[state]
      : undefined;
  return where ? `${head}: ${where}` : head;
}

/** The main page's line after "Keep them all", and the ledger's after "Keep it". */
export const RENEWED_NOTICE = 'Renewed.';

/** The lapsing tile's button. */
export const KEEP_THEM_ALL = 'Keep them all';

/** The count under "Your wants and haves": "2 live · 1 being checked". */
export function countLine(c: { total: number; published: number; pending: number }): string {
  if (!c.total) return 'Nothing posted yet.';
  const parts = [`${c.published} live`];
  if (c.pending) parts.push(`${c.pending} being checked`);
  return parts.join(' · ');
}

/** Where a want or have stands, in the words the ledger says it. */
export type LedgerState = 'live' | 'paused' | 'being checked' | 'needs a change' | 'taken down' | 'lapsed';

export interface LedgerCardView {
  id: string;
  type: 'WANT' | 'HAVE';
  /** The person's own name for the thing (their `kind`), else its shelf. */
  title: string;
  /** The attributes' values in plain order, as one sentence. No keys. */
  sentence?: string;
  state: LedgerState;
  /** For 'needs a change': screening's reason in plain words. */
  reason?: string;
  /** localTime(…, 'day') markup for when it lapses. Inserted without esc(). */
  until: string;
  /** "within 25 km of Braddon, …", "anywhere in Australia", "anywhere". */
  reach: string;
  /** True where the owner wrote a private limit on it. */
  hasLimit: boolean;
  /** Introductions that reached them on this one. */
  introduced: number;
  /** Who writes its negotiating figures. Defaults to Pass on. */
  mode: NegotiationMode;
  /** Runs out inside the week: the row offers "Keep it". */
  lapsingSoon?: boolean;
}

/** A finished connection the human filed away — shown in a quiet "past
 *  connections" area, distinct from the live wants and haves above it. */
export interface PastConnectionView {
  /** Leaf label of the category, e.g. "book club". */
  category: string;
  /** "Alex, Franklin" where the two reached stage-3 disclosure; absent otherwise. */
  who?: string;
  /** When it was filed away, e.g. "2026-09-03". */
  archivedOn?: string;
}

/** How the assistant handles figures on one want or have, in a phrase. */
export function figuresPhrase(mode: NegotiationMode): string {
  return mode === 'mandate'
    ? 'your assistant handles figures between your limits'
    : 'your assistant brings every figure to you';
}

/** The line under the ledger's list. */
export const LEDGER_CHANGE_LINE = 'To change what one says, tell your assistant.';

/** "Hardtail mountain bike" from "hardtail mountain bike"; "iPhone" stays. */
export function upperFirst(t: string): string {
  const s = String(t ?? '').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** "hardtail mountain bike" from "Hardtail mountain bike"; "TV" and "iPhone" stay. */
export function lowerFirst(t: string): string {
  const s = String(t ?? '').trim();
  if (s.length > 1 && s[1] === s[1]!.toUpperCase() && s[1] !== s[1]!.toLowerCase()) return s;
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/**
 * A posting's attributes as one plain sentence: the values in the order they
 * were written, no keys. `true` says its key ("boxed"), `false` and anything
 * nested say nothing, a list reads as a list.
 */
export function attributesSentence(attrs: unknown): string | undefined {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return undefined;
  const words: string[] = [];
  for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
    if (v === true) words.push(k.replace(/_/g, ' '));
    else if (typeof v === 'string' && v.trim()) words.push(v.trim());
    else if (typeof v === 'number' && Number.isFinite(v)) words.push(String(v));
    else if (Array.isArray(v)) {
      const list = v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String);
      if (list.length) words.push(list.join(', '));
    }
  }
  if (!words.length) return undefined;
  const joined = words.join(', ');
  return `${upperFirst(joined)}${/[.!?]$/.test(joined) ? '' : '.'}`;
}

/** The muted line under a ledger row. Returns markup: `until` is markup. */
function ledgerFacts(c: LedgerCardView): string {
  const head =
    c.state === 'live'
      ? `Live until ${c.until}`
      : c.state === 'paused'
        ? `Paused, lapses ${c.until}`
        : c.state === 'being checked'
          ? 'Being checked'
          : c.state === 'needs a change'
            ? 'Needs a change'
            : c.state === 'taken down'
              ? 'Taken down'
              : 'Lapsed';
  const open = c.state !== 'taken down' && c.state !== 'lapsed';
  const parts = [head];
  if (c.reach) parts.push(esc(c.reach));
  if (open && c.hasLimit) parts.push('your limit is private');
  parts.push(c.introduced ? `${c.introduced} introduced` : 'nobody introduced yet');
  if (open) parts.push(esc(figuresPhrase(c.mode)));
  return parts.join(' · ');
}

export function ledgerPage(
  cards: LedgerCardView[],
  notice?: string,
  pastConnections: PastConnectionView[] = [],
): string {
  const rows = cards.length
    ? cards
        .map((c) => {
          const open = c.state !== 'taken down' && c.state !== 'lapsed';
          return `<div class="card-row" data-card-id="${esc(c.id)}">
<div class="top">
  <span class="badge ${c.type === 'WANT' ? 'want' : 'have'}">${c.type === 'WANT' ? 'Want' : 'Have'}</span>
  <span class="led-title">${esc(upperFirst(c.title))}</span>
</div>
${c.sentence ? `<p class="led-sum">${esc(c.sentence)}</p>` : ''}
<p class="led-facts">${ledgerFacts(c)}</p>
${c.state === 'needs a change' && c.reason ? `<p class="small">${esc(c.reason)}</p>` : ''}
${
  open
    ? `<div class="row-actions">
  ${c.lapsingSoon && (c.state === 'live' || c.state === 'paused') ? `<form method="POST" action="/ledger/${esc(c.id)}/renew"><button type="submit">Keep it</button></form>` : ''}
  <a class="btn secondary" href="/ledger/${esc(c.id)}/numbers">Your numbers</a>
  <a class="btn secondary" href="/ledger/${esc(c.id)}/withdraw">Take it down</a>
</div>`
    : ''
}
</div>`;
        })
        .join('')
    : `<div class="empty">Nothing posted yet. What your assistant posts for you shows up here.</div>`;
  const past = pastConnections.length
    ? `<section class="past-connections">
<h2 class="small-head">Past connections</h2>
<p class="small">Connections you filed away as finished. The switchboard keeps the
first name and suburb they shared, what it was about and the date. What you said
to each other is in your chat with your assistant.</p>
${pastConnections
  .map(
    (p) => `<div class="card-row past">
<div class="top">
  <span class="led-title">${esc(upperFirst(p.category))}</span>
  <span class="badge state">filed away</span>
</div>
<p class="led-facts">${p.who ? esc(p.who) : 'Filed away before names were shared'}${p.archivedOn ? ` · ${esc(p.archivedOn)}` : ''}</p>
</div>`,
  )
  .join('')}
</section>`
    : '';
  return layout('Your wants and haves', `
${LEDGER_STYLE}
<h1>Your wants and haves.</h1>
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${rows}
${cards.length ? `<p class="small muted">${esc(LEDGER_CHANGE_LINE)}</p>` : ''}
${past}
<a class="btn secondary" href="/">Back</a>`);
}

/** The ledger's own few rules, local to it rather than in the shared sheet. */
const LEDGER_STYLE = `<style>
.led-title { font-family:var(--sans); font-weight:600; font-size:var(--t-md); overflow-wrap:anywhere; min-width:0; }
.led-sum { font-family:var(--serif); font-size:var(--t-md); margin:var(--s2) 0 0; overflow-wrap:anywhere; }
.led-facts { font-family:var(--sans); font-size:var(--t-sm); color:var(--muted); margin:var(--s2) 0 0; line-height:1.45; overflow-wrap:anywhere; }
</style>`;

/**
 * "Take it down" asks once before it does anything. "Not now" is a way back
 * and nothing more; the POST is the existing withdraw.
 */
export function takeDownPage(v: { id: string; type: 'WANT' | 'HAVE'; thing: string }): string {
  const q = `Take down your ${v.thing} ${v.type === 'WANT' ? 'want' : 'have'}?`;
  return layout(q, `
<h1>${esc(q)}</h1>
<p class="lead">It comes off the switchboard straight away.</p>
<form method="POST" action="/ledger/${esc(v.id)}/withdraw">
  <button type="submit" class="danger">Take it down</button>
</form>
<a class="btn secondary" href="/ledger">Not now</a>`);
}

// ---------------------------------------------------------------------------
// Your numbers (1.E). Who writes the figures this want or have negotiates with. Both
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
  /** Setting a mandate hands the agent a band it can spend inside without
   *  asking again, so writing one takes the same ceremony an approval takes.
   *  Absent means "ask nothing", which is what the standalone page renderers
   *  in the tests want. */
  ceremony?: cpages.CeremonyView;
}

/** A ceremony view that asks for nothing, for a page rendered without one. */
const ASKS_NOTHING: cpages.CeremonyView = { hasPin: false, hasPasskey: false, elevated: true };

export function cardNumbersPage(v: CardNumbersView, error?: string, notice?: string): string {
  const c = v.ceremony ?? ASKS_NOTHING;
  const f = v.form ?? {
    open: v.mandate?.open != null ? String(v.mandate.open) : '',
    limit: v.mandate?.limit != null ? String(v.mandate.limit) : '',
    step: v.mandate?.step != null ? String(v.mandate.step) : '',
    ccy: v.mandate?.ccy ?? '',
  };
  const selling = v.type === 'HAVE';
  const thing = selling ? 'have' : 'want';
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
<h1>Your numbers on this ${thing}.</h1>
<div class="top" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem">
  <span class="badge ${selling ? 'have' : 'want'}">${esc(v.type)}</span>
  <span class="cat">${esc(v.category)}</span>
</div>
${errBox(error)}
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${draft}
<p class="lead">Every figure this ${thing} carries into a negotiation is one you
wrote. Your assistant presents and advises; it never invents a price of its own.</p>
${current}
<form method="POST" action="/ledger/${esc(v.id)}/numbers" id="numbersForm">
  <h2>How this ${thing} negotiates</h2>
  ${modeRadio('relay')}
  ${modeRadio('mandate')}
  <h2>Your numbers</h2>
  <p class="small muted">These are needed for Auto-negotiate and are kept
  private: your assistant works inside them, and the other side is never told
  any of it.</p>
  <label for="open">Open at (optional)</label>
  <input id="open" name="open" type="number" step="0.01" min="0" value="${esc(f.open ?? '')}" placeholder="amount">
  <label for="limit">${selling ? 'Take no less than' : 'Pay no more than'}</label>
  <input id="limit" name="limit" type="number" step="0.01" min="0" value="${esc(f.limit ?? '')}" placeholder="amount">
  <label for="step">Move in steps of at least (optional)</label>
  <input id="step" name="step" type="number" step="0.01" min="0" value="${esc(f.step ?? '')}" placeholder="amount">
  <label for="ccy">Currency</label>
  <input id="ccy" name="ccy" type="text" maxlength="3" pattern="[A-Za-z]{3}" value="${esc(f.ccy ?? '')}" placeholder="AUD">
  ${cpages.ceremonyField(c, 'numbers')}
  ${cpages.ceremonySubmit(c, { formId: 'numbersForm', label: 'Save' })}
</form>
${cpages.ceremonyAlt(c, 'numbersForm')}
${cpages.ceremonyNote(c)}
${
  v.mandate
    ? `<form method="POST" action="/ledger/${esc(v.id)}/numbers/clear">
  <button type="submit" class="secondary">Clear my numbers and go back to Pass on</button>
</form>`
    : ''
}
<p class="small muted">Whichever way this is set, accepting an offer still
comes to you on your main page. Auto-negotiate lets your assistant put figures
on the table between the two you wrote; it never agrees anything.</p>
<a class="btn secondary" href="/ledger">Back to your wants and haves</a>
${cpages.ceremonyScript(c)}`);
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
  /** localTime() markup: when the offer lapses, in the reader's clock. */
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
  /** The person's own word for the thing, for the page's title. */
  thing?: string;
  /** The other side's first name, once names have crossed. */
  theirName?: string;
  /** "Theirs: Trek Marlin 5 mountain bike · asking $620 AUD", from the same
   *  read that serves the details to the assistant. */
  theirs?: string;
  /** This person's own live figure, rendered "400 AUD". The form collapses to
   *  a line about it, because the number is already sent. */
  myOfferOnTable?: string;
  /** A figure a human accepted, rendered "415 AUD". The switchboard has done
   *  its part at that point and the page says so. */
  agreedAmount?: string;
  /** This person's own call on the introduction, if they have made one. The
   *  ask sits at the foot of this page, where the introduction is. */
  verdict?: string;
  /** True while this one is open, which is while there is something to close.
   *  The report road sits beside every open introduction, so that reporting
   *  somebody never depends on an assistant being in the room. */
  canReport?: boolean;
  /** Setting a mandate hands the agent a band it can spend inside without
   *  asking again, so writing one takes the same ceremony an approval takes.
   *  Absent means "ask nothing", which is what the standalone page renderers
   *  in the tests want. */
  ceremony?: cpages.CeremonyView;
  /** Everything that has happened on this match, oldest first: the same
   *  timeline the main page's box shows, with nothing cut. */
  story?: MatchStep[];
  /** The account's IANA zone for those times, where one is set. */
  timezone?: string | null;
}

/**
 * How was that one? The quietest thing on the page, at the very foot of it.
 *
 * It used to sit on the front page beside a percentage, which made the front
 * page a place to browse. It belongs here, on the introduction it is about,
 * asked once and never scored: a person reads no figure about a person.
 *
 * Three answers rather than two. A yes/no left a person with nowhere to put an
 * introduction that was simply all right, so all right went in with the
 * rejections and muted the pairing for good.
 */
function verdictLine(v: MatchOffersView): string {
  if (v.verdict) {
    return `<p class="small muted">Your call on this one: ${esc(
      VERDICT_WORDS[v.verdict] ?? v.verdict,
    )}.</p>`;
  }
  const btn = (verdict: string, label: string) => `<form method="POST" action="/verdict">
  <input type="hidden" name="match_id" value="${esc(v.matchId)}">
  <input type="hidden" name="return_to" value="${esc(v.matchId)}">
  <input type="hidden" name="verdict" value="${verdict}">
  <button type="submit" class="secondary">${label}</button>
</form>`;
  return `<p class="small muted">How was that one?</p>
<div class="row-actions">${btn('good', 'Good')}${btn('fine', 'Fine')}${btn('bad', 'Bad')}</div>
<p class="small muted">Your answer tunes what comes to you next. "Fine" is a real
answer and changes nothing else. "Bad" also mutes this pairing, and no reason is
ever sent to the other side.</p>`;
}

/**
 * Report this person. Quieter than the verdict line and under it, because most
 * people will never want it — and always there while the introduction is open,
 * because the person who does want it should not have to ask an assistant for
 * a link to it first.
 *
 * It goes to a page that asks before it does anything, so this is a link
 * rather than a button: nothing here is the report.
 */
function reportLine(v: MatchOffersView): string {
  if (!v.canReport) return '';
  return `<p class="small muted">Is something wrong with this one?
<a href="/matches/${esc(v.matchId)}/report">Report this person</a>. It closes this
one straight away, and they are told only that the switchboard closed it.</p>`;
}

/** The box's heading when the assistant carried the figure here. */
export const OFFER_HEADING_DRAFT = 'Confirm the number your assistant brought';
/** And when the box is empty, so the person is opening the bidding. */
export const OFFER_HEADING_EMPTY = 'Put a number on the table';

/** Offer states, in the words the person would use for them. */
const OFFER_STATE_WORDS: Record<string, string> = {
  proposed: 'on the table',
  'awaiting-human': 'waiting for you',
  'accepted-by-human': 'agreed',
  declined: 'declined',
  withdrawn: 'withdrawn',
};

/** The one line about figures on the match page, in place of the old control. */
export function figuresLine(cardId: string, mode: NegotiationMode): string {
  return `<p class="small muted">How your assistant handles figures on this: ${
    mode === 'mandate' ? 'between your limits' : esc(MODE_NAMES.relay)
  } &mdash; <a href="/ledger/${esc(cardId)}/numbers">change</a></p>`;
}

/** "Hardtail mountain bike · with Tony", or "· with the other side" before names cross. */
export function matchPageTitle(thing: string | undefined, theirName: string | undefined, category: string): string {
  return `${upperFirst(thing || category) || 'Your match'} · with ${theirName || 'the other side'}`;
}

export function matchOffersPage(v: MatchOffersView, error?: string, notice?: string): string {
  const rows = v.offers.length
    ? v.offers
        .map((o) => {
          const agreed = o.state === 'accepted-by-human';
          const head = agreed
            ? `<div class="kv"><strong>Agreed at ${esc(moneyPhrase(o.amount))}</strong></div>
<div class="kv">${esc(DEAL_DONE_LINE)}</div>`
            : `<div class="kv"><strong>${esc(o.amount)}</strong> — good until ${o.expires}${
                o.mine && o.authoredByMe
                  ? ` · ${o.authoredByMe === 'human' ? 'you typed this one' : 'your assistant sent this one from your numbers'}`
                  : ''
              }</div>`;
          return `<div class="card-row"><div class="top">
<span class="badge ${o.mine ? 'have' : 'want'}">${o.mine ? 'YOURS' : 'THEIRS'}</span>
<span class="badge state">${esc(OFFER_STATE_WORDS[o.state] ?? o.state)}</span></div>
${head}
${
  o.note ? `<div class="kv">${o.mine ? 'Your line:' : 'Their words:'} “${esc(o.note)}”</div>` : ''
}
</div>`;
        })
        .join('')
    : `<div class="empty">No figures on the table yet.</div>`;
  // A resubmitted form beats a draft: what the person just typed is newer than
  // anything their agent left here.
  const useDraft = !v.form && !!v.draft;
  // The heading says where the number in the box came from. A figure the
  // assistant carried is a figure to check and confirm; an empty box is the
  // person opening the bidding.
  const form = counterOfferForm(v.matchId, {
    ccy: useDraft ? v.draft!.ccy : v.form?.ccy,
    amount: useDraft ? v.draft!.amount : v.form?.amount,
    note: useDraft ? v.draft!.note : v.form?.note,
    draft: useDraft,
    ...(v.ceremony ? { ceremony: v.ceremony } : {}),
    heading: v.myOfferOnTable
      ? ''
      : useDraft
        ? OFFER_HEADING_DRAFT
        : OFFER_HEADING_EMPTY,
  });
  // Three ways this stretch of the page can stand. A deal is done, so there is
  // nothing to type; a figure of theirs is already out there, so the form
  // folds down to a line about it; or the box is open with nothing sent.
  const reply = v.agreedAmount
    ? `<div class="headline"><div class="k">Agreed</div><div class="v">${esc(moneyPhrase(v.agreedAmount))}</div></div>
<p class="lead">Agreed at ${esc(moneyPhrase(v.agreedAmount))}. ${esc(DEAL_DONE_LINE)}</p>`
    : !v.canOffer
      ? `<p class="note">${esc(v.canOfferBlockedBecause ?? 'Offers are not open on this match yet.')}</p>`
      : v.myOfferOnTable
        ? `<p class="lead">Your ${esc(moneyPhrase(v.myOfferOnTable))} is on the table.</p>
${foldedDetail('Change your number', form)}`
        : form;
  const title = matchPageTitle(v.thing, v.theirName, v.category);
  return layout(title, `
<h1>${esc(title)}</h1>
${v.theirs ? `<p class="muted">${esc(v.theirs)}</p>` : ''}
${errBox(error)}
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${reply}
${v.story?.length ? `<h2>What has happened</h2>
${timelineHtml(v.story, { timezone: v.timezone })}` : ''}
<h2>What has been offered</h2>
${rows}
${figuresLine(v.cardId, v.mode)}
<a class="btn secondary" href="/">Back</a>
${verdictLine(v)}
${reportLine(v)}
${v.ceremony ? cpages.ceremonyScript(v.ceremony, cpages.moneyCeremony(v.ceremony)) : ''}`);
}

/**
 * How this person hears about things. An assistant that runs on its own brings
 * them the news itself; one that only acts when spoken to cannot, so
 * everything has to reach them by email. Nothing else on the switchboard can
 * work this out on its own, so the page asks, once at onboarding and again on
 * the settings page, in the same words both times.
 */
export type HearsVia = 'email' | 'assistant';

const HEARS_VIA_OPTIONS: ModeOption[] = [
  {
    value: 'assistant',
    head: 'Through my assistant.',
    rest: 'My assistant checks on its own and provides updates back to me. Best suited to always-on agents.',
  },
  {
    value: 'email',
    head: 'By email.',
    rest: 'Each match and reply reaches me by email. Best suited to chat assistants.',
  },
];

/**
 * The one page a new person passes through, right after they set their PIN and
 * before their assistant is authorised.
 *
 * It asks the single thing the software cannot work out for itself (whether
 * email goes out at all) and, while it has their attention, offers the first
 * name and suburb they would share. Both of those may be left blank: the
 * names step asks for them again when it matters.
 *
 * "Skip for now" leaves hears_via on 'email', which is the safe answer: a
 * person nobody has told us about gets told rather than left in silence.
 */
export interface HelloView {
  hearsVia: HearsVia;
  firstName: string;
  locality: string;
  /** Cadence in minutes as a string, when one is already on the arrangement. */
  checkEvery?: string;
  /** IANA zone already on the account, if any. */
  timezone?: string | null;
}

/** The cadence question belongs to one of the two answers, so it comes and goes with it. */
const CADENCE_SCRIPT = `<script>
document.querySelectorAll('input[name="hears_via"]').forEach(function (r) {
  r.addEventListener('change', function () {
    document.getElementById('cadence').hidden =
      document.querySelector('input[name="hears_via"]:checked').value !== 'assistant';
  });
});
</script>
<noscript><style>#cadence{display:block !important}</style></noscript>`;

/** Fills the hidden zone boxes with the browser's zone, so nobody is asked a question the browser can answer. */
const ZONE_SCRIPT = `<script>
(function(){try{var z=Intl.DateTimeFormat().resolvedOptions().timeZone;if(!z)return;document.querySelectorAll('input.tz').forEach(function(el){if(!el.value)el.value=z;});}catch(e){}})();
</script>`;

/**
 * How often an assistant that runs on its own should look, asked in words.
 *
 * The arrangement page keeps the minutes box, because an assistant that
 * writes an arrangement mid-conversation deals in minutes and a person editing
 * one later has a reason to be exact. A person meeting the switchboard for the
 * first time does not: they are picking a rhythm, not a number, and three
 * rhythms cover it. The blank is a real answer — it leaves the question to the
 * conversation they are about to have with their assistant.
 */
export const HELLO_CADENCES: { value: string; label: string }[] = [
  { value: '180', label: 'Every few hours' },
  { value: '720', label: 'Twice a day' },
  { value: '1440', label: 'Once a day' },
  { value: '', label: 'Let my assistant ask me' },
];

/** The rhythm a new always-on account starts on when nobody says otherwise. */
export const HELLO_CADENCE_DEFAULT = '720';

/** The onboarding question's heading, and the settings section's. */
export const HEARS_VIA_HEADING = 'How do you hear about things?';

export function helloPage(v: HelloView, error?: string): string {
  const options = modeOptions('hears_via', 'hello', HEARS_VIA_OPTIONS, v.hearsVia);
  const cadence = HELLO_CADENCES.map(
    (c) => `<option value="${esc(c.value)}"${c.value === (v.checkEvery ?? HELLO_CADENCE_DEFAULT) ? ' selected' : ''}>${esc(c.label)}</option>`,
  ).join('');
  return layout(HEARS_VIA_HEADING, `
<h1>${esc(HEARS_VIA_HEADING)}</h1>
<p class="lead">Pick one so the switchboard knows whether to email you.</p>
${errBox(error)}
<form method="POST" action="/hello">
  ${options}
  <div id="cadence"${v.hearsVia === 'assistant' ? '' : ' hidden'}>
    <label for="check_every_minutes">How often should it check?</label>
    <select id="check_every_minutes" name="check_every_minutes">${cadence}</select>
  </div>
  <h2>What you share on a match</h2>
  <p class="small muted">A first name and a suburb, shared only after both
  people say yes. You can leave these for now.</p>
  ${plainSharedFields({ firstName: v.firstName, locality: v.locality }, { optional: true })}
  <input type="hidden" class="tz" name="timezone" value="${esc(v.timezone ?? '')}">
  <button type="submit">Save and carry on</button>
</form>
<form method="POST" action="/hello">
  <input type="hidden" name="skip" value="yes">
  <input type="hidden" class="tz" name="timezone" value="${esc(v.timezone ?? '')}">
  <button type="submit" class="secondary">Skip for now</button>
</form>
${CADENCE_SCRIPT}
${ZONE_SCRIPT}`);
}

export interface EmailSettingsView {
  /** Which of the two ways this account hears about things right now. */
  hearsVia: HearsVia;
  /** IANA zone on the account, or null when never captured. */
  timezone: string | null;
  freqMatches: string;
  freqDigests: string;
  complaintSuppressed: boolean;
  emailUnreachable: boolean;
  /** "Ana, Braddon", or absent when nothing is filled in. */
  sharedProfile?: string;
  /** Which credentials approve things. Absent reads as nothing set. */
  approveWith?: { pin: boolean; passkey: boolean };
  /** One line of the standing arrangement. Absent = nothing set yet. */
  arrangementSummary?: string;
  /** How many keys are live. */
  keyCount?: number;
  /** Kept on the view for older callers; the page no longer shows it. Every
   *  notice email is the same bare notice now, so blind mode changes nothing. */
  blindMode?: boolean;
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

/** "Australia/Sydney, 9:02 am now". */
export function zoneFact(timezone: string, now: Date = new Date()): string {
  let clock = '';
  try {
    clock = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone })
      .format(now)
      .replace(/\s/g, ' ');
  } catch {
    return timezone.replace(/_/g, ' ');
  }
  return `${timezone.replace(/_/g, ' ')}, ${clock} now`;
}

function approveFact(a?: { pin: boolean; passkey: boolean }): string {
  if (!a || (!a.pin && !a.passkey)) return 'Nothing set up yet.';
  if (a.pin && a.passkey) return 'Your passkey or your PIN.';
  return a.pin ? 'Your PIN.' : 'Your passkey.';
}

/** One settings section that is a fact and a link. */
function linkSection(head: string, fact: string, href: string, linkText: string): string {
  return `<section class="set"><h2>${esc(head)}</h2>
<p class="set-fact">${esc(fact)}</p>
<a href="${esc(href)}">${esc(linkText)}</a></section>`;
}

const SETTINGS_STYLE = `<style>
section.set { border-bottom:1px solid var(--line); padding:0 0 var(--s4); }
section.set h2 { margin-top:var(--s5); margin-bottom:var(--s1); }
.set-fact { margin:0 0 var(--s1); }
section.set a { font-family:var(--sans); font-weight:600; font-size:var(--t-sm); }
section.set details > summary { font-family:var(--sans); font-weight:600; font-size:var(--t-sm);
  color:var(--accent); cursor:pointer; }
</style>`;

/**
 * The settings hub (28 September 2026). Everything that used to be its own row
 * on the main page is a short section here: one fact and a way to change it.
 */
export function settingsPage(v: EmailSettingsView, notice?: string): string {
  const complaint = v.complaintSuppressed
    ? `<div class="err">You marked one of our emails as spam, so everything
except sign-in codes, approvals and security notices is on hold.
<form method="POST" action="/settings/email-resume">
  <button type="submit" class="secondary">Start emailing me again</button>
</form></div>`
    : '';
  const unreachable = v.emailUnreachable
    ? `<div class="err">Email to your address is bouncing, so all email is on
hold. Re-verify from your <a href="/">main page</a>.</div>`
    : '';
  const hearsVia = modeOptions('hears_via', 'hears', HEARS_VIA_OPTIONS, v.hearsVia);
  const zones = Intl.supportedValuesOf('timeZone');
  const zoneOptions = [
    `<option value=""${v.timezone ? '' : ' selected'}>Not set</option>`,
    ...zones.map((z) => `<option value="${esc(z)}"${z === v.timezone ? ' selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`),
  ].join('');
  const zoneForm = `<form method="POST" action="/settings/timezone">
  <label for="timezone">Time zone</label>
  <select id="timezone" name="timezone">${zoneOptions}</select>
  <button type="submit" class="secondary">Save</button>
</form>`;
  const zone = v.timezone
    ? `<p class="set-fact">${esc(zoneFact(v.timezone))}</p>
<details><summary>Change</summary>${zoneForm}</details>`
    : `<p class="set-fact">Not set</p>
${zoneForm}`;
  const keys = v.keyCount
    ? v.keyCount === 1
      ? 'You have one key.'
      : `You have ${v.keyCount} keys.`
    : 'None.';
  return layout('Settings', `
${SETTINGS_STYLE}
<h1>Settings.</h1>
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${unreachable}${complaint}
${linkSection('What you share', v.sharedProfile ?? 'Nothing filled in yet.', '/profile', 'Change')}
${linkSection('How you approve things', approveFact(v.approveWith), '/security', 'Change')}
<section class="set"><h2>How you hear about things</h2>
<form method="POST" action="/settings/hears-via">
  ${hearsVia}
  <button type="submit" class="secondary" id="hears-save" hidden>Save</button>
</form></section>
${linkSection('Your assistant', v.arrangementSummary ?? 'Nothing set yet.', '/arrangement', 'Change')}
${linkSection("Keys for assistants that can't sign in", keys, '/agent-keys', 'Change')}
<section class="set"><h2>Time zone</h2>
${zone}</section>
<section class="set"><h2>Email</h2>
<div id="email-dials"${v.hearsVia === 'assistant' ? ' hidden' : ''}>
<form method="POST" action="/settings/frequency">
  <label for="freq_matches">When someone comes forward</label>
  ${freqSelect('freq_matches', 'freq_matches', v.freqMatches)}
  <label for="freq_digests">Round-ups and reminders</label>
  ${freqSelect('freq_digests', 'freq_digests', v.freqDigests)}
  <button type="submit" class="secondary">Save</button>
</form>
</div>
<p class="small muted">Sign-in codes and security notices always send.</p>
</section>
<script>
// Choosing "through my assistant" takes the email dials off the page; they
// only mean something when email is how the person hears about things.
document.querySelectorAll('input[name="hears_via"]').forEach(function (r) {
  r.addEventListener('change', function () {
    var chosen = document.querySelector('input[name="hears_via"]:checked').value;
    document.getElementById('email-dials').hidden = chosen === 'assistant';
    // The save button only appears once the choice differs from what is saved.
    document.getElementById('hears-save').hidden = chosen === ${JSON.stringify(v.hearsVia)};
  });
});
</script>
<noscript><style>#hears-save{display:inline-block !important}</style></noscript>
${linkSection('Your account', 'Delete your account and what it holds.', '/account/delete', 'Delete my account')}
<a class="btn secondary" href="/">Back</a>`);
}

// ---------------------------------------------------------------------------
// Delete my account (founder decision, 28 September 2026). One paragraph of
// what happens, the PIN or passkey asked for at the press whatever window is
// open, and one button. src/domain/accountDeletion.ts does the work.
// ---------------------------------------------------------------------------
export const ACCOUNT_DELETE_WHAT_HAPPENS =
  'This takes down every want and have you have up, closes every introduction and conversation, and signs out every assistant and device. We erase your email address, first name, suburb, time zone, what you set up for your assistant, and your PIN and passkeys. We keep what safety or the law needs: anything under a report or a safety hold, the encrypted copy of your messages until it expires after 30 days, the record of what you agreed to, and any payment records. We send one email to say it is done, and you can open a new account with the same address whenever you like.';

export const ACCOUNT_DELETE_PAYMENT_UNDER_WAY =
  'You have a payment still under way. It has to finish before your account can be deleted. Your main page shows where it is up to.';

export interface AccountDeleteView extends cpages.CeremonyView {
  paymentUnderWay?: boolean;
}

export function accountDeletePage(v: AccountDeleteView, error?: string): string {
  // Always the fresh ceremony, whatever window a sign-in opened.
  const c = cpages.freshCeremony(v);
  const form = v.paymentUnderWay
    ? `<div class="note">${esc(ACCOUNT_DELETE_PAYMENT_UNDER_WAY)}</div>`
    : `<form method="POST" action="/account/delete" id="deleteForm">
  ${cpages.ceremonyField(c, 'delete')}
  ${cpages.ceremonySubmit(c, { formId: 'deleteForm', label: 'Delete my account', className: 'danger', strong: true })}
</form>
${cpages.ceremonyAlt(c, 'deleteForm')}
${cpages.ceremonyNote(c)}`;
  return layout('Delete your account', `
<h1>Delete your account.</h1>
${errBox(error)}
<p>${esc(ACCOUNT_DELETE_WHAT_HAPPENS)}</p>
${form}
<a class="btn secondary" href="/">Not now</a>
${v.paymentUnderWay ? '' : cpages.ceremonyScript(c)}`);
}

/** Where a deleted account lands. There is nothing left to sign in to. */
export const ACCOUNT_DELETED_PAGE_LINE = 'Your account is deleted and you are signed out.';
export const ACCOUNT_DELETED_EMAIL_LINE = 'We have sent one email to say so.';

export function accountDeletedPage(emailSent: boolean): string {
  const line = emailSent
    ? `${ACCOUNT_DELETED_PAGE_LINE} ${ACCOUNT_DELETED_EMAIL_LINE}`
    : ACCOUNT_DELETED_PAGE_LINE;
  return cpages.messagePage('Your account is deleted', `<p class="lead">${esc(line)}</p>`, '/', 'Home');
}

// ---------------------------------------------------------------------------
// Agent keys (1.C). A key is a long password an agent sends with every
// request, for the agents that cannot do a browser sign-in. Issued here by
// hand, behind the same ceremony as an approval, shown once.
// ---------------------------------------------------------------------------

export interface AgentKeyItem {
  keyId: string;
  name: string;
  created: string;
  /** All three are localTime(d, 'day') markup, inserted without esc(). */
  lastUsed?: string;
  expires: string;
}

export interface AgentKeysView extends cpages.CeremonyView {
  keys: AgentKeyItem[];
  atLimit: boolean;
}

export function agentKeysPage(v: AgentKeysView, notice?: string, error?: string): string {
  const rows = v.keys.length
    ? v.keys
        .map(
          (k) => `<div class="card-row"><div class="top">
<span class="badge state">KEY</span><span class="cat">${esc(k.name)}</span></div>
<div class="kv">made ${k.created} · ${k.lastUsed ? `last used ${k.lastUsed}` : 'never used yet'} · lapses ${k.expires}</div>
<div class="row-actions">
<form method="POST" action="/agent-keys/revoke">
  <input type="hidden" name="key_id" value="${esc(k.keyId)}">
  <button type="submit" class="secondary">Revoke</button>
</form></div></div>`,
        )
        .join('')
    : `<div class="empty">You have no keys yet.</div>`;

  const createForm = v.atLimit
    ? `<p class="muted small">You are holding as many keys as we allow at once.
Revoke one you have finished with to make room.</p>`
    : `<form method="POST" action="/agent-keys" id="keyForm">
  <label for="name">What is this key for?</label>
  <input id="name" name="name" type="text" maxlength="60" required placeholder="the laptop assistant">
  ${cpages.ceremonyField(v, 'key')}
  ${cpages.ceremonySubmit(v, { formId: 'keyForm', label: 'Make a key' })}
</form>
${cpages.ceremonyAlt(v, 'keyForm')}
${cpages.ceremonyNote(v)}`;

  return layout('Keys for assistants', `
<h1>Keys for assistants that can't sign in.</h1>
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
${errBox(error)}
<h2>Your keys</h2>
${rows}
<h2>Make a new one</h2>
${createForm}
${foldedDetail(
  'What a key can do',
  `<p class="small">Most assistants sign in through your browser the first time they
call the switchboard. A few cannot do that. Give one of those a key instead: a
long password it sends with every request.</p>
<p class="small">Anyone holding a key can post wants and haves and negotiate as your
assistant. It still cannot approve anything. Approvals only happen on your own
pages, where you confirm them yourself. Keep a key somewhere private, and revoke it the
moment you have finished with it. Keys lapse after 90 days, and the kill switch
stops them dead along with everything else.</p>`,
)}
<a class="btn secondary" href="/">Back</a>
${cpages.ceremonyScript(v)}`);
}

/** The one and only sighting of the plaintext key. */
export function agentKeyCreatedPage(v: { name: string; token: string; expires: string }): string {
  return layout('Your new key', `
<h1>Here is your key.</h1>
<p class="lead">Copy it now and paste it into your assistant's settings. This
page is the only place it is ever shown.</p>
<div class="fact"><div class="k">${esc(v.name)}</div><div class="v" id="keybox">${esc(v.token)}</div></div>
<button type="button" id="copybtn" class="approve">Copy the key</button>
<p class="small muted">Lost it? Revoke it and make another.</p>
<p class="small muted">Your assistant sends it as a header:</p>
<div class="fact"><div class="k">Header</div><div class="v">Authorization: Bearer ${esc(v.token.slice(0, 11))}…</div></div>
<p class="small muted">It lapses on ${v.expires}. Revoke it any time from
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
// Consent. The two statements that open an account. It is drawn here rather
// than in pages.ts since 28 September 2026, when its wording moved to the
// plain vocabulary: the handler that records CONSENT_STATEMENT is the one that
// renders it, so the words a person ticks and the words the log keeps come
// from one constant.
// ---------------------------------------------------------------------------

/** The consent statement, exactly as it is shown and as the consent log records it. */
export const CONSENT_STATEMENT =
  'My assistant may post wants and haves for me. I can see or take down anything on my main page.';

export const CONSENT_HEADING = 'Two things to confirm.';

export function consentPage(error?: string): string {
  return layout('Two things to confirm', `
<h1>${esc(CONSENT_HEADING)}</h1>
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
<p class="small muted">Both are recorded in a tamper-evident consent log.</p>
<p class="small muted">A first name and a suburb are the only things that ever cross,
and only after both people say yes.</p>`);
}

// ---------------------------------------------------------------------------
// "Still true?" renewal review (reached from the renewal email's signed link).
// ---------------------------------------------------------------------------
export interface RenewCardView {
  type: string;
  category: string;
  /** Its own attributes, summarised — what tells two in the same category apart. */
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
<p class="lead">These are your open wants and haves. One tap restarts each one's own clock.</p>
<form method="POST" action="/renew">
  <input type="hidden" name="t" value="${esc(token)}">
  <button type="submit">Still true — keep them all</button>
</form>
<a class="btn secondary" href="/ledger">See them one by one</a>
<h2>What you have open</h2>
${rows}
<p class="small muted">Wants and haves lapse on their own.</p>`);
}

// ---------------------------------------------------------------------------
// Unsubscribe (footer link lands here; the POST is also the RFC 8058 target).
// ---------------------------------------------------------------------------
export function unsubPage(token: string): string {
  return layout('Unsubscribe', `
<h1>Fewer emails.</h1>
<p class="lead">This switches off two kinds of email: “When someone comes forward”
and “Round-ups and reminders”. Sign-in codes, approval requests and security notices
keep sending.</p>
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
