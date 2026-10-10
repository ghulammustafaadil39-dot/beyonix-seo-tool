/**
 * In-process fake servers for integration tests.
 *
 * - FakeSmtpCatcher: a minimal SMTP-protocol server (node:net) that captures
 *   every message sent through it. Point SMTP_HOST/SMTP_PORT at it and the
 *   backend's nodemailer transport delivers here instead of the network.
 *   Started once per test worker by tests/integration/setup.ts.
 * - FakeWebhookCatcher: a plain HTTP server that records every request it
 *   receives. Used to assert outbound webhook delivery (retries, replay).
 *
 * Both are hermetic: no external network, loopback only.
 */
import { createServer, type Server, type Socket } from 'node:net';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';

export interface CapturedEmail {
  from: string;
  to: string[];
  raw: string;
  subject: string;
}

export interface CapturedWebhook {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  receivedAt: number;
}

function parseSubject(raw: string): string {
  const m = raw.match(/^subject:\s*(.+)$/im);
  return m ? m[1].trim() : '';
}

/** Minimal SMTP server. Accepts anything; captures DATA payloads. */
export class FakeSmtpCatcher {
  readonly messages: CapturedEmail[] = [];
  private server: Server | null = null;

  private constructor() {}

  static async start(port: number): Promise<FakeSmtpCatcher> {
    const catcher = new FakeSmtpCatcher();
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => catcher.handleConnection(socket));
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        catcher.server = server;
        resolve();
      });
    });
    return catcher;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  clear(): void {
    this.messages.length = 0;
  }

  /** Poll until at least one message arrives or the timeout elapses. */
  async waitForMessage(timeoutMs = 5000): Promise<CapturedEmail> {
    const start = Date.now();
    for (;;) {
      if (this.messages.length > 0) return this.messages[this.messages.length - 1];
      if (Date.now() - start > timeoutMs) {
        throw new Error(`FakeSmtpCatcher: no message received within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private handleConnection(socket: Socket): void {
    socket.setEncoding('utf8');
    socket.write('220 localhost FakeSMTP\r\n');
    let buffer = '';
    let inData = false;
    let dataLines: string[] = [];
    let from = '';
    let to: string[] = [];

    const resetTx = () => {
      inData = false;
      dataLines = [];
      from = '';
      to = [];
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            const raw = dataLines.join('\r\n');
            this.messages.push({ from, to: [...to], raw, subject: parseSubject(raw) });
            resetTx();
            socket.write('250 2.0.0 OK: queued\r\n');
          } else {
            dataLines.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        const [verb, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        switch (verb.toUpperCase()) {
          case 'EHLO':
          case 'HELO':
            socket.write('250-localhost greets you\r\n250 AUTH PLAIN LOGIN\r\n');
            break;
          case 'AUTH':
            // Accept any credentials; this is a catcher, not a verifier.
            socket.write('235 2.7.0 Authentication successful\r\n');
            break;
          case 'MAIL': {
            const m = arg.match(/FROM:\s*<?([^>\s]+)>?/i);
            from = m ? m[1] : '';
            socket.write('250 2.1.0 OK\r\n');
            break;
          }
          case 'RCPT': {
            const m = arg.match(/TO:\s*<?([^>\s]+)>?/i);
            if (m) to.push(m[1]);
            socket.write('250 2.1.5 OK\r\n');
            break;
          }
          case 'DATA':
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
            break;
          case 'RSET':
            resetTx();
            socket.write('250 2.0.0 OK\r\n');
            break;
          case 'NOOP':
            socket.write('250 2.0.0 OK\r\n');
            break;
          case 'QUIT':
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
            break;
          default:
            socket.write('502 5.5.2 Command not implemented\r\n');
        }
      }
    });

    socket.on('error', () => {
      /* client went away; nothing to do */
    });
  }
}

/** Plain HTTP catcher: records every request, always answers 200 {ok:true}. */
export class FakeWebhookCatcher {
  readonly requests: CapturedWebhook[] = [];
  private server: HttpServer | null = null;

  private constructor() {}

  static async start(port: number): Promise<FakeWebhookCatcher> {
    const catcher = new FakeWebhookCatcher();
    await new Promise<void>((resolve, reject) => {
      const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
        let body = '';
        req.on('data', (c: Buffer) => {
          body += c.toString('utf8');
        });
        req.on('end', () => {
          catcher.requests.push({
            method: req.method ?? '',
            url: req.url ?? '',
            headers: req.headers,
            body,
            receivedAt: Date.now(),
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        catcher.server = server;
        resolve();
      });
    });
    return catcher;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  clear(): void {
    this.requests.length = 0;
  }

  async waitForRequest(timeoutMs = 5000): Promise<CapturedWebhook> {
    const start = Date.now();
    for (;;) {
      if (this.requests.length > 0) return this.requests[this.requests.length - 1];
      if (Date.now() - start > timeoutMs) {
        throw new Error(`FakeWebhookCatcher: no request received within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// ---- worker-scoped singletons (started by setup.ts) ----
let smtp: FakeSmtpCatcher | null = null;
let hook: FakeWebhookCatcher | null = null;

export function registerFakes(s: FakeSmtpCatcher, h: FakeWebhookCatcher): void {
  smtp = s;
  hook = h;
}

export function getSmtpCatcher(): FakeSmtpCatcher {
  if (!smtp) throw new Error('FakeSmtpCatcher not started — is setup.ts in setupFiles?');
  return smtp;
}

export function getWebhookCatcher(): FakeWebhookCatcher {
  if (!hook) throw new Error('FakeWebhookCatcher not started — is setup.ts in setupFiles?');
  return hook;
}

export async function stopFakes(): Promise<void> {
  await smtp?.stop();
  await hook?.stop();
  smtp = null;
  hook = null;
}
