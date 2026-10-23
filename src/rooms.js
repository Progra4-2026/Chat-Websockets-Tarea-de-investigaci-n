/**
 * rooms.js
 * ---------------------------------------------------------------------------
 * Administra las salas (rooms): qué clientes hay en cada una, el historial
 * reciente de mensajes y el envío a todos los miembros (broadcast).
 *
 * Cada cliente conectado se representa con un objeto "client":
 *   { id, socket, user, room, ip, rate }
 */
'use strict';

const { WebSocket } = require('ws');
const config = require('./config');

class RoomManager {
  constructor(roomNames, historySize = config.HISTORY_SIZE) {
    this.historySize = historySize;
    /** @type {Map<string, {members:Set<object>, history:object[]}>} */
    this.rooms = new Map();
    for (const name of roomNames) {
      this.rooms.set(name, { members: new Set(), history: [] });
    }
  }

  /** Nombres de usuario activos en una sala, ordenados alfabéticamente. */
  usersIn(roomName) {
    const room = this.rooms.get(roomName);
    if (!room) return [];
    return [...room.members].map((c) => c.user).sort((a, b) => a.localeCompare(b, 'es'));
  }

  /** Busca en la sala un cliente con ese nombre (sin distinguir mayúsculas). */
  findByName(roomName, user) {
    const room = this.rooms.get(roomName);
    if (!room) return null;
    const target = user.toLocaleLowerCase('es');
    return [...room.members].find((c) => c.user.toLocaleLowerCase('es') === target) || null;
  }

  /** ¿Ya hay alguien con ese nombre en la sala? */
  isNameTaken(roomName, user) {
    return this.findByName(roomName, user) !== null;
  }

  join(client, roomName) {
    const room = this.rooms.get(roomName);
    room.members.add(client);
    client.room = roomName;
  }

  /** Saca al cliente de su sala. Devuelve el nombre de la sala que abandonó. */
  leave(client) {
    const roomName = client.room;
    if (!roomName) return null;
    const room = this.rooms.get(roomName);
    if (room) room.members.delete(client);
    client.room = null;
    return roomName;
  }

  /** Guarda un mensaje en el historial circular de la sala. */
  remember(roomName, message) {
    const room = this.rooms.get(roomName);
    room.history.push(message);
    if (room.history.length > this.historySize) room.history.shift();
  }

  history(roomName) {
    return [...(this.rooms.get(roomName)?.history || [])];
  }

  /**
   * Envía un texto ya serializado a todos los miembros de la sala.
   * @param {string} roomName
   * @param {string} payload   mensaje JSON serializado
   * @param {object} [except]  cliente que no debe recibirlo (p. ej. el emisor)
   */
  broadcast(roomName, payload, except = null) {
    const room = this.rooms.get(roomName);
    if (!room) return 0;
    let sent = 0;
    for (const member of room.members) {
      if (member === except) continue;
      if (member.socket.readyState === WebSocket.OPEN) {
        member.socket.send(payload);
        sent++;
      }
    }
    return sent;
  }

  /** Resumen de ocupación de cada sala (para el evento system:welcome). */
  summary() {
    return [...this.rooms.entries()].map(([name, r]) => ({ name, users: r.members.size }));
  }
}

module.exports = { RoomManager };
