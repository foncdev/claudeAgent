import { WebSocket } from 'ws';
import { config } from './config.js';

/**
 * relay-service로 나가는 연결.
 *
 * 맥이 공유기 안에 있어도 서버가 먼저 닿을 필요가 없도록, 이쪽에서 붙는다.
 * 서버가 보내온 요청을 자기 REST API로 대신 호출해 결과를 돌려준다.
 */

/** 끊겼을 때 다시 붙기까지 기다리는 시간. 점점 늘려 서버를 두드리지 않는다. */
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

interface ServerMessage {
  type?: string;
  id?: string;
  method?: string;
  path?: string;
  body?: string;
  agentId?: string;
}

export class RelayLink {
  private socket?: WebSocket;
  private retryMs = RETRY_MIN_MS;
  private closed = false;
  /** 열려 있는 SSE 구독. 서버가 닫으라고 하면 끊는다. */
  private readonly streams = new Map<string, AbortController>();

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly name: string,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    for (const c of this.streams.values()) c.abort();
    this.streams.clear();
    this.socket?.close();
    this.socket = undefined;
  }

  private connect(): void {
    if (this.closed) return;

    const target = new URL(this.url);
    target.searchParams.set('name', this.name);
    if (this.token) target.searchParams.set('token', this.token);

    const socket = new WebSocket(target.toString());
    this.socket = socket;

    socket.on('open', () => {
      this.retryMs = RETRY_MIN_MS;
      console.log(`[relay-link] 연결됨: ${this.url}`);
    });

    socket.on('message', (data) => void this.handle(data.toString()));

    socket.on('close', () => {
      if (this.closed) return;
      console.log(`[relay-link] 끊김. ${Math.round(this.retryMs / 1000)}초 후 재시도`);
      setTimeout(() => this.connect(), this.retryMs).unref();
      // 계속 실패하면 간격을 늘린다.
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    });

    socket.on('error', (err) => {
      console.warn(`[relay-link] 오류: ${err.message}`);
      socket.close();
    });
  }

  /** 로컬 API 주소로 바꾼다. */
  private localUrl(path: string): string {
    return `http://127.0.0.1:${config.port}${path}`;
  }

  private headers(): Record<string, string> {
    return config.apiKey ? { 'x-api-key': config.apiKey } : {};
  }

  private async handle(raw: string): Promise<void> {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    if (msg.type === 'welcome') {
      console.log(`[relay-link] 등록 완료 (${msg.agentId?.slice(0, 8)})`);
      return;
    }

    if (msg.type === 'request' && msg.id && msg.method && msg.path) {
      await this.proxyRequest(msg.id, msg.method, msg.path, msg.body);
      return;
    }

    if (msg.type === 'stream_open' && msg.id && msg.path) {
      this.openStream(msg.id, msg.path);
      return;
    }

    if (msg.type === 'stream_close' && msg.id) {
      this.streams.get(msg.id)?.abort();
      this.streams.delete(msg.id);
    }
  }

  /** 서버가 넘긴 요청을 자기 API로 호출하고 결과를 돌려준다. */
  private async proxyRequest(
    id: string,
    method: string,
    path: string,
    body?: string,
  ): Promise<void> {
    try {
      const res = await fetch(this.localUrl(path), {
        method,
        headers: {
          ...this.headers(),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
      });
      this.send({
        type: 'response',
        id,
        status: res.status,
        body: await res.text(),
      });
    } catch (err) {
      this.send({ type: 'error', id, message: (err as Error).message });
    }
  }

  /** SSE를 열어 오는 대로 서버에 넘긴다. */
  private openStream(id: string, path: string): void {
    const controller = new AbortController();
    this.streams.set(id, controller);

    void (async () => {
      try {
        const res = await fetch(this.localUrl(path), {
          headers: this.headers(),
          signal: controller.signal,
        });
        if (!res.body) {
          this.send({ type: 'stream_chunk', id, chunk: '', done: true });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.send({
            type: 'stream_chunk',
            id,
            chunk: decoder.decode(value, { stream: true }),
            done: false,
          });
        }
        this.send({ type: 'stream_chunk', id, chunk: '', done: true });
      } catch {
        // 취소했거나 연결이 끊긴 경우다. 서버에 종료를 알린다.
        this.send({ type: 'stream_chunk', id, chunk: '', done: true });
      } finally {
        this.streams.delete(id);
      }
    })();
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      // 끊긴 연결은 close 처리에서 정리된다.
    }
  }
}
