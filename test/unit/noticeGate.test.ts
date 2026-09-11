/**
 * The notice rule, enforced in the one place every email passes through.
 *
 * The rule (Lachlan, 2026-09-11): a notice email is sent ONLY when the
 * recipient's hears_via is 'email', and it carries NO link and NO button. It
 * says what happened in one sentence and ends "Ask your assistant."
 *
 * Three exemptions, and only three: the verification code (it is how someone
 * signs in), the security notices, and the kill-switch mail. Those go out
 * whatever hears_via says, because they are about the account rather than
 * about the network.
 *
 * Both halves live in email/send.ts rather than at each call site, so a new
 * template cannot quietly opt itself out of either. That is what this suite
 * holds shut.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sesSend = vi.fn(async () => ({ MessageId: 'ses-1' }));
vi.mock('../../src/aws.js', () => ({ sesv2: { send: (...a: unknown[]) => sesSend(...(a as [])) } }));

import * as db from '../../src/db.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { sendEmail } from '../../src/email/send.js';
import { EXEMPT_TEMPLATES, NOTICE_TEMPLATES } from '../../src/email/templates.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  sesFrom: 'switchboard@test',
  sesReplyTo: 'switchboard@test',
  sesConfigurationSet: 'cs',
} as unknown as Config;

const ACCOUNT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const FOOTER =
  '<a href="https://my.test/settings">Email settings</a> ' +
  '<a href="https://my.test/email/unsub?t=x">Unsubscribe</a>';

beforeAll(async () => {
  // The pipeline paces SES at one send a second. That pacing is its own
  // concern and is covered elsewhere; here it would only make the suite wait,
  // so the gap is taken out.
  vi.stubGlobal('setTimeout', ((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
});

let hearsVia: 'email' | 'assistant';
let recorded: { template: string; status: string; detail: string | null }[];

beforeEach(() => {
  hearsVia = 'email';
  recorded = [];
  sesSend.mockClear();
  vi.spyOn(db, 'getPool').mockReturnValue({
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: hearsVia }]);
      if (/SELECT email_unreachable_at/.test(sql)) {
        return rows([{ email_unreachable_at: null, email_complaint_suppressed_at: null }]);
      }
      if (/INSERT INTO email_sends/.test(sql)) {
        recorded.push({ template: params[3], status: params[6], detail: params[7] });
        return rows([{ id: 'send-1' }]);
      }
      if (/UPDATE email_sends/.test(sql)) return rows([]);
      return rows([]);
    },
  } as any);
});

const send = (template: string, content: Partial<{ html: string; text: string }> = {}) =>
  sendEmail(cfg, {
    to: 'someone@test',
    accountId: ACCOUNT,
    template,
    kind: 'bulk',
    dedupeKey: `${template}:1`,
    content: {
      subject: 'Something happened',
      html: `<p>Someone has come forward.</p><p>Ask your assistant.</p>${FOOTER}`,
      text: 'Someone has come forward.\n\nAsk your assistant.\n\nEmail settings: https://my.test/settings',
      ...content,
    },
  });

describe('a notice goes only to someone who hears by email', () => {
  it('sends when email is how they hear', async () => {
    const r = await send('summons');
    expect(r.status).toBe('sent');
    expect(sesSend).toHaveBeenCalledTimes(1);
  });

  it('is held back when their assistant brings them the news', async () => {
    hearsVia = 'assistant';
    const r = await send('summons');
    expect(r.status).toBe('suppressed');
    expect(sesSend).not.toHaveBeenCalled();
    expect(recorded[0].detail).toBe('their assistant brings them the news');
  });

  it('holds back every notice, one template at a time', async () => {
    hearsVia = 'assistant';
    for (const template of NOTICE_TEMPLATES) {
      sesSend.mockClear();
      expect((await send(template)).status, template).toBe('suppressed');
      expect(sesSend, template).not.toHaveBeenCalled();
    }
  });

  it('an unknown template is treated as a notice rather than waved through', async () => {
    hearsVia = 'assistant';
    expect((await send('something-new')).status).toBe('suppressed');
  });
});

describe('the three exemptions send whatever hears_via says', () => {
  it('each one goes out to an always-on account, and may carry a link', async () => {
    hearsVia = 'assistant';
    for (const template of EXEMPT_TEMPLATES) {
      sesSend.mockClear();
      const r = await sendEmail(cfg, {
        to: 'someone@test',
        accountId: ACCOUNT,
        template,
        kind: 'transactional',
        dedupeKey: `${template}:1`,
        content: {
          subject: 'Your code',
          html: `<a href="https://my.test/verify?t=tok" style="padding:14px 34px">Open</a>${FOOTER}`,
          text: 'Open this link:\nhttps://my.test/verify?t=tok',
        },
      });
      expect(r.status, template).toBe('sent');
    }
  });
});

describe('a notice may carry no link and no button', () => {
  it('a button in a notice is a hard failure, before anything is sent', async () => {
    await expect(
      send('summons', {
        html: `<a href="https://my.test/settings" style="padding:14px 34px">Go</a>${FOOTER}`,
      }),
    ).rejects.toThrow(/no link and no button/);
    expect(sesSend).not.toHaveBeenCalled();
  });

  it('a link in a notice is a hard failure, in the HTML and in the plaintext', async () => {
    await expect(
      send('summons', { html: `<p><a href="https://my.test/a/tok">Decide</a></p>${FOOTER}` }),
    ).rejects.toThrow(/no link and no button/);
    await expect(
      send('summons', { text: 'Decide:\nhttps://my.test/a/tok' }),
    ).rejects.toThrow(/no link and no button/);
    expect(sesSend).not.toHaveBeenCalled();
  });

  it('the two footer controls are fine, because every sender has to carry them', async () => {
    const r = await send('summons');
    expect(r.status).toBe('sent');
  });
});
