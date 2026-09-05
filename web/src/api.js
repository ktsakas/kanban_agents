const base = '/api';

async function request(path, options = {}) {
  const res = await fetch(base + path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

export const api = {
  board: () => request('/board'),
  updateSettings: (patch) => request('/settings', { method: 'PATCH', body: patch }),

  createCard: (card) => request('/cards', { method: 'POST', body: card }),
  updateCard: (id, patch) => request(`/cards/${id}`, { method: 'PATCH', body: patch }),
  deleteCard: (id) => request(`/cards/${id}`, { method: 'DELETE' }),
  moveCard: (id, column, index) => request(`/cards/${id}/move`, { method: 'POST', body: { column, index } }),

  events: (id) => request(`/cards/${id}/events`),
  reply: (id, text) => request(`/cards/${id}/reply`, { method: 'POST', body: { text } }),
  permission: (id, requestId, decision, text) =>
    request(`/cards/${id}/permission`, { method: 'POST', body: { requestId, decision, text } }),
  stop: (id) => request(`/cards/${id}/stop`, { method: 'POST' }),
  reset: (id) => request(`/cards/${id}/reset`, { method: 'POST' }),

  pauseQueue: () => request('/queue/pause', { method: 'POST' }),
  resumeQueue: () => request('/queue/resume', { method: 'POST' }),

  dirs: (path) => request(`/fs/dirs?path=${encodeURIComponent(path ?? '')}`),
};

/** Subscribe to a server-sent event stream; returns an unsubscribe function. */
export function subscribe(path, onMessage) {
  const source = new EventSource(base + path);
  source.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data));
    } catch {
      /* ignore malformed frames */
    }
  };
  return () => source.close();
}
