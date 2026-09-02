/**
 * The shared profile — the first name and rough area that stage 3 hands over.
 *
 * The defect this suite exists to hold shut: registration never asked for
 * either field, so an account carried two encrypted empty strings, both humans
 * could opt in, and the stage-3 payload then failed OUTBOUND schema validation
 * (match.mutual requires minLength 1 on both). The agent saw a malformed
 * server, and nobody was told the one thing that would fix it.
 *
 * The rules asserted here:
 *  - opt_in on an empty profile is REFUSED before anything is recorded, with
 *    CONSENT_REQUIRED, the human sentence, and that human's own approval link;
 *  - a stage-3 fetch on a match where both sides opted in but a profile is
 *    still empty answers CONSENT_REQUIRED as well — the outbound validator is
 *    never reached, and the recorded opt-ins are left alone;
 *  - once both profiles exist, the same fetch returns a valid match.mutual;
 *  - identity is written only by the human's own pages, through the account's
 *    own envelope key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // A stand-in envelope: 'enc:' + plaintext. The real AES-GCM path is proved
  // against live KMS in the integration suite; what matters here is that the
  // domain reads and writes these fields through the envelope helpers at all.
  encryptField: vi.fn(async (_a: string, _k: Buffer, plaintext: string) =>
    Buffer.from(`enc:${plaintext}`),
  ),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v.toString('utf8').replace(/^enc:/, '')]),
    ),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

import { encryptField, writeConsentEvent } from '../../src/crypto.js';
import * as db from '../../src/db.js';
import * as matches from '../../src/domain/matches.js';
import * as profile from '../../src/domain/profile.js';
import * as cpages from '../../src/counter/pages.js';
import * as chome from '../../src/counter/pagesHome.js';
import { lintEmailCopy } from '../../src/email/lint.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { OsbError, validatePayload } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  legacyCounterHosts: ['counter.test'],
  publicOrigin: 'https://mcp.test',
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side
const LINK_ID = 'dddddddd-4444-4444-8444-dddddddddddd';

// ---------------------------------------------------------------------------
// A small world the real statements can be run against: two accounts, one
// stage-3 match with both opt-ins recorded, and the approval_links table.
// ---------------------------------------------------------------------------
interface World {
  accounts: Record<string, { first_name: string; locality: string }>;
  stage: number;
  optins: Set<string>;
  links: any[];
  writes: { sql: string; params: any[] }[];
}

let world: World;

const theMatch = () => ({
  id: MATCH,
  card_want: 'card-w',
  card_have: 'card-h',
  account_want: ANA,
  account_have: BEPPE,
  score: 0.82,
  category: 'social.language-exchange',
  stage: world.stage,
  interest_want: true,
  interest_have: true,
  state: 'open' as const,
  channel_id: null,
  opened_at: null,
});

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/FROM matches/.test(sql) && /^\s*SELECT (\*|m\.\*)/.test(sql)) {
        return rows([theMatch()]);
      }
      if (/FROM cards c/.test(sql)) return rows([]); // no collection window
      if (/^\s*SELECT \* FROM cards WHERE id/.test(sql)) {
        return rows([
          {
            id: params[0],
            type: params[0] === 'card-w' ? 'WANT' : 'HAVE',
            category: 'social.language-exchange',
            attributes: { language: 'italian' },
            ask: null,
            lifecycle_state: 'PUBLISHED',
            account_id: params[0] === 'card-w' ? ANA : BEPPE,
          },
        ]);
      }
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
        const a = world.accounts[params[0]];
        if (!a) return rows([]);
        return rows([
          {
            id: params[0],
            data_key_enc: Buffer.from('wrapped'),
            first_name_enc: Buffer.from(`enc:${a.first_name}`),
            locality_enc: Buffer.from(`enc:${a.locality}`),
            status: 'active',
          },
        ]);
      }
      if (/count\(DISTINCT account_id\)/.test(sql)) return rows([{ n: world.optins.size }]);
      if (/max\(recorded_at\)/.test(sql)) return rows([{ at: '2026-09-01T06:30:00.000Z' }]);
      if (/^\s*SELECT \* FROM approval_links/.test(sql)) {
        return rows(
          world.links.filter(
            (l) => l.account_id === params[0] && l.ref_id === params[1] && !l.used_at,
          ),
        );
      }
      if (/INSERT INTO approval_links/.test(sql)) {
        world.links.push({
          id: LINK_ID,
          account_id: params[0],
          action: params[1],
          ref_id: params[2],
          amount: params[3],
          ccy: params[4],
          counterparty_account: params[5],
          used_at: null,
          token_hash: 'pending',
        });
        return rows([{ id: LINK_ID }]);
      }
      world.writes.push({ sql, params });
      if (/INSERT INTO consent_tokens/.test(sql)) {
        world.optins.add(params[1]);
        return rows([]);
      }
      if (/UPDATE matches SET stage = 3/.test(sql)) {
        world.stage = 3;
        return rows([]);
      }
      if (/UPDATE accounts SET first_name_enc/.test(sql)) {
        world.accounts[params[0]] = {
          first_name: params[1].toString('utf8').replace(/^enc:/, ''),
          locality: params[2].toString('utf8').replace(/^enc:/, ''),
        };
        return rows([]);
      }
      return rows([]);
    },
  } as any;
}

beforeEach(async () => {
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
  world = {
    accounts: {
      [ANA]: { first_name: '', locality: '' },
      [BEPPE]: { first_name: '', locality: '' },
    },
    stage: 3,
    optins: new Set([ANA, BEPPE]),
    links: [],
    writes: [],
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.mocked(writeConsentEvent).mockClear();
  vi.mocked(encryptField).mockClear();
});

// ---------------------------------------------------------------------------
describe('validateSharedProfile', () => {
  it('accepts a first name and a suburb, trimming both', () => {
    const r = profile.validateSharedProfile({ firstName: '  Ana ', locality: ' Fremantle ' });
    expect(r).toEqual({ ok: true, value: { firstName: 'Ana', locality: 'Fremantle' } });
  });

  it('accepts the shapes real places come in', () => {
    for (const locality of [
      'Newtown, NSW',
      "Coeur d'Alene",
      'St. Kilda',
      'Fremantle 6160',
      'Reggio nell’Emilia',
      'AU-ACT',
    ]) {
      expect(
        profile.validateSharedProfile({ firstName: 'Ana', locality }),
        locality,
      ).toMatchObject({ ok: true });
    }
  });

  it('asks for a first name when the box is empty', () => {
    expect(profile.validateSharedProfile({ firstName: '  ', locality: 'Fremantle' })).toMatchObject(
      { ok: false },
    );
  });

  it('holds the length bounds: 1-40 name, 2-60 locality', () => {
    expect(profile.FIRST_NAME_MAX).toBe(40);
    expect(profile.LOCALITY_MIN).toBe(2);
    expect(profile.LOCALITY_MAX).toBe(60);
    expect(
      profile.validateSharedProfile({ firstName: 'A'.repeat(41), locality: 'Fremantle' }),
    ).toMatchObject({ ok: false });
    expect(profile.validateSharedProfile({ firstName: 'Ana', locality: 'F' })).toMatchObject({
      ok: false,
    });
    expect(
      profile.validateSharedProfile({ firstName: 'Ana', locality: 'F'.repeat(61) }),
    ).toMatchObject({ ok: false });
    // The bounds themselves are inside.
    expect(
      profile.validateSharedProfile({ firstName: 'A'.repeat(40), locality: 'F'.repeat(60) }),
    ).toMatchObject({ ok: true });
  });

  it('turns away anything shaped like a way to reach someone', () => {
    for (const bad of [
      { firstName: 'ana@example.com', locality: 'Fremantle' },
      { firstName: 'Ana', locality: 'ana@example.com' },
      { firstName: 'Ana', locality: 'https://example.com/ana' },
      { firstName: 'Ana', locality: 'www.example.com' },
      { firstName: 'Ana', locality: 'find me at example.com' },
      { firstName: 'Ana', locality: '+61 400 000 000' },
      { firstName: '0412345678', locality: 'Fremantle' },
      { firstName: 'Ana', locality: 'call 0412 345 678' },
    ]) {
      expect(profile.validateSharedProfile(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  it('never says a field is fine without saying what it is', () => {
    const r = profile.validateSharedProfile({ firstName: 'Ana', locality: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(lintEmailCopy(r.error)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('opt_in on an empty profile', () => {
  it('is refused with CONSENT_REQUIRED and the human sentence + link', async () => {
    world.optins = new Set();
    world.stage = 2;
    const err = await matches
      .recordStage3OptIn(cfg, MATCH, ANA, 'agent-attested')
      .catch((e) => e);
    expect(err).toBeInstanceOf(OsbError);
    expect(err.payload.code).toBe('CONSENT_REQUIRED');
    expect(err.payload.human_action).toContain(profile.SHARED_PROFILE_ACTION);
    expect(err.payload.human_action).toContain('https://my.test/a/');
    // The error itself is a conformant protocol error.
    expect(validatePayload('error', err.payload).valid).toBe(true);
    expect(err.payload.human_action.length).toBeLessThanOrEqual(300);
  });

  it('records NOTHING: no WORM consent event, no consent token, no stage bump', async () => {
    world.optins = new Set();
    world.stage = 2;
    await matches.recordStage3OptIn(cfg, MATCH, ANA, 'agent-attested').catch(() => {});
    expect(vi.mocked(writeConsentEvent)).not.toHaveBeenCalled();
    expect(world.writes.filter((w) => /INSERT INTO consent_tokens/.test(w.sql))).toEqual([]);
    expect(world.optins.size).toBe(0);
    expect(world.stage).toBe(2);
  });

  it('mints the link against this human and this match, and re-uses it on a retry', async () => {
    world.optins = new Set();
    world.stage = 2;
    const first = await matches.recordStage3OptIn(cfg, MATCH, ANA, 'agent-attested').catch((e) => e);
    expect(world.links).toHaveLength(1);
    expect(world.links[0]).toMatchObject({
      account_id: ANA,
      action: 'stage3-disclosure',
      ref_id: MATCH,
      counterparty_account: BEPPE,
    });
    const second = await matches.recordStage3OptIn(cfg, MATCH, ANA, 'agent-attested').catch((e) => e);
    expect(world.links).toHaveLength(1); // a retry does not stack link rows
    expect(second.payload.human_action).toBe(first.payload.human_action);
  });

  it('lets the opt-in through once the profile is filled', async () => {
    world.optins = new Set();
    world.stage = 2;
    world.accounts[ANA] = { first_name: 'Ana', locality: 'Fremantle' };
    const r = await matches.recordStage3OptIn(cfg, MATCH, ANA, 'agent-attested');
    expect(r.both).toBe(false);
    expect(world.optins.has(ANA)).toBe(true);
    expect(vi.mocked(writeConsentEvent).mock.calls[0][0]).toMatchObject({
      event: 'stage3-optin',
      match_id: MATCH,
      account_id: ANA,
    });
  });
});

// ---------------------------------------------------------------------------
describe('stage-3 fetch with both opt-ins recorded but a profile still empty', () => {
  it('answers CONSENT_REQUIRED for the caller when it is the CALLER who is empty', async () => {
    world.accounts[BEPPE] = { first_name: 'Beppe', locality: 'Trastevere' };
    const err = await matches.getStagePayload(cfg, ANA, MATCH, 3).catch((e) => e);
    expect(err).toBeInstanceOf(OsbError);
    expect(err.payload.code).toBe('CONSENT_REQUIRED');
    expect(err.payload.human_action).toContain(profile.SHARED_PROFILE_ACTION);
    expect(err.payload.human_action).toContain('https://my.test/a/');
  });

  it('answers CONSENT_REQUIRED naming the other side when the CALLER is done', async () => {
    world.accounts[ANA] = { first_name: 'Ana', locality: 'Fremantle' };
    const err = await matches.getStagePayload(cfg, ANA, MATCH, 3).catch((e) => e);
    expect(err).toBeInstanceOf(OsbError);
    expect(err.payload.code).toBe('CONSENT_REQUIRED');
    expect(err.payload.human_action).toBe(profile.COUNTERPARTY_PROFILE_ACTION);
    // No link is minted for somebody else's account, ever.
    expect(world.links).toEqual([]);
  });

  it('never reaches the outbound validator, so no malformed-payload failure escapes', async () => {
    const err = await matches.getStagePayload(cfg, ANA, MATCH, 3).catch((e) => e);
    expect(err).toBeInstanceOf(OsbError);
    expect(String(err.message)).not.toContain('outbound payload failed');
  });

  it('leaves the recorded opt-ins and the stage alone', async () => {
    await matches.getStagePayload(cfg, ANA, MATCH, 3).catch(() => {});
    expect([...world.optins].sort()).toEqual([ANA, BEPPE].sort());
    expect(world.stage).toBe(3);
  });

  it('flags the blockage on the check_matches sweep instead of dropping it silently', async () => {
    const list = await matches.checkMatches(cfg, ANA);
    expect(list[0].mutual).toBeUndefined();
    expect(list[0].mutual_blocked.code).toBe('CONSENT_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
describe('stage-3 fetch once both profiles are filled', () => {
  beforeEach(() => {
    world.accounts[ANA] = { first_name: 'Ana', locality: 'Fremantle' };
    world.accounts[BEPPE] = { first_name: 'Beppe', locality: 'Trastevere' };
  });

  it('returns a valid match.mutual to each side', async () => {
    const toAna: any = await matches.getStagePayload(cfg, ANA, MATCH, 3);
    expect(toAna.kind).toBe('match.mutual');
    expect(toAna.counterparty).toEqual({ first_name: 'Beppe', locality: 'Trastevere' });
    expect(toAna.optin.both_recorded).toBe(true);
    expect(validatePayload('match.mutual', toAna).valid).toBe(true);

    const toBeppe: any = await matches.getStagePayload(cfg, BEPPE, MATCH, 3);
    expect(toBeppe.counterparty).toEqual({ first_name: 'Ana', locality: 'Fremantle' });
    expect(validatePayload('match.mutual', toBeppe).valid).toBe(true);
  });

  it('carries the mutual payload on the check_matches sweep', async () => {
    const list = await matches.checkMatches(cfg, ANA);
    expect(list[0].mutual.counterparty.first_name).toBe('Beppe');
    expect(list[0].mutual_blocked).toBeUndefined();
  });

  it('end to end: empty -> the human fills the page -> the reveal completes', async () => {
    world.accounts[ANA] = { first_name: '', locality: '' };
    world.accounts[BEPPE] = { first_name: '', locality: '' };
    world.optins = new Set();
    world.stage = 2;

    // Neither agent can opt in.
    for (const who of [ANA, BEPPE]) {
      const e = await matches.recordStage3OptIn(cfg, MATCH, who, 'agent-attested').catch((x) => x);
      expect(e.payload.code).toBe('CONSENT_REQUIRED');
    }

    // Each human fills their own page.
    await profile.saveSharedProfile(ANA, { firstName: 'Ana', locality: 'Fremantle' }, 'counter');
    await profile.saveSharedProfile(BEPPE, { firstName: 'Beppe', locality: 'Trastevere' }, 'counter');

    // Now both opt-ins record, and the reveal is a conformant payload.
    expect((await matches.recordStage3OptIn(cfg, MATCH, ANA, 'agent-attested')).both).toBe(false);
    expect((await matches.recordStage3OptIn(cfg, MATCH, BEPPE, 'agent-attested')).both).toBe(true);
    const mutual: any = await matches.getStagePayload(cfg, ANA, MATCH, 3);
    expect(validatePayload('match.mutual', mutual).valid).toBe(true);
    expect(mutual.counterparty.first_name).toBe('Beppe');
  });
});

// ---------------------------------------------------------------------------
describe('saveSharedProfile', () => {
  it('encrypts both fields under the account key and writes the WORM event first', async () => {
    await profile.saveSharedProfile(ANA, { firstName: 'Ana', locality: 'Fremantle' }, 'counter');
    expect(vi.mocked(encryptField).mock.calls.map((c) => [c[0], c[2]])).toEqual([
      [ANA, 'Ana'],
      [ANA, 'Fremantle'],
    ]);
    const event: any = vi.mocked(writeConsentEvent).mock.calls[0][0];
    expect(event).toMatchObject({
      event: 'shared-profile-set',
      account_id: ANA,
      recorded_via: 'counter',
    });
    // The consent log records THAT the human set them, never the values.
    expect(JSON.stringify(event)).not.toContain('Fremantle');
    expect(JSON.stringify(event)).not.toContain('Ana');
  });

  it('stores what a later read gives back', async () => {
    await profile.saveSharedProfile(ANA, { firstName: 'Ana', locality: 'Fremantle' }, 'counter');
    const read = await profile.readSharedProfile(ANA, { purpose: 'test', actor: ANA });
    expect(read).toEqual({ firstName: 'Ana', locality: 'Fremantle' });
    expect(profile.profileIsFilled(read)).toBe(true);
  });

  it('an untouched account reads back empty and unfilled', async () => {
    const read = await profile.readSharedProfile(BEPPE, { purpose: 'test', actor: BEPPE });
    expect(read).toEqual({ firstName: '', locality: '' });
    expect(profile.profileIsFilled(read)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the pages that collect it', () => {
  const approvalWithCollection = cpages.approvalPage({
    action: 'stage3-disclosure',
    refId: MATCH,
    facts: [
      { k: 'What gets shared', v: 'first name + locality' },
      { k: 'For', v: 'Language exchange' },
      { k: 'Shared with', v: 'your matched counterparty' },
    ],
    anomalies: [],
    collectProfile: { firstName: '', locality: '' },
    hasPasskey: false,
    elevated: false,
    postPath: '/approve',
  });

  it('asks for both fields on the approval page, in the same form as the decision', () => {
    expect(approvalWithCollection).toContain('What should we share?');
    expect(approvalWithCollection).toContain('name="first_name"');
    expect(approvalWithCollection).toContain('name="locality"');
    expect(approvalWithCollection).toContain('Suburb or area');
    // One form: the boxes travel with the approve decision.
    expect(approvalWithCollection.split('<form').length - 1).toBe(1);
    expect(approvalWithCollection).toContain('name="decision" value="approve"');
  });

  it('holds the same length caps the server enforces', () => {
    expect(approvalWithCollection).toContain('maxlength="40"');
    expect(approvalWithCollection).toContain('maxlength="60"');
  });

  it('lets a decline through without filling anything in', () => {
    expect(approvalWithCollection).toMatch(/value="decline"[^>]*formnovalidate|formnovalidate[^>]*value="decline"/);
  });

  it('asks for nothing extra once the profile is on file', () => {
    const plain = cpages.approvalPage({
      action: 'stage3-disclosure',
      refId: MATCH,
      facts: [{ k: 'What gets shared', v: 'first name + locality' }],
      anomalies: [],
      hasPasskey: false,
      elevated: false,
      postPath: '/approve',
    });
    expect(plain).not.toContain('name="first_name"');
    expect(plain).not.toContain('What should we share?');
  });

  it('the profile page shows what is on file and says when nothing is', () => {
    const empty = chome.sharedProfilePage({ firstName: '', locality: '' });
    expect(empty).toContain('What you share on a match');
    expect(empty).toContain('Nothing is filled in yet');
    const filled = chome.sharedProfilePage({ firstName: 'Ana', locality: 'Fremantle' });
    expect(filled).toContain('value="Ana"');
    expect(filled).toContain('value="Fremantle"');
    expect(filled).not.toContain('Nothing is filled in yet');
  });

  it('escapes what the human typed back into the boxes', () => {
    const nasty = chome.sharedProfilePage({ firstName: '"><script>x()</script>', locality: 'A' });
    expect(nasty).not.toContain('<script>x()');
    expect(nasty).toContain('&lt;script&gt;');
  });

  it('the dashboard links to it and says when it is empty', () => {
    const base = {
      killSwitchOn: false,
      cardCounts: { total: 0, published: 0, pending: 0 },
      pendingApprovals: [],
      matches: [],
      collectionWindows: [],
    };
    const empty = chome.dashboardPage(base);
    expect(empty).toContain('/profile');
    expect(empty).toContain('Yours are empty');
    const filled = chome.dashboardPage({ ...base, sharedProfile: 'Ana, Fremantle' });
    expect(filled).toContain('Ana, Fremantle');
    expect(filled).not.toContain('Yours are empty');
  });

  it('the consent page says, in one line, when details ever cross', () => {
    const consent = cpages.consentPage();
    expect(consent).toMatch(/first name and a rough area/);
  });

  it('every new page passes the banned-phrase lint and never says "the counter"', () => {
    for (const [name, htmlBody] of [
      ['approval-collect', approvalWithCollection],
      ['profile-empty', chome.sharedProfilePage({ firstName: '', locality: '' })],
      ['profile-filled', chome.sharedProfilePage({ firstName: 'Ana', locality: 'Fremantle' }, { notice: 'Saved.' })],
      ['profile-error', chome.sharedProfilePage({ firstName: '', locality: '' }, { error: 'Add the suburb or area you are in.' })],
      ['consent', cpages.consentPage()],
    ] as const) {
      expect(lintEmailCopy(htmlBody), name).toEqual([]);
      expect(htmlBody.toLowerCase(), name).not.toContain('the counter');
      expect(htmlBody.toLowerCase(), name).not.toContain('your counter');
    }
  });
});
