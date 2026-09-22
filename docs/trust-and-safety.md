# Trust and safety: one intake pipe

Design, 2026-09-17; built the same day, steps 1–8 (step 9, PhotoDNA, pending). Raised by Lachlan alongside the decision to open
the catalogue (see `taxonomy-question.md`): if anyone can post anything in plain
words, the switchboard needs a real answer to abuse, to reporting, and to a
lawful request for what it holds.

**His framing, in his words:** "Need to ability to report others using their
unlocked AIs trying to do nefarious things. Thinking child grooming or any other
illegal activities that large tech have to consider. How do we stop or report
those things and if law enforcement need detail on what is in the OSB, how
should we provide."

## Where we stand today

| Need | Today |
|---|---|
| Report someone | Nothing. No tool, no page, no abuse contact. |
| Evidence behind a report | Nothing. Messages are deleted on delivery (`008_channel.sql`). Only postings persist. |
| Screening of conversations | Money-figure check only. The model screen runs on postings alone. |
| Prohibited things | Category-path glob only (`denylist.ts`). A thing under a made-up name is not checked for what it is. |
| Photos | EXIF stripped in the browser; nothing looks at the picture. Dev only. |
| Age | 18+ tickbox at onboarding. Keep. |
| Suspension | Does not exist. A `bad` verdict mutes one pairing. |
| Law enforcement | The privacy page promises two keyholders and a transparency report. Neither is a mechanism yet. |

Four separate doors (postings, messages, photos, categories), each with its own
checks and its own retention story. Reports, retention, suspension and export
would have to be bolted onto all four.

## The change: everything goes through one pipe

Anything a person hands the switchboard for another person to see passes
through the same path: a posting, an amendment, a message, a photo, offer
wording, the shared first name and suburb.

```
intake  →  checks  →  verdict  →  ledger  →  deliver
```

- **Intake** normalises whatever arrived into one shape: who sent it, which
  door, the text or the object, the introduction it belongs to.
- **Checks** are plug-ins, one file each, each answering pass / hold / refuse
  with a reason code. Adding a check is one file, not four edits.
- **Verdict** folds the checks into one of three: **pass**, **hold** for
  review, **refuse** with plain words back to the sender's assistant. Same
  shape at every door, so the assistant-facing answer is uniform.
- **Ledger** keeps every item that passed, encrypted under a separate safety
  key, for thirty days, then deletes it. This is the one new store.
- **Deliver** is unchanged. Suspension is checked here as well as at intake.

The whitepaper then carries one true sentence: *nothing reaches another
person that the switchboard has not looked at and cannot account for.*

## The checks

| Check | What it catches | How | Runs on |
|---|---|---|---|
| Prohibited, by meaning | Weapons, drugs, prescription meds, live animals, wildlife, sexual services, anything illegal, regardless of category name | Model classifier against the deny list's reason codes; the path glob stays as the cheap first pass | Postings, amendments |
| PII | Names, emails, phones, street addresses, handles, coordinates | Existing model screen | Postings, messages |
| Money figures | Digits, symbols, spelled amounts, price phrasing | Existing `moneyInWords` | Messages |
| Injection | Text aimed at an AI reader | Existing model screen | Postings, messages |
| Stolen / recalled markers | Existing | Existing model screen | Postings |
| Sexual content | Nudity and sexual imagery of any kind, and violence, hate symbols and drugs alongside it | Rekognition `DetectModerationLabels` on the uploaded object at the send press, before the other side is told it exists, `MinConfidence` 50. Refused on any of these top-level labels, in both the old and the current taxonomy names: Explicit, Explicit Nudity, Non-Explicit Nudity of Intimate parts and Kissing, Suggestive, Sexual Activity, Swimwear or Underwear, Violence, Visually Disturbing, Graphic Violence Or Gore, Hate Symbols, Drugs & Tobacco, Drugs, Tobacco. Alcohol, Gambling and Rude Gestures are deliberately not refused: a bottle of wine is a thing somebody may lawfully be handing over. A refusal keeps the reason code alone; an error is a hold, never a pass. WHAT HAPPENS TO THE BYTES DEPENDS ON THE FAMILY. A refusal on violence, hate or drugs deletes the object, as before. A refusal on any of the SEXUAL labels does not: the object is copied to `conversation-photos/quarantine/<introduction>/<name>` in the same bucket, the original is deleted, and a `photo_quarantine` row is written (migration 038) — held ninety days, status `held`. The reason is s 474.25 of the Criminal Code (Cth): a host that becomes aware of child abuse material must refer it to the Australian Federal Police, and Rekognition says "Explicit", never "a child". Deleting on sight destroys the referrable thing, fastest in exactly the cases where that is worst. A copy that fails leaves the original where it is and logs `{event:'photo-quarantine-failed', match_id}` — nothing is ever deleted that could not first be copied. The operator gets one line, `{event:'photo-quarantined', quarantine_id, match_id}`, with no key and no label; the sender's assistant reads the same plain sentence either way and nothing about quarantine reaches any user. A person decides with `scripts/safety/quarantine.mts`, which displays and fetches no image: `--cleared` deletes the object, `--referred` marks it and keeps it forever. The daily sweep takes only `cleared` rows past expiry; a `held` row past ninety days is logged as overdue and left alone, and a `referred` row is never swept | Photos |
| Known abuse image | The picture IS one that has already been found, identified and hashed by the organisations that do that work | PhotoDNA, at the send press, BEFORE the moderation call. OpenSwitchboard uses PhotoDNA technology licensed by Microsoft at no cost. The bytes are read out of the bucket and hashed on the task, twice where the picture has a border, so a cropped or letterboxed copy of a known image is caught too; the hashes and nothing else go to Microsoft's match service. A match REFUSES with the same sentence the sexual-label refusal uses, word for word, and behind that sentence: the object is quarantined with `hash_match` set (migration 045), a `safety_reviews` row is opened flagged `known_abuse_image` carrying the service's tracking id, and the sender's account is suspended. This is the only check here that suspends on its own. An error is a hold, never a pass. A deployment without the licensed files or without a subscription key PASSES with the detail `photodna_off` and carries on to the moderation call, and says which half is missing once at boot. The hash is never logged, never stored and never in a row. See "A known-image match" below | Photos |
| Grooming, exploitation, threats | Contact with minors, coercion, moving a child off-platform, sextortion, threats of harm, and a sender who sounds at risk themselves | Model classifier on message text (Haiku, the same client and model the screen uses; the first 2,000 characters; `MESSAGE_SAFETY=off` turns it off for a deployment). Five flags: `minor_involved`, `grooming`, `sexual_exploitation`, `threat`, `self_harm_risk`. Any of them HOLDS, and it can never refuse — and a hold at this door still DELIVERS the message: it is a flag for review, never a stall, because the person waiting for a reply must not be silently ghosted on a fast model's word. The hold opens a `safety_reviews` row (the flag names and the ledger entry id, never the words), holds that introduction's ledger entries ninety days exactly as a report does, and puts one line in front of the operator: `{event:'safety-review', review_id, match_id}`. A model that does not answer is a PASS with a `{event:'message-safety-unavailable'}` warn line — deliberately the opposite of the photo rule, because an outage must not stop every ordinary conversation and the words are in the ledger to be read afterwards. A model that DOES answer, with something that is not a verdict in the shape asked for, is the opposite again: that HOLDS, with `{event:'message-safety-unreadable'}` and a review row carrying the single name `unreadable_verdict`. An outage is an outage; a classifier talked out of classifying is what a successful injection looks like from here, and it must not be spent as a pass. The second-model pass below is not wired to it yet; every hold reaches a person today | Messages |
| Suspended sender or recipient | Nothing in, nothing out | Flag on the account | Every door |

Three of the doors named above were built in step one and left without a
caller. Two now have one (2026-09-17). **`offer_words`**: the note beside a
figure is the same free text a message is, sent between the same two people, so
`proposeOffer` runs the pipe over it and the message classifier stands at that
door alongside the message door — and the note is held to `validateOfferNote`,
the two-hundred-character, no-contact-details, no-angle-brackets rule the
main page had always applied and an agent calling `propose_offer` directly
had been walking past. A hold there behaves as a hold on a message does: the
figure still goes on the table and a person is told. **`shared_identity`**:
`saveSharedProfile` runs the pipe, so a suspended account cannot hand a first
name and a suburb to anyone and the ledger accounts for the one thing here that
most needs accounting for. No model reads that door — a first name and a suburb
ARE personal details, so the screen that refuses personal details has no
business at it. **`amendment`** still has no direct caller and does not need
one: an amend sets the card back to `PENDING_SCREENING` and re-enqueues it, so
its words go through the `posting` door on the screening worker, and the tool
surface answers `SUSPENDED` before `amendIntent` is reached.

Pornography of any kind stays off the switchboard. A photo is for showing the
thing being sold; there is no legitimate use for a sexual image here, so the
threshold is "any explicit label", not "probably illegal".

## Verdicts, and how much of review is automatic

Nearly all of it. Pass and refuse are automatic and always were. **Hold** is
the only verdict a person sees, and it is meant to be rare:

1. First pass: the fast screen (Haiku on Bedrock, already in use).
2. A hold from the first pass goes to a second, stronger model with the full
   context of the introduction. Where the two agree, that is the verdict.
3. What remains uncertain after two models sits in a queue. Target: under one
   in a hundred items. At launch the queue is an email to the operator.

Two exceptions where a person is always in the loop, by law rather than by
choice: anything the CSAM hash check matches, and anything the sexual-content
check flags on a photo that might involve a minor. Those go straight to the
reporting path below and nowhere else.

## The ledger

- Every item that **passed** is written, encrypted, with sender, recipient,
  door, introduction id and timestamp. Refused items keep only the reason code
  and the sender, never the content.
- Encrypted under a **safety key** distinct from the channel keys. The safety
  key is split so that reading anything from the ledger needs **two
  keyholders** to act. This is the mechanism behind the promise the privacy
  page already makes.
- **Thirty days**, then deleted. Nothing about a person survives beyond that
  window except the postings they chose to keep up and the counts in the
  transparency report.
- Built as a Postgres table (`ledger_entries`, migration 033), encrypted per
  row: X25519 + HKDF wraps a fresh AES-256-GCM key for each entry, the private
  half split 2-of-3 with Shamir and never on a server. A held item keeps its
  body (a review with the words removed is no review); a refused one keeps the
  reason code only.
- The stores this section covers are `ledger_entries` (migration 033, thirty
  days), `safety_reviews` (migration 037, the flag a person looks at) and
  `photo_quarantine` (migration 038, ninety days): a photo refused for sexual
  content, moved to a quarantine prefix rather than deleted so that anything
  that must be referred to police still exists to be referred. None of the
  three holds content a server can read, and nobody has looked at a quarantined
  image.
- **Key ceremonies held.** One per environment, each on a laptop rather than
  a server, with `scripts/safety/generate.mts`. The private half was split
  2-of-3 and never written whole. The records below name the fingerprint and
  who holds which share; never the shares.
  - **dev**, 17 September 2026: fingerprint `b9:ee:f5:ce:be:f2:51:eb`. All
    three shares held by Lachlan Taylor (a test key for a test environment).
    Public half at SSM `/osb/dev/safety/public-key`.
  - **prod**, 18 September 2026: fingerprint `86:e0:e6:72:48:36:93:84`.
    Share 1 Lachlan Taylor, share 2 Mary Levy, share 3 Brett Kennedy, handed
    over by Lachlan the same day; shares 2 and 3 were deleted from his machine
    once handed over. Public half at SSM `/osb/prod/safety/public-key`, read
    by the prod task from that deploy on. Nobody was present but Lachlan when
    the key was made, so at that step the record rests on his word; the
    design's protection is that no one share opens anything.
- OPEN: unlike the settlement evidence bucket, a database row can be deleted
  or overwritten by an administrator (it still cannot be read). If tamper
  evidence matters, add an append-only hash chain over rows or move bodies to
  an Object Lock bucket. The public pages make no claim about this until it
  is built.

## The conversation budget: ongoing consent to talk

**The hole.** A conversation opened when both humans pressed the names page,
and after that the two assistants talked unattended. That one press was the
whole of the consent. Nothing in the design asked either human again whether
the conversation still mattered to them, which meant a conversation could go
on for as long as an assistant kept finding things to say.

**The rule.** Each press grants THAT human's side of THAT introduction a
window: `CONVERSATION_BUDGET_MESSAGES` messages sent by that side (40), or
`CONVERSATION_BUDGET_DAYS` days (7), whichever ends first. The first window
starts when their stage-3 opt-in is recorded. When it is spent, that side's
`send_message` carries nothing and answers `conversation_paused` with the
sentence telling the assistant to ask its human.

**How it is enforced.** One row per party per introduction in
`conversation_windows` (migration 044). The spend is a single `UPDATE` whose
`WHERE` clause is the budget itself, so two calls racing cannot both take the
last message, and zero rows back means paused. It sits in `sendMessage` after
authorisation and before the hourly slot and the intake pipe; a message the
pipe refuses has still spent one, the same reasoning the hourly slot uses.

**What a pause is not.** It does not close anything and nothing is lost. The
other side's messages keep arriving and `collect_messages` keeps working, so a
paused assistant can still bring its human everything that comes in. The other
side is told nothing whatever: not that the far side is paused, not how much
of its window is left. A paused conversation looks, from over there, exactly
like a reply that has not come yet, which is the point — a window is a fact
about somebody's attention and nobody consented to sharing it.

**Renewal.** `respond(request_keep_talking)` mints a `conversation-renew`
one-question link, bound to that introduction, for a party of an open
conversation only. The page says how many messages have gone from their side
and offers one button, "Keep going"; the press takes their passkey or PIN,
writes a consent event, and starts a fresh window. It may be pressed early,
which simply starts the window again. "Not now" leaves it paused and changes
nothing.

**Asking ahead.** The `check_in` sweep carries a `switchboard-system` note on
the caller's own side: paused when it is paused, and how many messages remain
once fewer than ten are left, so an assistant can put the question to its
human before it runs out rather than in the middle of carrying something
across. The manual tells it plainly not to stretch the budget by packing
several messages into one.

**Deploy.** Migration 044 backfills a full window for both parties of every
introduction with an open channel, so nothing live pauses on the deploy.

## An assistant never holds its human's PIN

No enforcement beyond copy, because there is nothing here to enforce: a PIN
handed over is a PIN we cannot tell apart from the human's own. So the rule is
stated everywhere it would be read.

- **The manual** (v48): the PIN and the passkey belong to the human alone.
  Never ask for it, never store it, never type it into a page for them, never
  press a switchboard page on their behalf. If it is offered, say no and say
  why.
- **The PIN set-up page**: "Keep this PIN to yourself. Do not give it to your
  assistant; the PIN is how we know it is you."
- **The terms and the public safety page**: you must keep your PIN and passkey
  to yourself and must not let an assistant press a main page for you; a
  press made with them is treated as yours.

## Reporting

A human can report from their own page on any introduction or conversation,
and can say "report this person" to their assistant, which fetches the same
one-question link. The report carries a reason in plain words and the
introduction id. It points at ledger entries; nothing needs to be re-sent.
The page takes the human's own passkey or PIN before it files anything, the
same ceremony the disclosure and settlement pages take, so an assistant
driving a browser cannot make the press for them.

A report does three things at once: opens a hold on the introduction (nothing
further is delivered either way), queues the ledger entries for review, and
answers the reporter with the sentence to say to their human.

## Enforcement

- **Sever**: close the introduction, refuse further delivery.
- **Block the pairing**: the two accounts never meet again (already what `bad`
  does; reuse it).
- **Suspend**: the account flag. Nothing in, nothing out, at every door. Their
  postings come down. Onboarding a new account from the same email is refused.
  Suspending also ends the credentials already out in the world: the account's
  browser sessions on the main pages are deleted, and its agents' OAuth
  refresh tokens are suspended, so neither goes on working after the flag.

**Telling their assistant.** We cannot make an assistant remember, so the
switchboard tells it every time instead: the connect block puts the suspension
first, before the manual; every tool answers `SUSPENDED` with the sentence to
say; and the manual asks the assistant to keep the fact in its own memory as
well, so the human hears it even in a client that never reconnects. Told every
time beats remembered once.

## A known-image match

The one thing on this switchboard that is not a judgement call. See
`src/intake/checks/photoHashMatch.ts` and `src/safety/photodna.ts`.

**What the machine did, before anybody was told anything.** The photo was
refused with the ordinary sentence. The bytes were copied to the quarantine
prefix and the original deleted, with `hash_match` true and the names of the
lists that held the hash on the row. A safety review was opened, flagged
`known_abuse_image`, carrying the matching service's tracking id. The sender's
account was suspended: every door shut, every posting down, every open
conversation severed, every credential pulled back. Neither user was told
anything beyond the ordinary refusal, and the person on the other side was
never told there was a photo at all.

**What the person does, within 24 hours.**

1. **Do not view it.** There is nothing an operator learns by looking that the
   match has not already said, and looking is its own harm. Nothing in this
   repository displays or fetches a quarantined object, and
   `scripts/safety/quarantine.mts` prints the match first and says to refer it.
2. **Report it to the ACCCE**, the Australian Centre to Counter Child
   Exploitation, on the AFP's online form at accce.gov.au. Quote the tracking
   id from the review row, the quarantine id, the introduction id and the time.
   Say that the material is preserved and where, and ask how they want it
   handed over. This is the s 474.25 referral and it is not optional.
3. **Preserve.** Mark the quarantine row `--referred`, which keeps it forever:
   a referred row is never swept at any age and the object is never touched.
   Preserve the introduction's ledger entries as well if the review's own
   ninety days will not cover the request.
4. **NCMEC, where there is a United States connection.** The CyberTipline is
   the US channel and an electronic service provider reports through it. We do
   not have an NCMEC ESP account yet and have not registered for one. Until we
   do, a US-connected matter goes through the ACCCE, who deal with NCMEC
   themselves. Registering is an open item.
5. **Write it down.** Date, tracking id, review id, quarantine id, who was
   told, what they said, and what was handed over. It is one line in the
   transparency report as well: date, kind, what was produced, nothing
   identifying.

**What is logged, and what is not.** `{event:'photo-refused', reason_code:
'KNOWN_ABUSE_IMAGE'}` at the moment of refusal; `{event:'photo-quarantined',
quarantine_id, match_id, hash_match}`; `{event:'safety-review', review_id,
match_id}`. No hash, ever, in any of them, in any row, or in the ledger: a hash
is a handle on one specific picture and a log line is the one thing in this
system that is read casually. The tracking id is on the review row and nowhere
else, because that is what a referral quotes.

**The licence.** The PhotoDNA files are Microsoft confidential and are not in
this repository. `vendor/photodna/README.md` says what belongs there; a fork
has to obtain its own licence from Microsoft.

## Law enforcement: the runbook

For a lawyer to read before launch. This is the shape, not the legal advice.

**What applies to us.** We carry messages between strangers in Australia, so
the Online Safety Act 2021 and eSafety's Basic Online Safety Expectations
apply. Child sexual abuse material carries mandatory reporting. Preservation
requests and warrants under the Telecommunications (Interception and Access)
Act and the Crimes Act can reach us.

**What we hold** (all of it within the window unless noted): account email;
the area they set; first name and suburb where they chose to share them;
postings (no window; they are up until withdrawn); ledger entries for thirty
days; photos for thirty days; timestamps and introduction ids. We do not hold
IP addresses beyond the load balancer's own logs, and we hold nothing after
the window.

**How a request is met.**

1. A request arrives at the abuse address. It is logged, counted, and
   acknowledged.
2. A **preservation request** freezes the named ledger entries past the
   thirty days, without anyone reading them.
3. A **warrant or equivalent** triggers the two-keyholder ceremony. The export
   is a bundle: the entries, decrypted, with a manifest and a hash over the
   whole, signed by both keyholders.
4. Anything the sexual-content check quarantined, or the CSAM check matched,
   is assessed and, where it is child abuse material, reported to the
   Australian Federal Police through the Australian Centre to Counter Child
   Exploitation without waiting to be asked (Criminal Code s 474.25), and the
   material is preserved for them; nothing is deleted before that decision.
5. Every request is a line in the transparency report: date, kind, what was
   produced, nothing identifying.

**Two kinds of request, two standards.** Message and photo content is a stored
communication under the Telecommunications (Interception and Access) Act: it is
produced on a warrant or its equivalent, never on a request. Account details
(email, area, when an account was opened) may be given to a law-enforcement
body on a written request on its letterhead naming the law it acts under
(APP 6.2(e)); we are permitted to answer such a request, never compelled, and
every one is logged and counted.

**On our own initiative.** Where we reasonably believe it necessary to prevent
a serious threat to someone's life, health or safety, or to report a serious
crime (APP 6.2), we may take what the classifier or a report has surfaced to
the police or to the eSafety Commissioner without waiting to be asked, and we
record that we did.

**What we contest.** We produce what lawful process compels and nothing more.
Under the Assistance and Access Act a technical assistance or capability
notice is lawful process and cannot simply be refused; but the same Act
forbids a demand for a systemic weakness, and a record no single key can open
is the argument that any such demand is one. We contest it by every lawful
means rather than promising to refuse it.

**Clocks.** An eSafety removal notice runs 24 hours; a BOSE reporting notice
sets its own deadline. `safety@openswitchboard.ai` is the address on file and
is monitored daily; the operator is the responder and names a fallback before
any absence longer than a day.

**Transparency report.** Published each year, the first twelve months after
launch, or sooner if a request arrives: date, kind, what was produced, nothing
identifying.

## Plaintext, and being honest about it

The switchboard **does** see the words at send time. It has to: it writes the
sentences, screens the content and refuses the money figures. It is not
end-to-end encrypted and has never claimed to be. What is true, and what the
privacy page should say plainly:

- Everything in transit is under TLS (ACM certificate on the load balancer).
- Everything at rest is encrypted under KMS-held keys.
- The server reads by machine. A person reads only through the two-keyholder
  ceremony, only from the thirty-day ledger, only under a report or a lawful
  request.
- Message bodies never go to logs.

Saying this beats implying a privacy we do not have. The people we are
protecting a child from are the two humans in the conversation, not the
operator, and that protection needs the operator to be able to look.

## Runbook: the email-hash rehash (migration 043)

`accounts.email_hash`, `suspended_emails.email_hash` and `email_suppressions`
key on the hash of an address rather than the address. Until migration 043 that
hash was a bare SHA-256, which for email addresses is not much of a hash at
all: the plausible space is a few billion real addresses, everybody has the
leaked-credential corpora that list them, and an afternoon on a laptop puts a
name to every row. Three tables key on it — who has an account, whose account
was stopped, whose address bounced — so what was readable from a copy of the
database was a membership list, a moderation record and a deliverability
record.

**v2** is HMAC-SHA256 under a pepper derived with HKDF from the counter's
existing link HMAC key (info `email-hash-pepper-v1`). No new secret: the
counter already refuses to boot without that key, and the pepper is never
written anywhere. A v1 hash cannot be turned into a v2 hash — that is the point
of both — so the columns live side by side while the switchboard catches up.
Every lookup asks v2 first and takes v1 as the fallback, so nothing breaks
during the changeover.

**Run it once, after 043 is deployed.**

```
npm run rehash-emails             # dry run: counts, writes nothing
npm run rehash-emails -- --apply
```

It goes through every account with a NULL `email_hash_v2`, decrypts the
address the account already holds under its own data key, writes the peppered
hash, and touches nothing else. It is safe to run again: a second run picks up
whatever the first left. Each account read writes the ordinary decrypt-audit
line to the WORM consent log, which is deliberate — a job that reads every
address on the switchboard should leave a record that it did.

**Afterwards.** When the script reports nothing left to do (accounts with no
stored address are reported separately and stay on v1 forever), a later
migration may drop `accounts.email_hash` and the fallback with it.

**`suspended_emails` keeps both, permanently.** There is no plaintext behind
those rows — the account it belonged to may be long gone — so nothing can
rehash them, and `emailIsSuspended` checks either spelling for good.

## Policy surfaces to update

Two layers, deliberately kept apart. The **behaviour** of the software is
public and lives beside the code. The **contracts** are ours alone, live only
on openswitchboard.ai, and are not in any repository: a fork writing its own
switchboard writes its own terms, and the README says so in one line. That is
so nobody takes our terms in good faith from GitHub and is caught out by
something in them that was only ever true of us.

- **`docs/safety.md`** (this repo, public): what is checked, what is kept and
  for how long, who can read it and under what ceremony, how to report, how a
  lawful request is met. A description of the code, not a contract. The site's
  safety page renders from it; the README and the whitepaper point at it.
- **Terms** (website only): 18+ (keep the tickbox); the law-enforcement
  carve-out from privacy; suspension and what triggers it; no sexual content;
  reporting.
- **Privacy policy** (website only): rewritten around the pipe, the ledger,
  the window, the two keyholders, the transparency report, and the plain
  statement above.
- **Whitepaper**: a section on safety protocols, with the same one sentence
  and the same table of checks. Measured numbers once there are any.
- **The tie between them** is a release-bar check, not a shared file: a change
  to `docs/safety.md` without a matching website commit fails the check.

## Cost

Rehearsal scale: a few dollars a month. What scales:

| Item | Rough cost |
|---|---|
| Message screening (Haiku, ~300 tokens each) | about $0.50 per thousand messages |
| Second-model pass on holds | pennies; holds are rare by design |
| Image moderation (Rekognition) | about $1 per thousand photos |
| Known-CSAM hash match | PhotoDNA is free to qualifying services; Thorn Safer is a paid licence, thousands a year, only if PhotoDNA is refused |
| Ledger storage | negligible at thirty days |
| Second KMS key | about $1 a month |

No new always-on infrastructure. Everything here is per-item.

## Build sequence

1. `src/intake/`: the pipe, verdict shape, and the existing checks moved in
   unchanged. No behaviour change; the tests prove it.
2. Ledger and the safety key, with the two-keyholder ceremony as a script
   before it is a page.
3. Prohibited-by-meaning check. This is the gate on opening the catalogue.
4. Photo moderation. Photos stay off prod until this ships.
5. Report link and page; sever and block.
6. Suspend, the connect-block line, the `SUSPENDED` answer, the manual
   sentence (new changelog entry; nothing reworded).
7. Message classifier for grooming and threats, hold-only.
8. Terms, privacy, safety page, README, whitepaper.
9. Apply for PhotoDNA; wire the hash check when granted.

Steps 1 to 6 and 8 are release-bar tier one. Steps 7 and 9 follow within the
first month of launch.

## Open questions for a lawyer

- Is thirty days the right window under the Basic Online Safety Expectations,
  or does anything oblige longer?
- The exact reporting route and timing for CSAM in Australia, and whether
  overseas users change it.
- Whether the two-keyholder ceremony satisfies a warrant's timing
  requirements, and who the second keyholder should be.
- IP addresses do sit in the application logs for one month (Fastify request
  logs); the public pages now say so.
