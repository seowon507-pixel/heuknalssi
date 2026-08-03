const DEFAULT_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_REPORTS = 50;
const MAX_CAS_ATTEMPTS = 8;

function requireIdentifier(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 180) {
    throw new TypeError(`${field} must be a non-empty identifier`);
  }
  return value.trim();
}

function documentKey(ownerSessionId, farmId) {
  return JSON.stringify([
    "report-history-v1",
    requireIdentifier(ownerSessionId, "ownerSessionId"),
    requireIdentifier(farmId, "farmId"),
  ]);
}

function assertStore(store) {
  for (const method of ["get", "setIfAbsent", "compareAndSet"]) {
    if (typeof store?.[method] !== "function") {
      throw new TypeError(`report history store.${method} is required`);
    }
  }
}

function normalizeDocument(value) {
  if (value === undefined) return { reports: [] };
  if (!value || !Array.isArray(value.reports)) {
    throw new Error("report history store returned an invalid document");
  }
  return structuredClone(value);
}

export function createReportHistoryRepository({
  store,
  ttlMs = DEFAULT_TTL_MS,
  maxReports = DEFAULT_MAX_REPORTS,
} = {}) {
  assertStore(store);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError("report history ttlMs must be a positive integer");
  }
  if (!Number.isSafeInteger(maxReports) || maxReports < 1 || maxReports > 200) {
    throw new TypeError("maxReports must be an integer from 1 to 200");
  }

  async function mutate(ownerSessionId, farmId, operation) {
    const key = documentKey(ownerSessionId, farmId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const currentValue = await Promise.resolve(store.get(key));
      if (currentValue === undefined) {
        const created = await Promise.resolve(
          store.setIfAbsent(key, { reports: [] }, ttlMs),
        );
        if (!created) continue;
      }
      const baselineValue = await Promise.resolve(store.get(key));
      const baseline = normalizeDocument(baselineValue);
      const outcome = operation(structuredClone(baseline));
      if (outcome.write === false) return outcome.value;
      const changed = await Promise.resolve(
        store.compareAndSet(key, baselineValue, outcome.document, ttlMs),
      );
      if (changed) return outcome.value;
    }
    const error = new Error("report history update conflicted repeatedly");
    error.code = "REPORT_HISTORY_CONFLICT";
    throw error;
  }

  return Object.freeze({
    async upsertReport({ ownerSessionId, farmId, report }) {
      const normalizedReportId = requireIdentifier(report?.reportId, "reportId");
      return mutate(ownerSessionId, farmId, (document) => {
        const index = document.reports.findIndex(
          (item) => item.reportId === normalizedReportId,
        );
        if (index >= 0) {
          document.reports[index] = structuredClone(report);
        } else {
          document.reports.push(structuredClone(report));
        }
        document.reports.sort(
          (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
        );
        document.reports = document.reports.slice(0, maxReports);
        return { write: true, document, value: structuredClone(report) };
      });
    },

    async listReports({ ownerSessionId, farmId, cropId = null }) {
      const document = normalizeDocument(
        await Promise.resolve(store.get(documentKey(ownerSessionId, farmId))),
      );
      return structuredClone(
        document.reports.filter(
          (report) => cropId === null || report.cropId === cropId,
        ),
      );
    },

    async getReport({ ownerSessionId, farmId, reportId }) {
      const document = normalizeDocument(
        await Promise.resolve(store.get(documentKey(ownerSessionId, farmId))),
      );
      const normalizedReportId = requireIdentifier(reportId, "reportId");
      const report = document.reports.find(
        (item) => item.reportId === normalizedReportId,
      );
      return report ? structuredClone(report) : null;
    },
  });
}

export const reportHistoryRepositoryDefaults = Object.freeze({
  maxReports: DEFAULT_MAX_REPORTS,
  ttlMs: DEFAULT_TTL_MS,
});
