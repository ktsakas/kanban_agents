import { EventEmitter } from 'node:events';

/**
 * Single in-process fan-out for SSE clients. Two channels:
 *   board  — card/settings/queue changes (small, sent to everyone)
 *   card:<id> — transcript events for one session (only sent to subscribers)
 */
class Bus extends EventEmitter {}

export const bus = new Bus();
bus.setMaxListeners(0);

export function emitBoard(payload) {
  bus.emit('board', payload);
}

export function emitCardEvent(cardId, event) {
  bus.emit(`card:${cardId}`, event);
}
