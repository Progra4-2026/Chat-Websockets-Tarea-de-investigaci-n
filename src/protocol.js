/**
 * protocol.js
 * ---------------------------------------------------------------------------
 * Define el esquema de mensajes de la aplicación y su validación.
 *
 * Todo mensaje que viaja por el WebSocket es un objeto JSON con la forma
 *
 *     { "event": "<nombre>", "data": { ... } }
 *
 * El servidor NUNCA confía en lo que envía el cliente: cada mensaje entrante
 * se parsea y se valida contra el esquema de su evento antes de procesarlo.
 * Si algo no cumple, se responde con un evento "error" y el mensaje se descarta.
 */
'use strict';

const config = require('./config');

/** Eventos que el CLIENTE puede enviar al servidor. */
const CLIENT_EVENTS = Object.freeze({
  USER_JOIN: 'user:join',
  USER_LEAVE: 'user:leave',
  CHAT_MESSAGE: 'chat:message',
  USER_TYPING: 'user:typing',
});

/** Eventos que el SERVIDOR envía a los clientes. */
const SERVER_EVENTS = Object.freeze({
  SYSTEM_WELCOME: 'system:welcome',
  SYSTEM_INFO: 'system:info',
  USER_JOIN: 'user:join',
  USER_LEAVE: 'user:leave',
  ROOM_USERS: 'room:users',
  CHAT_HISTORY: 'chat:history',
  CHAT_MESSAGE: 'chat:message',
  USER_TYPING: 'user:typing',
  ERROR: 'error',
});

/** Códigos de error devueltos en el evento "error". */
const ERROR_CODES = Object.freeze({
  INVALID_JSON: 'INVALID_JSON',
  INVALID_ENVELOPE: 'INVALID_ENVELOPE',
  UNKNOWN_EVENT: 'UNKNOWN_EVENT',
  INVALID_DATA: 'INVALID_DATA',
  NOT_JOINED: 'NOT_JOINED',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  RATE_LIMITED: 'RATE_LIMITED',
  BINARY_NOT_SUPPORTED: 'BINARY_NOT_SUPPORTED',
});

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const ok = (data) => ({ ok: true, data });
const fail = (code, msg) => ({ ok: false, error: { code, msg } });

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Verifica que el objeto no traiga campos fuera del esquema. */
function onlyKeys(obj, allowed) {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

/** Elimina caracteres de control (excepto salto de línea) y espacios sobrantes. */
function cleanText(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
}

// ---------------------------------------------------------------------------
// Validadores por evento. Cada uno recibe "data" y devuelve ok(...) o fail(...)
// con los datos ya normalizados.
// ---------------------------------------------------------------------------

const validators = {
  [CLIENT_EVENTS.USER_JOIN](data) {
    if (!isPlainObject(data) || !onlyKeys(data, ['user', 'room', 'resumeToken'])) {
      return fail(ERROR_CODES.INVALID_DATA, 'user:join requiere { user, room, resumeToken? }.');
    }
    if (data.resumeToken !== undefined &&
        (typeof data.resumeToken !== 'string' || data.resumeToken.length > 64)) {
      return fail(ERROR_CODES.INVALID_DATA, '"resumeToken" inválido.');
    }
    if (typeof data.user !== 'string' || typeof data.room !== 'string') {
      return fail(ERROR_CODES.INVALID_DATA, '"user" y "room" deben ser texto.');
    }
    const user = data.user.trim();
    if (!config.USERNAME_PATTERN.test(user)) {
      return fail(
        ERROR_CODES.INVALID_DATA,
        'El nombre debe tener entre 2 y 20 caracteres (letras, números, espacio, punto, guion o guion bajo).'
      );
    }
    if (!config.ROOMS.includes(data.room)) {
      return fail(ERROR_CODES.INVALID_DATA, `La sala "${String(data.room).slice(0, 30)}" no existe.`);
    }
    return ok({ user, room: data.room, resumeToken: data.resumeToken });
  },

  [CLIENT_EVENTS.CHAT_MESSAGE](data) {
    if (!isPlainObject(data) || !onlyKeys(data, ['text', 'ts'])) {
      return fail(ERROR_CODES.INVALID_DATA, 'chat:message requiere { text, ts? }.');
    }
    if (typeof data.text !== 'string') {
      return fail(ERROR_CODES.INVALID_DATA, '"text" debe ser texto.');
    }
    const text = cleanText(data.text);
    if (text.length === 0) {
      return fail(ERROR_CODES.INVALID_DATA, 'El mensaje no puede estar vacío.');
    }
    if (text.length > config.MAX_TEXT_LENGTH) {
      return fail(
        ERROR_CODES.INVALID_DATA,
        `El mensaje supera los ${config.MAX_TEXT_LENGTH} caracteres.`
      );
    }
    if (data.ts !== undefined && !Number.isFinite(data.ts)) {
      return fail(ERROR_CODES.INVALID_DATA, '"ts" debe ser un número (epoch en ms).');
    }
    return ok({ text });
  },

  [CLIENT_EVENTS.USER_TYPING](data) {
    if (!isPlainObject(data) || !onlyKeys(data, ['typing']) || typeof data.typing !== 'boolean') {
      return fail(ERROR_CODES.INVALID_DATA, 'user:typing requiere { typing: boolean }.');
    }
    return ok({ typing: data.typing });
  },

  [CLIENT_EVENTS.USER_LEAVE](data) {
    if (data !== undefined && !(isPlainObject(data) && Object.keys(data).length === 0)) {
      return fail(ERROR_CODES.INVALID_DATA, 'user:leave no lleva datos ({}).');
    }
    return ok({});
  },
};

/**
 * Parsea y valida un mensaje de texto crudo recibido por el socket.
 * @param {string} raw
 * @returns {{ok:true, event:string, data:object} | {ok:false, error:{code,msg}}}
 */
function parseClientMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return fail(ERROR_CODES.INVALID_JSON, 'El mensaje no es JSON válido.');
  }

  if (!isPlainObject(msg) || typeof msg.event !== 'string' || !onlyKeys(msg, ['event', 'data'])) {
    return fail(
      ERROR_CODES.INVALID_ENVELOPE,
      'Formato esperado: { "event": string, "data": object }.'
    );
  }

  const validate = validators[msg.event];
  if (!validate) {
    return fail(ERROR_CODES.UNKNOWN_EVENT, `Evento desconocido: "${msg.event.slice(0, 40)}".`);
  }

  const result = validate(msg.data);
  if (!result.ok) return result;
  return { ok: true, event: msg.event, data: result.data };
}

/** Serializa un evento del servidor con el mismo esquema { event, data }. */
function encode(event, data = {}) {
  return JSON.stringify({ event, data });
}

module.exports = {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  ERROR_CODES,
  parseClientMessage,
  encode,
};
