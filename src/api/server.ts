import path from 'node:path';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { config, isLoopback } from '../core/config.js';
import { JobManager } from '../core/manager.js';
import { WorkspaceRegistry, WorkspaceError } from '../core/workspaces.js';
import {
  createJobSchema,
  createSessionSchema,
  createWorkspaceSchema,
  deleteFileSchema,
  internalPermissionSchema,
  listFilesSchema,
  listJobsSchema,
  mkdirSchema,
  readFileSchema,
  readHistorySchema,
  renameFileSchema,
  resolvePermissionSchema,
  resumeSessionSchema,
  sendInputSchema,
  updatePolicySchema,
  updateSessionSchema,
  writeFileSchema,
} from './schemas.js';
import { SessionRegistry, SessionError } from '../core/sessions.js';
import type { SessionEvent } from '../core/session.js';
import type { JobEvent } from '../core/types.js';
import * as files from '../core/files.js';
import { history } from '../core/history.js';

/**
 * Express 4는 async 핸들러의 rejection을 잡지 못한다.
 * 래핑해서 오류 미들웨어로 넘긴다.
 */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** 길이가 달라도 던지지 않는 상수 시간 비교. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createServer(): {
  app: express.Express;
  manager: JobManager;
  sessions: SessionRegistry;
} {
  const workspaces = new WorkspaceRegistry();
  const manager = new JobManager(workspaces);
  const sessions = new SessionRegistry(workspaces);
  const app = express();

  app.use(express.json({ limit: '5mb' }));

  /**
   * 브라우저에서 오는 요청을 막는다.
   *
   * 이 매니저는 명령을 실행한다. 예전에는 요청한 오리진을 그대로 허용해,
   * 키가 없으면 사용자가 연 아무 웹페이지나 127.0.0.1:4000으로 세션을
   * 만들고 명령을 돌릴 수 있었다. 정상 호출자(relay-link, client.ts, 권한
   * MCP 서버)는 브라우저가 아니라 Origin을 싣지 않으므로, Origin이 있는데
   * 허용 목록에 없으면 거절한다.
   */
  app.use((req, res, next) => {
    const origin = req.header('origin');
    if (origin) {
      if (!config.corsOrigins.includes(origin)) {
        res.status(403).json({
          error: {
            code: 'origin_not_allowed',
            message: `허용되지 않은 오리진: ${origin} (AGENT_CORS_ORIGINS에 추가)`,
          },
        });
        return;
      }
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.header('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
    }
    next();
  });

  /**
   * 키가 없을 때는 이 기기 주소로 온 요청만 받는다.
   *
   * DNS 리바인딩은 공격자 도메인을 127.0.0.1로 바꿔 같은 오리진인 척하므로
   * Origin 검사를 지나간다. 그때 Host는 공격자 도메인으로 남는다.
   */
  app.use((req, res, next) => {
    if (config.apiKey) return next();
    const host = (req.header('host') ?? '').replace(/:\d+$/, '');
    if (!isLoopback(host)) {
      res.status(403).json({
        error: { code: 'host_not_allowed', message: 'AGENT_API_KEY 없이는 이 기기 주소로만 접속할 수 있습니다.' },
      });
      return;
    }
    next();
  });

  /** API 경로만 인증한다. UI 정적 파일은 열어둬야 페이지가 뜬다. */
  const isApiPath = (p: string): boolean =>
    /^\/(workspaces|jobs|sessions|internal)\b/.test(p);

  // API 키가 설정된 경우에만 인증을 강제한다. 헬스체크는 열어둔다.
  // 권한 MCP 서버는 API 키 대신 세션 전용 키를 쓴다. 아래 /internal/permission에서 본다.
  app.use((req, res, next) => {
    if (req.path === '/internal/permission') return next();
    if (!config.apiKey || req.path === '/health' || !isApiPath(req.path)) return next();
    // EventSource는 헤더를 못 붙이므로 SSE 경로에 한해 쿼리 키를 받는다.
    const isStream = req.path.endsWith('/stream');
    const provided =
      req.header('x-api-key') ?? (isStream ? (req.query.apiKey as string | undefined) : undefined);
    if (!sameSecret(provided ?? '', config.apiKey)) {
      res.status(401).json({
        error: {
          code: 'unauthorized',
          message: provided
            ? 'x-api-key가 서버의 AGENT_API_KEY와 일치하지 않습니다.'
            : 'x-api-key 헤더가 없습니다. 클라이언트 쪽에도 AGENT_API_KEY를 설정하세요 (.env 또는 export).',
        },
      });
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version: '0.1.0',
      allowedRoots: config.allowedRoots,
      ...manager.stats(),
    });
  });

  // --- 워크스페이스 ---

  app.get('/workspaces', (_req, res) => {
    res.json({ workspaces: workspaces.list() });
  });

  app.post('/workspaces', (req, res) => {
    const body = createWorkspaceSchema.parse(req.body);
    res.status(201).json({ workspace: workspaces.register(body) });
  });

  app.get('/workspaces/:id', (req, res) => {
    const ws = workspaces.get(req.params.id);
    if (!ws) {
      res.status(404).json({ error: { code: 'workspace_not_found', message: '없는 워크스페이스' } });
      return;
    }
    res.json({ workspace: ws });
  });

  app.delete('/workspaces/:id', (req, res) => {
    const ok = workspaces.remove(req.params.id);
    res.status(ok ? 204 : 404).end();
  });

  // --- 파일 관리 (워크스페이스 내부 한정) ---

  app.get('/workspaces/:id/files', (req, res) => {
    const ws = workspaces.require(req.params.id);
    const { path: rel, hidden } = listFilesSchema.parse(req.query);
    res.json({ path: rel ?? '', entries: files.list(ws, rel ?? '', hidden) });
  });

  app.get('/workspaces/:id/file', (req, res) => {
    const ws = workspaces.require(req.params.id);
    const { path: rel } = readFileSchema.parse(req.query);
    res.json({ file: files.read(ws, rel) });
  });

  app.put('/workspaces/:id/file', (req, res) => {
    const ws = workspaces.require(req.params.id);
    const { path: rel, content } = writeFileSchema.parse(req.body);
    res.json({ file: files.write(ws, rel, content) });
  });

  app.post('/workspaces/:id/mkdir', (req, res) => {
    const ws = workspaces.require(req.params.id);
    const { path: rel } = mkdirSchema.parse(req.body);
    res.status(201).json(files.mkdir(ws, rel));
  });

  app.post('/workspaces/:id/rename', (req, res) => {
    const ws = workspaces.require(req.params.id);
    const { from, to } = renameFileSchema.parse(req.body);
    res.json(files.rename(ws, from, to));
  });

  app.delete('/workspaces/:id/file', (req, res) => {
    const ws = workspaces.require(req.params.id);
    const { path: rel, recursive } = deleteFileSchema.parse(req.query);
    files.remove(ws, rel, recursive);
    res.status(204).end();
  });

  /** 바이너리/대용량 파일은 이 경로로 원본을 내려받는다. */
  app.get('/workspaces/:id/download', (req, res) => {
    const ws = workspaces.require(req.params.id);
    const { path: rel } = readFileSchema.parse(req.query);
    const abs = files.resolveInWorkspace(ws, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.status(404).json({ error: { code: 'file_not_found', message: `파일 없음: ${rel}` } });
      return;
    }
    res.download(abs, path.basename(abs));
  });

  // --- 잡 ---

  app.post(
    '/jobs',
    asyncHandler(async (req, res) => {
      const { wait, ...input } = createJobSchema.parse(req.body);
      const job = manager.create(input);

      if (!wait) {
        res.status(202).json({ job });
        return;
      }
      const final = await manager.wait(job.id);
      res.status(200).json({ job: final ?? job });
    }),
  );

  app.get('/jobs', (req, res) => {
    const filter = listJobsSchema.parse(req.query);
    res.json({ jobs: manager.list(filter) });
  });

  app.get('/jobs/:id', (req, res) => {
    const job = manager.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: { code: 'job_not_found', message: '없는 잡' } });
      return;
    }
    res.json({ job });
  });

  app.post('/jobs/:id/cancel', (req, res) => {
    const ok = manager.cancel(req.params.id);
    if (!ok) {
      res.status(409).json({
        error: { code: 'cannot_cancel', message: '없는 잡이거나 이미 종료되었습니다.' },
      });
      return;
    }
    res.json({ job: manager.get(req.params.id) });
  });

  app.get('/jobs/:id/stream', (req, res) => {
    const job = manager.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: { code: 'job_not_found', message: '없는 잡' } });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 프록시가 SSE를 버퍼링하지 않도록 한다.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const send = (event: JobEvent): void => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'result') res.end();
    };

    const unsubscribe = manager.subscribe(req.params.id, send);
    if (!unsubscribe) {
      res.end();
      return;
    }

    // 유휴 연결이 중간 장비에서 끊기지 않게 주기적으로 주석을 보낸다.
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
    const cleanup = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  // --- 세션 (대화형) ---

  app.post('/sessions', (req, res) => {
    const input = createSessionSchema.parse(req.body);
    const session = sessions.create(input);
    res.status(201).json({ session: session.info() });
  });

  /**
   * 살아있는 세션과 저장된 이력을 합쳐서 돌려준다.
   * live=true인 항목만 입력을 받을 수 있다.
   */
  app.get('/sessions', (_req, res) => {
    const live = sessions.list();
    const liveIds = new Set(live.map((s) => s.id));
    const archived = history
      .listMeta()
      .filter((m) => !liveIds.has(m.id))
      .map((m) => ({ ...m, live: false, status: m.status === 'closed' ? m.status : 'closed' }));
    res.json({
      sessions: [...live.map((s) => ({ ...s, live: true })), ...archived],
    });
  });

  /** 저장된 대화 이력. 새로고침 후 화면 복원에 쓴다. */
  app.get('/sessions/:id/history', (req, res) => {
    const { limit } = readHistorySchema.parse(req.query);
    const events = history.read(req.params.id, limit);
    const meta = history.readMeta(req.params.id);
    if (events.length === 0 && !meta && !sessions.get(req.params.id)) {
      res.status(404).json({ error: { code: 'session_not_found', message: '없는 세션' } });
      return;
    }
    res.json({ events, meta });
  });

  app.patch('/sessions/:id', (req, res) => {
    const { title } = updateSessionSchema.parse(req.body);
    const session = sessions.get(req.params.id);
    if (session) {
      session.setTitle(title);
      res.json({ session: session.info() });
      return;
    }
    // 종료된 세션이라도 제목은 바꿀 수 있게 한다.
    const meta = history.readMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: { code: 'session_not_found', message: '없는 세션' } });
      return;
    }
    history.writeMeta({ ...meta, title });
    res.json({ session: { ...meta, title } });
  });

  /**
   * 종료된 세션의 대화를 이어간다.
   * 새 세션이 생기고, CLI 쪽 맥락은 --resume으로 복원된다.
   */
  app.post('/sessions/:id/resume', (req, res) => {
    const options = resumeSessionSchema.parse(req.body ?? {});
    const session = sessions.resume(req.params.id, options);
    res.status(201).json({
      session: { ...session.info(), live: true },
      // 클라이언트가 "원본도 지웠다"고 정확히 안내할 수 있게 알려준다.
      deletedOriginal: options.deleteOriginal === true,
    });
  });

  /** 이력까지 완전히 지운다. 살아있으면 먼저 종료한다. */
  app.delete('/sessions/:id/history', (req, res) => {
    sessions.close(req.params.id);
    res.status(history.remove(req.params.id) ? 204 : 404).end();
  });

  app.get('/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: { code: 'session_not_found', message: '없는 세션' } });
      return;
    }
    res.json({ session: session.info() });
  });

  app.post(
    '/sessions/:id/input',
    asyncHandler(async (req, res) => {
      const session = sessions.get(req.params.id);
      if (!session) {
        res.status(404).json({ error: { code: 'session_not_found', message: '없는 세션' } });
        return;
      }
      const { prompt, wait } = sendInputSchema.parse(req.body);

      if (!wait) {
        session.send(prompt);
        res.status(202).json({ session: session.info() });
        return;
      }
      const turn = await session.sendAndWait(prompt);
      res.json({ session: session.info(), ...turn });
    }),
  );

  app.post('/sessions/:id/permissions', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: { code: 'session_not_found', message: '없는 세션' } });
      return;
    }
    const { requestId, behavior, message } = resolvePermissionSchema.parse(req.body);
    const ok = session.resolvePermission(requestId, behavior, message);
    if (!ok) {
      res.status(404).json({
        error: { code: 'permission_not_found', message: '없거나 이미 처리된 권한 요청' },
      });
      return;
    }
    res.json({ session: session.info() });
  });

  app.post('/sessions/:id/policy', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: { code: 'session_not_found', message: '없는 세션' } });
      return;
    }
    session.setPolicyMode(updatePolicySchema.parse(req.body).policyMode);
    res.json({ session: session.info() });
  });

  app.delete('/sessions/:id', (req, res) => {
    res.status(sessions.close(req.params.id) ? 204 : 404).end();
  });

  app.get('/sessions/:id/stream', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: { code: 'session_not_found', message: '없는 세션' } });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    // 구독 시점에 이미 대기 중인 권한 요청이 있으면 먼저 알려준다.
    for (const p of session.info().pending) {
      res.write('event: permission_request\n');
      res.write(
        `data: ${JSON.stringify({ type: 'permission_request', sessionId: session.id, requestId: p.id, toolName: p.toolName, input: p.input, summary: p.summary, reason: p.reason, at: p.at })}\n\n`,
      );
    }

    const unsubscribe = session.subscribe((event: SessionEvent) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'closed') res.end();
    });

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
    const cleanup = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  /**
   * 권한 MCP 서버 전용 엔드포인트.
   * 사용자가 결정할 때까지 응답을 붙잡는다.
   */
  app.post(
    '/internal/permission',
    asyncHandler(async (req, res) => {
      const { sessionId, toolName, input } = internalPermissionSchema.parse(req.body);
      const session = sessions.get(sessionId);
      if (!session) {
        res.json({ behavior: 'deny', message: '세션을 찾을 수 없습니다.' });
        return;
      }
      // 이 세션을 띄울 때 권한 MCP 서버에만 건넨 키다. 다른 세션 이름으로
      // 요청을 끼워 넣지 못하게 세션마다 따로 맞춰 본다.
      if (!sameSecret(req.header('x-perm-token') ?? '', session.permToken)) {
        res.status(401).json({ behavior: 'deny', message: '권한 서버 키가 맞지 않습니다.' });
        return;
      }
      const decision = await session.requestPermission(toolName, input);
      res.json(decision);
    }),
  );

  // --- 웹 UI 안내 ---
  //
  // 웹 UI는 relay-service가 /web 에서 서빙한다.
  // 여기서 같이 서빙하면 자원 경로와 인증이 어긋나므로 안내만 남긴다.

  app.get('/', (_req, res) => {
    res.type('html').send(
      `<!doctype html><meta charset="utf-8">
       <title>agent-cli</title>
       <body style="font:15px system-ui;padding:40px;max-width:520px;margin:auto">
         <h2>agent-cli 실행 중</h2>
         <p>이 서버는 API 전용입니다. 화면은 relay-service에서 엽니다.</p>
         <ul style="line-height:1.9">
           <li>웹 UI: <code>http://&lt;relay-service&gt;:4100/web</code></li>
           <li>안경앱: <code>http://&lt;relay-service&gt;:4100/</code></li>
         </ul>
       </body>`,
    );
  });

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: `경로 없음: ${req.path}` } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: { code: 'invalid_request', message: '요청 형식 오류', issues: err.issues },
      });
      return;
    }
    if (err instanceof SessionError) {
      const status = err.code === 'session_not_found' ? 404 : 400;
      res.status(status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof WorkspaceError) {
      const status = err.code === 'workspace_not_found' ? 404 : 400;
      res.status(status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: { code: 'internal_error', message } });
  });

  return { app, manager, sessions };
}
