/**
 * A link opened while signed in as somebody else. The first rehearsal that
 * ran both sides in one browser hit the old "sign in" page, whose button led
 * to a sign-in page that bounced a signed-in person straight home, with no
 * word about why. The page now says what is wrong and offers sign-out.
 */
import { describe, expect, it } from 'vitest';
import { wrongAccountPage } from '../../src/counter/pages.js';

describe('the wrong-account page', () => {
  const page = wrongAccountPage();

  it('says the link belongs to a different account and that it stays good', () => {
    expect(page).toContain('This link is for a different account');
    expect(page).toContain('The link stays good.');
  });

  it('offers sign-out as a form, since sign-out is a POST', () => {
    expect(page).toMatch(/<form method="post" action="\/logout">/);
    expect(page).toContain('Sign out');
    expect(page).not.toContain('href="/login"');
  });
});
