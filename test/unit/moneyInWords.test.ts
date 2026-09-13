/**
 * A figure never travels in the words (run 8, 13 September 2026).
 *
 * The defect this suite exists to hold shut: an assistant told to "confirm
 * $420" sent the sentence "Happy to confirm $420 for it" across the open
 * conversation and created no offer at all. The price reached a stranger, and
 * nothing had checked it against what the human themselves wrote down.
 *
 * Two halves, and the second one is the expensive one:
 *  - EVERY WAY A PRICE IS WRITTEN is refused — money signs, money codes, money
 *    words, the same thing spelled out, the phrasing that wraps a bare number,
 *    and the obvious dodges;
 *  - EVERY ORDINARY SENTENCE still travels. Times, dates, sizes, specs,
 *    addresses, distances and plain counts are what two people arranging a
 *    handover actually send each other, and a refusal there is a bug.
 *
 * Each case is named with the sentence itself, so a failure reads as the
 * sentence that was got wrong rather than as an index.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FIGURE_IN_OFFER_NOTE_ACTION,
  FIGURE_IN_WORDS_ACTION,
  carriesMoneyFigure,
  moneyFigureRule,
} from '../../src/domain/moneyInWords.js';
import * as db from '../../src/db.js';
import * as channel from '../../src/domain/channel.js';
import { OsbError } from '../../src/protocol.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = { envName: 'dev', publicOrigin: 'https://mcp.test' } as unknown as Config;
const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** The machinery's own nouns, which no sentence an agent relays may carry. */
const SYSTEM_WORDS = [
  { label: 'card', re: /\b(index\s+)?cards?\b/i },
  { label: 'channel', re: /\bchannels?\b/i },
  { label: 'match', re: /\bmatch(es)?\b/i },
  { label: 'stage', re: /\bstages?\b/i },
  { label: 'WANT', re: /\bWANT\b/ },
  { label: 'HAVE', re: /\bHAVE\b/ },
  { label: 'connection', re: /\bconnections?\b/i },
  { label: 'score', re: /\bscores?\b/i },
];

// ---------------------------------------------------------------------------
// The corpus. Left column is what an agent might hand to send_message.
// ---------------------------------------------------------------------------

/** Everything that is a price, however it is dressed. */
const REFUSE: [group: string, text: string][] = [
  // A money sign and a number, either order, any spacing.
  ['a money sign', 'Happy to confirm $420 for it'],
  ['a money sign', 'I can do $ 420 on Saturday'],
  ['a money sign', 'call it 420$ and we are done'],
  ['a money sign', 'A$420 works for me'],
  ['a money sign', 'AU$420 and I will collect it'],
  ['a money sign', 'US$50 posted'],
  ['a money sign', '€50 for the pair'],
  ['a money sign', '£50 and it is yours'],
  ['a money sign', 'about $420ish, give or take'],
  // Money codes.
  ['a money code', '420 AUD, collection Saturday'],
  ['a money code', 'AUD 420 is where I am at'],
  ['a money code', 'USD420 delivered'],
  ['a money code', '420AUD and I will take it today'],
  // Numbers written the way money is written.
  ['money punctuation', 'the total comes to 420.00'],
  ['money punctuation', 'that brings it to 1,250 all up'],
  ['money punctuation', 'it works out at 29.99'],
  // A number and a money word.
  ['a money word', 'I can do 420 dollars'],
  ['a money word', 'four hundred and twenty dollars, final'],
  ['a money word', 'twenty bucks and it is yours'],
  ['a money word', '420 bucks, collection included'],
  ['a money word', '420 quid for the lot'],
  ['a money word', 'fifty cents each way'],
  ['a money word', '50 cents on top'],
  ['a money word', 'two grand for the pair'],
  ['a money word', 'it would be a dollar cheaper posted'],
  ['a money word', '420 each if you take both'],
  // The same figure spelled out, with no money word at all.
  ['a spoken figure', 'four twenty and I will bring it round'],
  ['a spoken figure', 'four-twenty works'],
  ['a spoken figure', 'four hundred, if that suits'],
  ['a spoken figure', 'a hundred and fifty is my limit'],
  ['a spoken figure', 'fifteen hundred all up'],
  ['a spoken figure', 'two fifty and we are square'],
  // Price phrasing wrapped around a bare number.
  ['price phrasing', 'how about 400'],
  ['price phrasing', 'I could do 400 if you collect'],
  ['price phrasing', 'would you take 400 for it'],
  ['price phrasing', 'call it 400 and I will come Saturday'],
  ['price phrasing', 'I can drop to 400'],
  ['price phrasing', 'happy to come down to 400'],
  ['price phrasing', 'meet you at 400'],
  ['price phrasing', 'let us split the difference at 400'],
  ['price phrasing', 'I could go to 450 if you deliver'],
  ['price phrasing', 'I am asking 400 for it'],
  ['price phrasing', 'I will pay 400 on pickup'],
  ['price phrasing', "I'll take 400 for it"],
  ['price phrasing', 'my best is 380'],
  ['price phrasing', 'can you do 350'],
  ['price phrasing', "how's 390 sound"],
  ['price phrasing', 'the price is 420'],
  ['price phrasing', 'let it go for 300'],
  ['a bare opening', '450 and I will collect Saturday'],
  ['price phrasing', '400 firm, sorry'],
  ['price phrasing', '400 cash on the day'],
  ['price phrasing', '400 ono'],
  ['price phrasing', 'how about four hundred'],
  // Obfuscation that is plainly a price.
  ['a dodge', 'the number is 4 2 0'],
  ['a dodge', '~420 should do it'],
  ['a dodge', '420-ish, depending on the tyres'],
  ['a dodge', 'somewhere around 420ish'],
];

/** Everything an ordinary sentence carries, which must go straight through. */
const ALLOW: [group: string, text: string][] = [
  // Times.
  ['a time', 'see you at 4:20'],
  ['a time', 'see you at 4.20'],
  ['a time', 'half four suits me'],
  ['a time', 'anywhere between 2 and 3 works'],
  ['a time', 'Saturday at 10 then'],
  ['a time', 'I am free at 9 or after 6'],
  ['a time', 'shall we say 4pm'],
  ['a time', 'around 10:30 in the morning'],
  // Dates and years.
  ['a date', 'it is a 2019 model'],
  ['a date', 'I could do the 14th'],
  ['a date', 'next Tuesday is better for me'],
  ['a date', 'I have had it since 2021'],
  // Sizes, measurements and specs.
  ['a spec', 'it has 29 inch wheels'],
  ['a spec', 'large frame, hydraulic brakes'],
  ['a spec', 'it is a 21 speed'],
  ['a spec', 'it weighs about 15kg'],
  ['a spec', 'size 10 if that helps'],
  ['a spec', 'the boot is 2.5 metres long'],
  ['a spec', 'two kids can ride it'],
  ['a spec', 'we could do a 30 minute lesson to start'],
  ['a spec', "I've got two thirty minute slots free"],
  ['a spec', 'three bedrooms, one bathroom'],
  // Addresses and directions.
  ['an address', 'I am at 42 Smith Street'],
  ['an address', 'it is unit 7, round the back'],
  ['an address', 'about 8km away from the markets'],
  ['an address', 'take the 2nd left after the bridge'],
  // Plain counts.
  ['a count', 'I have two of them'],
  ['a count', 'both of us can come'],
  ['a count', 'I could bring a couple'],
  ['a count', 'there are 3 left'],
  ['a count', 'a hundred times better than the old one'],
  ['a count', 'it took a couple of thousand words to explain'],
  // Ordinary sentences with a money word in them and no figure.
  ['no figure', 'what were you thinking money wise?'],
  ['no figure', 'happy to talk about the price when you are'],
  ['no figure', 'my assistant will put a number on the table for you'],
  ['no figure', 'is it still available?'],
  ['no figure', 'Saturday morning works, I can come to you'],
  ['no figure', 'I am near the markets, anywhere around there is fine'],
  ['no figure', 'lovely, let us swap numbers and take it from here'],
];

describe('a money figure in the words, however it is written', () => {
  for (const [group, text] of REFUSE) {
    it(`refuses ${group}: "${text}"`, () => {
      expect(carriesMoneyFigure(text), `no rule fired on "${text}"`).toBe(true);
      // Every refusal has to be one a reader can justify out loud.
      expect(moneyFigureRule(text)).toBeTruthy();
    });
  }
});

describe('everything else two people arranging a handover say', () => {
  for (const [group, text] of ALLOW) {
    it(`carries ${group}: "${text}"`, () => {
      const rule = moneyFigureRule(text);
      expect(rule, `refused as "${rule}" — a false alarm on "${text}"`).toBeUndefined();
    });
  }
});

describe('the edges of the check itself', () => {
  it('says nothing about an empty or missing sentence', () => {
    expect(carriesMoneyFigure('')).toBe(false);
    expect(carriesMoneyFigure(undefined as unknown as string)).toBe(false);
  });

  it('reads the same sentence in any case', () => {
    expect(carriesMoneyFigure('FOUR HUNDRED AND TWENTY DOLLARS')).toBe(true);
    expect(carriesMoneyFigure('How About 400')).toBe(true);
  });

  it('finds a figure buried in the middle of a long message', () => {
    const long = `${'lovely, thanks for getting back to me. '.repeat(20)}happy to confirm $420 for it, see you Saturday.`;
    expect(carriesMoneyFigure(long)).toBe(true);
  });

  it('reads a curly apostrophe the way it reads a straight one', () => {
    expect(carriesMoneyFigure('I’ll pay 400 on pickup')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The refusal an agent is handed.
// ---------------------------------------------------------------------------

describe('what the agent is told', () => {
  for (const [name, sentence] of [
    ['the words refusal', FIGURE_IN_WORDS_ACTION],
    ['the note refusal', FIGURE_IN_OFFER_NOTE_ACTION],
  ] as const) {
    it(`${name} passes the copy lint and keeps the machinery's words out`, () => {
      expect(lintHumanCopy(sentence), sentence).toEqual([]);
      for (const { label, re } of SYSTEM_WORDS) {
        expect(re.test(sentence), `${label} in ${name}`).toBe(false);
      }
      // human_action is capped at 300 characters by the published error schema.
      expect(sentence.length).toBeLessThanOrEqual(300);
    });
  }

  it('says the thing was not sent, where money goes instead, and what to do', () => {
    expect(FIGURE_IN_WORDS_ACTION).toMatch(/has not gone/);
    expect(FIGURE_IN_WORDS_ACTION).toMatch(/own road/);
    expect(FIGURE_IN_WORDS_ACTION).toMatch(/limits are checked/);
    expect(FIGURE_IN_WORDS_ACTION).toMatch(/as an offer/);
    // And a sentence the agent can hand straight to its human.
    expect(FIGURE_IN_WORDS_ACTION).toMatch(/Say to your human/);
  });
});

// ---------------------------------------------------------------------------
// The send itself: refused before anything is written.
// ---------------------------------------------------------------------------

describe('send_message with a figure in it', () => {
  let queries: string[];

  beforeEach(() => {
    queries = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      connect: async () => {
        queries.push('CONNECT');
        return { query: async () => ({ rows: [], rowCount: 0 }), release: () => {} };
      },
    } as any);
  });

  it('refuses, and never touches the database at all', async () => {
    await expect(
      channel.sendMessage(ANA, MATCH, 'Happy to confirm $420 for it', cfg),
    ).rejects.toBeInstanceOf(OsbError);
    // Nothing read, nothing written, no allowance spent: the refusal lands
    // before the introduction is even looked up.
    expect(queries).toEqual([]);
  });

  it('hands back the sentence, on the code the other refusals use', async () => {
    const err = await channel
      .sendMessage(ANA, MATCH, 'how about 400', cfg)
      .then(() => undefined)
      .catch((e) => e as OsbError);
    expect(err).toBeInstanceOf(OsbError);
    expect((err as OsbError).payload.code).toBe('CONSENT_REQUIRED');
    expect((err as OsbError).payload.human_action).toBe(FIGURE_IN_WORDS_ACTION);
  });

  it('refuses a spelled-out figure the same as a written one', async () => {
    await expect(
      channel.sendMessage(ANA, MATCH, 'four hundred and twenty dollars, final', cfg),
    ).rejects.toBeInstanceOf(OsbError);
    expect(queries).toEqual([]);
  });

  it('lets an ordinary arrangement through to the transport', async () => {
    // No figure, so the send gets past the check and on to the real work —
    // which this stub database cannot complete. What matters here is that it
    // got that far: the refusal is not what stopped it.
    await expect(
      channel.sendMessage(ANA, MATCH, 'Saturday morning works, I can come to you', cfg),
    ).rejects.not.toBeInstanceOf(OsbError);
    expect(queries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The note that rides along with an offer.
//
// THE DECISION: the same rule applies, and only to a note an AGENT wrote. An
// offer's own amount has been read against the human's own limits; a second
// figure in the note beside it has been read by nothing and lands in front of
// the other human word for word, which is the very leak the relay rule closes.
// A note typed by the human on their own approval page is left alone: that
// page is their own words about their own money, and the rule here is about
// what an agent may author.
// ---------------------------------------------------------------------------

describe('a figure in the note beside an offer', () => {
  it('is the same leak, so the same words are refused', () => {
    expect(carriesMoneyFigure('and I could go to 450 if you deliver')).toBe(true);
    expect(carriesMoneyFigure('four fifty if you deliver')).toBe(true);
  });

  it('leaves a plain note alone', () => {
    expect(carriesMoneyFigure('I can collect Saturday morning if that helps')).toBe(false);
    expect(carriesMoneyFigure('this is the most I can do, sorry')).toBe(false);
  });

  it('the refusal names the offer as the place the figure goes', () => {
    expect(FIGURE_IN_OFFER_NOTE_ACTION).toMatch(/has not gone/);
    expect(FIGURE_IN_OFFER_NOTE_ACTION).toMatch(/on the offer/);
  });
});

// ---------------------------------------------------------------------------
// What a connected agent is told about it.
// ---------------------------------------------------------------------------

describe('the manual', () => {
  it('carries the rule at the version it shipped at', async () => {
    const { MANUAL, MANUAL_CHANGELOG, SERVER_INSTRUCTIONS } = await import(
      '../../src/mcp/instructions.js'
    );
    expect(MANUAL.version).toBe(35);
    const entry = MANUAL_CHANGELOG.find((c) => c.version === 35)!;
    expect(entry).toBeTruthy();
    expect(entry.note).toMatch(/send_message refuses/);
    expect(entry.note).toMatch(/spelled out/);
    expect(entry.note).toMatch(/propose_offer/);
    // The body says it too, so an agent connecting fresh reads it without the
    // changelog.
    expect(SERVER_INSTRUCTIONS).toMatch(/the words you send carry NO figure at all/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/in digits or spelled out/i);
  });

  it('tells the tool surface the same thing', async () => {
    const { TOOLS } = await import('../../src/mcp/tools.js');
    const send = TOOLS.find((t) => t.name === 'send_message')!;
    expect(send.description).toMatch(/REFUSED/);
    expect(send.description).toMatch(/four hundred and twenty dollars/);
  });
});
