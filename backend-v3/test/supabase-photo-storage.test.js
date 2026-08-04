import assert from "node:assert/strict";
import test from "node:test";

import {
  TtlMemoryStore,
  createSupabasePhotoStorage,
} from "../src/infrastructure/index.js";

const SCOPE = Object.freeze({
  ownerSessionId: "owner-a",
  farmId: "farm-1",
  cropId: "APPLE",
  seasonId: "season-1",
});

function response(status = 200) {
  return { ok: status >= 200 && status < 300, status };
}

test("private photo upload returns a one-use token without object paths", async () => {
  const requests = [];
  const storage = createSupabasePhotoStorage({
    url: "https://project.supabase.co",
    serviceKey: "sb_secret_fixture",
    uploadStore: new TtlMemoryStore({ capacityPolicy: "reject" }),
    tokenFactory: () => "upload-token-1",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return response();
    },
  });
  const prepared = await storage.prepareUpload({
    ...SCOPE,
    mimeType: "image/jpeg",
    dataBase64: Buffer.from("valid-photo-bytes").toString("base64"),
  });

  assert.deepEqual(prepared, {
    uploadToken: "upload-token-1",
    mimeType: "image/jpeg",
    size: 17,
  });
  assert.equal("objectPath" in prepared, false);
  assert.match(requests[0].url, /\/storage\/v1\/object\/farm-photos\//u);
  assert.equal(requests[0].url.includes("owner-a"), false);
  assert.equal(requests[0].init.headers.apikey, "sb_secret_fixture");
  assert.equal("Authorization" in requests[0].init.headers, false);

  const committed = await storage.commitUpload({
    ...SCOPE,
    uploadToken: prepared.uploadToken,
    photoId: "photo-1",
  });
  assert.match(committed.objectPath, /^owners\/[a-f0-9]{24}\//u);
  await assert.rejects(
    () =>
      storage.commitUpload({
        ...SCOPE,
        uploadToken: prepared.uploadToken,
        photoId: "photo-2",
      }),
    (error) => error?.code === "PHOTO_UPLOAD_TOKEN_INVALID",
  );
});

test("photo token cannot cross an account or farm scope", async () => {
  const storage = createSupabasePhotoStorage({
    url: "https://project.supabase.co",
    serviceKey: "legacy.jwt.fixture",
    uploadStore: new TtlMemoryStore({ capacityPolicy: "reject" }),
    tokenFactory: () => "upload-token-2",
    fetchImpl: async () => response(),
  });
  await storage.prepareUpload({
    ...SCOPE,
    mimeType: "image/png",
    dataBase64: Buffer.from("png-data").toString("base64"),
  });
  await assert.rejects(
    () =>
      storage.commitUpload({
        ...SCOPE,
        ownerSessionId: "owner-b",
        uploadToken: "upload-token-2",
        photoId: "photo-2",
      }),
    (error) => error?.code === "PHOTO_UPLOAD_SCOPE_MISMATCH",
  );
});

test("photo deletion uses the Supabase bulk object endpoint", async () => {
  const requests = [];
  const storage = createSupabasePhotoStorage({
    url: "https://project.supabase.co",
    serviceKey: "sb_secret_fixture",
    uploadStore: new TtlMemoryStore({ capacityPolicy: "reject" }),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return response();
    },
  });

  const ownerSessionId = "owner-delete";
  const storageForPath = createSupabasePhotoStorage({
    url: "https://project.supabase.co",
    serviceKey: "sb_secret_fixture",
    uploadStore: new TtlMemoryStore({ capacityPolicy: "reject" }),
    tokenFactory: () => "upload-token-delete",
    fetchImpl: async () => response(),
  });
  const prepared = await storageForPath.prepareUpload({
    ...SCOPE,
    ownerSessionId,
    mimeType: "image/webp",
    dataBase64: Buffer.from("delete-photo").toString("base64"),
  });
  const committed = await storageForPath.commitUpload({
    ...SCOPE,
    ownerSessionId,
    uploadToken: prepared.uploadToken,
    photoId: "photo-delete",
  });

  await storage.deleteObjects({
    ownerSessionId,
    objectPaths: [committed.objectPath],
  });

  assert.equal(
    requests[0].url,
    "https://project.supabase.co/storage/v1/object/farm-photos",
  );
  assert.equal(requests[0].init.method, "DELETE");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    prefixes: [committed.objectPath],
  });
});

test("photo storage rejects unsupported files before a provider request", async () => {
  let calls = 0;
  const storage = createSupabasePhotoStorage({
    url: "https://project.supabase.co",
    serviceKey: "sb_secret_fixture",
    uploadStore: new TtlMemoryStore({ capacityPolicy: "reject" }),
    fetchImpl: async () => {
      calls += 1;
      return response();
    },
  });
  await assert.rejects(
    () =>
      storage.prepareUpload({
        ...SCOPE,
        mimeType: "image/svg+xml",
        dataBase64: Buffer.from("<svg/>").toString("base64"),
      }),
    (error) => error?.code === "PHOTO_UPLOAD_INVALID",
  );
  assert.equal(calls, 0);
});

test("photo upload treats a provider 404 as a failure", async () => {
  const storage = createSupabasePhotoStorage({
    url: "https://project.supabase.co",
    serviceKey: "sb_secret_fixture",
    uploadStore: new TtlMemoryStore({ capacityPolicy: "reject" }),
    fetchImpl: async () => response(404),
  });

  await assert.rejects(
    () =>
      storage.prepareUpload({
        ...SCOPE,
        mimeType: "image/jpeg",
        dataBase64: Buffer.from("photo").toString("base64"),
      }),
    (error) => error?.code === "PHOTO_STORAGE_REJECTED",
  );
});
