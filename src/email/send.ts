/**
 * The one email send pipeline (phase 0.E). Every outgoing message — the 0.D
 * transactional set included — goes through sendEmail(), which enforces:
 *
 *  - IDEMPOTENCY: a send happens only when this call wins the INSERT of its
 *    dedupe_key into email_sends (or reclaims a terminally 'failed' row — an
 *    SES quota/outage failure must stay retryable — or a 'sending' row left
 *    stale by a crash mid-send). A redelivered queue job or double-submitted
 *    request can never double-send.
 *  - SUPPRESSION: a permanent bounce (email_unreachable_at) withholds every
 *    send except address re-verification; a spam complaint
 *    (email_complaint_suppressed_at) withholds all non-transactional mail
 *    until the human re-enables it from the counter.
 *  - VOICE: the banned-phrase lint runs on every subject + body in every env.
 *  - HEADERS: SES configuration set (bounce/complaint events), proper From,
 *    reply-to, RFC 8058 one-click List-Unsubscribe (mailto + URL) whenever
 *    the recipient has an account.
 *
 * SES SANDBOX NOTE (carried from 0.D): the account is in the SES sandbox
 * until production access lands. In DEV ONLY a MessageRejected for an
 * unverified recipient is logged loudly, recorded in the send log as
 * 'sandbox-rejected', and tolerated — that is SES's real sandbox behaviour
 * and the dev harness reads tokens from the test DB instead of an inbox.
 * In prod any send failure is a hard failure.
 */
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { sesv2 } from '../aws.js';
import { getPool } from '../db.js';
import { emailHash } from '../domain/accounts.js';
import { assertEmailCopyClean } from './lint.js';
import { signEmailToken } from './tokens.js';
import type { EmailContent, FooterLinks } from './templates.js';
import type { Config } from '../config.js';

export type EmailKind = 'transactional' | 'bulk';

export interface SendEmailInput {
  to: string;
  /** Account the mail belongs to (undefined only for pre-account
   *  registration verifications). */
  accountId?: string | null;
  /** Template name for the send log (e.g. 'verification', 'summons'). */
  template: string;
  kind: EmailKind;
  /** Idempotency key — unique per logical send event. */
  dedupeKey: string;
  content: EmailContent;
  /** '[SAMPLE] ' for the visual-review set. */
  subjectPrefix?: string;
}

export type SendStatus =
  | 'sent'
  | 'sandbox-rejected'
  | 'suppressed'
  | 'duplicate'
  | 'failed';

/** Row states in email_sends. 'sending' marks an in-flight attempt; 'failed'
 *  is terminal for the attempt but reclaimable by a retry (see recordSend). */
type RowStatus = 'sent' | 'sandbox-rejected' | 'suppressed' | 'failed' | 'sending';

export interface SendOutcome {
  status: SendStatus;
  sesMessageId?: string;
  detail?: string;
}

/** Per-account email context: footer links + suppression + preferences. */
export interface EmailAccountContext {
  blind: boolean;
  freqMatches: 'immediate' | 'daily' | 'weekly' | 'off';
  freqDigests: 'immediate' | 'daily' | 'weekly' | 'off';
  unreachable: boolean;
  complaintSuppressed: boolean;
  links: FooterLinks;
}

export function baseFooterLinks(cfg: Config): FooterLinks {
  return {
    settingsUrl: `${cfg.counterOrigin}/settings`,
    ledgerUrl: `${cfg.counterOrigin}/ledger`,
  };
}

export async function emailAccountContext(
  cfg: Config,
  accountId: string,
): Promise<EmailAccountContext> {
  const r = await getPool().query(
    `SELECT blind_mode, email_freq_matches, email_freq_digests,
            email_unreachable_at, email_complaint_suppressed_at
     FROM accounts WHERE id = $1`,
    [accountId],
  );
  const a = r.rows[0];
  if (!a) throw new Error(`emailAccountContext: no account ${accountId}`);
  const links = baseFooterLinks(cfg);
  links.unsubUrl = `${cfg.counterOrigin}/email/unsub?t=${encodeURIComponent(
    signEmailToken(accountId, 'unsubscribe'),
  )}`;
  return {
    blind: !!a.blind_mode,
    freqMatches: a.email_freq_matches,
    freqDigests: a.email_freq_digests,
    unreachable: !!a.email_unreachable_at,
    complaintSuppressed: !!a.email_complaint_suppressed_at,
    links,
  };
}

async function recordSend(
  input: SendEmailInput,
  status: RowStatus,
  detail?: string,
): Promise<boolean> {
  // The INSERT is the idempotency lock. A terminal 'failed' row (SES quota /
  // throttle / outage) is RECLAIMED so the next tick can retry the send —
  // otherwise a throttled email consumes its dedupe key forever and is
  // silently lost. A 'sending' row STALE by 15+ minutes is reclaimed too: a
  // process that crashed mid-send would otherwise eat its dedupe key forever.
  // Fresh 'sending' and successful rows never reclaim, so a concurrently
  // redelivered job still reads 'duplicate' and cannot double-send. The
  // reclaim refreshes created_at — the row now records the new attempt, and a
  // second crash gets the full staleness window again. (This SQL is exercised
  // by the integration suite; the unit tests mock the pool.)
  const r = await getPool().query(
    `INSERT INTO email_sends (dedupe_key, account_id, email_hash, template, kind, subject, status, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET status = EXCLUDED.status, detail = EXCLUDED.detail, created_at = now()
       WHERE email_sends.status = 'failed'
          OR (email_sends.status = 'sending'
              AND email_sends.created_at < now() - interval '15 minutes')
     RETURNING id`,
    [
      input.dedupeKey,
      input.accountId ?? null,
      emailHash(input.to),
      input.template,
      input.kind,
      (input.subjectPrefix ?? '') + input.content.subject,
      status,
      detail ?? null,
    ],
  );
  return !!r.rowCount;
}

async function updateSend(
  dedupeKey: string,
  status: RowStatus,
  sesMessageId?: string,
  detail?: string,
): Promise<void> {
  await getPool().query(
    `UPDATE email_sends SET status = $2, ses_message_id = COALESCE($3, ses_message_id),
            detail = $4
     WHERE dedupe_key = $1`,
    [dedupeKey, status, sesMessageId ?? null, detail ?? null],
  );
}

// ---------------------------------------------------------------------------
// SES rate pacing. The sandbox caps the account at 1 send/second; a digest
// tick's back-to-back loop trips "Maximum sending rate exceeded" without
// spacing. Serialise SES calls in this process with a minimum gap, and give a
// throttle that still slips through (another task sending concurrently) one
// spaced retry. Daily-quota failures are NOT retried here — they are terminal
// for the attempt and land as a reclaimable 'failed' row.
// ---------------------------------------------------------------------------
const SES_MIN_SEND_GAP_MS = 1100;
let sesGate: Promise<void> = Promise.resolve();
function paceSes(): Promise<void> {
  const turn = sesGate;
  sesGate = turn.then(() => new Promise((r) => setTimeout(r, SES_MIN_SEND_GAP_MS)));
  return turn;
}
// SESv2 raises TooManyRequestsException for the per-second throttle AND the
// daily quota; only the former is worth a quick retry.
const isSesThrottle = (e: any) => /sending rate exceeded/i.test(String(e?.message ?? ''));

export async function sendEmail(cfg: Config, input: SendEmailInput): Promise<SendOutcome> {
  // VOICE gate: banned phrases never leave the building, any env.
  const context = `template=${input.template}`;
  assertEmailCopyClean(input.content.subject, context);
  assertEmailCopyClean(input.content.text, context);
  assertEmailCopyClean(input.content.html, context);

  // Suppression gates (need an account to have state).
  if (input.accountId) {
    const r = await getPool().query(
      `SELECT email_unreachable_at, email_complaint_suppressed_at FROM accounts WHERE id = $1`,
      [input.accountId],
    );
    const a = r.rows[0];
    if (a?.email_unreachable_at && input.template !== 'verification') {
      const won = await recordSend(input, 'suppressed', 'address flagged unreachable (hard bounce)');
      return { status: won ? 'suppressed' : 'duplicate' };
    }
    if (a?.email_complaint_suppressed_at && input.kind === 'bulk') {
      const won = await recordSend(input, 'suppressed', 'complaint suppression (re-enable at the counter)');
      return { status: won ? 'suppressed' : 'duplicate' };
    }
  }

  // Idempotency: the INSERT (or reclaim of a terminal 'failed' row) is the
  // lock. Record as 'sending' first; flip to a terminal state after SES
  // answers, so a crash mid-send reads truthfully.
  const won = await recordSend(input, 'sending', 'send in flight');
  if (!won) return { status: 'duplicate' };

  const headers: { Name: string; Value: string }[] = [];
  if (input.accountId) {
    const unsubToken = signEmailToken(input.accountId, 'unsubscribe');
    const unsubUrl = `${cfg.counterOrigin}/email/unsub?t=${encodeURIComponent(unsubToken)}`;
    headers.push(
      {
        Name: 'List-Unsubscribe',
        Value: `<mailto:unsubscribe@openswitchboard.ai?subject=unsubscribe>, <${unsubUrl}>`,
      },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    );
  }

  const command = new SendEmailCommand({
    FromEmailAddress: cfg.sesFrom,
    ReplyToAddresses: [cfg.sesReplyTo],
    Destination: { ToAddresses: [input.to] },
    ConfigurationSetName: cfg.sesConfigurationSet,
    Content: {
      Simple: {
        Subject: {
          Data: (input.subjectPrefix ?? '') + input.content.subject,
          Charset: 'UTF-8',
        },
        Body: {
          Text: { Data: input.content.text, Charset: 'UTF-8' },
          Html: { Data: input.content.html, Charset: 'UTF-8' },
        },
        Headers: headers.length ? headers : undefined,
      },
    },
  });

  try {
    let res;
    for (let attempt = 0; ; attempt++) {
      await paceSes();
      try {
        res = await sesv2.send(command);
        break;
      } catch (e: any) {
        if (attempt < 1 && isSesThrottle(e)) continue; // one spaced retry
        throw e;
      }
    }
    await updateSend(input.dedupeKey, 'sent', res.MessageId);
    return { status: 'sent', sesMessageId: res.MessageId };
  } catch (e: any) {
    const sandboxRejected =
      e?.name === 'MessageRejected' && /not verified|sandbox/i.test(String(e?.message ?? ''));
    if (cfg.envName === 'dev' && sandboxRejected) {
      // eslint-disable-next-line no-console
      console.error(
        `SES SANDBOX: send to unverified recipient rejected (dev tolerated; see email/send.ts): ` +
          `template=${input.template} ${e.message}`,
      );
      await updateSend(input.dedupeKey, 'sandbox-rejected', undefined, String(e.message));
      return { status: 'sandbox-rejected', detail: String(e.message) };
    }
    await updateSend(input.dedupeKey, 'failed', undefined, String(e?.message ?? e));
    throw e;
  }
}
