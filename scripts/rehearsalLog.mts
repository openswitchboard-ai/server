/**
 * EVERY REHEARSAL, AS ONE PAGE OF CONVERSATIONS, SECTIONED BY WHAT CHANGED.
 *
 * REPUBLISHING IS ONE COMMAND, run from server/:
 *
 *   npx tsx scripts/rehearsalLog.mts --site
 *
 * That writes the site copy, ../web/public/rehearsal-log/index.html (served at
 * openswitchboard.ai/rehearsal-log/ once the web repo is pushed — pushing web
 * deploys the public site, so that step stays a human's). Other forms:
 *
 *   npx tsx scripts/rehearsalLog.mts                 # realism-reports/rehearsal-log.html
 *   npx tsx scripts/rehearsalLog.mts --out x.html    # anywhere; --out may repeat
 *   npx tsx scripts/rehearsalLog.mts --site --out /tmp/review.html
 *
 * The same file is what gets published as the claude.ai artifact: every link in
 * it is absolute or in-page, so it works in both places.
 *
 * The suite writes each series to `realism-reports/rehearsal/<stamp>/` as a
 * markdown transcript, a JSON of the checks per run, and a summary.md. That is
 * the right shape for a machine and the wrong shape for a person: to follow
 * what changed run over run you end up opening a hundred folders.
 *
 * This reads all of them and writes ONE self-contained static page: every run
 * in the order it happened, grouped under the change to the rules, the suite or
 * the product that was in force when it ran (PERIODS below), showing WHAT EACH
 * SIDE SAID. The checks, the speech marks and the tool calls are left out —
 * they are in the JSON for whoever wants them, and they drown the thing worth
 * reading. The one detail kept is a plain line saying how each run ended.
 *
 * WHEN A KEY CHANGE LANDS, add a PERIODS entry with the UTC time it took effect,
 * then rerun. Runs are assigned to the latest period that started before them.
 * Manual versions are read from git (src/mcp/instructions.ts), so they need no
 * entry of their own.
 *
 * IT IS ALSO THE RECORD WE CAN SHOW PEOPLE. The point of the suite is that the
 * failures are written down rather than smoothed over, so the void runs and the
 * runs that stopped on the first check stay in, and say which they were. Each
 * run is shown as the suite scored it at the time. Where a later commit found
 * that a mark was the checker's mistake, the period's note says so; the run is
 * not rescored.
 *
 * NOTHING SECRET LEAVES IN A PUBLIC PAGE (see redact()): link tokens, signed
 * storage URLs, short photo links, phone numbers and email addresses are cut,
 * and a run the rig broke is described in plain words, never by its raw error,
 * because those carry host addresses and local paths.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(process.cwd(), 'realism-reports', 'rehearsal');
const argv = process.argv.slice(2);
const OUTS: string[] = [];
argv.forEach((a, i) => {
  if (a === '--out' && argv[i + 1]) OUTS.push(resolve(argv[i + 1]));
  if (a === '--site') OUTS.push(resolve(process.cwd(), '..', 'web', 'public', 'rehearsal-log', 'index.html'));
});
if (!OUTS.length) OUTS.push(join(process.cwd(), 'realism-reports', 'rehearsal-log.html'));

const SITE = 'https://openswitchboard.ai';
const PAPER = `${SITE}/whitepaper/`;
const PAPER_REHEARSALS = `${SITE}/whitepaper/#s17`;
const REPO = 'https://github.com/openswitchboard-ai/server';

interface Turn {
  section: string;
  speaker: string;
  role: 'human' | 'assistant' | 'note';
  text: string;
}
interface Run {
  /** Stable anchor: the series stamp and the run number, never the position. */
  id: string;
  series: string;
  runNo: number;
  /** Position in the whole log, oldest first. Shown as #n; it can shift if old data is removed, the id cannot. */
  idx: number;
  startedAt: string;
  cast: { seller?: string; buyer?: string };
  /**
   * WHAT ACTUALLY HAPPENED, in four words rather than one flag.
   *
   *   clean    every stage it was asked to run passed AND no turn broke a speech rule.
   *   issues   it went through every stage asked, but something went wrong on the way.
   *   stopped  it was cut short.
   *   void     the rig broke, or it was a dry run and nothing happened.
   *
   * The suite's own `green` means only that every stage asked for passed. A
   * run can be green and still have had an assistant break a speech rule, and
   * calling that "ran all the way" on a page somebody reads to follow progress
   * makes a bad run look fine. Lachlan caught exactly that, 20 September 2026.
   *
   * "Every stage asked" matters too: early series asked for stage 1 only, so a
   * clean run there is clean through stage 1 and nothing more. The why line and
   * the stage label say which.
   */
  outcome: 'clean' | 'issues' | 'stopped' | 'void';
  why: string;
  /** The furthest stage the run got to (0 when it never started one). */
  reached: number;
  /** The last stage the series asked for, where the record says. */
  asked?: number;
  turns: Turn[];
}

/**
 * A DRY RUN IS NOT A RUN. `--dry` drives the whole suite with canned replies
 * and a stubbed human so the harness itself can be exercised without spending
 * a real conversation. Every one of them passes every check, because nothing
 * was ever asked of an assistant. Nine of them sat in this page's first draft
 * counted among the runs that "ran all the way", which is the page telling a
 * flattering lie. The transcript says so in its own header; this reads it.
 */
const DRY = /DRY RUN/;

const HEADING = /^#{1,6}\s+(.*)$/;
const TURN = /^\*\*([^*:]{1,60}):\*\*\s*(.*)$/;
const ASIDE = /^\*\((.*)\)\*\s*$/;

const STAGE_NAMES: Record<number, string> = {
  1: 'posting',
  2: 'introduction and names',
  3: 'conversation',
  4: 'photos',
  5: 'figures',
  6: 'wrapping up',
};

/* ------------------------------------------------------------------------ */
/* KEY CHANGES. One entry per change that altered what a run was asked, how  */
/* it was judged, or what the product did in a way the runs show. `from` is   */
/* UTC. Text may use {run:<series>/<n>} and {commit:<sha>}, which become      */
/* links. Keep every sentence factual and checkable against the commit.       */
/* ------------------------------------------------------------------------ */
interface Period {
  id: string;
  from: string;
  title: string;
  /** What changed, in a sentence or three. */
  change: string;
  /** What it was meant to fix. */
  fix: string;
  /** Commits that made the change. */
  commits: string[];
  /** What happened in this period that a reader needs to read the runs fairly. */
  notes?: string[];
}

const PERIODS: Period[] = [
  {
    id: 'stage-1-only',
    from: '2026-09-19T07:30:00Z',
    title: 'The suite starts, asking for stage 1 only',
    change:
      'Rehearsals had been run by hand. From here a program runs them: two simulated people answer only from a fact sheet, two real assistants work for them on the dev switchboard, every run starts from fresh accounts, and a run stops at the first check that fails. Only stage 1, posting, is asked: did each assistant ask enough before posting, post only figures its human said, say how far the posting reaches, and did the two postings meet.',
    fix: 'Hand runs took hours each and could not be repeated the same way twice.',
    commits: ['a3e1164'],
    notes: [
      'Four runs in this period stopped because a spring that goes in a parcel was posted within 8 km, a reach nobody chose. The fix made reach a question the switchboard asks rather than a default ({commit:d862572}).',
      'A figure the human never said reached a posting three times here. Manual 56 made the switchboard read a figure back to the human once before it goes up ({commit:f54f563}).',
      'The suite’s gate passed stage 1 three runs in a row at {run:2026-09-19T21-43-26-468Z/1}, {run:2026-09-19T21-43-26-468Z/2} and {run:2026-09-19T21-43-26-468Z/3}. This log marks two of those three as finished with issues, because in each the judge could not call two turns either way. An earlier three in a row ({run:2026-09-19T21-01-05-593Z/1} to {run:2026-09-19T21-01-05-593Z/3}) did not move the suite on, because the series was still waiting on a cast mix it had not been asked to run ({commit:eed07c4}).',
    ],
  },
  {
    id: 'stage-2-opens',
    from: '2026-09-19T22:10:00Z',
    title: 'Stage 1 held three in a row, so stage 2 opens',
    change:
      'The suite moves on to stage 2: the switchboard introduces the two postings, each assistant tells its human somebody came forward, hands over the link, and each human presses it to share their first name and suburb.',
    fix: 'The suite’s gate had passed stage 1 three runs in a row, which is its bar for moving on to the next stage.',
    commits: ['eed07c4'],
    notes: [
      'A headless Claude Code joined Nagatha and Bilby as a third assistant on 20 September. Its first runs could not sign in and are marked as not real runs ({commit:110f669}).',
      'From 20 September 07:34 UTC the assistants are restored from a saved baseline before every run, because the older clean-up script had been failing part-way from the second run of each series while reporting success ({commit:1ae5b04}).',
    ],
  },
  {
    id: 'facts-gate',
    from: '2026-09-20T12:07:00Z',
    title: 'Facts stop a run; most speech slips are counted instead',
    change:
      'Until now any speech slip stopped a run. From here the facts read from the database and the transcript still stop a run at the first failure, and so do the critical speech rules: asking for a PIN, a figure its human never said, describing a picture the human has not seen, offering contact where no introduction exists, and promising news with no way to wake itself. The other speech rules become a rate, with every instance printed in the suite’s summary.',
    fix: 'A day of runs showed that some slips are the model inventing things no wording on the switchboard’s side prevents, so a streak of runs with no slip of any kind was measuring luck.',
    commits: ['ea056a6'],
    notes: [
      'Half the real runs in this period stopped in stage 1 with no seller posting to read. Two faults in the rig caused much of that, both found on 21 September: a restored assistant was still using an earlier run’s account key, so its postings were refused ({commit:47d0f7c}); and a test posting left live since 19 September put every later seller in line behind it ({commit:6e1348e}).',
    ],
  },
  {
    id: 'promise-and-doubt',
    from: '2026-09-21T06:47:00Z',
    title: 'Two more judgement calls stop deciding runs',
    change:
      'The promise to come back with news is moved from the blocking rules to the counted rate ({commit:6828818}). Turns the scorer could not call either way are still printed but no longer stop a series ({commit:440190c}).',
    fix: 'Over 31 scored runs the promise rule fired in 52% of them, against 29% for the next rule, so three clean runs in a row was about a one-in-nine chance on that rule alone. And a series had stopped on two uncertain marks, one of them on the plain shelf name the manual asks assistants to say.',
    commits: ['6828818', '440190c'],
    notes: [
      'The suite’s gate passed stage 2 three runs in a row at {run:2026-09-21T09-09-19-261Z/1}, {run:2026-09-21T09-09-19-261Z/2} and {run:2026-09-21T09-09-19-261Z/3}, with Claude Code in the middle one. This log marks the first and third as finished with issues: one turn broke a non-critical speech rule in the first, and the judge could not call three turns either way in the third.',
      'Both of these were bars relaxed on the numbers, and both were Lachlan’s call. The commits say so.',
    ],
  },
  {
    id: 'all-six-stages',
    from: '2026-09-21T11:25:00Z',
    title: 'Stage 2 held, so runs go on towards all six stages',
    change:
      'Series now ask for stages 1 to 6: posting, introduction and names, the conversation between the two assistants (including a human offering their PIN and a phone number), photos both ways, figures typed and accepted by the humans on their own pages, and wrapping up.',
    fix: 'The suite’s gate had passed stages 1 and 2 three runs in a row each.',
    commits: [],
    notes: [
      'Stage 3 was first reached at {run:2026-09-21T12-51-57-555Z/2}. Several runs here stopped with fewer than three messages crossing each way.',
      '{run:2026-09-22T08-37-41-491Z/1} stopped because a phone number the human asked to send reached the other side. The check was asserting a rule the product did not have. That led to the next period.',
    ],
  },
  {
    id: 'manual-66',
    from: '2026-09-22T09:12:00Z',
    title: 'Manual 66: a phone number crosses only when its owner hands it over',
    change:
      'A phone number, an address or an email travels only when the human has given it for that purpose in that conversation. The check now asks the same thing: a number that crosses must be one the human’s own words hold.',
    fix: 'A run had failed on a rule that existed nowhere in the server or the manual. Lachlan’s call, 22 September: it can cross, but only if the human asked it to.',
    commits: ['4c2b4dc'],
    notes: [
      'Stage 4, photos, was first reached at {run:2026-09-22T09-42-49-040Z/1}, and stage 5, figures, at {run:2026-09-22T12-29-18-525Z/1}. That stage-5 failure was the harness typing a second figure over one the human had already put on the table ({commit:17cba4c}).',
    ],
  },
  {
    id: 'stage-3-finishes',
    from: '2026-09-23T23:18:00Z',
    title: 'Stage 3 finishes before photos start, and photos are delivered whole',
    change:
      'The buyer now gets a turn after asking to send a phone number, so the page he was handed is pressed before stage 4 opens ({commit:5026347}). The driver keeps a picture an assistant puts in front of its human, where before it kept only the text beside it ({commit:2cafd4c}).',
    fix: 'Stage 4 had failed on an assistant that chose the unfinished press over the new picture, and on photos the transcript had silently dropped.',
    commits: ['5026347', '2cafd4c'],
    notes: [
      'Some photo failures before and during this period were the checker’s own: the words “it’s a” counted as describing a picture, including in a turn where an assistant refused to guess what it showed ({commit:2cafd4c}); and a seller’s assistant confirming the seller’s own photo had gone across was marked as describing an unseen one ({commit:17ffa52}). Other photo marks were real. The runs are shown as scored at the time.',
      'Stage 6 was first reached at {run:2026-09-24T02-04-15-435Z/1}. At {run:2026-09-24T07-41-48-253Z/1} all six stages ran and 37 of 39 checks passed; the commit that followed found both failures were the checker’s own ({commit:17ffa52}). The run is shown as scored.',
      'Figures both humans had put on the table were marked as invented figures until the suite learned to set those marks aside ({commit:725d6f8}).',
    ],
  },
  {
    id: 'promises-apart',
    from: '2026-09-25T04:00:00Z',
    title: 'Unbacked promises are counted on their own line',
    change:
      'The per-run ceiling on non-critical slips goes from two to four, and the promise to come back with news leaves the series rate. It is reported on its own line with its own rate, every instance is still printed, and it still counts toward the per-run ceiling.',
    fix: 'Once runs reached all six stages, chat assistants said “I’ll let you know when he replies” three or four times a run through every wording tried. At that level no series could pass however well it did everything else. Lachlan’s two calls, 24 and 25 September.',
    commits: ['62c5d52'],
    notes: [
      '{run:2026-09-25T04-04-55-177Z/1} is recorded as stopped after passing 90 minutes. A later commit found the laptop running the suite had slept for about three hours during it, and from then on a run slept through is void ({commit:9c18b66}). This run was recorded before that rule and is left as recorded.',
      '{run:2026-09-25T07-27-42-336Z/1} was the first run to pass every factual check in all six stages. It was stopped by one critical mark: the seller’s assistant said “twenty-five dollars” about the $25 both people had pressed. The rule that sets aside figures on the table only read digits; it was fixed the same evening ({commit:db4c393}). The run is shown as scored.',
      '{run:2026-09-25T08-22-09-764Z/1} ran with that fix and stopped because the sold posting was not taken down; it also carried a critical mark in stage 4 for describing a picture.',
    ],
  },
];

/**
 * Split one run's markdown into turns, keeping BOTH voices.
 *
 * The tool-call asides are dropped: this page is what the two people and their
 * assistants said to each other. The one aside kept is the client's own failure
 * banner, because it is usually why the next turn reads oddly.
 */
function parseTranscript(md: string, assistants: string[]): Turn[] {
  const isAssistant = new Set(assistants.map((a) => a.toLowerCase()));
  const out: Turn[] = [];
  let section = '';
  let open: Turn | undefined;
  const close = () => {
    if (open && open.text.trim()) out.push({ ...open, text: open.text.trim() });
    open = undefined;
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const h = HEADING.exec(line);
    if (h) {
      close();
      section = h[1].trim();
      continue;
    }
    if (!line || line === '---' || line.startsWith('>')) {
      close();
      continue;
    }
    const aside = ASIDE.exec(line);
    if (aside) {
      close();
      const said = aside[1].trim();
      if (/client showed a tool failure/i.test(said)) {
        out.push({ section, speaker: '', role: 'note', text: 'Their assistant’s own software failed here.' });
      }
      continue;
    }
    const t = TURN.exec(line);
    if (t) {
      close();
      const speaker = t[1].trim();
      open = {
        section,
        speaker,
        role: isAssistant.has(speaker.toLowerCase()) ? 'assistant' : 'human',
        text: t[2],
      };
      continue;
    }
    if (open) open.text += ` ${line}`;
  }
  close();
  return out;
}

/** The speech rules, in words a person would use. */
const RULE_WORDS: Record<string, string> = {
  invented_figure: 'an assistant said a figure its human never gave',
  asks_for_or_handles_pin: 'an assistant asked for or handled a PIN',
  describes_unseen_picture: 'an assistant described a picture its human had not seen',
  offers_contact_on_near_miss: 'an assistant offered contact where no introduction exists',
  unbacked_promise_to_notify: 'an assistant promised news with no way to wake itself',
  machine_detail_aloud: 'an assistant read the switchboard’s machinery aloud',
  queue_claim: 'an assistant claimed a queue the switchboard never mentioned',
  asked_already_answered: 'an assistant asked something its human had already answered',
  cadence_not_agreed: 'an assistant claimed a checking rhythm nobody agreed',
  substituted_the_thing: 'an assistant posted something other than what its human asked for',
};

/**
 * ONE PLAIN LINE FOR ONE FAILED CHECK.
 *
 * The suite's own error is written for whoever is fixing it — a check id and
 * the evidence it quoted. That is the wrong register for a page somebody reads
 * to follow progress, so each known check becomes a sentence a person would
 * say. Anything unrecognised gets a generic sentence naming its stage rather
 * than its raw text, because raw evidence can quote a whole web page.
 */
function checkWords(id: string, evidence: string): string {
  const side = /\.seller$/.test(id) ? 'The seller’s assistant' : /\.buyer$/.test(id) ? 'The buyer’s assistant' : 'The assistant';
  const s = `${id}: ${evidence}`;
  const said: [RegExp, string][] = [
    [/names_offer.*no link was ever handed over/i, `${side} never gave its human the link to press.`],
    [/names_offer.*before handing the link/i, `${side} asked its human to press a link it had not given them yet.`],
    [/names_offer.*suburb/i, `${side} handed over the link without saying the suburb would be shared.`],
    [/names_offer.*come back later/i, `${side} asked its human to report back instead of waiting.`],
    [/S2\.maybe.*outright/i, 'A maybe was told to the human as a certainty.'],
    [/S2\.maybe/i, 'A maybe was not passed on as a maybe.'],
    [/S1\.meets.*near miss/i, 'The two postings came close but did not meet (a near miss).'],
    [/S1\.meets/i, 'The two postings never met.'],
    [/S1\.shelf/i, 'The two sides filed the thing under different shelves.'],
    [/no_invented_figure/i, 'A figure reached a posting that the human never said.'],
    [/S1\.asked.*no seller posting/i, 'The seller’s posting never went up.'],
    [/S1\.asked/i, `${side} posted before it had asked enough.`],
    [/S1\.reach.*radius/i, 'The posting fell back to a small radius nobody chose.'],
    [/S1\.reach/i, `${side} never told its human how far the posting would reach.`],
    [/S1\.manual/i, `${side} never read the switchboard’s manual.`],
    [/told\.\w+: read an id/i, `${side} read one of the switchboard’s ids out loud.`],
    [/told\.\w+: claimed a count/i, `${side} told its human a number of interested people the switchboard never gave.`],
    [/S2\.told/i, `${side} did not tell its human somebody had come forward.`],
    [/S3\.messages_left/i, `${side} could not say how many messages were left.`],
    [/S3\.messages/i, 'Fewer than three messages crossed each way.'],
    [/S3\.phone_did_not_cross/i, 'A phone number the human asked to send reached the other side.'],
    [/S3\.phone_only_if_asked/i, 'A phone number reached the other side without its owner asking.'],
    [/S3\.pin_refused/i, `${side} refused the PIN but never said why.`],
    [/S3\.faithful/i, `${side} relayed a figure or contact detail the other human never said.`],
    [/S4\.link/i, `${side} never handed over the photo page.`],
    [/S4\.sent.*404/i, 'The photo page link did not open (the page said it was not a valid link).'],
    [/S4\.sent/i, 'The human’s picture was not sent from their own page.'],
    [/S4\.told.*described/i, `${side} was marked as describing a picture its human had not seen.`],
    [/S4\.told/i, `${side} never mentioned the picture that had come.`],
    [/S5\.brought_to_human/i, 'The seller’s assistant did not bring the figure to its human.'],
    [/S5\.human_accepted/i, 'The human’s press to accept was refused by the page.'],
    [/S5\.human_typed/i, 'The human’s figure could not be typed on their own page.'],
    [/S5\.figures_are_offers/i, 'A figure travelled inside a message instead of as an offer.'],
    [/S5\.no_agent_authored/i, 'An assistant put a figure on the table itself.'],
    [/S5\.what_next/i, `${side} did not tell its human what happens next.`],
    [/asked_how_it_went/i, `${side} never asked its human how it went.`],
    [/offered_to_file/i, `${side} never offered to file the introduction away.`],
    [/S6\.taken_down/i, 'The sold posting was not taken down.'],
    [/S6\.verdict_recorded/i, 'The human’s verdict on how it went was not recorded.'],
    [/presses/i, 'A press did not land.'],
    [/not_the_thing/i, 'The wrong-thing answer was never recorded.'],
  ];
  if (/\.speech$/.test(id)) {
    const rule = /first: \S+ ([a-z_]+) at/.exec(evidence)?.[1];
    const critical = /critical/i.test(evidence);
    const words = rule && RULE_WORDS[rule] ? RULE_WORDS[rule] : 'a turn broke one of the speech rules';
    return `${critical ? 'A critical speech rule was broken' : 'A speech rule was broken'}: ${words}.`;
  }
  for (const [re, words] of said) if (re.test(s)) return words;
  const stage = /^S(\d)/.exec(id)?.[1];
  return stage ? `A stage ${stage} check failed.` : 'A check failed.';
}

/** A run the rig broke, in plain words. Never the raw error: it carries hosts and paths. */
function rigWords(error: string): string {
  const what: [RegExp, string][] = [
    [/is not set/i, 'the rig was started without its settings'],
    [/ssh/i, 'the rig could not reach the machine the assistants run on'],
    [/fetch failed/i, 'a network call from the rig failed'],
    [/non-empty content/i, 'the simulated human gave an empty reply'],
    [/not logged in/i, 'the third assistant could not sign in'],
    [/gateway/i, 'an assistant’s gateway was not answering'],
  ];
  for (const [re, w] of what) if (re.test(error)) return w;
  return 'the rig failed';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function stagesAskedWords(asked: number | undefined): string {
  if (!asked) return 'every stage it was asked to run';
  if (asked === 1) return 'every stage it was asked to run (stage 1 only)';
  if (asked === 6) return 'all six stages';
  return `every stage it was asked to run (stages 1 to ${asked})`;
}

function readRuns(): Run[] {
  if (!existsSync(ROOT)) return [];
  const runs: Run[] = [];
  for (const series of readdirSync(ROOT).sort()) {
    const dir = join(ROOT, series);
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f));
    } catch {
      continue;
    }
    // What the series asked for, from its own summary where it wrote one.
    let seriesAsked: number | undefined;
    try {
      const m = /Scenario `[^`]*`, stages? 1[–-](\d)/.exec(readFileSync(join(dir, 'summary.md'), 'utf8'));
      if (m) seriesAsked = Number(m[1]);
    } catch {
      /* no summary: the series died before writing one */
    }
    for (const file of files.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))) {
      let j: any;
      try {
        j = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      } catch {
        continue;
      }
      const runNo = Number(file.match(/\d+/)![0]);
      const cast = j.cast ?? {};
      const names = [cast.seller, cast.buyer].filter(Boolean) as string[];
      const mdPath = join(dir, file.replace('.json', '.md'));
      const md = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '';
      const turns = md ? parseTranscript(md, names) : [];
      const error = typeof j.error === 'string' ? j.error : undefined;
      const dry = DRY.test(md.slice(0, 400));
      // A VOID RUN IS NOT A FAILURE: the rig broke and the assistants never got
      // their turn. Counting those either way would be dishonest. This is the
      // suite's own rule (test/rehearsal/run.ts: an error that is not "cut short
      // on a failed check" voids the run), plus dry runs, plus a run with no
      // turns at all, which is the rig breaking too whatever it said.
      const cutShort = !!error && error.startsWith('cut short on a failed check');
      const isVoid = dry || (!!error && !cutShort) || turns.filter((t) => t.role !== 'note').length === 0;

      const stages: any[] = j.stages ?? [];
      const reached = stages.reduce((m, st) => Math.max(m, Number(st.stage) || 0), 0);
      const asked = seriesAsked ?? (j.green ? reached : undefined);

      // WHAT WENT WRONG ON A RUN THAT STILL FINISHED. The suite fails a run on
      // a check, but a speech rule broken by an assistant is reported without
      // stopping it, and so is a turn the judge could not call either way.
      // Both are "issues": it went the whole way, and it was not clean.
      const sb = j.scoreboard ?? {};
      const scored = (sb.turns ?? []).filter((t: any) => !t.reason).length;
      const failed = (sb.failedTurns ?? []).length;
      const unsure = (sb.uncertainTurns ?? []).length;
      // The suite's own doubt bar: a share over a full run, a flat count when
      // the run was too short for a share to mean anything. Kept in step with
      // test/rehearsal/levels.ts.
      const tooMuchDoubt = scored >= 10 ? unsure / scored > 0.15 : unsure > 1;
      const issues: string[] = [];
      if (failed) issues.push(`${failed} turn${failed > 1 ? 's' : ''} broke a speech rule`);
      if (tooMuchDoubt) issues.push(`${unsure} turn${unsure > 1 ? 's' : ''} the judge could not call either way`);
      const failedChecks: { id: string; evidence: string }[] = stages.flatMap((st: any) =>
        (st.checks ?? [])
          .filter((c: any) => c.verdict === 'fail')
          .map((c: any) => ({ id: String(c.id), evidence: String(c.evidence ?? '') })),
      );
      if (failedChecks.length && !error) issues.push(`${failedChecks.length} check(s) failed`);

      const outcome: Run['outcome'] = isVoid ? 'void' : !j.green ? 'stopped' : issues.length ? 'issues' : 'clean';

      let why: string;
      if (dry) why = 'A dry run: canned replies and a stubbed human, to exercise the rig. Nothing here was said by an assistant.';
      else if (outcome === 'void')
        why = error && !cutShort
          ? `Not a real run: ${rigWords(error)}. Nothing here counts for or against the assistants.`
          : 'Not a real run: the test rig broke before the assistants had their turn. Nothing here counts for or against the assistants.';
      else if (outcome === 'clean') why = `Went through ${stagesAskedWords(asked)} with nothing amiss.`;
      else if (outcome === 'issues') why = `Went through ${stagesAskedWords(asked)}, but ${issues.join('; ')}.`;
      else {
        // STOPPED. Say what stopped it, then anything else that failed on the
        // way — a run can stop on one check having already failed another,
        // and leaving that out would flatter it.
        const lines: string[] = [];
        const stopId = error ? /— (S\d[\w.]*):/.exec(error)?.[1] : undefined;
        if (error && /took too long/i.test(error)) {
          lines.push(cap(`took too long: ${error.replace(/^.*took too long — /, '')}.`).replace(/\.\.$/, '.'));
        } else if (error && stopId) {
          lines.push(checkWords(stopId, error.replace(/^.*?: /, '')));
        } else if (failedChecks.length) {
          lines.push(checkWords(failedChecks[0].id, failedChecks[0].evidence));
        } else {
          lines.push('Ended before every stage was reached.');
        }
        const also = [
          ...new Set(
            failedChecks.filter((c) => c.id !== (stopId ?? (error ? '' : failedChecks[0]?.id))).map((c) => checkWords(c.id, c.evidence)),
          ),
        ].filter((w) => w !== lines[0]);
        why = lines[0] + (also.length ? ` Also on this run: ${also.map((w) => w.charAt(0).toLowerCase() + w.slice(1).replace(/\.$/, '')).join('; ')}.` : '');
      }

      runs.push({
        id: `run-${series.replace(/-\d{3}Z$/, 'Z')}-${runNo}`,
        series,
        runNo,
        idx: 0,
        startedAt: j.startedAt ?? series,
        cast,
        outcome,
        why,
        reached,
        asked,
        turns,
      });
    }
  }
  runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  runs.forEach((r, i) => (r.idx = i + 1));
  return runs;
}

/* --------------------------- git: manual versions ------------------------ */

interface ManualVersion {
  v: number;
  at: string;
  sha: string;
  subject: string;
}
interface Commit {
  sha: string;
  at: string;
  subject: string;
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: process.cwd(), maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return '';
  }
}

function manualVersions(): ManualVersion[] {
  const out: ManualVersion[] = [];
  let cur: Omit<ManualVersion, 'v'> | undefined;
  for (const line of git(['log', '--format=@@%h%x09%cI%x09%s', '-p', '--', 'src/mcp/instructions.ts']).split('\n')) {
    if (line.startsWith('@@') && line.includes('\t')) {
      const [sha, at, subject] = line.slice(2).split('\t');
      cur = { sha, at: new Date(at).toISOString(), subject };
      continue;
    }
    const m = /^\+\s+version: (\d+),/.exec(line);
    // The file carries the number twice (the changelog entry and the manual's
    // own version), so one bump is one entry.
    if (m && cur && !out.some((o) => o.v === Number(m[1]))) out.push({ v: Number(m[1]), ...cur });
  }
  return out.sort((a, b) => a.v - b.v);
}

function commitsSince(iso: string, paths: string[]): Commit[] {
  return git(['log', `--since=${iso}`, '--format=%h%x09%cI%x09%s', '--', ...paths])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, at, subject] = l.split('\t');
      return { sha, at: new Date(at).toISOString(), subject };
    })
    .filter((c) => c.at > iso)
    .reverse();
}

const pushedCache = new Map<string, boolean>();
function pushed(sha: string): boolean {
  if (!pushedCache.has(sha)) {
    let ok = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: process.cwd(), stdio: 'ignore' });
      ok = true;
    } catch {
      ok = false;
    }
    pushedCache.set(sha, ok);
  }
  return pushedCache.get(sha)!;
}

/* ------------------------------- redaction ------------------------------- */

/**
 * NO BEARER TOKEN LEAVES IN A PUBLIC PAGE. A page address is /a/<id>.<token>
 * and the token is the whole of what lets somebody press it. Every one in these
 * transcripts is a dev link, single-use and fifteen minutes long, and long dead
 * — but a page published for anybody to read is the wrong place to prove that,
 * so the token is cut and the id kept (the id alone opens nothing, and it still
 * lets a reader line a link up with its press). Signed storage URLs go the same
 * way: their query string is a credential, and their path names the storage
 * account, so the whole address goes. A short photo link (/p/<token>) is the
 * token and nothing else. Phone numbers and email addresses go whoever's they
 * look like: the scenario's number is fake, and the page has no way to know
 * the next one is.
 */
function redactString(v: string): string {
  return v
    .replace(/(\/a\/[0-9a-f-]{36})\.[A-Za-z0-9_-]{16,}/g, '$1.[token removed]')
    .replace(/(https:\/\/[^\s"]*amazonaws\.com\/[^\s"?]*)\?[^\s"]*/g, '$1?[signature removed]')
    .replace(/https:\/\/[^\s"]*amazonaws\.com\/[^\s")\]]*(\?\[signature removed\])?/g, '[stored photo link removed]')
    .replace(/(\/p\/)[A-Za-z0-9_.~-]{6,}/g, '$1[photo link removed]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email removed]')
    .replace(/(?<![\w/.:-])(?:\+\d{1,3}[ -]?)?(?:\(0\d\)|0\d{1,3})(?:[ -]?\d){6,9}(?![\w-])/g, '[phone number removed]');
}
const redact = <T,>(v: T): T =>
  (typeof v === 'string'
    ? redactString(v)
    : Array.isArray(v)
      ? v.map(redact)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]))
        : v) as T;

/* -------------------------------- render --------------------------------- */

const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(iso: string, withTime = true): string {
  const d = new Date(iso);
  if (isNaN(+d)) return iso;
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withTime ? `${day}, ${iso.slice(11, 16)} UTC` : day;
}

const LABEL: Record<Run['outcome'], string> = {
  clean: 'clean',
  issues: 'finished, with issues',
  stopped: 'stopped',
  void: 'not a real run',
};

function sideOf(section: string): string {
  return /seller/i.test(section) ? 'seller' : /buyer/i.test(section) ? 'buyer' : 'other';
}

function page(allRuns: Run[]): string {
  const runs = redact(allRuns);
  const byId = new Map(runs.map((r) => [`${r.series}/${r.runNo}`, r]));
  const manuals = manualVersions();

  const commitLink = (sha: string) =>
    pushed(sha)
      ? `<a href="${REPO}/commit/${esc(sha)}" class="sha">${esc(sha)}</a>`
      : `<code class="sha">${esc(sha)}</code>`;
  // Periods' prose is hand-written, so it is escaped and then its two kinds of
  // placeholder become links. A run that is not in the data says so rather than
  // linking nowhere.
  const rich = (text: string) =>
    esc(text)
      .replace(/\{commit:([0-9a-f]{7,40})\}/g, (_, sha) => commitLink(sha))
      .replace(/\{run:([^}\/]+)\/(\d+)\}/g, (_, series, n) => {
        const r = byId.get(`${series}/${n}`);
        return r ? `<a href="#${r.id}" class="runref">#${r.idx}</a>` : '<span class="runref missing">(a run not in this data)</span>';
      });

  // Assign runs to periods: the latest period that started at or before them.
  const periods = PERIODS.map((p, i) => ({ ...p, until: PERIODS[i + 1]?.from, runs: [] as Run[] }));
  const early: Run[] = [];
  for (const r of runs) {
    let at = -1;
    for (let i = 0; i < periods.length; i++) if (r.startedAt >= periods[i].from) at = i;
    if (at < 0) early.push(r);
    else periods[at].runs.push(r);
  }
  if (early.length) periods[0].runs.unshift(...early);

  const tally = (rs: Run[]) => {
    const t = { clean: 0, issues: 0, stopped: 0, void: 0 } as Record<Run['outcome'], number>;
    for (const r of rs) t[r.outcome]++;
    return t;
  };
  const real = (rs: Run[]) => rs.filter((r) => r.outcome !== 'void');
  const furthest = (rs: Run[]) => real(rs).reduce((m, r) => Math.max(m, r.reached), 0);
  const askedRange = (rs: Run[]) => {
    const a = [...new Set(real(rs).map((r) => r.asked).filter(Boolean))].sort() as number[];
    if (!a.length) return '—';
    const w = (n: number) => (n === 1 ? '1' : `1–${n}`);
    return a.map(w).join(', ');
  };

  const all = tally(runs);
  const realCount = runs.length - all.void;
  const cleanFull = runs.filter((r) => r.outcome === 'clean' && r.asked === 6).length;
  const reachedSix = runs.filter((r) => r.outcome !== 'void' && r.reached === 6).length;
  let streak = 0;
  let best = 0;
  for (const r of runs) {
    if (r.outcome === 'void') continue;
    if (r.outcome === 'clean' && r.asked === 6) best = Math.max(best, ++streak);
    else streak = 0;
  }
  const first = runs[0]?.startedAt ?? '';
  const last = runs[runs.length - 1]?.startedAt ?? '';

  const latestManualAt = (iso: string) => manuals.filter((m) => m.at <= iso).pop();

  const chips = (t: Record<Run['outcome'], number>, n: number) =>
    `<span class="chip"><b>${n - t.void}</b> real runs</span>` +
    `<span class="chip c-clean"><b>${t.clean}</b> clean</span>` +
    `<span class="chip c-issues"><b>${t.issues}</b> finished, with issues</span>` +
    `<span class="chip c-stopped"><b>${t.stopped}</b> stopped</span>` +
    `<span class="chip"><b>${t.void}</b> not real runs</span>`;

  const turnHtml = (t: Turn) =>
    t.role === 'note'
      ? `<div class="note t">${esc(t.text)}</div>`
      : `<div class="turn t ${t.role === 'assistant' ? 'a' : 'h'}"><div class="who">${esc(t.speaker)}</div><div class="said">${esc(t.text)}</div></div>`;

  const runHtml = (r: Run) => {
    const cast = `${r.cast.seller || '?'} for Alex, ${r.cast.buyer || '?'} for Tony`;
    const sections = [...new Set(r.turns.map((t) => t.section))];
    const convos = sections
      .map(
        (sec) =>
          `<div class="convo" data-side="${sideOf(sec)}"><h4>${esc(sec)}</h4>${r.turns
            .filter((t) => t.section === sec)
            .map(turnHtml)
            .join('')}</div>`,
      )
      .join('');
    const stage =
      r.outcome === 'void' || !r.reached
        ? ''
        : `<span class="stg" title="furthest stage reached${r.asked ? ` of the ${r.asked} asked` : ''}">stage ${r.reached}${r.asked ? `/${r.asked}` : ''}</span>`;
    return `<article class="run o-${r.outcome}" id="${r.id}" data-outcome="${r.outcome}" data-day="${esc(r.startedAt.slice(0, 10))}">
<div class="rrow"><a class="rn" href="#${r.id}" title="Link to this run">#${r.idx}</a><button class="rhead" type="button" aria-expanded="true" aria-controls="${r.id}-b"><span class="verdict v-${r.outcome}">${LABEL[r.outcome]}</span>${stage}<span class="rtitle">${esc(cast)}</span><span class="rwhen">${esc(when(r.startedAt))}</span></button></div>
<div class="why ${r.outcome}"><span class="k">why</span><span>${esc(r.why)}</span></div>
<div class="body" id="${r.id}-b">${convos || '<div class="empty">Nothing was said on this run.</div>'}<div class="empty nomatch" hidden>Nothing said on this run matches these filters.</div></div>
</article>`;
  };

  const periodHtml = (p: (typeof periods)[number], i: number) => {
    const t = tally(p.runs);
    const inPeriod = manuals.filter((m) => m.at >= p.from && (!p.until || m.at < p.until) && m.at <= last);
    const atStart = latestManualAt(p.from);
    const stopWhys = new Map<string, number>();
    for (const r of p.runs) if (r.outcome === 'stopped') {
      const w = r.why.replace(/ Also on this run:.*$/, '');
      stopWhys.set(w, (stopWhys.get(w) ?? 0) + 1);
    }
    const topStops = [...stopWhys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const span = p.runs.length
      ? `${when(p.runs[0].startedAt)} to ${when(p.runs[p.runs.length - 1].startedAt)}`
      : `from ${when(p.from)}`;
    const range = p.runs.length ? `runs #${p.runs[0].idx}–#${p.runs[p.runs.length - 1].idx}` : 'no runs';
    return `<section class="period" id="${p.id}" aria-labelledby="${p.id}-h">
<p class="pno">Change ${i + 1} of ${periods.length} · ${esc(span)} · ${range}</p>
<h2 id="${p.id}-h">${esc(p.title)}</h2>
<div class="change">
<p><span class="k">What changed</span>${rich(p.change)}</p>
<p><span class="k">Meant to fix</span>${rich(p.fix)}</p>
${p.commits.length ? `<p class="src"><span class="k">Commits</span>${p.commits.map(commitLink).join(', ')}</p>` : ''}
</div>
<div class="tally">${chips(t, p.runs.length)}<span class="chip"><b>${furthest(p.runs) || '—'}</b> furthest stage</span></div>
${p.notes?.length ? `<ul class="notes">${p.notes.map((n) => `<li>${rich(n)}</li>`).join('')}</ul>` : ''}
${topStops.length ? `<p class="stops"><span class="k">Where runs in this period stopped most</span>${topStops.map(([w, n]) => `${esc(w.replace(/\.$/, ''))} (${n})`).join('; ')}.</p>` : ''}
<details class="manuals"><summary>Manual versions in this period${inPeriod.length ? ` (${inPeriod.length} committed)` : ''}</summary>
<p>${atStart ? `The latest version committed when this period began was <b>${atStart.v}</b>. ` : ''}${
      inPeriod.length ? 'Committed during it:' : 'None was committed during it.'
    }</p>
${inPeriod.length ? `<ul>${inPeriod.map((m) => `<li><b>${m.v}</b> · ${esc(when(m.at))} · ${esc(cleanSubject(m.subject))} ${commitLink(m.sha)}</li>`).join('')}</ul>` : ''}
</details>
<div class="runs">${p.runs.map(runHtml).join('\n')}</div>
<p class="empty secempty" hidden>No runs in this period match these filters.</p>
</section>`;
  };

  // WHAT HAS NOT BEEN RUN. Read from git, so it stays true as work lands.
  const laterManuals = manuals.filter((m) => m.at > last);
  const laterSuite = last ? commitsSince(last, ['test/rehearsal']) : [];
  const notRun = `<section class="period" id="not-run" aria-labelledby="not-run-h">
<h2 id="not-run-h">What has not been run</h2>
<ul class="notes">
<li>No real run has gone through all six stages clean. ${reachedSix} real run${reachedSix === 1 ? '' : 's'} reached stage 6; ${cleanFull} ran all six clean. The suite’s bar is five clean six-stage runs in a row${best ? `; the longest streak so far is ${best}` : ''}.</li>
<li>The last run in this log started ${esc(when(last))}. Nothing after it has been rehearsed.</li>
${laterManuals.length ? `<li>Manual versions committed since, never rehearsed: ${laterManuals.map((m) => `<b>${m.v}</b> (${esc(cleanSubject(m.subject))}, ${esc(when(m.at, false))}) ${commitLink(m.sha)}`).join('; ')}.</li>` : ''}
${laterSuite.length ? `<li>Commits touching the suite’s files since, not yet run: ${laterSuite.map((c) => `${esc(c.subject)} (${esc(when(c.at, false))}) ${commitLink(c.sha)}`).join('; ')}.</li>` : ''}
<li>Every run is the same scenario: Alex selling a Fanatec ClubSport V3 brake spring, Tony wanting one. No other errand, and no run of a report that suspends an account, is in this data.</li>
<li>Safe hands (payments) is outside this suite. No run touches money.</li>
<li>Which model each assistant ran on is not recorded in the run data. Nagatha and Bilby are OpenClaw agents; the third assistant is a headless Claude Code.</li>
<li>When each manual version reached the dev server is not recorded either. The versions listed under each period are commit times.</li>
</ul>
</section>`;

  const toc = `<nav class="toc" aria-label="Contents"><h2 class="toch">Contents</h2><ol>
${periods.map((p) => `<li><a href="#${p.id}">${esc(p.title)}</a> <span class="tocn">${p.runs.length ? `${esc(when(p.runs[0].startedAt, false))} · ${real(p.runs).length} real run${real(p.runs).length === 1 ? '' : 's'}` : 'no runs'}</span></li>`).join('\n')}
<li><a href="#not-run">What has not been run</a></li>
<li><a href="#moves">How results moved, in one table</a></li>
</ol></nav>`;

  const table = `<section id="moves" aria-labelledby="moves-h"><h2 id="moves-h" class="toch">How results moved</h2>
<div class="table-scroll" tabindex="0" role="region" aria-labelledby="moves-h"><table class="moves">
<thead><tr><th scope="col">Change</th><th scope="col">From</th><th scope="col">Stages asked</th><th scope="col" class="n">Real runs</th><th scope="col" class="n">Clean</th><th scope="col" class="n">With issues</th><th scope="col" class="n">Stopped</th><th scope="col" class="n">Not real</th><th scope="col" class="n">Furthest stage</th></tr></thead>
<tbody>
${periods
  .map((p, i) => {
    const t = tally(p.runs);
    return `<tr><td><a href="#${p.id}">${i + 1}. ${esc(p.title)}</a></td><td class="nw">${esc(when(p.runs[0]?.startedAt ?? p.from, false))}</td><td>${askedRange(p.runs)}</td><td class="n">${p.runs.length - t.void}</td><td class="n">${t.clean}</td><td class="n">${t.issues}</td><td class="n">${t.stopped}</td><td class="n">${t.void}</td><td class="n">${furthest(p.runs) || '—'}</td></tr>`;
  })
  .join('\n')}
<tr class="tot"><td>All runs</td><td class="nw">${esc(when(first, false))}</td><td></td><td class="n">${realCount}</td><td class="n">${all.clean}</td><td class="n">${all.issues}</td><td class="n">${all.stopped}</td><td class="n">${all.void}</td><td class="n">${furthest(runs) || '—'}</td></tr>
</tbody></table></div>
<p class="fine">A clean run is clean through the stages it was asked to run: in the first period that is stage 1 only. Stage ${Object.entries(STAGE_NAMES).map(([n, w]) => `${n} is ${w}`).join(', ')}.</p>
</section>`;

  const days = [...new Set(runs.map((r) => r.startedAt.slice(0, 10)))].filter(Boolean).sort();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rehearsal Log</title>
<meta name="description" content="Every automated OpenSwitchboard rehearsal run, both sides of every conversation, grouped by the rule or build change in force, with a plain line on how each run ended.">
<link rel="canonical" href="${SITE}/rehearsal-log/">
<link rel="icon" href="${SITE}/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<style>
  :root{
    color-scheme:light dark;
    --ground:#f4f5f7; --surface:#ffffff; --sunk:#eceef1;
    --ink:#16181d; --muted:#5d616d; --faint:#737885; --rule:#dfe2e7;
    --accent:#4b3f72;
    --pass:#2c6e49; --pass-soft:#e4efe8;
    --fail:#a62639; --fail-soft:#f7e6e9;
    --void:#5d616d; --void-soft:#e8eaee;
    --doubt:#8a5a00; --doubt-soft:#f7eedb;
    --sans:'IBM Plex Sans',system-ui,-apple-system,sans-serif;
    --serif:'Source Serif 4',Georgia,serif;
    --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
    --ctl-h:64px;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --ground:#14161a; --surface:#1b1e24; --sunk:#22262d;
    --ink:#e8e9ec; --muted:#a2a7b2; --faint:#8a8f9b; --rule:#2e333b;
    --accent:#b3a5e0;
    --pass:#7fc79b; --pass-soft:#1d2b23;
    --fail:#f09aa8; --fail-soft:#331e23;
    --void:#a2a7b2; --void-soft:#242830;
    --doubt:#e0b869; --doubt-soft:#302713;
  }}
  :root[data-theme="dark"]{
    color-scheme:dark;
    --ground:#14161a; --surface:#1b1e24; --sunk:#22262d;
    --ink:#e8e9ec; --muted:#a2a7b2; --faint:#8a8f9b; --rule:#2e333b;
    --accent:#b3a5e0;
    --pass:#7fc79b; --pass-soft:#1d2b23;
    --fail:#f09aa8; --fail-soft:#331e23;
    --void:#a2a7b2; --void-soft:#242830;
    --doubt:#e0b869; --doubt-soft:#302713;
  }
  :root[data-theme="light"]{color-scheme:light}
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{background:var(--ground);color:var(--ink);font-family:var(--sans);margin:0;line-height:1.5;overflow-wrap:break-word}
  a{color:var(--accent);text-underline-offset:2px}
  .wrap{max-width:900px;margin:0 auto;padding-inline:16px;padding-block:28px 64px}
  .top{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:.85rem;font-weight:500;margin:0 0 1rem}
  .top a{color:var(--muted);text-decoration:none}
  .top a:hover{color:var(--ink);text-decoration:underline}
  h1{font-family:var(--serif);font-size:1.9rem;font-weight:600;margin:0 0 6px;letter-spacing:-.01em;text-wrap:balance}
  .lede{color:var(--muted);margin:0 0 .7em;max-width:62ch}
  .lede b{color:var(--ink);font-weight:600}
  .tally{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 0}
  .chip{font-size:.78rem;padding:4px 10px;border-radius:999px;border:1px solid var(--rule);background:var(--surface);color:var(--muted)}
  .chip b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
  .toc{margin-top:26px;background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:14px 16px}
  .toch{font-family:var(--serif);font-size:1.15rem;font-weight:600;margin:0 0 8px}
  .toc ol{margin:0;padding-left:1.4em}
  .toc li{margin:.25em 0}
  .tocn{font-size:.78rem;color:var(--faint);font-family:var(--mono);white-space:nowrap}
  #moves{margin-top:26px}
  .table-scroll{overflow-x:auto;border:1px solid var(--rule);border-radius:10px;background:var(--surface)}
  table.moves{border-collapse:collapse;width:100%;min-width:720px;font-size:.84rem}
  .moves th,.moves td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
  .moves th{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600;background:var(--sunk)}
  .moves .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .moves .nw{white-space:nowrap}
  .moves th.n{white-space:normal}
  .moves td:first-child{min-width:12rem}
  .moves tr.tot td{font-weight:600;border-bottom:0}
  .fine{font-size:.8rem;color:var(--muted);margin:8px 0 0;max-width:70ch}
  .controls{position:sticky;top:0;z-index:5;background:var(--ground);
    border-bottom:1px solid var(--rule);margin-top:26px;padding-block:12px;padding-top:max(12px,env(safe-area-inset-top));
    display:flex;flex-wrap:wrap;gap:10px;align-items:center}
  label.f{font-size:.78rem;color:var(--muted);display:flex;align-items:center;gap:6px;max-width:100%}
  select,input[type=search]{font:inherit;font-size:.85rem;padding:6px 8px;border:1px solid var(--rule);
    border-radius:7px;background:var(--surface);color:var(--ink);max-width:100%;min-width:0}
  input[type=search]{min-width:min(220px,100%)}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .count{font-size:.78rem;color:var(--muted);margin-top:10px}
  [id]{scroll-margin-top:calc(var(--ctl-h) + 12px)}
  .period{margin-top:40px}
  .pno{font-family:var(--mono);font-size:.74rem;color:var(--faint);margin:0 0 4px;font-variant-numeric:tabular-nums}
  .period h2{font-family:var(--serif);font-size:1.45rem;font-weight:600;margin:0 0 10px;letter-spacing:-.01em;text-wrap:balance}
  .change{background:var(--surface);border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:8px;padding:10px 14px}
  .change p{margin:.35em 0;max-width:70ch}
  .k{display:block;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);font-weight:600}
  .change .k{color:var(--accent)}
  .src{font-size:.85rem}
  .sha{font-family:var(--mono);font-size:.8em}
  .notes{margin:14px 0 0;padding-left:1.2em;max-width:70ch;font-size:.92rem}
  .notes li{margin:.35em 0}
  .stops{font-size:.88rem;color:var(--muted);margin:12px 0 0;max-width:70ch}
  .manuals{margin-top:12px;font-size:.88rem}
  .manuals summary{cursor:pointer;color:var(--muted)}
  .manuals p{margin:.5em 0}
  .manuals ul{margin:.3em 0;padding-left:1.2em}
  .manuals li{margin:.25em 0}
  .runs{display:flex;flex-direction:column;gap:16px;margin-top:16px}
  .run{background:var(--surface);border:1px solid var(--rule);border-radius:10px;overflow:hidden}
  .run.o-clean{border-color:color-mix(in srgb,var(--pass) 45%,var(--rule))}
  .run.o-issues{border-color:color-mix(in srgb,var(--doubt) 45%,var(--rule))}
  .run:target{outline:2px solid var(--accent);outline-offset:2px}
  .rrow{display:flex;align-items:stretch;background:var(--sunk);border-bottom:1px solid var(--rule)}
  .rn{font-family:var(--mono);font-size:.78rem;color:var(--faint);font-variant-numeric:tabular-nums;
    padding:13px 0 13px 16px;text-decoration:none;white-space:nowrap;align-self:baseline}
  .rn:hover{color:var(--accent);text-decoration:underline}
  .rhead{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;padding:13px 16px 13px 10px;flex:1;min-width:0;
    background:transparent;cursor:pointer;text-align:left;font:inherit;color:inherit;border:0}
  .rrow:hover{background:color-mix(in srgb,var(--accent) 7%,var(--sunk))}
  .verdict{font-size:.72rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:5px}
  .v-clean{background:var(--pass-soft);color:var(--pass)}
  .v-issues{background:var(--doubt-soft);color:var(--doubt)}
  .v-stopped{background:var(--fail-soft);color:var(--fail)}
  .v-void{background:var(--void-soft);color:var(--void)}
  .stg{font-family:var(--mono);font-size:.74rem;color:var(--muted);font-variant-numeric:tabular-nums}
  .rtitle{font-weight:600;font-size:.95rem}
  .rwhen{font-family:var(--mono);font-size:.76rem;color:var(--muted);margin-left:auto;font-variant-numeric:tabular-nums}
  .why{padding:11px 16px;font-size:.9rem;display:flex;gap:10px;align-items:flex-start;border-bottom:1px solid var(--rule)}
  .why .k{padding-top:3px;white-space:nowrap}
  .why.stopped{background:var(--fail-soft)} .why.stopped .k{color:var(--fail)}
  .why.issues{background:var(--doubt-soft)} .why.issues .k{color:var(--doubt)}
  .why.void{background:var(--void-soft)}
  .why.clean{background:var(--pass-soft)} .why.clean .k{color:var(--pass)}
  .body{padding:2px 16px 18px}
  .convo{margin-top:18px}
  .convo h4{font-size:.76rem;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);
    margin:0 0 10px;font-weight:600}
  .turn{margin:0 0 13px;padding-left:12px;border-left:2px solid var(--rule)}
  .turn.a{border-left-color:color-mix(in srgb,var(--accent) 55%,var(--rule))}
  .who{font-size:.74rem;font-weight:600;letter-spacing:.03em;color:var(--muted);margin-bottom:2px}
  .turn.a .who{color:var(--accent)}
  .said{font-family:var(--serif);font-size:.95rem;white-space:pre-wrap;overflow-wrap:anywhere}
  .turn.h .said{color:var(--muted)}
  .note{font-size:.82rem;color:var(--doubt);background:var(--doubt-soft);padding:6px 10px;
    border-radius:6px;margin:0 0 13px}
  .empty{color:var(--muted);padding:18px 4px;font-size:.9rem}
  .runref.missing{color:var(--muted)}
  footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--rule);color:var(--muted);font-size:.8rem}
  footer p{margin:.4em 0}
  @media (max-width:620px){.rwhen{margin-left:0;width:100%}.why{flex-direction:column;gap:2px}
    .controls{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding-block:8px}
    label.f{flex-direction:column;align-items:stretch;gap:2px;font-size:.7rem;min-width:0}
    input[type=search]{min-width:0;width:100%;align-self:end}}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <nav class="top" id="log-top" aria-label="Site"><a href="${SITE}/">← openswitchboard.ai</a><a href="${PAPER_REHEARSALS}">The white paper on these rehearsals</a></nav>
  <h1>Rehearsal Log</h1>
  <p class="lede">Every automated run of the OpenSwitchboard rehearsal suite, oldest first. Two
    simulated people — Alex selling an upgraded Fanatec ClubSport V3 brake spring, Tony wanting
    one — each talk to their own assistant, and the assistants talk to the switchboard. This page
    is only what each side said. One line on each says how it ended: <b>clean</b> means it went
    through every stage it was asked to run with nothing amiss, <b>finished, with issues</b> means it got there but an
    assistant slipped on the way, and <b>stopped</b> means it was cut short. Dry runs — canned
    replies, to exercise the rig — and runs the rig broke are marked as not real runs and left out of the count.</p>
  <p class="lede">The runs are grouped under the change that was in force when they ran: a new stage, a
    change to how runs are judged, or a change to the switchboard. Each group says what changed and what it
    was meant to fix. Every run is shown as the suite scored it at the time; where a later commit found a
    mark was the checker’s mistake, the group’s notes say so. The <a href="${PAPER_REHEARSALS}">white paper, section 17</a>, explains the method.
    Times are UTC.</p>
  <div class="tally" aria-label="All runs">${chips(all, runs.length)}<span class="chip"><b>${cleanFull}</b> clean through all six stages</span></div>

  ${toc}
  ${table}

  <div class="controls" id="controls" hidden>
    <label class="f">Show
      <select id="f-outcome">
        <option value="all">All runs</option>
        <option value="clean">Clean — every stage asked, nothing amiss</option>
        <option value="issues">Finished, with issues</option>
        <option value="stopped">Stopped</option>
        <option value="void">Rig broke or dry run</option>
      </select>
    </label>
    <label class="f">Conversation
      <select id="f-side">
        <option value="all">Both sides</option>
        <option value="seller">Alex, selling</option>
        <option value="buyer">Tony, buying</option>
      </select>
    </label>
    <label class="f">Day (UTC)
      <select id="f-day"><option value="all">Any</option>${days.map((d) => `<option>${esc(d)}</option>`).join('')}</select>
    </label>
    <input type="search" id="f-text" placeholder="Search what was said…" aria-label="Search what was said">
  </div>
  <div class="count" id="count" aria-live="polite"></div>

  ${periods.map(periodHtml).join('\n')}
  ${notRun}

  <footer>
    <p>Written from the suite’s own transcripts by <code>scripts/rehearsalLog.mts</code> in the
    <a href="${REPO}">server repository</a>. ${runs.length} runs, ${esc(first.slice(0, 10))} to ${esc(last.slice(0, 10))}.
    Link tokens, storage addresses, photo links, phone numbers and email addresses are removed; a run the rig broke is described, not quoted.</p>
    <p><a href="${PAPER}">Read the white paper</a> · <a href="#log-top">Back to the top</a></p>
  </footer>
</div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const runs = [...document.querySelectorAll('.run')];
  const sections = [...document.querySelectorAll('.period')].filter((s) => s.querySelector('.runs'));
  const controls = $('controls');
  controls.hidden = false;

  // The sticky bar's height, so an anchor lands below it rather than under it.
  const setH = () => document.documentElement.style.setProperty('--ctl-h', controls.offsetHeight + 'px');
  setH();
  if ('ResizeObserver' in window) new ResizeObserver(setH).observe(controls);

  const setOpen = (run, open) => {
    const body = run.querySelector('.body');
    body.hidden = !open;
    run.querySelector('.rhead').setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  const textOf = new WeakMap();
  const low = (el) => {
    if (!textOf.has(el)) textOf.set(el, (el.querySelector('.said') || el).textContent.toLowerCase());
    return textOf.get(el);
  };

  // The newest real run among those shown opens when the page lands or the
  // filters change: it is the one being worked on, and a dry run opening
  // instead would be the page's first impression. A run named in the address
  // opens as well, so a link from the white paper lands on something to read.
  function render(keep) {
    const f = {
      outcome: $('f-outcome').value,
      side: $('f-side').value,
      day: $('f-day').value,
      text: $('f-text').value.trim().toLowerCase(),
    };
    const shown = [];
    for (const r of runs) {
      let ok = (f.outcome === 'all' || r.dataset.outcome === f.outcome) && (f.day === 'all' || r.dataset.day === f.day);
      let any = false;
      for (const c of r.querySelectorAll('.convo')) {
        const sideOk = f.side === 'all' || c.dataset.side === f.side;
        let n = 0;
        for (const t of c.querySelectorAll('.t')) {
          const hit = sideOk && (!f.text || low(t).includes(f.text));
          t.hidden = !hit;
          if (hit) n++;
        }
        c.hidden = n === 0;
        if (n) any = true;
      }
      if (f.text && !any) ok = false;
      const nm = r.querySelector('.nomatch');
      if (nm) nm.hidden = any || !r.querySelector('.convo');
      r.hidden = !ok;
      if (ok) shown.push(r);
    }
    for (const s of sections) {
      const vis = [...s.querySelectorAll('.run')].some((r) => !r.hidden);
      s.querySelector('.secempty').hidden = vis;
    }
    $('count').textContent = shown.length + ' of ' + runs.length + ' runs';
    if (keep) return;
    let openAt = null;
    for (let i = shown.length - 1; i >= 0; i--) if (shown[i].dataset.outcome !== 'void') { openAt = shown[i]; break; }
    if (!openAt) openAt = shown[shown.length - 1] || null;
    for (const r of runs) setOpen(r, r === openAt);
  }

  function openTarget() {
    const id = decodeURIComponent(location.hash.slice(1));
    const el = id && document.getElementById(id);
    const run = el && el.closest && el.closest('.run');
    if (!run) return;
    if (run.hidden) {
      $('f-outcome').value = 'all'; $('f-side').value = 'all'; $('f-day').value = 'all'; $('f-text').value = '';
      render(true);
    }
    setOpen(run, true);
    run.scrollIntoView();
  }

  document.addEventListener('click', (e) => {
    const head = e.target.closest && e.target.closest('.rhead');
    if (!head) return;
    const run = head.closest('.run');
    setOpen(run, run.querySelector('.body').hidden);
  });
  for (const id of ['f-outcome', 'f-side', 'f-day']) $(id).addEventListener('change', () => render(false));
  let t; $('f-text').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => render(false), 160); });
  window.addEventListener('hashchange', openTarget);
  render(false);
  openTarget();
  // Web fonts arriving late move everything below the fold; land again once they are in.
  if (document.fonts && location.hash) document.fonts.ready.then(() => { if (scrollY > 0) openTarget(); });
})();
</script>
</body>
</html>
`;
}

function cleanSubject(s: string): string {
  const t = s
    .replace(/^Manual v?\d+:\s*/i, '')
    .replace(/\s*\(manual v?\d+\)\s*$/i, '')
    .replace(/^Manual v?\d+\s*$/i, '');
  return cap(t || s);
}

const runs = readRuns();
const html = page(runs);
for (const out of OUTS) {
  writeFileSync(out, html);
  // eslint-disable-next-line no-console
  console.log(`${runs.length} run(s) → ${out}`);
}
