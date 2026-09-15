import { z } from 'zod';

export const permissionModeSchema = z.enum([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
]);

export const createWorkspaceSchema = z.object({
  id: z.string().min(1).max(64),
  path: z.string().min(1),
  description: z.string().max(500).optional(),
});

export const createJobSchema = z.object({
  workspaceId: z.string().min(1),
  prompt: z.string().min(1).max(100_000),
  subPath: z.string().max(1000).optional(),
  model: z.string().max(100).optional(),
  permissionMode: permissionModeSchema.optional(),
  allowedTools: z.array(z.string()).max(100).optional(),
  disallowedTools: z.array(z.string()).max(100).optional(),
  appendSystemPrompt: z.string().max(50_000).optional(),
  resumeSessionId: z.string().uuid().optional(),
  maxTurns: z.number().int().positive().max(1000).optional(),
  timeoutMs: z.number().int().positive().max(6 * 60 * 60 * 1000).optional(),
  metadata: z.record(z.unknown()).optional(),
  /** true면 잡이 끝날 때까지 응답을 붙잡고 최종 결과를 돌려준다. */
  wait: z.boolean().optional(),
});

export const listJobsSchema = z.object({
  status: z
    .enum(['queued', 'running', 'succeeded', 'failed', 'canceled', 'timeout'])
    .optional(),
  workspaceId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const policyModeSchema = z.enum(['ask-risky', 'ask-all', 'auto-approve']);

export const createSessionSchema = z.object({
  /** path를 주면 생략할 수 있다. */
  workspaceId: z.string().min(1).optional(),
  /**
   * 작업 디렉토리 절대 경로. 허용 루트 안이면 워크스페이스 등록 없이 바로 쓴다.
   * 등록되지 않은 경로면 임시 워크스페이스를 자동으로 만든다.
   */
  path: z.string().min(1).max(4096).optional(),
  subPath: z.string().max(1000).optional(),
  model: z.string().max(100).optional(),
  policyMode: policyModeSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  appendSystemPrompt: z.string().max(50_000).optional(),
  resumeSessionId: z.string().uuid().optional(),
  loadMemory: z.boolean().optional(),
}).refine((v) => v.workspaceId ?? v.path, {
  message: 'workspaceId 또는 path 중 하나는 필요합니다.',
});

export const sendInputSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  /** true면 턴이 끝날 때까지 대기 후 결과를 돌려준다. */
  wait: z.boolean().optional(),
});

export const resolvePermissionSchema = z.object({
  requestId: z.string().min(1),
  behavior: z.enum(['allow', 'deny']),
  message: z.string().max(2000).optional(),
});

export const internalPermissionSchema = z.object({
  sessionId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.unknown().optional(),
});

export const updatePolicySchema = z.object({
  policyMode: policyModeSchema,
});

export const updateSessionSchema = z.object({
  title: z.string().min(1).max(200),
});

/** 이어가기 시 바꿀 수 있는 값들. 모두 생략하면 원래 설정을 따른다. */
export const resumeSessionSchema = z.object({
  model: z.string().max(100).optional(),
  policyMode: policyModeSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  /**
   * true면 이어간 뒤 원본 세션의 기록을 지운다.
   * 되돌릴 수 없으므로 기본은 false이고, 호출자가 명시해야 한다.
   */
  deleteOriginal: z.boolean().optional(),
});

export const readHistorySchema = z.object({
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

// --- 파일 관리 ---

/** 워크스페이스 기준 상대 경로. 절대 경로와 .. 는 서버에서 한 번 더 막는다. */
const relPathSchema = z.string().max(4096);

export const listFilesSchema = z.object({
  path: relPathSchema.optional(),
  /** 'true'면 점으로 시작하는 항목도 보여준다. */
  hidden: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const readFileSchema = z.object({
  path: relPathSchema.min(1),
});

export const writeFileSchema = z.object({
  path: relPathSchema.min(1),
  content: z.string().max(5_000_000),
});

export const mkdirSchema = z.object({
  path: relPathSchema.min(1),
});

export const deleteFileSchema = z.object({
  path: relPathSchema.min(1),
  recursive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const renameFileSchema = z.object({
  from: relPathSchema.min(1),
  to: relPathSchema.min(1),
});
