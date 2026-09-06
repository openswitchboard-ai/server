import { describe, expect, it } from 'vitest';

import {
  canonicaliseAttributes,
  canonicaliseValue,
  enumVocabulary,
} from '../../src/domain/attributeCanon.js';
import { projectionText } from '../../src/domain/matchRules.js';

const BIKE = 'goods.bicycle.mountain';

describe('whitespace and case', () => {
  it('trims and collapses whitespace inside a free-text value', () => {
    expect(canonicaliseValue(BIKE, 'notes', '  a   well   loved  bike ')).toBe(
      'a well loved bike',
    );
  });

  it('lowercases free text without touching its words', () => {
    expect(canonicaliseValue(BIKE, 'brand', 'Trek Marlin 7')).toBe('trek marlin 7');
  });

  it('leaves an empty value empty rather than inventing one', () => {
    expect(canonicaliseValue(BIKE, 'notes', '   ')).toBe('');
  });
});

describe('the taxonomy vocabulary', () => {
  it('reads an enum defined on the node itself', () => {
    expect(enumVocabulary(BIKE, 'suspension')).toEqual(['rigid', 'hardtail', 'full']);
  });

  it('reads an enum from common_attributes when no node defines the key', () => {
    expect(enumVocabulary(BIKE, 'condition')).toEqual([
      'new',
      'like-new',
      'good',
      'fair',
      'parts-only',
    ]);
  });

  it('reports no vocabulary for a free-string key the taxonomy types loosely', () => {
    expect(enumVocabulary('goods.bicycle', 'frame_size')).toBeUndefined();
  });

  it('matches a vocabulary value case-insensitively', () => {
    expect(canonicaliseValue(BIKE, 'condition', 'GOOD')).toBe('good');
  });

  it('reads spaces, underscores and hyphens as the same separator', () => {
    expect(canonicaliseValue(BIKE, 'condition', 'Like New')).toBe('like-new');
    expect(canonicaliseValue(BIKE, 'condition', 'like_new')).toBe('like-new');
    expect(canonicaliseValue(BIKE, 'condition', 'PARTS ONLY')).toBe('parts-only');
  });

  it('completes an unambiguous abbreviation', () => {
    expect(canonicaliseValue('social.language-exchange', 'proficiency', 'int')).toBe(
      'intermediate',
    );
    expect(canonicaliseValue(BIKE, 'suspension', 'hard')).toBe('hardtail');
  });

  it('leaves an ambiguous abbreviation alone', () => {
    // 'o' opens both 'once' and 'ongoing', so the switchboard does not guess.
    expect(canonicaliseValue('social.conversation', 'frequency', 'o')).toBe('o');
  });

  it('leaves a value the vocabulary does not contain alone, lowercased', () => {
    expect(canonicaliseValue(BIKE, 'condition', 'Immaculate')).toBe('immaculate');
  });

  it('lets a category vocabulary win over the size scale', () => {
    // bed_size is single/double/queen/king. The s -> small mapping must not
    // reach a key the taxonomy has an opinion on, and a single letter is not
    // treated as an abbreviation, so 's' is left exactly as it was written
    // rather than being turned into a size no bed has.
    expect(canonicaliseValue('goods.furniture.bed', 'bed_size', 's')).toBe('s');
    expect(canonicaliseValue('goods.furniture.bed', 'bed_size', 'Queen')).toBe('queen');
    expect(canonicaliseValue('goods.furniture.bed', 'bed_size', 'KING SIZE')).toBe('king size');
    expect(canonicaliseValue('goods.furniture.mattress', 'bed_size', 'dou')).toBe('double');
  });
});

describe('booleans', () => {
  it('turns yes and no into real booleans', () => {
    expect(canonicaliseValue('goods.electronics.phone', 'unlocked', 'yes')).toBe(true);
    expect(canonicaliseValue('goods.electronics.phone', 'unlocked', 'No')).toBe(false);
  });

  it('accepts the single-letter and spelled-out forms', () => {
    expect(canonicaliseValue(BIKE, 'boxed', 'Y')).toBe(true);
    expect(canonicaliseValue(BIKE, 'boxed', 'FALSE')).toBe(false);
  });

  it('leaves a real boolean untouched', () => {
    expect(canonicaliseValue(BIKE, 'boxed', true)).toBe(true);
  });
});

describe('numbers', () => {
  it('turns a purely numeric string into a number', () => {
    expect(canonicaliseValue('goods.bicycle', 'wheel_size_in', '26')).toBe(26);
    expect(canonicaliseValue('goods.furniture', 'width_cm', ' 180.5 ')).toBe(180.5);
  });

  it('keeps a numeric size as a number rather than a letter scale', () => {
    expect(canonicaliseValue('goods.bicycle', 'frame_size', '54')).toBe(54);
  });

  it('leaves a string whose number would not print back the same', () => {
    expect(canonicaliseValue(BIKE, 'model', '1.10')).toBe('1.10');
    expect(canonicaliseValue(BIKE, 'model', '007')).toBe('007');
  });

  it('leaves a value that is not purely numeric', () => {
    expect(canonicaliseValue('goods.bicycle', 'frame_size', '54cm')).toBe('54cm');
    expect(canonicaliseValue(BIKE, 'phone_model', '+61')).toBe('+61');
  });

  it('leaves a real number untouched', () => {
    expect(canonicaliseValue('goods.bicycle', 'wheel_size_in', 27.5)).toBe(27.5);
  });
});

describe('the size scale', () => {
  it('spells out the letter sizes', () => {
    expect(canonicaliseValue('goods.bicycle', 'frame_size', 'M')).toBe('medium');
    expect(canonicaliseValue('goods.bicycle', 'frame_size', 's')).toBe('small');
    expect(canonicaliseValue('goods.bicycle', 'frame_size', 'L')).toBe('large');
    expect(canonicaliseValue('goods.clothing', 'size', 'XL')).toBe('extra-large');
    expect(canonicaliseValue('goods.clothing', 'size', 'xs')).toBe('extra-small');
  });

  it('accepts the written-out and abbreviated spellings', () => {
    expect(canonicaliseValue('goods.clothing', 'size', 'Extra Large')).toBe('extra-large');
    expect(canonicaliseValue('goods.clothing', 'size', 'x-small')).toBe('extra-small');
    expect(canonicaliseValue('goods.baby.clothing', 'size', 'med')).toBe('medium');
  });

  it('applies only to keys that are about size', () => {
    expect(canonicaliseValue(BIKE, 'model', 'm')).toBe('m');
    expect(canonicaliseValue(BIKE, 'size_note', 'm')).toBe('m');
  });

  it('leaves a size word it does not know', () => {
    expect(canonicaliseValue('goods.clothing', 'size', 'Toddler 3')).toBe('toddler 3');
  });
});

describe('the whole bag', () => {
  it('canonicalises every value and leaves the keys alone', () => {
    expect(
      canonicaliseAttributes(BIKE, {
        frame_size: 'M',
        condition: 'Like New',
        wheel_size_in: '29',
        boxed: 'yes',
        brand: '  Trek  ',
      }),
    ).toEqual({
      frame_size: 'medium',
      condition: 'like-new',
      wheel_size_in: 29,
      boxed: true,
      brand: 'trek',
    });
  });

  it('is idempotent, which is what an amend depends on', () => {
    const once = canonicaliseAttributes(BIKE, {
      frame_size: 'M',
      condition: 'Like New',
      wheel_size_in: '29',
      boxed: 'yes',
    });
    expect(canonicaliseAttributes(BIKE, once)).toEqual(once);
  });

  it('hands back an absent or non-object bag unchanged', () => {
    expect(canonicaliseAttributes(BIKE, undefined)).toBeUndefined();
    expect(canonicaliseAttributes(BIKE, {})).toEqual({});
  });
});

describe('the duet pair', () => {
  it('projects the seller and the buyer identically on frame_size', () => {
    const seller = canonicaliseAttributes('goods.bicycle.mountain', { frame_size: 'medium' });
    const buyer = canonicaliseAttributes('goods.bicycle.mountain', { frame_size: 'M' });
    expect(seller).toEqual(buyer);
    expect(
      projectionText({ category: 'goods.bicycle.mountain', attributes: seller }),
    ).toBe(projectionText({ category: 'goods.bicycle.mountain', attributes: buyer }));
  });

  it('was not identical before canonicalisation, which is the bug this fixes', () => {
    expect(
      projectionText({ category: 'goods.bicycle.mountain', attributes: { frame_size: 'medium' } }),
    ).not.toBe(
      projectionText({ category: 'goods.bicycle.mountain', attributes: { frame_size: 'M' } }),
    );
  });
});
