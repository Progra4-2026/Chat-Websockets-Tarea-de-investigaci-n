/**
 * chatServer.js
 * ---------------------------------------------------------------------------
 * Lógica principal del servidor WebSocket.
 *
 *  1. Acepta o rechaza el handshake (validación de Origin y límite por IP).
 *  2. Mantiene el registro de clientes conectados.
 *  3. Recibe cada mensaje, lo valida con protocol.js y lo enruta al
 *     manejador del evento correspondiente.
 *  4. Retransmite (broadcast) a la sala los eventos que corresponden.
 *  5. Detecta conexiones muertas con ping/pong de protocolo (heartbeat).
 */
'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const config = require('./config');
const { RoomManager } = require('./rooms');
const { SlidingWindowLimiter } = require('./rateLimiter');
const {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  ERROR_CODES,
  parseClientMessage,
  encode,
} = require('./protocol');

/** Escribe una línea de bitácora con marca de tiempo. */
function log(...args) {
  if (process.env.NODE_ENV === 'test') return;
  console.log(new Date().toISOString(), '[ws]', ...args);
}

/**
 * Crea el servidor WebSocket y lo engancha al servidor HTTP indicado.
 * @param {import('http').Server} httpServer
 * @param {object} [options]  permite sobreescribir valores de config (pruebas)
 */
function createChatServer(httpServer, options = {}) {
  const opts = { ...config, ...options };
  const rooms = new RoomManager(opts.ROOMS, opts.HISTORY_SIZE);
  /** @type {Set<object>} */
  const clients = new Set();
  /** Conexiones abiertas por IP. */
  const connectionsByIp = new Map();

  const wss = new WebSocketServer({
    server: httpServer,
    path: opts.WS_PATH,
    maxPayload: opts.MAX_PAYLOAD_BYTES, // > maxPayload => cierre 1009
    clientTracking: false,
    perMessageDeflate: false,

    // Se ejecuta durante el handshake HTTP (antes del 101 Switching Protocols).
    verifyClient(info, done) {
      const origin = info.origin || info.req.headers.origin;
      const ip = info.req.socket.remoteAddress;

      // Validación de origen: los navegadores siempre envían Origin.
      // Clientes sin Origin (p. ej. herramientas de línea de comandos) se
      // permiten solo si ALLOW_NO_ORIGIN está activo.
      if (origin && !opts.ALLOWED_ORIGINS.includes(origin)) {
        log(`handshake rechazado: origen no permitido ${origin}`);
        return done(false, 403, 'Origin not allowed');
      }
      if (!origin && !opts.ALLOW_NO_ORIGIN) {
        return done(false, 403, 'Origin required');
      }
      if ((connectionsByIp.get(ip) || 0) >= opts.MAX_CONNECTIONS_PER_IP) {
        log(`handshake rechazado: demasiadas conexiones desde ${ip}`);
        return done(false, 429, 'Too many connections');
      }
      return done(true);
    },
  });

  // -------------------------------------------------------------------------
  // Helpers de envío
  // -------------------------------------------------------------------------
  const send = (client, event, data) => {
    if (client.socket.readyState === client.socket.OPEN) {
      client.socket.send(encode(event, data));
    }
  };
  const sendError = (client, code, msg) => send(client, SERVER_EVENTS.ERROR, { code, msg });
  const systemInfo = (msg, level = 'info') => ({ level, msg, ts: Date.now() });

  /** Envía a toda la sala la lista actualizada de usuarios conectados. */
  const publishUsers = (roomName) => {
    rooms.broadcast(
      roomName,
      encode(SERVER_EVENTS.ROOM_USERS, { room: roomName, users: rooms.usersIn(roomName) })
    );
  };

  /** Saca a un cliente de su sala y avisa a los demás. */
  const leaveRoom = (client, reason = 'salió de') => {
    const roomName = rooms.leave(client);
    if (!roomName) return;
    rooms.broadcast(roomName, encode(SERVER_EVENTS.USER_LEAVE, { user: client.user, room: roomName }));
    rooms.broadcast(
      roomName,
      encode(SERVER_EVENTS.SYSTEM_INFO, systemInfo(`${client.user} ${reason} la sala`))
    );
    publishUsers(roomName);
    log(`${client.user} ${reason} #${roomName}`);
  };

  // -------------------------------------------------------------------------
  // Manejadores de eventos del cliente
  // -------------------------------------------------------------------------
  const handlers = {
    [CLIENT_EVENTS.USER_JOIN](client, { user, room, resumeToken }) {
      // Si ya estaba en otra sala, se trata como un cambio de sala.
      if (client.room) leaveRoom(client, 'cambió de');

      const holder = rooms.findByName(room, user);
      if (holder && holder !== client) {
        // Reanudación: el mismo navegador reconectó antes de que el servidor
        // detectara la caída de la conexión anterior. Si presenta el token de
        // esa conexión, se cierra la vieja y se le permite continuar.
        if (resumeToken && holder.resumeToken === resumeToken) {
          log(`${user} reanuda sesión; cerrando conexión anterior ${holder.id}`);
          rooms.leave(holder);
          holder.socket.terminate();
        } else {
          return sendError(client, ERROR_CODES.USERNAME_TAKEN, `"${user}" ya está en uso en #${room}.`);
        }
      }

      client.user = user;
      rooms.join(client, room);
      log(`${user} se unió a #${room} (${client.id})`);

      // Al recién llegado: historial reciente de la sala.
      send(client, SERVER_EVENTS.CHAT_HISTORY, { room, messages: rooms.history(room) });
      // A los demás: aviso de que alguien entró.
      rooms.broadcast(room, encode(SERVER_EVENTS.USER_JOIN, { user, room }), client);
      // A todos (incluido él): mensaje de sistema y lista de usuarios.
      rooms.broadcast(room, encode(SERVER_EVENTS.SYSTEM_INFO, systemInfo(`${user} se unió a la sala`)));
      publishUsers(room);
    },

    [CLIENT_EVENTS.CHAT_MESSAGE](client, { text }) {
      if (!client.room) {
        return sendError(client, ERROR_CODES.NOT_JOINED, 'Primero debe unirse a una sala (user:join).');
      }
      if (!client.rate.tryConsume()) {
        return sendError(
          client,
          ERROR_CODES.RATE_LIMITED,
          `Demasiados mensajes: máximo ${opts.RATE_LIMIT_MAX} cada ${opts.RATE_LIMIT_WINDOW_MS / 1000} s.`
        );
      }
      // El servidor asigna id y marca de tiempo: no se confía en el reloj del cliente.
      const message = {
        id: crypto.randomUUID(),
        user: client.user,
        text,
        ts: Date.now(),
        room: client.room,
      };
      rooms.remember(client.room, message);
      rooms.broadcast(client.room, encode(SERVER_EVENTS.CHAT_MESSAGE, message));
    },

    [CLIENT_EVENTS.USER_TYPING](client, { typing }) {
      if (!client.room) return; // se ignora en silencio: es un evento efímero
      rooms.broadcast(
        client.room,
        encode(SERVER_EVENTS.USER_TYPING, { user: client.user, typing }),
        client
      );
    },

    [CLIENT_EVENTS.USER_LEAVE](client) {
      if (!client.room) {
        return sendError(client, ERROR_CODES.NOT_JOINED, 'No está en ninguna sala.');
      }
      leaveRoom(client);
    },
  };

  // -------------------------------------------------------------------------
  // Ciclo de vida de cada conexión
  // -------------------------------------------------------------------------
  wss.on('connection', (socket, req) => {
    const ip = req.socket.remoteAddress;
    connectionsByIp.set(ip, (connectionsByIp.get(ip) || 0) + 1);

    const client = {
      id: crypto.randomUUID(),
      socket,
      ip,
      user: null,
      room: null,
      alive: true,
      // Token secreto que solo conoce este navegador; permite reanudar la sesión.
      resumeToken: crypto.randomBytes(18).toString('base64url'),
      rate: new SlidingWindowLimiter(opts.RATE_LIMIT_MAX, opts.RATE_LIMIT_WINDOW_MS),
    };
    clients.add(client);
    log(`conexión abierta ${client.id} desde ${ip} (total ${clients.size})`);

    send(client, SERVER_EVENTS.SYSTEM_WELCOME, {
      clientId: client.id,
      resumeToken: client.resumeToken,
      rooms: rooms.summary(),
      limits: { maxText: opts.MAX_TEXT_LENGTH, maxPayload: opts.MAX_PAYLOAD_BYTES },
    });

    // Heartbeat: el navegador responde automáticamente los ping con pong.
    socket.on('pong', () => {
      client.alive = true;
    });

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        return sendError(client, ERROR_CODES.BINARY_NOT_SUPPORTED, 'Solo se aceptan marcos de texto (JSON).');
      }
      const parsed = parseClientMessage(raw.toString('utf8'));
      if (!parsed.ok) {
        log(`mensaje rechazado de ${client.id}: ${parsed.error.code}`);
        return sendError(client, parsed.error.code, parsed.error.msg);
      }
      handlers[parsed.event](client, parsed.data);
    });

    socket.on('close', (code, reason) => {
      leaveRoom(client, 'se desconectó de');
      clients.delete(client);
      const n = (connectionsByIp.get(ip) || 1) - 1;
      if (n <= 0) connectionsByIp.delete(ip);
      else connectionsByIp.set(ip, n);
      log(`conexión cerrada ${client.id} código=${code} ${reason || ''} (total ${clients.size})`);
    });

    socket.on('error', (err) => {
      // Ej.: mensaje mayor a maxPayload => RangeError y cierre 1009.
      log(`error en ${client.id}: ${err.message}`);
    });
  });

  // Recorre los clientes; quien no respondió el ping anterior se da por muerto.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        log(`sin respuesta al ping, terminando ${client.id}`);
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, opts.HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  wss.on('close', () => clearInterval(heartbeat));

  return { wss, rooms, clients };
}

module.exports = { createChatServer };
