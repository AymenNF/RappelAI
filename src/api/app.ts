import Fastify, { LogController } from 'fastify';
import type { Config } from '../config/env.js';
import type { IngressStore } from '../db/ingress-store.js';
import { verifySignature } from '../modules/whatsapp/signature.js';
import { extractEvents } from '../modules/whatsapp/events.js';

export function buildApp(config: Config, store: IngressStore) {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    requestTimeout: 10000,
    logController: new LogController({ disableRequestLogging: true }),
    logger: config.LOG_LEVEL === 'silent' ? false : { level: config.LOG_LEVEL },
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const ready = await store.ready();
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unavailable' });
  });

  app.register(async (webhooks) => {
    // Scope raw parsing to webhooks; do not reserialize JSON before signature verification.
    webhooks.removeContentTypeParser('application/json');
    webhooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });
    webhooks.get('/webhooks/whatsapp', async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      if (
        query['hub.mode'] !== 'subscribe' ||
        query['hub.verify_token'] !== config.WHATSAPP_VERIFY_TOKEN ||
        typeof query['hub.challenge'] !== 'string'
      ) {
        return reply.code(403).send({ error: 'verification_failed' });
      }
      return reply.type('text/plain').send(query['hub.challenge']);
    });
    webhooks.post('/webhooks/whatsapp', async (request, reply) => {
      const raw = request.body;
      if (
        !Buffer.isBuffer(raw) ||
        !verifySignature(raw, request.headers['x-hub-signature-256'], config.WHATSAPP_APP_SECRET)
      ) {
        return reply.code(401).send({ error: 'invalid_signature' });
      }
      let events;
      try {
        events = extractEvents(JSON.parse(raw.toString('utf8')), config.WHATSAPP_PHONE_NUMBER_ID);
      } catch {
        return reply.code(400).send({ error: 'invalid_payload' });
      }
      try {
        const result = await store.persist(events);
        request.log.info(
          { requestId: request.id, received: events.length, inserted: result.inserted },
          'webhook persisted',
        );
        return reply.code(200).send({ accepted: true });
      } catch {
        // Returning 200 before durable storage would lose the message. Never log its body.
        request.log.error({ requestId: request.id }, 'webhook persistence failed');
        return reply.code(503).send({ error: 'storage_unavailable' });
      }
    });
  });
  return app;
}
