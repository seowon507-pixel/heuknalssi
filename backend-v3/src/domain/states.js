import { MODULE_APPLICABILITY } from "./constants.js";

export function evaluateAnalysisStates(input = {}) {
  const request = input.request ?? {};
  const modules = input.modules ?? {};
  const cultivationMode = input.cultivationMode ?? request.cultivationMode;
  const applicability =
    MODULE_APPLICABILITY[cultivationMode] ??
    MODULE_APPLICABILITY.OPEN_FIELD;
  const names = Object.keys(applicability);
  const applicableModules = names.filter(
    (name) => applicability[name] !== "NOT_APPLICABLE",
  );
  const summaries = Object.fromEntries(
    names.map((name) => [name, moduleFor(modules, name)]),
  );
  const usableModules = applicableModules.filter((name) =>
    isUsable(summaries[name]),
  );
  const allReady = applicableModules.every(
    (name) => effectiveState(summaries[name]) === "READY",
  );
  const analysisState = allReady
    ? "COMPLETE"
    : usableModules.length > 0
      ? "PARTIAL"
      : "DATA_NEEDED";

  let conditionState;
  if (cultivationMode === "FACILITY_HYDRO") {
    conditionState = "NOT_APPLICABLE";
  } else if (cultivationMode === "FACILITY_SOIL") {
    conditionState = conditionFromOne(summaries.soil);
  } else {
    conditionState = conditionFromTwo(summaries.climate, summaries.soil);
  }

  const riskSummaries = [
    summaries.observations,
    summaries.shortForecast,
    summaries.midForecast,
  ];
  const riskState = riskSummaries.every(
    (summary) => effectiveState(summary) === "READY",
  )
    ? "READY"
    : riskSummaries.some(isUsable)
      ? "PARTIAL"
      : "HOLD";

  return {
    analysisState,
    conditionState,
    riskState,
    applicableModules,
    usableModules,
    effectiveModuleStates: Object.fromEntries(
      names.map((name) => [name, effectiveState(summaries[name])]),
    ),
  };
}

export function isUsableModule(summary) {
  return isUsable(summary);
}

function conditionFromOne(summary) {
  const state = effectiveState(summary);
  if (state === "READY") return "READY";
  if (isUsable(summary)) return "PARTIAL";
  return "HOLD";
}

function conditionFromTwo(climate, soil) {
  const climateUsable = isUsable(climate);
  const soilUsable = isUsable(soil);
  if (!climateUsable && !soilUsable) return "HOLD";
  if (
    climateUsable &&
    soilUsable &&
    effectiveState(climate) === "READY" &&
    effectiveState(soil) === "READY"
  ) {
    return "READY";
  }
  return "PARTIAL";
}

function moduleFor(modules, name) {
  if (modules[name] !== undefined) return modules[name];
  if (name === "observations" && modules.observation !== undefined) {
    return modules.observation;
  }
  if (
    (name === "shortForecast" || name === "midForecast") &&
    modules.forecast !== undefined
  ) {
    return projectForecastModule(modules.forecast, name);
  }
  return null;
}

function projectForecastModule(summary, name) {
  const result = summary?.result ?? summary;
  const available =
    name === "shortForecast"
      ? result?.shortAvailable ?? (result?.shortDays?.length > 0)
      : result?.midAvailable ?? (result?.midDays?.length > 0);
  if (!available) {
    return {
      state: "HOLD",
      result: null,
      qualityFlags: summary?.qualityFlags ?? [],
    };
  }
  return summary?.state
    ? summary
    : {
        state: "PARTIAL",
        result,
        qualityFlags: summary?.qualityFlags ?? [],
      };
}

function effectiveState(summary) {
  if (!summary || typeof summary !== "object") return "UNAVAILABLE";
  if (
    summary.state === "READY" &&
    (summary.qualityFlags?.includes("STALE") ||
      summary.qualityFlags?.includes("SAMPLE") ||
      summary.deliveryState === "SAMPLE")
  ) {
    return "PARTIAL";
  }
  return summary.state ?? "UNAVAILABLE";
}

function isUsable(summary) {
  const state = effectiveState(summary);
  return (
    state === "READY" ||
    (state === "PARTIAL" &&
      summary !== null &&
      typeof summary === "object" &&
      summary.result !== null &&
      summary.result !== undefined)
  );
}
