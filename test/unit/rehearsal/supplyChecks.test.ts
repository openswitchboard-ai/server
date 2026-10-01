/**
 * The supply question (manual 82): asked once after an account's first
 * posting goes up, and not pushed again after a no.
 */
import { describe, expect, it } from 'vitest';
import { SUPPLY_ASK, checkSupplyAsked, checkSupplyNotPushed } from '../../rehearsal/checks.js';

describe('the supply-question checks', () => {
  it('reads the ask in ordinary wordings', () => {
    for (const t of [
      "Anything you'd lend, give away or sell while we're here?",
      'Is there anything else you could offer, like something to lend?',
      'While we are at it, got something you would sell or give away?',
    ]) expect(SUPPLY_ASK.test(t), t).toBe(true);
    for (const t of ["It's up. I'll check back in a few minutes.", 'Anything else about the ladder I should add?']) {
      expect(SUPPLY_ASK.test(t), t).toBe(false);
    }
  });

  it('skips an account the switchboard did not hand the question to', () => {
    expect(checkSupplyAsked('seller', false, []).verdict).toBe('skip');
  });

  it('passes an ask, fails a question never asked', () => {
    expect(checkSupplyAsked('buyer', true, ["Posted. Anything you'd lend, give away or sell while we're here?"]).verdict).toBe('pass');
    expect(checkSupplyAsked('buyer', true, ['Posted.']).verdict).toBe('fail');
  });

  it('fails asking again after a no', () => {
    expect(checkSupplyNotPushed('seller', ['No worries.']).verdict).toBe('pass');
    expect(checkSupplyNotPushed('seller', ['Sure? Anything at all you could give away?']).verdict).toBe('fail');
    expect(checkSupplyNotPushed('seller', undefined).verdict).toBe('skip');
  });
});
