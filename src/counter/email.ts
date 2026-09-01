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
  renderKillSwitch,
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
  const link = `${cfg.counterOrigin}/counter/verify?t=${encodeURIComponent(linkToken)}`;
  return sendEmail(cfg, {
    to,
    accountId: account?.id ?? null,
    template: 'verification',
    kind: 'transactional',
    dedupeKey: `verification:${sha(linkToken).slice(0, 32)}`,
    content: renderVerification({ code, link, purpose }, links),
  });
}

export async function sendApprovalEmail(
  cfg: Config,
  to: string,
  accountId: string,
  linkId: string,
  linkToken: string,
  summary?: string,
): Promise<SendOutcome> {
  const ctx = await emailAccountContext(cfg, accountId);
  const link = `${cfg.counterOrigin}/counter/a/${encodeURIComponent(linkToken)}`;
  return sendEmail(cfg, {
    to,
    accountId,
    template: 'approval',
    kind: 'transactional',
    dedupeKey: `approval:${linkId}`,
    content: renderApproval(
      {
        link,
        summary: ctx.blind ? undefined : summary,
        blind: ctx.blind,
        counterUrl: `${cfg.counterOrigin}/counter`,
      },
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
    content: renderKillSwitch({ on, counterUrl: `${cfg.counterOrigin}/counter` }, ctx.links),
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
        counterUrl: `${cfg.counterOrigin}/counter`,
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
        editUrl: `${cfg.counterOrigin}/counter/ledger/${encodeURIComponent(input.cardId)}/edit`,
        blind: ctx.blind,
        counterUrl: `${cfg.counterOrigin}/counter`,
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
  /** settlement-proposed only: single-use approval link token + row id. */
  linkToken?: string;
  linkId?: string;
  /** settlement-proposed only: category-level summary (blind mode strips it). */
  summary?: string;
  /** update templates only: which side this recipient is on. */
  role?: 'buyer' | 'seller';
}

export async function sendSettlementEmail(
  cfg: Config,
  input: SettlementEmailInput,
): Promise<SendOutcome> {
  const ctx = await emailAccountContext(cfg, input.accountId);
  const counterUrl = `${cfg.counterOrigin}/counter`;
  if (input.template === 'settlement-proposed') {
    if (!input.linkToken || !input.linkId) {
      throw new Error('settlement-proposed email requires the approval link');
    }
    const link = `${cfg.counterOrigin}/counter/a/${encodeURIComponent(input.linkToken)}`;
    return sendEmail(cfg, {
      to: input.to,
      accountId: input.accountId,
      template: 'settlement-proposed',
      kind: 'transactional',
      dedupeKey: `settlement-proposed:${input.linkId}`,
      content: renderSettlementProposed(
        { link, summary: ctx.blind ? undefined : input.summary, blind: ctx.blind, counterUrl },
        ctx.links,
      ),
    });
  }
  if (!input.role) throw new Error('settlement update email requires the recipient role');
  return sendEmail(cfg, {
    to: input.to,
    accountId: input.accountId,
    template: `settlement-${input.template}`,
    kind: 'transactional',
    dedupeKey: `settlement:${input.template}:${input.settlementId}:${input.accountId}`,
    content: renderSettlementUpdate(
      {
        event: input.template,
        role: input.role,
        blind: ctx.blind,
        settlementUrl: `${cfg.counterOrigin}/counter/settlements/${input.settlementId}`,
        counterUrl,
      },
      ctx.links,
    ),
  });
}
