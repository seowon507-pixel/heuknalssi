import { domainAssert } from "../domain/errors.js";

const CROPS = new Set(["APPLE", "PEAR", "CUCUMBER", "POTATO", "LETTUCE"]);

export function createHarvestAssessmentService({ assessor, clock = Date.now } = {}) {
  domainAssert(
    assessor && typeof assessor.assessHarvestPhoto === "function",
    "HARVEST_ASSESSMENT_PORT_INVALID",
    "assessor.assessHarvestPhoto must be a function.",
  );
  domainAssert(typeof clock === "function", "HARVEST_ASSESSMENT_PORT_INVALID", "clock must be a function.");

  return Object.freeze({ assessPhoto });

  async function assessPhoto(input = {}) {
    const cropId = String(input.cropId ?? "").trim().toUpperCase();
    domainAssert(CROPS.has(cropId), "HARVEST_CROP_INVALID", "Unsupported crop.");
    requiredIdentifier(input.ownerSessionId, "ownerSessionId");
    const farmId = requiredIdentifier(input.farmId, "farmId");
    const seasonId = requiredIdentifier(input.seasonId, "seasonId");
    let result;
    try {
      result = await assessor.assessHarvestPhoto({
        cropId,
        mimeType: input.mimeType,
        dataBase64: input.dataBase64,
        signal: input.signal,
        deadlineAt: input.deadlineAt,
      });
    } catch (error) {
      const code = String(error?.code ?? "");
      if (["HARVEST_PHOTO_INVALID", "HARVEST_PHOTO_TOO_LARGE"].includes(code)) {
        domainAssert(false, code, "The harvest photo could not be assessed.");
      }
      if (code.startsWith("GOOGLE_AI_")) {
        domainAssert(
          false,
          "HARVEST_ASSESSMENT_UNAVAILABLE",
          "Harvest photo assessment is temporarily unavailable.",
        );
      }
      throw error;
    }
    return Object.freeze({
      ...result,
      cropId,
      farmId,
      seasonId,
      assessedAt: new Date(clock()).toISOString(),
      basis: "VISIBLE_HARVEST_MATURITY_ONLY",
    });
  }
}

function requiredIdentifier(value, field) {
  domainAssert(
    typeof value === "string" &&
      value.trim() === value &&
      value.length > 0 &&
      value.length <= 180,
    "HARVEST_ASSESSMENT_SCOPE_INVALID",
    `${field} must be a non-empty identifier.`,
  );
  return value;
}
