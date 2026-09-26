import { networkInterfaces } from 'node:os';
import { createServer } from './api/server.js';
import { RelayLink } from './core/relay-link.js';
import { config, isLoopback } from './core/config.js';

// 키 없이 밖에 열면 같은 네트워크의 누구나 명령을 돌릴 수 있다. 경고로
// 끝내면 켜진 채로 두게 되므로 아예 뜨지 않는다.
if (!config.apiKey && !isLoopback(config.host)) {
  console.error(
    `[agent-cli] HOST=${config.host}로 열려면 AGENT_API_KEY가 필요합니다.\n` +
      '  openssl rand -hex 24 로 만든 값을 .env에 넣거나, HOST=127.0.0.1로 두세요.',
  );
  process.exit(1);
}

const { app } = createServer();

const server = app.listen(config.port, config.host, () => {
  console.log(`[agent-cli] http://${config.host}:${config.port}`);
  console.log(`[agent-cli] 허용 루트: ${config.allowedRoots.join(', ')}`);
  console.log(`[agent-cli] 인증: ${config.apiKey ? 'x-api-key 필요' : '없음 — 이 기기 주소로만 받음'}`);
  console.log(`[agent-cli] 동시 실행 제한: ${config.maxConcurrent}`);

  // 외부에 열려 있으면 접속 주소를 알려준다. 키 없이 여는 것은 위에서 막았다.
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) {
          console.log(`[agent-cli] LAN 접속: http://${a.address}:${config.port}  (${name})`);
        }
      }
    }
  }
});

// relay-service가 설정돼 있으면 그쪽으로 나가서 붙는다.
// 맥이 공유기 안에 있어도 밖에서 쓸 수 있게 하는 경로다.
let link: RelayLink | undefined;
if (config.relayUrl) {
  link = new RelayLink(config.relayUrl, config.relayToken, config.relayName);
  link.start();
  console.log(`[agent-cli] relay 연결 시도: ${config.relayUrl}`);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n[agent-cli] ${sig} 수신, 종료합니다.`);
    link?.stop();
    server.close(() => process.exit(0));
  });
}
