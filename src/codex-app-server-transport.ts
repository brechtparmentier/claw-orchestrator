/**
 * Shared newline-delimited JSON-RPC transport for `codex app-server`.
 *
 * This class deliberately knows nothing about threads, turns, accounts, or
 * quota. Protocol consumers own those concerns and receive notifications via
 * callbacks. Keeping the transport generic lets account-level read operations
 * share the same tested process/plumbing as persistent Codex sessions.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

export interface CodexAppServerMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface CodexAppServerTransportOptions {
  codexBin?: string;
  args?: string[];
  cwd?: string;
  onMessage?: (message: CodexAppServerMessage) => void;
  onNotification?: (method: string, params: unknown) => void;
  onStderr?: (text: string) => void;
  onUnparsedStdout?: (text: string) => void;
  onExit?: (code: number | null) => void;
}

export class CodexAppServerTransport extends EventEmitter {
  private proc: ChildProcess | null = null;
  private lineReader: readline.Interface | null = null;
  private nextRpcId = 1;
  private pendingRequests = new Map<number, PendingRequest>();

  constructor(private readonly options: CodexAppServerTransportOptions = {}) {
    super();
  }

  get pid(): number | undefined {
    return this.proc?.pid ?? undefined;
  }

  get nextRequestId(): number {
    return this.nextRpcId;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  start(): void {
    if (this.proc) return;

    const codexBin = this.options.codexBin || process.env.CODEX_BIN || 'codex';
    const args = this.options.args ?? ['app-server', '--listen', 'stdio://'];
    const proc = spawn(codexBin, args, {
      cwd: this.options.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    this.lineReader = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    this.lineReader.on('line', (line) => this.handleLine(line));
    proc.stderr?.on('data', (data: Buffer) => this.options.onStderr?.(data.toString()));

    proc.on('error', (error) => {
      this.rejectPending(error);
      this.emit('error', error);
    });
    proc.on('exit', (code) => {
      this.rejectPending(new Error(`codex app-server exited (code=${code}) before responding`));
      this.proc = null;
      this.options.onExit?.(code);
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error('codex app-server stdin not writable'));
    }
    const id = this.nextRpcId++;
    // Codex follows JSON-RPC 2.0 semantics but its documented wire format
    // omits the `jsonrpc` header.
    const message = JSON.stringify({ id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
      this.proc!.stdin!.write(message, (error) => {
        if (error) {
          this.pendingRequests.delete(id);
          reject(error);
        }
      });
    });
  }

  stop(): void {
    this.lineReader?.close();
    this.lineReader = null;
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // Process already exited.
      }
      this.proc = null;
    }
    this.rejectPending(new Error('codex app-server transport stopped'));
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: CodexAppServerMessage;
    try {
      message = JSON.parse(trimmed) as CodexAppServerMessage;
    } catch {
      this.options.onUnparsedStdout?.(trimmed);
      return;
    }

    this.options.onMessage?.(message);
    if (typeof message.id === 'number' && message.method === undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${message.error.message ?? 'unknown error'}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) this.options.onNotification?.(message.method, message.params);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
  }
}
