import { networkInterfaces } from 'node:os';
import { createServer } from './api/server.js';
import { RelayLink } from './core/relay-link.js';
import { config } from './core/config.js';

const { app } = createServer();

const server = app.listen(config.port, config.host, () => {
  console.log(`[agent-cli] http://${config.host}:${config.port}`);
  console.log(`[agent-cli] 허용 루트: ${config.allowedRoots.join(', ')}`);
  console.log(`[agent-cli] 인증: ${config.apiKey ? 'x-api-key 필요' : '없음(로컬 전용 권장)'}`);
  console.log(`[agent-cli] 동시 실행 제한: ${config.maxConcurrent}`);

  // 외부에 열려 있으면 접속 주소를 알려주고, 키가 없으면 경고한다.
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) {
          console.log(`[agent-cli] LAN 접속: http://${a.address}:${config.port}  (${name})`);
        }
      }
    }
    if (!config.apiKey) {
      console.warn(
        '[agent-cli] 경고: 네트워크에 열려 있는데 AGENT_API_KEY가 없습니다. 같은 와이파이의 누구나 접근할 수 있습니다.',
      );
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
