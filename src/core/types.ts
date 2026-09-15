/** 잡 생명주기 상태. */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timeout';

/** 매니저가 관리하는 실행 경로 등록 정보. */
export interface Workspace {
  /** 외부 API에서 참조하는 별칭. */
  id: string;
  /** 절대 경로. 허용 루트 하위로 제한된다. */
  path: string;
  description?: string;
  createdAt: string;
}

/** 잡 생성 요청. */
export interface CreateJobInput {
  workspaceId: string;
  prompt: string;
  /** 워크스페이스 내부 상대 경로. 지정 시 여기서 실행된다. */
  subPath?: string;
  model?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  appendSystemPrompt?: string;
  /** 기존 Claude 세션을 이어서 실행한다. */
  resumeSessionId?: string;
  maxTurns?: number;
  timeoutMs?: number;
  /** 호출자가 임의로 붙이는 메타데이터. 매니저는 해석하지 않는다. */
  metadata?: Record<string, unknown>;
}

export type PermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'dontAsk'
  | 'plan';

/** 잡 실행 중 수집한 도구 호출 1건. */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  at: string;
}

/** CLI가 보고한 사용량/비용. */
export interface JobUsage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  numTurns?: number;
  durationMs?: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  workspaceId: string;
  /** 실제 실행된 절대 경로. */
  cwd: string;
  prompt: string;
  /** Claude Code가 부여한 세션 ID. resume에 사용한다. */
  sessionId?: string;
  /** 최종 결과 텍스트. */
  result?: string;
  error?: string;
  exitCode?: number;
  usage?: JobUsage;
  toolCalls: ToolCallRecord[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  options: Omit<CreateJobInput, 'workspaceId' | 'prompt'>;
}

/** SSE로 내보내는 이벤트. */
export type JobEvent =
  | { type: 'status'; jobId: string; status: JobStatus; at: string }
  | { type: 'session'; jobId: string; sessionId: string; cwd: string; model?: string; at: string }
  | { type: 'assistant'; jobId: string; text: string; at: string }
  | { type: 'thinking'; jobId: string; text: string; at: string }
  | { type: 'tool_use'; jobId: string; name: string; input: unknown; at: string }
  | { type: 'tool_result'; jobId: string; name?: string; isError: boolean; at: string }
  | { type: 'stderr'; jobId: string; text: string; at: string }
  | { type: 'result'; jobId: string; job: Job; at: string };
