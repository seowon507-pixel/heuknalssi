import { createHash, randomInt } from "node:crypto";

import { createSupabaseServerHeaders } from "./supabase-server-headers.js";

/**
 * 기기 간 데이터 이관.
 *
 * 사용자가 발급받은 계정키로만 조회되는 백업을 저장한다. 계정키 원문은
 * 서버에도 DB에도 남기지 않고 SHA-256 해시만 보관하므로, 저장소가 통째로
 * 유출돼도 키를 되돌릴 수 없다. 키를 잃어버리면 복구할 수 없다는 뜻이기도
 * 해서 화면에서 그렇게 안내한다.
 */

// 사람이 받아 적을 키라서 0/O, 1/I/L 처럼 헷갈리는 글자는 뺀다.
const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const KEY_GROUPS = 3;
const KEY_GROUP_SIZE = 4;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const ALLOWED_PAYLOAD_KEYS = Object.freeze(["soilTest", "region", "savedAt"]);

export class DeviceBackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeviceBackupError";
    this.code = code;
  }
}

export function generateAccountKey(randomIntImpl = randomInt) {
  const groups = [];
  for (let group = 0; group < KEY_GROUPS; group += 1) {
    let chunk = "";
    for (let index = 0; index < KEY_GROUP_SIZE; index += 1) {
      chunk += KEY_ALPHABET[randomIntImpl(0, KEY_ALPHABET.length)];
    }
    groups.push(chunk);
  }
  return groups.join("-");
}

/** 입력된 키에서 구분선·대소문자 차이를 흡수한다. */
export function normalizeAccountKey(value) {
  const compact = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "");
  if (compact.length !== KEY_GROUPS * KEY_GROUP_SIZE) {
    throw new DeviceBackupError(
      "INVALID_ACCOUNT_KEY",
      "account key must contain 12 key characters",
    );
  }
  if ([...compact].some((character) => !KEY_ALPHABET.includes(character))) {
    throw new DeviceBackupError(
      "INVALID_ACCOUNT_KEY",
      "account key contains unsupported characters",
    );
  }
  const groups = [];
  for (let index = 0; index < compact.length; index += KEY_GROUP_SIZE) {
    groups.push(compact.slice(index, index + KEY_GROUP_SIZE));
  }
  return groups.join("-");
}

export function hashAccountKey(accountKey) {
  return createHash("sha256")
    .update(`heuknalssi-device-backup:${normalizeAccountKey(accountKey)}`)
    .digest("hex");
}

/** 임의의 데이터가 서버에 쌓이지 않도록 알려진 키와 크기만 통과시킨다. */
export function assertStorablePayload(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DeviceBackupError("INVALID_PAYLOAD", "payload must be an object");
  }
  const unknown = Object.keys(payload).filter(
    (key) => !ALLOWED_PAYLOAD_KEYS.includes(key),
  );
  if (unknown.length > 0) {
    throw new DeviceBackupError(
      "INVALID_PAYLOAD",
      `payload contains unsupported fields: ${unknown.join(", ")}`,
    );
  }
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new DeviceBackupError("PAYLOAD_TOO_LARGE", "payload is too large");
  }
  return payload;
}

export function createDeviceBackupStore({
  url,
  serviceKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 6000,
  now = Date.now,
} = {}) {
  const configured =
    typeof url === "string" &&
    url.trim() !== "" &&
    typeof serviceKey === "string" &&
    serviceKey.trim() !== "";
  // 테이블을 직접 부르지 않고 SECURITY DEFINER 함수만 호출한다.
  // 테이블에는 RLS 정책이 없어서 목록 조회 자체가 불가능하다.
  const endpoint = configured
    ? `${url.trim().replace(/\/$/u, "")}/rest/v1/rpc`
    : null;

  async function callRpc(name, args) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}/${name}`, {
        method: "POST",
        body: JSON.stringify(args),
        signal: controller.signal,
        headers: createSupabaseServerHeaders(serviceKey),
      });
      if (!response.ok) {
        throw new DeviceBackupError(
          "BACKUP_STORE_ERROR",
          `backup store responded with ${response.status}`,
        );
      }
      const text = await response.text();
      return text === "" ? null : JSON.parse(text);
    } catch (error) {
      if (error instanceof DeviceBackupError) throw error;
      throw new DeviceBackupError(
        "BACKUP_STORE_UNAVAILABLE",
        "backup store is unreachable",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    configured,

    async save(accountKey, payload) {
      if (!configured) {
        throw new DeviceBackupError(
          "BACKUP_NOT_CONFIGURED",
          "device backup storage is not configured",
        );
      }
      assertStorablePayload(payload);
      const savedAt = await callRpc("save_device_backup", {
        p_key_hash: hashAccountKey(accountKey),
        p_payload: payload,
      });
      return { savedAt: savedAt ?? new Date(now()).toISOString() };
    },

    async load(accountKey) {
      if (!configured) {
        throw new DeviceBackupError(
          "BACKUP_NOT_CONFIGURED",
          "device backup storage is not configured",
        );
      }
      const rows = await callRpc("load_device_backup", {
        p_key_hash: hashAccountKey(accountKey),
      });
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) {
        throw new DeviceBackupError("BACKUP_NOT_FOUND", "no backup for this key");
      }
      return { payload: row.payload, savedAt: row.updated_at ?? null };
    },
  });
}
