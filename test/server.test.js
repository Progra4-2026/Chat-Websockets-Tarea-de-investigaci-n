/**
 * Pruebas de integración: levantan el servidor real en un puerto libre y se
 * conectan con clientes WebSocket reales (librería ws).
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createApp } = require('../src/server');

let app;
let base;
const ORIGIN = 'http://localhost:3000';

test.before(async () => {
  app = createApp({ ALLOWED_ORIGINS: [ORIGIN], RATE_LIMIT_MAX: 3, HEARTBEAT_INTERVAL_MS: 60000 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${app.server.address().port}/ws`;
});

test.after(() => {
  app.wss.close();
  app.server.close();
});

/** Abre un cliente y acumula los mensajes recibidos para poder esperarlos. */
function connect(origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base, { origin });
    const inbox = [];
    const waiters = [];
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      inbox.push(msg);
      for (const w of [...waiters]) {
        const i = inbox.findIndex(w.match);
        if (i >= 0) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(inbox.splice(i, 1)[0]);
        }
      }
    });
    const client = {
      ws,
      send: (event, data) => ws.send(JSON.stringify({ event, data })),
      /** Espera el siguiente mensaje con ese evento (y condición opcional). */
      next(event, pred = () => true, ms = 2000) {
        const match = (m) => m.event === event && pred(m.data);
        const i = inbox.findIndex(match);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { match, resolve: res };
          waiters.push(w);
          setTimeout(() => rej(new Error(`timeout esperando ${event}`)), ms);
        });
      },
      close: () => ws.close(),
    };
    ws.once('open', () => resolve(client));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

test('el handshake con un origen no permitido se rechaza con 403', async () => {
  await assert.rejects(connect('http://sitio-malicioso.com'), /403/);
});

test('al conectar se recibe system:welcome con las salas', async () => {
  const c = await connect();
  const { data } = await c.next('system:welcome');
  assert.ok(data.clientId);
  assert.deepEqual(data.rooms.map((r) => r.name), ['general', 'programacion-4', 'proyectos']);
  c.close();
});

test('dos clientes en la misma sala intercambian mensajes en tiempo real', async () => {
  const ana = await connect();
  const luis = await connect();

  ana.send('user:join', { user: 'Ana', room: 'general' });
  await ana.next('chat:history');

  luis.send('user:join', { user: 'Luis', room: 'general' });
  await luis.next('chat:history');

  // Ana se entera de que Luis entró y recibe la lista actualizada.
  assert.equal((await ana.next('user:join')).data.user, 'Luis');
  const users = await ana.next('room:users', (d) => d.users.length === 2);
  assert.deepEqual(users.data.users, ['Ana', 'Luis']);

  ana.send('chat:message', { text: 'Hola, grupo', ts: 1 });
  const recibido = await luis.next('chat:message');
  assert.equal(recibido.data.user, 'Ana');
  assert.equal(recibido.data.text, 'Hola, grupo');
  assert.notEqual(recibido.data.ts, 1, 'el servidor asigna su propia marca de tiempo');

  // Al desconectarse Luis, Ana recibe user:leave.
  luis.close();
  assert.equal((await ana.next('user:leave')).data.user, 'Luis');
  ana.close();
});

test('un nuevo integrante recibe el historial reciente de la sala', async () => {
  const a = await connect();
  a.send('user:join', { user: 'Carla', room: 'proyectos' });
  await a.next('chat:history');
  a.send('chat:message', { text: 'Mensaje guardado' });
  await a.next('chat:message');

  const b = await connect();
  b.send('user:join', { user: 'Diego', room: 'proyectos' });
  const hist = await b.next('chat:history');
  assert.ok(hist.data.messages.some((m) => m.text === 'Mensaje guardado'));
  a.close();
  b.close();
});

test('mensajes malformados o fuera de esquema reciben un evento error', async () => {
  const c = await connect();
  c.ws.send('esto no es json');
  assert.equal((await c.next('error')).data.code, 'INVALID_JSON');

  c.send('chat:borrar-todo', {});
  assert.equal((await c.next('error')).data.code, 'UNKNOWN_EVENT');

  c.send('chat:message', { text: 'hola' });
  assert.equal((await c.next('error')).data.code, 'NOT_JOINED');

  c.send('user:join', { user: '<b>x</b>', room: 'general' });
  assert.equal((await c.next('error')).data.code, 'INVALID_DATA');
  c.close();
});

test('no se permiten dos usuarios con el mismo nombre en una sala', async () => {
  const a = await connect();
  const b = await connect();
  a.send('user:join', { user: 'Eva', room: 'programacion-4' });
  await a.next('chat:history');
  b.send('user:join', { user: 'eva', room: 'programacion-4' });
  assert.equal((await b.next('error')).data.code, 'USERNAME_TAKEN');
  a.close();
  b.close();
});

test('reanudar sesión con el token de la conexión anterior', async () => {
  const a = await connect();
  const { data: welcome } = await a.next('system:welcome');
  a.send('user:join', { user: 'Fabio', room: 'general' });
  await a.next('chat:history');

  // Simula que la red se cayó y el navegador abrió una conexión nueva
  // antes de que el servidor notara la caída de la primera.
  const b = await connect();
  b.send('user:join', { user: 'Fabio', room: 'general', resumeToken: welcome.resumeToken });
  await b.next('chat:history');
  await new Promise((r) => a.ws.once('close', r)); // la conexión vieja se cierra
  b.close();
});

test('el limitador de frecuencia bloquea ráfagas de mensajes', async () => {
  const c = await connect();
  c.send('user:join', { user: 'Gabi', room: 'general' });
  await c.next('chat:history');
  for (let i = 0; i < 5; i++) c.send('chat:message', { text: `m${i}` });
  assert.equal((await c.next('error')).data.code, 'RATE_LIMITED');
  c.close();
});

test('un mensaje mayor al límite cierra la conexión con código 1009', async () => {
  const c = await connect();
  const code = await new Promise((resolve) => {
    c.ws.on('close', (code) => resolve(code));
    c.ws.send('x'.repeat(10 * 1024));
  });
  assert.equal(code, 1009);
});
