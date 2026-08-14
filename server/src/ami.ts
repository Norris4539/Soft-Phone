/**
 * Asterisk Manager Interface client.
 *
 * ARI covers channels and bridges well but exposes nothing about queues, which
 * is exactly what a switchboard dashboard needs: who is waiting, for how long,
 * and which agents are actually taking calls.  AMI is the only interface that
 * reports that, so both are used — AMI for queues, ARI for channels.
 *
 * The wire format is plain text: `Key: Value\r\n` repeated, terminated by a
 * blank line.  Small enough that a dependency would cost more than it saves.
 */

import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';

import { config } from './config.js';
import { log } from './logger.js';

export type AmiMessage = Record<string, string>;

interface Pending {
  resolve: (messages: AmiMessage[]) => void;
  reject: (error: Error) => void;
  /** Responses that stream events collect until the completion event. */
  collected: AmiMessage[];
  completionEvent?: string;
  timer: NodeJS.Timeout;
}

export declare interface AmiClient {
  on(event: 'event', listener: (message: AmiMessage) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: () => void): this;
  on(event: string, listener: (...args: never[]) => void): this;
}

export class AmiClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = '';
  private actionCounter = 0;
  private readonly pending = new Map<string, Pending>();
  private reconnectDelay = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private loggedIn = false;

  get connected(): boolean {
    return this.loggedIn;
  }

  connect(): void {
    if (this.closing) return;

    const socket = new Socket();
    this.socket = socket;
    this.buffer = '';

    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30_000);

    socket.on('data', (chunk: string) => this.onData(chunk));

    socket.on('error', (err) => {
      log.warn('AMI socket error', { error: err.message });
    });

    socket.on('close', () => {
      this.loggedIn = false;
      this.failAllPending(new Error('AMI connection closed'));
      this.emit('disconnected');
      if (!this.closing) this.scheduleReconnect();
    });

    socket.connect(config.ami.port, config.ami.host, () => {
      log.info('AMI connected', { host: config.ami.host, port: config.ami.port });
      void this.login();
    });
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // Asterisk may still be booting when we first try; back off rather than
    // hammering, but stay responsive once it is up.
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    log.info('AMI reconnecting', { inMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async login(): Promise<void> {
    try {
      await this.send('Login', {
        Username: config.ami.username,
        Secret: config.ami.password,
        Events: 'on',
      });
      this.loggedIn = true;
      this.reconnectDelay = 1000;
      log.info('AMI authenticated');
      this.emit('connected');
    } catch (err) {
      log.error('AMI login failed — check AMI_USERNAME/AMI_PASSWORD', { error: String(err) });
      this.socket?.destroy();
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;

    // Asterisk's greeting is a single line with no blank-line terminator.
    if (this.buffer.startsWith('Asterisk Call Manager')) {
      const end = this.buffer.indexOf('\r\n');
      if (end === -1) return;
      this.buffer = this.buffer.slice(end + 2);
    }

    let boundary = this.buffer.indexOf('\r\n\r\n');
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 4);
      if (block.trim().length > 0) this.dispatch(parseBlock(block));
      boundary = this.buffer.indexOf('\r\n\r\n');
    }
  }

  private dispatch(message: AmiMessage): void {
    const actionId = message['ActionID'];
    const pending = actionId ? this.pending.get(actionId) : undefined;

    if (pending) {
      pending.collected.push(message);

      // A list-style action answers with `Response: Success`, then one event
      // per row, then a completion event.  A simple action answers once.
      if (message['Response'] === 'Error') {
        this.settle(actionId!, pending, new Error(message['Message'] ?? 'AMI action failed'));
        return;
      }
      if (!pending.completionEvent) {
        if (message['Response']) this.settle(actionId!, pending);
        return;
      }
      if (message['Event'] === pending.completionEvent) {
        this.settle(actionId!, pending);
      }
      return;
    }

    if (message['Event']) this.emit('event', message);
  }

  private settle(actionId: string, pending: Pending, error?: Error): void {
    clearTimeout(pending.timer);
    this.pending.delete(actionId);
    if (error) pending.reject(error);
    else pending.resolve(pending.collected);
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  /**
   * Send an action.  Pass `completionEvent` for actions that answer with a
   * stream of events (QueueStatus, CoreShowChannels, ...) to collect the whole
   * list; omit it for one-shot actions.
   */
  send(
    action: string,
    params: Record<string, string> = {},
    completionEvent?: string,
    timeoutMs = 10_000,
  ): Promise<AmiMessage[]> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('AMI not connected'));
    }

    this.actionCounter += 1;
    const actionId = `sw-${Date.now()}-${this.actionCounter}`;

    return new Promise<AmiMessage[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject(new Error(`AMI action ${action} timed out`));
      }, timeoutMs);
      timer.unref();

      this.pending.set(actionId, { resolve, reject, collected: [], completionEvent, timer });

      const lines = [`Action: ${action}`, `ActionID: ${actionId}`];
      for (const [key, value] of Object.entries(params)) {
        // A newline in a value would let a caller inject a second action.
        lines.push(`${key}: ${String(value).replace(/[\r\n]/g, ' ')}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
  }
}

function parseBlock(block: string): AmiMessage {
  const message: AmiMessage = {};
  for (const line of block.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    // Repeated keys (Variable:, ChanVariable:) are joined rather than lost.
    message[key] = key in message ? `${message[key]},${value}` : value;
  }
  return message;
}

export const ami = new AmiClient();
