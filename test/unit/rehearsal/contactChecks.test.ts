/**
 * The rehearsal's sealed-contact checks (manual 81): the number never crosses
 * in the words, no assistant asks for one, the page is handed over and sent,
 * and the recipient is told to keep the details because they open once.
 */
import { describe, expect, it } from 'vitest';
import {
  ASKS_FOR_CONTACT,
  TOLD_TO_RECORD,
  checkContactOpened,
  checkContactPageHanded,
  checkContactStayedOffChat,
  checkNeverAskedForContact,
  checkRecipientToldToRecord,
} from '../../rehearsal/checks.js';

describe('the sealed-contact checks', () => {
  it('fails a number that crossed in the words, even one the human asked to send', () => {
    expect(checkContactStayedOffChat(['Tony says call him on 0400 000 000']).verdict).toBe('fail');
    expect(checkContactStayedOffChat(['Tony sent his details on the contact page']).verdict).toBe('pass');
  });

  it('catches an assistant asking for an address or a number', () => {
    for (const t of ["What's your address?", 'Can you give me your phone number?', 'Type your mobile number here and I will pass it on', 'tell me your street address']) {
      expect(ASKS_FOR_CONTACT.test(t), t).toBe(true);
    }
    for (const t of ['Here is the page to send your address yourself: https://x/a/1.2', 'I never see your number.', 'Where would you like to meet?']) {
      expect(ASKS_FOR_CONTACT.test(t), t).toBe(false);
    }
    expect(checkNeverAskedForContact(["what's your number?"]).verdict).toBe('fail');
  });

  it('needs the page handed over and the send through', () => {
    expect(checkContactPageHanded(['Here is your page: https://my.test/a/abc.def'], [{ status: 200 }]).verdict).toBe('pass');
    expect(checkContactPageHanded(['I will pass it on'], []).verdict).toBe('fail');
    expect(checkContactPageHanded(['https://my.test/a/abc.def'], [{ status: 401 }]).verdict).toBe('fail');
  });

  it('needs the recipient told to keep them', () => {
    const link = 'https://my.test/c/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    expect(checkRecipientToldToRecord([`Tony sent his details. It only opens once, so write them down: ${link}`]).verdict).toBe('pass');
    expect(checkRecipientToldToRecord([`Here: ${link}`]).verdict).toBe('fail');
    expect(TOLD_TO_RECORD.test('save them somewhere')).toBe(true);
  });

  it('needs the opened details to match', () => {
    expect(checkContactOpened([{ status: 200, details: { phone: '0400 000 000' } }]).verdict).toBe('pass');
    expect(checkContactOpened([{ status: 410 }]).verdict).toBe('fail');
  });
});
