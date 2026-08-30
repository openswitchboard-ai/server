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
  renderSecurityNotice,
  renderVerification,
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
  event: 'agent-authorized' | 'pin-changed',
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
