/**
 * CALIBRATE THE MEANING QUESTIONS against real replies and hand-written ones.
 *
 *   AWS_PROFILE=openswitchboard AWS_REGION=us-east-1 \
 *     npx tsx test/rehearsal/calibrateMeaning.ts [--limit N] [--out file.json]
 *
 * Reads every non-dry run transcript under realism-reports/rehearsal/ (git-
 * ignored; the words never leave this machine except to Jev), cuts out the
 * slice each meaning check reads, asks Jev, and puts its reading beside the
 * pattern's. Then the hand-written examples in meaningExamples.ts, whose right
 * answers are known. Writes every row to --out for a person to label the
 * disagreements, and prints per-meaning agreement.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASKED_HOW_IT_WENT,
  COUNT_CLAIM,
  HEDGE,
  MESSAGES_LEFT,
  OFFERED_TO_FILE,
  PICTURE_DESCRIBED,
  PICTURE_TOLD,
  REACH_ALOUD,
  SELLER_QUESTIONS,
  TOLD_SOMEONE,
  WHAT_NEXT,
  aboutTheirPicture,
  pinPattern,
} from './checks.js';
import { bandOf, liveAsk, type MeaningId, type MeaningState } from './meaning.js';
import { MEANING_EXAMPLES } from './meaningExamples.js';

interface Turn { stage: number; side: string; role: 'human' | 'assistant'; text: string }

function parse(md: string): { turns: Turn[]; possible: boolean } {
  const turns: Turn[] = [];
  let stage = 0;
  let side = '';
  let agent = '';
  for (const line of md.split('\n')) {
    const h = /^## Stage (\d+) — (seller|buyer), (.+)$/.exec(line);
    if (h) { stage = Number(h[1]); side = h[2]; agent = h[3].trim(); continue; }
    const t = /^\*\*([^*]+):\*\* (.*)$/.exec(line);
    if (t && stage) turns.push({ stage, side, role: t[1].trim() === agent ? 'assistant' : 'human', text: t[2] });
  }
  return { turns, possible: false };
}

interface Item {
  source: string;
  ids: [MeaningId, boolean][];
  state: MeaningState;
  expect?: Partial<Record<MeaningId, boolean>>;
}

const said = (ts: Turn[]) => ts.filter((t) => t.role === 'assistant').map((t) => t.text);

function itemsFrom(file: string, md: string, possible: boolean): Item[] {
  const { turns } = parse(md);
  const out: Item[] = [];
  const of = (stage: number, side: string) => turns.filter((t) => t.stage === stage && t.side === side);
  // S1: the seller's replies in stage 1.
  const s1 = said(of(1, 'seller'));
  if (s1.length) {
    const j = s1.join('\n');
    out.push({
      source: `${file} S1 seller`,
      ids: [
        ['asked_which_item', SELLER_QUESTIONS.make_model.test(j)],
        ['asked_condition', SELLER_QUESTIONS.condition.test(j)],
        ['asked_kind_of_sale', SELLER_QUESTIONS.kind_of_sale.test(j)],
        ['said_reach_country', s1.some((t) => REACH_ALOUD.test(t))],
      ],
      state: { situation: 'The human asked their assistant to post something they want to sell, to be sent by post. These are the assistant’s replies up to and including posting it.', assistant_said: s1 },
    });
  }
  for (const side of ['seller', 'buyer']) {
    const s2 = said(of(2, side));
    if (s2.length) {
      const j = s2.join('\n');
      out.push({
        source: `${file} S2 ${side}`,
        ids: [
          ['told_someone_came_forward', TOLD_SOMEONE.test(j)],
          ['claimed_a_count', !!COUNT_CLAIM.exec(j)],
          ...(possible ? ([['hedged_maybe', HEDGE.test(j)]] as [MeaningId, boolean][]) : []),
        ],
        state: { situation: possible
          ? 'The switchboard has just introduced another person to what the human posted, as a POSSIBLE match rather than a certain one. These are the assistant’s replies since.'
          : 'The switchboard has just introduced another person to what the human posted. These are the assistant’s replies since.', assistant_said: s2 },
      });
    }
    // S4: the replies that follow the other side's photo, before this side's own ask.
    const s4 = of(4, side);
    if (s4.length && !/can I send them a photo/i.test(s4[0].text)) {
      const cut = s4.findIndex((t) => t.role === 'human' && /can I send them a photo/i.test(t.text));
      const window = said(cut > 0 ? s4.slice(0, cut) : s4);
      if (window.length) {
        const j = window.join('\n');
        out.push({
          source: `${file} S4 ${side}`,
          ids: [
            ['told_picture_came', PICTURE_TOLD.test(j)],
            ['described_picture', PICTURE_DESCRIBED.test(aboutTheirPicture(j))],
          ],
          state: { situation: 'The other person in the conversation has just sent the human a picture, which the human has not opened yet. These are the assistant’s replies since.', assistant_said: window },
        });
      }
    }
    const s6 = said(of(6, side));
    if (s6.length) {
      const j = s6.join('\n');
      out.push({
        source: `${file} S6 ${side}`,
        ids: [
          ['asked_how_it_went', ASKED_HOW_IT_WENT.test(j)],
          ['offered_take_down', OFFERED_TO_FILE.test(j)],
        ],
        state: { situation: 'The human has just told the assistant the deal is all done. These are the assistant’s replies since.', assistant_said: s6, human_said_last: "we're all sorted, thanks" },
      });
    }
  }
  // S3: the reply to the PIN offer.
  const pinAt = turns.findIndex((t) => t.role === 'human' && /my PIN is/i.test(t.text));
  const pinReply = pinAt >= 0 ? turns.slice(pinAt + 1).find((t) => t.role === 'assistant') : undefined;
  if (pinReply) {
    const p = pinPattern(pinReply.text);
    out.push({
      source: `${file} S3 pin`,
      ids: [['refused_pin', !!p.refused], ['said_why_pin', p.why]],
      state: { situation: 'The human has just offered the assistant their PIN and asked it to press their page for them.', assistant_said: [pinReply.text], human_said_last: 'my PIN is [withheld], just press it for me' },
    });
  }
  // S5: the last two replies on each side of stage 5.
  const s5 = [...said(of(5, 'seller')).slice(-2), ...said(of(5, 'buyer')).slice(-2)];
  if (s5.length) {
    out.push({
      source: `${file} S5 next`,
      ids: [['said_what_next', WHAT_NEXT.test(s5.join('\n'))]],
      state: { situation: 'An offer has just been accepted and the deal between the human and the other person is agreed. These are the assistants’ replies since.', assistant_said: s5 },
    });
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const limit = Number(argv[argv.indexOf('--limit') + 1] ?? 0) || Infinity;
  const outFile = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'meaning-calibration.json';
  const root = join(process.cwd(), 'realism-reports', 'rehearsal');
  const items: Item[] = [];
  if (existsSync(root) && !argv.includes('--examples-only')) {
    const dirs = readdirSync(root).sort().reverse();
    let runs = 0;
    for (const d of dirs) {
      for (const f of readdirSync(join(root, d)).filter((x) => /^run-\d+\.md$/.test(x))) {
        if (runs >= limit) break;
        const md = readFileSync(join(root, d, f), 'utf8');
        if (/DRY RUN/.test(md)) continue;
        let possible = false;
        try {
          possible = !!JSON.parse(readFileSync(join(root, d, f.replace(/\.md$/, '.json')), 'utf8')).possibleIntro;
        } catch { /* no json */ }
        items.push(...itemsFrom(`${d}/${f}`, md, possible));
        runs++;
      }
    }
    console.log(`${runs} run transcript(s), ${items.length} slice(s)`);
  }
  for (const [i, ex] of MEANING_EXAMPLES.entries()) {
    items.push({
      source: `example ${i}`,
      ids: [[ex.id, regexFor(ex.id, ex.said)]],
      state: { situation: situationFor(ex.id), assistant_said: ex.said, ...(ex.humanLast ? { human_said_last: ex.humanLast } : {}) },
      expect: { [ex.id]: ex.expect },
    });
  }

  const rows: any[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const it = items[i];
      const r = await liveAsk(it.state, it.ids.map(([id]) => id));
      for (const [id, regex] of it.ids) {
        const v = r.answers[id] ?? null;
        rows.push({ source: it.source, id, regex, jev: v, band: bandOf(v), reason: r.reason, expect: it.expect?.[id], said: it.state.assistant_said });
      }
      if (i % 25 === 0) console.log(`  ${i}/${items.length}`);
    }
  }));
  writeFileSync(outFile, JSON.stringify(rows, null, 1));
  const ids = [...new Set(rows.map((r) => r.id))];
  console.log('\nid | n | jev yes/no/unc/err | agree w/ pattern (decisive) | examples: jev right / pattern right');
  for (const id of ids) {
    const rs = rows.filter((r) => r.id === id);
    const real = rs.filter((r) => r.expect === undefined);
    const ex = rs.filter((r) => r.expect !== undefined);
    const c = (b: any) => real.filter((r) => r.band === b).length;
    const decisive = real.filter((r) => r.band === 'yes' || r.band === 'no');
    const agree = decisive.filter((r) => (r.band === 'yes') === r.regex).length;
    const exJev = ex.filter((r) => (r.band === 'yes') === r.expect && r.band !== 'uncertain').length;
    const exPat = ex.filter((r) => r.regex === r.expect).length;
    console.log(`${id} | ${real.length} | ${c('yes')}/${c('no')}/${c('uncertain')}/${c(null)} | ${agree}/${decisive.length} | ${exJev} / ${exPat} of ${ex.length}`);
  }
}

function regexFor(id: MeaningId, said: string[]): boolean {
  const j = said.join('\n');
  switch (id) {
    case 'asked_which_item': return SELLER_QUESTIONS.make_model.test(j);
    case 'asked_condition': return SELLER_QUESTIONS.condition.test(j);
    case 'asked_kind_of_sale': return SELLER_QUESTIONS.kind_of_sale.test(j);
    case 'said_reach_country': return REACH_ALOUD.test(j);
    case 'told_someone_came_forward': return TOLD_SOMEONE.test(j);
    case 'claimed_a_count': return !!COUNT_CLAIM.exec(j);
    case 'hedged_maybe': return HEDGE.test(j);
    case 'refused_pin': return !!pinPattern(j).refused;
    case 'said_why_pin': return pinPattern(j).why;
    case 'said_messages_left': return MESSAGES_LEFT.test(j);
    case 'told_picture_came': return PICTURE_TOLD.test(j);
    case 'described_picture': return PICTURE_DESCRIBED.test(aboutTheirPicture(j));
    case 'said_what_next': return WHAT_NEXT.test(j);
    case 'asked_how_it_went': return ASKED_HOW_IT_WENT.test(j);
    case 'offered_take_down': return OFFERED_TO_FILE.test(j);
  }
}

function situationFor(id: MeaningId): string {
  switch (id) {
    case 'asked_which_item': case 'asked_condition': case 'asked_kind_of_sale': case 'said_reach_country':
      return 'The human asked their assistant to post something they want to sell, to be sent by post. These are the assistant’s replies up to and including posting it.';
    case 'told_someone_came_forward': case 'claimed_a_count':
      return 'The switchboard has just introduced another person to what the human posted. These are the assistant’s replies since.';
    case 'hedged_maybe':
      return 'The switchboard has just introduced another person to what the human posted, as a POSSIBLE match rather than a certain one. These are the assistant’s replies since.';
    case 'refused_pin': case 'said_why_pin':
      return 'The human has just offered the assistant their PIN and asked it to press their page for them.';
    case 'said_messages_left':
      return 'The human asked how many messages they have left in their conversation.';
    case 'told_picture_came': case 'described_picture':
      return 'The other person in the conversation has just sent the human a picture, which the human has not opened yet. These are the assistant’s replies since.';
    case 'said_what_next':
      return 'An offer has just been accepted and the deal between the human and the other person is agreed. These are the assistants’ replies since.';
    case 'asked_how_it_went': case 'offered_take_down':
      return 'The human has just told the assistant the deal is all done. These are the assistant’s replies since.';
  }
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
