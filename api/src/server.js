require('dotenv').config();

// ---- Fail fast on a misconfigured production boot ----------------------------
// Render/Neon deploys inject these via the dashboard; if they're missing or
// still set to the .env.example placeholders we'd boot an insecure / broken
// server. Surface it loudly at startup instead of at the first request.
function assertProductionEnv() {
  if (process.env.NODE_ENV !== 'production') return;
  const problems = [];

  if (!process.env.DATABASE_URL) {
    problems.push('DATABASE_URL is required');
  }

  const secret = process.env.JWT_SECRET || '';
  if (!secret || /change-me|replace-with/i.test(secret) || secret.length < 32) {
    problems.push('JWT_SECRET must be a real value of at least 32 characters');
  }

  if (!process.env.CLIENT_ORIGIN) {
    problems.push('CLIENT_ORIGIN should be set to your public origin');
  }

  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error('Refusing to start — invalid production config:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
}

assertProductionEnv();

const app = require('./app');
const prisma = require('./lib/prisma');

const port = process.env.PORT || 4000;
const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on port ${port}`);
});

// Graceful shutdown so Render's deploy/restart drains connections cleanly.
async function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`${signal} received, shutting down...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // Don't hang forever if a connection won't close.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
