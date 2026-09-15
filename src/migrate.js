'use strict';
/**
 * Migration runner.
 *
 * Migrations are plain SQL, applied in filename order, each inside its own
 * transaction, recorded with a checksum. A file that has already run and has
 * since been edited is a hard error — schema history is not rewritten in place,
 * it is corrected by adding the next migration.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'migrations');

const TRACKING = `
CREATE TABLE IF NOT EXISTS schema_migration (
  filename    text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  ms          int NOT NULL
)`;

function files() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
}

async function migrate(db, { log = console.log } = {}) {
  await db.query(TRACKING);
  const done = new Map(
    (await db.query('SELECT filename, checksum FROM schema_migration')).rows.map(r => [r.filename, r.checksum])
  );

  let applied = 0;
  for (const f of files()) {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const sum = crypto.createHash('sha256').update(sql).digest('hex');

    if (done.has(f)) {
      if (done.get(f) !== sum) {
        throw new Error(
          `${f} has changed since it was applied. Migrations are immutable — ` +
          `add a new migration instead of editing this one.`
        );
      }
      continue;
    }

    const t0 = Date.now();
    await db.query('BEGIN');
    try {
      await db.exec(sql);
      await db.query(
        'INSERT INTO schema_migration (filename, checksum, ms) VALUES ($1,$2,$3)',
        [f, sum, Date.now() - t0]
      );
      await db.query('COMMIT');
      log(`  applied ${f} (${Date.now() - t0}ms)`);
      applied++;
    } catch (e) {
      await db.query('ROLLBACK');
      throw new Error(`${f} failed: ${e.message}`);
    }
  }
  return applied;
}

module.exports = { migrate, files };

if (require.main === module) {
  (async () => {
    const { connect } = require('./db');
    const db = await connect();
    const n = await migrate(db);
    console.log(n ? `${n} migration(s) applied.` : 'Schema already current.');
    await db.end();
  })().catch(e => { console.error(e.message); process.exit(1); });
}
