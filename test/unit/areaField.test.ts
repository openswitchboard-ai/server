/**
 * The area box, and the suggestions under it.
 *
 * The decision (Lachlan, 13 September 2026): the box a person types their area
 * into offers real places to choose from, and they come from the switchboard's
 * own offline gazetteer rather than a third party — the same asset that places
 * every posting, so the area a person shares and the area their postings match
 * on can no longer disagree.
 *
 * What this suite holds shut:
 *  - the list is drawn from settlements, capped, and silent on a short query;
 *  - every suggestion resolves back to the place it came from, so picking one
 *    stores something the posting path agrees with;
 *  - the endpoint needs the human's own session and is rate-limited;
 *  - a person who types something the gazetteer has never heard of still
 *    saves, exactly as before;
 *  - with the script switched off the box is still a box: plain text, typed,
 *    posted to the page that saves it.
 */
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import {
  AREA_HELP,
  AREA_LABEL,
  AREA_PLACEHOLDER,
  sharedFieldsFieldset,
} from '../../src/counter/pages.js';
import { AREA_QUERY_MIN, AREA_SUGGEST_MAX, suggestAreas } from '../../src/geo/suggest.js';
import { resolvePlace, describePlace } from '../../src/geo/gazetteer.js';
import { LOCALITY_MAX, validateSharedProfile } from '../../src/domain/profile.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import * as db from '../../src/db.js';
import type { Config } from '../../src/config.js';
import type { FastifyInstance } from 'fastify';

const cfg = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'https://mcp.test',
  counterOrigin: 'https://my.test',
  legacyCounterHosts: ['counter.test'],
  sesFrom: 'OpenSwitchboard <board@openswitchboard.ai>',
  sesReplyTo: 'info@openswitchboard.ai',
  sesConfigurationSet: 'unused',
  emailEventsQueueUrl: 'http://unused',
  dbSecretArn: 'unused',
  screeningQueueUrl: 'http://unused',
  matchingQueueUrl: 'http://unused',
  opsQueueUrl: 'http://unused',
  consentLogBucket: 'unused',
  identityKeyArn: 'unused',
  bedrockModelId: 'unused',
  registrationMode: 'dev-bootstrap',
  region: 'us-east-1',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
  settlementFeePercent: 0,
  settlementFeeFlatMinor: 100,
} as unknown as Config;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SIGNED_IN = 'osb_counter=osb_cs_a-signed-in-session';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp(cfg);
  await app.ready();
  vi.spyOn(db, 'getPool').mockReturnValue({
    query: async (sql: string) => {
      if (/FROM counter_sessions/.test(sql)) {
        return {
          rows: [{ id: 'sess-1', account_id: ACCOUNT, pin_ok_until: null, oauth_ctx: null }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any);
});

const ask = (q: string, opts: { signedIn?: boolean } = {}) =>
  app.inject({
    method: 'GET',
    url: `/areas?q=${encodeURIComponent(q)}`,
    headers: { host: 'my.test', ...(opts.signedIn === false ? {} : { cookie: SIGNED_IN }) },
  });

// ---------------------------------------------------------------------------
describe('the suggestions themselves', () => {
  it('offers the suburb behind a few letters', () => {
    const braddon = suggestAreas('bradd').map((s) => s.value);
    expect(braddon).toContain('Braddon, Australian Capital Territory');
    const fre = suggestAreas('fremant');
    expect(fre[0].value).toBe('Fremantle, Western Australia');
    expect(fre[0].country).toBe('Australia');
  });

  it('suggests across countries, not one corner of one of them', () => {
    for (const [typed, expected] of [
      ['gungah', 'Gungahlin, Australian Capital Territory'],
      ['queanbey', 'Queanbeyan, New South Wales'],
      ['surry h', 'Surry Hills, New South Wales'],
      ['shibu', 'Shibuya, Tokyo'],
      ['kreuzb', 'Kreuzberg, State of Berlin'],
      ['ikej', 'Ikeja, Lagos'],
      ['kitsil', 'Kitsilano, British Columbia'],
    ] as [string, string][]) {
      expect(
        suggestAreas(typed).map((s) => s.value),
        typed,
      ).toContain(expected);
    }
  });

  it('caps the list, however common the name', () => {
    for (const q of ['san', 'new', 'sain', 'bra', 'lon']) {
      expect(suggestAreas(q).length, q).toBeLessThanOrEqual(AREA_SUGGEST_MAX);
    }
    expect(suggestAreas('san', 50).length).toBeLessThanOrEqual(AREA_SUGGEST_MAX);
    expect(suggestAreas('san', 3).length).toBe(3);
  });

  it('says nothing at all to a query too short to mean anything', () => {
    expect(AREA_QUERY_MIN).toBe(3);
    for (const q of ['', ' ', 'b', 'br', '  a ']) expect(suggestAreas(q), q).toEqual([]);
    expect(suggestAreas('bra').length).toBeGreaterThan(0);
  });

  it('every suggestion resolves back to the place it came from, and fits the box', () => {
    for (const q of ['bradd', 'frank', 'newt', 'san', 'kreuz', 'surry', 'lond', 'par']) {
      for (const s of suggestAreas(q)) {
        const back = resolvePlace(s.value);
        expect(back, `${q}: ${s.value}`).toBeDefined();
        expect(back!.kind, s.value).toBe('city');
        expect(s.value.length, s.value).toBeLessThanOrEqual(LOCALITY_MAX);
      }
    }
  });

  it('finds a place whose own name in the data is a transliteration', () => {
    // The asset writes some names the way nobody types them: "Zuerich",
    // "Duesseldorf", "OErebro". An alternate spelling is offered when it is
    // plainly the same name spelled another way.
    for (const [typed, expected] of [
      ['zuri', 'Zuerich'],
      ['dusseld', 'Duesseldorf'],
      ['orebro', 'OErebro'],
      ['cracow', 'Krakow'],
    ] as [string, string][]) {
      expect(
        suggestAreas(typed).map((s) => s.value.split(',')[0]),
        typed,
      ).toContain(expected);
    }
  });

  it('never offers a place that merely carries the name as a label', () => {
    // The Franklin defect, in the list this time: Columbus, Ohio answers to
    // "Franklin" in the source data and would have sat at the top of it.
    const franklin = suggestAreas('frankl').map((s) => s.value);
    expect(franklin.length).toBeGreaterThan(0);
    for (const v of franklin) expect(v.toLowerCase(), v).toContain('frankl');
    // And a short label — the airport codes the dump hangs off cities — is
    // never a way in: "ACT" finds places called Acton, never Waco.
    for (const v of suggestAreas('act').map((s) => s.value)) {
      expect(v.toLowerCase(), v).toContain('act');
    }
  });

  it('offers only places people live in — never a state, a territory or a country', () => {
    for (const q of ['austral', 'new south', 'califor', 'texas', 'united st']) {
      for (const s of suggestAreas(q)) {
        expect(resolvePlace(s.value)!.kind, `${q}: ${s.value}`).toBe('city');
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('the endpoint behind the box', () => {
  it('needs the human to be signed in', async () => {
    const out = await ask('bradd', { signedIn: false });
    expect(out.statusCode).toBe(401);
    expect(out.json().error).toBe('not_signed_in');
  });

  it('answers a signed-in human with a capped list', async () => {
    const out = await ask('bradd');
    expect(out.statusCode).toBe(200);
    const places = out.json().places;
    expect(places.length).toBeGreaterThan(0);
    expect(places.length).toBeLessThanOrEqual(AREA_SUGGEST_MAX);
    expect(places.map((p: any) => p.value)).toContain('Braddon, Australian Capital Territory');
    const many = await ask('san');
    expect(many.json().places.length).toBeLessThanOrEqual(AREA_SUGGEST_MAX);
  });

  it('answers a too-short query with nothing rather than with the gazetteer', async () => {
    for (const q of ['b', 'br', '']) {
      const out = await ask(q);
      expect(out.statusCode, q).toBe(200);
      expect(out.json().places, q).toEqual([]);
    }
  });

  it('is rate-limited the way the rest of the counter is', async () => {
    let limited = false;
    for (let i = 0; i < 120 && !limited; i++) {
      const out = await ask('bradd');
      if (out.statusCode === 429) {
        limited = true;
        expect(out.json().error).toBe('slow_down');
      }
    }
    expect(limited, 'the suggestion endpoint refused nothing in 120 hits').toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the box itself', () => {
  const html = sharedFieldsFieldset({ firstName: 'Ana', locality: '' });

  it('is a plain text box with a list attached, so it works with the script off', () => {
    expect(html).toContain('<input id="locality" name="locality" type="text"');
    expect(html).toContain('list="area-options"');
    expect(html).toContain('<datalist id="area-options"></datalist>');
    // Nothing about the box depends on the script: it is typed into, and the
    // form it sits in posts it.
    expect(html).toContain('required');
    expect(html).toContain(`placeholder="${AREA_PLACEHOLDER}"`);
    expect(html).toContain(AREA_LABEL);
  });

  it('fills the list from this service and nowhere else', () => {
    expect(html).toContain("fetch('/areas?q='");
    expect(html).not.toMatch(/https?:\/\/(?!my\.test)/);
    for (const third of ['googleapis', 'google.com', 'maps.', 'mapbox', 'algolia', 'autocomplete?']) {
      expect(html.toLowerCase(), third).not.toContain(third);
    }
  });

  it('says what a person now does, in the register the rest of the page uses', () => {
    expect(lintHumanCopy(AREA_HELP)).toEqual([]);
    expect(AREA_HELP).toMatch(/pick/i);
    expect(AREA_HELP).toMatch(/ten minutes away or two hours/);
    expect(AREA_HELP).toMatch(/kept as you wrote it/);
  });
});

// ---------------------------------------------------------------------------
describe('what gets stored', () => {
  it('a typed area the gazetteer has never heard of still saves, untouched', () => {
    for (const typed of ['Nowhereville', 'behind the servo', 'Maboneng', 'ACT']) {
      const checked = validateSharedProfile({ firstName: 'Ana', locality: typed });
      expect(checked.ok, typed).toBe(true);
      expect((checked as any).value.locality, typed).toBe(typed);
    }
  });

  it('a picked suggestion stores the resolved place, and the posting path agrees', () => {
    const picked = suggestAreas('bradd').find((s) => s.value.startsWith('Braddon'))!;
    const checked = validateSharedProfile({ firstName: 'Ana', locality: picked.value });
    expect(checked.ok).toBe(true);
    // Stored exactly as offered — no rewriting on the way in.
    expect((checked as any).value.locality).toBe(picked.value);
    // And the same string a posting would carry, landing in the same place.
    const asShared = resolvePlace(picked.value)!;
    const asPosted = resolvePlace('Braddon, ACT')!;
    expect(asShared.lat).toBe(asPosted.lat);
    expect(asShared.lon).toBe(asPosted.lon);
    expect(describePlace(asShared)).toBe('Braddon, Australian Capital Territory, Australia');
  });
});
