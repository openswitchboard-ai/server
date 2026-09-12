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
 * THE EMAIL RULE (2026-09-11). The assistant does the talking and the
 * carrying; the switchboard's own page does the confirming; and whenever a
 * formality is needed the assistant hands the person a single-use link to a
 * one-question page, in the conversation they are already having. Email is not
 * part of that path. So:
 *
 *   A NOTICE EMAIL IS SENT ONLY WHEN THE RECIPIENT'S hears_via IS 'email',
 *   AND IT CARRIES NO LINK AND NO BUTTON. It says what happened in one
 *   sentence and ends "Ask your assistant."
 *
 * The notices are: the summons (including "a second person"), a message
 * waiting, your move on the way to the names step, a figure on the table, a
 * deal agreed, the renewal, a screening rejection, the settlement notices
 * (proposed and every update), and the digest. Every one of them is a person
 * being told something, and the thing they do about it is speak to their
 * assistant.
 *
 * THREE EXEMPTIONS, and only three. A verification code (it is how someone
 * signs in, so the link and the code both belong). A security notice (a new
 * agent, a new key, a changed PIN: the revoke gate keeps its button, the other
 * two carry the guidance as plain text). The kill-switch mail. Those send
 * whatever hears_via says, because they are about the account rather than
 * about the network.
 *
 * The footer keeps the unsubscribe link (RFC 8058 one-click) and the
 * email-settings link, which are required of any sender; nothing else.
 *
 * NOTICE_TEMPLATES below is that rule as a list, and email/send.ts enforces
 * both halves of it on every send.
 */

import { categoryPhrase, categoryPhraseWithArticle } from '../domain/matchRules.js';

// Re-exported so a caller working with email copy has it to hand; the helper
// itself lives beside the taxonomy labels it phrases.
export { categoryPhrase, categoryPhraseWithArticle };

/**
 * WHICH SIDE THE READER IS ON. Every sentence that names the thing has to know
 * whether the person reading it is the one offering it or the one after it —
 * "your mountain bike" to somebody who is trying to buy one is the switchboard
 * telling them they own what they want. The senders work it out from the
 * recipient's own want or have at send time and pass it in.
 */
export type ReaderSide = 'want' | 'have';

/**
 * The thing as this reader holds it: "your mountain bike" for the person
 * offering it, "the mountain bike you are after" for the person looking. The
 * one place either half of that is written.
 */
export function theirThing(thing: string, side: ReaderSide): string {
  return side === 'have' ? `your ${thing}` : `the ${thing} you are after`;
}

/** The side in the words a person uses about their own want or have. */
function sideInWords(type: 'WANT' | 'HAVE'): string {
  return type === 'HAVE' ? 'offering' : 'looking for';
}

/** First letter up, for a phrase that starts a line. Acronyms are untouched. */
function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/**
 * Footer links, and the only links a notice email carries. Both are required
 * of any sender: the one-click unsubscribe (RFC 8058) and a place to change
 * what gets sent. unsubUrl is present whenever the recipient has an account (a
 * registration verification for a brand-new address has no subscription to
 * leave, so its footer carries the settings link only once the account
 * exists).
 */
export interface FooterLinks {
  settingsUrl: string;
  unsubUrl?: string;
}

/**
 * The templates the notice rule covers: no link, no button, and sent only to
 * someone whose hears_via is 'email'. Names match email_sends.template, which
 * is what send.ts checks.
 */
export const NOTICE_TEMPLATES = new Set<string>([
  'approval',
  'summons',
  'channel-waiting',
  'your-move',
  'offer-on-the-table',
  'deal-agreed',
  'digest',
  'renewal',
  'card-screening-rejected',
  'settlement-proposed',
  'settlement-payment-held',
  'settlement-handover-window',
  'settlement-confirm-receipt-request',
  'settlement-released',
  'settlement-refund',
  'settlement-disputed',
  'settlement-resolution-proposed',
  'settlement-split',
]);

/** The three exemptions, by send-log name: they go out whatever hears_via
 *  says, and they may carry a link. */
export const EXEMPT_TEMPLATES = new Set<string>([
  'verification',
  'kill-switch-on',
  'kill-switch-off',
  'security-agent-authorized',
  'security-pin-changed',
  'security-agent-key-created',
]);

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
  const parts = [link(f.settingsUrl, 'Email settings')];
  if (f.unsubUrl) parts.push(link(f.unsubUrl, 'Unsubscribe'));
  return `<tr><td style="padding:26px 8px 10px;text-align:center;font-family:${SANS};font-size:12px;line-height:1.7;color:${MUTED}">
${parts.join(' &nbsp;·&nbsp; ')}<br>
OpenSwitchboard &nbsp;·&nbsp; openswitchboard.ai<br>
You get this email because you hold an OpenSwitchboard account.
</td></tr>`;
}

function footerText(f: FooterLinks): string {
  const lines = ['—', `Email settings: ${f.settingsUrl}`];
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

/** The closing line on every notice. It is the whole of what to do next. */
const ASK_YOUR_ASSISTANT = 'Ask your assistant.';

/**
 * A notice, in one shape: a heading, one sentence, and "Ask your assistant."
 * No link, no button — the person's assistant hands them a link when a
 * formality is actually needed, and everything else is a word to it.
 */
function notice(
  v: { heading: string; line: string; accent?: string; eyebrow?: string; extra?: string },
  f: FooterLinks,
): { html: string; text: string } {
  const eyebrow = v.eyebrow
    ? `<tr><td style="font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${v.accent ?? MATCH};padding-bottom:14px">${esc(v.eyebrow)}</td></tr>`
    : '';
  const html = shell(
    eyebrow +
      h1(esc(v.heading)) +
      para(esc(v.line)) +
      (v.extra ?? '') +
      small(ASK_YOUR_ASSISTANT),
    f,
    v.accent ?? MATCH,
  );
  const text = `${v.heading}\n\n${v.line}\n\n${ASK_YOUR_ASSISTANT}\n\n` + footerText(f);
  return { html, text };
}

// ---------------------------------------------------------------------------
// (b) Something is waiting on this person's own page. A notice like the rest:
// their assistant knows what it is and can hand them the link to it.
// ---------------------------------------------------------------------------
export function renderApproval(
  v: { summary?: string; blind: boolean },
  f: FooterLinks,
): EmailContent {
  const subject = 'OpenSwitchboard: something is waiting for you';
  const line = v.blind
    ? 'Something needs your decision.'
    : (v.summary ?? 'Something needs your decision.');
  const { html, text } = notice({ heading: 'Your decision is needed.', line, accent: HAVE }, f);
  return { subject, html, text };
}

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
  v: {
    count: number;
    ordinal?: number;
    categoryLabel?: string;
    blind: boolean;
    /** The RECIPIENT'S own side. The batched summons counts arrivals across
     *  every want and have at once and names none of them, so it has no one
     *  side to give; without a side the sentence names nothing either. */
    side?: ReaderSide;
  },
  f: FooterLinks,
): EmailContent {
  const later = (v.ordinal ?? 1) >= 2;
  const subject = later ? 'Your assistant has more news' : 'Your assistant has news';
  const thing = categoryPhrase(v.categoryLabel);
  const who = whoCameForward(v.ordinal);
  // Somebody offering hears about the thing they hold; somebody looking hears
  // that a person turned up WITH one, because they hold nothing yet.
  const named = !!thing && !!v.side;
  const phrase = v.side === 'want' ? categoryPhraseWithArticle(v.categoryLabel) : thing;
  const preposition = v.side === 'want' ? 'with' : 'about your';
  const textLine = v.blind
    ? v.count === 1
      ? later ? 'Something else is waiting for you.' : 'Something is waiting for you.'
      : `${v.count} things are waiting for you.`
    : v.count === 1
      ? named
        ? `${who} has come forward ${preposition} ${phrase}.`
        : `${who} has come forward.`
      : `${v.count} people have come forward.`;
  const line =
    !v.blind && v.count === 1 && named
      ? `${who} has come forward ${preposition} <span style="font-family:${SANS};font-weight:600;font-size:16px">${esc(phrase)}</span>.`
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
  v: { categoryLabel?: string; blind: boolean; side: ReaderSide },
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
      ? `Someone you got talking to about ${theirThing(thing, v.side)} has sent you a message.`
      : 'Someone you got talking to has sent you a message.';
  const line = esc(textLine);
  const html = shell(h1('A message is waiting.') + para(line) + small(tail), f, MATCH);
  const text = `A message is waiting.\n\n${textLine}\n\n${tail}\n\n` + footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (c3) "Your move" nudge, at either of the two steps where a human who only
// hears by email would otherwise be left waiting on a page nobody has told
// them to open.
//
//   step 'names'   — the counterparty has said yes to swapping first names,
//                    and it is now this human's turn to answer.
//   step 'details' — the person this human said they were keen on has said
//                    the same back, so there is a little more to see now.
//                    The one told is the side that spoke first, because the
//                    other side has just heard it from their own assistant.
//
// New-match is already summoned; these cover the later progressions. A notice
// like the rest: the step each one is about is one their assistant can hand
// them a link to, so the email says what happened and stops there.
// ---------------------------------------------------------------------------
export type YourMoveStep = 'names' | 'details';

export function renderYourMove(
  v: { categoryLabel?: string; blind: boolean; step?: YourMoveStep; side: ReaderSide },
  f: FooterLinks,
): EmailContent {
  const thing = categoryPhrase(v.categoryLabel);
  if (v.step === 'details') {
    const line = v.blind
      ? 'They would like to take it further too.'
      : thing
        ? `Good news about the ${thing}: they would like to take it further too.`
        : 'They would like to take it further too.';
    const { html, text } = notice({ heading: 'They are keen too.', line, accent: MATCH }, f);
    return { subject: 'They are keen too', html, text };
  }
  const subject = 'It is your turn';
  // Nobody has said a word to anybody at this step: the other side has said
  // yes to swapping first names, and the two of them can talk once this
  // person says yes back. The sentence says exactly that and no more.
  const tail = 'Your yes is the last step before the two of you can talk.';
  const line = v.blind
    ? 'Someone is ready to hear back from you.'
    : thing
      ? `They have said yes to swapping first names about ${theirThing(thing, v.side)}. ${tail}`
      : `They have said yes to swapping first names. ${tail}`;
  const { html, text } = notice({ heading: 'It is your move.', line, accent: MATCH }, f);
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
// A notice like the rest: answering a figure — taking it, or replying with one
// of their own — is a sentence to their assistant, which hands them a link to
// the one page that asks the question when it comes to that.
// ---------------------------------------------------------------------------
/**
 * "for your mountain bike" is the seller's phrase; the buyer hears "for the
 * mountain bike you are after". Every sentence that names the thing beside a
 * figure goes through here, so no side is ever told it owns what it wants.
 */
export function aboutThing(thing: string | undefined, side: ReaderSide): string {
  if (!thing) return '';
  return ` for ${theirThing(thing, side)}`;
}

export function renderOfferOnTheTable(
  v: { amount: number; ccy: string; categoryLabel?: string; blind: boolean; side: 'want' | 'have' },
  f: FooterLinks,
): EmailContent {
  const figure = offerAmountInWords(v.amount, v.ccy);
  const thing = categoryPhrase(v.categoryLabel);
  const subject = v.blind
    ? 'OpenSwitchboard: something is waiting for you'
    : 'A number is on the table';
  const line = v.blind
    ? 'Someone has answered you.'
    : v.side === 'have'
      ? `Someone has offered ${figure}${aboutThing(thing, 'have')}.`
      : `Someone has come back with ${figure}${aboutThing(thing, 'want')}.`;
  const { html, text } = notice(
    {
      heading: v.blind ? 'Something is waiting.' : 'There is a number on the table.',
      line,
      accent: HAVE,
    },
    f,
  );
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (c5) The deal is agreed. One human accepted the other's figure on their own
// page, and this is the mail to the human whose figure it was. No money moves
// on this path — settlements are their own thing — so the copy hands the
// handover back to the two people and stops there.
// ---------------------------------------------------------------------------
export function renderDealAgreed(
  v: { amount: number; ccy: string; categoryLabel?: string; blind: boolean; side: 'want' | 'have' },
  f: FooterLinks,
): EmailContent {
  const figure = offerAmountInWords(v.amount, v.ccy);
  const thing = categoryPhrase(v.categoryLabel);
  const subject = v.blind ? 'OpenSwitchboard: something moved on your account' : 'Deal agreed';
  const line = v.blind
    ? 'Something on your account is agreed.'
    : `Deal: ${figure} agreed${aboutThing(thing, v.side)}. Where and when to hand it over is for the two of you.`;
  const { html, text } = notice(
    { heading: v.blind ? 'Something moved.' : 'You have a deal.', line, accent: HAVE },
    f,
  );
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

/**
 * The one line the digest stands on. It used to promise the counts were real
 * and say near misses stayed near misses "until the switchboard is sure",
 * which explains nothing to somebody who has never heard the phrase. This one
 * says what a near miss is.
 */
const NEAR_MISS_LINE = 'A near miss is someone close on everything but one thing.';

/**
 * The head of a digest line, with the side said in words. HAVE and WANT are
 * wire words and never reach a person: what they read is their own thing and
 * what they are doing with it.
 */
function digestHead(it: DigestItem): string {
  const phrase = categoryPhrase(it.categoryLabel) || it.categoryLabel.toLowerCase();
  return it.type === 'HAVE'
    ? `Your ${phrase} (${sideInWords(it.type)})`
    : `${capitalise(phrase)} (${sideInWords(it.type)})`;
}

/**
 * The counts beside it, in whole words and the right grammar for one and for
 * many. A null count is the k-anonymity floor: the cell is too small to say
 * anything about, so the line says that rather than a number.
 */
function digestCounts(it: DigestItem): string {
  const n = it.newOpposite;
  const arrivals =
    n === null
      ? 'nothing new that clears the floor'
      : it.type === 'HAVE'
        ? n === 0
          ? 'nobody new looking nearby'
          : `${n} new ${n === 1 ? 'person' : 'people'} looking nearby`
        : n === 0
          ? 'nothing new nearby'
          : `${n} new nearby`;
  const misses =
    it.nearMisses === 0
      ? 'no near misses'
      : it.nearMisses === 1
        ? '1 near miss'
        : `${it.nearMisses} near misses`;
  return `${arrivals}, ${misses}`;
}

const digestLine = (it: DigestItem): string => `${digestHead(it)}: ${digestCounts(it)}`;

export function renderDigest(
  v: { cadence: 'daily' | 'weekly'; items: DigestItem[]; blind: boolean },
  f: FooterLinks,
): EmailContent {
  const period = v.cadence === 'daily' ? 'today' : 'this week';
  const subject = `Your ${v.cadence} OpenSwitchboard digest`;
  if (v.blind) {
    const { html, text } = notice(
      {
        heading: 'Your digest is ready.',
        line: `There is movement around your wants and haves ${period}.`,
        accent: MATCH,
      },
      f,
    );
    return { subject, html, text };
  }
  const rows = v.items
    .map((it) => {
      const badgeColor = it.type === 'WANT' ? WANT : HAVE;
      return `<tr>
<td style="padding:10px 0;border-bottom:1px solid ${LINE}">
<span style="font-family:${SANS};font-weight:600;font-size:14px;color:${badgeColor}">${esc(digestHead(it))}</span><br>
<span style="font-family:${SANS};font-size:15px;color:${MUTED}">${esc(digestCounts(it))}</span>
</td></tr>`;
    })
    .join('');
  // A summary and no links: the digest tells someone what is moving, and what
  // they do about any of it is a word to their assistant.
  const { html, text } = notice(
    {
      heading: `Around your wants and haves ${period}.`,
      line: NEAR_MISS_LINE,
      accent: MATCH,
      extra: `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>`,
    },
    f,
  );
  const textRows = v.items.map((it) => `- ${digestLine(it)}`).join('\n');
  const fullText = text.replace(NEAR_MISS_LINE, `${textRows}\n\n${NEAR_MISS_LINE}`);
  return { subject, html, text: fullText };
}

// ---------------------------------------------------------------------------
// (e) "Still true?" renewal. Wants and haves expire on their own; this lands 7
// days before the next expiry, and says which one lapses when. The lapse date
// is printed the way a person reads it ("Thursday 11 September") — an email
// cannot run a script to localise it. Renewing and letting go are both a word
// to their assistant, so the mail carries no link. Blind: pointer only.
// ---------------------------------------------------------------------------
export interface RenewalCardItem {
  type: 'WANT' | 'HAVE';
  /** Human taxonomy label ("Mountain bikes") — never the raw slug. */
  categoryLabel: string;
  expiresAt: Date;
  expiringSoon: boolean;
}

/** The one sentence the renewal ends on, before "Ask your assistant." */
const RENEWAL_TAIL = 'Ask your assistant to renew or let it go.';

/**
 * A renewal line: the thing, what the person is doing with it, and the day it
 * lapses. "Within a week" was a marker in brackets; a person reads "this
 * week".
 */
function renewalLine(c: RenewalCardItem): string {
  const phrase = categoryPhrase(c.categoryLabel) || c.categoryLabel.toLowerCase();
  const when = c.expiringSoon
    ? `lapses this week, on ${plainDay(c.expiresAt)}`
    : `lapses ${plainDay(c.expiresAt)}`;
  return `${capitalise(phrase)} (${sideInWords(c.type)}): ${when}`;
}

export function renderRenewal(
  v: { cards: RenewalCardItem[]; blind: boolean },
  f: FooterLinks,
): EmailContent {
  const subject = 'Still true?';
  const soon = v.cards.filter((c) => c.expiringSoon);
  if (v.blind) {
    const { html, text } = notice(
      {
        heading: 'Still true?',
        line: `Wants and haves on the switchboard lapse on their own, and some of yours lapse within a week. ${RENEWAL_TAIL}`,
        accent: WANT,
      },
      f,
    );
    return { subject, html, text };
  }
  const rows = v.cards
    .map((c) => {
      const badgeColor = c.type === 'WANT' ? WANT : HAVE;
      const line = renewalLine(c);
      const head = line.slice(0, line.indexOf(':') + 1);
      const when = line.slice(line.indexOf(':') + 2);
      return `<tr><td style="padding:9px 0;border-bottom:1px solid ${LINE}">
<span style="font-family:${SANS};font-weight:600;font-size:14px;color:${badgeColor}">${esc(head)}</span><br>
<span style="font-family:${SANS};font-size:12px;color:${c.expiringSoon ? WANT : MUTED}">${esc(when)}</span>
</td></tr>`;
    })
    .join('');
  const first = soon[0];
  // One thing lapsing is a sentence about that thing; several is a sentence
  // about the first of them, so nobody has to read a list to learn what is
  // about to go.
  const lead = !first
    ? `Wants and haves on the switchboard lapse on their own. ${RENEWAL_TAIL}`
    : soon.length === 1
      ? `What you put up about your ${categoryPhrase(first.categoryLabel) || first.categoryLabel.toLowerCase()} lapses on ${plainDay(first.expiresAt)}. Ask your assistant to renew it or let it go.`
      : `${soon.length} of the things you put up lapse this week, starting with your ${categoryPhrase(first.categoryLabel) || first.categoryLabel.toLowerCase()} on ${plainDay(first.expiresAt)}. Ask your assistant to renew them or let them go.`;
  const { html, text } = notice(
    {
      heading: 'Still true?',
      line: lead,
      accent: WANT,
      extra: `<tr><td style="padding-top:8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>`,
    },
    f,
  );
  const textRows = v.cards.map((c) => `- ${renewalLine(c)}`).join('\n');
  return { subject, html, text: text.replace(`${lead}\n`, `${lead}\n\n${textRows}\n`) };
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
          'Turning things back on takes your sign-in and your PIN. If you did not do this, your account is already safe — everything is paused. Sign in when you can and look over your approval page.',
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
      `Sign in when you can and look over your approval page.\n\n` +
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
    blind: boolean;
  },
  f: FooterLinks,
): EmailContent {
  if (v.blind) {
    const { html, text } = notice(
      {
        heading: 'Something needs a change.',
        line: 'Something on your account needs a change from you before it can go back out.',
        accent: WANT,
      },
      f,
    );
    return { subject: 'OpenSwitchboard: something needs a change from you', html, text };
  }
  const thing = categoryPhrase(v.categoryLabel);
  const which = thing ? `What you put up about your ${thing}` : 'What you posted';
  // The reason rides along because it is this person's own want or have and
  // their own words that tripped screening. Fixing it is a word to their
  // assistant, which can amend it and send it back through.
  const { html, text } = notice(
    {
      heading: 'Something you posted needs a change.',
      line: `${which} did not pass screening, so it is off the board until you change it. ${v.reason}`,
      accent: WANT,
    },
    f,
  );
  return { subject: 'OpenSwitchboard: something you posted needs a change', html, text };
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
  // A security notice is one of the three exemptions: it goes out whatever
  // hears_via says, because it is about the account rather than the network.
  // The revoke gate keeps its button — revoking is the thing this mail exists
  // to make possible — and the other two carry the guidance as plain text.
  const isRevokeGate = v.event === 'agent-key-created';
  const html = shell(
    h1('A change on your account.') +
      para(line) +
      (isRevokeGate ? center(button(v.counterUrl, 'Review and revoke')) : '') +
      small(
        'If this was you, all good. If it was someone else, hit the kill switch — one tap pauses everything.' +
          (isRevokeGate ? '' : ` Sign in at <a href="${esc(v.counterUrl)}" style="color:${MUTED}">${esc(v.counterUrl)}</a> to look.`),
      ),
    f,
    WANT,
  );
  const text =
    `${textLine}\n\n` +
    (isRevokeGate ? `Review and revoke:\n${v.counterUrl}\n\n` : '') +
    `If this was you, all good. If it was someone else, hit the kill switch — ` +
    `one tap pauses everything.` +
    (isRevokeGate ? '' : ` Sign in at ${v.counterUrl} to look.`) +
    `\n\n` +
    footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (h) Settlement lifecycle (phase 1.A safe hands). Every one of these is a
// notice: a held payment moves only through someone's own approval page, and
// their assistant is what carries them to it. Non-blind copy stays
// category/amount-free below the approval gate; blind is a pure pointer.
// ---------------------------------------------------------------------------
export function renderSettlementProposed(
  v: { summary?: string; blind: boolean },
  f: FooterLinks,
): EmailContent {
  // Blind mode: subject and body reveal nothing (that a settlement exists is
  // itself content).
  const subject = v.blind
    ? 'OpenSwitchboard: something is waiting for your approval'
    : 'OpenSwitchboard: a settlement is waiting for your approval';
  const line = v.blind
    ? 'Something needs your decision.'
    : `${v.summary ?? 'A settlement needs your decision.'} Nothing is paid until you approve it, and the money is held until the buyer confirms receipt.`;
  const { html, text } = notice({ heading: 'Your decision is needed.', line, accent: HAVE }, f);
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
    /** When the held payment releases on its own. Carried by the handover
     *  mails, which are the whole point of saying the date out loud. */
    deadline?: Date;
    /** True when the clock released this payment rather than the buyer. */
    auto?: boolean;
  },
  f: FooterLinks,
): EmailContent {
  const by = v.deadline ? plainDay(v.deadline) : undefined;
  const copy: Record<SettlementUpdateEvent, { subject: string; heading: string; buyer: string; seller: string }> = {
    'payment-held': {
      subject: 'OpenSwitchboard: the payment is held',
      heading: 'The payment is in safe hands.',
      buyer:
        'Your payment went through and is held. It moves to the seller only after you confirm receipt.',
      seller:
        'The buyer paid and the money is held. Hand over the goods, then mark it handed over on the settlement page, with photos if you like.',
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
    },
    refund: {
      subject: 'OpenSwitchboard: payment returned',
      heading: 'The payment went back.',
      buyer:
        'The agreed amount was returned to you. The introductory fee and the card processing stay paid, because the card processor keeps its own fee on a refund. This settlement is closed.',
      seller: 'The agreed amount was returned to the buyer. This settlement is closed.',
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
    },
    'resolution-proposed': {
      subject: 'OpenSwitchboard: a way to settle this is waiting',
      heading: 'There is a split on the table.',
      buyer:
        'The seller has proposed how to divide the held amount. Have a look, and the money moves once you have both agreed to the same two figures.',
      seller:
        'The buyer has proposed how to divide the held amount. Have a look, and the money moves once you have both agreed to the same two figures.',
    },
    split: {
      subject: 'OpenSwitchboard: settled between you',
      heading: 'You both agreed, and the money has moved.',
      buyer:
        'You both approved the same split of the held amount, and your part is on its way back to you. The introductory fee and the card processing stay paid. This settlement is closed.',
      seller:
        'You both approved the same split of the held amount, and your part is on its way to you. This settlement is closed.',
    },
  };
  const c = copy[v.event];
  if (v.blind) {
    const { html, text } = notice(
      {
        heading: 'Something moved.',
        line: 'Something on your account changed.',
        accent: HAVE,
      },
      f,
    );
    return { subject: 'OpenSwitchboard: something moved on your account', html, text };
  }
  const { html, text } = notice(
    {
      heading: c.heading,
      line: v.role === 'buyer' ? c.buyer : c.seller,
      accent: v.event === 'refund' || v.event === 'disputed' ? WANT : HAVE,
    },
    f,
  );
  return { subject: c.subject, html, text };
}
