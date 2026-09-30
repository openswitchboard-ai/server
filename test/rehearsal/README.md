# The rehearsal suite

The run the founder has been doing by hand, automated.

Two real assistants, each working for a different human, on the **dev**
switchboard. One human says one loose, ordinary sentence in his own words and
then answers whatever his assistant asks — truthfully, briefly, volunteering
nothing. The other asks for advice first and then states his want. The run goes
from there through posting, the introduction and names, the conversation,
photos, the figure and wrapping up — and every step is checked against what the
manual asks and what the database says happened.

**The scenario is not in this repository.** The fact sheets, the opening lines
and the hand-written meaning examples are our evaluation data and live in a
private data repository; `data.ts` says where the runner looks for them
(`OSB_REHEARSAL_DATA`, `OSB_INTERNAL_DIR`, or a checkout at `../internal`).
Without them the runner and the calibrator say so and exit cleanly, and the unit
tests that need a fact sheet skip. To rehearse your own errand, write a scenario
module with the exports `Scenario` in `data.ts` names.

**Safe hands is out of scope.** This suite never calls `settle` and never
touches Stripe. Payments come later.
---

## Running it

```
AWS_PROFILE=openswitchboard AWS_REGION=us-east-1 \
NAGATHA_HOST=ubuntu@<box> NAGATHA_KEY=<key.pem> \
DUET_B_HOST=ubuntu@<box>  DUET_B_KEY=<key.pem> \
DUET_B_PROFILE=bilby \
npm run rehearsal -- --stage 6 --until-green 5
```

`npm run rehearsal -- <flags>` and `npx tsx test/rehearsal/run.ts <flags>` are
the same thing.

### Claude Code as the third assistant

The driver runs Claude Code headless with an empty working directory, so no
CLAUDE.md, project settings or repository are discovered. It also used to make
a fresh `CLAUDE_CONFIG_DIR` per run — and that is where the login lives, so on
a machine whose token sits in the Keychain the CLI answered **"Not logged in ·
Please run /login"** and every run it was cast in died.

**Signing in by hand does not work here, and cannot.** The driver runs the CLI
in bare mode (`CLAUDE_CODE_SIMPLE`), and bare mode never reads OAuth or the
keychain — authentication is an API key or a third-party provider, nothing
else. An afternoon went on "Not logged in · Please run /login" answers from a
CLI that was signed in perfectly well; it simply was not allowed to look. A
long-lived `claude setup-token` is OAuth too, so it is ignored the same way.

So the third assistant goes through **Bedrock, on the AWS credentials the run
already holds** — the same `AWS_PROFILE` that reaches the database and the
logs. Nothing extra to set up:

| variable | default | what it does |
| --- | --- | --- |
| `REHEARSAL_CLAUDE_BEDROCK` | `1` | `0` falls back to a plain `ANTHROPIC_API_KEY` |
| `REHEARSAL_CLAUDE_MODEL` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | named on every turn and recorded by name |

Haiku 4.5 is about two tenths of a cent a turn, so a six-run series is small
change. It is also the honest test: the manual-delivery faults this suite
exists to find are the ones a smaller model hits first, and most people will
not arrive on the largest model.

Everything else stays isolated: empty working directory, `--strict-mcp-config`
so the only MCP server is the one the run writes, and `--setting-sources ''`.

| flag | what it does |
| --- | --- |
| `--stage <n>` | run stages 1..n (default 6) |
| `--runs <N>` | at most N runs (default 6) |
| `--until-green <K>` | stop once K clean runs have happened in a row (default 5; `10` is the stronger figure) |
| `--cast a,b[;c,d]` | which clients, as one or more pairings cycled run over run. Default `nagatha,bilby;claude,nagatha`. Sides alternate within a pairing |
| `--errand <name>` | which scenario file to rehearse (`scenarios/<name>.ts` in the data folder; default `spring`). A scenario says the shape of its errand — whether money changes hands (`MONEY`), how far each posting should reach (`REACH`), what must be asked before posting (`ASK_BEFORE_POSTING`) — and where there is no money the figures stage becomes the two settling the arrangement (`AGREE_WORDS`), with any offer on the table the finding. See `Scenario` in `data.ts` |
| `--scenario main\|report` | `report` runs stages 1–3 and then the report, on its own, because a report closes the conversation |
| `--keep-going` | do not stop at the first failed check |
| `--dry` | canned replies, a stubbed human, no network, no AWS |
| `--overrule <run>:<turn>:<rule> "<reason>"` | record that a person judged a flag false. The run then does **not** count toward the streak |

There is **no `--from-stage`**, on purpose: every run starts at stage 1, so a
stage-5 finding is never a finding about a board somebody else built.

### Typecheck and unit tests

```
npx tsc --noEmit                        # the repository
npx tsc -p test/rehearsal/tsconfig.json # this suite and what it imports
npx vitest run test/unit/rehearsal      # the pure parts
npx tsx test/rehearsal/run.ts --dry --stage 6 --runs 1   # the orchestration, free
```

---

## Environment

| variable | what for |
| --- | --- |
| `AWS_PROFILE=openswitchboard`, `AWS_REGION=us-east-1` | the dev database (RDS Data API), Bedrock for the simulated humans, Secrets Manager for the scorer's key, CloudWatch for the tool-call log |
| `NAGATHA_HOST`, `NAGATHA_KEY` | the OpenClaw box and the key that opens it |
| `REHEARSAL_CLAUDE_CONFIG_DIR` | a directory holding nothing but this rig's own Claude Code login (see below) |
| `DUET_B_HOST`, `DUET_B_KEY` | the same box; Bilby lives in its own OpenClaw home |
| `DUET_B_PROFILE=bilby` | which profile is Bilby |
| `OSB_RATELIMIT_BYPASS` | **read for you.** The suite fetches it from SSM `/osb/dev/ratelimit-bypass` inside the process and puts it where `test/integration/helpers.ts` reads it. It is **never printed**, never written to a report and never passed on a command line. Set it yourself only if you have a reason to |

Optional knobs: `REHEARSAL_HUMAN_MODEL`, `REHEARSAL_ROUND_CAP`,
`REHEARSAL_GAP_MS`, `REHEARSAL_MEET_WAIT_MS`, `REHEARSAL_SCREEN_WAIT_MS`,
`OSB_TOOL_LOG_GROUP`, and the three slip levels
(`REHEARSAL_MAX_SLIPS_PER_RUN`, `REHEARSAL_MAX_SLIP_RATE`,
`REHEARSAL_RATE_FROM_TURNS`) — which move the bar, so a series run with any of
them set is not comparable with one run without.

The suite **refuses to run against anything but dev**: every URL is checked for
`-dev.` before a word is said.

---

## What one run does

1. **Sweeps the board.** Every `PUBLISHED` / `PENDING_SCREENING` card belonging
   to any account this suite has ever made is withdrawn, and the run refuses to
   start while one is still standing. The account ids live in
   `test/rehearsal/.ledger.json`; that file holds account ids and nothing else.
2. **Mints two fresh humans** (`bootstrapActor`) and an agent key each.
3. **Deep-cleans both assistants.** `~/osb-deep-clean.sh <dir> <unit>` on the
   box — the *deep* clean, not the older reset in `test/adversary/box.ts`, which
   misses `workspace/memory/.dreams`, the state database's memory rows, cron
   jobs the agent made for itself and `workspace/skills/switchboard-*` skills it
   wrote about the switchboard after reading the manual once. The run's key then
   goes over **stdin**, never on a command line.
4. **Drives the errand**, one human utterance at a time, with the human
   simulated by a Haiku-class model held to a fact sheet
   (the scenario; see `data.ts`). When the simulated human is handed a link it answers
   `[[PRESS <url>]]` and the harness presses that page as that human, on their
   own session, with their own PIN. **No assistant is ever given a PIN.**
5. **Checks as it goes**, and on the first failed check stops driving the
   assistants. Teardown still runs in full.
6. **Tears down.** Cards withdrawn, Claude Code's temp config and key deleted,
   any suspension on a throwaway account lifted.

---

## Reading the report

Each series writes `realism-reports/rehearsal/<timestamp>/`:

- `run-<i>.md` — the transcript, in exactly the shape
  `scripts/eval/transcriptScore.mts` parses. A unit test holds the writer to the
  parser, because if they drift the scorer silently finds no assistant turns and
  every speech check reports clean.
- `run-<i>.json` — every check with its evidence, the database facts, the raw
  scorer answers, the `jev_shadow` rows for that run's cards.
- `summary.md` — the headline paragraph first (**what failed, and on what
  evidence**), then **the gate in plain words** (runs counted, runs that passed
  every deterministic check, runs with no critical slip, and the non-critical
  slip rate against its ceiling), the per-run table, the per-check pass rate,
  the per-rule slip rate per assistant, **every slip verbatim in its two
  classes**, the uncertain turns verbatim, the overrule column, and a list of
  what the series did **not** do.
- `.private/` — Claude Code's throwaway config. Deleted at teardown.

### The gate

Deterministic checks (everything in `checks.ts` read off the database and the
transcript) are facts, and every one asked for must pass. Speech-rule marks are
one model's judgement about how another spoke: outside the critical rules in
`levels.ts`, which gate at zero, they are counted against a per-run ceiling and
a series-wide rate rather than failing a run on their own. Every level, and the
streak a series needs to be green, is in `levels.ts` with its environment
override; the summary prints the gate in plain words whether or not the series
passed, and every tolerated slip verbatim.

---

## Meaning checks: Jev first, the pattern as the net

Most of the ladder's stops in late September were a regular expression missing
a correct reply worded a new way. The checks that judge **meaning** in an
assistant's words now ask Jev a plain yes/no question (`meaning.ts`) over the
assistant's own replies, one general line saying what just happened, and the
human's last words where they matter (a PIN is never sent — it goes as
`[withheld]`). Structural checks stay deterministic: a link present, an id read
aloud, a figure on a card, a tool called, a database row.

| check | meaning question(s) |
| --- | --- |
| `S1.asked.seller` | `asked_which_item`, `asked_condition`, `asked_kind_of_sale` (the card facts stay deterministic) |
| `S1.reach.seller` | `said_reach_country` (the reach itself is read off the row) |
| `S2.told.*` | `told_someone_came_forward`, `claimed_a_count` (an id read aloud stays a pattern) |
| `S2.maybe.*` | `hedged_maybe` (only on a possible introduction) |
| `S3.pin_refused` | `refused_pin`, `said_why_pin` |
| `S3.messages_left` | `said_messages_left` |
| `S4.told.*` | `told_picture_came`, `described_picture` (describing is still counted, not gated) |
| `S5.what_next` | `said_what_next` |
| `S6.asked_how_it_went.*` | `asked_how_it_went` |
| `S6.offered_to_file.*` | `offered_take_down` |

**The pass line.** yes ≥ **0.70** means it was said; ≤ **0.30** means it was
not; in between, the old pattern decides. Where Jev's first reading agrees
with the pattern that is the verdict. Where it is decisive and disagrees, Jev
is asked again, and it overrules the pattern only if the second reading lands
on the same side; otherwise the pattern decides. No key, a timeout or an error
falls back to the pattern. Every such check's evidence names who decided and
on what readings, and `run-<i>.json` carries them under `meaning`.

The questions name no good, service, brand or figure (a unit test holds them
to that). `REHEARSAL_MEANING_JEV=0` turns Jev off and the patterns decide
alone; `--dry` never asks it.

**Calibration.** `npx tsx test/rehearsal/calibrateMeaning.ts` reads past run
transcripts and the hand-written examples and puts Jev's reading beside the
pattern's, for a person to label the disagreements.

## What this suite cannot see, said once

- **Message bodies.** `channel_messages.body_enc` is encrypted under a
  per-channel key and delivery deletes the row. There is no plaintext to compare
  a relay against, and this suite does not manufacture one. "Carried faithfully"
  is judged on what the *receiving* assistant relayed to its own human, and the
  per-sender tally in `channel_send_rate`, which survives delivery.
- **Which assistant made a tool call.** The tool-call log line carries a tool
  name and nothing else — no account, no session — deliberately (see
  `src/mcp/mcp.ts` where it is written). Where two assistants are driven in one
  window their lines are indistinguishable, and `S1.manual` records **unknown**
  and does not fail anybody for it.
- **Claude Code's authentication.** The driver isolates the working directory,
  `CLAUDE_CONFIG_DIR`, settings sources and MCP servers, so no CLAUDE.md, no
  memory and no other MCP server can leak into a run. It does **not** isolate
  who the CLI is signed in as: turns are billed to whoever this machine is
  signed in as, and a managed/policy settings file still applies. There is no
  way around that from here.
- **The report stage.** `--scenario report` reaches it and reports **"not
  implemented"** rather than a fake pass. The page and `fileReport` are mapped
  (`POST /a/:token` with `decision`, `reason`, `pin`; `src/safety/reports.ts`)
  but this harness has never pressed one. Worth knowing when it is built: a
  report **severs the match and mutes the pairing — it does not suspend the
  reported account.** Suspension is an operator act
  (`scripts/safety/suspend.mts`).

## What it costs

Per run, roughly: a few dozen turns across two real assistants (the largest
cost, and the reason `--dry` exists), one small Bedrock call per simulated human
turn, one or two Jev calls per assistant turn, and a handful of Data API reads.
A series of six full runs is not cheap. Run `--dry` first, every time you change
the orchestration.
