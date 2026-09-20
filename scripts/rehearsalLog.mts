/**
 * EVERY REHEARSAL, AS ONE PAGE OF CONVERSATIONS.
 *
 * The suite writes each series to `realism-reports/rehearsal/<stamp>/` as a
 * markdown transcript plus a JSON of the checks. That is the right shape for a
 * machine and the wrong shape for a person: to follow what changed run over run
 * you end up opening thirty folders.
 *
 * This reads all of them and writes ONE self-contained page: every run in the
 * order it happened, showing WHAT EACH SIDE SAID and nothing else. The checks,
 * the speech marks and the tool calls are deliberately left out — they are in
 * the JSON for whoever wants them, and they drown the thing worth reading.
 * The only detail kept is one plain line saying why a run stopped.
 *
 *   npx tsx scripts/rehearsalLog.mts            # writes realism-reports/rehearsal-log.html
 *   npx tsx scripts/rehearsalLog.mts --out x.html
 *
 * IT IS ALSO THE RECORD WE CAN SHOW PEOPLE. The point of the suite is that the
 * failures are written down rather than smoothed over, so the void runs and the
 * runs that stopped on the first check stay in, and say which they were.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'realism-reports', 'rehearsal');
const argv = process.argv.slice(2);
const OUT =
  argv.indexOf('--out') >= 0
    ? argv[argv.indexOf('--out') + 1]
    : join(process.cwd(), 'realism-reports', 'rehearsal-log.html');

interface Turn {
  section: string;
  speaker: string;
  role: 'human' | 'assistant' | 'note';
  text: string;
}
interface Run {
  startedAt: string;
  cast: { seller?: string; buyer?: string };
  green: boolean;
  void: boolean;
  why: string;
  turns: Turn[];
}

const HEADING = /^#{1,6}\s+(.*)$/;
const TURN = /^\*\*([^*:]{1,60}):\*\*\s*(.*)$/;
const ASIDE = /^\*\((.*)\)\*\s*$/;

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

/**
 * ONE PLAIN LINE FOR WHY A RUN STOPPED.
 *
 * The suite's own error is written for whoever is fixing it — a check id and
 * the evidence it quoted. That is the wrong register for a page somebody reads
 * to follow progress, so each known check becomes a sentence a person would
 * say. Anything unrecognised falls through with its own words rather than
 * being flattened into "something went wrong", because a reason nobody can act
 * on is worse than a long one.
 */
function shortWhy(error: string | undefined, green: boolean, isVoid: boolean): string {
  if (green) return 'Ran the whole way through.';
  if (!error) return 'Ended before every stage was reached.';
  if (isVoid) return 'The test rig broke before the assistants had their turn. Nothing here is their doing.';
  const said: [RegExp, string][] = [
    [/names_offer.*no link was ever handed over/i, 'The assistant never gave its human the link to press.'],
    [/names_offer.*before handing the link/i, 'The assistant asked its human to press a link it had not given them yet.'],
    [/names_offer.*suburb/i, 'The link went over without saying the suburb would be shared.'],
    [/names_offer.*come back later/i, 'The assistant asked its human to report back instead of waiting.'],
    [/S2\.maybe.*outright/i, 'A maybe was told to the human as a certainty.'],
    [/S2\.maybe/i, 'A maybe was not passed on as a maybe.'],
    [/S1\.meets/i, 'The two postings never met.'],
    [/S1\.shelf/i, 'The two sides filed the thing under different shelves.'],
    [/no_invented_figure/i, 'A figure reached a posting that the human never said.'],
    [/S1\.asked/i, 'The assistant posted before it had asked enough.'],
    [/S1\.reach/i, 'The posting did not say how far it reached.'],
    [/told\./i, 'The assistant did not tell its human somebody had come forward.'],
    [/presses/i, 'A press did not land.'],
    [/not_the_thing/i, 'The wrong-thing answer was never recorded.'],
    [/manual/i, 'The assistant never came at the manual.'],
    [/unbacked_promise/i, 'An assistant promised to come back with no way to wake itself.'],
    [/invented_figure/i, 'An assistant said a figure of its own.'],
    [/queue_claim/i, 'An assistant claimed a queue the switchboard never mentioned.'],
    [/machine_detail/i, 'An assistant read the switchboard’s own machinery aloud.'],
    [/uncertain/i, 'Too many turns the judge could not call either way.'],
    [/speech/i, 'A turn broke one of the speech rules.'],
  ];
  for (const [re, words] of said) if (re.test(error)) return words;
  return error.replace(/^cut short on a failed check — /, '');
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
    for (const file of files.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))) {
      let j: any;
      try {
        j = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      } catch {
        continue;
      }
      const cast = j.cast ?? {};
      const names = [cast.seller, cast.buyer].filter(Boolean) as string[];
      const mdPath = join(dir, file.replace('.json', '.md'));
      const turns = existsSync(mdPath) ? parseTranscript(readFileSync(mdPath, 'utf8'), names) : [];
      const error = typeof j.error === 'string' ? j.error : undefined;
      // A VOID RUN IS NOT A FAILURE: the rig broke and the assistants never got
      // their turn. Counting those either way would be dishonest.
      const isVoid = !!error && /is not set|VOID|credentials|ECONNREFUSED|gateway/i.test(error);
      // A run with no turns at all is the rig breaking too, whatever it said.
      const empty = turns.filter((t) => t.role !== 'note').length === 0;
      runs.push({
        startedAt: j.startedAt ?? series,
        cast,
        green: !!j.green,
        void: isVoid || empty,
        why: shortWhy(error, !!j.green, isVoid || empty),
        turns,
      });
    }
  }
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function page(runs: Run[]): string {
  const data = JSON.stringify(runs).replace(/</g, '\\u003c');
  const first = runs[0]?.startedAt?.slice(0, 10) ?? '';
  const last = runs[runs.length - 1]?.startedAt?.slice(0, 10) ?? '';
  return `<title>Rehearsal Log</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<style>
  :root{
    --ground:#f4f5f7; --surface:#ffffff; --sunk:#eceef1;
    --ink:#16181d; --muted:#5d616d; --faint:#8b8f9a; --rule:#dfe2e7;
    --accent:#4b3f72;
    --pass:#2c6e49; --pass-soft:#e4efe8;
    --fail:#a62639; --fail-soft:#f7e6e9;
    --void:#5d616d; --void-soft:#e8eaee;
    --doubt:#8a5a00; --doubt-soft:#f7eedb;
    --sans:'IBM Plex Sans',system-ui,-apple-system,sans-serif;
    --serif:'Source Serif 4',Georgia,serif;
    --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --ground:#14161a; --surface:#1b1e24; --sunk:#22262d;
    --ink:#e8e9ec; --muted:#a2a7b2; --faint:#767b87; --rule:#2e333b;
    --accent:#b3a5e0;
    --pass:#7fc79b; --pass-soft:#1d2b23;
    --fail:#f09aa8; --fail-soft:#331e23;
    --void:#a2a7b2; --void-soft:#242830;
    --doubt:#e0b869; --doubt-soft:#302713;
  }}
  :root[data-theme="dark"]{
    --ground:#14161a; --surface:#1b1e24; --sunk:#22262d;
    --ink:#e8e9ec; --muted:#a2a7b2; --faint:#767b87; --rule:#2e333b;
    --accent:#b3a5e0;
    --pass:#7fc79b; --pass-soft:#1d2b23;
    --fail:#f09aa8; --fail-soft:#331e23;
    --void:#a2a7b2; --void-soft:#242830;
    --doubt:#e0b869; --doubt-soft:#302713;
  }
  *{box-sizing:border-box}
  body{background:var(--ground);color:var(--ink);font-family:var(--sans);margin:0;line-height:1.5}
  .wrap{max-width:900px;margin:0 auto;padding-inline:16px;padding-block:28px 64px}
  h1{font-family:var(--serif);font-size:1.9rem;font-weight:600;margin:0 0 6px;letter-spacing:-.01em;text-wrap:balance}
  .lede{color:var(--muted);margin:0;max-width:62ch}
  .tally{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 0}
  .chip{font-size:.78rem;padding:4px 10px;border-radius:999px;border:1px solid var(--rule);background:var(--surface);color:var(--muted)}
  .chip b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
  .controls{position:sticky;top:env(safe-area-inset-top,0px);z-index:5;background:var(--ground);
    border-bottom:1px solid var(--rule);margin-top:22px;padding-block:12px;
    display:flex;flex-wrap:wrap;gap:10px;align-items:center}
  label.f{font-size:.78rem;color:var(--muted);display:flex;align-items:center;gap:6px}
  select,input[type=search]{font:inherit;font-size:.85rem;padding:6px 8px;border:1px solid var(--rule);
    border-radius:7px;background:var(--surface);color:var(--ink);max-width:100%}
  input[type=search]{min-width:min(220px,100%)}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .count{font-size:.78rem;color:var(--muted);margin-top:10px}
  .runs{display:flex;flex-direction:column;gap:16px;margin-top:16px}
  .run{background:var(--surface);border:1px solid var(--rule);border-radius:10px;overflow:hidden}
  .run.is-green{border-color:color-mix(in srgb,var(--pass) 45%,var(--rule))}
  .rhead{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;padding:13px 16px;
    background:var(--sunk);cursor:pointer;width:100%;text-align:left;font:inherit;color:inherit;
    border:0;border-bottom:1px solid var(--rule)}
  .rhead:hover{background:color-mix(in srgb,var(--accent) 7%,var(--sunk))}
  .rn{font-family:var(--mono);font-size:.78rem;color:var(--faint);font-variant-numeric:tabular-nums}
  .verdict{font-size:.72rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:5px}
  .v-green{background:var(--pass-soft);color:var(--pass)}
  .v-fail{background:var(--fail-soft);color:var(--fail)}
  .v-void{background:var(--void-soft);color:var(--void)}
  .rtitle{font-weight:600;font-size:.95rem}
  .rwhen{font-family:var(--mono);font-size:.76rem;color:var(--muted);margin-left:auto;font-variant-numeric:tabular-nums}
  .why{padding:11px 16px;font-size:.9rem;display:flex;gap:10px;align-items:flex-start;border-bottom:1px solid var(--rule)}
  .why .k{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);padding-top:3px;white-space:nowrap}
  .why.f{background:var(--fail-soft)} .why.f .k{color:var(--fail)}
  .why.v{background:var(--void-soft)}
  .why.g{background:var(--pass-soft)} .why.g .k{color:var(--pass)}
  .body{padding:2px 16px 18px}
  .convo{margin-top:18px}
  .convo h3{font-size:.76rem;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);
    margin:0 0 10px;font-weight:600}
  .turn{margin:0 0 13px;padding-left:12px;border-left:2px solid var(--rule)}
  .turn.a{border-left-color:color-mix(in srgb,var(--accent) 55%,var(--rule))}
  .who{font-size:.74rem;font-weight:600;letter-spacing:.03em;color:var(--muted);margin-bottom:2px}
  .turn.a .who{color:var(--accent)}
  .said{font-family:var(--serif);font-size:.95rem;white-space:pre-wrap;overflow-wrap:anywhere}
  .turn.h .said{color:var(--muted)}
  .note{font-size:.82rem;color:var(--doubt);background:var(--doubt-soft);padding:6px 10px;
    border-radius:6px;margin:0 0 13px}
  .empty{color:var(--muted);padding:26px 4px;font-size:.9rem}
  footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--rule);color:var(--faint);font-size:.8rem}
  @media (max-width:620px){.rwhen{margin-left:0;width:100%}}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
<div class="wrap">
  <h1>Rehearsal Log</h1>
  <p class="lede">Every automated run of the OpenSwitchboard rehearsal suite, oldest first. Two
    simulated people — Alex selling an upgraded Fanatec ClubSport V3 brake spring, Tony wanting
    one — each talk to their own assistant, and the assistants talk to the switchboard. This page
    is only what each side said. Where a run stopped, one line says why.</p>
  <div class="tally" id="tally"></div>

  <div class="controls">
    <label class="f">Show
      <select id="f-outcome">
        <option value="all">All runs</option>
        <option value="green">Ran all the way</option>
        <option value="fail">Stopped</option>
        <option value="void">Rig broke</option>
      </select>
    </label>
    <label class="f">Conversation
      <select id="f-side">
        <option value="all">Both sides</option>
        <option value="seller">Alex, selling</option>
        <option value="buyer">Tony, buying</option>
      </select>
    </label>
    <label class="f">Day
      <select id="f-day"><option value="all">Any</option></select>
    </label>
    <input type="search" id="f-text" placeholder="Search what was said…" aria-label="Search what was said">
  </div>

  <div class="count" id="count"></div>
  <div class="runs" id="runs"></div>

  <footer>Written from the suite's own transcripts by <code>scripts/rehearsalLog.mts</code>.
    ${runs.length} runs, ${first} to ${last}.</footer>
</div>
<script>
const RUNS = ${data};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const dayOf = (r) => (r.startedAt || '').slice(0,10);
const sideOf = (s) => /seller/i.test(s) ? 'seller' : /buyer/i.test(s) ? 'buyer' : 'other';
const outcomeOf = (r) => r.void ? 'void' : r.green ? 'green' : 'fail';

for (const d of [...new Set(RUNS.map(dayOf))].filter(Boolean).sort())
  $('f-day').insertAdjacentHTML('beforeend', '<option>' + esc(d) + '</option>');

const tally = { green:0, fail:0, void:0 };
for (const r of RUNS) tally[outcomeOf(r)]++;
$('tally').innerHTML =
  '<span class="chip"><b>' + RUNS.length + '</b> runs</span>' +
  '<span class="chip"><b>' + tally.green + '</b> ran all the way</span>' +
  '<span class="chip"><b>' + tally.fail + '</b> stopped</span>' +
  '<span class="chip"><b>' + tally.void + '</b> rig broke</span>';

function turnHtml(t) {
  if (t.role === 'note') return '<div class="note">' + esc(t.text) + '</div>';
  return '<div class="turn ' + (t.role === 'assistant' ? 'a' : 'h') + '">' +
    '<div class="who">' + esc(t.speaker) + '</div>' +
    '<div class="said">' + esc(t.text) + '</div></div>';
}

function runHtml(r, f, open) {
  const outcome = outcomeOf(r);
  const label = outcome === 'green' ? 'ran all the way' : outcome === 'void' ? 'rig broke' : 'stopped';
  const cls = outcome === 'green' ? 'g' : outcome === 'void' ? 'v' : 'f';
  const cast = (r.cast.seller || '?') + ' for Alex, ' + (r.cast.buyer || '?') + ' for Tony';
  const when = (r.startedAt || '').replace('T',' ').slice(0,16);

  const sections = [...new Set(r.turns.map(t => t.section))];
  const convos = sections.map(sec => {
    if (f.side !== 'all' && sideOf(sec) !== f.side) return '';
    let turns = r.turns.filter(t => t.section === sec);
    if (f.text) turns = turns.filter(t => t.text.toLowerCase().includes(f.text));
    if (!turns.length) return '';
    return '<div class="convo"><h3>' + esc(sec) + '</h3>' + turns.map(turnHtml).join('') + '</div>';
  }).join('');

  return '<article class="run' + (outcome === 'green' ? ' is-green' : '') + '">' +
    '<button class="rhead" type="button" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="rn">#' + (r.idx + 1) + '</span>' +
      '<span class="verdict v-' + (outcome === 'green' ? 'green' : outcome === 'void' ? 'void' : 'fail') + '">' + label + '</span>' +
      '<span class="rtitle">' + esc(cast) + '</span>' +
      '<span class="rwhen">' + esc(when) + '</span>' +
    '</button>' +
    '<div class="why ' + cls + '"><span class="k">why</span><span>' + esc(r.why) + '</span></div>' +
    '<div class="body"' + (open ? '' : ' hidden') + '>' +
      (convos || '<div class="empty">Nothing was said on this run.</div>') +
    '</div></article>';
}

function render() {
  const f = {
    outcome: $('f-outcome').value,
    side: $('f-side').value,
    day: $('f-day').value,
    text: $('f-text').value.trim().toLowerCase(),
  };
  let shown = RUNS.map((r,i) => ({ ...r, idx:i }));
  if (f.outcome !== 'all') shown = shown.filter(r => outcomeOf(r) === f.outcome);
  if (f.day !== 'all') shown = shown.filter(r => dayOf(r) === f.day);
  if (f.text) shown = shown.filter(r => r.turns.some(t => t.text.toLowerCase().includes(f.text)));

  $('count').textContent = shown.length + ' of ' + RUNS.length + ' runs';
  // The newest run is open when the page lands: it is the one being worked on.
  $('runs').innerHTML = shown.length
    ? shown.map((r,i) => runHtml(r, f, i === shown.length - 1)).join('')
    : '<div class="empty">No runs match these filters.</div>';
}

$('runs').addEventListener('click', (e) => {
  const head = e.target.closest('.rhead');
  if (!head) return;
  const b = head.parentElement.querySelector('.body');
  b.hidden = !b.hidden;
  head.setAttribute('aria-expanded', b.hidden ? 'false' : 'true');
});
for (const id of ['f-outcome','f-side','f-day']) $(id).addEventListener('change', render);
let t; $('f-text').addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 160); });
render();
</script>
`;
}

const runs = readRuns();
writeFileSync(OUT, page(runs));
// eslint-disable-next-line no-console
console.log(`${runs.length} run(s) → ${OUT}`);
