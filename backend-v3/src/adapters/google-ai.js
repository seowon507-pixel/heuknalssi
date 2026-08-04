import { requestProviderJson } from "./network.js";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CATALOG_ITEMS = 24;
const MAX_SELECTED_ITEMS = 6;
const MAX_HARVEST_PHOTO_BYTES = 6 * 1024 * 1024;
const MODEL_PATTERN = /^gemini-[A-Za-z0-9._-]{1,64}$/;
const HARVEST_CROPS = new Set(["APPLE", "PEAR", "CUCUMBER", "POTATO", "LETTUCE"]);
const HARVEST_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function createGoogleAiSelector({
  enabled = false,
  apiKey = null,
  model = DEFAULT_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now
} = {}) {
  const normalizedKey =
    typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
  const normalizedModel =
    typeof model === "string" && MODEL_PATTERN.test(model)
      ? model
      : DEFAULT_MODEL;
  const ready = enabled === true && Boolean(normalizedKey);

  return Object.freeze({
    state: ready ? "READY" : "FALLBACK",
    model: normalizedModel,

    async select({ intent, catalog, signal, deadlineAt } = {}) {
      if (!ready) {
        throw assistantError("GOOGLE_AI_NOT_CONFIGURED");
      }
      const safeCatalog = normalizeCatalog(catalog);
      if (safeCatalog.length === 0) {
        throw assistantError("GOOGLE_AI_CATALOG_EMPTY");
      }
      const response = await requestProviderJson({
        fetchImpl,
        url:
          `https://generativelanguage.googleapis.com/v1beta/models/` +
          `${encodeURIComponent(normalizedModel)}:generateContent`,
        provider: "GOOGLE_AI",
        requestInit: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": normalizedKey
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text:
                    "You are a selector, not an answer writer. Select only IDs " +
                    "from AVAILABLE_ITEMS that best answer the intent. Never add " +
                    "facts, numbers, causes, diagnoses, treatments, pesticide or " +
                    "fertilizer advice. Return JSON only as " +
                    '{"selectedIds":["ITEM_ID"]}.'
                }
              ]
            },
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: JSON.stringify({
                      intent: normalizeIntent(intent),
                      availableItems: safeCatalog
                    })
                  }
                ]
              }
            ],
            generationConfig: {
              maxOutputTokens: 512,
              responseMimeType: "application/json"
            }
          })
        },
        signal,
        timeoutMs,
        deadlineAt,
        now,
        maxResponseBytes: 32 * 1024
      });
      return validateSelection(response, safeCatalog);
    },

    async assessHarvestPhoto({ cropId, mimeType, dataBase64, signal, deadlineAt } = {}) {
      if (!ready) throw assistantError("GOOGLE_AI_NOT_CONFIGURED");
      const crop = normalizeHarvestCrop(cropId);
      const image = normalizeHarvestImage({ mimeType, dataBase64 });
      const response = await requestProviderJson({
        fetchImpl,
        url:
          `https://generativelanguage.googleapis.com/v1beta/models/` +
          `${encodeURIComponent(normalizedModel)}:generateContent`,
        provider: "GOOGLE_AI",
        requestInit: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": normalizedKey,
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{
                text:
                  "You assess only visible harvest maturity for one supported crop. " +
                  "Do not diagnose disease, identify pesticides, or infer hidden facts. " +
                  "If the crop, harvestable part, scale, focus, or lighting is unclear, " +
                  "return UNCERTAIN and UNUSABLE. READY means visible harvest maturity " +
                  "signals are present; NOT_READY means the crop is clear but visibly " +
                  "immature. Return JSON only with state, quality, confidence, " +
                  "suggestedDelayDays, recheckInDays, and visibleReasons."
              }],
            },
            contents: [{
              role: "user",
              parts: [
                { inlineData: { mimeType: image.mimeType, data: image.dataBase64 } },
                {
                  text: JSON.stringify({
                    cropId: crop,
                    allowedStates: ["READY", "NOT_READY", "UNCERTAIN"],
                    allowedQuality: ["USABLE", "UNUSABLE"],
                    outputLanguage: "Korean",
                    constraints: {
                      confidence: "0..1",
                      suggestedDelayDays: "0..14; zero unless NOT_READY",
                      recheckInDays: "1..7",
                      visibleReasons: "1..3 short observations",
                    },
                  }),
                },
              ],
            }],
            generationConfig: {
              maxOutputTokens: 512,
              responseMimeType: "application/json",
            },
          }),
        },
        signal,
        timeoutMs,
        deadlineAt,
        now,
        maxResponseBytes: 32 * 1024,
      });
      return validateHarvestAssessment(response);
    },
  });
}

function normalizeHarvestCrop(value) {
  const crop = String(value ?? "").trim().toUpperCase();
  if (!HARVEST_CROPS.has(crop)) throw assistantError("HARVEST_CROP_INVALID");
  return crop;
}

function normalizeHarvestImage({ mimeType, dataBase64 }) {
  const mime = String(mimeType ?? "").trim().toLowerCase();
  if (!HARVEST_MIME_TYPES.has(mime)) throw assistantError("HARVEST_PHOTO_INVALID");
  if (
    typeof dataBase64 !== "string" ||
    dataBase64.length === 0 ||
    dataBase64.length > Math.ceil(MAX_HARVEST_PHOTO_BYTES / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(dataBase64)
  ) {
    throw assistantError("HARVEST_PHOTO_INVALID");
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_HARVEST_PHOTO_BYTES ||
    bytes.toString("base64") !== dataBase64
  ) {
    throw assistantError(
      bytes.length > MAX_HARVEST_PHOTO_BYTES
        ? "HARVEST_PHOTO_TOO_LARGE"
        : "HARVEST_PHOTO_INVALID",
    );
  }
  if (!matchesImageSignature(mime, bytes)) {
    throw assistantError("HARVEST_PHOTO_INVALID");
  }
  return { mimeType: mime, dataBase64 };
}

function matchesImageSignature(mimeType, bytes) {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function validateHarvestAssessment(response) {
  const textParts = response?.candidates?.[0]?.content?.parts
    ?.filter((part) => part?.thought !== true)
    .map((part) => part?.text)
    .filter((value) => typeof value === "string" && value.trim());
  const parsed = textParts?.length
    ? ([...textParts].reverse().map(parseJson).find(Boolean) ?? parseJson(textParts.join("")))
    : null;
  if (!parsed) throw assistantError("GOOGLE_AI_INVALID_RESPONSE");
  const state = String(parsed.state ?? "").trim().toUpperCase();
  const quality = String(parsed.quality ?? "").trim().toUpperCase();
  if (!new Set(["READY", "NOT_READY", "UNCERTAIN"]).has(state)) {
    throw assistantError("GOOGLE_AI_INVALID_RESPONSE");
  }
  if (!new Set(["USABLE", "UNUSABLE"]).has(quality)) {
    throw assistantError("GOOGLE_AI_INVALID_RESPONSE");
  }
  const confidence = Number(parsed.confidence);
  const suggestedDelayDays = Number(parsed.suggestedDelayDays);
  const recheckInDays = Number(parsed.recheckInDays);
  if (
    !Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
    !Number.isInteger(suggestedDelayDays) || suggestedDelayDays < 0 || suggestedDelayDays > 14 ||
    !Number.isInteger(recheckInDays) || recheckInDays < 1 || recheckInDays > 7
  ) {
    throw assistantError("GOOGLE_AI_INVALID_RESPONSE");
  }
  const visibleReasons = Array.isArray(parsed.visibleReasons)
    ? parsed.visibleReasons
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim().slice(0, 120))
        .slice(0, 3)
    : [];
  if (visibleReasons.length === 0) throw assistantError("GOOGLE_AI_INVALID_RESPONSE");
  const safeState = quality === "UNUSABLE" ? "UNCERTAIN" : state;
  return Object.freeze({
    state: safeState,
    quality,
    confidence,
    suggestedDelayDays: safeState === "NOT_READY" ? suggestedDelayDays : 0,
    recheckInDays,
    visibleReasons,
  });
}

function normalizeCatalog(catalog) {
  if (!Array.isArray(catalog)) return [];
  return catalog
    .slice(0, MAX_CATALOG_ITEMS)
    .filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        /^[A-Z]+_[0-9]{1,2}$/.test(item.id) &&
        typeof item.kind === "string" &&
        typeof item.text === "string" &&
        item.text.trim()
    )
    .map(({ id, kind, text, tags = [] }) => ({
      id,
      kind: String(kind).slice(0, 20),
      text: text.trim().slice(0, 360),
      tags: Array.isArray(tags)
        ? tags.filter((tag) => typeof tag === "string").slice(0, 6)
        : []
    }));
}

function normalizeIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    return { topics: ["GENERAL"], wantsAction: false };
  }
  return {
    topics: Array.isArray(intent.topics)
      ? intent.topics
          .filter((topic) => typeof topic === "string")
          .slice(0, 5)
      : ["GENERAL"],
    wantsAction: intent.wantsAction === true,
    wantsReason: intent.wantsReason === true,
    wantsRecheck: intent.wantsRecheck === true
  };
}

function validateSelection(response, catalog) {
  const textParts = response?.candidates?.[0]?.content?.parts
    ?.filter((part) => part?.thought !== true)
    .map((part) => part?.text)
    .filter((value) => typeof value === "string" && value.trim());
  if (!textParts?.length) {
    throw assistantError("GOOGLE_AI_EMPTY_RESPONSE");
  }
  const parsed =
    [...textParts].reverse().map(parseJson).find(Boolean) ??
    parseJson(textParts.join(""));
  if (!parsed) {
    throw assistantError("GOOGLE_AI_INVALID_RESPONSE");
  }
  const allowedIds = new Set(catalog.map(({ id }) => id));
  const selectedIds = Array.isArray(parsed?.selectedIds)
    ? [
        ...new Set(
          parsed.selectedIds.filter(
            (id) => typeof id === "string" && allowedIds.has(id)
          )
        )
      ].slice(0, MAX_SELECTED_ITEMS)
    : [];
  if (selectedIds.length === 0) {
    throw assistantError("GOOGLE_AI_SELECTION_EMPTY");
  }
  return Object.freeze({ selectedIds });
}

function parseJson(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const candidates = [text];
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(text.slice(objectStart, objectEnd + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Continue to the bounded object candidate, if present.
    }
  }
  return null;
}

function assistantError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
