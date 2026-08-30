/**
 * SES event consumer (phase 0.E): configuration set -> SNS -> SQS -> here.
 *
 *  - PERMANENT bounce: the address is flagged unreachable
 *    (accounts.email_unreachable_at). Every send to the account is withheld
 *    (send.ts) until the human re-verifies the address at the counter; the
 *    counter dashboard shows the re-verify banner.
 *  - Complaint: ALL non-transactional mail for the account is suppressed
 *    (accounts.email_complaint_suppressed_at) until the human re-enables it
 *    from the counter settings page.
 *  - Every event (bounce, complaint, delivery, reject, ...) is logged to
 *    email_events with the raw payload.
 *
 * SNS subscription uses raw message delivery, so the SQS body IS the SES
 * event JSON. An SNS envelope (Type: Notification) is unwrapped if one ever
 * appears, so a subscription-attribute regression cannot silently drop
 * suppression events.
 */
import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { emailHash } from '../domain/accounts.js';
import type { Config } from '../config.js';

interface SesEvent {
  eventType?: string;
  notificationType?: string; // legacy field name, same values
  mail?: { messageId?: string; destination?: string[] };
  bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress?: string }[] };
}

async function accountIdForEmail(email: string): Promise<string | null> {
  const r = await getPool().query(`SELECT id FROM accounts WHERE email_hash = $1`, [
    emailHash(email),
  ]);
  return r.rows[0]?.id ?? null;
}

export async function processSesEvent(raw: string, log: (msg: string, extra?: any) => void): Promise<void> {
  let ev: SesEvent = JSON.parse(raw);
  if ((ev as any).Type === 'Notification' && typeof (ev as any).Message === 'string') {
    ev = JSON.parse((ev as any).Message);
  }
  const eventType = (ev.eventType ?? ev.notificationType ?? 'unknown').toLowerCase();
  const messageId = ev.mail?.messageId ?? null;
  const destination = ev.mail?.destination ?? [];

  const affected: { email: string; accountId: string | null }[] = [];
  const recipients =
    eventType === 'bounce'
      ? (ev.bounce?.bouncedRecipients ?? []).map((r) => r.emailAddress).filter(Boolean)
      : eventType === 'complaint'
        ? (ev.complaint?.complainedRecipients ?? []).map((r) => r.emailAddress).filter(Boolean)
        : destination;
  for (const email of recipients as string[]) {
    affected.push({ email, accountId: await accountIdForEmail(email) });
  }

  const pool = getPool();
  await pool.query(
    `INSERT INTO email_events (event_type, ses_message_id, account_id, recipients, raw)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      eventType,
      messageId,
      affected.find((a) => a.accountId)?.accountId ?? null,
      JSON.stringify(destination),
      raw,
    ],
  );

  if (eventType === 'bounce' && ev.bounce?.bounceType === 'Permanent') {
    for (const a of affected) {
      if (!a.accountId) continue;
      await pool.query(
        `UPDATE accounts SET email_unreachable_at = now() WHERE id = $1 AND email_unreachable_at IS NULL`,
        [a.accountId],
      );
      log('email-events: permanent bounce -> address flagged unreachable', {
        account_id: a.accountId,
        ses_message_id: messageId,
      });
    }
  } else if (eventType === 'complaint') {
    for (const a of affected) {
      if (!a.accountId) continue;
      await pool.query(
        `UPDATE accounts SET email_complaint_suppressed_at = now()
         WHERE id = $1 AND email_complaint_suppressed_at IS NULL`,
        [a.accountId],
      );
      log('email-events: complaint -> non-transactional mail suppressed', {
        account_id: a.accountId,
        ses_message_id: messageId,
      });
    }
  }
}

export function startEmailEventsWorker(cfg: Config, log: (msg: string, extra?: any) => void) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const r = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: cfg.emailEventsQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 60,
          }),
        );
        for (const msg of r.Messages ?? []) {
          try {
            await processSesEvent(msg.Body ?? '{}', log);
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: cfg.emailEventsQueueUrl,
                ReceiptHandle: msg.ReceiptHandle!,
              }),
            );
          } catch (e: any) {
            log('email-events: message failed (will redeliver)', { error: e?.message });
          }
        }
      } catch (e: any) {
        log('email-events: receive loop error', { error: e?.message });
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
