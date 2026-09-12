/**
 * Every category, read aloud in every sentence that names one.
 *
 * A label is a heading — "Mountain bikes", "Kettles, toasters & benchtop
 * appliances", "DSLR cameras" — and the switchboard used to push headings into
 * sentences with a mechanical rule. The rule lower-cased acronyms, singularised
 * mass nouns and left "your kids clothing" standing. So every open leaf in the
 * taxonomy now carries a phrase written by hand, and this file is how they stay
 * honest.
 *
 * What is asserted here:
 *  - every open leaf (status not reserved) has a phrase, and no branch above
 *    one carries a phrase it would never be asked for;
 *  - every leaf renders through EVERY frame that names a category: the summons
 *    line, the number-on-the-table both ways round, deal-agreed both ways
 *    round, the two one-question pages, the sweep's offer note and the signal
 *    sentence that needs an article in front;
 *  - and none of those renderings carries a lower-cased acronym, a double
 *    space, "a" in front of a vowel sound or "an" in front of a consonant, a
 *    plural used as a possessive ("your kids clothing"), or the raw "&" the
 *    heading it came from still has.
 *
 * The frames are rendered for all 462 leaves rather than a handful, because a
 * phrase that reads well after "your" can still read wrong after "keen on".
 */
import { describe, expect, it } from 'vitest';
import { loadTaxonomy } from '@openswitchboard/schema';
import {
  articleForPhrase,
  categoryLeafLabel,
  categoryPhrase,
  categoryPhraseIsCountable,
  categoryPhraseWithArticle,
} from '../../src/domain/matchRules.js';
import { aboutThing, offerAmountInWords } from '../../src/email/templates.js';
import { offerTableNote, type OfferLine } from '../../src/domain/offers.js';

const taxonomy = loadTaxonomy() as unknown as {
  nodes: Record<
    string,
    { label: string; phrase?: string; countable?: boolean; article?: string; status?: string }
  >;
};
const PATHS = Object.keys(taxonomy.nodes);
const hasChildren = (path: string) => PATHS.some((o) => o !== path && o.startsWith(`${path}.`));
/** Every leaf a person may be phrased about: a node with nothing under it that
 *  is not itself held back. Reserved top levels are included on purpose — the
 *  day work.* opens, the words are already written. */
const LEAVES = PATHS.filter((p) => !hasChildren(p) && taxonomy.nodes[p].status !== 'reserved');

/** Letters whose name opens with a vowel sound, checked here independently of
 *  the server's own list so the two have to agree. */
const SOUNDS_LIKE_VOWEL = 'AEFHILMNORSX';

const FIGURE = offerAmountInWords(420, 'AUD');
const LINKS = { settingsUrl: 'https://my.test/settings' };
const OFFER_LINE: OfferLine = {
  offer_id: '00000000-0000-4000-8000-0000000000f1',
  side: 'theirs',
  authored_by: 'human',
  amount: 420,
  ccy: 'AUD',
  state: 'sent',
  message: null,
  at: '2026-09-12T00:00:00.000Z',
};

/** Every sentence in the product that drops a category into it. */
function framesFor(path: string): { frame: string; text: string }[] {
  const label = categoryLeafLabel(path);
  const thing = categoryPhrase(path);
  const withArticle = categoryPhraseWithArticle(path);
  return [
    { frame: 'summons (have side)', text: `Someone has come forward about your ${thing}.` },
    { frame: 'summons (want side)', text: `Someone has come forward with ${withArticle}.` },
    {
      frame: 'summons (second person, have side)',
      text: `A second person has come forward about your ${thing}.`,
    },
    {
      frame: 'summons (second person, want side)',
      text: `A second person has come forward with ${withArticle}.`,
    },
    {
      frame: 'number on the table (seller)',
      text: `Someone has offered ${FIGURE}${aboutThing(thing, 'have')}.`,
    },
    {
      frame: 'number on the table (buyer)',
      text: `Someone has come back with ${FIGURE}${aboutThing(thing, 'want')}.`,
    },
    {
      frame: 'deal agreed (seller)',
      text: `Deal: ${FIGURE} agreed${aboutThing(thing, 'have')}. Where and when to hand it over is for the two of you.`,
    },
    {
      frame: 'deal agreed (buyer)',
      text: `Deal: ${FIGURE} agreed${aboutThing(thing, 'want')}. Where and when to hand it over is for the two of you.`,
    },
    {
      frame: 'one question (offer-send)',
      text: `Send ${FIGURE} to Sam${aboutThing(thing, 'have')}?`,
    },
    {
      frame: 'one question (offer-accept)',
      text: `Sam offers ${FIGURE}${aboutThing(thing, 'want')}.`,
    },
    {
      frame: 'sweep offer note',
      text: offerTableNote([OFFER_LINE], thing, 'have') ?? '',
    },
    {
      frame: 'signal (they have it)',
      text: `Someone nearby has ${withArticle} going that could be what you're after.`,
    },
    {
      frame: 'signal (they want it)',
      text: `Someone nearby is looking for ${withArticle} like yours.`,
    },
    { frame: 'recall', text: `You had ${withArticle} sorted with someone a while back.` },
    { frame: 'message waiting', text: `You have a message on your ${thing} conversation.` },
    { frame: 'link sentence', text: `Opens one page saying ${FIGURE} is on the table for their ${thing}.` },
    { frame: 'heading (unchanged)', text: label },
  ];
}

describe('every open leaf has words a person would say', () => {
  it('ships a phrase on every open leaf and on no branch above one', () => {
    expect(LEAVES.length).toBe(462);
    const missing = LEAVES.filter((p) => !taxonomy.nodes[p].phrase);
    expect(missing, `these leaves have no phrase: ${missing.join(', ')}`).toEqual([]);
    const branchesWithPhrases = PATHS.filter((p) => hasChildren(p) && taxonomy.nodes[p].phrase);
    expect(branchesWithPhrases).toEqual([]);
  });

  it('answers to the leaf id and to the label with the same words', () => {
    for (const path of LEAVES) {
      const byId = categoryPhrase(path);
      const byLabel = categoryPhrase(categoryLeafLabel(path));
      expect(byLabel, `${path}: id says "${byId}", label says "${byLabel}"`).toBe(byId);
    }
  });
});

describe('every leaf, read aloud in every frame', () => {
  it('keeps an acronym an acronym', () => {
    const wrong: string[] = [];
    for (const path of LEAVES) {
      const label = taxonomy.nodes[path].label;
      const phrase = categoryPhrase(path);
      for (const run of label.match(/[A-Z]{2,}/g) ?? []) {
        if (phrase.includes(run.toLowerCase())) wrong.push(`${path}: ${run} -> "${phrase}"`);
      }
    }
    expect(wrong, wrong.join('; ')).toEqual([]);
  });

  it('never carries the heading’s ampersand into a sentence', () => {
    const wrong = LEAVES.filter((p) => categoryPhrase(p).includes('&'));
    expect(wrong, wrong.join(', ')).toEqual([]);
  });

  it('never doubles a space in any frame', () => {
    const wrong: string[] = [];
    for (const path of LEAVES) {
      for (const { frame, text } of framesFor(path)) {
        if (/\s\s/.test(text)) wrong.push(`${path} (${frame}): "${text}"`);
      }
    }
    expect(wrong, wrong.join('; ')).toEqual([]);
  });

  it('never leaves a sentence with nothing where the thing should be', () => {
    const wrong: string[] = [];
    for (const path of LEAVES) {
      for (const { frame, text } of framesFor(path)) {
        if (!text.trim()) wrong.push(`${path} (${frame}) rendered empty`);
        if (/\byour \./.test(text) || /\bthe  ?you are after/.test(text)) {
          wrong.push(`${path} (${frame}): "${text}"`);
        }
      }
    }
    expect(wrong, wrong.join('; ')).toEqual([]);
  });

  it('says "a" before a consonant and "an" before a vowel sound', () => {
    const wrong: string[] = [];
    for (const path of LEAVES) {
      if (!categoryPhraseIsCountable(path)) continue;
      const phrase = categoryPhrase(path);
      const said = categoryPhraseWithArticle(path);
      const article = said.slice(0, said.indexOf(' '));
      expect(article, `${path}: "${said}"`).toMatch(/^(a|an)$/);
      const first = phrase.split(/[\s-]/)[0] ?? '';
      const acronym = /^[A-Z][A-Z0-9]/.test(first);
      // An acronym is said letter by letter, so its FIRST LETTER's name is what
      // decides: an SLR, a DSLR camera, a BMX bike.
      const vowelSound = acronym
        ? SOUNDS_LIKE_VOWEL.includes(first[0])
        : /^[aeiou]/i.test(first) && !/^(eu|uni|use|user|ukulele)/i.test(first);
      const spelledOut = taxonomy.nodes[path].article;
      if (spelledOut) {
        // A leaf spells its article out only where the spelling misleads — "an
        // Xbox". One that agrees with the rule is a line nobody needs to read.
        const derived = vowelSound ? 'an' : 'a';
        if (spelledOut === derived) {
          wrong.push(`${path}: "${said}" spells out an article the rule already gives`);
        }
        continue;
      }
      if (vowelSound && article !== 'an') wrong.push(`${path}: "${said}" wants "an"`);
      if (!vowelSound && article !== 'a') wrong.push(`${path}: "${said}" wants "a"`);
    }
    expect(wrong, wrong.join('; ')).toEqual([]);
  });

  it('never says "your kids clothing"', () => {
    const wrong: string[] = [];
    for (const path of LEAVES) {
      const phrase = categoryPhrase(path);
      // A plural noun standing in front of another noun needs its apostrophe.
      if (/\b(kids|mens|womens|childrens|ladies|babies|parents)\s+\S/.test(phrase)) {
        wrong.push(`${path}: "${phrase}"`);
      }
    }
    expect(wrong, wrong.join('; ')).toEqual([]);
  });

  it('starts every phrase with a word, never punctuation or a code', () => {
    const wrong: string[] = [];
    for (const path of LEAVES) {
      const phrase = categoryPhrase(path);
      if (!/^[A-Za-z0-9]/.test(phrase)) wrong.push(`${path}: "${phrase}"`);
      if (/[._]/.test(phrase)) wrong.push(`${path}: "${phrase}" reads like a code`);
      if (phrase !== phrase.trim()) wrong.push(`${path}: "${phrase}" has stray spacing`);
    }
    expect(wrong, wrong.join('; ')).toEqual([]);
  });

  it('renders the whole taxonomy through every frame without throwing', () => {
    let rendered = 0;
    for (const path of LEAVES) {
      for (const { text } of framesFor(path)) {
        expect(typeof text).toBe('string');
        rendered++;
      }
    }
    expect(rendered).toBe(LEAVES.length * 17);
  });
});

describe('the article helper on its own', () => {
  it('works from how a word is said, not only how it is spelt', () => {
    expect(articleForPhrase('mountain bike')).toBe('a');
    expect(articleForPhrase('oven')).toBe('an');
    expect(articleForPhrase('e-bike')).toBe('an');
    expect(articleForPhrase('DSLR camera')).toBe('a');
    expect(articleForPhrase('BMX bike')).toBe('a');
    expect(articleForPhrase('SLR camera')).toBe('an');
    expect(articleForPhrase('university place')).toBe('a');
  });

  it('takes the taxonomy’s word where the spelling misleads', () => {
    // X is said "ex", which the spelling alone would never tell you.
    expect(categoryPhraseWithArticle('goods.electronics.console.xbox')).toBe('an Xbox');
    expect(categoryPhraseWithArticle('goods.bicycle.mountain')).toBe('a mountain bike');
    expect(categoryPhraseWithArticle('goods.sports.outdoor.climbing')).toBe('climbing gear');
    expect(categoryPhraseWithArticle('services.lessons.guitar')).toBe('guitar lessons');
  });

  it('leaves a mass noun and a plural without an article at all', () => {
    expect(categoryPhraseIsCountable('goods.sports.outdoor.climbing')).toBe(false);
    expect(categoryPhraseIsCountable('goods.bicycle.mountain')).toBe(true);
    expect(categoryPhraseWithArticle('goods.clothing.kids')).toBe("kids' clothing");
  });
});
