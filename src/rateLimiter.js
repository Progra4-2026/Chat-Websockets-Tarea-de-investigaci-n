/**
 * rateLimiter.js
 * ---------------------------------------------------------------------------
 * Limitador de frecuencia por conexión con ventana deslizante.
 * Evita que un cliente inunde la sala (flood) o sature el servidor.
 */
'use strict';

class SlidingWindowLimiter {
  /**
   * @param {number} max       mensajes permitidos dentro de la ventana
   * @param {number} windowMs  tamaño de la ventana en milisegundos
   * @param {() => number} now función reloj (inyectable para pruebas)
   */
  constructor(max, windowMs, now = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = [];
  }

  /** Registra un intento. Devuelve true si se permite, false si excede el límite. */
  tryConsume() {
    const t = this.now();
    while (this.hits.length && t - this.hits[0] >= this.windowMs) this.hits.shift();
    if (this.hits.length >= this.max) return false;
    this.hits.push(t);
    return true;
  }
}

module.exports = { SlidingWindowLimiter };
