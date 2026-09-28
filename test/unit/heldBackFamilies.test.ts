/**
 * FAMILIES HELD BACK BECAUSE OF THE LAW AROUND THEM (28 September 2026).
 *
 * The deny-list seed marks some families 'vertical-policy-pending'. They stay
 * closed, and the refusal the agent gets says why, in one plain general
 * sentence that comes from the data (denylist.ts, heldBackReason). The same
 * sentence is served whether the thing was caught by its path or by what it
 * is on another shelf (the model screen is told the list, also from the data).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bedrock } from '../../src/aws.js';
import {
  HELD_BACK_FALLBACK,
  categoryDenied,
  heldBackFamilies,
  heldBackReason,
  type DenyEntry,
} from '../../src/denylist.js';
import { screeningReasonInPlainWords } from '../../src/domain/screening.js';
import { assertCategoryOpen } from '../../src/domain/cards.js';
import { denyListPath } from '../../src/intake/checks/denyListPath.js';
import {
  HELD_BACK_REASONS,
  MODEL_SCREEN_SYSTEM_PROMPT,
  SCREEN_FLAG_KEYS,
  heldBackInstruction,
  modelScreen,
  prohibitedReason,
} from '../../src/intake/checks/modelScreen.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import { loadDenyListSeed } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const cfg = { bedrockModelId: 'anthropic.claude-3-5-haiku' } as unknown as Config;

afterEach(() => vi.restoreAllMocks());

describe('the held-back families come from the data', () => {
  it('lists every vertical-policy-pending entry in the seed, and nothing else', () => {
    const codes = heldBackFamilies().map((f) => f.reason_code);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      // Each one is a closed path in the seed with the pending status.
      expect(heldBackReason(code)).toBeTruthy();
    }
    expect(heldBackReason('weapons')).toBeUndefined();
    expect(heldBackReason('stolen-goods-markers')).toBeUndefined();
    expect(heldBackReason(undefined)).toBeUndefined();
  });

  it("serves the entry's own closed_reason where the data carries one", () => {
    const entries: DenyEntry[] = [
      {
        jurisdiction: '*',
        denied: ['goods.example.**'],
        reason_code: 'example-family',
        status: 'vertical-policy-pending',
        closed_reason: 'A sentence written in the data.',
      },
      { jurisdiction: '*', denied: ['goods.other'], reason_code: 'other', status: 'denied' },
    ];
    expect(heldBackReason('example-family', entries)).toBe('A sentence written in the data.');
    expect(heldBackReason('other', entries)).toBeUndefined();
    expect(heldBackFamilies(entries).map((f) => f.reason_code)).toEqual(['example-family']);
  });

  it('falls back to the one general sentence, keyed on the status alone', () => {
    const entries: DenyEntry[] = [
      { jurisdiction: '*', denied: ['goods.example'], reason_code: 'x', status: 'vertical-policy-pending' },
    ];
    expect(heldBackReason('x', entries)).toBe(HELD_BACK_FALLBACK);
  });

  it('the sentence is plain, general and clean', () => {
    for (const f of heldBackFamilies()) {
      expect(lintHumanCopy(f.reason), f.reason_code).toEqual([]);
      expect(f.reason, f.reason_code).not.toMatch(/\w\.\w/);
      // General: it never names the family it closes.
      expect(f.reason.toLowerCase(), f.reason_code).not.toContain(f.reason_code.split('-')[0]);
    }
    expect(lintHumanCopy(HELD_BACK_FALLBACK)).toEqual([]);
  });
});

describe('caught by its path', () => {
  /** A family's bare path, as its seed entry writes it. */
  const pathOf = (code: string): string =>
    (loadDenyListSeed().entries as DenyEntry[])
      .find((e) => e.reason_code === code)!
      .denied.find((g) => !g.includes('*'))!;

  it('the publish door refuses with the reason sentence', async () => {
    for (const f of heldBackFamilies()) {
      expect(categoryDenied(pathOf(f.reason_code))?.reason_code).toBe(f.reason_code);
      await expect(
        assertCategoryOpen(cfg, `${pathOf(f.reason_code)}.something`, 'acct'),
      ).rejects.toMatchObject({
        payload: { code: 'CATEGORY_PROHIBITED', human_action: f.reason },
      });
    }
  });

  it('the pipe check says the same sentence and never the dotted path', async () => {
    for (const f of heldBackFamilies()) {
      const path = pathOf(f.reason_code);
      const r = await denyListPath.run(
        { door: 'posting', sender_account: 'acct', fields: { category: path } } as any,
        cfg,
      );
      expect(r.outcome).toBe('refuse');
      expect(r.reason_code).toBe(f.reason_code);
      expect(r.plain_words).toBe(f.reason);
      expect(r.plain_words).not.toContain(path);
    }
  });

  it('a rejection stored under the code reads the same sentence', () => {
    for (const f of heldBackFamilies()) {
      expect(screeningReasonInPlainWords(f.reason_code)).toBe(f.reason);
    }
  });
});

describe('caught on another shelf', () => {
  it('the model screen is told every held-back family, from the data', () => {
    expect(HELD_BACK_REASONS).toEqual(heldBackFamilies().map((f) => f.reason_code));
    for (const code of HELD_BACK_REASONS) expect(MODEL_SCREEN_SYSTEM_PROMPT).toContain(code);
    expect(MODEL_SCREEN_SYSTEM_PROMPT).toContain(heldBackInstruction());
    expect(heldBackInstruction()).toMatch(/on any shelf and whatever it was filed under/);
    expect(heldBackInstruction([])).toBe('');
  });

  it("keeps a held-back family's code rather than falling back to 'prohibited'", () => {
    const flags = Object.fromEntries(SCREEN_FLAG_KEYS.map((k) => [k, false])) as any;
    for (const code of HELD_BACK_REASONS) {
      expect(prohibitedReason({ ...flags, prohibited: true, prohibited_reason: code, note: '' })).toBe(code);
    }
  });

  it('a held-back thing filed under an open shelf is refused with its family reason', async () => {
    const [first] = heldBackFamilies();
    const verdict = {
      ...Object.fromEntries(SCREEN_FLAG_KEYS.map((k) => [k, false])),
      prohibited: true,
      prohibited_reason: first.reason_code,
      note: 'held-back family',
    };
    vi.spyOn(bedrock, 'send').mockImplementation(async () => {
      return {
        body: new TextEncoder().encode(JSON.stringify({ content: [{ text: JSON.stringify(verdict) }] })),
      } as any;
    });
    const r = await modelScreen.run(
      {
        door: 'posting',
        sender_account: 'acct',
        text: 'kind: something',
        fields: { category: 'goods.bicycle.mountain' },
      } as any,
      cfg,
    );
    expect(r.outcome).toBe('refuse');
    expect(r.reason_code).toBe(first.reason_code);
    expect(screeningReasonInPlainWords(r.reason_code)).toBe(first.reason);
  });
});
