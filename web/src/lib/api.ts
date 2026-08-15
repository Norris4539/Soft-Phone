/** Typed client for the control server. */

import { apiBase, isDemo } from './backend';

export interface PublicUser {
  extension: string;
  name: string;
  role: 'agent' | 'admin';
  groups: string[];
  queues: { name: string; penalty: number }[];
  email?: string;
  did?: string;
}

export interface DirectoryEntry extends PublicUser {
  status: 'available' | 'ringing' | 'busy' | 'onhold' | 'offline' | 'unknown';
  onCall: boolean;
}

export interface PhoneConfigResponse {
  sip: {
    websocketUrl: string;
    domain: string;
    extension: string;
    username: string;
    password: string;
    displayName: string;
  };
  ice: { iceServers: RTCIceServer[] };
  switchboard: { mainDid: string; operatorExtension: string };
}

export interface TrackedChannel {
  id: string;
  name: string;
  endpoint: string;
  external: boolean;
  state: string;
  callerNumber: string;
  callerName: string;
  connectedNumber: string;
  connectedName: string;
  context: string;
  exten: string;
  bridgeId: string | null;
  startedAt: string;
}

export interface ActiveCall {
  id: string;
  bridged: boolean;
  startedAt: string;
  channels: TrackedChannel[];
}

export interface QueueSnapshot {
  name: string;
  callers: {
    channelId: string;
    position: number;
    callerNumber: string;
    callerName: string;
    waitSeconds: number;
  }[];
  members: {
    extension: string;
    name: string;
    status: string;
    paused: boolean;
    callsTaken: number;
    lastCall: number;
  }[];
  completed: number;
  abandoned: number;
}

export interface Snapshot {
  updatedAt: string;
  sources: { ari: boolean; ami: boolean };
  extensions: {
    extension: string;
    name: string;
    role: string;
    status: DirectoryEntry['status'];
    registered: boolean;
    channelIds: string[];
  }[];
  calls: ActiveCall[];
  queues: QueueSnapshot[];
}

const TOKEN_KEY = 'softphone.token';

export function storedToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Demo mode never reaches the network — there is no backend to reach.
  if (isDemo()) return demoRequest<T>(path, init);

  const token = storedToken();

  const response = await fetch(`${apiBase()}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (response.status === 401) {
    // The token has expired or been invalidated; drop it so the app falls
    // back to the login screen instead of retrying forever.
    clearToken();
    throw new ApiError('Your session has expired. Please sign in again.', 401);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `Request failed (${response.status})`, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Demo routing. Kept beside `request` so the two cannot drift: every endpoint
 * the app calls has to be answered here too, or the demo breaks loudly rather
 * than silently returning undefined.
 */
async function demoRequest<T>(path: string, init: RequestInit): Promise<T> {
  const demo = await import('./demo');
  // A little latency, so loading states are exercised rather than skipped.
  await new Promise((resolve) => setTimeout(resolve, 120));

  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};

  if (path === '/auth/login') return demo.demoLogin(String(body['extension'] ?? '101')) as T;
  if (path === '/auth/me') return demo.demoMe() as T;
  if (path === '/config') return demo.demoPhoneConfig() as T;
  if (path === '/directory') return demo.demoDirectory() as T;
  if (path === '/state') return demo.demoSnapshot() as T;
  // Operator actions: accept and do nothing, as a 204 would.
  if (path.startsWith('/calls/') || path.startsWith('/queues/')) return undefined as T;

  throw new ApiError(`demo mode has no handler for ${path}`, 501);
}

export const api = {
  login(extension: string, password: string) {
    return request<{ token: string; user: PublicUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ extension, password }),
    });
  },

  me() {
    return request<{ user: PublicUser }>('/auth/me');
  },

  phoneConfig() {
    return request<PhoneConfigResponse>('/config');
  },

  directory() {
    return request<{
      users: DirectoryEntry[];
      ringGroups: Record<string, { description?: string }>;
      queues: Record<string, { description?: string }>;
    }>('/directory');
  },

  state() {
    return request<Snapshot>('/state');
  },

  hangupChannel(channelId: string) {
    return request<void>(`/calls/${encodeURIComponent(channelId)}/hangup`, { method: 'POST' });
  },

  transferChannel(channelId: string, extension: string) {
    return request<void>(`/calls/${encodeURIComponent(channelId)}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ extension }),
    });
  },

  originate(from: string, to: string) {
    return request<{ status: string }>('/calls/originate', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    });
  },

  setQueuePause(queue: string, extension: string, paused: boolean) {
    return request<void>(
      `/queues/${encodeURIComponent(queue)}/members/${encodeURIComponent(extension)}/pause`,
      { method: 'POST', body: JSON.stringify({ paused }) },
    );
  },
};

/**
 * Live state feed. Reconnects on its own: a dashboard left open overnight
 * should still be correct in the morning.
 */
export function openEventStream(onSnapshot: (snapshot: Snapshot) => void): () => void {
  // No socket in demo mode; poll the canned snapshot so the durations tick.
  if (isDemo()) {
    let stopped = false;
    void import('./demo').then((demo) => {
      const push = () => {
        if (!stopped) onSnapshot(demo.demoSnapshot());
      };
      push();
      const timer = window.setInterval(push, 2000);
      cleanupDemo = () => {
        stopped = true;
        window.clearInterval(timer);
      };
    });
    let cleanupDemo = () => {
      stopped = true;
    };
    return () => cleanupDemo();
  }

  let socket: WebSocket | null = null;
  let retryDelay = 1000;
  let retryTimer: number | undefined;
  let closed = false;

  const connect = () => {
    const token = storedToken();
    if (!token || closed) return;

    // Same origin normally; an explicit base when the bundle is served by a
    // static host that has no /api to proxy.
    const base = apiBase();
    const origin = base
      ? base.replace(/^http/, 'ws')
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

    socket = new WebSocket(`${origin}/api/events?token=${encodeURIComponent(token)}`);

    socket.addEventListener('open', () => {
      retryDelay = 1000;
    });

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data as string) as { type: string; payload: Snapshot };
        if (message.type === 'snapshot') onSnapshot(message.payload);
      } catch {
        // A malformed frame is not worth tearing the connection down for.
      }
    });

    socket.addEventListener('close', () => {
      if (closed) return;
      retryTimer = window.setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    });
  };

  connect();

  return () => {
    closed = true;
    if (retryTimer) window.clearTimeout(retryTimer);
    socket?.close();
  };
}
