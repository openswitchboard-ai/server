# DELIVERABILITY.md — email runbook (phase 0.E)

State of the world (2026-08): domain identity `openswitchboard.ai` VERIFIED in
SES us-east-1 (DKIM green, custom MAIL FROM `mail.openswitchboard.ai`, DMARC
`p=quarantine`). The account is in the **SES sandbox**; production access is
requested and pending. All sends carry the `osb-<env>-email` configuration
set, From `OpenSwitchboard <board@openswitchboard.ai>`, reply-to
`info@openswitchboard.ai`, and RFC 8058 one-click List-Unsubscribe headers
(mailto + URL) on every account-bound message.

## Warmup plan (run this when production access lands)

Volume is tiny at launch, which is itself the best warmup. Still, do it
deliberately:

1. **Week 1**: transactional only (verification, approvals, kill-switch,
   security). These have the highest engagement and the lowest complaint
   surface. Cap: whatever real signups produce; no digests.
2. **Week 2**: enable match summons for real accounts (they default to
   `immediate`). Watch the SES reputation dashboard daily.
3. **Week 3+**: digests and renewals flow on their schedules (daily 21:00
   UTC / weekly Sunday 21:00 UTC / renewal sweep 20:30 UTC).
4. Keep total daily volume under ~200 for the first month unless reputation
   metrics are clean (see thresholds), then let it grow organically. There is
   no purchased list and no cold outreach anywhere in the system, so ramp
   risk is inherently low.

## Thresholds (check the SES reputation dashboard + `email_events`)

- **Bounce rate**: alarm in your head at 2%, act at 3% (SES review territory
  starts ~5%). Every hard bounce already auto-suppresses the account
  (`accounts.email_unreachable_at`), so a rising rate means a systemic
  problem (DNS, a bad import, a bug), never routine attrition.
- **Complaint rate**: act at 0.05% (SES review ~0.1%). One complaint
  auto-suppresses all non-transactional mail for that account.
- Both rates are computed by SES over rolling windows; the raw events are in
  the `email_events` table and the `osb-<env>-emailevents` queue's DLQ holds
  anything the consumer failed on five times.

## When placement dips (mail lands in spam / disappears)

Work the list in order; check off before moving on:

1. DNS: confirm all three SES DKIM CNAMEs (`<token>._domainkey.openswitchboard.ai`),
   the MAIL FROM MX + SPF TXT on `mail.openswitchboard.ai`, and the DMARC
   record (`_dmarc.openswitchboard.ai`, `p=quarantine`) still resolve
   (Cloudflare is authoritative; an accidental proxy toggle or record edit is
   the usual suspect).
2. SES console → verified identities → openswitchboard.ai: DKIM status,
   MAIL FROM status both green.
3. SES reputation dashboard: bounce + complaint rates against the thresholds
   above; account status not "under review".
4. `SELECT event_type, count(*) FROM email_events WHERE created_at > now() -
   interval '7 days' GROUP BY 1;` — a delivery/bounce mix shift pinpoints
   when it started.
5. Send the full sample set to a Gmail, an Outlook and an iCloud mailbox you
   control (`npx tsx scripts/send-samples.ts --to you@example.com`) and read
   the raw headers of what arrives: `Authentication-Results` must show
   `dkim=pass`, `spf=pass` (on mail.openswitchboard.ai), `dmarc=pass`.
6. Check content drift: new template copy that smells like marketing gets
   filtered. The banned-phrase lint catches voice; nothing catches a wall of
   links — keep emails content-thin (that is the product's own rule anyway).
7. Google Postmaster Tools (register openswitchboard.ai when volume justifies
   it) for Gmail-specific reputation.

## Inbox-placement gate (10/10) — PENDING SES PRODUCTION ACCESS

The 0.E release gate "10/10 inbox placement across Gmail/Outlook/iCloud"
cannot run from the sandbox (only verified recipients accept mail). The exact
procedure, to run the day production access is granted:

1. `npx tsx scripts/send-samples.ts --to <gmail>` and the same for an
   Outlook.com and an iCloud address (3 mailboxes you control), prefix stays
   `[SAMPLE]`.
2. Score: each of the ~10 sample messages must land in the PRIMARY inbox
   (Gmail: Primary tab; Outlook: Focused; iCloud: Inbox) — 10/10 per
   provider. A "Promotions"-tab landing counts as a miss.
3. For any miss: pull full headers, verify dkim/spf/dmarc all pass, then
   check items 5–6 above; fix, re-send the missing template, re-score.
4. Record the scores in the phase report; re-run quarterly and after any
   template redesign.

## Cost

SES $0.10/1k emails, SNS→SQS effectively free at this volume. The whole 0.E
pipeline rounds to $0/month until volume is five digits monthly.
