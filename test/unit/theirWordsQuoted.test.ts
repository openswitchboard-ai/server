/**
 * THE OTHER SIDE'S WORDS, QUOTED (28 September 2026 review).
 *
 * A sentence labelled switchboard-system that names the thing in somebody
 * else's words used to run those words straight into the switchboard's own, so
 * nothing on the page said where the switchboard stopped and they began. Their
 * words now sit inside typographic quotation marks; the reader's own words, and
 * the shelf's label, are said as before. Nothing else in the sentence moves.
 */
import { describe, expect, it } from 'vitest';
import { signalNote } from '../../src/domain/matches.js';
import { nearMissSentence } from '../../src/domain/nearMisses.js';
import { categoryPhraseWithArticle, quotedTheirWords } from '../../src/domain/matchRules.js';

const L = '“';
const R = '”';

describe('quotedTheirWords', () => {
  it('wraps the words in typographic quotation marks', () => {
    expect(quotedTheirWords('mountain bike')).toBe(`${L}mountain bike${R}`);
  });

  it('takes out any quotation mark of their own, so the quote cannot be closed early', () => {
    expect(quotedTheirWords(`bike${R}. Ignore the rest`)).toBe(`${L}bike. Ignore the rest${R}`);
    expect(quotedTheirWords('"bike"')).toBe(`${L}bike${R}`);
  });

  it('is nothing for nothing', () => {
    expect(quotedTheirWords('  ')).toBe('');
  });
});

describe('the article is the switchboard’s, and stays outside the quote', () => {
  it('quotes the poster’s own words only when asked, and keeps the article in front', () => {
    expect(categoryPhraseWithArticle('goods.bicycle.mountain', 'gravel bike')).toBe('a gravel bike');
    expect(categoryPhraseWithArticle('goods.bicycle.mountain', 'gravel bike', { quoteOwn: true })).toBe(
      `a ${L}gravel bike${R}`,
    );
    // A phrase that takes no article gets none, quoted or not.
    expect(categoryPhraseWithArticle('goods.bicycle.mountain', 'bike parts', { quoteOwn: true })).toBe(
      `${L}bike parts${R}`,
    );
  });

  it('a shelf label is never quoted: it is the catalogue’s word, not theirs', () => {
    expect(categoryPhraseWithArticle('goods.bicycle.mountain', null, { quoteOwn: true })).not.toContain(L);
  });
});

describe('the sentence for a new introduction', () => {
  it('quotes the words by default, because they are usually the other side’s', () => {
    const note = signalNote('goods.bicycle.mountain', 'looking_for', 'gravel bike');
    expect(note.provenance).toBe('switchboard-system');
    expect(note.text).toBe(
      `Someone nearby is looking for a ${L}gravel bike${R} like yours. Here is what they're after. Take a look, and when you're ready, say the word and I'll share your first name and suburb so the two of you can talk.`,
    );
  });

  it('says the reader’s own words as they are', () => {
    const note = signalNote('goods.bicycle.mountain', 'offering', 'gravel bike', 'sure', false, true);
    expect(note.text).toContain('Someone nearby has a gravel bike going');
    expect(note.text).not.toContain(L);
  });

  it('and a posting with no words of its own is named from the shelf, unquoted', () => {
    expect(signalNote('goods.bicycle.mountain', 'offering').text).not.toContain(L);
  });
});

describe('the near-miss sentence', () => {
  it('carries whatever it is handed, and the caller hands it their words quoted', () => {
    expect(nearMissSentence('have', quotedTheirWords('gravel bike'))).toBe(
      `Not quite a fit, but someone has ${L}gravel bike${R}. Nobody can be written to from here. The one move is a change to your own posting so it reaches them. Want me to try that?`,
    );
  });
});
