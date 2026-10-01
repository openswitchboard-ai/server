/**
 * AN ADDRESS OR A PHONE NUMBER IS REFUSED IN THE WORDS, AND POINTED AT ITS
 * PAGE (1 October 2026; intake/checks/contactDetails.ts, manual 81).
 *
 *  - The message and offer-words doors refuse it, with the lane's own
 *    sentence, and the refusal keeps nothing of the words.
 *  - Times, prices and the rest of an ordinary handover pass the same doors.
 *  - A photo caption says it to the person on their own page.
 *  - The tool surface and the manual say where contact details go instead.
 *  - The link that goes there refuses at mint time before names have crossed
 *    and while the other side has no browser ready.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as db from '../../src/db.js';
import { runIntake, CHECKS } from '../../src/intake/pipe.js';
import { contactDetails, CONTACT_IN_WORDS_ACTION } from '../../src/intake/checks/contactDetails.js';
import { entryParams } from '../../src/safety/ledger.js';
import { generateKeyPairSync } from 'node:crypto';
import { refusalWords } from '../../src/domain/channel.js';
import { checkCaption } from '../../src/domain/channelPhoto.js';
import { CONTACT_IN_WORDS_REASON, CONTACT_IN_CAPTION_LINE } from '../../src/domain/contactInWords.js';
import { say } from '../../src/domain/lanes.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import { MANUAL_CHANGELOG, manualSection } from '../../src/mcp/instructions.js';
import { TOOLS, toolsFor } from '../../src/mcp/tools.js';
import { CONTACT_NOT_READY, fetchAgainFor, sendContactLink } from '../../src/domain/humanLinks.js';
import { OsbError } from '../../src/protocol.js';
import { attachContactsToSweep } from '../../src/domain/sealedContact.js';
import type { Config } from '../../src/config.js';

const ON = { sealedContact: true } as unknown as Config;
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc';
const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

afterEach(() => vi.restoreAllMocks());

describe('the words doors', () => {
  it('refuses an address or a phone number in a message and in an offer note', async () => {
    for (const door of ['message', 'offer_words'] as const) {
      for (const text of ['call me on 0412 345 678', 'come to 12 Smith St after five', 'email me at sam@example.com']) {
        const v = await runIntake(ON, { door, sender_account: ANA, text }, { checks: [contactDetails], ledger: { recordVerdict() {} } });
        expect(v.outcome, `${door}: ${text}`).toBe('refuse');
        expect(v.reason_code).toBe(CONTACT_IN_WORDS_REASON);
        expect(v.plain_words).toBe(CONTACT_IN_WORDS_ACTION);
      }
    }
  });

  it('lets an ordinary handover through', async () => {
    for (const text of ['Thursday around 7pm at the station car park?', 'I can do 7:30, it is 54cm and 2 years old']) {
      const v = await runIntake(ON, { door: 'message', sender_account: ANA, text }, { checks: [contactDetails], ledger: { recordVerdict() {} } });
      expect(v.outcome, text).toBe('pass');
    }
  });

  it('changes nothing where the page is switched off', async () => {
    for (const cfg of [undefined, { sealedContact: false } as unknown as Config]) {
      const v = await runIntake(cfg, { door: 'message', sender_account: ANA, text: 'call me on 0412 345 678' }, {
        checks: [contactDetails],
        ledger: { recordVerdict() {} },
      });
      expect(v.outcome).toBe('pass');
    }
    expect(checkCaption('ring 0412 345 678')).toBe('ring 0412 345 678');
  });

  it('keeps nothing of refused words in the ledger', () => {
    const { publicKey } = generateKeyPairSync('x25519');
    const params = entryParams(
      publicKey,
      { door: 'message', sender_account: ANA, text: 'call me on 0412 345 678' },
      { outcome: 'refuse', reason_code: CONTACT_IN_WORDS_REASON, checks: [{ name: 'contactDetails', outcome: 'refuse', reason_code: CONTACT_IN_WORDS_REASON, detail: 'phone' }] },
    );
    expect(JSON.stringify(params)).not.toContain('0412');
    // No body, no key, no nonce for a refused item.
    expect(params.slice(9, 12)).toEqual([null, null, null]);
  });

  it('stands at the doors where one person writes free words to another, and not the report', () => {
    expect(contactDetails.doors).toEqual(['message', 'offer_words']);
    expect(CHECKS.map((c) => c.name)).toContain('contactDetails');
  });

  it('answers in the agent’s own lane', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string) =>
        /arrangement/.test(sql)
          ? { rows: [{ arrangement: { runs_on_its_own: true, check_every_minutes: 60 } }], rowCount: 1 }
          : { rows: [{ hears_via: 'assistant' }], rowCount: 1 },
    } as any);
    const said = await refusalWords(ANA, CONTACT_IN_WORDS_REASON, CONTACT_IN_WORDS_ACTION);
    expect(said).toContain('respond(request_send_contact)');
    // Any other refusal keeps the check's own sentence.
    expect(await refusalWords(ANA, 'money-figure-in-words', 'the figure words')).toBe('the figure words');
    for (const lane of ['prompted', 'autonomous'] as const) {
      const text = say('contact_in_words', lane, lane === 'prompted' ? {} : { runs_on_its_own: true, check_every_minutes: 60 });
      expect(text).toContain('respond(request_send_contact)');
      expect(text).toMatch(/neither assistant sees them/);
      expect(lintHumanCopy(text)).toEqual([]);
    }
  });

  it('turns a caption back on the page, in the person’s own words', () => {
    expect(() => checkCaption('ring 0412 345 678', true)).toThrow(CONTACT_IN_CAPTION_LINE);
    expect(checkCaption('the scratch on the left side', true)).toBe('the scratch on the left side');
    expect(lintHumanCopy(CONTACT_IN_CAPTION_LINE)).toEqual([]);
  });
});

describe('what the tools and the manual say', () => {
  const desc = (n: string) => TOOLS.find((t) => t.name === n)!;

  it('offers the page on respond, and refuses the words on send_message', () => {
    expect((desc('respond').inputSchema as any).properties.action.enum).toContain('request_send_contact');
    expect(desc('respond').description).toMatch(/request_send_contact \(address, phone or email: they type it there; never ask or relay\)/);
    expect(desc('send_message').description).toMatch(/An address, phone number or email is REFUSED too/);
    expect(desc('send_message').description).toContain('respond(request_send_contact)');
  });

  it('serves the descriptions from before where the page is off', () => {
    const off = toolsFor({ sealedContact: false });
    const respond = off.find((t) => t.name === 'respond')!;
    expect(respond.description).not.toContain('request_send_contact');
    expect((respond.inputSchema as any).properties.action.enum).not.toContain('request_send_contact');
    expect(off.find((t) => t.name === 'send_message')!.description).not.toContain('request_send_contact');
    expect(toolsFor({ sealedContact: true })).toBe(TOOLS);
    for (const t of off) expect(t.description.length, t.name).toBeLessThanOrEqual(1900);
  });

  it('writes the rule down at version 81, and in the photos section', () => {
    const note = MANUAL_CHANGELOG.find((c) => c.version === 81)!.note;
    expect(note).toContain('respond(request_send_contact)');
    expect(note).toMatch(/Never ask your human for an address or a phone number, never ask them to type one to you, and never relay one/);
    expect(note).toMatch(/opens once, so they should write the details down/);
    const photos = manualSection('photos')!.text;
    expect(photos).toMatch(/an address, a phone number or an email has that page of its own and never goes in a message, an offer note or a caption/);
    expect(photos).toMatch(/Where it answers that the page is not on here, the older rule holds/);
    // The old rule, that a number travels in the words on the human's say-so, is gone.
    expect(photos).not.toMatch(/A phone number, an address or an email is not yours to offer/);
  });
});

describe('the send page link', () => {
  const cfg = { counterOrigin: 'https://my.test', sealedContact: true } as unknown as Config;
  const pool = (m: any, keys: any[]) =>
    ({
      query: async (sql: string) => {
        if (/FROM matches WHERE id/.test(sql)) return { rows: [m], rowCount: 1 };
        if (/FROM contact_keys/.test(sql)) return { rows: keys, rowCount: keys.length };
        return { rows: [], rowCount: 0 };
      },
    }) as any;
  const match = (over: any = {}) => ({ id: MATCH, account_want: ANA, account_have: BEPPE, state: 'open', stage: 3, ...over });

  it('refuses before first names have crossed', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(pool(match({ stage: 2 }), [{ key_id: 'a'.repeat(32), public_key: Buffer.alloc(65) }]));
    await expect(sendContactLink(cfg, ANA, MATCH)).rejects.toThrow(OsbError);
  });

  it('answers plainly where it is switched off', async () => {
    await expect(sendContactLink({ ...cfg, sealedContact: false } as Config, ANA, MATCH)).rejects.toThrow(OsbError);
  });

  it('refuses while the other side has no browser ready, asks them to set one up, and says what to do', async () => {
    const asked: any[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string, params: any[]) => {
        if (/FROM matches WHERE id/.test(sql)) return { rows: [match()], rowCount: 1 };
        if (/INSERT INTO contact_setup_asks/.test(sql)) asked.push(params);
        return { rows: [], rowCount: 0 };
      },
    } as any);
    try {
      await sendContactLink(cfg, ANA, MATCH);
      throw new Error('minted');
    } catch (e: any) {
      expect(e).toBeInstanceOf(OsbError);
      expect(e.payload.human_action).toBe(CONTACT_NOT_READY);
    }
    expect(lintHumanCopy(CONTACT_NOT_READY)).toEqual([]);
    // The other side's assistant is handed a page to set one up.
    expect(asked).toEqual([[MATCH, ANA, BEPPE]]);
  });

  it('is fetched again the same way when it runs out', () => {
    expect(fetchAgainFor({ action: 'contact-send', ref_id: MATCH })).toEqual({
      tool: 'respond',
      action: 'request_send_contact',
      intro_id: MATCH,
    });
  });
});

describe('what the sweep carries', () => {
  const facts = { arrangement: {}, hearsVia: 'email' as const };
  const cfg = { counterOrigin: 'https://my.test' };
  const poolWith = (sealedRows: any[], askRows: any[]) =>
    ({
      query: async (sql: string) => {
        if (/FROM contact_setup_asks/.test(sql)) return { rows: askRows, rowCount: askRows.length };
        if (/FROM sealed_contacts s/.test(sql)) return { rows: sealedRows, rowCount: sealedRows.length };
        return { rows: [], rowCount: 0 };
      },
    }) as any;

  it('leads with the page waiting for the recipient, and gives the agent its lane sentence', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(
      poolWith([{ id: 'sid-1', match_id: MATCH, sender_account: BEPPE, recipient_account: ANA, expires_at: new Date(), missed_at: null }], []),
    );
    const entries: any[] = [{ intro_id: MATCH, note: { text: 'The state sentence.' } }];
    await attachContactsToSweep(cfg, ANA, entries, facts);
    const c = entries[0].contact_details;
    expect(c.waiting).toBe(true);
    expect(c.link).toBe('https://my.test/c/sid-1');
    expect(c.say).toMatch(/has sent you their contact details\. Here is your page\. It shows them once, so have somewhere to write them down: https:\/\/my\.test\/c\/sid-1$/);
    expect(c.note.text).toMatch(/Never ask them to read the details out or type them to you/);
    expect(entries[0].note.text.startsWith(c.say)).toBe(true);
    expect(entries[0].note.text).toContain('The state sentence.');
  });

  it('hands the recipient a setup page when no browser of theirs can receive, and tells the sender when it can', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(
      poolWith([], [{ match_id: MATCH, sender_account: BEPPE, recipient_account: ANA, ready: false }]),
    );
    const recipient: any[] = [{ intro_id: MATCH }];
    await attachContactsToSweep(cfg, ANA, recipient, facts);
    expect(recipient[0].contact_details.setup).toBe(true);
    expect(recipient[0].contact_details.link).toBe('https://my.test/contact-keys/setup');
    expect(recipient[0].contact_details.say).toMatch(/contact details are ready to come to you\. Open this page once to set up this browser to receive them/);

    vi.spyOn(db, 'getPool').mockReturnValue(
      poolWith([], [{ match_id: MATCH, sender_account: BEPPE, recipient_account: ANA, ready: true }]),
    );
    const sender: any[] = [{ intro_id: MATCH }];
    await attachContactsToSweep(cfg, BEPPE, sender, facts);
    expect(sender[0].contact_details.ready).toBe(true);
    expect(sender[0].contact_details.ready_note.text).toMatch(/Fetch respond\(request_send_contact\)/);
  });
});
