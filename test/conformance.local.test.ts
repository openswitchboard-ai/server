import { describe, expect, it } from 'vitest';
import { runConformance } from '@openswitchboard/schema';
import { validatePayload } from '../src/protocol.js';

describe('conformance (local validators)', () => {
  it('passes the schema repo conformance suite with the server validators', () => {
    const report = runConformance((schema, data) => validatePayload(schema, data));
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(report.total);
    expect(report.total).toBeGreaterThan(30);
  });
});
