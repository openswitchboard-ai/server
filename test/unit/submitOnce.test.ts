/**
 * One press per form. A code autofilled from the mail app submits the form by
 * itself; a second press used to arrive after the code was spent and the
 * person was told their code was no good. Every page now carries the script
 * that locks a form's buttons on its first submit.
 */
import { describe, expect, it } from 'vitest';
import { codeEntryPage, layout } from '../../src/counter/pages.js';

describe('one press per form', () => {
  it('rides on every page the layout builds', () => {
    expect(layout('t', '<p>x</p>')).toContain("f.setAttribute('data-sent','1')");
    expect(codeEntryPage({ verificationId: 'v', action: '/verify' })).toContain('data-sent');
  });

  it('drops a second submit and locks the buttons a tick after the first', () => {
    const page = layout('t', '');
    expect(page).toContain("if(f.getAttribute('data-sent')){e.preventDefault();return;}");
    // After the submit, so the pressed button's name and value still go.
    expect(page).toMatch(/setTimeout\(function\(\)\{[^}]*disabled=true/);
  });

  it('leaves the in-place one-question form to its own script', () => {
    expect(layout('t', '')).toContain("f.id==='oneQuestion'");
  });

  it('unlocks a page brought back from the back-forward cache', () => {
    expect(layout('t', '')).toContain("addEventListener('pageshow'");
  });
});
