/**
 * NO TEST STORIES IN ANYTHING SERVED TO AN ASSISTANT.
 *
 * The served text used to carry anecdotes from our own rehearsals and tests:
 * the bike posted across the country, the courier scam, the spring that was
 * asked about four times. On 27 September 2026 an assistant on production
 * relayed one of them to its human as if it were real history. So every served
 * sentence states its rule plainly, and this suite fails on the words a story
 * leaves behind: rehearsal, a probe, run N, our test people's names, the
 * production test.
 *
 * What it scans is everything an assistant can be handed as text: the connect
 * page, every manual section and its one-line about, every changelog note
 * (served by read_manual "whats_new" and on the sweep), every tool
 * description and every string inside its input schema, the lane sentences and
 * notes in every lane, and the connect-time blocks about this human.
 *
 * Code comments are out of scope and keep their history.
 */
import { describe, expect, it } from 'vitest';

import {
  MANUAL_CHANGELOG,
  MANUAL_SECTIONS,
  SERVER_INSTRUCTIONS,
  WHATS_NEW_SECTION,
  readManual,
} from '../../src/mcp/instructions.js';
import { TOOLS } from '../../src/mcp/tools.js';
import { NOTE_IDS, SENTENCE_IDS, say, sayNote, type Lane } from '../../src/domain/lanes.js';
import {
  OWN_HUMAN_HEADING,
  OWN_HUMAN_PREAMBLE,
  SUSPENDED_BLOCK,
  ownHumanBlockText,
} from '../../src/mcp/connectFacts.js';

/**
 * The words a story leaves behind. "probe" is allowed after "not" because the
 * offers section says "Declines carry no reason, by design; do not probe",
 * which is a rule about asking and has nothing to do with our tests.
 */
const STORY_WORDS =
  /\brehears(?:al|als|ed|ing)\b|rehearsal-suite|(?<!not )\bprobes?\b|\brun \d+\b|\bNagatha\b|\bBilby\b|\bPia\b|Queanbeyan|production (?:test|conversation)|\bin a test\b|\bwith real people\b/i;

function served(): [string, string][] {
  const out: [string, string][] = [['connect text', SERVER_INSTRUCTIONS]];
  for (const s of MANUAL_SECTIONS) {
    out.push([`manual section ${s.id}`, s.text]);
    out.push([`manual section ${s.id} (about)`, s.about]);
  }
  for (const c of MANUAL_CHANGELOG) out.push([`changelog v${c.version}`, c.note]);
  out.push(['whats_new', readManual({ section: WHATS_NEW_SECTION }).text]);
  out.push(['whats_new since 0', readManual({ section: WHATS_NEW_SECTION, since: 0 }).text]);

  const walk = (where: string, v: unknown): void => {
    if (typeof v === 'string') out.push([where, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(`${where}[${i}]`, x));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(`${where}.${k}`, x);
    }
  };
  for (const t of TOOLS) walk(`tool ${t.name}`, t);

  const lanes: Lane[] = ['prompted', 'autonomous'];
  const arrangements = [{}, { runs_on_its_own: true, check_every_minutes: 60 }];
  const ctxs = [
    { thing: 'the bike', added: 'I have added the other way they say it.', hearsVia: 'email' as const },
    { thing: 'the bike', added: 'I have added the other way they say it.', hearsVia: 'assistant' as const },
    { thing: 'the bike', added: 'I have added the other way they say it.' },
  ];
  for (const lane of lanes) {
    for (const a of arrangements) {
      for (const ctx of ctxs) {
        for (const id of SENTENCE_IDS) out.push([`sentence ${id} (${lane})`, say(id, lane, a as never, ctx)]);
        for (const id of NOTE_IDS) out.push([`note ${id} (${lane})`, sayNote(id, lane, a as never, ctx)]);
      }
    }
  }

  out.push(['connect: suspended', SUSPENDED_BLOCK]);
  out.push(['connect: own human', `${OWN_HUMAN_HEADING}\n${OWN_HUMAN_PREAMBLE}`]);
  out.push([
    'connect: own human block',
    ownHumanBlockText({ area: { area: 'Lyons', area_resolved: 'Lyons, Northern Territory, Australia' } as never, timezone: 'Australia/Darwin' }),
  ]);
  return out;
}

describe('nothing served to an assistant tells one of our test stories', () => {
  it('scans a real body of text', () => {
    const all = served();
    // Guard against a scan that silently reads nothing.
    expect(all.length).toBeGreaterThan(200);
    expect(all.some(([w]) => w.startsWith('tool publish_intent'))).toBe(true);
    expect(all.some(([w]) => w === 'changelog v72')).toBe(true);
  });

  it('carries none of the words a story leaves behind', () => {
    const hits = served()
      .map(([where, text]) => {
        const m = text.match(STORY_WORDS);
        return m ? `${where}: "${text.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 60)}"` : null;
      })
      .filter(Boolean);
    expect(hits).toEqual([]);
  });

  it('would catch one if it came back', () => {
    for (const story of [
      'In a rehearsal today a bike went up.',
      'a rehearsal found the gap',
      'all from one probe of what really gets posted',
      'in run 8 an assistant',
      'Nagatha posted it',
      'Bilby answered',
      'Pia asked',
      'the Queanbeyan spring',
      'from the first production test',
    ]) {
      expect(STORY_WORDS.test(story), story).toBe(true);
    }
    expect(STORY_WORDS.test('Declines carry no reason, by design; do not probe.')).toBe(false);
  });
});
