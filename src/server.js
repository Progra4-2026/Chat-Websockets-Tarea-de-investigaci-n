/**
 * server.js
 * ---------------------------------------------------------------------------
 * Punto de entrada. Levanta un único servidor HTTP (o HTTPS si hay
 * certificados) que:
 *   - sirve los archivos estáticos del cliente desde /public
 *   - expone GET /health para monitoreo
 *   - acepta el "Upgrade: websocket" en /ws (ver chatServer.js)
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const config = require('./config');
const { createChatServer } = require('./chatServer');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** Encabezados de seguridad para las respuestas HTTP del cliente. */
const SECURITY_HEADERS = {
  // Solo se permite conectar (connect-src) al propio servidor por ws/wss.
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Sirve un archivo de /public evitando recorrer directorios (path traversal). */
function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === '/') filePath = '/index.html';

  const resolved = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No encontrado');
      return;
    }
    const type = MIME[path.extname(resolved)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(content);
  });
}

function requestHandler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }
  serveStatic(req, res);
}

/** Crea el servidor HTTP/HTTPS y engancha el WebSocket. Exportado para pruebas. */
function createApp(options = {}) {
  const useTls = Boolean(config.TLS_CERT && config.TLS_KEY);
  const server = useTls
    ? https.createServer(
        { cert: fs.readFileSync(config.TLS_CERT), key: fs.readFileSync(config.TLS_KEY) },
        requestHandler
      )
    : http.createServer(requestHandler);
  const chat = createChatServer(server, options);
  return { server, ...chat, useTls };
}

if (require.main === module) {
  const { server, clients, wss, useTls } = createApp();
  server.listen(config.PORT, config.HOST, () => {
    const http_ = useTls ? 'https' : 'http';
    const ws_ = useTls ? 'wss' : 'ws';
    console.log('──────────────────────────────────────────────');
    console.log(' SalaUNA · chat en tiempo real con WebSockets');
    console.log(` Cliente:   ${http_}://localhost:${config.PORT}`);
    console.log(` Endpoint:  ${ws_}://localhost:${config.PORT}${config.WS_PATH}`);
    console.log(` Orígenes permitidos: ${config.ALLOWED_ORIGINS.join(', ')}`);
    console.log('──────────────────────────────────────────────');
  });

  // Cierre ordenado con Ctrl+C: avisa a los clientes con código 1001 (Going Away).
  process.on('SIGINT', () => {
    console.log('\nCerrando servidor...');
    for (const c of clients) c.socket.close(1001, 'Servidor detenido');
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

module.exports = { createApp };
