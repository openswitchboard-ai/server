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
 */

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
<span style="font-size:15px">&#128025;</span>&nbsp; OpenSwitchboard
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

// ---------------------------------------------------------------------------
// (c) Match summons — the screenshot-worthy one. One clear line, one button.
// count > 1 covers the daily/weekly summons batch. Non-blind may name the
// category (category-level only). Blind: pointer, nothing else.
// ---------------------------------------------------------------------------
export function renderSummons(
  v: { count: number; categoryLabel?: string; blind: boolean; counterUrl: string },
  f: FooterLinks,
): EmailContent {
  const subject = 'Your assistant has news';
  let line: string;
  if (v.blind) {
    line = v.count === 1 ? 'Something is waiting for you.' : `${v.count} things are waiting for you.`;
  } else if (v.count === 1) {
    line = v.categoryLabel
      ? `A match is waiting on your <span style="font-family:${SANS};font-weight:600;font-size:16px">${esc(v.categoryLabel)}</span> card.`
      : 'A match is waiting for you.';
  } else {
    line = `${v.count} matches are waiting for you.`;
  }
  const textLine = v.blind
    ? v.count === 1
      ? 'Something is waiting for you.'
      : `${v.count} things are waiting for you.`
    : v.count === 1
      ? v.categoryLabel
        ? `A match is waiting on your ${v.categoryLabel} card.`
        : 'A match is waiting for you.'
      : `${v.count} matches are waiting for you.`;
  const buttonLabel = v.blind
    ? "See what's waiting"
    : v.count === 1
      ? 'See the match'
      : 'See your matches';
  const html = shell(
    `<tr><td style="font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${MATCH};padding-bottom:14px">Match</td></tr>` +
      `<tr><td style="font-family:${SANS};font-size:24px;line-height:1.4;color:${INK};padding:2px 0 6px">Your assistant has news.</td></tr>` +
      para(line) +
      center(button(v.counterUrl, buttonLabel)),
    f,
    MATCH,
  );
  const text =
    `Your assistant has news.\n\n${textLine}\n\n` +
    `${buttonLabel}:\n${v.counterUrl}\n\n` +
    footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (d) Activity digest. Items come from the digest engine: per open card cell,
// counts of new opposite-side cards (cell already clears the k-anonymity
// floor by construction — see domain/pulse.ts) and the card's own new
// near-misses. Blind: pointer only.
// ---------------------------------------------------------------------------
export interface DigestItem {
  type: 'WANT' | 'HAVE';
  /** Human taxonomy label ("Mountain bikes") — never the raw slug. */
  categoryLabel: string;
  /** New opposite-side cards in this card's (category, geo) cell since the
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
        para(`There is movement around your cards ${period}. The detail waits behind your sign-in.`) +
        center(button(v.counterUrl, "See what's new")),
      f,
      MATCH,
    );
    const text =
      `Your digest is ready.\n\nThere is movement around your cards ${period}. ` +
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
    h1(`Around your cards ${period}.`) +
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
    `Around your cards ${period}:\n\n${textRows}\n\n` +
    `See what's new:\n${v.counterUrl}\n\n` +
    footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (e) "Still true?" renewal. Cards expire on their own; this lands 7 days
// before the next expiry. Lists the account's open cards with one-tap
// renew-all and a review link. Blind: pointer only.
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
        para('Cards on the switchboard lapse on their own. Some of yours lapse within a week. Keep them or let them go from your ledger.') +
        center(button(v.counterUrl, 'Review your cards')),
      f,
      WANT,
    );
    const text =
      `Still true?\n\nCards on the switchboard lapse on their own. Some of yours ` +
      `lapse within a week. Review your cards:\n${v.counterUrl}\n\n` +
      footerText(f);
    return { subject, html, text };
  }
  const rows = v.cards
    .map((c) => {
      const badgeColor = c.type === 'WANT' ? WANT : HAVE;
      const when = c.expiresAt.toISOString().slice(0, 10);
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
        `Cards on the switchboard lapse on their own — that is the rule that keeps every want and have honest. ` +
          `${soon === 1 ? 'One of yours lapses' : `${soon} of yours lapse`} within a week.`,
      ) +
      `<tr><td style="padding-top:8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>` +
      center(button(v.renewAllUrl, 'Still true — keep them all')) +
      small(
        `Renewing restarts each card's own clock. To edit or drop single cards, ` +
          `<a href="${esc(f.ledgerUrl)}" style="color:${MUTED}">review your ledger</a>. ` +
          `Do nothing and they lapse quietly.`,
      ),
    f,
    WANT,
  );
  const textRows = v.cards
    .map(
      (c) =>
        `- ${c.type} ${c.categoryLabel}: lapses ${c.expiresAt.toISOString().slice(0, 10)}${c.expiringSoon ? ' (within a week)' : ''}`,
    )
    .join('\n');
  const text =
    `Still true?\n\nCards on the switchboard lapse on their own — that is the rule ` +
    `that keeps every want and have honest. ` +
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
          'The kill switch on your account was just activated. All of your cards are paused and your agents&#39; tokens are suspended. Nothing will match, be disclosed, or be accepted while it is on.',
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
      `All of your cards are paused and your agents' tokens are suspended. ` +
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
        'The kill switch on your account was just turned off with your PIN. Your cards are back in matching and your agents&#39; tokens work again.',
      ) +
      center(button(v.counterUrl, 'Open your account')) +
      small('If you did not do this, hit the kill switch again from your account and change your PIN.'),
    f,
    HAVE,
  );
  const text =
    `The kill switch on your OpenSwitchboard account was just turned off with your PIN.\n\n` +
    `Your cards are back in matching and your agents' tokens work again.\n\n` +
    `If you did not do this, hit the kill switch again at ${v.counterUrl} and change your PIN.\n\n` +
    footerText(f);
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// (g) Security notices.
// ---------------------------------------------------------------------------
export function renderSecurityNotice(
  v: { event: 'agent-authorized' | 'pin-changed'; agentName?: string; counterUrl: string },
  f: FooterLinks,
): EmailContent {
  const subject =
    v.event === 'agent-authorized'
      ? 'OpenSwitchboard: a new agent was authorised'
      : 'OpenSwitchboard: your PIN was changed';
  const line =
    v.event === 'agent-authorized'
      ? `A new agent${v.agentName ? ` (&#8220;${esc(v.agentName)}&#8221;)` : ''} was just authorised to use your account.`
      : 'The PIN on your account was just changed.';
  const textLine =
    v.event === 'agent-authorized'
      ? `A new agent${v.agentName ? ` ("${v.agentName}")` : ''} was just authorised to use your account.`
      : 'The PIN on your account was just changed.';
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
  | 'confirm-receipt-request'
  | 'released'
  | 'refund';

export function renderSettlementUpdate(
  v: {
    event: SettlementUpdateEvent;
    role: 'buyer' | 'seller';
    blind: boolean;
    settlementUrl: string;
    counterUrl: string;
  },
  f: FooterLinks,
): EmailContent {
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
    'confirm-receipt-request': {
      subject: 'OpenSwitchboard: confirm receipt',
      heading: 'Ready for your confirmation.',
      buyer:
        'The seller locked the handover evidence. Once the goods are in your hands, confirm receipt and the held payment is released.',
      seller:
        'Your evidence is locked and the buyer has been asked to confirm receipt.',
      buttonLabel: 'Open the settlement',
    },
    released: {
      subject: 'OpenSwitchboard: payment released',
      heading: 'The payment is released.',
      buyer: 'You confirmed receipt and the held payment was released to the seller. This settlement is complete.',
      seller: 'The buyer confirmed receipt and the held payment was released to you. This settlement is complete.',
      buttonLabel: 'See the settlement',
    },
    refund: {
      subject: 'OpenSwitchboard: payment returned',
      heading: 'The payment went back.',
      buyer: 'The held payment was returned to you in full. This settlement is closed.',
      seller: 'The held payment was returned to the buyer. This settlement is closed.',
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
    v.event === 'refund' ? WANT : HAVE,
  );
  const text = `${line}\n\n${c.buttonLabel}:\n${v.settlementUrl}\n\n` + footerText(f);
  return { subject: c.subject, html, text };
}
