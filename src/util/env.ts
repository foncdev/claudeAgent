import fs from 'node:fs';
import path from 'node:path';

/**
 * 프로젝트 루트의 .env를 읽어 process.env에 채운다.
 * 이미 설정된 변수는 덮어쓰지 않는다(셸 값이 우선).
 * 서버와 클라이언트가 같은 파일을 읽으므로 키를 한 곳에서 관리할 수 있다.
 */
export function loadEnv(file = '.env'): void {
  const target = path.resolve(process.cwd(), file);
  if (!fs.existsSync(target)) return;

  for (const raw of fs.readFileSync(target, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // 따옴표로 감싼 값은 벗겨낸다.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}
