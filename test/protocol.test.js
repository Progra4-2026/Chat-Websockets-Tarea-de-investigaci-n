/**
 * Pruebas unitarias del esquema de mensajes (protocol.js) y del limitador.
 * Ejecutar con:  npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClientMessage, ERROR_CODES } = require('../src/protocol');
const { SlidingWindowLimiter } = require('../src/rateLimiter');

const raw = (obj) => JSON.stringify(obj);

test('acepta un user:join válido y recorta espacios', () => {
  const r = parseClientMessage(raw({ event: 'user:join', data: { user: '  Ana  ', room: 'general' } }));
  assert.equal(r.ok, true);
  assert.equal(r.data.user, 'Ana');
  assert.equal(r.data.room, 'general');
});

test('rechaza JSON mal formado', () => {
  const r = parseClientMessage('{"event": "chat:message", "data": {');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, ERROR_CODES.INVALID_JSON);
});

test('rechaza un sobre sin "event" o con campos extra', () => {
  assert.equal(parseClientMessage(raw({ data: {} })).error.code, ERROR_CODES.INVALID_ENVELOPE);
  assert.equal(parseClientMessage(raw([1, 2])).error.code, ERROR_CODES.INVALID_ENVELOPE);
  assert.equal(
    parseClientMessage(raw({ event: 'chat:message', data: { text: 'a' }, x: 1 })).error.code,
    ERROR_CODES.INVALID_ENVELOPE
  );
});

test('rechaza eventos desconocidos', () => {
  const r = parseClientMessage(raw({ event: 'chat:borrar-todo', data: {} }));
  assert.equal(r.error.code, ERROR_CODES.UNKNOWN_EVENT);
});

test('rechaza nombres de usuario inválidos y salas inexistentes', () => {
  for (const user of ['A', 'x'.repeat(21), '<script>', 'ana@una']) {
    const r = parseClientMessage(raw({ event: 'user:join', data: { user, room: 'general' } }));
    assert.equal(r.ok, false, `debería rechazar "${user}"`);
  }
  const r = parseClientMessage(raw({ event: 'user:join', data: { user: 'Ana', room: 'secreta' } }));
  assert.equal(r.error.code, ERROR_CODES.INVALID_DATA);
});

test('chat:message: vacío, demasiado largo, tipo incorrecto o campo extra', () => {
  const cases = [
    { text: '   ' },
    { text: 'x'.repeat(501) },
    { text: 42 },
    { text: 'hola', admin: true },
    { text: 'hola', ts: 'ayer' },
  ];
  for (const data of cases) {
    const r = parseClientMessage(raw({ event: 'chat:message', data }));
    assert.equal(r.ok, false, `debería rechazar ${JSON.stringify(data).slice(0, 40)}`);
    assert.equal(r.error.code, ERROR_CODES.INVALID_DATA);
  }
});

test('chat:message elimina caracteres de control pero conserva saltos de línea', () => {
  const r = parseClientMessage(raw({ event: 'chat:message', data: { text: 'hola\u0007\nmundo', ts: 1 } }));
  assert.equal(r.ok, true);
  assert.equal(r.data.text, 'hola\nmundo');
});

test('user:typing exige un booleano', () => {
  assert.equal(parseClientMessage(raw({ event: 'user:typing', data: { typing: true } })).ok, true);
  assert.equal(parseClientMessage(raw({ event: 'user:typing', data: { typing: 'si' } })).ok, false);
});

test('el limitador permite N mensajes por ventana y luego bloquea', () => {
  let t = 0;
  const lim = new SlidingWindowLimiter(3, 1000, () => t);
  assert.equal(lim.tryConsume(), true);
  assert.equal(lim.tryConsume(), true);
  assert.equal(lim.tryConsume(), true);
  assert.equal(lim.tryConsume(), false);
  t = 1000; // la ventana se desliza
  assert.equal(lim.tryConsume(), true);
});
