import { createServer } from 'node:http';

import cors from 'cors';
import express from 'express';

import { ami } from './ami.js';
import { ari } from './ari.js';
import { config } from './config.js';
import { log } from './logger.js';
import { attachRealtime, connectedDashboards } from './realtime.js';
import { authRouter } from './routes/auth.js';
import { configRouter } from './routes/config.js';
import { switchboardRouter } from './routes/switchboard.js';
import { switchboard } from './state.js';
import { loadUsers, watchUsers } from './users.js';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Normally the web container serves the app and proxies /api here, so requests
// are same-origin and CORS never applies.  Two exceptions: the dev server runs
// on its own port, and a statically hosted UI (GitHub Pages, a CDN) is a
// genuinely different origin — which is what CORS_ORIGIN is for.
//
// Never a wildcard in production: these endpoints hand out SIP credentials, so
// an unlisted origin should be refused rather than trusted.
app.use(
  cors({
    origin:
      config.env === 'production'
        ? config.corsOrigins.length > 0
          ? config.corsOrigins
          : false
        : true,
    credentials: false,
  }),
);

if (config.env === 'production' && config.corsOrigins.length > 0) {
  log.info('cross-origin browser access enabled', { origins: config.corsOrigins });
}

app.get('/api/health', (_req, res) => {
  const healthy = ari.connected && ami.connected;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    ari: ari.connected,
    ami: ami.connected,
    dashboards: connectedDashboards(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.use('/api/auth', authRouter);
app.use('/api/config', configRouter);
app.use('/api', switchboardRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Express needs the four-argument shape to recognise an error handler.
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ): void => {
    log.error('unhandled request error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'internal error' });
  },
);

async function main(): Promise<void> {
  await loadUsers();
  watchUsers();

  const server = createServer(app);
  attachRealtime(server);

  switchboard.start(process.env['TRUNK_NAME'] ?? 'primary');
  ari.connect();
  ami.connect();

  server.listen(config.port, () => {
    log.info('control server listening', {
      port: config.port,
      env: config.env,
      sipWebsocket: config.sipWebsocketUrl,
    });
  });

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    switchboard.stop();
    ari.close();
    ami.close();
    server.close(() => process.exit(0));
    // Do not let a hung socket keep the container alive past the stop timeout.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('failed to start', { error: String(err) });
  process.exit(1);
});
