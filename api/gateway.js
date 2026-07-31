// backend-v3를 Vercel 서버리스 함수로 노출한다.
// createBackend()가 반환하는 handler(req, res)가 Node 함수 시그니처와
// 동일하므로 HTTP 서버를 listen 하지 않고 핸들러만 재사용한다.
import { fileURLToPath } from "node:url";

import { createBackend } from "../backend-v3/server/app.js";
import { createRuntimeOptions } from "../backend-v3/runtime/reviewed-runtime.mjs";
import { buildBackendEnvironment } from "../ui-integration/runtime-env.mjs";

const reviewedRuntimePath = fileURLToPath(
  new URL("../backend-v3/runtime/reviewed-runtime.mjs", import.meta.url),
);

// 람다 인스턴스가 재사용될 때 규칙 레지스트리와 어댑터를 다시 만들지 않는다.
let backendPromise = null;

export default async function handler(request, response) {
  const pathname = restoreRequestUrl(request);

  let backend;
  try {
    backend = await loadBackend();
  } catch (error) {
    console.error(`backend bootstrap failed: ${error.message}`);
    sendJson(response, 500, {
      code: "BACKEND_BOOTSTRAP_FAILED",
      message: "백엔드 설정이 올바르지 않아 요청을 처리할 수 없습니다.",
    });
    return;
  }

  // 반드시 기다린다. 핸들러는 응답을 보낸 뒤에도 공유 저장소에 이번 요청의
  // 변경을 반영한다. 여기서 기다리지 않으면 서버리스가 그 작업을 얼려서
  // 세션·분석이 다음 인스턴스로 넘어가지 않는다.
  await backend.handler(request, response);
}

/**
 * vercel.json의 rewrite가 원래 경로를 `__vpath`에 실어 보낸다. 리라이트 후
 * request.url이 어떤 형태로 도착하든 백엔드 라우터에는 원래 경로를 넘긴다.
 * request.url을 제자리에서 복원한 뒤 pathname을 돌려준다.
 */
function restoreRequestUrl(request) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const forwardedPath = url.searchParams.get("__vpath");
  if (forwardedPath !== null && forwardedPath.startsWith("/")) {
    url.searchParams.delete("__vpath");
    const pathname = forwardedPath.split("?")[0];
    request.url = `${pathname}${url.search}`;
    return pathname;
  }
  return url.pathname;
}

function loadBackend() {
  if (backendPromise === null) {
    backendPromise = createConfiguredBackend().catch((error) => {
      // 설정 오류가 인스턴스에 고착되지 않도록 실패한 약속은 버린다.
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

/**
 * dev-server의 external 모드와 동일한 플래그·계약버전 기본값을 재사용한다.
 * 키를 Vercel 환경변수에 추가하기만 하면 해당 어댑터가 켜진다.
 */
function buildVercelEnvironment(baseEnv) {
  const allowedOrigins = resolveAllowedOrigins(baseEnv);
  const env = buildBackendEnvironment({
    baseEnv,
    runtimeMode: "external",
    backendPort: 3100,
    frontendOrigin: allowedOrigins.split(",")[0] ?? "",
    reviewedRuntimePath,
  });

  // buildBackendEnvironment는 로컬 개발용 기본값을 넣는다. 배포에서는
  // NODE_ENV를 되돌리고, 공유된 개발용 SESSION_SECRET을 절대 쓰지 않는다.
  env.NODE_ENV = baseEnv.NODE_ENV ?? "production";
  env.ALLOWED_ORIGINS = allowedOrigins;
  if (!hasValue(baseEnv.SESSION_SECRET)) {
    delete env.SESSION_SECRET;
  }
  // 런타임 모듈은 위에서 직접 import 하므로 경로 주입 경로는 사용하지 않는다.
  delete env.TRUSTED_BACKEND_RUNTIME_MODULE;
  return env;
}

/**
 * ALLOWED_ORIGINS를 명시하지 않으면 Vercel이 주입하는 배포 호스트를 쓴다.
 * 미리보기 배포마다 URL이 달라지는 문제를 환경변수 수정 없이 처리한다.
 */
function resolveAllowedOrigins(baseEnv) {
  if (hasValue(baseEnv.ALLOWED_ORIGINS)) return baseEnv.ALLOWED_ORIGINS.trim();
  const hosts = [
    baseEnv.VERCEL_PROJECT_PRODUCTION_URL,
    baseEnv.VERCEL_BRANCH_URL,
    baseEnv.VERCEL_URL,
  ].filter(hasValue);
  return [...new Set(hosts)].map((host) => `https://${host}`).join(",");
}

function hasValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(payload);
}
