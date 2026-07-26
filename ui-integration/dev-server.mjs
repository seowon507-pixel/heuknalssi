import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBackendEnvironment } from "./runtime-env.mjs";

const integrationDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(integrationDirectory, "..");
const backendDirectory = join(projectDirectory, "backend-v3");
const sampleRuntimePath = join(integrationDirectory, "sample-runtime.mjs");
const reviewedRuntimePath = join(
  backendDirectory,
  "runtime",
  "reviewed-runtime.mjs",
);
const frontendPort = parsePort(process.env.UI_PORT, 3000);
const backendPort = parsePort(process.env.BACKEND_PORT, 3100);
const frontendOrigin = `http://localhost:${frontendPort}`;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const runtimeMode = resolveRuntimeMode(process.argv.slice(2));
const uiFile = await findUiFile();

const backend = startBackend();
let server = null;
backend.stdout?.on("data", (chunk) => process.stdout.write(`[backend] ${chunk}`));
backend.stderr?.on("data", (chunk) => process.stderr.write(`[backend] ${chunk}`));

let stopping = false;
let backendExited = false;
backend.once("exit", (code, signal) => {
  backendExited = true;
  if (!stopping) {
    console.error(
      `backend-v3 exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`})`,
    );
    process.exitCode = 1;
    void shutdown();
  }
});

try {
  await waitForBackend();
} catch (error) {
  console.error(error.message);
  await shutdown();
  process.exit(1);
}

server = createServer((request, response) => {
  void routeRequest(request, response).catch((error) => {
    console.error(`frontend request failed: ${error.message}`);
    if (!response.headersSent) {
      sendJson(response, 500, {
        code: "FRONTEND_SERVER_ERROR",
        message: "로컬 UI 서버가 요청을 처리하지 못했습니다.",
      });
    } else {
      response.destroy();
    }
  });
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(frontendPort, "127.0.0.1", resolveListen);
});

console.log(`흙날씨 UI: ${frontendOrigin}`);
console.log(
  runtimeMode === "sample"
    ? "실행 모드: 개발 샘플 API (농업 의사결정 사용 금지)"
    : runtimeMode === "external"
      ? "실행 모드: 외부 검수 runtime/키 (환경변수 사용)"
      : "실행 모드: 안전 기본 HOLD (외부 검수 runtime 없음)",
);

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

async function routeRequest(request, response) {
  const url = new URL(request.url ?? "/", frontendOrigin);
  if (url.pathname.startsWith("/api/")) {
    await proxyApi(request, response, url);
    return;
  }
  if (url.pathname === "/__integration/config") {
    sendJson(response, 200, {
      runtimeMode,
      sampleData: runtimeMode === "sample",
      apiBase: "/api",
      backendPort,
    });
    return;
  }
  if (url.pathname === "/" || url.pathname === `/${encodeURIComponent(uiFile.name)}`) {
    await serveFile(uiFile.path, response, { cache: false });
    return;
  }
  if (url.pathname.startsWith("/ui-integration/")) {
    const localPath = safeIntegrationPath(url.pathname);
    if (localPath) {
      await serveFile(localPath, response, { cache: false });
      return;
    }
  }
  sendJson(response, 404, {
    code: "NOT_FOUND",
    message: "요청한 로컬 UI 파일을 찾을 수 없습니다.",
  });
}

async function proxyApi(request, response, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || isHopByHopHeader(name)) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  headers.delete("host");
  headers.delete("content-length");
  headers.set("origin", frontendOrigin);

  const method = request.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD" ? undefined : await readRequestBody(request);
  let upstream;
  try {
    upstream = await fetch(`${backendOrigin}${url.pathname}${url.search}`, {
      method,
      headers,
      body,
      redirect: "manual",
    });
  } catch {
    sendJson(response, 502, {
      code: "BACKEND_UNREACHABLE",
      message: "backend-v3에 연결할 수 없습니다.",
      retryable: true,
    });
    return;
  }

  const payload = Buffer.from(await upstream.arrayBuffer());
  const responseHeaders = {};
  for (const [name, value] of upstream.headers) {
    if (
      isHopByHopHeader(name) ||
      name.toLowerCase() === "content-length" ||
      name.toLowerCase() === "content-encoding" ||
      name.toLowerCase() === "set-cookie"
    ) {
      continue;
    }
    responseHeaders[name] = value;
  }
  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) responseHeaders["Set-Cookie"] = setCookies;
  responseHeaders["Content-Length"] = String(payload.length);
  response.writeHead(upstream.status, responseHeaders);
  response.end(payload);
}

function startBackend() {
  const env = buildBackendEnvironment({
    baseEnv: process.env,
    runtimeMode,
    backendPort,
    frontendOrigin,
    sampleRuntimePath,
    reviewedRuntimePath,
  });
  return spawn(process.execPath, ["server/index.js"], {
    cwd: backendDirectory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForBackend() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (backendExited) {
      throw new Error("backend-v3가 준비되기 전에 종료됐습니다.");
    }
    try {
      const response = await fetch(`${backendOrigin}/api/health/preflight`, {
        headers: { Origin: frontendOrigin },
      });
      if (response.ok) return;
    } catch {
      // The backend process is still starting.
    }
    await delay(100);
  }
  throw new Error("backend-v3가 10초 안에 시작되지 않았습니다.");
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (server?.listening) {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  if (!backendExited) {
    backend.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => backend.once("exit", resolveExit)),
      delay(2_000),
    ]);
  }
}

async function findUiFile() {
  const entries = await readdir(projectDirectory, { withFileTypes: true });
  const matches = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("08_") &&
        entry.name.endsWith(".html") &&
        entry.name.includes("UI"),
    )
    .sort((left, right) => left.name.localeCompare(right.name, "ko"));
  if (matches.length !== 1) {
    throw new Error(
      `UI HTML을 하나로 확정할 수 없습니다. 발견 개수: ${matches.length}`,
    );
  }
  return {
    name: matches[0].name,
    path: join(projectDirectory, matches[0].name),
  };
}

function safeIntegrationPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relativePath = decoded.replace(/^\/ui-integration\//u, "");
  if (!relativePath || relativePath.includes("\0")) return null;
  const resolvedPath = resolve(integrationDirectory, normalize(relativePath));
  const relation = relative(integrationDirectory, resolvedPath);
  if (relation.startsWith("..") || relation === "") return null;
  return resolvedPath;
}

async function serveFile(path, response, { cache }) {
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch {
    sendJson(response, 404, {
      code: "NOT_FOUND",
      message: "요청한 로컬 UI 파일을 찾을 수 없습니다.",
    });
    return;
  }
  if (!fileStat.isFile()) {
    sendJson(response, 404, {
      code: "NOT_FOUND",
      message: "요청한 로컬 UI 파일을 찾을 수 없습니다.",
    });
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType(path),
    "Content-Length": String(fileStat.size),
    "Cache-Control": cache ? "public, max-age=300" : "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(path).pipe(response);
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) {
      const error = new Error("proxy request body exceeds 128 KiB");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
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

function contentType(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") {
    return "text/javascript; charset=utf-8";
  }
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function isHopByHopHeader(name) {
  return new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]).has(name.toLowerCase());
}

function parsePort(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`유효하지 않은 포트: ${value}`);
  }
  return port;
}

function resolveRuntimeMode(args) {
  if (args.includes("--safe")) return "safe";
  if (args.includes("--external")) return "external";
  if (args.length === 0 || args.includes("--sample")) return "sample";
  throw new TypeError(
    "지원하는 실행 옵션은 --sample, --safe 또는 --external입니다.",
  );
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
