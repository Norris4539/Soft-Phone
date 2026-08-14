/**
 * Asterisk REST Interface client: a thin fetch wrapper for the REST side and a
 * reconnecting WebSocket for the event stream.
 *
 * The event socket subscribes with `subscribeAll=true`, which delivers events
 * for every channel on the system rather than only those handed to the Stasis
 * application.  That is what makes the dashboard a live view of the whole
 * switchboard without routing every call through Stasis — the dialplan stays
 * in charge of routing, and this only watches.
 */

import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import { config } from './config.js';
import { log } from './logger.js';

export interface AriChannel {
  id: string;
  name: string;
  state: string;
  caller: { name: string; number: string };
  connected: { name: string; number: string };
  dialplan: { context: string; exten: string; priority: number };
  creationtime: string;
  channelvars?: Record<string, string>;
}

export interface AriBridge {
  id: string;
  technology: string;
  bridge_type: string;
  channels: string[];
  creationtime: string;
}

export interface AriEndpoint {
  technology: string;
  resource: string;
  state: string;
  channel_ids: string[];
}

export interface AriEvent {
  type: string;
  application: string;
  timestamp: string;
  channel?: AriChannel;
  bridge?: AriBridge;
  endpoint?: AriEndpoint;
  [key: string]: unknown;
}

class AriError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AriError';
  }
}

export declare interface AriClient {
  on(event: 'event', listener: (event: AriEvent) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: () => void): this;
  on(event: string, listener: (...args: never[]) => void): this;
}

export class AriClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private ready = false;

  private readonly authHeader =
    'Basic ' + Buffer.from(`${config.ari.username}:${config.ari.password}`).toString('base64');

  get connected(): boolean {
    return this.ready;
  }

  // --- REST ----------------------------------------------------------------
  async request<T>(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    path: string,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(`${config.ari.url}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      method,
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AriError(`ARI ${method} ${path} -> ${response.status} ${body}`.trim(), response.status);
    }

    // DELETE and some POSTs answer 204 with no body.
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  listChannels(): Promise<AriChannel[]> {
    return this.request<AriChannel[]>('GET', '/channels');
  }

  listBridges(): Promise<AriBridge[]> {
    return this.request<AriBridge[]>('GET', '/bridges');
  }

  listEndpoints(): Promise<AriEndpoint[]> {
    return this.request<AriEndpoint[]>('GET', '/endpoints');
  }

  hangup(channelId: string, reason = 'normal'): Promise<void> {
    return this.request<void>('DELETE', `/channels/${encodeURIComponent(channelId)}`, { reason });
  }

  /** Blind transfer: move a live channel to another dialplan destination. */
  redirect(channelId: string, context: string, extension: string): Promise<void> {
    return this.request<void>('POST', `/channels/${encodeURIComponent(channelId)}/redirect`, {
      endpoint: `PJSIP/${extension}`,
      context,
      extension,
      priority: '1',
    });
  }

  continueInDialplan(
    channelId: string,
    context: string,
    extension: string,
    priority = 1,
  ): Promise<void> {
    return this.request<void>('POST', `/channels/${encodeURIComponent(channelId)}/continue`, {
      context,
      extension,
      priority: String(priority),
    });
  }

  // --- Events --------------------------------------------------------------
  connect(): void {
    if (this.closing) return;

    const base = config.ari.url.replace(/^http/, 'ws');
    const url = new URL(`${base}/events`);
    url.searchParams.set('app', config.ari.app);
    // Without this we would only see channels explicitly handed to Stasis.
    url.searchParams.set('subscribeAll', 'true');
    url.searchParams.set('api_key', `${config.ari.username}:${config.ari.password}`);

    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.on('open', () => {
      this.ready = true;
      this.reconnectDelay = 1000;
      log.info('ARI event stream connected', { app: config.ari.app });
      this.emit('connected');
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        this.emit('event', JSON.parse(raw.toString()) as AriEvent);
      } catch (err) {
        log.warn('unparseable ARI event', { error: String(err) });
      }
    });

    socket.on('error', (err: Error) => {
      log.warn('ARI socket error', { error: err.message });
    });

    socket.on('close', () => {
      this.ready = false;
      this.emit('disconnected');
      if (!this.closing) this.scheduleReconnect();
    });
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    log.info('ARI reconnecting', { inMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export const ari = new AriClient();
