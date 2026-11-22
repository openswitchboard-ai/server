import { describe, expect, it } from 'vitest';
import { lintHumanCopy } from '../../src/email/lint.js';
import * as home from '../../src/counter/pagesHome.js';
import * as pages from '../../src/counter/pages.js';
import { PIN_MASK_JS } from '../../src/counter/pinMask.js';
import { SEALED_JS } from '../../src/counter/sealedScript.js';
import { PRIVACY_URL, TERMS_URL, TERMS_VERSION, termsCurrent } from '../../src/counter/terms.js';

describe('agreeing to the terms', () => {
  it('a new account ticks the terms beside the other two, with both documents linked', () => {
    const html = home.consentPage();
    expect(html).toContain('Three things to confirm.');
    expect(html).toMatch(/name="adult" value="yes" required/);
    expect(html).toMatch(/name="consent" value="yes" required/);
    expect(html).toMatch(/name="terms" value="yes" required/);
    expect(html).toContain(`href="${TERMS_URL}"`);
    expect(html).toContain(`href="${PRIVACY_URL}"`);
    expect(lintHumanCopy(html)).toEqual([]);
  });

  it('an existing account is asked once, says what changed, and can leave instead', () => {
    const html = home.termsUpdatePage();
    expect(html).toContain('Our terms have changed.');
    expect(html).toMatch(/action="\/terms-update"/);
    expect(html).toMatch(/name="terms" value="yes" required/);
    expect(html).toContain('href="/settings"');
    expect(lintHumanCopy(html)).toEqual([]);
  });

  it('only the current version counts as agreed', () => {
    expect(termsCurrent({ terms_version: TERMS_VERSION })).toBe(true);
    expect(termsCurrent({ terms_version: '2026-01-01' })).toBe(false);
    expect(termsCurrent({})).toBe(false);
    expect(termsCurrent(undefined)).toBe(false);
  });
});

describe('PIN boxes show dots', () => {
  it('every ordinary page carries the masking script, and sealed.js carries it for the sealed pages', () => {
    expect(pages.landingPage()).toContain(PIN_MASK_JS);
    expect(SEALED_JS).toContain(PIN_MASK_JS);
  });

  it('the boxes stay plain text boxes, so Safari does not offer to save a password', () => {
    const html = pages.pinSetPage();
    expect(html).toMatch(/id="pin" name="pin" type="text" class="pinbox"/);
    expect(html).not.toMatch(/type="password"/);
    // The CSS comment names text-security; no rule uses it.
    expect(html).not.toMatch(/text-security\s*:/);
  });
});
