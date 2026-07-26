import { requestProviderJson } from "./network.js";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CATALOG_ITEMS = 24;
const MAX_SELECTED_ITEMS = 6;
const MODEL_PATTERN = /^gemini-[A-Za-z0-9._-]{1,64}$/;

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
    }
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
