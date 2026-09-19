/**
 * The human's own facts, in the manual served at connect.
 *
 * The defect this suite exists to hold shut: a human said he had a mountain
 * bike to sell and his assistant asked which suburb — twice, on two postings,
 * with the area already on file and already riding every sweep. The logs of
 * the second run show why the sweep could not help: the account made no read
 * call at all before the question. An assistant turns to its human first and
 * to the switchboard second, so the only place a fact can sit early enough is
 * the manual, which every agent reads at connect.
 *
 * The rules asserted here:
 *  - the block is served, under the manual, for an account with an area and a
 *    zone, and says what to do with each;
 *  - each half is absent on its own when that fact is not on file, and the
 *    whole block is absent when neither is — never a line saying "unknown";
 *  - a read that fails, or one that hangs, costs the connect nothing: the
 *    manual is served whole and the block is simply missing;
 *  - an ordinary tool call reads no identity at all — only the handshake does,
 *    and its audit line says so;
 *  - the copy passes the human-copy lint and the banned-noun list;
 *  - the settlement-off block still works, and both blocks sit together;
 *  - nothing here can reach a counterparty.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  OWN_AREA_CONNECT_PURPOSE,
  OWN_HUMAN_HEADING,
  ownHumanBlockText,
} from '../../src/mcp/connectFacts.js';
import { areaNote } from '../../src/domain/profile.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.js';
import type { Config } from '../../src/config.js';

const SETTLING = { stripeSecretArn: 'arn:stripe', evidenceBucket: 'b' } as unknown as Config;
const NO_SETTLEMENT = {} as unknown as Config;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const NOW = new Date('2026-09-13T00:14:00Z');

const FRANKLIN = {
  area: 'Franklin, ACT',
  area_resolved: 'Franklin, Australian Capital Territory, Australia',
  note: { text: areaNote('Franklin, Australian Capital Territory, Australia'), provenance: 'switchboard-system' as const },
};

/** The block as the domain would compose it, with both facts known. */
function bothKnown(): string {
  return ownHumanBlockText({ area: FRANKLIN, timezone: 'Australia/Sydney' }, NOW);
}

// The same banned nouns manual.test.ts holds the manual to: every word the
// switchboard puts in front of a model, including the words it puts there
// outside the versioned text.
const BANNED = [
  { label: 'card', re: /\b(index\s+)?cards?\b/i },
  { label: 'channel', re: /\bchannels?\b/i },
  { label: 'match', re: /\bmatch(es)?\b/i },
  { label: 'stage', re: /\bstages?\b/i },
  { label: 'WANT', re: /\bWANT\b/ },
  { label: 'HAVE', re: /\bHAVE\b/ },
  { label: 'connection', re: /\bconnections?\b/i },
  { label: 'score', re: /\bscores?\b/i },
];

describe('the block of what the switchboard already knows about this human', () => {
  it('says the area, as they typed it and written out, and what to do with it', () => {
    const block = bothKnown();
    expect(block).toContain(OWN_HUMAN_HEADING);
    expect(block).toContain('Your human is in Franklin, Australian Capital Territory, Australia');
    expect(block).toMatch(/use that as the area on anything you post for them/i);
    expect(block).toMatch(/tell them which area you used/i);
    // What they typed is kept, so the agent can say it back in their words.
    expect(block).toContain('which they wrote as "Franklin, ACT"');
  });

  it('says the clock, in their zone, and what to do with it', () => {
    const block = bothKnown();
    expect(block).toMatch(/Your human's clock reads .* \(Australia\/Sydney\)/);
    expect(block).toMatch(/say times to them in their own zone/i);
    // The local time is written out, so no sum is needed to know it.
    expect(block).toContain('10:14');
  });

  it('leaves out the half that is not on file, and never says "unknown"', () => {
    const areaOnly = ownHumanBlockText({ area: FRANKLIN }, NOW);
    expect(areaOnly).toContain('Your human is in Franklin');
    expect(areaOnly).not.toMatch(/clock reads/i);

    const clockOnly = ownHumanBlockText({ timezone: 'Australia/Sydney' }, NOW);
    expect(clockOnly).toMatch(/clock reads/i);
    expect(clockOnly).not.toMatch(/Use that as the area/i);

    for (const block of [areaOnly, clockOnly, bothKnown()]) {
      expect(block).not.toMatch(/unknown|not set|no area|we don't know/i);
    }
  });

  it('is absent entirely when nothing is known', () => {
    expect(ownHumanBlockText({}, NOW)).toBe('');
    expect(ownHumanBlockText({ area: undefined, timezone: null }, NOW)).toBe('');
  });

  it('says an unresolved area exactly as the human typed it, once', () => {
    const typed = {
      area: 'up the back of Bungendore',
      note: { text: areaNote('up the back of Bungendore'), provenance: 'switchboard-system' as const },
    };
    const block = ownHumanBlockText({ area: typed }, NOW);
    expect(block).toContain('Your human is in up the back of Bungendore.');
    expect(block).not.toMatch(/which they wrote as/);
  });

  it('passes the human-copy lint and the banned nouns', () => {
    const block = bothKnown();
    expect(lintHumanCopy(block)).toEqual([]);
    for (const { label, re } of BANNED) {
      expect(re.test(block), `${label} in the connect block`).toBe(false);
    }
  });
});

describe('reading those facts at connect', () => {
  async function withMocks(
    impl: { readOwnArea?: any; getTimezone?: any },
    run: (mod: typeof import('../../src/mcp/connectFacts.js'), spies: any) => Promise<void>,
  ) {
    vi.resetModules();
    const readOwnArea = vi.fn(impl.readOwnArea ?? (async () => FRANKLIN));
    const getTimezone = vi.fn(impl.getTimezone ?? (async () => 'Australia/Sydney'));
    vi.doMock('../../src/domain/profile.js', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      readOwnArea,
    }));
    vi.doMock('../../src/domain/accounts.js', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      getTimezone,
    }));
    try {
      await run(await import('../../src/mcp/connectFacts.js'), { readOwnArea, getTimezone });
    } finally {
      vi.doUnmock('../../src/domain/profile.js');
      vi.doUnmock('../../src/domain/accounts.js');
      vi.resetModules();
    }
  }

  it('reads the area under a purpose that names the connect manual', async () => {
    await withMocks({}, async (mod, spies) => {
      const block = await mod.ownHumanBlock(ACCOUNT, { now: NOW });
      expect(block).toContain('Your human is in Franklin');
      // And with the country behind their clock, so a shared name — Franklin,
      // of all names — is read back to them with their own country's places
      // first (src/geo/homeCountry.ts).
      expect(spies.readOwnArea).toHaveBeenCalledWith(ACCOUNT, OWN_AREA_CONNECT_PURPOSE, {
        country: 'AU',
      });
      expect(OWN_AREA_CONNECT_PURPOSE).toMatch(/connect/);
    });
  });

  it('says nothing at all when the read throws', async () => {
    await withMocks(
      {
        readOwnArea: async () => {
          throw new Error('kms is having a day');
        },
      },
      async (mod) => {
        const onError = vi.fn();
        expect(await mod.ownHumanBlock(ACCOUNT, { now: NOW, onError })).toBe('');
        expect(onError).toHaveBeenCalledOnce();
      },
    );
  });

  it('gives up on a slow read rather than holding the handshake open', async () => {
    await withMocks(
      { readOwnArea: () => new Promise(() => {}) },
      async (mod) => {
        const onError = vi.fn();
        const started = Date.now();
        expect(await mod.ownHumanBlock(ACCOUNT, { now: NOW, timeoutMs: 20, onError })).toBe('');
        expect(Date.now() - started).toBeLessThan(2000);
        expect(onError).toHaveBeenCalledOnce();
        expect(String(onError.mock.calls[0]![0])).toMatch(/timed out/i);
      },
    );
  });

  it('has a default timeout short enough that a connect is never held up', async () => {
    const mod = await import('../../src/mcp/connectFacts.js');
    expect(mod.OWN_HUMAN_READ_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});

describe('the manual served at connect', () => {
  async function instructions(cfg: Config, opts: any = {}) {
    const { instructionsFor } = await import('../../src/mcp/mcp.js');
    return instructionsFor(cfg, opts);
  }

  it('serves the connect page first, with the human\'s own facts under it', async () => {
    vi.resetModules();
    vi.doMock('../../src/mcp/connectFacts.js', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      ownHumanBlock: vi.fn(async () => 'YOUR HUMAN, TODAY\nstand-in'),
    }));
    try {
      const text = await instructions(SETTLING, { accountId: ACCOUNT });
      // The core goes first now. It used to go last, because the manual it
      // followed ran to fifty thousand characters and these blocks sat at 99%
      // of a text most clients had already cut off (2026-09-13). The core is
      // a thousand characters, so what never bends reads first and this
      // human's own facts read straight after it.
      expect(text.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
      expect(text).toContain('YOUR HUMAN, TODAY\nstand-in');
      expect(text.endsWith('YOUR HUMAN, TODAY\nstand-in')).toBe(true);
    } finally {
      vi.doUnmock('../../src/mcp/connectFacts.js');
      vi.resetModules();
    }
  });

  it('still serves the manual when the facts cannot be read', async () => {
    vi.resetModules();
    vi.doMock('../../src/mcp/connectFacts.js', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      ownHumanBlock: vi.fn(async () => ''),
    }));
    try {
      expect(await instructions(SETTLING, { accountId: ACCOUNT })).toBe(SERVER_INSTRUCTIONS);
    } finally {
      vi.doUnmock('../../src/mcp/connectFacts.js');
      vi.resetModules();
    }
  });

  it('reads nothing for a call that is not the handshake', async () => {
    vi.resetModules();
    const ownHumanBlock = vi.fn(async () => 'should never be asked for');
    vi.doMock('../../src/mcp/connectFacts.js', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      ownHumanBlock,
    }));
    try {
      expect(await instructions(SETTLING)).toBe(SERVER_INSTRUCTIONS);
      expect(ownHumanBlock).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../src/mcp/connectFacts.js');
      vi.resetModules();
    }
  });

  it('keeps the settlement-off block, and seats both blocks together', async () => {
    vi.resetModules();
    vi.doMock('../../src/mcp/connectFacts.js', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      ownHumanBlock: vi.fn(async () => 'YOUR HUMAN, TODAY\nstand-in'),
    }));
    try {
      const off = await instructions(NO_SETTLEMENT);
      expect(off).toContain('THIS DEPLOYMENT, TODAY');
      expect(off).toContain('settle answers SETTLEMENT_UNAVAILABLE');
      expect(off).not.toContain('YOUR HUMAN, TODAY');

      // Both ride under the core, the human's own facts first: they are the
      // ones an agent acts on in its first exchange.
      expect(off.indexOf('THIS DEPLOYMENT, TODAY')).toBeGreaterThan(0);

      const both = await instructions(NO_SETTLEMENT, { accountId: ACCOUNT });
      expect(both.indexOf(SERVER_INSTRUCTIONS)).toBe(0);
      expect(both.indexOf('YOUR HUMAN, TODAY')).toBeGreaterThan(0);
      expect(both.indexOf('THIS DEPLOYMENT, TODAY')).toBeGreaterThan(
        both.indexOf('YOUR HUMAN, TODAY'),
      );
    } finally {
      vi.doUnmock('../../src/mcp/connectFacts.js');
      vi.resetModules();
    }
  });
});

describe('none of it can reach the other side', () => {
  const src = join(process.cwd(), 'src');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  })(src);

  it('is composed in one place and handed to one caller: the connect manual', () => {
    const importers = files.filter((f) => /from '.*connectFacts\.js'/.test(readFileSync(f, 'utf8')));
    expect(importers.map((f) => f.replace(src, 'src'))).toEqual(['src/mcp/mcp.ts']);

    const mcp = readFileSync(join(src, 'mcp', 'mcp.ts'), 'utf8');
    // The only use of the composed text is the MCP `instructions` field of the
    // server built for this account's own bearer token.
    expect(mcp).toMatch(/instructions: await instructionsFor\(/);
    const uses = mcp.match(/instructionsFor\(/g) ?? [];
    expect(uses.length).toBe(2); // the definition and that one use
  });

  it('carries the area no further than the account that typed it', () => {
    // The block is pure text built from one account's own row, and the only
    // account it is built for is the one on the bearer token (buildMcpServer
    // passes auth.accountId and nothing else).
    const mcp = readFileSync(join(src, 'mcp', 'mcp.ts'), 'utf8');
    expect(mcp).toMatch(/accountId: auth\.accountId/);
    expect(mcp).not.toMatch(/counterparty/i);

    // And the disclosure paths never ask for it: readOwnArea is for a human's
    // own agent, so it appears only on the two own-agent surfaces.
    const readers = files
      .filter((f) => /\breadOwnArea\b/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(src, 'src'))
      .sort();
    expect(readers).toEqual(['src/domain/profile.ts', 'src/mcp/connectFacts.ts', 'src/mcp/tools.ts']);
  });
});
