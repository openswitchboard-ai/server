/**
 * Transactional email senders (verification, approval, kill switch, security
 * notices). All rendering lives in email/templates.ts; every send goes
 * through the one pipeline in email/send.ts (idempotency, suppression,
 * banned-phrase lint, configuration set, RFC 8058 headers, sandbox note).
 */
import { createHash } from 'node:crypto';
import { findAccountByEmail } from '../domain/accounts.js';
import {
  renderAccountDeleted,
  renderApproval,
  renderDealAgreed,
  renderKillSwitch,
  renderOfferOnTheTable,
  renderReceipt,
  renderScreeningRejected,
  renderSecurityNotice,
  renderSettlementProposed,
  renderSettlementUpdate,
  renderVerification,
  type SecurityNoticeEvent,
  type SettlementUpdateEvent,
} from '../email/templates.js';
import { baseFooterLinks, emailAccountContext, sendEmail } from '../email/send.js';
import type { SendOutcome } from '../email/send.js';
import type { Config } from '../config.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function sendVerificationEmail(
  cfg: Config,
  to: string,
  code: string,
  linkToken: string,
  purpose: 'register' | 'login',
): Promise<SendOutcome> {
  const account = await findAccountByEmail(to);
  const links = account
    ? (await emailAccountContext(cfg, account.id)).links
    : baseFooterLinks(cfg);
  const link = `${cfg.counterOrigin}/verify?t=${encodeURIComponent(linkToken)}`;
  return sendEmail(cfg, {
    to,
    accountId: account?.id ?? null,
    template: 'verification',
    kind: 'transactional',
    dedupeKey: `verification:${sha(linkToken).slice(0, 32)}`,
    content: renderVerification({ code, link, purpose }, links),
  });
}

/**
 * Something is waiting on this person's own page. A NOTICE: no link, no
 * button, and the one pipeline holds it back unless email is how they hear
 * about things. Their assistant knows what is waiting and hands them the link
 * to it.
 */
export async function sendApprovalEmail(
  cfg: Config,
  to: string,
  accountId: string,
  dedupeOn: string,
  summary?: string,
): Promise<SendOutcome> {
  const ctx = await emailAccountContext(cfg, accountId);
  return sendEmail(cfg, {
    to,
    accountId,
    template: 'approval',
    kind: 'bulk',
    dedupeKey: `approval:${dedupeOn}`,
    content: renderApproval(
      { summary: ctx.blind ? undefined : summary, blind: ctx.blind },
      ctx.links,
    ),
  });
}

export async function sendKillSwitchEmail(
  cfg: Config,
  to: string,
  accountId: string,
  on: boolean,
): Promise<SendOutcome> {
  const ctx = await emailAccountContext(cfg, accountId);
  return sendEmail(cfg, {
    to,
    accountId,
    template: on ? 'kill-switch-on' : 'kill-switch-off',
    kind: 'transactional',
    // KEYED ON THE STATE, NOT THE MOMENT (2026-09-17 audit). With Date.now()
    // in it every key was unique, so the dedupe deduplicated nothing and ten
    // taps on the brake were ten emails to the person who just pressed it.
    //
    // The key is the account, the direction, and the day. Not the account and
    // the direction alone: a successful send holds its key forever
    // (src/email/send.ts), so a bare key would mean somebody who paused
    // everything in March is told nothing when they pause everything again in
    // September — and this email is a security notice, which has to arrive the
    // second time as much as the first. The day is the smallest bucket that
    // makes a run of taps one email while leaving a genuine pause next month
    // its own.
    dedupeKey: `kill-${on ? 'on' : 'off'}:${accountId}:${new Date().toISOString().slice(0, 10)}`,
    content: renderKillSwitch({ on, counterUrl: `${cfg.counterOrigin}/` }, ctx.links),
  });
}

export async function sendSecurityNoticeEmail(
  cfg: Config,
  to: string,
  accountId: string,
  event: SecurityNoticeEvent,
  agentName?: string,
): Promise<SendOutcome> {
  const ctx = await emailAccountContext(cfg, accountId);
  return sendEmail(cfg, {
    to,
    accountId,
    template: `security-${event}`,
    kind: 'transactional',
    dedupeKey: `security:${event}:${accountId}:${Date.now()}`,
    content: renderSecurityNotice(
      {
        event,
        agentName: ctx.blind ? undefined : agentName,
        counterUrl: `${cfg.counterOrigin}/`,
      },
      ctx.links,
    ),
  });
}

/**
 * A card came back from screening rejected. The person's own card, their own
 * reason — so the non-blind copy carries the category label and the plain
 * words, and blind mode strips both to a pointer.
 *
 * TRANSACTIONAL by class: the card is off the board until they change it, so
 * it goes out whether or not they have digests turned down. The one pipeline
 * still honours the suppression flags (a hard-bounced address gets nothing;
 * complaint suppression only withholds bulk).
 *
 * DE-DUPE: keyed on the card plus the moment the rejection was recorded, so
 * one rejection event sends once however many times its queue message is
 * redelivered, while a later re-screen that rejects again does send again.
 */
export async function sendScreeningRejectedEmail(
  cfg: Config,
  to: string,
  accountId: string,
  input: { cardId: string; rejectedAt: string; categoryLabel?: string; reason: string },
): Promise<SendOutcome> {
  const ctx = await emailAccountContext(cfg, accountId);
  return sendEmail(cfg, {
    to,
    accountId,
    template: 'card-screening-rejected',
    kind: 'transactional',
    dedupeKey: `card-screening-rejected:${input.cardId}:${input.rejectedAt}`,
    content: renderScreeningRejected(
      {
        categoryLabel: ctx.blind ? undefined : input.categoryLabel,
        reason: input.reason,
        blind: ctx.blind,
      },
      ctx.links,
    ),
  });
}

/**
 * A figure landed on this person's main page and their assistant is not
 * the sort that will bring it to them (hears_via = 'email'). The caller checks
 * that; this only renders and sends.
 *
 * TRANSACTIONAL by class: a number waiting for an answer is the switchboard
 * doing the one job it was asked to do, and it expires. De-duped on the offer,
 * so one figure raises one mail however many times its caller runs.
 */
export async function sendOfferOnTheTableEmail(
  cfg: Config,
  to: string,
  accountId: string,
  input: { offerId: string; matchId: string; amount: number; ccy: string; categoryLabel?: string; side: 'want' | 'have' },
): Promise<SendOutcome> {
  const ctx = await emailAccountContext(cfg, accountId);
  return sendEmail(cfg, {
    to,
    accountId,
    template: 'offer-on-the-table',
    kind: 'transactional',
    dedupeKey: `offer-on-the-table:${input.offerId}:${accountId}`,
    content: renderOfferOnTheTable(
      {
        amount: input.amount,
        ccy: input.ccy,
        categoryLabel: ctx.blind ? undefined : input.categoryLabel,
        blind: ctx.blind,
        side: input.side,
      },
      ctx.links,
    ),
  });
}

/**
 * The other human accepted this person's figure.
 *
 * It used to go out however they heard about the switchboard. Under the notice
 * rule (2026-09-11) it is a notice like the rest, so the one pipeline holds it
 * back when their own assistant is the one bringing them the news — which it
 * is, on the next sweep, carrying the same sentence in its own voice.
 *
 * Since 2 October 2026 the ordinary mail on an acceptance is the record, to
 * both people (sendReceiptEmail below). This one is what is left for an
 * acceptance no record could be built for.
 */
export async function sendDealAgreedEmail(
  cfg: Config,
  to: string,
  accountId: string,
  input: { offerId: string; matchId: string; amount: number; ccy: string; categoryLabel?: string; side: 'want' | 'have' },
): Promise<SendOutcome> {
  const ctx = await emailAccountContext(cfg, accountId);
  return sendEmail(cfg, {
    to,
    accountId,
    template: 'deal-agreed',
    kind: 'transactional',
    dedupeKey: `deal-agreed:${input.offerId}:${accountId}`,
    content: renderDealAgreed(
      {
        amount: input.amount,
        ccy: input.ccy,
        categoryLabel: ctx.blind ? undefined : input.categoryLabel,
        blind: ctx.blind,
        side: input.side,
      },
      ctx.links,
    ),
  });
}

/**
 * The record of a deal, to ONE of the two people. The caller sends it to both
 * (domain/offers.ts), with the same block and the same fingerprint each time.
 *
 * It is not a notice: it is the fourth kind of mail that is not (email/
 * templates.ts), and it is theirs to keep and to show. EVERYONE GETS IT
 * (decided 2 October 2026). It goes out when their assistant is the one who
 * brings them the news, and it goes out whole when the account has blind mode
 * on: a setting about how much a notice says is no reason to leave somebody
 * without the evidence of what they agreed. So blind mode is not read here at
 * all; the account context is asked only for the footer links.
 *
 * De-duped on the offer and the account, so one acceptance raises one record
 * per person however many times its caller runs.
 *
 * Every line of the block is handed to the pipeline as verbatim: they are the
 * record, parts of them are other people's own words, and the voice lint is
 * about the sentences around them.
 */
export async function sendReceiptEmail(
  cfg: Config,
  to: string,
  accountId: string,
  input: { offerId: string; block: string; fingerprint: string },
): Promise<SendOutcome> {
  const ctx = await emailAccountContext(cfg, accountId);
  return sendEmail(cfg, {
    to,
    accountId,
    template: 'receipt',
    kind: 'transactional',
    dedupeKey: `receipt:${input.offerId}:${accountId}`,
    content: renderReceipt({ block: input.block, fingerprint: input.fingerprint }, ctx.links),
    verbatim: input.block.split('\n'),
  });
}

// ---------------------------------------------------------------------------
// Settlement lifecycle emails (phase 1.A safe hands). settlement-proposed
// carries the single-use approval link; the update set follows the held
// payment. Blind mode strips everything beyond the pointer.
// ---------------------------------------------------------------------------
export interface SettlementEmailInput {
  to: string;
  accountId: string;
  template: 'settlement-proposed' | SettlementUpdateEvent;
  settlementId: string;
  /** settlement-proposed only: category-level summary (blind mode strips it). */
  summary?: string;
  /** update templates only: which side this recipient is on. */
  role?: 'buyer' | 'seller';
  /** handover templates only: when the held payment releases on its own. */
  deadline?: Date;
  /** released only: true when the clock released it rather than the buyer. */
  auto?: boolean;
}

export async function sendSettlementEmail(
  cfg: Config,
  input: SettlementEmailInput,
): Promise<SendOutcome> {
  const ctx = await emailAccountContext(cfg, input.accountId);
  if (input.template === 'settlement-proposed') {
    return sendEmail(cfg, {
      to: input.to,
      accountId: input.accountId,
      template: 'settlement-proposed',
      kind: 'bulk',
      dedupeKey: `settlement-proposed:${input.settlementId}:${input.accountId}`,
      content: renderSettlementProposed(
        { summary: ctx.blind ? undefined : input.summary, blind: ctx.blind },
        ctx.links,
      ),
    });
  }
  if (!input.role) throw new Error('settlement update email requires the recipient role');
  return sendEmail(cfg, {
    to: input.to,
    accountId: input.accountId,
    template: `settlement-${input.template}`,
    kind: 'bulk',
    dedupeKey: `settlement:${input.template}:${input.settlementId}:${input.accountId}`,
    content: renderSettlementUpdate(
      {
        event: input.template,
        role: input.role,
        blind: ctx.blind,
        deadline: input.deadline,
        auto: input.auto,
      },
      ctx.links,
    ),
  });
}

/**
 * The one email a deleted account is sent, to the address it held, before
 * that address is erased. Transactional and exempt: it goes whatever hears_via
 * says. Keyed on the account alone, so it is sent once, however many times the
 * deletion is run.
 */
export async function sendAccountDeletedEmail(
  cfg: Config,
  to: string,
  accountId: string,
): Promise<SendOutcome> {
  return sendEmail(cfg, {
    to,
    accountId,
    template: 'account-deleted',
    kind: 'transactional',
    dedupeKey: `account-deleted:${accountId}`,
    content: renderAccountDeleted(baseFooterLinks(cfg)),
  });
}
