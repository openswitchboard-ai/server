/**
 * What the switchboard keeps about mail, how long, and ops that outlive a
 * minute (2026-09-28 review).
 *
 *  6. An SES event row holds hashes of its recipients and the bounce /
 *     complaint type fields, never an address and never the raw payload, and
 *     rows go after ninety days on the ttl-expiry tick.
 *  7. Every received ops message keeps its claim while it runs; the
 *     ttl-expiry tick also purges expired human sessions.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from '../../src/db.js';
import { sqs } from '../../src/aws.js';
import { emailHash } from '../../src/domain/accounts.js';
import {
  EMAIL_EVENT_RETENTION_DAYS,
  processSesEvent,
  purgeOldEmailEvents,
} from '../../src/workers/emailEventsWorker.js';
import {
  OPS_VISIBILITY_S,
  purgeExpiredCounterSessions,
  startVisibilityHeartbeat,
} from '../../src/workers/opsWorker.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, '..', '..', p), 'utf8');

beforeAll(async () => {
  process.env.COUNTER_LINK_HMAC_KEY = 'ab'.repeat(32);
  process.env.COUNTER_COOKIE_KEY = 'cd'.repeat(32);
  const { initCounterKeys } = await import('../../src/counter/keys.js');
  await initCounterKeys({} as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function recordingPool() {
  const seen: { sql: string; params: any[] }[] = [];
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/FROM email_sends/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 3 };
    },
  } as any;
  return { seen, pool };
}

describe('6. an SES event row holds no address', () => {
  it('writes the recipients as keyed hashes and keeps only the type fields', async () => {
    const { seen, pool } = recordingPool();
    vi.spyOn(db, 'getPool').mockReturnValue(pool);
    const event = {
      eventType: 'Bounce',
      mail: {
        messageId: 'msg-1',
        destination: ['Person@Example.test'],
        commonHeaders: { to: ['Person <person@example.test>'], subject: 'Your code' },
      },
      bounce: {
        bounceType: 'Transient',
        bounceSubType: 'MailboxFull',
        bouncedRecipients: [{ emailAddress: 'person@example.test', diagnosticCode: 'smtp; 552' }],
      },
    };
    await processSesEvent(JSON.stringify(event), () => {});
    const insert = seen.find((s) => /INSERT INTO email_events/.test(s.sql))!;
    expect(insert.sql).toMatch(/recipient_hashes, detail/);
    expect(insert.sql).not.toMatch(/\braw\b/);
    expect(insert.sql).not.toMatch(/\brecipients\b/);
    const written = JSON.stringify(insert.params);
    expect(written).not.toMatch(/example\.test/i);
    expect(written).not.toMatch(/Your code/);
    expect(JSON.parse(insert.params[3])).toEqual([emailHash('person@example.test')]);
    expect(JSON.parse(insert.params[4])).toEqual({
      bounceType: 'Transient',
      bounceSubType: 'MailboxFull',
    });
  });

  it('writes no detail at all for an event that has none', async () => {
    const { seen, pool } = recordingPool();
    vi.spyOn(db, 'getPool').mockReturnValue(pool);
    await processSesEvent(
      JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'x', destination: ['a@b.test'] } }),
      () => {},
    );
    const insert = seen.find((s) => /INSERT INTO email_events/.test(s.sql))!;
    expect(insert.params[4]).toBeNull();
  });

  it('deletes rows past ninety days in batches, and empties any retired column', async () => {
    const { seen, pool } = recordingPool();
    vi.spyOn(db, 'getPool').mockReturnValue(pool);
    expect(EMAIL_EVENT_RETENTION_DAYS).toBe(90);
    const r = await purgeOldEmailEvents();
    expect(r).toEqual({ deleted: 3, scrubbed: 3 });
    expect(seen[0].sql).toMatch(/DELETE FROM email_events/);
    expect(seen[0].sql).toMatch(/created_at < now\(\) - make_interval\(days => \$1::int\)/);
    expect(seen[0].sql).toMatch(/LIMIT \$2/);
    expect(seen[0].params).toEqual([90, 5000]);
    expect(seen[1].sql).toMatch(/SET recipients = NULL, raw = NULL/);
  });

  it('migration 056 empties the old columns and never needs the pepper', () => {
    const sql = read('migrations/056_money_and_retention.sql');
    expect(sql).toMatch(/UPDATE email_events SET recipients = NULL, raw = NULL/);
    expect(sql).toMatch(/ALTER COLUMN raw DROP NOT NULL/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS recipient_hashes jsonb/);
    expect(sql).toMatch(/conversation_photos ADD COLUMN IF NOT EXISTS metadata_stripped_at/);
  });

  it('the ttl-expiry tick runs the retention, the session purge, and marks the screening hook', () => {
    const src = read('src/workers/opsWorker.ts');
    const tick = src.slice(src.indexOf("case 'ttl-expiry'"), src.indexOf("case 'sequencer-tick'"));
    expect(tick).toContain('purgeOldEmailEvents()');
    expect(tick).toContain('purgeExpiredCounterSessions()');
    expect(tick).toContain('// rf-content: call screening.rejectStuckScreening() here');
  });
});

describe('7. an ops message keeps its claim while it runs', () => {
  it('purges sessions a day past their expiry', async () => {
    const { seen, pool } = recordingPool();
    vi.spyOn(db, 'getPool').mockReturnValue(pool);
    expect(await purgeExpiredCounterSessions()).toEqual({ sessions: 3 });
    expect(seen[0].sql).toMatch(
      /DELETE FROM counter_sessions WHERE expires_at < now\(\) - interval '1 day'/,
    );
  });

  it('extends every unfinished message each minute, and stops for finished ones', async () => {
    vi.useFakeTimers();
    const sent: any[] = [];
    vi.spyOn(sqs, 'send').mockImplementation(async (cmd: any) => {
      sent.push({ kind: cmd.constructor.name, input: cmd.input });
      return {} as any;
    });
    const pending = new Set(['h1', 'h2']);
    const stop = startVisibilityHeartbeat('https://q.test/ops', pending, () => {});
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent.map((s) => [s.kind, s.input.ReceiptHandle, s.input.VisibilityTimeout])).toEqual([
      ['ChangeMessageVisibilityCommand', 'h1', OPS_VISIBILITY_S],
      ['ChangeMessageVisibilityCommand', 'h2', OPS_VISIBILITY_S],
    ]);
    pending.delete('h1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent.slice(2).map((s) => s.input.ReceiptHandle)).toEqual(['h2']);
    stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sent).toHaveLength(3);
  });

  it('the receive asks for longer than the heartbeat interval', () => {
    expect(OPS_VISIBILITY_S * 1000).toBeGreaterThan(60_000);
    const src = read('src/workers/opsWorker.ts');
    expect(src).toContain('VisibilityTimeout: OPS_VISIBILITY_S');
    expect(src).not.toMatch(/VisibilityTimeout: 60\b/);
  });
});
