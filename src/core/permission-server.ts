#!/usr/bin/env node
/**
 * 권한 프롬프트를 매니저로 중계하는 최소 MCP 서버.
 *
 * Claude Code가 도구 실행 전 이 서버의 approve 도구를 호출하면,
 * 여기서 매니저 HTTP API로 승인 요청을 보내고 응답을 기다린다.
 * 사용자가 결정할 때까지 블로킹되므로 CLI와 같은 확인 흐름이 된다.
 *
 * stdio로 통신하므로 stdout에는 JSON-RPC만 써야 한다. 로그는 stderr로.
 */
import { createInterface } from 'node:readline';

const MANAGER_URL = process.env.AGENT_MANAGER_URL ?? 'http://127.0.0.1:4000';
const SESSION_ID = process.env.AGENT_SESSION_ID ?? '';
/** 이 세션 전용 키. 매니저 API 키가 아니다 — session.ts의 permToken 참고. */
const PERM_TOKEN = process.env.AGENT_PERM_TOKEN ?? '';

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function send(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

/** 매니저에 승인 여부를 묻는다. 실패하면 안전하게 거부한다. */
async function askManager(
  toolName: string,
  input: unknown,
): Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: unknown }> {
  try {
    const res = await fetch(`${MANAGER_URL}/internal/permission`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-perm-token': PERM_TOKEN,
      },
      body: JSON.stringify({ sessionId: SESSION_ID, toolName, input }),
    });
    if (!res.ok) {
      return { behavior: 'deny', message: `매니저 응답 오류 (HTTP ${res.status})` };
    }
    const body = (await res.json()) as {
      behavior?: string;
      message?: string;
      updatedInput?: unknown;
    };
    return body.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: body.updatedInput ?? input }
      : { behavior: 'deny', message: body.message ?? '매니저가 거부했습니다.' };
  } catch (err) {
    return { behavior: 'deny', message: `매니저 연결 실패: ${(err as Error).message}` };
  }
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line: string) => {
  let msg: RpcMessage;
  try {
    msg = JSON.parse(line) as RpcMessage;
  } catch {
    return;
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-cli-permission', version: '1.0.0' },
      },
    });
    return;
  }

  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'approve',
            description: '도구 실행 권한을 매니저에 확인한다.',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                input: { type: 'object' },
              },
              required: ['tool_name'],
            },
          },
        ],
      },
    });
    return;
  }

  if (msg.method === 'tools/call') {
    const args = msg.params?.arguments ?? {};
    const toolName = String(args.tool_name ?? 'unknown');
    void askManager(toolName, args.input).then((decision) => {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(decision) }] },
      });
    });
    return;
  }

  // notifications/* 등 응답이 필요 없는 메시지는 무시한다.
  if (msg.id !== undefined && msg.method) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
