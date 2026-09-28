/**
 * Measure one representative check_in sweep, the way an agent receives it:
 * the text content of the answer (what most clients hand the model) and the
 * structured content, with the lean-sweep flag off and on.
 *
 *   npx vitest run scripts/measure-sweep.test.ts
 *
 * Not part of `npm test`: it prints numbers and asserts nothing about them.
 * The world is test/unit/sweepFixture.ts, eight introductions in the shapes a
 * real account collects over a couple of weeks.
 */
import { it, vi } from 'vitest';
import { cryptoMock, fakeSweepPool, fixtureCfg, representativeWorld, ANA } from '../unit/sweepFixture.js';

vi.mock('../../src/crypto.js', (orig) => cryptoMock(orig as any));

import * as db from '../../src/db.js';
import { dispatchTool } from '../../src/mcp/tools.js';

it('prints the size of a representative sweep, lean off and on', async () => {
  const out: Record<string, unknown> = {};
  for (const lean of [false, true]) {
    const world = representativeWorld();
    const unknown: string[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue(fakeSweepPool(world, unknown));
    vi.useFakeTimers({ now: world.now, toFake: ['Date'] });
    const r: any = await dispatchTool({ ...fixtureCfg, leanSweep: lean } as any, ANA, 'check_in', {});
    vi.useRealTimers();
    const text = r.content[0].text as string;
    const structured = JSON.stringify(r.structuredContent);
    const intros = r.structuredContent.introductions as any[];
    out[lean ? 'lean' : 'full'] = {
      content_text_chars: text.length,
      structured_chars: structured.length,
      introductions_chars: JSON.stringify(intros).length,
      account_level_chars: structured.length - JSON.stringify(intros).length,
      per_entry: intros.map((e) => ({ intro_id: e.intro_id.slice(0, 8), next: e.next ?? e.state, chars: JSON.stringify(e).length })),
      unmatched_sql: [...new Set(unknown)],
    };
    if (process.env.SHOW_SWEEP) console.log(text);
  }
  const full: any = out.full;
  const lean: any = out.lean;
  const pct = (a: number, b: number) => `${Math.round((1 - b / a) * 100)}% smaller`;
  const lines = [
    `content text (what the model reads): ${full.content_text_chars} -> ${lean.content_text_chars} chars (${pct(full.content_text_chars, lean.content_text_chars)})`,
    `structured content:                  ${full.structured_chars} -> ${lean.structured_chars} chars (${pct(full.structured_chars, lean.structured_chars)})`,
    `introductions (structured):          ${full.introductions_chars} -> ${lean.introductions_chars} chars`,
    `account-level fields (structured):   ${full.account_level_chars} -> ${lean.account_level_chars} chars`,
    'per entry (structured chars):',
    ...full.per_entry.map(
      (e: any, i: number) => `  ${e.intro_id} ${String(e.next).padEnd(20)} ${String(e.chars).padStart(5)} -> ${String(lean.per_entry[i].chars).padStart(5)}`,
    ),
  ];
  console.log(lines.join('\n'));
  if (process.env.SHOW_SQL) console.log(JSON.stringify({ unmatched: full.unmatched_sql }, null, 1));
});
