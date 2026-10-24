/**
 * A MASK OR A PLACEHOLDER WHERE A VALUE SHOULD BE (domain/placeholderValues.ts).
 *
 * Found in a rehearsal of lists: an assistant's client masked a detail as
 * "***" and the posting carried it. The rule is narrow on purpose, and this
 * suite holds both halves of it: what is refused, and the real values that
 * look a little like masks and must never be.
 */
import { describe, expect, it } from 'vitest';
import {
  isPlaceholderValue,
  placeholderDetail,
  placeholderDetailSentence,
} from '../../src/domain/placeholderValues.js';
import { readIdentifiers, IDENTIFIER_SENTENCES } from '../../src/domain/identifiers.js';
import { phraseComplaint } from '../../src/domain/refine.js';
import { ITEM_FIXES, readListItem } from '../../src/domain/lists.js';
import { lintHumanCopy } from '../../src/email/lint.js';

describe('what is a placeholder', () => {
  it('refuses values made only of mask marks', () => {
    for (const v of ['***', '*', '• • • •', '●●●●', '####', '???', '?', '___', '-', '—', '...', '…', '~~', '"***"', ' * * * ']) {
      expect(isPlaceholderValue(v), v).toBe(true);
    }
  });

  it('refuses a run of x used as a mask', () => {
    for (const v of ['XXXX-XXXX', 'xxxx xxxx xxxx', 'XXX-XX-XXXX', 'xxxxxx', 'XXXXXXXX', 'xx/xx']) {
      expect(isPlaceholderValue(v), v).toBe(true);
    }
  });

  it('refuses a bracketed placeholder and the three bare redaction words', () => {
    for (const v of ['[redacted]', '<hidden>', '{{number}}', '{value}', '[private]', '[ ]', '()', '(***)', 'REDACTED', 'withheld', 'Placeholder', '**redacted**']) {
      expect(isPlaceholderValue(v), v).toBe(true);
    }
  });

  it('never refuses a real value that looks a little like one', () => {
    for (const v of [
      'XL', 'XXL', 'X', 'XX', 'XXX', 'XXXX', 'xs', '4x4', '****1234', 'Mark XX', 'N/A', 'n/a', 'none', 'unknown',
      'TBC', 'hidden', 'removed', 'private', 'censored', '(boxed)', '(private sale)', '[EN]', '#1', '3.5', '0',
      'mint', 'near mint', 'Hidden Fates', '?!', 'A-', 'B+',
    ]) {
      expect(isPlaceholderValue(v), v).toBe(false);
    }
    // Numbers, true and false are never placeholders.
    for (const v of [0, 1234, true, false, null, undefined]) expect(isPlaceholderValue(v)).toBe(false);
  });

  it('names the first detail that is one, and none where there is none', () => {
    expect(placeholderDetail({ condition: 'good', edition_number: '***' })).toBe('edition_number');
    expect(placeholderDetail({ condition: 'good', size: 'XL' })).toBeUndefined();
    expect(placeholderDetail(undefined)).toBeUndefined();
    expect(placeholderDetail(['***'])).toBeUndefined();
  });
});

describe('where a posting words are read', () => {
  it('turns back a list item with a masked detail, with its number and the fix', () => {
    const r = readListItem({ name: 'desk lamp', details: { colour: 'red', serial_ref: '***' }, open_to_offers: true }, 4, {
      type: 'HAVE',
      deal: 'sale',
    });
    expect(r).toEqual({
      ok: false,
      refusal: { index: 4, reason: 'details', fix: ITEM_FIXES.details_placeholder('serial_ref') },
    });
    // The same item with a real value goes through.
    const ok = readListItem({ name: 'desk lamp', details: { colour: 'red', size: 'XL' }, open_to_offers: true }, 4, {
      type: 'HAVE',
      deal: 'sale',
    });
    expect(ok.ok).toBe(true);
  });

  it('turns back an identifier that is a mask', () => {
    const r = readIdentifiers([{ kind: 'model number', value: 'XXXX-XXXX' }]);
    expect(r).toEqual({ ok: false, reason: 'placeholder', error: IDENTIFIER_SENTENCES.placeholder });
    expect(readIdentifiers([{ kind: 'model number', value: '[redacted]' }]).ok).toBe(false);
    expect(readIdentifiers([{ kind: 'model number', value: 'XXXX' }]).ok).toBe(true);
  });

  it('turns back other words that are a placeholder', () => {
    expect(phraseComplaint('<hidden>')).toContain('a mask or a placeholder');
    expect(phraseComplaint('desk light')).toBeUndefined();
  });

  it('says each refusal in the house register', () => {
    for (const text of [
      placeholderDetailSentence('edition_number'),
      ITEM_FIXES.details_placeholder('edition_number'),
      IDENTIFIER_SENTENCES.placeholder,
    ]) {
      expect(lintHumanCopy(text), text).toEqual([]);
    }
  });
});
