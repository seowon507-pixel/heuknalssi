// 재배 참고 이미지 프록시.
//
// 브라우저는 /api/knowledge-images/{imageId}만 호출한다. 업스트림 URL은 응답에
// 담기지 않고 서버 안에 머문다. 이렇게 두는 이유는 세 가지다.
//
//   1. CSP를 img-src 'self'로 유지할 수 있다. 외부 호스트를 열면 흙톡 이외의
//      화면에서도 외부 이미지 로드가 가능해진다.
//   2. 사용자 입력이 fetch 대상이 될 수 없다. 프록시는 레지스트리에 등록된
//      imageId만 받고, URL 문자열은 어떤 경로로도 요청에서 들어오지 않는다.
//   3. 사용자의 IP와 Referer가 외부 기관 서버로 나가지 않는다.

// 프록시가 이미지를 받아올 수 있는 호스트. 보안 정책이므로 검수 코퍼스가 아니라
// 애플리케이션 계층이 소유한다. 코퍼스에 등록된 URL이라도 이 목록 밖이면 거절한다.
export const KNOWLEDGE_IMAGE_HOST_ALLOWLIST = Object.freeze([
  "ncpms.rda.go.kr",
  "www.nongsaro.go.kr",
  "nongsaro.go.kr",
]);

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 6_000;
const IMAGE_ID_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;
// 외부에서 받아오는 이미지는 래스터만 허용한다. 제3자가 준 SVG는 우리 오리진에서
// 서빙되므로 형식을 넓히지 않는다.
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
// 자체 제작 도해는 저장소에 있는 우리 파일이므로 SVG를 허용한다. <img>로 불린
// SVG는 브라우저가 스크립트를 실행하지 않고, 응답에도 nosniff와 default-src
// 'none' CSP가 붙는다. 그래도 검증 스크립트가 script·foreignObject·외부 참조를
// 거부해 두 겹으로 막는다.
const ALLOWED_ASSET_CONTENT_TYPES = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export class KnowledgeImageError extends Error {
  constructor(code) {
    super(code);
    this.name = "KnowledgeImageError";
    this.code = code;
  }
}

function normalizeAllowlist(hosts) {
  return new Set(
    (Array.isArray(hosts) ? hosts : [])
      .filter((host) => typeof host === "string" && host.trim())
      .map((host) => host.trim().toLowerCase()),
  );
}

/**
 * 등록된 이미지가 프록시로 내보낼 수 있는 상태인지 확인한다.
 * 통과하지 못한 이미지는 화면에서 "이미지 자료 미연결"로 표시된다.
 */
function resolveTarget(entry, allowlist) {
  if (!entry || typeof entry.url !== "string" || !entry.url.trim()) {
    throw new KnowledgeImageError("KNOWLEDGE_IMAGE_NOT_CONNECTED");
  }
  let url;
  try {
    url = new URL(entry.url);
  } catch {
    throw new KnowledgeImageError("KNOWLEDGE_IMAGE_INVALID_TARGET");
  }
  if (url.protocol !== "https:") {
    throw new KnowledgeImageError("KNOWLEDGE_IMAGE_INVALID_TARGET");
  }
  if (!allowlist.has(url.hostname.toLowerCase())) {
    throw new KnowledgeImageError("KNOWLEDGE_IMAGE_HOST_NOT_ALLOWED");
  }
  return url;
}

/**
 * 등록된 이미지를 화면 표시용 설명으로 바꾼다. 업스트림 URL은 포함하지 않고,
 * 실제로 프록시할 수 있는지만 available로 알려 준다. 흙톡 답변과 프록시 라우트가
 * 같은 판정을 쓰도록 여기 한 곳에 둔다.
 */
/** 등록된 항목이 내보낼 수 있는 자체 제작 에셋을 들고 있는지. */
function assetOf(entry) {
  const body = entry?.body;
  const contentType =
    typeof entry?.contentType === "string"
      ? entry.contentType.trim().toLowerCase()
      : "";
  if (!Buffer.isBuffer(body) || body.length === 0) return null;
  if (!ALLOWED_ASSET_CONTENT_TYPES.has(contentType)) return null;
  return { contentType, body };
}

export function describeKnowledgeImage(entry, imageId) {
  if (!entry || typeof entry !== "object") return null;
  const asset = assetOf(entry);
  return Object.freeze({
    imageId,
    alt: entry.alt ?? null,
    caption: entry.caption ?? null,
    credit: entry.credit ?? null,
    licence: entry.licence ?? null,
    // 자체 제작 도해는 항상 사용할 수 있고, 외부 URL은 등록되어 있을 때만이다.
    source: asset ? "DIAGRAM" : entry.url ? "EXTERNAL" : null,
    available: Boolean(asset) ||
      Boolean(typeof entry.url === "string" && entry.url.trim()),
  });
}

export function createKnowledgeImageService({
  images = {},
  hostAllowlist = KNOWLEDGE_IMAGE_HOST_ALLOWLIST,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_IMAGE_BYTES,
} = {}) {
  const allowlist = normalizeAllowlist(hostAllowlist);
  const registry = new Map(
    Object.entries(images ?? {}).filter(
      ([imageId, entry]) =>
        IMAGE_ID_PATTERN.test(imageId) && entry && typeof entry === "object",
    ),
  );
  const diagramCount = [...registry.values()].filter((entry) =>
    assetOf(entry),
  ).length;
  const externalCount = [...registry.values()].filter(
    (entry) => !assetOf(entry) && typeof entry.url === "string" && entry.url.trim(),
  ).length;
  const connectedCount = diagramCount + externalCount;

  return Object.freeze({
    state: connectedCount > 0 ? "READY" : "NOT_CONNECTED",
    registeredCount: registry.size,
    connectedCount,
    diagramCount,
    externalCount,

    /** 화면 표시용 설명. 업스트림 URL은 포함하지 않는다. */
    describe(imageId) {
      return describeKnowledgeImage(registry.get(imageId), imageId);
    },

    async fetchImage(rawImageId, { signal } = {}) {
      const imageId = typeof rawImageId === "string" ? rawImageId : "";
      if (!IMAGE_ID_PATTERN.test(imageId)) {
        throw new KnowledgeImageError("KNOWLEDGE_IMAGE_INVALID_ID");
      }
      const entry = registry.get(imageId);
      if (!entry) {
        throw new KnowledgeImageError("KNOWLEDGE_IMAGE_NOT_FOUND");
      }
      // 자체 제작 도해는 기동 시 메모리에 올려 두었으므로 여기서 끝난다.
      // 네트워크도 파일 시스템도 요청 경로에 들어오지 않는다.
      const asset = assetOf(entry);
      if (asset) {
        if (asset.body.length > maxBytes) {
          throw new KnowledgeImageError("KNOWLEDGE_IMAGE_TOO_LARGE");
        }
        return Object.freeze({
          contentType: asset.contentType,
          body: asset.body,
        });
      }
      const target = resolveTarget(entry, allowlist);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let response;
      try {
        response = await fetchImpl(target.href, {
          method: "GET",
          // 리다이렉트를 따라가면 허용목록 밖 호스트로 끌려갈 수 있다.
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
          headers: { Accept: "image/jpeg,image/png,image/webp" },
        });
      } catch {
        throw new KnowledgeImageError("KNOWLEDGE_IMAGE_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      if (!response?.ok) {
        throw new KnowledgeImageError("KNOWLEDGE_IMAGE_UNAVAILABLE");
      }
      const contentType = String(response.headers?.get?.("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new KnowledgeImageError("KNOWLEDGE_IMAGE_UNSUPPORTED_TYPE");
      }
      const declaredLength = Number(
        response.headers?.get?.("content-length") ?? Number.NaN,
      );
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new KnowledgeImageError("KNOWLEDGE_IMAGE_TOO_LARGE");
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      // Content-Length를 신뢰하지 않고 실제 바이트도 확인한다.
      if (buffer.length === 0 || buffer.length > maxBytes) {
        throw new KnowledgeImageError("KNOWLEDGE_IMAGE_TOO_LARGE");
      }
      return Object.freeze({ contentType, body: buffer });
    },
  });
}
