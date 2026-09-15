'use strict';
/**
 * One thin interface over two drivers: node-postgres in production, PGlite in
 * tests. The tests therefore run against real PostgreSQL semantics — triggers,
 * constraint timing, transaction isolation — not a mock that agrees with us.
 */

async function connect(opts = {}) {
  const url = opts.url || process.env.DATABASE_URL;

  if (!url || url === 'memory') {
    const { PGlite } = require('@electric-sql/pglite');
    const pg = await PGlite.create(opts.dir || undefined);
    return {
      kind: 'pglite',
      async query(sql, params) {
        const r = await pg.query(sql, params);
        return { rows: r.rows || [], rowCount: (r.rows || []).length, affected: r.affectedRows };
      },
      // multi-statement script (migrations); PGlite needs exec(), not query()
      async exec(sql) { await pg.exec(sql); },
      async tx(fn) {
        await this.query('BEGIN');
        try { const out = await fn(this); await this.query('COMMIT'); return out; }
        catch (e) { await this.query('ROLLBACK'); throw e; }
      },
      async end() { await pg.close(); }
    };
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: opts.max || 10 });
  return {
    kind: 'postgres',
    async query(sql, params) { return pool.query(sql, params); },
    async exec(sql) { await pool.query(sql); },
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn({ query: (s, p) => c.query(s, p) });
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally { c.release(); }
    },
    async end() { await pool.end(); }
  };
}

module.exports = { connect };
