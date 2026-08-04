const SUPPORTED_CROPS = new Set(["apple", "pear", "cucumber", "potato", "lettuce"]);
const CYCLE_ANCHORS = new Set(["SOWING", "TRANSPLANTING", "FLOWERING", "SEASON_START"]);
const CYCLE_STATUSES = new Set(["PLANNING", "ACTIVE", "HARVEST_WINDOW", "COMPLETED"]);
const SETTING_FIELDS = Object.freeze([
  "cultivation",
  "season",
  "growth",
  "cultivationMode",
  "growthStage",
  "seasonProfile",
]);

export function sanitizeFarmForDeviceBackup(farm, { now = () => new Date() } = {}) {
  if (!farm || typeof farm !== "object" || Array.isArray(farm)) return null;
  const id = boundedText(farm.id, 160);
  const region = boundedText(farm.region, 200);
  const situation = ["planning", "growing"].includes(farm.situation)
    ? farm.situation
    : null;
  const crops = [...new Set(
    (Array.isArray(farm.crops) ? farm.crops : [])
      .map((crop) => String(crop ?? "").trim().toLowerCase())
      .filter((crop) => SUPPORTED_CROPS.has(crop)),
  )].slice(0, SUPPORTED_CROPS.size);
  if (!id || !region || !situation || crops.length === 0) return null;

  const cropSettings = Object.fromEntries(crops.map((crop) => {
    const raw = farm.cropSettings?.[crop] ?? farm.cropSettings?.[crop.toUpperCase()] ?? {};
    const setting = {};
    for (const field of SETTING_FIELDS) {
      const value = boundedText(raw?.[field], 80);
      if (value) setting[field] = value;
    }
    const cycle = sanitizeCycle(raw?.cycle);
    if (cycle) setting.cycle = cycle;
    return [crop, setting];
  }));
  const updatedAt = Number.isFinite(Date.parse(farm.updatedAt))
    ? new Date(farm.updatedAt).toISOString()
    : now().toISOString();
  const name = boundedText(farm.name, 200) ?? `${region} 농장`;
  return { id, name, updatedAt, situation, crops, cropSettings, region };
}

// 복원도 저장과 동일한 마이그레이션 경계를 통과시킨다. 예전 버전이
// APPLE처럼 대문자 작물키를 저장했더라도 현재 폼이 쓰는 소문자 계약으로
// 정리하고, 더 이상 지원하지 않는 필드는 브라우저 저장소에 다시 넣지 않는다.
export function sanitizeFarmsFromDeviceBackup(farms, options = {}) {
  if (!Array.isArray(farms)) return [];
  const seen = new Set();
  return farms.flatMap((farm) => {
    const sanitized = sanitizeFarmForDeviceBackup(farm, options);
    if (!sanitized || seen.has(sanitized.id)) return [];
    seen.add(sanitized.id);
    return [sanitized];
  });
}

function sanitizeCycle(cycle) {
  if (!cycle || typeof cycle !== "object" || Array.isArray(cycle)) return null;
  const seasonId = boundedText(cycle.seasonId, 160);
  const anchorType = String(cycle.anchorType ?? "").trim().toUpperCase();
  const anchorDate = String(cycle.anchorDate ?? "").trim();
  const status = String(cycle.status ?? "").trim().toUpperCase();
  if (
    !seasonId ||
    !CYCLE_ANCHORS.has(anchorType) ||
    !isDateKey(anchorDate) ||
    !CYCLE_STATUSES.has(status)
  ) return null;
  const sanitized = { seasonId, anchorType, anchorDate, status };
  if (typeof cycle.userConfirmed === "boolean") {
    sanitized.userConfirmed = cycle.userConfirmed;
  }
  return sanitized;
}

function boundedText(value, maximum) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximum ? text : null;
}

function isDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
