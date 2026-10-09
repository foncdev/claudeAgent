<p align="center"><img src="docs/icon.svg" width="112" alt="claudeAgent 아이콘"></p>

# agent-cli manager

로컬에서 Claude Code CLI를 제어하는 매니저. 외부 API(REST + SSE)로 프롬프트를 보내고,
실행 경로를 관리하고, 최종 결과를 돌려받는다.

```
외부 클라이언트 ──HTTP──> 매니저(Express) ──spawn──> claude -p --output-format stream-json
                            │                                  │
                            └── SSE 스트림 <── stream-json 파싱 ──┘
```

## 구성

| 파일 | 역할 |
|---|---|
| `src/core/config.ts` | 환경변수 설정 (포트, 허용 루트, API 키, 동시 실행 수) |
| `src/core/workspaces.ts` | 워크스페이스 등록 + 경로 격리 (realpath 기반) |
| `src/core/runner.ts` | CLI spawn, stream-json 파싱, 타임아웃/취소 |
| `src/core/manager.ts` | 잡 큐, 동시 실행 제한, 이벤트 버퍼링 |
| `src/api/server.ts` | REST + SSE 엔드포인트 |

## 실행

```bash
npm install
cp .env.example .env    # 여기에 설정을 적는다
npm run dev
```

`.env`는 **서버와 클라이언트가 함께** 읽는다. 셸에 이미 export된 변수가 있으면 그쪽이 우선한다.

`.env` 없이 셸 변수만 쓸 수도 있지만, 그때는 서버와 클라이언트가 별개 프로세스이므로
**양쪽 터미널 모두** `AGENT_API_KEY`를 export해야 한다. 한쪽만 설정하면
클라이언트가 `x-api-key 헤더가 없습니다` 401을 받는다.

```bash
# 터미널 A (서버)
AGENT_ALLOWED_ROOTS=~/develop AGENT_API_KEY=secret npm run dev

# 터미널 B (클라이언트) — 같은 키를 다시 설정해야 한다
export AGENT_API_KEY=secret
npx tsx src/client.ts ws
```

### 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `4000` | 리스닝 포트 |
| `HOST` | `127.0.0.1` | 리스닝 주소. 로컬 전용 유지 권장 |
| `AGENT_ALLOWED_ROOTS` | `~/develop` | 워크스페이스 허용 루트. `:`로 여러 개 |
| `AGENT_API_KEY` | (없음) | 설정 시 `x-api-key` 헤더 필수. 비우면 이 기기 주소로만 받고, `HOST`가 루프백이 아니면 뜨지 않는다 |
| `AGENT_CORS_ORIGINS` | (없음) | 브라우저에서 직접 부를 수 있는 오리진. 쉼표로 여러 개. 목록에 없는 `Origin`은 403. relay를 거치지 않고 웹·안경앱에서 직접 붙을 때만 필요 |
| `AGENT_ALLOW_UNCHECKED` | (꺼짐) | `1`이면 `bypassPermissions`·`auto` 모드와 잡의 `allowedTools`를 받는다. 끄면 403 |
| `AGENT_MAX_CONCURRENT` | `3` | 동시 실행 잡 수 |
| `AGENT_TIMEOUT_MS` | `1800000` | 기본 타임아웃 (30분) |
| `CLAUDE_BIN` | `claude` | CLI 경로 |
| `AGENT_DATA_DIR` | `./data` | 워크스페이스 저장 위치 |

## 대화형 모드 (권장)

CLI처럼 프롬프트를 던지고, 권한 질문이 오면 선택하고, 이어서 진행한다.

```bash
npx tsx src/repl.ts my-app
```

```
세션 41131f5c · ~/develop/my-app
> repl-test.txt 파일에 hi 라고 써줘.
  · Write

┌─ 권한 요청
│ Write  (쓰기 가능 도구)
│ ~/develop/my-app/repl-test.txt
└─ 1) 허용  2) 거부  3) 이번 세션 전체 허용
선택 [1] > 1
  → 허용

`repl-test.txt` 파일을 만들고 `hi` 라고 작성했습니다.
  [완료 · $0.0892]
>
```

세션이 하나의 CLI 프로세스를 유지하므로 맥락이 계속 이어진다.

### 권한 정책

| 모드 | 동작 |
|---|---|
| `ask-risky` (기본) | 작업 폴더 안을 읽는 Read/Grep/`ls`·`git status` 등은 자동 승인, 폴더 밖 읽기·웹 요청·쓰기·실행은 질문 |
| `ask-all` | 모든 도구 질문 |
| `auto-approve` | 질문 없이 전부 승인 |

실행 중 `/policy auto-approve`로 바꾸거나, 권한 질문에서 `3`을 골라 세션 전체 허용으로 전환할 수 있다.

`ask-risky`에서 셸 명령은 `ls`·`cat`·`grep`·`git status` 같은 읽기 전용이 `&&`·`||`·`;`·`|`로
이어진 경우만 자동 승인한다. 줄바꿈, 단일 `&`, 리다이렉트(`>` `<`), 명령 치환(`` ` `` `$(`)이
하나라도 있으면 묻는다. 앞머리가 같아도 쓰거나 다른 프로그램을 부르는 옵션
(`find -delete`·`-exec`, `rg --pre`, `git --output`·`--ext-diff`, `git branch <이름>`·`-d`)은 묻는다.

파일 읽기(Read·Grep·Glob과 `cat` 같은 셸 명령)는 세션 작업 폴더 안일 때만 자동 승인한다. 심볼릭
링크는 풀어서 보고, `$`가 든 인자는 무엇으로 펼쳐질지 모르므로 묻는다. WebFetch·WebSearch는 읽은
내용을 밖으로 내보내는 통로가 될 수 있어 늘 묻는다.

### CLAUDE.md

세션 시작 시 CLAUDE.md를 자동으로 찾아 시스템 프롬프트로 주입한다.

| 범위 | 경로 |
|---|---|
| 사용자 전역 | `~/.claude/CLAUDE.md` |
| 프로젝트 | 루트→cwd 경로상의 `CLAUDE.md`, `CLAUDE.local.md` (가까울수록 우선) |

REPL 헤더와 `GET /sessions/:id`의 `memory`에 로드된 파일이 표시된다.
끄려면 세션 생성 시 `{"loadMemory": false}`.

> **왜 직접 주입하나:** 세션 모드는 `--setting-sources ''`로 사용자 설정을 격리한다.
> `~/.claude/settings.json`의 `permissions.allow`(예: `Write(*)`)가 권한 훅을 통째로
> 우회시키기 때문이다. 그런데 이 격리는 `~/.claude/CLAUDE.md`도 함께 차단하므로,
> 파일을 직접 읽어 `--append-system-prompt`로 넣는다. 프로젝트 CLAUDE.md는 격리와
> 무관하게 로드되지만, 일관성을 위해 같은 경로로 처리한다.
>
> 잡 모드(`run`/`chat`)는 설정을 격리하지 않으므로 CLAUDE.md가 원래대로 로드된다.

## API

모든 요청에 `x-api-key` 헤더 필요 (`AGENT_API_KEY` 설정 시). `/health`는 예외지만, 키 없이는
`{ok, version}`만 돌려준다. 허용 루트(홈 경로)와 잡 통계는 키를 낸 호출자에게만 준다.

### 워크스페이스 (실행 경로 관리)

```bash
# 등록 — 허용 루트 밖이면 거부된다
curl -X POST localhost:4000/workspaces -H "x-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"id":"my-app","path":"~/develop/my-app","description":"메인 앱"}'

curl localhost:4000/workspaces -H "x-api-key: $KEY"      # 목록
curl -X DELETE localhost:4000/workspaces/my-app -H "x-api-key: $KEY"
```

### 잡 (프롬프트 실행)

```bash
# 비동기 — 즉시 202와 jobId 반환
curl -X POST localhost:4000/jobs -H "x-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"my-app","prompt":"테스트 추가해줘","permissionMode":"acceptEdits"}'

# 동기 — 끝날 때까지 대기 후 최종 결과 반환
curl -X POST localhost:4000/jobs -H "x-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"my-app","prompt":"README 요약","wait":true}'
```

요청 필드:

| 필드 | 필수 | 설명 |
|---|---|---|
| `workspaceId` | O | 등록된 워크스페이스 ID |
| `prompt` | O | 전달할 프롬프트 |
| `subPath` | | 워크스페이스 내부 상대 경로에서 실행 |
| `wait` | | `true`면 완료까지 대기 |
| `model` | | `opus`, `sonnet` 등 |
| `permissionMode` | | `acceptEdits`, `plan` 등. `bypassPermissions`·`auto`는 `AGENT_ALLOW_UNCHECKED=1`일 때만 |
| `allowedTools` / `disallowedTools` | | 도구 허용·제한. `allowedTools`는 `AGENT_ALLOW_UNCHECKED=1`일 때만 |
| `appendSystemPrompt` | | 시스템 프롬프트 추가 |
| `resumeSessionId` | | 기존 세션 이어서 실행 |
| `maxTurns`, `timeoutMs` | | 실행 한도 |
| `metadata` | | 호출자 임의 데이터 (매니저는 해석 안 함) |

```bash
curl localhost:4000/jobs/$ID -H "x-api-key: $KEY"           # 단건 조회
curl "localhost:4000/jobs?status=running" -H "x-api-key: $KEY"  # 목록
curl -X POST localhost:4000/jobs/$ID/cancel -H "x-api-key: $KEY" # 취소
```

### 세션 API (대화형)

```bash
# 세션 생성 — CLI 프로세스가 뜨고 계속 살아있다
curl -X POST localhost:4000/sessions -H "x-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"my-app","policyMode":"ask-risky"}'

# 프롬프트 전송 (wait:true면 턴 완료까지 대기)
curl -X POST localhost:4000/sessions/$SID/input -H "x-api-key: $KEY" \
  -H 'content-type: application/json' -d '{"prompt":"테스트 추가해줘"}'

# 권한 요청에 응답 — 이걸 보내야 Claude가 이어서 진행한다
curl -X POST localhost:4000/sessions/$SID/permissions -H "x-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"requestId":"...","behavior":"allow"}'

curl localhost:4000/sessions/$SID -H "x-api-key: $KEY"   # 상태 + 대기 중인 권한 요청
curl -X DELETE localhost:4000/sessions/$SID -H "x-api-key: $KEY"  # 종료
```

세션 SSE (`GET /sessions/:id/stream`) 이벤트: `status`, `session`, `assistant`,
`thinking`, `tool_use`, `tool_result`, **`permission_request`**,
`permission_resolved`, `turn_complete`, `stderr`, `closed`.

`permission_request`가 오면 세션은 `waiting` 상태로 멈춘다.
`POST /sessions/:id/permissions`로 응답해야 진행된다.

세션 정보의 `slashCommands`는 그 세션에서 쓸 수 있는 `/` 명령(기본 명령·스킬, `/` 없이)이다. CLI가 시작할 때
알려 주는데 첫 입력을 받은 뒤에 오므로 그 전에는 비어 있다. `session` 이벤트에도 실린다.
`/compact`·`/usage` 같은 명령은 프롬프트로 그대로 보내면 된다(`POST /sessions/:id/input`).

### 잡 SSE 스트림

```bash
curl -N localhost:4000/jobs/$ID/stream -H "x-api-key: $KEY"
```

이벤트 종류: `status`, `session`, `assistant`, `thinking`, `tool_use`,
`tool_result`, `stderr`, `result`. `result`가 오면 스트림이 닫힌다.

구독 시점까지 쌓인 이벤트를 먼저 재생하므로, 잡 생성 직후가 아니어도 전체 스트림을 받는다.

```js
const es = new EventSource(`/jobs/${id}/stream`);
es.addEventListener('assistant', (e) => console.log(JSON.parse(e.data).text));
es.addEventListener('result', (e) => { console.log(JSON.parse(e.data).job.result); es.close(); });
```

### 세션 이어가기

`result`의 `sessionId`를 다음 요청의 `resumeSessionId`로 넘기면 대화가 이어진다.

## 경로 격리

- 워크스페이스는 `AGENT_ALLOWED_ROOTS` 하위에만 등록 가능
- `realpath`로 해석하므로 심볼릭 링크를 통한 탈출도 차단
- `subPath`는 상대 경로만 허용하고 워크스페이스 밖으로 나가면 거부
- 등록 시점뿐 아니라 **실행 시점에도 재검증** (등록 후 경로가 바뀐 경우 대비)
- 프롬프트는 argv 원소로 전달 — 셸을 거치지 않아 인젝션 위험 없음

## 주의

`permissionMode: "bypassPermissions"`·`"auto"`와 잡의 `allowedTools`는 사람의 확인 없이 도구를
돌린다. relay가 `/sessions`·`/jobs`를 중계하므로, 요청 값으로 받아주면 폰·안경 로그인 토큰 하나로
밖에서 확인 없는 실행이 된다. 그래서 기본은 거절(403)이고, 이 기기에서 자동화에 쓸 때만
`AGENT_ALLOW_UNCHECKED=1`로 켠다. 기본 모드는 세션이 `manual`, 잡이 CLI 기본 동작(`default`)이다.

relay-link는 relay-service가 중계하는 경로(`/sessions`·`/workspaces`·`/jobs`·`/files`·`/health`)만
받는다. `..`을 끼운 경로는 정규화한 뒤 다시 보므로 `/internal` 같은 경로로 빠지지 않는다. 밖의 relay에
`ws://`(평문)로 붙거나 `RELAY_AGENT_TOKEN`이 24자보다 짧으면 시작할 때 경고한다.

CLI에 넘기는 값은 `--옵션=값` 한 덩어리로, 잡의 프롬프트는 `--` 뒤에 둔다. `-`로 시작하는 값이
CLI 옵션으로 읽히지 않게 하려는 것이다.

`AGENT_API_KEY` 없이 `HOST`를 루프백이 아닌 주소로 열면 매니저가 뜨지 않는다. 매니저는 임의 코드
실행 능력을 가지므로 네트워크 노출을 피하는 것이 안전하다.

브라우저가 보낸 요청(`Origin` 헤더가 있는 것)은 `AGENT_CORS_ORIGINS`에 없으면 거절한다. 키가 없을
때는 `Host`도 이 기기 주소여야 한다. 사용자가 연 웹페이지나 DNS 리바인딩으로 매니저를 부를 수 없다.

Claude CLI에는 `AGENT_`·`RELAY_`로 시작하는 환경변수를 넘기지 않는다. 넘기면 Claude가
`echo $AGENT_API_KEY`로 매니저 키를 얻어 자기 권한을 스스로 풀 수 있다. 권한 MCP 서버에는
매니저 키 대신 세션마다 새로 만든 키를 주며, 그 키로는 그 세션의 권한을 묻는 것만 된다.

## 관련

- [relay-service](https://github.com/foncdev/relay-service) — 밖에서 붙게 해주는 중계 서버
- [glasses-ui](https://github.com/foncdev/glasses-ui) — 안경 UI 상태머신
- [glasses-g2](https://github.com/foncdev/glasses-g2) — G2 호스트 앱

## 라이선스

MIT
