/**
 * Runs the schema repo's runConformance() suite against the LIVE deployment's
 * validators via POST /conformance/validate.
 */
import { describe, expect, it } from 'vitest';
import { runConformance, type ValidationResult } from '@openswitchboard/schema';
import { BASE_URL } from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

d('conformance against live deployment validators', () => {
  it(`passes runConformance() via ${BASE_URL}/conformance/validate`, async () => {
    // The harness is synchronous; pre-fetch every fixture validation result.
    const { loadFixtures } = await import('@openswitchboard/schema');
    const fixtures = loadFixtures();
    const results = new Map<string, ValidationResult>();
    for (const f of fixtures) {
      const res = await fetch(`${BASE_URL}/conformance/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema: f.schema, data: f.data }),
      });
      expect(res.status).toBe(200);
      results.set(`${f.schema}:${JSON.stringify(f.data)}`, (await res.json()) as ValidationResult);
    }
    const report = runConformance((schema, data) => {
      const r = results.get(`${schema}:${JSON.stringify(data)}`);
      if (!r) throw new Error('missing prefetched validation result');
      return r;
    });
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(report.total);
  }, 300_000);
});
