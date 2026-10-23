/**
 * config.js
 * ---------------------------------------------------------------------------
 * Configuración centralizada del servidor. Todos los valores pueden
 * sobreescribirse con variables de entorno para no tocar el código.
 *
 *   PORT=4000 ALLOWED_ORIGINS=http://localhost:4000 npm start
 */
'use strict';

const PORT = Number(process.env.PORT) || 3000;

// Orígenes que pueden abrir el WebSocket. Si un navegador envía un
// encabezado Origin distinto, el handshake se rechaza con 403
// (protección contra Cross-Site WebSocket Hijacking).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  `http://localhost:${PORT},http://127.0.0.1:${PORT}`)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

module.exports = Object.freeze({
  PORT,
  HOST: process.env.HOST || '0.0.0.0',
  ALLOWED_ORIGINS,

  // Permitir clientes sin encabezado Origin (wscat, scripts). Desactivado por defecto.
  ALLOW_NO_ORIGIN: process.env.ALLOW_NO_ORIGIN === 'true',

  // Ruta del endpoint WebSocket: ws://localhost:3000/ws
  WS_PATH: '/ws',

  // TLS opcional: si se indican certificado y llave se levanta HTTPS + wss://
  TLS_CERT: process.env.TLS_CERT || '',
  TLS_KEY: process.env.TLS_KEY || '',

  // Tamaño máximo de un mensaje recibido (bytes). Mensajes más grandes
  // provocan el cierre de la conexión con el código 1009 (Message Too Big).
  MAX_PAYLOAD_BYTES: 4 * 1024,

  // Salas disponibles. El cliente solo puede unirse a alguna de estas.
  ROOMS: ['general', 'programacion-4', 'proyectos'],

  // Reglas de validación del esquema de mensajes.
  USERNAME_PATTERN: /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9_ .-]{2,20}$/,
  MAX_TEXT_LENGTH: 500,

  // Persistencia ligera: últimos N mensajes por sala guardados en memoria.
  HISTORY_SIZE: 50,

  // Control de frecuencia: máximo N mensajes por ventana de tiempo (ms).
  RATE_LIMIT_MAX: 5,
  RATE_LIMIT_WINDOW_MS: 3000,

  // Máximo de conexiones simultáneas por dirección IP (mitigación DoS).
  MAX_CONNECTIONS_PER_IP: 10,

  // Cada cuánto el servidor envía un ping de protocolo (frame 0x9) para
  // detectar conexiones muertas (cliente que perdió la red sin cerrar).
  HEARTBEAT_INTERVAL_MS: 30000,
});
