import {registerDoudizhu} from './games/doudizhu.js';
import Fastify from 'fastify';
import { Server } from 'socket.io';
import type { ClientEvents, ServerEvents } from '@board/contracts';
import { openDatabase } from './database/index.js';
import { createRegistry } from './games/registry.js';
import { registerAuth } from './auth/index.js';
export function createApp(options: { databasePath: string; origin: string; logger?: boolean; production?: boolean; doudizhuClock?:()=>number }) {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 16384, trustProxy: '127.0.0.1' });
  const { sqlite } = openDatabase(options.databasePath);
  const registry = createRegistry();
  app.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control','no-store'); });
  registerAuth(app, sqlite, options.origin, options.production ?? false);
  registerDoudizhu(app,sqlite,options.origin,options.production??false,options.doudizhuClock);
  const io = new Server<ClientEvents, ServerEvents>(app.server, { maxHttpBufferSize: 16384, cors: { origin: options.origin }, allowRequest: (req, callback) => callback(null, !req.headers.origin || req.headers.origin === options.origin) });
  // Public transport diagnostics only. No room subscriptions, identity claims or game actions.
  io.on('connection', socket => {
    socket.emit('platform:hello', { protocolVersion: 1, serverTime: new Date().toISOString(), access: 'public' });
    socket.on('platform:ping', ack => { if (typeof ack === 'function') ack({ serverTime: new Date().toISOString() }); });
  });
  app.get('/api/health', (_req, reply) => {
    try {
      const migration = sqlite.prepare('SELECT version FROM schema_migrations WHERE version=1').get();
      if (!migration) throw new Error('Migration missing');
      return { status: 'ok', database: 'ready' };
    }
    catch { return reply.code(503).send({ status: 'unavailable', database: 'migration_required' }); }
  });
  app.get('/api/games', () => ({ games: registry.list() }));
  app.addHook('onClose', async () => { io.disconnectSockets(true); io.engine.close(); sqlite.close(); });
  return { app, io };
}
