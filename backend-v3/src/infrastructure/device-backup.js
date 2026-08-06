import { createHash, randomInt, randomUUID } from "node:crypto";

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
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_FARMS = 12;
const SUPPORTED_CROPS = new Set([
  "APPLE",
  "PEAR",
  "CUCUMBER",
  "POTATO",
  "LETTUCE",
]);
const MAX_SUPPORTED_CROPS = SUPPORTED_CROPS.size;
const SUPPORTED_SITUATIONS = new Set(["planning", "growing"]);
const CYCLE_ANCHOR_TYPES = new Set([
  "SOWING",
  "TRANSPLANTING",
  "FLOWERING",
  "SEASON_START",
]);
const CYCLE_STATUSES = new Set([
  "PLANNING",
  "ACTIVE",
  "HARVEST_WINDOW",
  "COMPLETED",
]);
const ALLOWED_PAYLOAD_KEYS = Object.freeze([
  "version",
  "soilTest",
  "soilTestsByFarmId",
  "region",
  "farms",
  "activeFarmId",
  "alarm",
  "todo",
  "savedAt",
]);

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
  if (payload.version !== undefined && payload.version !== 2) {
    throw new DeviceBackupError(
      "INVALID_PAYLOAD",
      "payload version is unsupported",
    );
  }
  if (payload.region !== undefined) {
    requireBoundedText(payload.region, "region", 200);
  }
  if (payload.farms !== undefined) validateFarms(payload.farms);
  if (payload.activeFarmId !== undefined) {
    const activeFarmId = requireBoundedText(
      payload.activeFarmId,
      "activeFarmId",
      160,
    );
    if (
      !Array.isArray(payload.farms) ||
      !payload.farms.some((farm) => farm.id === activeFarmId)
    ) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        "activeFarmId must reference a stored farm",
      );
    }
  }
  for (const field of ["soilTest", "alarm", "todo"]) {
    if (
      payload[field] !== undefined &&
      (payload[field] === null ||
        typeof payload[field] !== "object" ||
        Array.isArray(payload[field]))
    ) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `${field} must be an object`,
      );
    }
  }
  if (payload.soilTestsByFarmId !== undefined) {
    validateScopedSoilTests(payload.soilTestsByFarmId, payload.farms);
  }
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new DeviceBackupError("PAYLOAD_TOO_LARGE", "payload is too large");
  }
  return payload;
}

function validateScopedSoilTests(value, farms) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeviceBackupError(
      "INVALID_PAYLOAD",
      "soilTestsByFarmId must be an object",
    );
  }
  const farmIds = new Set(Array.isArray(farms) ? farms.map(({ id }) => id) : []);
  const entries = Object.entries(value);
  if (entries.length > MAX_FARMS) {
    throw new DeviceBackupError(
      "INVALID_PAYLOAD",
      `soilTestsByFarmId must contain at most ${MAX_FARMS} items`,
    );
  }
  for (const [farmId, soilTest] of entries) {
    requireBoundedText(farmId, "soilTestsByFarmId key", 160);
    if (!farmIds.has(farmId)) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        "soilTestsByFarmId must reference a stored farm",
      );
    }
    if (!soilTest || typeof soilTest !== "object" || Array.isArray(soilTest) || !Number.isFinite(soilTest.ph)) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `soilTestsByFarmId.${farmId} must contain a numeric ph`,
      );
    }
    const allowedFields = new Set([
      "ph",
      "electricalConductivity",
      "organicMatter",
      "availablePhosphate",
      "exchangeableK",
      "exchangeableCa",
      "exchangeableMg",
      "sampledOn",
      "issuer",
      "userConfirmed",
    ]);
    if (Object.keys(soilTest).some((field) => !allowedFields.has(field))) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `soilTestsByFarmId.${farmId} contains unsupported fields`,
      );
    }
    if (soilTest.ph < 0 || soilTest.ph > 14) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `soilTestsByFarmId.${farmId}.ph is out of range`,
      );
    }
    for (const field of [
      "electricalConductivity",
      "organicMatter",
      "availablePhosphate",
      "exchangeableK",
      "exchangeableCa",
      "exchangeableMg",
    ]) {
      if (soilTest[field] !== undefined && !Number.isFinite(soilTest[field])) {
        throw new DeviceBackupError(
          "INVALID_PAYLOAD",
          `soilTestsByFarmId.${farmId}.${field} must be numeric`,
        );
      }
    }
    if (soilTest.sampledOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(soilTest.sampledOn)) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `soilTestsByFarmId.${farmId}.sampledOn is invalid`,
      );
    }
    if (soilTest.issuer !== undefined) {
      requireBoundedText(soilTest.issuer, `soilTestsByFarmId.${farmId}.issuer`, 120);
    }
    if (soilTest.userConfirmed !== undefined && typeof soilTest.userConfirmed !== "boolean") {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `soilTestsByFarmId.${farmId}.userConfirmed must be boolean`,
      );
    }
  }
}

function validateFarms(farms) {
  if (!Array.isArray(farms) || farms.length > MAX_FARMS) {
    throw new DeviceBackupError(
      "INVALID_PAYLOAD",
      `farms must contain at most ${MAX_FARMS} items`,
    );
  }
  const ids = new Set();
  for (const [index, farm] of farms.entries()) {
    if (farm === null || typeof farm !== "object" || Array.isArray(farm)) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `farms[${index}] must be an object`,
      );
    }
    const allowed = new Set([
      "id",
      "name",
      "updatedAt",
      "situation",
      "crops",
      "cropSettings",
      "region",
    ]);
    if (Object.keys(farm).some((key) => !allowed.has(key))) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `farms[${index}] contains unsupported fields`,
      );
    }
    const id = requireBoundedText(farm.id, `farms[${index}].id`, 160);
    if (ids.has(id)) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `farms[${index}].id is duplicated`,
      );
    }
    ids.add(id);
    requireBoundedText(farm.name, `farms[${index}].name`, 200);
    requireBoundedText(farm.region, `farms[${index}].region`, 200);
    if (!SUPPORTED_SITUATIONS.has(farm.situation)) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `farms[${index}].situation is unsupported`,
      );
    }
    if (
      !Array.isArray(farm.crops) ||
      farm.crops.length === 0 ||
      farm.crops.length > MAX_SUPPORTED_CROPS ||
      farm.crops.some((crop) =>
        typeof crop !== "string" || !SUPPORTED_CROPS.has(crop.toUpperCase())
      ) ||
      new Set(farm.crops.map((crop) => crop.toUpperCase())).size !== farm.crops.length
    ) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `farms[${index}].crops is invalid`,
      );
    }
    if (
      farm.cropSettings === null ||
      typeof farm.cropSettings !== "object" ||
      Array.isArray(farm.cropSettings)
    ) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `farms[${index}].cropSettings must be an object`,
      );
    }
    validateCropSettings(farm.cropSettings, farm.crops, index);
    if (
      typeof farm.updatedAt !== "string" ||
      Number.isNaN(Date.parse(farm.updatedAt))
    ) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `farms[${index}].updatedAt is invalid`,
      );
    }
  }
}

function validateCropSettings(settings, crops, farmIndex) {
  const supportedKeys = new Set(crops.flatMap((crop) => [crop, crop.toLowerCase()]));
  const entries = Object.entries(settings);
  if (entries.some(([crop]) => !supportedKeys.has(crop))) {
    throw new DeviceBackupError(
      "INVALID_PAYLOAD",
      `farms[${farmIndex}].cropSettings contains an unsupported crop`,
    );
  }
  const allowedSettingFields = new Set([
    "cultivation",
    "season",
    "growth",
    "cultivationMode",
    "growthStage",
    "seasonProfile",
    "cycle",
  ]);
  for (const [crop, setting] of entries) {
    if (setting === null || typeof setting !== "object" || Array.isArray(setting)) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `farms[${farmIndex}].cropSettings.${crop} must be an object`,
      );
    }
    if (Object.keys(setting).some((field) => !allowedSettingFields.has(field))) {
      throw new DeviceBackupError(
        "INVALID_PAYLOAD",
        `farms[${farmIndex}].cropSettings.${crop} contains unsupported fields`,
      );
    }
    for (const field of [
      "cultivation",
      "season",
      "growth",
      "cultivationMode",
      "growthStage",
      "seasonProfile",
    ]) {
      if (setting[field] !== undefined) {
        requireBoundedText(
          setting[field],
          `farms[${farmIndex}].cropSettings.${crop}.${field}`,
          80,
        );
      }
    }
    if (setting.cycle !== undefined) {
      validateCropCycle(setting.cycle, `farms[${farmIndex}].cropSettings.${crop}.cycle`);
    }
  }
}

function validateCropCycle(cycle, field) {
  if (cycle === null || typeof cycle !== "object" || Array.isArray(cycle)) {
    throw new DeviceBackupError("INVALID_PAYLOAD", `${field} must be an object`);
  }
  const allowed = new Set([
    "seasonId",
    "anchorType",
    "anchorDate",
    "status",
    "userConfirmed",
  ]);
  if (Object.keys(cycle).some((key) => !allowed.has(key))) {
    throw new DeviceBackupError(
      "INVALID_PAYLOAD",
      `${field} contains unsupported fields`,
    );
  }
  requireBoundedText(cycle.seasonId, `${field}.seasonId`, 160);
  if (!CYCLE_ANCHOR_TYPES.has(cycle.anchorType)) {
    throw new DeviceBackupError(
      "INVALID_PAYLOAD",
      `${field}.anchorType is unsupported`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(cycle.anchorDate ?? "")) ||
      Number.isNaN(Date.parse(`${cycle.anchorDate}T00:00:00Z`))) {
    throw new DeviceBackupError(
      "INVALID_PAYLOAD",
      `${field}.anchorDate is invalid`,
    );
  }
  if (!CYCLE_STATUSES.has(cycle.status)) {
    throw new DeviceBackupError(
      "INVALID_PAYLOAD",
      `${field}.status is unsupported`,
    );
  }
  if (cycle.userConfirmed !== undefined && typeof cycle.userConfirmed !== "boolean") {
    throw new DeviceBackupError(
      "INVALID_PAYLOAD",
      `${field}.userConfirmed must be boolean`,
    );
  }
}

function requireBoundedText(value, field, maximum) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maximum
  ) {
    throw new DeviceBackupError(
      "INVALID_PAYLOAD",
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

export function createDeviceBackupStore({
  url,
  serviceKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 6000,
  now = Date.now,
  probeId = randomUUID,
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

  if (typeof probeId !== "function") {
    throw new TypeError("device backup probeId must be a function");
  }

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

    async probe() {
      if (!configured) {
        return {
          ready: false,
          state: "NOT_CONFIGURED",
          verifiedAt: null,
        };
      }
      const keyHash = createHash("sha256")
        .update(`heuknalssi-device-backup-probe:${probeId()}`, "utf8")
        .digest("hex");
      try {
        const ready = await callRpc("heuknalssi_device_backup_probe", {
          p_key_hash: keyHash,
        });
        return ready === true
          ? {
              ready: true,
              state: "READY",
              verifiedAt: new Date(now()).toISOString(),
            }
          : {
              ready: false,
              state: "PROBE_FAILED",
              verifiedAt: null,
            };
      } catch {
        return {
          ready: false,
          state: "UNAVAILABLE",
          verifiedAt: null,
        };
      }
    },

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
