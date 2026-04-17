require('dotenv').config();
const Fastify = require('fastify');

const app = Fastify({
  logger: process.env.NODE_ENV === 'production'
    ? { level: 'warn' }
    : { level: 'info' },
  trustProxy: true,
});

app.register(require('@fastify/helmet'));
app.register(require('@fastify/cors'), { origin: '*' });
app.register(require('@fastify/sensible'));

// Root endpoint with ASCII art
app.get('/', async (request, reply) => {
  reply.type('text/plain').send(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ███████╗██╗   ██╗███████╗███╗   ██╗████████╗ ██████╗       ║
║   ██╔════╝██║   ██║██╔════╝████╗  ██║╚══██╔══╝██╔═══██╗      ║
║   █████╗  ██║   ██║█████╗  ██╔██╗ ██║   ██║   ██║   ██║      ║
║   ██╔══╝  ╚██╗ ██╔╝██╔══╝  ██║╚██╗██║   ██║   ██║   ██║      ║
║   ███████╗ ╚████╔╝ ███████╗██║ ╚████║   ██║   ╚██████╔╝      ║
║   ╚══════╝  ╚═══╝  ╚══════╝╚═╝  ╚═══╝   ╚═╝    ╚═════╝       ║
║                                                               ║
║                       NODE API v1.0                           ║
║                  https://eventoapi.com                        ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

🚀 Evento API is running

Endpoints:
  • GET  /health          - Health check
  • POST /v1/*            - API v1 (requires authentication)

Documentation: https://github.com/eventonz/api
  `);
});

// Health check — no version prefix, used by DO Load Balancer
app.get('/health', async () => ({ status: 'ok' }));

// Versioned API routes
// New URL: eventoapi.com/v1/...
// Old API: eventotracker.com/api/v4/... (still running on ColdFusion)
app.register(require('./routes/v1'), { prefix: '/v1' });

// Future versions added here:
// app.register(require('./routes/v2'), { prefix: '/v2' });

const start = async () => {
  try {
    await app.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
    if (process.send) process.send('ready');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

const shutdown = async (signal) => {
  app.log.warn(`${signal} received — shutting down`);
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
