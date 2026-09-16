# How the switchboard keeps people safe

A description of what this software does. It is written so that anyone can
check it against the code in this repository. It is not the terms of use or
the privacy policy of any particular deployment; those belong to whoever runs
the switchboard, and the ones for openswitchboard.ai are on that site.

## One sentence

Nothing reaches another person that the switchboard has not looked at and
cannot account for.

## Everything goes through one pipe

Anything one person hands the switchboard for another person to see goes
through the same path (`src/intake/`): a want or a have, an amendment, a
message, a photo, a report.

```
intake  →  checks  →  verdict  →  ledger  →  deliver
```

Each check is one file in `src/intake/checks/`. The verdict is one of three:
**pass**, **hold** for a person to look at, or **refuse** with plain words
back to the sender's assistant. Refusals are answered as ordinary answers, so
an assistant always has a sentence to say to its human.

## What is checked

| Door | Checked for | Where |
|---|---|---|
| Every door | The account is suspended (nothing in, nothing out) | `checks/suspended.ts` |
| Wants and haves | Reserved families (jobs, property, licensed trades, dating) by path; prohibited things by what they **are**, whatever they are called: weapons, drugs and prescription medication, live animals and wildlife products, sexual services, anything illegal, people as the thing itself; personal details; text aimed at an AI reader; the wording of stolen or recalled goods | `checks/denyListPath.ts`, `checks/modelScreen.ts` |
| Messages | Money figures, in digits or in words (figures travel only through the offer path where the human presses); personal details; grooming, sexual exploitation, threats, a child involved, a sender at risk (hold for a person, still delivered) | `checks/moneyFigure.ts`, `checks/modelScreen.ts`, `checks/messageSafety.ts` |
| Photos | Hidden metadata removed in the sender's browser before upload; then, before the other side is told a photo exists, a machine looks at it once: anything sexual or nude at all, violence, hate symbols or drugs, and it does not go. A photo stopped for violence, hate symbols or drugs is deleted; one stopped for anything sexual is held unseen in quarantine instead, because what may have to be referred to police must still exist to be referred. An error is a hold, never a pass | `checks/photoMetadata.ts`, `checks/photoModeration.ts` |
| Reports | Never refused for their words. A figure or a personal detail in a report is held for a person, never sent back | `pipe.ts` (`REFUSAL_FREE_DOORS`) |

A lawful secondhand-goods conversation, blunt haggling, or rudeness is none
of these, and the classifier is told so.

## What is kept, and for how long

- **Wants and haves**: until withdrawn or expired.
- **Everything that passed or was held**: kept for **thirty days** in a
  ledger (`ledger_entries`), encrypted per entry with a key the server holds
  only the public half of. Sender, recipient, door, introduction and time
  ride beside it. Then deleted by the daily sweep.
- **Refusals**: the reason code and the sender only. Never the words.
- **A reported introduction**: its ledger entries are preserved for
  **ninety days**.
- **A photo stopped for sexual content**: held in quarantine, unseen, for up
  to **ninety days**, so that anything that must be referred to police can be,
  then deleted.
- **Message bodies never go into logs.** Operator log lines carry ids and
  reason codes only.
- IP addresses appear in the application's request logs, kept for one month.

## Who can read it

The switchboard reads every message and photo **by machine** at the moment it
is sent. It has to: it writes the sentences, keeps money figures out of chat,
and runs the checks above. It is not end-to-end encrypted and does not claim
to be.

A **person** can read an entry only from the thirty-day ledger, and only
through a ceremony that needs **two of three keyholders** in the room. The
private half of the ledger key is split with Shamir secret sharing
(`src/safety/shamir.ts`); one share opens nothing; the private key is never on
a server. The scripts in `scripts/safety/` say what they are about to do
before they do it.

## Reporting

A human can report the person on the other side of any introduction, from
their own page or by telling their assistant "report this person". The page
carries a box for a line in their own words and one press. That press:

1. closes the introduction there and then, both ways;
2. means the two of them are never put together again;
3. preserves the ledger entries for ninety days for a person to review;
4. tells the operator a report exists, by id, with none of the words.

The other person is told only that the switchboard has closed the
conversation: never that they were reported, never by whom, never what was
said. The reporter's own assistant is never handed anything to send back
across.

## Suspension

An operator can stop an account (`scripts/safety/suspend.mts`). Their wants
and haves come down, their open conversations close, and nothing further goes
in or out at any door. The same email cannot come back. Their assistant is
told on every connect, in the first block before the manual, and by every tool
answer, and is asked to keep the fact in its own memory. The people on the
other side of their conversations are told only that the switchboard closed
them.

## How a lawful request is met

1. A request arrives at the address the deployment publishes. It is logged,
   counted and acknowledged.
2. A preservation request freezes the named ledger entries past the thirty
   days, without anyone reading them (`scripts/safety/preserve.mts`).
3. A warrant or its equivalent triggers the two-keyholder ceremony
   (`scripts/safety/export.mts`): a bundle of the named entries, decrypted,
   with a manifest and a hash over the whole.
4. Child sexual abuse material is reported to the Australian Federal Police,
   through the Australian Centre to Counter Child Exploitation, without
   waiting to be asked, as the law requires, and preserved for them. Account
   details may be given on a written request from a law-enforcement body
   naming the law it acts under; content only on a warrant or its equivalent.
   Where the operator reasonably believes it necessary to prevent a serious
   threat to someone's life, health or safety, what a report or the classifier
   surfaced may go to the police without waiting to be asked, and that is
   recorded.
5. Every request is a line in a transparency report: date, kind, what was
   produced, nothing identifying.

The operator produces what lawful process compels and nothing more, and
contests by every lawful means any demand that would weaken the two-keyholder
record for everyone, since the law does not permit a demand for a systemic
weakness.

## What is not built yet

- A hash match against known child-abuse imagery (PhotoDNA). Applied for;
  wired in when granted.
- A second, stronger model on every hold before a person sees it.
- Tamper evidence on the ledger itself: a database row can be deleted by an
  administrator, though it cannot be read. See `docs/trust-and-safety.md`.

Anyone who finds this page and the code disagreeing should say so; the code
is the truth and this page must follow it.
