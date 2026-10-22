require('dotenv').config();
const { createApp } = require('./src/app');
const { migrate } = require('./src/migrate');
const db = require('./src/db');

const PORT = process.env.PORT || 4000;

async function main() {
  // Apply pending migrations on boot (idempotent, guarded by an advisory
  // lock). Set AUTO_MIGRATE=false to run `npm run migrate` manually instead.
  if (process.env.AUTO_MIGRATE !== 'false') await migrate();

  const server = createApp().listen(PORT, () => {
    const mode = (process.env.EMAIL_MODE || 'console').toLowerCase();
    console.log(`ForgeFit backend listening on port ${PORT}`);
    console.log(`Email mode: ${mode}${mode !== 'smtp' ? ' (development only — codes are not emailed)' : ''}`);
  });

  const shutdown = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
