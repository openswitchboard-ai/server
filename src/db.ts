import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { secretsManager } from './aws.js';
import type { Config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));

let pool: pg.Pool | undefined;

export async function initDb(cfg: Config): Promise<pg.Pool> {
  if (pool) return pool;
  const sec = await secretsManager.send(new GetSecretValueCommand({ SecretId: cfg.dbSecretArn }));
  const s = JSON.parse(sec.SecretString ?? '{}');
  if (!s.host || !s.username || !s.password) {
    throw new Error('DB secret is missing host/username/password');
  }
  const caPath = process.env.RDS_CA_BUNDLE ?? '/etc/osb/rds-global-bundle.pem';
  let ssl: pg.PoolConfig['ssl'];
  try {
    ssl = { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  } catch {
    if (process.env.DB_ALLOW_PLAINTEXT === '1') {
      ssl = undefined; // local test container only
    } else {
      throw new Error(`RDS CA bundle not found at ${caPath}`);
    }
  }
  pool = new pg.Pool({
    host: s.host,
    port: Number(s.port ?? 5432),
    user: s.username,
    password: s.password,
    database: s.dbname ?? 'osb',
    max: 10,
    ssl,
  });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('db not initialised');
  return pool;
}

/** Run SQL migrations under an advisory lock (safe with multiple tasks). */
export async function migrate(): Promise<void> {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('SELECT pg_advisory_lock(772001)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    // Works compiled (dist/src/db.js), via tsx (src/db.ts), and from cwd.
    const candidates = [
      join(here, '..', '..', 'migrations'),
      join(here, '..', 'migrations'),
      join(process.cwd(), 'migrations'),
    ];
    const dir = candidates.find((d) => {
      try {
        return readdirSync(d).some((f) => f.endsWith('.sql'));
      } catch {
        return false;
      }
    });
    if (!dir) throw new Error('migrations directory not found');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
      if (done.rowCount) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(772001)').catch(() => {});
    client.release();
  }
}
