import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { ApiError } from './errors.js';
import { apiRoutes } from './routes/api.js';
import { publicRoutes } from './routes/public.js';
import { startWorker, stopWorker } from './worker.js';

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 20 * 1024 * 1024, trustProxy: true });

  // SNS posts JSON with content-type text/plain
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  await app.register(formbody);

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: err.issues.map((i) => `${i.path.join('.') || 'גוף הבקשה'}: ${i.message}`).join('; '), details: err.issues },
      });
    }
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'שגיאה פנימית. נסו שוב בעוד רגע' } });
  });

  await app.register(publicRoutes);
  await app.register(apiRoutes);

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  await app.register(fastifyStatic, { root: publicDir, prefix: '/app/' });
  app.get('/', (_req, reply) => reply.redirect('/app/', 302));
  app.get('/app', (_req, reply) => reply.redirect('/app/', 302));
  return app;
}

async function main() {
  const cmd = process.argv[2];
  await migrate();
  if (cmd === 'migrate') {
    await pool.end();
    return;
  }
  if (config.role === 'web' || config.role === 'all') {
    const app = await buildServer();
    await app.listen({ port: config.port, host: '0.0.0.0' });
  }
  if (config.role === 'worker' || config.role === 'all') startWorker();

  const shutdown = async () => {
    stopWorker();
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
