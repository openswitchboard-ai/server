/**
 * Email templates (phase 0.E). Every message renders BOTH a responsive HTML
 * part and a plaintext part, from typed inputs, with the brand palette the
 * counter uses (paper/ink tokens, Patch small in the header). Type is ONE
 * system sans stack everywhere (mail clients strip web fonts; a mixed
 * serif/sans role split falls back inconsistently) — mono only for codes.
 *
 * VOICE RULES (enforced by the banned-phrase lint in lint.ts and the render
 * suite): plain, human, zero marketing, no antithesis constructions.
 * Content-thin by default — a nudge says something is waiting and links to
 * the counter; details stay behind auth. When the account has blind mode on,
 * the email is a fully content-free pointer.
 *
 * Emails only ever state true things from real rows: every count rendered
 * here arrives from a SQL count in the digest engine.
 *
 * WHEN AN EMAIL CARRIES A BUTTON (2026-09-11). The assistant is where the
 * conversation happens; these emails are notifications. So an email carries a
 * button ONLY when the next step is a gate that lives on the person's own
 * page, and the button goes to that gate: the names step, an offer waiting for
 * their yes, a settlement step, a security notice, a verification. Everything
 * else — a first signal, a message waiting, their move on the way to the names
 * step, a figure they will answer through their assistant — ends on "Ask your
 * assistant." and links nowhere, because telling their assistant is the whole
 * of what they have to do.
 */

import { categoryPhrase } from '../domain/matchRules.js';

// Re-exported so a caller working with email copy has it to hand; the helper
// itself lives beside the taxonomy labels it phrases.
export { categoryPhrase };

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/** Footer links. unsubUrl is present whenever the recipient has an account
 *  (a registration verification for a brand-new address has no subscription
 *  to leave, so its footer carries the settings link only once the account
 *  exists). */
export interface FooterLinks {
  settingsUrl: string;
  ledgerUrl: string;
  unsubUrl?: string;
}

const esc = (s: string): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * A figure as a person writes it: "$415 AUD", "$415.50 AUD". Whole amounts
 * lose the cents, because a price nobody typed cents into should not grow
 * them.
 */
export function offerAmountInWords(amount: number, ccy: string): string {
  const n = Number(amount);
  const said = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `$${said} ${String(ccy).toUpperCase()}`;
}

// Brand tokens (light palette; email clients get one designed look).
const PAPER = '#F6F8F7';
const INK = '#1C2523';
const LINE = '#D3DBD8';
const CARD = '#FFFFFF';
const MUTED = '#5c6a66';
const MATCH = '#6D28D9';
const HAVE = '#0E7268';
const WANT = '#B45309';

// ONE system sans stack for every element (mail clients strip web fonts, so
// mixed roles fall back inconsistently). Mono is for verification codes ONLY.
const SANS = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,Menlo,Consolas,monospace";

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 8px"><tr>
<td style="border-radius:12px;background:${INK}">
<a href="${esc(href)}" style="display:inline-block;padding:14px 34px;font-family:${SANS};font-size:16px;font-weight:600;color:${PAPER};text-decoration:none;border-radius:12px">${esc(label)}</a>
</td></tr></table>`;
}

function footerHtml(f: FooterLinks): string {
  const link = (href: string, label: string) =>
    `<a href="${esc(href)}" style="color:${MUTED};text-decoration:underline">${esc(label)}</a>`;
  const parts = [link(f.settingsUrl, 'Email settings'), link(f.ledgerUrl, 'Your ledger')];
  if (f.unsubUrl) parts.push(link(f.unsubUrl, 'Unsubscribe'));
  return `<tr><td style="padding:26px 8px 10px;text-align:center;font-family:${SANS};font-size:12px;line-height:1.7;color:${MUTED}">
${parts.join(' &nbsp;·&nbsp; ')}<br>
OpenSwitchboard &nbsp;·&nbsp; openswitchboard.ai<br>
You get this email because you hold an OpenSwitchboard account.
</td></tr>`;
}

function footerText(f: FooterLinks): string {
  const lines = [
    '—',
    `Email settings: ${f.settingsUrl}`,
    `Your ledger: ${f.ledgerUrl}`,
  ];
  if (f.unsubUrl) lines.push(`Unsubscribe: ${f.unsubUrl}`);
  lines.push('OpenSwitchboard · openswitchboard.ai');
  lines.push('You get this email because you hold an OpenSwitchboard account.');
  return lines.join('\n');
}

/** Shared responsive shell: paper ground, one 520px column, Patch small. */
function shell(bodyRows: string, f: FooterLinks, accent = LINE): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>OpenSwitchboard</title></head>
<body style="margin:0;padding:0;background:${PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}">
<tr><td align="center" style="padding:28px 14px 36px">
<table role="presentation" cellpadding="0" cellspacing="0" width="520" style="width:100%;max-width:520px">
<tr><td style="padding:0 8px 18px;font-family:${SANS};font-size:14px;font-weight:700;color:${INK}">
<img src="https://openswitchboard.ai/brand/patch-64.png" width="22" height="22" alt="" style="vertical-align:middle;border:0">&nbsp; OpenSwitchboard
</td></tr>
<tr><td style="background:${CARD};border:1px solid ${LINE};border-top:3px solid ${accent};border-radius:14px;padding:34px 30px 30px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bodyRows}</table>
</td></tr>
${footerHtml(f)}
</table>
</td></tr></table>
</body></html>`;
}

const h1 = (t: string) =>
  `<tr><td style="font-family:${SANS};font-size:22px;font-weight:700;line-height:1.25;color:${INK};padding-bottom:10px">${t}</td></tr>`;
const para = (t: string, extra = '') =>
  `<tr><td style="font-family:${SANS};font-size:17px;line-height:1.6;color:${INK};padding:4px 0${extra}">${t}</td></tr>`;
const small = (t: string) =>
  `<tr><td style="font-family:${SANS};font-size:13px;line-height:1.6;color:${MUTED};padding-top:16px">${t}</td></tr>`;
const center = (inner: string) => `<tr><td align="center">${inner}</td></tr>`;

// ---------------------------------------------------------------------------
// (a) Verification code.
// ---------------------------------------------------------------------------
export function renderVerification(
  v: { code: string; link: string; purpose: 'register' | 'login' },
  f: FooterLinks,
): EmailContent {
  const what = v.purpose === 'register' ? 'finish opening your account' : 'sign in';
  const subject = `${v.code} is your OpenSwitchboard code`;
  const html = shell(
    h1('Your code.') +
      para(`Enter it to ${what}.`) +
      center(
        `<div style="font-family:${MONO};font-size:34px;letter-spacing:10px;color:${INK};background:${PAPER};border:1px solid ${LINE};border-radius:12px;padding:16px 10px;margin:18px 0 6px;text-align:center">${esc(v.code)}</div>`,
      ) +
      center(button(v.link, 'Or open this link')) +
      small(
        `This code works for the next 15 minutes. If you did not ask for this, ignore this email.`,
      ),
    f,
  );
  const text =
    `Your OpenSwitchboard verification code is: ${v.code}\n\n` +
    `Enter it to ${what}, or open this link:\n${v.link}\n\n` +
    `This code works for the next 15 minutes. ` +
    `If you did not ask for this, ignore this email.\n\n` +
    footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (b) Approval request. Non-blind: may carry the caller's category-level
// summary (never identity, never amounts before approval). Blind: pointer only.
// ---------------------------------------------------------------------------
export function renderApproval(
  v: { link: string; summary?: string; blind: boolean; counterUrl: string },
  f: FooterLinks,
): EmailContent {
  const subject = 'OpenSwitchboard: something is waiting for your approval';
  const line = v.blind
    ? 'Something needs your decision.'
    : (v.summary ?? 'Your assistant lined something up. It needs your decision.');
  const html = shell(
    h1('Your decision is needed.') +
      para(esc(line)) +
      center(button(v.link, 'Review and decide')) +
      small(
        `The link works once. ` +
          `<a href="${esc(v.counterUrl)}" style="color:${MUTED}">Sign in</a> any time to review it. ` +
          `Nothing is shared or accepted until you approve it.`,
      ),
    f,
    HAVE,
  );
  const text =
    `${line}\n\nReview and decide:\n${v.link}\n\n` +
    `The link works once. Sign in at ${v.counterUrl} any time to review it.\n\n` +
    `Nothing is shared or accepted until you approve it.\n\n` +
    footerText(f);
  return { subject, html, text };
}

/** The closing line on every email whose next step is a word to an assistant. */
const ASK_YOUR_ASSISTANT = 'Ask your assistant.';

// ---------------------------------------------------------------------------
// (c) Match summons — the screenshot-worthy one. One clear line, and no button:
// the next step is to tell their assistant they are interested, which is a
// sentence rather than a press. count > 1 covers the daily/weekly summons
// batch. Non-blind may name the category (category-level only). Blind:
// pointer, nothing else.
// ---------------------------------------------------------------------------
const ORDINALS = ['', '', 'second', 'third', 'fourth', 'fifth'];
/** "Someone" for the first arrival on a want or have, "A second person" after that. */
function whoCameForward(ordinal: number | undefined): string {
  if (!ordinal || ordinal < 2) return 'Someone';
  return ORDINALS[ordinal] ? `A ${ORDINALS[ordinal]} person` : 'Another person';
}

export function renderSummons(
  v: { count: number; ordinal?: number; categoryLabel?: string; blind: boolean; counterUrl: string },
  f: FooterLinks,
): EmailContent {
  const later = (v.ordinal ?? 1) >= 2;
  const subject = later ? 'Your assistant has more news' : 'Your assistant has news';
  const thing = categoryPhrase(v.categoryLabel);
  const who = whoCameForward(v.ordinal);
  const textLine = v.blind
    ? v.count === 1
      ? later ? 'Something else is waiting for you.' : 'Something is waiting for you.'
      : `${v.count} things are waiting for you.`
    : v.count === 1
      ? thing
        ? `${who} has come forward about your ${thing}.`
        : `${who} has come forward.`
      : `${v.count} people have come forward.`;
  const line =
    !v.blind && v.count === 1 && thing
      ? `${who} has come forward about your <span style="font-family:${SANS};font-weight:600;font-size:16px">${esc(thing)}</span>.`
      : esc(textLine);
  const html = shell(
    `<tr><td style="font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${MATCH};padding-bottom:14px">Match</td></tr>` +
      `<tr><td style="font-family:${SANS};font-size:24px;line-height:1.4;color:${INK};padding:2px 0 6px">${esc(subject)}.</td></tr>` +
      para(line) +
      small(ASK_YOUR_ASSISTANT),
    f,
    MATCH,
  );
  const text = `${subject}.\n\n${textLine}\n\n${ASK_YOUR_ASSISTANT}\n\n` + footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (c2) Waiting-message nudge. The other side has sent something on an open
// conversation and it is sitting uncollected; this tells the recipient's human
// so the exchange does not stall with both sides waiting. Plain and warm, with
// none of the machinery words (no "channel", "match", "listing"): it is simply
// their conversation. Non-blind may name the category the way a summons does;
// blind is a pure pointer. Throttled upstream (domain/channelNotify.ts) so a
// live back-and-forth never becomes one email per line.
// ---------------------------------------------------------------------------
export function renderChannelWaiting(
  v: { categoryLabel?: string; blind: boolean; counterUrl: string },
  f: FooterLinks,
): EmailContent {
  const subject = 'You have a message waiting';
  const thing = categoryPhrase(v.categoryLabel);
  // The switchboard carries the message and the assistant reads it out, so
  // there is nothing on any page for this person to press.
  const tail = 'Ask your assistant and it will read it to you.';
  const textLine = v.blind
    ? 'Someone has sent you a message.'
    : thing
      ? `Someone you got talking to about your ${thing} has sent you a message.`
      : 'Someone you got talking to has sent you a message.';
  const line = esc(textLine);
  const html = shell(h1('A message is waiting.') + para(line) + small(tail), f, MATCH);
  const text = `A message is waiting.\n\n${textLine}\n\n${tail}\n\n` + footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (c3) "Your move" nudge. The counterparty has stepped forward — said yes to
// swapping first names — and it is now this human's turn to answer. New-match
// is already summoned; this covers the later progression, where a passive human
// would otherwise never learn the ball is in their court.
//
// This is the one nudge that can carry a button, because the step it is about
// can be a gate. When the caller has a names-step approval link for this
// person, the email is the names-step email: one button, straight to the page
// where they share a first name and an area. Without one the step is something
// they say to their assistant, so the email ends the way the rest do.
// ---------------------------------------------------------------------------
export function renderYourMove(
  v: {
    categoryLabel?: string;
    blind: boolean;
    counterUrl: string;
    /** The approval link for this introduction's names step, when there is one. */
    namesUrl?: string;
  },
  f: FooterLinks,
): EmailContent {
  const subject = 'It is your turn';
  const thing = categoryPhrase(v.categoryLabel);
  const names = !!v.namesUrl;
  // True at this point and no more than true: they have said yes, and nothing
  // crosses in either direction until this person says yes as well. Blind mode
  // says none of it — the link still goes, worded the way a blind approval
  // email words it.
  const what =
    names && !v.blind
      ? 'They have said yes to swapping first names. Nothing crosses either way until you say yes too.'
      : '';
  const textLine = v.blind
    ? 'Someone is ready to hear back from you.'
    : thing
      ? `Someone you got talking to about your ${thing} is keen and ready to talk.`
      : 'Someone you got talking to is keen and ready to talk.';
  const body = [textLine, what].filter(Boolean).join(' ');
  const label = v.blind ? 'Review and decide' : 'Share your first name and area';
  const html = shell(
    h1('It is your move.') +
      para(esc(body)) +
      (names
        ? center(button(v.namesUrl!, label)) +
          small('Nothing is shared until you say so on that page.')
        : small(ASK_YOUR_ASSISTANT)),
    f,
    MATCH,
  );
  const text =
    `It is your move.\n\n${body}\n\n` +
    (names
      ? `${label}:\n${v.namesUrl}\n\nNothing is shared until you say so on that page.\n\n`
      : `${ASK_YOUR_ASSISTANT}\n\n`) +
    footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (c4) A number is on the table. The other person typed a figure on their own
// approval page, and this human hears about the switchboard by email — their
// assistant only wakes when they speak to it, so without this mail the figure
// sits on a page nobody has been told to open. Non-blind names the figure and
// the thing, because an offer is a deliberate disclosure meant to be seen;
// blind is a pure pointer.
//
// Saying yes to a figure is a gate that lives on the page, so this email keeps
// one button and it goes straight to that page. Blind mode has no page to name
// without naming the thing, so it ends on "Ask your assistant." like the rest.
// ---------------------------------------------------------------------------
export function renderOfferOnTheTable(
  v: {
    amount: number;
    ccy: string;
    categoryLabel?: string;
    blind: boolean;
    offersUrl: string;
    counterUrl: string;
  },
  f: FooterLinks,
): EmailContent {
  const figure = offerAmountInWords(v.amount, v.ccy);
  const thing = categoryPhrase(v.categoryLabel);
  const subject = v.blind
    ? 'OpenSwitchboard: something is waiting for you'
    : 'A number is on the table';
  const textLine = v.blind
    ? 'Someone has answered you.'
    : thing
      ? `Someone you got talking to has offered ${figure} for your ${thing}.`
      : `Someone you got talking to has offered ${figure}.`;
  const tail = v.blind
    ? ASK_YOUR_ASSISTANT
    : 'Nothing is agreed until you say so. You can answer with a number of your own, or leave it. Ask your assistant and it will talk it through with you.';
  const html = shell(
    h1(v.blind ? 'Something is waiting.' : 'There is a number on the table.') +
      para(esc(textLine)) +
      (v.blind ? '' : center(button(v.offersUrl, 'See the offer'))) +
      small(esc(tail)),
    f,
    HAVE,
  );
  const text =
    `${textLine}\n\n` +
    (v.blind ? '' : `See the offer:\n${v.offersUrl}\n\n`) +
    `${tail}\n\n` +
    footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (c5) The deal is agreed. One human accepted the other's figure on their own
// page, and this is the mail to the human whose figure it was. It goes to
// everybody, however they hear about the switchboard: an agreed price is the
// end of the switchboard's part, and a person is entitled to hear it from the
// switchboard as well as from their agent. No money moves on this path —
// settlements are their own thing — so the copy says plainly that the two of
// them arrange the handover.
// ---------------------------------------------------------------------------
export function renderDealAgreed(
  v: {
    amount: number;
    ccy: string;
    categoryLabel?: string;
    blind: boolean;
    matchUrl: string;
    counterUrl: string;
  },
  f: FooterLinks,
): EmailContent {
  const figure = offerAmountInWords(v.amount, v.ccy);
  const thing = categoryPhrase(v.categoryLabel);
  const subject = v.blind ? 'OpenSwitchboard: something moved on your account' : 'Deal agreed';
  const textLine = v.blind
    ? 'Something on your account is agreed. The detail waits behind your sign-in.'
    : thing
      ? `Deal: ${figure} agreed for your ${thing}. Sort pickup with them in the conversation; the switchboard's part is done.`
      : `Deal: ${figure} agreed. Sort pickup with them in the conversation; the switchboard's part is done.`;
  // A notice, so no button: nothing here needs the page. The next step is a
  // conversation, and the assistant is where that happens.
  const html = shell(
    h1(v.blind ? 'Something moved.' : 'You have a deal.') +
      para(esc(textLine)) +
      para('Ask your assistant.'),
    f,
    HAVE,
  );
  const text = `${textLine}\n\nAsk your assistant.\n\n` + footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (d) Activity digest. Items come from the digest engine: per open want-or-have
// cell, counts of new opposite-side posts (cell already clears the k-anonymity
// floor by construction — see domain/pulse.ts) and that want or have's own new
// near-misses. Blind: pointer only.
// ---------------------------------------------------------------------------
export interface DigestItem {
  type: 'WANT' | 'HAVE';
  /** Human taxonomy label ("Mountain bikes") — never the raw slug. */
  categoryLabel: string;
  /** New opposite-side posts in this one's (category, geo) cell since the
   *  last digest. null when the cell is under the k-anonymity floor. */
  newOpposite: number | null;
  nearMisses: number;
}

export function renderDigest(
  v: { cadence: 'daily' | 'weekly'; items: DigestItem[]; blind: boolean; counterUrl: string },
  f: FooterLinks,
): EmailContent {
  const period = v.cadence === 'daily' ? 'today' : 'this week';
  const subject = `Your ${v.cadence} OpenSwitchboard digest`;
  if (v.blind) {
    const html = shell(
      h1('Your digest is ready.') +
        para(`There is movement around your wants and haves ${period}. The detail waits behind your sign-in.`) +
        center(button(v.counterUrl, "See what's new")),
      f,
      MATCH,
    );
    const text =
      `Your digest is ready.\n\nThere is movement around your wants and haves ${period}. ` +
      `The detail waits behind your sign-in:\n${v.counterUrl}\n\n` +
      footerText(f);
    return { subject, html, text };
  }
  const rows = v.items
    .map((it) => {
      const bits: string[] = [];
      if (it.newOpposite !== null && it.newOpposite > 0) {
        const side = it.type === 'WANT' ? 'have' : 'want';
        bits.push(`${it.newOpposite} new ${side}${it.newOpposite === 1 ? '' : 's'} nearby`);
      }
      if (it.nearMisses > 0) {
        bits.push(`${it.nearMisses} near miss${it.nearMisses === 1 ? '' : 'es'}`);
      }
      const badgeColor = it.type === 'WANT' ? WANT : HAVE;
      return `<tr>
<td style="padding:10px 0;border-bottom:1px solid ${LINE}">
<span style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:.5px;color:#fff;background:${badgeColor};border-radius:999px;padding:2px 8px">${it.type}</span>
<span style="font-family:${SANS};font-weight:600;font-size:14px;color:${INK}">&nbsp;${esc(it.categoryLabel)}</span><br>
<span style="font-family:${SANS};font-size:15px;color:${MUTED}">${esc(bits.join(' · '))}</span>
</td></tr>`;
    })
    .join('');
  const html = shell(
    h1(`Around your wants and haves ${period}.`) +
      `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>` +
      center(button(v.counterUrl, "See what's new")) +
      small('Counts are real and current. Near misses stay near misses until the switchboard is sure.'),
    f,
    MATCH,
  );
  const textRows = v.items
    .map((it) => {
      const bits: string[] = [];
      if (it.newOpposite !== null && it.newOpposite > 0) {
        const side = it.type === 'WANT' ? 'have' : 'want';
        bits.push(`${it.newOpposite} new ${side}${it.newOpposite === 1 ? '' : 's'} nearby`);
      }
      if (it.nearMisses > 0) bits.push(`${it.nearMisses} near miss${it.nearMisses === 1 ? '' : 'es'}`);
      return `- ${it.type} ${it.categoryLabel}: ${bits.join(', ')}`;
    })
    .join('\n');
  const text =
    `Around your wants and haves ${period}:\n\n${textRows}\n\n` +
    `See what's new:\n${v.counterUrl}\n\n` +
    footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (e) "Still true?" renewal. Wants and haves expire on their own; this lands 7
// days before the next expiry. Lists the account's open ones with one-tap
// renew-all and a review link. The lapse date is printed the way a person reads
// it ("Thursday 11 September") — an email cannot run a script to localise it.
// Blind: pointer only.
// ---------------------------------------------------------------------------
export interface RenewalCardItem {
  type: 'WANT' | 'HAVE';
  /** Human taxonomy label ("Mountain bikes") — never the raw slug. */
  categoryLabel: string;
  expiresAt: Date;
  expiringSoon: boolean;
}

export function renderRenewal(
  v: { cards: RenewalCardItem[]; renewAllUrl: string; blind: boolean; counterUrl: string },
  f: FooterLinks,
): EmailContent {
  const subject = 'Still true?';
  const soon = v.cards.filter((c) => c.expiringSoon).length;
  if (v.blind) {
    const html = shell(
      h1('Still true?') +
        para('Wants and haves on the switchboard lapse on their own. Some of yours lapse within a week. Keep them or let them go from your ledger.') +
        center(button(v.counterUrl, 'Review your wants and haves')),
      f,
      WANT,
    );
    const text =
      `Still true?\n\nWants and haves on the switchboard lapse on their own. Some of yours ` +
      `lapse within a week. Review your wants and haves:\n${v.counterUrl}\n\n` +
      footerText(f);
    return { subject, html, text };
  }
  const rows = v.cards
    .map((c) => {
      const badgeColor = c.type === 'WANT' ? WANT : HAVE;
      const when = plainDay(c.expiresAt);
      return `<tr><td style="padding:9px 0;border-bottom:1px solid ${LINE}">
<span style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:.5px;color:#fff;background:${badgeColor};border-radius:999px;padding:2px 8px">${c.type}</span>
<span style="font-family:${SANS};font-weight:600;font-size:14px;color:${INK}">&nbsp;${esc(c.categoryLabel)}</span><br>
<span style="font-family:${SANS};font-size:12px;color:${c.expiringSoon ? WANT : MUTED}">lapses ${when}${c.expiringSoon ? ' — within a week' : ''}</span>
</td></tr>`;
    })
    .join('');
  const html = shell(
    h1('Still true?') +
      para(
        `Wants and haves on the switchboard lapse on their own; that is the rule that keeps every one of them honest. ` +
          `${soon === 1 ? 'One of yours lapses' : `${soon} of yours lapse`} within a week.`,
      ) +
      `<tr><td style="padding-top:8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>` +
      center(button(v.renewAllUrl, 'Still true — keep them all')) +
      small(
        `Renewing restarts each one's own clock. To edit or drop them one at a time, ` +
          `<a href="${esc(f.ledgerUrl)}" style="color:${MUTED}">review your ledger</a>. ` +
          `Do nothing and they lapse quietly.`,
      ),
    f,
    WANT,
  );
  const textRows = v.cards
    .map(
      (c) =>
        `- ${c.type} ${c.categoryLabel}: lapses ${plainDay(c.expiresAt)}${c.expiringSoon ? ' (within a week)' : ''}`,
    )
    .join('\n');
  const text =
    `Still true?\n\nWants and haves on the switchboard lapse on their own; that is the rule ` +
    `that keeps every one of them honest. ` +
    `${soon === 1 ? 'One of yours lapses' : `${soon} of yours lapse`} within a week.\n\n` +
    `${textRows}\n\n` +
    `Still true — keep them all:\n${v.renewAllUrl}\n\n` +
    `Review one by one:\n${f.ledgerUrl}\n\n` +
    `Do nothing and they lapse quietly.\n\n` +
    footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (f) Kill switch on / off.
// ---------------------------------------------------------------------------
export function renderKillSwitch(
  v: { on: boolean; counterUrl: string },
  f: FooterLinks,
): EmailContent {
  if (v.on) {
    const subject = 'OpenSwitchboard: kill switch is ON';
    const html = shell(
      h1('Everything is paused.') +
        para(
          'The kill switch on your account was just activated. All of your wants and haves are paused and your agents&#39; tokens are suspended. Nothing will match, be disclosed, or be accepted while it is on.',
        ) +
        center(button(v.counterUrl, 'Open your account')) +
        small(
          'Turning things back on takes your sign-in and your PIN. If you did not do this, your account is already safe — everything is paused. Sign in when you can and review your ledger.',
        ),
      f,
      '#a3271f',
    );
    const text =
      `The kill switch on your OpenSwitchboard account was just activated.\n\n` +
      `All of your wants and haves are paused and your agents' tokens are suspended. ` +
      `Nothing will match, be disclosed, or be accepted while it is on.\n\n` +
      `To turn things back on, sign in at ${v.counterUrl} and confirm with your PIN.\n\n` +
      `If you did not do this, your account is already safe — everything is paused. ` +
      `Sign in when you can and review your ledger.\n\n` +
      footerText(f);
    return { subject, html, text };
  }
  const subject = 'OpenSwitchboard: kill switch is off';
  const html = shell(
    h1('Everything is back on.') +
      para(
        'The kill switch on your account was just turned off with your PIN. Your wants and haves are back in matching and your agents&#39; tokens work again.',
      ) +
      center(button(v.counterUrl, 'Open your account')) +
      small('If you did not do this, hit the kill switch again from your account and change your PIN.'),
    f,
    HAVE,
  );
  const text =
    `The kill switch on your OpenSwitchboard account was just turned off with your PIN.\n\n` +
    `Your wants and haves are back in matching and your agents' tokens work again.\n\n` +
    `If you did not do this, hit the kill switch again at ${v.counterUrl} and change your PIN.\n\n` +
    footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (f2) Something the person posted did not pass screening. Transactional: it is
// off the board until they change it, so this goes out whatever their digest
// settings say. Non-blind carries the category label and the plain-words reason
// (both are the person's OWN want or have — nothing about anybody else is in
// here). Blind: pointer only.
// ---------------------------------------------------------------------------
export function renderScreeningRejected(
  v: {
    /** Human taxonomy label ("Mountain bikes") — never the raw slug. */
    categoryLabel?: string;
    /** The reason in plain words (domain/screening.ts owns the wording). */
    reason: string;
    /** Deep link to its edit form on the approval page. */
    editUrl: string;
    blind: boolean;
    counterUrl: string;
  },
  f: FooterLinks,
): EmailContent {
  if (v.blind) {
    const subject = 'OpenSwitchboard: something needs a change from you';
    const html = shell(
      h1('Something needs a change.') +
        para('Something on your account needs a change from you before it can go back out. The detail waits behind your sign-in.') +
        center(button(v.counterUrl, "See what's waiting")),
      f,
      WANT,
    );
    const text =
      `Something on your account needs a change from you before it can go back out. ` +
      `The detail waits behind your sign-in:\n${v.counterUrl}\n\n` +
      footerText(f);
    return { subject, html, text };
  }
  const subject = 'OpenSwitchboard: something you posted needs a change';
  const thing = categoryPhrase(v.categoryLabel);
  const which = thing ? `What you put up about your ${thing}` : 'What you posted';
  const html = shell(
    h1('Something you posted needs a change.') +
      para(
        `${esc(which)} did not pass screening, so it is off the board until you change it. Here is what screening picked up:`,
      ) +
      para(esc(v.reason)) +
      center(button(v.editUrl, 'Open it')) +
      small(
        'Everything you post goes through screening before it reaches anyone. Edit this one and save it, and it goes straight back through.',
      ),
    f,
    WANT,
  );
  const text =
    `${which} did not pass screening, so it is off the board until you change it.\n\n` +
    `Here is what screening picked up:\n${v.reason}\n\n` +
    `Open it:\n${v.editUrl}\n\n` +
    `Everything you post goes through screening before it reaches anyone. Edit this one ` +
    `and save it, and it goes straight back through.\n\n` +
    footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (g) Security notices.
// ---------------------------------------------------------------------------
export type SecurityNoticeEvent = 'agent-authorized' | 'pin-changed' | 'agent-key-created';

export function renderSecurityNotice(
  v: { event: SecurityNoticeEvent; agentName?: string; counterUrl: string },
  f: FooterLinks,
): EmailContent {
  const subject = {
    'agent-authorized': 'OpenSwitchboard: a new agent was authorised',
    'pin-changed': 'OpenSwitchboard: your PIN was changed',
    'agent-key-created': 'OpenSwitchboard: a new agent key was created',
  }[v.event];
  // Blind mode is the caller's job here: it strips agentName, and the copy
  // below carries nothing else about the account.
  const namedHtml = v.agentName ? ` (&#8220;${esc(v.agentName)}&#8221;)` : '';
  const namedText = v.agentName ? ` ("${v.agentName}")` : '';
  const line = {
    'agent-authorized': `A new agent${namedHtml} was just authorised to use your account.`,
    'pin-changed': 'The PIN on your account was just changed.',
    'agent-key-created': `A new agent key${namedHtml} was just created on your account. Anything holding that key can act as your agent until it lapses or you revoke it.`,
  }[v.event];
  const textLine = {
    'agent-authorized': `A new agent${namedText} was just authorised to use your account.`,
    'pin-changed': 'The PIN on your account was just changed.',
    'agent-key-created': `A new agent key${namedText} was just created on your account. Anything holding that key can act as your agent until it lapses or you revoke it.`,
  }[v.event];
  const html = shell(
    h1('A change on your account.') +
      para(line) +
      center(button(v.counterUrl, 'Review your account')) +
      small(
        'If this was you, all good. If it was someone else, hit the kill switch — one tap pauses everything.',
      ),
    f,
    WANT,
  );
  const text =
    `${textLine}\n\n` +
    `Review your account:\n${v.counterUrl}\n\n` +
    `If this was you, all good. If it was someone else, hit the kill switch — ` +
    `one tap pauses everything.\n\n` +
    footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (h) Settlement lifecycle (phase 1.A safe hands). settlement-proposed is an
// approval-style nudge with the single-use link; the update templates track
// the held payment. Non-blind copy stays category/amount-free below the
// approval gate: the amount is on the approval page, behind auth. Blind:
// pointer only.
// ---------------------------------------------------------------------------
export function renderSettlementProposed(
  v: { link: string; summary?: string; blind: boolean; counterUrl: string },
  f: FooterLinks,
): EmailContent {
  // Blind mode: subject and body reveal nothing beyond the pointer (that a
  // settlement exists is itself content).
  const subject = v.blind
    ? 'OpenSwitchboard: something is waiting for your approval'
    : 'OpenSwitchboard: a settlement is waiting for your approval';
  const line = v.blind
    ? 'Something needs your decision.'
    : (v.summary ?? 'Your assistant lined up a settlement. It needs your decision.');
  const tail = v.blind
    ? 'Nothing happens until you approve it.'
    : 'Nothing is paid until you approve it, and the money is held until the buyer confirms receipt.';
  const html = shell(
    h1('Your decision is needed.') +
      para(esc(line)) +
      center(button(v.link, 'Review and decide')) +
      small(
        `The link works once. ` +
          `<a href="${esc(v.counterUrl)}" style="color:${MUTED}">Sign in</a> any time to review it. ` +
          esc(tail),
      ),
    f,
    HAVE,
  );
  const text =
    `${line}\n\nReview and decide:\n${v.link}\n\n` +
    `The link works once. Sign in at ${v.counterUrl} any time to review it.\n\n` +
    `${tail}\n\n` +
    footerText(f);
  return { subject, html, text };
}

export type SettlementUpdateEvent =
  | 'payment-held'
  | 'handover-window'
  | 'confirm-receipt-request'
  | 'released'
  | 'refund'
  | 'disputed'
  | 'resolution-proposed'
  | 'split';

/** "Saturday 13 September" — a date a person reads without decoding it. */
function plainDay(d: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);
}

export function renderSettlementUpdate(
  v: {
    event: SettlementUpdateEvent;
    role: 'buyer' | 'seller';
    blind: boolean;
    settlementUrl: string;
    counterUrl: string;
    /** When the held payment releases on its own. Carried by the handover
     *  mails, which are the whole point of saying the date out loud. */
    deadline?: Date;
    /** True when the clock released this payment rather than the buyer. */
    auto?: boolean;
  },
  f: FooterLinks,
): EmailContent {
  const by = v.deadline ? plainDay(v.deadline) : undefined;
  const copy: Record<SettlementUpdateEvent, { subject: string; heading: string; buyer: string; seller: string; buttonLabel: string }> = {
    'payment-held': {
      subject: 'OpenSwitchboard: the payment is held',
      heading: 'The payment is in safe hands.',
      buyer:
        'Your payment went through and is held. It moves to the seller only after you confirm receipt.',
      seller:
        'The buyer paid and the money is held. Hand over the goods, then lock your handover evidence from the settlement page.',
      buttonLabel: 'Open the settlement',
    },
    // The seller has said the thing changed hands, which starts the buyer's
    // window. This is the buyer's mail: their two ways to end the window, and
    // the date it ends by itself.
    'handover-window': {
      subject: by
        ? `OpenSwitchboard: handed over — confirm or raise a problem by ${by}`
        : 'OpenSwitchboard: handed over — confirm or raise a problem',
      heading: 'The seller says it has changed hands.',
      buyer: by
        ? `Confirm receipt once everything is in your hands and as described, and the held payment goes to the seller. If something is wrong, say so on the settlement page instead and the payment freezes while the two of you sort it out. You have until ${by}; after that the held payment is released to the seller on its own.`
        : 'Confirm receipt once everything is in your hands and as described, and the held payment goes to the seller. If something is wrong, say so on the settlement page instead and the payment freezes while the two of you sort it out.',
      seller: by
        ? `You have declared the handover. The buyer has until ${by} to confirm receipt or raise a problem, and the held payment comes to you on that date if they do neither.`
        : 'You have declared the handover, and the buyer has been asked to confirm receipt.',
      buttonLabel: 'Open the settlement',
    },
    'confirm-receipt-request': {
      subject: 'OpenSwitchboard: confirm receipt',
      heading: 'Ready for your confirmation.',
      buyer: by
        ? `The seller says the goods have changed hands. Once they are with you, confirm receipt and the held payment is released. You have until ${by}; after that it is released to the seller on its own.`
        : 'The seller says the goods have changed hands. Once they are with you, confirm receipt and the held payment is released.',
      seller: by
        ? `Your handover is recorded and the buyer has been asked to confirm receipt. They have until ${by}; after that the held payment comes to you on its own.`
        : 'Your handover is recorded and the buyer has been asked to confirm receipt.',
      buttonLabel: 'Open the settlement',
    },
    released: {
      subject: 'OpenSwitchboard: payment released',
      heading: 'The payment is released.',
      buyer: v.auto
        ? 'The window to confirm or raise a problem has run out, so the held payment was released to the seller. This settlement is complete.'
        : 'You confirmed receipt and the held payment was released to the seller. This settlement is complete.',
      seller: v.auto
        ? "The buyer's window to confirm or raise a problem has run out, so the held payment was released to you. This settlement is complete."
        : 'The buyer confirmed receipt and the held payment was released to you. This settlement is complete.',
      buttonLabel: 'See the settlement',
    },
    refund: {
      subject: 'OpenSwitchboard: payment returned',
      heading: 'The payment went back.',
      buyer:
        'The agreed amount was returned to you. The introductory fee and the card processing stay paid, because the card processor keeps its own fee on a refund. This settlement is closed.',
      seller: 'The agreed amount was returned to the buyer. This settlement is closed.',
      buttonLabel: 'See the settlement',
    },
    // Somebody said something is wrong. Nothing has moved; the payment is
    // simply frozen, and both people are told what they can do about it.
    disputed: {
      subject: 'OpenSwitchboard: the payment is on hold',
      heading: 'The payment is frozen.',
      buyer:
        'The payment is held where it is while the two of you sort this out. You can agree a split of the held amount, or send the item back with tracking and say so on the settlement page. If neither of you does anything for fourteen days, the payment goes to whichever side can show where the item went.',
      seller:
        'The payment is held where it is while the two of you sort this out. Add the tracking that shows where the item went, and you can agree a split of the held amount. If neither of you does anything for fourteen days, the payment goes to whichever side can show where the item went.',
      buttonLabel: 'Open the settlement',
    },
    'resolution-proposed': {
      subject: 'OpenSwitchboard: a way to settle this is waiting',
      heading: 'There is a split on the table.',
      buyer:
        'The seller has proposed how to divide the held amount. Have a look, and the money moves once you have both agreed to the same two figures.',
      seller:
        'The buyer has proposed how to divide the held amount. Have a look, and the money moves once you have both agreed to the same two figures.',
      buttonLabel: 'See what was proposed',
    },
    split: {
      subject: 'OpenSwitchboard: settled between you',
      heading: 'You both agreed, and the money has moved.',
      buyer:
        'You both approved the same split of the held amount, and your part is on its way back to you. The introductory fee and the card processing stay paid. This settlement is closed.',
      seller:
        'You both approved the same split of the held amount, and your part is on its way to you. This settlement is closed.',
      buttonLabel: 'See the settlement',
    },
  };
  const c = copy[v.event];
  if (v.blind) {
    const subject = 'OpenSwitchboard: something moved on your account';
    const html = shell(
      h1('Something moved.') +
        para('Something on your account changed. The detail waits behind your sign-in.') +
        center(button(v.counterUrl, "See what's waiting")),
      f,
      HAVE,
    );
    const text =
      `Something on your account changed. The detail waits behind your sign-in:\n${v.counterUrl}\n\n` +
      footerText(f);
    return { subject, html, text };
  }
  const line = v.role === 'buyer' ? c.buyer : c.seller;
  const html = shell(
    h1(c.heading) + para(esc(line)) + center(button(v.settlementUrl, c.buttonLabel)),
    f,
    v.event === 'refund' || v.event === 'disputed' ? WANT : HAVE,
  );
  const text = `${line}\n\n${c.buttonLabel}:\n${v.settlementUrl}\n\n` + footerText(f);
  return { subject: c.subject, html, text };
}
