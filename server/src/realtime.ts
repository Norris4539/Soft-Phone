/**
 * The dashboard's live feed.
 *
 * One WebSocket per open browser tab.  Each gets a full snapshot on connect
 * and a fresh one whenever the switchboard state changes — the snapshots are
 * small enough (tens of extensions, a handful of calls) that diffing them
 * would add failure modes without saving meaningful bandwidth.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

import { userFromToken } from './auth.js';
import { log } from './logger.js';
import { switchboard, type Snapshot } from './state.js';
import type { User } from './users.js';

interface Client {
  socket: WebSocket;
  user: User;
  alive: boolean;
}

const clients = new Set<Client>();

/**
 * Agents see presence and their own calls; only admins see every call on the
 * system. Filtering here rather than in the browser means an agent's client
 * never receives the data in the first place.
 */
function viewFor(user: User, snapshot: Snapshot): Snapshot {
  if (user.role === 'admin') return snapshot;

  return {
    ...snapshot,
    calls: snapshot.calls.filter((call) =>
      call.channels.some((channel) => channel.endpoint === user.extension),
    ),
    // Queue membership is useful to an agent (am I paused? how deep is the
    // line?) but the waiting callers' details are not theirs to browse.
    queues: snapshot.queues
      .filter((queue) => user.queues.some((q) => q.name === queue.name))
      .map((queue) => ({ ...queue, callers: queue.callers.map((c) => ({ ...c, callerName: '' })) })),
  };
}

function send(client: Client, type: string, payload: unknown): void {
  if (client.socket.readyState !== WebSocket.OPEN) return;
  client.socket.send(JSON.stringify({ type, payload }));
}

export function attachRealtime(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/events') {
      socket.destroy();
      return;
    }

    // The browser WebSocket API cannot set an Authorization header, so the
    // token travels as a query parameter.  It is short-lived and the
    // connection is WSS in any real deployment.
    const token = url.searchParams.get('token') ?? '';
    const user = token ? userFromToken(token) : null;

    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const client: Client = { socket: ws, user, alive: true };
      clients.add(client);
      log.info('dashboard connected', { extension: user.extension, clients: clients.size });

      send(client, 'snapshot', viewFor(user, switchboard.snapshot()));

      ws.on('pong', () => {
        client.alive = true;
      });
      ws.on('close', () => {
        clients.delete(client);
        log.info('dashboard disconnected', { extension: user.extension, clients: clients.size });
      });
      ws.on('error', (err) => {
        log.warn('dashboard socket error', { extension: user.extension, error: err.message });
      });
    });
  });

  switchboard.on('change', (snapshot: Snapshot) => {
    for (const client of clients) send(client, 'snapshot', viewFor(client.user, snapshot));
  });

  // A browser that goes to sleep or loses its network leaves a socket that
  // looks open forever; ping it and drop the ones that stop answering.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
}

export function connectedDashboards(): number {
  return clients.size;
}
