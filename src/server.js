'use strict';
/** Entry point. Migrate, then serve. */
const { connect } = require('./db');
const { migrate } = require('./migrate');
const { createApp } = require('./app');

(async () => {
  const db = await connect();
  await migrate(db, { log: m => console.log(m) });
  const app = createApp(db, { log: (lvl, ...rest) => console.error(`[${lvl}]`, ...rest) });
  const port = Number(process.env.PORT || 8080);
  app.listen(port);
  console.log(`SMARTWARE 360 API listening on :${port} — ${app.routeCount} routes`);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => { await db.end(); process.exit(0); });
  }
})().catch(e => { console.error(e); process.exit(1); });
