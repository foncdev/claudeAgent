import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { runClaude, type RunHandle } from './runner.js';
import { WorkspaceRegistry } from './workspaces.js';
import type { CreateJobInput, Job, JobEvent, JobStatus } from './types.js';

interface JobRecord {
  job: Job;
  handle?: RunHandle;
  /** 늦게 붙은 SSE 구독자에게 되돌려줄 이벤트 버퍼. */
  events: JobEvent[];
  emitter: EventEmitter;
  /** 큐에 대기 중인 잡을 시작시키는 함수. */
  start?: () => void;
}

const TERMINAL: JobStatus[] = ['succeeded', 'failed', 'canceled', 'timeout'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * 잡 수명주기를 관리한다.
 * - 동시 실행 수를 제한하고 초과분은 큐에 넣는다.
 * - 잡별 이벤트를 버퍼링해 SSE 구독자가 늦게 붙어도 전체를 받게 한다.
 */
export class JobManager {
  private jobs = new Map<string, JobRecord>();
  private queue: string[] = [];
  private running = new Set<string>();

  constructor(readonly workspaces: WorkspaceRegistry) {}

  create(input: CreateJobInput): Job {
    const ws = this.workspaces.require(input.workspaceId);
    const cwd = this.workspaces.resolveCwd(ws, input.subPath);

    const jobId = randomUUID();
    const { workspaceId: _w, prompt: _p, ...options } = input;
    const job: Job = {
      id: jobId,
      status: 'queued',
      workspaceId: ws.id,
      cwd,
      prompt: input.prompt,
      toolCalls: [],
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
      options,
    };

    const record: JobRecord = { job, events: [], emitter: new EventEmitter() };
    // SSE 구독자가 많아도 경고가 뜨지 않게 한다.
    record.emitter.setMaxListeners(0);
    record.start = () => this.launch(record, cwd, input);

    this.jobs.set(jobId, record);
    this.trim();
    this.queue.push(jobId);
    this.pump();
    return job;
  }

  private launch(record: JobRecord, cwd: string, input: CreateJobInput): void {
    const handle = runClaude({
      jobId: record.job.id,
      cwd,
      workspaceId: record.job.workspaceId,
      input,
    });
    record.handle = handle;

    // runner가 만든 Job 객체로 참조를 교체해 상태가 한 곳에서 갱신되게 한다.
    handle.job.createdAt = record.job.createdAt;
    handle.job.metadata = record.job.metadata;
    record.job = handle.job;

    this.publish(record, {
      type: 'status',
      jobId: record.job.id,
      status: 'running',
      at: new Date().toISOString(),
    });

    handle.events.on('event', (event: JobEvent) => this.publish(record, event));
    handle.done.finally(() => {
      this.running.delete(record.job.id);
      this.pump();
    });
  }

  private pump(): void {
    while (this.running.size < config.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const record = this.jobs.get(id);
      if (!record || record.job.status !== 'queued') continue;
      this.running.add(id);
      record.start?.();
    }
  }

  private publish(record: JobRecord, event: JobEvent): void {
    record.events.push(event);
    record.emitter.emit('event', event);
  }

  /** 오래된 종료 잡을 정리해 메모리 사용을 제한한다. */
  private trim(): void {
    if (this.jobs.size <= config.jobHistoryLimit) return;
    const finished = [...this.jobs.values()]
      .filter((r) => isTerminal(r.job.status))
      .sort((a, b) => (a.job.finishedAt ?? '').localeCompare(b.job.finishedAt ?? ''));
    let excess = this.jobs.size - config.jobHistoryLimit;
    for (const r of finished) {
      if (excess-- <= 0) break;
      this.jobs.delete(r.job.id);
    }
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)?.job;
  }

  list(filter?: { status?: JobStatus; workspaceId?: string; limit?: number }): Job[] {
    let items = [...this.jobs.values()].map((r) => r.job);
    if (filter?.status) items = items.filter((j) => j.status === filter.status);
    if (filter?.workspaceId) items = items.filter((j) => j.workspaceId === filter.workspaceId);
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filter?.limit ? items.slice(0, filter.limit) : items;
  }

  cancel(id: string): boolean {
    const record = this.jobs.get(id);
    if (!record) return false;
    if (isTerminal(record.job.status)) return false;

    if (record.job.status === 'queued') {
      // 아직 시작 전이면 큐에서 빼고 바로 종료 처리한다.
      this.queue = this.queue.filter((q) => q !== id);
      record.job.status = 'canceled';
      record.job.error = '시작 전에 취소되었습니다.';
      record.job.finishedAt = new Date().toISOString();
      this.publish(record, {
        type: 'status',
        jobId: id,
        status: 'canceled',
        at: record.job.finishedAt,
      });
      this.publish(record, {
        type: 'result',
        jobId: id,
        job: record.job,
        at: record.job.finishedAt,
      });
      return true;
    }

    record.handle?.cancel();
    return true;
  }

  /** 종료까지 기다린다. 이미 끝난 잡이면 즉시 돌려준다. */
  async wait(id: string): Promise<Job | undefined> {
    const record = this.jobs.get(id);
    if (!record) return undefined;
    if (isTerminal(record.job.status)) return record.job;
    if (record.handle) return record.handle.done;

    // 아직 큐에 있는 잡이면 result 이벤트를 기다린다.
    return new Promise<Job>((resolve) => {
      const onEvent = (event: JobEvent): void => {
        if (event.type === 'result') {
          record.emitter.off('event', onEvent);
          resolve(event.job);
        }
      };
      record.emitter.on('event', onEvent);
    });
  }

  /**
   * 잡 이벤트를 구독한다. 이미 발생한 이벤트를 먼저 재생하므로
   * 구독 시점에 관계없이 전체 스트림을 받는다.
   */
  subscribe(id: string, listener: (event: JobEvent) => void): (() => void) | undefined {
    const record = this.jobs.get(id);
    if (!record) return undefined;

    for (const event of record.events) listener(event);
    if (isTerminal(record.job.status)) return () => {};

    record.emitter.on('event', listener);
    return () => record.emitter.off('event', listener);
  }

  stats(): { running: number; queued: number; total: number; maxConcurrent: number } {
    return {
      running: this.running.size,
      queued: this.queue.length,
      total: this.jobs.size,
      maxConcurrent: config.maxConcurrent,
    };
  }
}
