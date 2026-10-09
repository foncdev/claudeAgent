/**
 * 실행 파일 하나로 묶을 때의 진입점(bun build --compile, npm run build:bin).
 *
 * 권한 서버(permission-server)는 Claude CLI가 따로 띄우는 MCP 서버다. 실행 파일 하나에는 그 스크립트가
 * 따로 없으므로, 이 실행 파일을 --permission-server로 다시 띄우면 권한 서버로 돈다(session.ts가 그렇게 띄운다).
 */
import { runtime } from './core/runtime.js';
import { VERSION } from './core/version.js';

runtime.selfExec = true;

if (process.argv.includes('--permission-server')) {
  await import('./core/permission-server.js');
} else if (process.argv.includes('--version')) {
  console.log(VERSION);
} else {
  await import('./index.js');
}
