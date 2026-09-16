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
| Sexual content | Nudity and sexual imagery of any kind, and violence, hate symbols and drugs alongside it | Rekognition `DetectModerationLabels` on the uploaded object at the send press, before the other side is told it exists, `MinConfidence` 50. Refused on any of these top-level labels, in both the old and the current taxonomy names: Explicit, Explicit Nudity, Non-Explicit Nudity of Intimate parts and Kissing, Suggestive, Sexual Activity, Swimwear or Underwear, Violence, Visually Disturbing, Graphic Violence Or Gore, Hate Symbols, Drugs & Tobacco, Drugs, Tobacco. Alcohol, Gambling and Rude Gestures are deliberately not refused: a bottle of wine is a thing somebody may lawfully be handing over. A refusal deletes the object and keeps the reason code alone; an error is a hold, never a pass | Photos |
| Known CSAM | Hash match against industry hash lists | PhotoDNA or Thorn Safer; apply early, it takes time to be granted | Photos |
| Grooming, exploitation, threats | Contact with minors, coercion, moving a child off-platform, sextortion, threats of harm, and a sender who sounds at risk themselves | Model classifier on message text (Haiku, the same client and model the screen uses; the first 2,000 characters; `MESSAGE_SAFETY=off` turns it off for a deployment). Five flags: `minor_involved`, `grooming`, `sexual_exploitation`, `threat`, `self_harm_risk`. Any of them HOLDS, and it can never refuse — and a hold at this door still DELIVERS the message: it is a flag for review, never a stall, because the person waiting for a reply must not be silently ghosted on a fast model's word. The hold opens a `safety_reviews` row (the flag names and the ledger entry id, never the words), holds that introduction's ledger entries ninety days exactly as a report does, and puts one line in front of the operator: `{event:'safety-review', review_id, match_id}`. A model that does not answer is a PASS with a `{event:'message-safety-unavailable'}` warn line — deliberately the opposite of the photo rule, because an outage must not stop every ordinary conversation and the words are in the ledger to be read afterwards. The second-model pass below is not wired to it yet; every hold reaches a person today | Messages |
| Suspended sender or recipient | Nothing in, nothing out | Flag on the account | Every door |

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
- OPEN: unlike the settlement evidence bucket, a database row can be deleted
  or overwritten by an administrator (it still cannot be read). If tamper
  evidence matters, add an append-only hash chain over rows or move bodies to
  an Object Lock bucket. The public pages make no claim about this until it
  is built.

## Reporting

A human can report from their own page on any introduction or conversation,
and can say "report this person" to their assistant, which fetches the same
one-question link. The report carries a reason in plain words and the
introduction id. It points at ledger entries; nothing needs to be re-sent.

A report does three things at once: opens a hold on the introduction (nothing
further is delivered either way), queues the ledger entries for review, and
answers the reporter with the sentence to say to their human.

## Enforcement

- **Sever**: close the introduction, refuse further delivery.
- **Block the pairing**: the two accounts never meet again (already what `bad`
  does; reuse it).
- **Suspend**: the account flag. Nothing in, nothing out, at every door. Their
  postings come down. Onboarding a new account from the same email is refused.

**Telling their assistant.** We cannot make an assistant remember, so the
switchboard tells it every time instead: the connect block puts the suspension
first, before the manual; every tool answers `SUSPENDED` with the sentence to
say; and the manual asks the assistant to keep the fact in its own memory as
well, so the human hears it even in a client that never reconnects. Told every
time beats remembered once.

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
4. Anything the CSAM check matched is reported to the Australian Centre to
   Counter Child Exploitation without waiting to be asked, as the law
   requires, and the material is preserved for them.
5. Every request is a line in the transparency report: date, kind, what was
   produced, nothing identifying.

**What we say no to.** Anything without lawful process; anything asking for
more than the window holds; anything asking us to build a way to read the
ledger without two keyholders.

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
- Whether refusing to hold IP addresses is defensible or a gap.
