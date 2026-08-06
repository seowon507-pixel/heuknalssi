// backend-v3(흙날씨 v3 코어 백엔드)를 Vercel 서버리스 함수로 노출합니다.
// createBackend()가 반환하는 handler(req, res)가 Node 함수 시그니처와
// 동일하므로 HTTP 서버를 listen하지 않고 핸들러만 재사용합니다.
// vercel.json의 rewrite가 /core-api/* 요청을 이 함수로 보냅니다
// (/api/*는 api/app.js가 heuknalssi-1 자체 게임 API로 처리하므로 경로가 겹치지 않습니다).

import { createBackend } from '../backend-v3/server/app.js';
import { createRuntimeOptions } from '../backend-v3/runtime/reviewed-runtime.mjs';

// 람다 인스턴스가 재사용될 때 규칙 레지스트리와 어댑터를 다시 만들지 않습니다.
let backendPromise = null;

export default async function handler(request, response) {
  restoreRequestUrl(request);

  let backend;
  try {
    backend = await loadBackend();
  } catch (error) {
    console.error(`backend bootstrap failed: ${error.message}`);
    sendJson(response, 500, {
      code: 'BACKEND_BOOTSTRAP_FAILED',
      message: '백엔드 설정이 올바르지 않아 요청을 처리할 수 없습니다.',
    });
    return;
  }

  await backend.handler(request, response);
}

// vercel.json의 rewrite가 원래 경로를 __vpath에 실어 보냅니다.
// 리라이트 후 request.url이 어떤 형태로 도착하든 백엔드 라우터에는
// 원래 경로(예: /api/session)를 그대로 넘깁니다.
function restoreRequestUrl(request) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const forwardedPath = url.searchParams.get('__vpath');
  if (forwardedPath !== null && forwardedPath.startsWith('/')) {
    url.searchParams.delete('__vpath');
    const pathname = forwardedPath.split('?')[0];
    request.url = `${pathname}${url.search}`;
  }
}

function loadBackend() {
  if (backendPromise === null) {
    backendPromise = createConfiguredBackend().catch((error) => {
      backendPromise = null;
      throw error;
    });
  }
  return backendPromise;
}

async function createConfiguredBackend() {
  const runtimeOptions = await createRuntimeOptions();
  return createBackend({ env: buildVercelEnvironment(process.env), ...runtimeOptions });
}

function hasValue(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * ALLOWED_ORIGINS를 명시하지 않으면 Vercel이 주입하는 배포 호스트를 씁니다.
 * 프리뷰 배포마다 URL이 달라지는 문제를 환경변수 수정 없이 처리합니다.
 */
function resolveAllowedOrigins(baseEnv) {
  if (hasValue(baseEnv.ALLOWED_ORIGINS)) return baseEnv.ALLOWED_ORIGINS.trim();
  const hosts = [
    baseEnv.VERCEL_PROJECT_PRODUCTION_URL,
    baseEnv.VERCEL_BRANCH_URL,
    baseEnv.VERCEL_URL,
  ].filter(hasValue);
  return [...new Set(hosts)].map((host) => `https://${host}`).join(',');
}

function buildVercelEnvironment(baseEnv) {
  const env = { ...baseEnv };
  env.NODE_ENV = baseEnv.NODE_ENV ?? 'production';
  env.ALLOWED_ORIGINS = resolveAllowedOrigins(baseEnv);
  if (!hasValue(baseEnv.SESSION_SECRET)) delete env.SESSION_SECRET;
  // 런타임 모듈(규칙·위치매핑·토양계약)은 위에서 직접 import해 주입하므로
  // 경로 기반 주입은 쓰지 않습니다 (서버리스 파일시스템 경로가 로컬과 다릅니다).
  delete env.TRUSTED_BACKEND_RUNTIME_MODULE;
  // 이 배포의 Supabase 프로젝트는 다른 제품(흙날씨 진단)용으로, 이 백엔드의
  // 공유 상태 RPC 스키마가 있다는 보장이 없습니다. 세션/후보 상태 공유 저장을
  // 끄고 인메모리(요청 처리 동안만 유지)로 안전하게 폴백시킵니다.
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SECRET_KEY;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  return env;
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}
