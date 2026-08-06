// dev-all.mjs — 코어 백엔드(backend-v3, 3100번)와 프론트+게임 서버(src/server.js, 4000번)를
// 한 번에 띄웁니다. 외부 패키지 없이 node:child_process만 사용합니다.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const children = [];

function run(label, args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const prefix = `[${label}] `;
  const pipe = (stream, out) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    console.log(`${prefix}종료됨 (code=${code}, signal=${signal})`);
  });
  return child;
}

run('core:3100', ['--env-file-if-exists=.env', 'server/index.js'], path.join(ROOT, 'backend-v3'));
run('app:4000', ['--env-file-if-exists=.env', 'src/server.js'], ROOT);

function shutdown() {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
