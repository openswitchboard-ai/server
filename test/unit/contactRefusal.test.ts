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
import { TOOLS } from '../../src/mcp/tools.js';
import { CONTACT_NOT_READY, fetchAgainFor, sendContactLink } from '../../src/domain/humanLinks.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc';
const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

afterEach(() => vi.restoreAllMocks());

describe('the words doors', () => {
  it('refuses an address or a phone number in a message and in an offer note', async () => {
    for (const door of ['message', 'offer_words'] as const) {
      for (const text of ['call me on 0412 345 678', 'come to 12 Smith St after five']) {
        const v = await runIntake(undefined, { door, sender_account: ANA, text }, { checks: [contactDetails] });
        expect(v.outcome, `${door}: ${text}`).toBe('refuse');
        expect(v.reason_code).toBe(CONTACT_IN_WORDS_REASON);
        expect(v.plain_words).toBe(CONTACT_IN_WORDS_ACTION);
      }
    }
  });

  it('lets an ordinary handover through', async () => {
    for (const text of ['Thursday around 7pm at the station car park?', 'I can do 7:30, it is 54cm and 2 years old']) {
      const v = await runIntake(undefined, { door: 'message', sender_account: ANA, text }, { checks: [contactDetails] });
      expect(v.outcome, text).toBe('pass');
    }
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
    expect(() => checkCaption('ring 0412 345 678')).toThrow(CONTACT_IN_CAPTION_LINE);
    expect(checkCaption('the scratch on the left side')).toBe('the scratch on the left side');
    expect(lintHumanCopy(CONTACT_IN_CAPTION_LINE)).toEqual([]);
  });
});

describe('what the tools and the manual say', () => {
  const desc = (n: string) => TOOLS.find((t) => t.name === n)!;

  it('offers the page on respond, and refuses the words on send_message', () => {
    expect((desc('respond').inputSchema as any).properties.action.enum).toContain('request_send_contact');
    expect(desc('respond').description).toMatch(/request_send_contact \(address or phone: they type it there; never ask or relay\)/);
    expect(desc('send_message').description).toMatch(/An address or a phone number is REFUSED too/);
    expect(desc('send_message').description).toContain('respond(request_send_contact)');
  });

  it('writes the rule down at version 81, and in the photos section', () => {
    const note = MANUAL_CHANGELOG.find((c) => c.version === 81)!.note;
    expect(note).toContain('respond(request_send_contact)');
    expect(note).toMatch(/Never ask your human for an address or a phone number, never ask them to type one to you, and never relay one/);
    expect(note).toMatch(/opens once, so they should write the details down/);
    const photos = manualSection('photos')!.text;
    expect(photos).toMatch(/An address or a phone number never goes in a message, an offer note or a caption/);
    // The old rule, that a number travels in the words on the human's say-so, is gone.
    expect(photos).not.toMatch(/A phone number, an address or an email is not yours to offer/);
    expect(manualSection('start')!.text).toMatch(/an address or phone number only ever goes from that page/);
  });
});

describe('the send page link', () => {
  const cfg = { counterOrigin: 'https://my.test' } as unknown as Config;
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

  it('refuses while the other side has no browser ready, and says what to do', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(pool(match(), []));
    try {
      await sendContactLink(cfg, ANA, MATCH);
      throw new Error('minted');
    } catch (e: any) {
      expect(e).toBeInstanceOf(OsbError);
      expect(e.payload.human_action).toBe(CONTACT_NOT_READY);
    }
    expect(lintHumanCopy(CONTACT_NOT_READY)).toEqual([]);
  });

  it('is fetched again the same way when it runs out', () => {
    expect(fetchAgainFor({ action: 'contact-send', ref_id: MATCH })).toEqual({
      tool: 'respond',
      action: 'request_send_contact',
      intro_id: MATCH,
    });
  });
});
