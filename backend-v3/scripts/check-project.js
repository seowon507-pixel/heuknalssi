import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const failures = [];
const forbiddenUiExtensions = new Set(['.html', '.css', '.jsx', '.tsx', '.vue', '.svelte']);
const secretPattern =
  /\b(?:AIza[0-9A-Za-z_-]{20,}|sk-ant-[0-9A-Za-z_-]{20,}|KakaoAK\s+[0-9A-Za-z_-]{20,})\b/;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (['node_modules', '.git', 'coverage'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

const files = await walk(root);
for (const file of files) {
  const name = relative(root, file);
  const extension = extname(file);

  if (forbiddenUiExtensions.has(extension)) {
    failures.push(`${name}: frontend file is outside backend-v3 scope`);
  }

  if (extension === '.js') {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(`${name}: ${result.stderr.trim()}`);
  }

  if (extension === '.json') {
    try {
      JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      failures.push(`${name}: invalid JSON (${error.message})`);
    }
  }

  if (!['.env', '.local'].includes(extension)) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (secretPattern.test(text)) failures.push(`${name}: possible hard-coded credential`);
    if (name !== 'scripts/check-project.js' && text.includes('http://apis.data.go.kr')) {
      failures.push(`${name}: plaintext data.go.kr endpoint is forbidden`);
    }
  }
}

for (const forbidden of ['.env', '.env.local']) {
  if (files.some((file) => relative(root, file) === forbidden)) {
    failures.push(`${forbidden}: secret-bearing environment file must not be in the revision`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`project check passed (${files.length} files)`);
}
