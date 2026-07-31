const DATABASE_NAME = "heuknalssi-photo-journal-v1";
const DATABASE_VERSION = 1;
const PHOTO_STORE = "photos";
const SEASON_STORE = "seasons";
export const LOCAL_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const MIN_BRIGHTNESS = 0.16;
const MAX_BRIGHTNESS = 0.88;
const MAX_CLIPPED_RATIO = 0.65;
const MIN_SHARPNESS = 0.002;
const MIN_SUBJECT_RATIO = 0.25;
const MAX_SUBJECT_RATIO = 0.9;

export function createLocalPhotoJournal({ indexedDBImpl = globalThis.indexedDB } = {}) {
  if (!indexedDBImpl) return null;

  async function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(DATABASE_NAME, DATABASE_VERSION);
      request.onerror = () => reject(request.error ?? new Error("photo database open failed"));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PHOTO_STORE)) {
          const store = db.createObjectStore(PHOTO_STORE, { keyPath: "photoId" });
          store.createIndex("scope", "scopeKey", { unique: false });
        }
        if (!db.objectStoreNames.contains(SEASON_STORE)) {
          db.createObjectStore(SEASON_STORE, { keyPath: "scopeKey" });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  async function transact(storeName, mode, operation) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let value;
        try {
          value = operation(store);
        } catch (error) {
          reject(error);
          return;
        }
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = () => reject(transaction.error ?? new Error("photo transaction failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("photo transaction aborted"));
      });
    } finally {
      db.close();
    }
  }

  return Object.freeze({
    async addPhoto({ scope, file, observedAt, growthStage = null, note = null, visualSignals = null }) {
      const normalized = normalizeScope(scope);
      assertLocalPhotoFile(file);
      const photo = {
        photoId: globalThis.crypto?.randomUUID?.() ?? `photo-${Date.now()}`,
        ...normalized,
        scopeKey: scopeKey(normalized),
        observedAt: requireDate(observedAt),
        createdAt: new Date().toISOString(),
        growthStage: nullableText(growthStage),
        note: nullableText(note),
        consentState: "GRANTED",
        fileName: typeof file.name === "string" ? file.name.slice(0, 120) : "photo",
        mimeType: file.type,
        size: file.size,
        visualSignals: normalizeVisualSignals(visualSignals),
        blob: file,
      };
      await transact(PHOTO_STORE, "readwrite", (store) => store.add(photo));
      return withoutBlob(photo);
    },

    async listPhotos(scope) {
      const key = scopeKey(normalizeScope(scope));
      const rows = await readAllByIndex(await database(), PHOTO_STORE, "scope", key);
      return rows.sort((left, right) =>
        String(left.observedAt).localeCompare(String(right.observedAt)),
      );
    },

    async deletePhoto(scope, photoId) {
      const normalized = normalizeScope(scope);
      const existing = await this.getPhoto(photoId);
      if (!existing || existing.scopeKey !== scopeKey(normalized)) return false;
      await transact(PHOTO_STORE, "readwrite", (store) => store.delete(photoId));
      return true;
    },

    async getPhoto(photoId) {
      const db = await database();
      try {
        return await requestValue(db.transaction(PHOTO_STORE).objectStore(PHOTO_STORE).get(photoId));
      } finally {
        db.close();
      }
    },

    async completeSeason(scope, { completedActionCount = 0 } = {}) {
      const normalized = normalizeScope(scope);
      const record = {
        ...normalized,
        scopeKey: scopeKey(normalized),
        status: "COMPLETED",
        completedAt: new Date().toISOString(),
        completedActionCount: Number.isInteger(completedActionCount) && completedActionCount >= 0
          ? completedActionCount
          : 0,
      };
      await transact(SEASON_STORE, "readwrite", (store) => store.put(record));
      return record;
    },

    async getSeason(scope) {
      const normalized = normalizeScope(scope);
      const db = await database();
      try {
        return await requestValue(
          db.transaction(SEASON_STORE).objectStore(SEASON_STORE).get(scopeKey(normalized)),
        );
      } finally {
        db.close();
      }
    },
  });
}

export function compareVisualSignals(previous, current) {
  const before = normalizeVisualSignals(previous);
  const after = normalizeVisualSignals(current);
  if (!before || !after) return [];
  return [
    signalChange("평균 밝기", before.brightness, after.brightness),
    signalChange("초록색 비율", before.greenRatio, after.greenRatio),
    signalChange("노란색 비율", before.yellowRatio, after.yellowRatio),
  ].filter(Boolean);
}

export function assertLocalPhotoFile(file) {
  if (!(file instanceof Blob) || !file.type.startsWith("image/")) {
    throw new TypeError("이미지 파일이 필요합니다.");
  }
  if (file.size > LOCAL_PHOTO_MAX_BYTES) {
    throw new RangeError("사진은 10MB 이하 이미지만 저장할 수 있습니다.");
  }
}

export function analyzePhotoPixels(imageData, { subjectBounds = null } = {}) {
  const width = Number(imageData?.width);
  const height = Number(imageData?.height);
  const data = imageData?.data;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 3 ||
    height < 3 ||
    !data ||
    typeof data.length !== "number" ||
    data.length < width * height * 4
  ) {
    throw new TypeError("valid browser image pixels are required");
  }

  const luminance = new Float64Array(width * height);
  let brightness = 0;
  let green = 0;
  let yellow = 0;
  let shadowClipped = 0;
  let highlightClipped = 0;
  const count = width * height;

  for (let pixel = 0; pixel < count; pixel += 1) {
    const offset = pixel * 4;
    const red = data[offset] / 255;
    const greenValue = data[offset + 1] / 255;
    const blue = data[offset + 2] / 255;
    const light = 0.2126 * red + 0.7152 * greenValue + 0.0722 * blue;
    luminance[pixel] = light;
    brightness += light;
    if (light <= 0.04) shadowClipped += 1;
    if (light >= 0.96) highlightClipped += 1;
    if (greenValue > red * 1.08 && greenValue > blue * 1.08) green += 1;
    if (
      red > 0.35 &&
      greenValue > 0.32 &&
      blue < Math.min(red, greenValue) * 0.72
    ) {
      yellow += 1;
    }
  }

  let laplacianEnergy = 0;
  let interiorCount = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const laplacian =
        4 * luminance[index] -
        luminance[index - 1] -
        luminance[index + 1] -
        luminance[index - width] -
        luminance[index + width];
      laplacianEnergy += laplacian * laplacian;
      interiorCount += 1;
    }
  }

  const subjectRatio = subjectBoundsRatio(subjectBounds, width, height);
  return {
    brightness: roundSignal(brightness / count),
    greenRatio: roundSignal(green / count),
    yellowRatio: roundSignal(yellow / count),
    shadowClipRatio: roundSignal(shadowClipped / count),
    highlightClipRatio: roundSignal(highlightClipped / count),
    sharpness: roundSignal(Math.min(1, laplacianEnergy / interiorCount)),
    subjectRatio,
    subjectRatioSource: subjectRatio === null ? null : "USER_BOUNDS",
  };
}

export function assessPhotoQuality(value) {
  const signals = normalizeQualitySignals(value);
  if (!signals) {
    const issues = [qualityIssue("QUALITY_SIGNALS_MISSING")];
    return qualityResult(issues);
  }

  const issues = [];
  if (
    signals.brightness < MIN_BRIGHTNESS ||
    signals.shadowClipRatio > MAX_CLIPPED_RATIO
  ) {
    issues.push(qualityIssue("TOO_DARK"));
  } else if (
    signals.brightness > MAX_BRIGHTNESS ||
    signals.highlightClipRatio > MAX_CLIPPED_RATIO
  ) {
    issues.push(qualityIssue("TOO_BRIGHT"));
  }
  if (signals.sharpness < MIN_SHARPNESS) {
    issues.push(qualityIssue("POSSIBLE_SHAKE"));
  }
  if (signals.subjectRatio === null && !signals.subjectConfirmed) {
    issues.push(qualityIssue("SUBJECT_CONFIRMATION_REQUIRED"));
  } else if (signals.subjectRatio !== null && signals.subjectRatio < MIN_SUBJECT_RATIO) {
    issues.push(qualityIssue("SUBJECT_TOO_SMALL"));
  } else if (signals.subjectRatio !== null && signals.subjectRatio > MAX_SUBJECT_RATIO) {
    issues.push(qualityIssue("SUBJECT_TOO_LARGE"));
  }
  return qualityResult(issues);
}

export function reviewPhotoComparison(previous, current) {
  const previousQuality = assessPhotoQuality(previous);
  const currentQuality = assessPhotoQuality(current);
  const issues = [
    ...previousQuality.issues.map((issue) => ({ ...issue, photo: "PREVIOUS" })),
    ...currentQuality.issues.map((issue) => ({ ...issue, photo: "CURRENT" })),
  ];
  if (issues.length > 0) {
    return {
      ready: false,
      changes: [],
      issues,
      message: [...new Set(issues.map(({ guidance }) => guidance))].join(" "),
    };
  }
  return {
    ready: true,
    changes: compareVisualSignals(previous, current),
    issues: [],
    message: "두 사진의 화면상 변화를 비교할 수 있습니다.",
  };
}

function signalChange(label, before, after) {
  const difference = after - before;
  if (Math.abs(difference) < 0.04) return { label, direction: "SIMILAR", difference };
  return { label, direction: difference > 0 ? "INCREASED" : "DECREASED", difference };
}

function normalizeVisualSignals(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of ["brightness", "greenRatio", "yellowRatio"]) {
    const number = Number(value[key]);
    if (!Number.isFinite(number) || number < 0 || number > 1) return null;
    result[key] = Math.round(number * 10_000) / 10_000;
  }
  for (const key of [
    "shadowClipRatio",
    "highlightClipRatio",
    "sharpness",
    "subjectRatio",
  ]) {
    if (value[key] === undefined || value[key] === null) continue;
    const number = Number(value[key]);
    if (!Number.isFinite(number) || number < 0 || number > 1) return null;
    result[key] = roundSignal(number);
  }
  result.subjectConfirmed = value.subjectConfirmed === true;
  result.subjectRatioSource =
    value.subjectRatioSource === "USER_BOUNDS" ? "USER_BOUNDS" : null;
  return result;
}

function normalizeQualitySignals(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of [
    "brightness",
    "shadowClipRatio",
    "highlightClipRatio",
    "sharpness",
  ]) {
    if (value[key] === undefined || value[key] === null) return null;
    const number = Number(value[key]);
    if (!Number.isFinite(number) || number < 0 || number > 1) return null;
    result[key] = number;
  }
  if (
    value.subjectRatioSource !== "USER_BOUNDS" ||
    value.subjectRatio === undefined ||
    value.subjectRatio === null
  ) {
    result.subjectRatio = null;
    result.subjectRatioSource = null;
  } else {
    const subjectRatio = Number(value.subjectRatio);
    if (!Number.isFinite(subjectRatio) || subjectRatio < 0 || subjectRatio > 1) {
      return null;
    }
    result.subjectRatio = subjectRatio;
    result.subjectRatioSource = "USER_BOUNDS";
  }
  result.subjectConfirmed = value.subjectConfirmed === true;
  return result;
}

function qualityIssue(code) {
  const descriptions = {
    QUALITY_SIGNALS_MISSING: {
      message: "사진 품질 정보를 확인하지 못했습니다.",
      guidance: "사진을 다시 선택한 뒤 비교해 주세요.",
    },
    TOO_DARK: {
      message: "사진이 너무 어두워 화면상 변화를 비교하기 어렵습니다.",
      guidance: "조금 더 밝은 곳에서 같은 대상을 다시 촬영해 주세요.",
    },
    TOO_BRIGHT: {
      message: "사진의 밝은 부분이 많이 뭉개져 화면상 변화를 비교하기 어렵습니다.",
      guidance: "강한 역광과 반사를 피해 같은 대상을 다시 촬영해 주세요.",
    },
    POSSIBLE_SHAKE: {
      message: "사진이 흔들렸거나 초점이 흐린 것처럼 보입니다.",
      guidance: "휴대전화를 고정하고 화면을 눌러 초점을 맞춘 뒤 다시 촬영해 주세요.",
    },
    SUBJECT_CONFIRMATION_REQUIRED: {
      message: "작물이 화면 중앙을 충분히 채웠는지 확인이 필요합니다.",
      guidance: "작물을 화면 중앙 안내선 안에 놓고 확인 항목을 선택해 주세요.",
    },
    SUBJECT_TOO_SMALL: {
      message: "비교할 대상이 화면에서 너무 작습니다.",
      guidance: "비교할 대상이 화면의 4분의 1 이상을 채우도록 가까이 촬영해 주세요.",
    },
    SUBJECT_TOO_LARGE: {
      message: "비교할 대상의 가장자리가 화면 밖으로 잘릴 수 있습니다.",
      guidance: "대상의 전체 모양이 보이도록 조금 떨어져 다시 촬영해 주세요.",
    },
  };
  return { code, ...descriptions[code] };
}

function qualityResult(issues) {
  return {
    ready: issues.length === 0,
    issues,
    message: issues.length
      ? [...new Set(issues.map(({ guidance }) => guidance))].join(" ")
      : "밝기, 선명도, 화면 비율이 비교 가능한 범위입니다.",
  };
}

function subjectBoundsRatio(bounds, frameWidth, frameHeight) {
  if (!bounds || typeof bounds !== "object") return null;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const left = Math.max(0, Math.min(frameWidth, x));
  const top = Math.max(0, Math.min(frameHeight, y));
  const right = Math.max(left, Math.min(frameWidth, x + width));
  const bottom = Math.max(top, Math.min(frameHeight, y + height));
  return roundSignal(((right - left) * (bottom - top)) / (frameWidth * frameHeight));
}

function roundSignal(value) {
  return Math.round(value * 10_000) / 10_000;
}

function normalizeScope(scope) {
  const result = {};
  for (const field of ["farmId", "cropId", "seasonId"]) {
    if (typeof scope?.[field] !== "string" || !scope[field].trim()) {
      throw new TypeError(`${field} is required`);
    }
    result[field] = scope[field].trim();
  }
  return result;
}

function scopeKey(scope) {
  return JSON.stringify([scope.farmId, scope.cropId, scope.seasonId]);
}

function requireDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("observedAt must be a date");
  return date.toISOString();
}

function nullableText(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
}

function withoutBlob(photo) {
  const { blob: _blob, ...metadata } = photo;
  return metadata;
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error ?? new Error("photo request failed"));
  });
}

function readAllByIndex(db, storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName);
    const request = transaction.objectStore(storeName).index(indexName).getAll(value);
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error ?? new Error("photo list failed"));
    transaction.oncomplete = () => db.close();
  });
}
