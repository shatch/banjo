import { Hono } from 'hono';

export const healthRoutes = new Hono();

healthRoutes.get('/health', (c) => c.json({ ok: true, service: 'ea', time: new Date().toISOString() }));
