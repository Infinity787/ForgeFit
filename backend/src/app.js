const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const db = require('./db');
const authRoutes = require('./auth');
const dataRoutes = require('./data');
const aiRoutes = require('./ai');
const gemini = require('./gemini');

function createApp() {
  const app = express();

  // Render/Fly/Railway sit behind one proxy hop; without this every request
  // would share the proxy's IP and the rate limits would be global.
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
  app.disable('x-powered-by');
  app.use(helmet());

  const corsOrigin = process.env.CORS_ORIGIN || '*';
  app.use(cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((s) => s.trim()),
    maxAge: 600,
  }));

  app.get('/api/health', async (req, res) => {
    let database = 'ok';
    try { await db.query('SELECT 1'); } catch (e) { database = 'unavailable'; }
    res.status(database === 'ok' ? 200 : 503).json({
      ok: database === 'ok', service: 'forgefit-backend', database,
      ai: gemini.configured() ? 'configured' : 'not-configured',
      time: new Date().toISOString(),
    });
  });

  app.use('/api/auth', express.json({ limit: '50kb' }), authRoutes);
  // Imports carry a whole device's history; normal syncs are small.
  app.use('/api/data/import', express.json({ limit: '5mb' }));
  app.use('/api/data', express.json({ limit: '1mb' }), dataRoutes);
  app.use('/api/ai', express.json({ limit: '64kb' }), aiRoutes);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // Errors: expose only messages we wrote for users; log everything else
  // without request bodies (they can contain personal data or photos).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON.' });
    const status = err.status || 500;
    if (status >= 500 && !err.expose) {
      console.error(`[error] ${req.method} ${req.path}:`, err.code || '', err.message);
      return res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
    }
    return res.status(status).json({ error: err.expose ? err.message : 'Request failed.' });
  });

  return app;
}

module.exports = { createApp };
