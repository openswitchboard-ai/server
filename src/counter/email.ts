/**
 * Transactional email senders (verification, approval, kill switch, security
 * notices). All rendering lives in email/templates.ts; every send goes
 * through the one pipeline in email/send.ts (idempotency, suppression,
 * banned-phrase lint, configuration set, RFC 8058 headers, sandbox note).
 */
import { createHash } from 'node:crypto';
import { findAccountByEmail } from '../domain/accounts.js';
import {
  renderApproval,
  renderDealAgreed,
  renderKillSwitch,
  renderOfferOnTheTable,
  renderScreeningRejected,
  renderSecurityNotice,
  renderSettlementProposed,
  renderSettlementUpdate,
  renderVerification,
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
    dedupeKey: `kill-${on ? 'on' : 'off'}:${accountId}:${Date.now()}`,
    content: renderKillSwitch({ on, counterUrl: `${cfg.counterOrigin}/` }, ctx.links),
  });
}

export async function sendSecurityNoticeEmail(
  cfg: Config,
  to: string,
  accountId: string,
  event: 'agent-authorized' | 'pin-changed' | 'agent-key-created',
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
 * A figure landed on this person's approval page and their assistant is not
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
  input: { offerId: string; matchId: string; amount: number; ccy: string; categoryLabel?: string },
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
      },
      ctx.links,
    ),
  });
}

/**
 * The other human accepted this person's figure. It goes however they hear
 * about the switchboard: an agreed price ends the switchboard's part, and a
 * person is owed that from the switchboard as well as from their agent.
 */
export async function sendDealAgreedEmail(
  cfg: Config,
  to: string,
  accountId: string,
  input: { offerId: string; matchId: string; amount: number; ccy: string; categoryLabel?: string },
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
      },
      ctx.links,
    ),
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
