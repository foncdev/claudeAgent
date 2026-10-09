/**
 * 어떻게 실행됐는지. 실행 파일 하나(bun build --compile)로 돌면 src/bin.ts가 selfExec를 켠다.
 *
 * 그때는 permission-server.js 파일이 따로 없으므로, 권한 서버를 "이 실행 파일 + --permission-server"로 띄운다.
 */
export const runtime = { selfExec: false };
