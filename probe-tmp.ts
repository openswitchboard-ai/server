import { dbExec } from './test/integration/helpers.js';
console.log('MIGRATIONS', JSON.stringify(await dbExec(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3`)));
console.log('COLUMN', JSON.stringify(await dbExec(
  `SELECT column_name FROM information_schema.columns WHERE table_name='cards' AND column_name='geo_country'`)));
console.log('BACKFILL STATE', JSON.stringify(await dbExec(
  `SELECT count(*) FILTER (WHERE geo_country IS NULL)::text AS no_country,
          count(*) FILTER (WHERE geo_lat IS NULL)::text AS unplaced, count(*)::text AS total FROM cards`)));
