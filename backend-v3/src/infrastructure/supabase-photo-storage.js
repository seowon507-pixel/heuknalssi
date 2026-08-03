import { createHash, randomUUID } from "node:crypto";

import { createSupabaseServerHeaders } from "./supabase-server-headers.js";

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const UPLOAD_TOKEN_TTL_MS = 10 * 60 * 1_000;
const MIME_EXTENSIONS = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});

export class PhotoStorageError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "PhotoStorageError";
    this.code = code;
  }
}

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    throw new PhotoStorageError(
      "PHOTO_UPLOAD_INVALID",
      `${field} must be a non-empty string`,
    );
  }
  return value.trim();
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function assertStore(store) {
  for (const method of ["get", "setIfAbsent", "compareAndSet", "delete"]) {
    if (typeof store?.[method] !== "function") {
      throw new TypeError(`photo upload store.${method} is required`);
    }
  }
}

function decodeBase64(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    throw new PhotoStorageError(
      "PHOTO_UPLOAD_INVALID",
      "photo data must be canonical base64",
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_PHOTO_BYTES ||
    bytes.toString("base64") !== value
  ) {
    throw new PhotoStorageError(
      bytes.length > MAX_PHOTO_BYTES
        ? "PHOTO_UPLOAD_TOO_LARGE"
        : "PHOTO_UPLOAD_INVALID",
      "photo data is invalid or exceeds 10MB",
    );
  }
  return bytes;
}

function storageUrl(baseUrl, bucket, objectPath) {
  const encoded = objectPath.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encoded}`;
}

async function ensureOk(response, { allowNotFound = false } = {}) {
  if (!response || typeof response.ok !== "boolean") {
    throw new PhotoStorageError(
      "PHOTO_STORAGE_UNAVAILABLE",
      "photo storage returned an invalid response",
    );
  }
  if (!response.ok && !(allowNotFound && response.status === 404)) {
    throw new PhotoStorageError(
      "PHOTO_STORAGE_REJECTED",
      "photo storage rejected the operation",
    );
  }
}

/**
 * Server-only private Supabase Storage adapter. The browser sends image bytes
 * to the API and receives only a one-use opaque token. Private object paths
 * and Supabase credentials never leave the backend.
 */
export function createSupabasePhotoStorage({
  url,
  serviceKey,
  uploadStore,
  fetchImpl = globalThis.fetch,
  bucket = "farm-photos",
  tokenFactory = randomUUID,
} = {}) {
  const configured =
    typeof url === "string" &&
    url.trim() !== "" &&
    typeof serviceKey === "string" &&
    serviceKey.trim() !== "";
  if (typeof fetchImpl !== "function" || typeof tokenFactory !== "function") {
    throw new TypeError("fetchImpl and tokenFactory must be functions");
  }
  assertStore(uploadStore);
  const baseUrl = configured ? url.trim().replace(/\/$/u, "") : null;

  function assertConfigured() {
    if (!configured) {
      throw new PhotoStorageError(
        "PHOTO_STORAGE_NOT_CONFIGURED",
        "photo storage is not configured",
      );
    }
  }

  async function deletePath(objectPath) {
    const response = await fetchImpl(storageUrl(baseUrl, bucket, objectPath), {
      method: "DELETE",
      headers: createSupabaseServerHeaders(serviceKey),
      redirect: "error",
    });
    await ensureOk(response, { allowNotFound: true });
  }

  return Object.freeze({
    configured,

    async prepareUpload({
      ownerSessionId,
      farmId,
      cropId,
      seasonId,
      mimeType,
      dataBase64,
    } = {}) {
      assertConfigured();
      const owner = requiredText(ownerSessionId, "ownerSessionId");
      const farm = requiredText(farmId, "farmId");
      const crop = requiredText(cropId, "cropId");
      const season = requiredText(seasonId, "seasonId");
      const mime = requiredText(mimeType, "mimeType");
      const extension = MIME_EXTENSIONS[mime];
      if (!extension) {
        throw new PhotoStorageError(
          "PHOTO_UPLOAD_INVALID",
          "only JPEG, PNG, and WebP photos are supported",
        );
      }
      const bytes = decodeBase64(dataBase64);
      const uploadToken = requiredText(tokenFactory(), "uploadToken");
      const objectPath = [
        "owners",
        digest(owner),
        "farms",
        digest(farm),
        "seasons",
        digest(`${crop}:${season}`),
        `${uploadToken}.${extension}`,
      ].join("/");
      const response = await fetchImpl(storageUrl(baseUrl, bucket, objectPath), {
        method: "POST",
        body: bytes,
        headers: {
          ...createSupabaseServerHeaders(serviceKey),
          "Content-Type": mime,
          "x-upsert": "false",
        },
        redirect: "error",
      });
      await ensureOk(response);

      const record = {
        state: "PREPARED",
        ownerSessionId: owner,
        farmId: farm,
        cropId: crop,
        seasonId: season,
        objectPath,
        mimeType: mime,
        size: bytes.length,
      };
      try {
        const saved = await Promise.resolve(
          uploadStore.setIfAbsent(uploadToken, record, UPLOAD_TOKEN_TTL_MS),
        );
        if (!saved) {
          throw new PhotoStorageError(
            "PHOTO_UPLOAD_CONFLICT",
            "photo upload token already exists",
          );
        }
      } catch (error) {
        await deletePath(objectPath).catch(() => {});
        throw error;
      }
      return {
        uploadToken,
        mimeType: mime,
        size: bytes.length,
      };
    },

    async commitUpload({
      uploadToken,
      photoId,
      ownerSessionId,
      farmId,
      cropId,
      seasonId,
    } = {}) {
      assertConfigured();
      const token = requiredText(uploadToken, "uploadToken");
      const current = await Promise.resolve(uploadStore.get(token));
      if (!current || current.state !== "PREPARED") {
        throw new PhotoStorageError(
          "PHOTO_UPLOAD_TOKEN_INVALID",
          "photo upload token is missing, expired, or already consumed",
        );
      }
      const expected = {
        ownerSessionId: requiredText(ownerSessionId, "ownerSessionId"),
        farmId: requiredText(farmId, "farmId"),
        cropId: requiredText(cropId, "cropId"),
        seasonId: requiredText(seasonId, "seasonId"),
      };
      for (const [field, value] of Object.entries(expected)) {
        if (current[field] !== value) {
          throw new PhotoStorageError(
            "PHOTO_UPLOAD_SCOPE_MISMATCH",
            "photo upload token does not belong to this farm season",
          );
        }
      }
      const committed = {
        ...current,
        state: "COMMITTED",
        photoId: requiredText(photoId, "photoId"),
      };
      const changed = await Promise.resolve(
        uploadStore.compareAndSet(
          token,
          current,
          committed,
          UPLOAD_TOKEN_TTL_MS,
        ),
      );
      if (!changed) {
        throw new PhotoStorageError(
          "PHOTO_UPLOAD_CONFLICT",
          "photo upload token was consumed by another request",
        );
      }
      return {
        objectPath: current.objectPath,
        thumbnailPath: null,
      };
    },

    async deleteObjects({ ownerSessionId, objectPaths = [] } = {}) {
      assertConfigured();
      const ownerPrefix = `owners/${digest(
        requiredText(ownerSessionId, "ownerSessionId"),
      )}/`;
      if (
        !Array.isArray(objectPaths) ||
        objectPaths.some(
          (path) =>
            typeof path !== "string" ||
            !path.startsWith(ownerPrefix) ||
            path.includes(".."),
        )
      ) {
        throw new PhotoStorageError(
          "PHOTO_STORAGE_SCOPE_MISMATCH",
          "photo object path is outside the account scope",
        );
      }
      await Promise.all([...new Set(objectPaths)].map(deletePath));
    },
  });
}

export const supabasePhotoStorageDefaults = Object.freeze({
  bucket: "farm-photos",
  maxPhotoBytes: MAX_PHOTO_BYTES,
  uploadTokenTtlMs: UPLOAD_TOKEN_TTL_MS,
});
