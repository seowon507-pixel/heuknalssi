const OBSERVATION_TIME_ZONE = "Asia/Seoul";
const OBSERVATION_WINDOW_DAYS = 7;
const TREND_MINIMUM_VALID_DAYS = 5;
const DAILY_FIELDS = Object.freeze([
  "minTemperature",
  "maxTemperature",
  "meanTemperature",
  "precipitationAmount",
]);

/**
 * Returns the seven completed provider-local calendar days, oldest first.
 * The current Asia/Seoul date is intentionally absent because it is incomplete.
 */
export function buildRecentCompletedDates(now = new Date()) {
  const instant = normalizeInstant(now);
  if (instant === null) return [];
  const today = seoulCalendarDate(instant);
  const [year, month, day] = today.split("-").map(Number);
  const todayUtc = Date.UTC(year, month - 1, day);
  return Array.from(
    { length: OBSERVATION_WINDOW_DAYS },
    (_, index) =>
      new Date(
        todayUtc -
          (OBSERVATION_WINDOW_DAYS - index) * 24 * 60 * 60 * 1000,
      )
        .toISOString()
        .slice(0, 10),
  );
}

/**
 * Validates only the frozen daily-observation input contract. It does not
 * infer missing values, select a station, or feed recent readings to climate.
 */
export function validateObservationInput(input = {}) {
  const expectedDates = buildRecentCompletedDates(input.now);
  const errors = [];
  const normalErrors = [];

  if (!isRecord(input)) {
    return {
      valid: false,
      errors: [
        issue(
          "INVALID_OBSERVATION_INPUT",
          "$",
          "observation input must be an object",
        ),
      ],
      normalErrors,
      expectedDates,
    };
  }
  if (expectedDates.length !== OBSERVATION_WINDOW_DAYS) {
    errors.push(
      issue(
        "INVALID_OBSERVATION_CLOCK",
        "now",
        "now must identify a valid instant",
      ),
    );
  }
  requireText(input.stationId, "stationId", errors);
  requireText(input.stationName, "stationName", errors);
  if (!Number.isFinite(input.distanceKm) || input.distanceKm < 0) {
    errors.push(
      issue(
        "INVALID_OBSERVATION_STATION",
        "distanceKm",
        "distanceKm must be a non-negative finite number",
      ),
    );
  }

  if (!Array.isArray(input.readings)) {
    errors.push(
      issue(
        "INVALID_OBSERVATION_READINGS",
        "readings",
        "readings must be an array",
      ),
    );
  } else {
    validateReadings(
      input.readings,
      input.stationId,
      new Set(expectedDates),
      errors,
    );
  }

  if (
    input.monthlyNormals !== undefined &&
    !Array.isArray(input.monthlyNormals)
  ) {
    normalErrors.push(
      issue(
        "INVALID_MONTHLY_NORMALS",
        "monthlyNormals",
        "monthlyNormals must be an array when supplied",
      ),
    );
  } else {
    validateMonthlyNormals(
      input.monthlyNormals ?? [],
      input.stationId,
      normalErrors,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    normalErrors,
    expectedDates,
  };
}

/**
 * Evaluates recent daily observations independently from the long-term
 * climate engine.
 *
 * A valid day has all four daily values present as finite numbers. A partial
 * day is retained in the DTO but is not counted toward the 5/7 trend gate.
 */
export function evaluateObservation(input = {}) {
  const validation = validateObservationInput(input);
  if (!validation.valid) {
    return {
      state: "HOLD",
      coverage: 0,
      blockingReasons: [
        "INVALID_OBSERVATION_CONTRACT",
        ...unique(validation.errors.map((error) => error.code)),
      ],
      missingInputs: validation.expectedDates.map(
        (date) => `observation:${date}`,
      ),
      qualityFlags: ["SCHEMA_CHANGED"],
      result: null,
      evidence: [],
      contractErrors: validation.errors,
    };
  }

  const readingsByDate = new Map(
    input.readings.map((reading) => [reading.date, reading]),
  );
  const normals = usableNormals(
    input.monthlyNormals ?? [],
    input.stationId,
    validation.normalErrors,
  );
  const missingInputs = [];
  const days = validation.expectedDates.map((date) => {
    const reading = readingsByDate.get(date);
    if (reading === undefined) {
      for (const field of DAILY_FIELDS) {
        missingInputs.push(`observation:${date}:${field}`);
      }
      return emptyDay(date);
    }

    for (const field of DAILY_FIELDS) {
      if (reading[field] === null) {
        missingInputs.push(`observation:${date}:${field}`);
      }
    }
    const month = Number(date.slice(5, 7));
    const monthlyNormal = normals.get(month);
    const monthlyNormalDeviation =
      isCompleteReading(reading) &&
      monthlyNormal !== undefined
        ? reading.meanTemperature - monthlyNormal
        : null;
    return {
      date,
      minTemperature: reading.minTemperature,
      maxTemperature: reading.maxTemperature,
      meanTemperature: reading.meanTemperature,
      precipitationAmount: reading.precipitationAmount,
      monthlyNormalDeviation,
    };
  });

  const validDayCount = days.filter(isCompleteDay).length;
  const coverage = validDayCount / OBSERVATION_WINDOW_DAYS;
  const missingNormalMonths = unique(
    days
      .filter(isCompleteDay)
      .map((day) => Number(day.date.slice(5, 7)))
      .filter((month) => !normals.has(month)),
  );
  for (const month of missingNormalMonths) {
    missingInputs.push(
      `monthlyNormal:${input.stationId}:${String(month).padStart(2, "0")}`,
    );
  }

  const result = {
    stationId: input.stationId,
    stationName: input.stationName,
    distanceKm: input.distanceKm,
    validDayCount,
    days,
    trendSummaryAvailable:
      validDayCount >= TREND_MINIMUM_VALID_DAYS,
    comparisonBasis: "MONTHLY_NORMAL_1991_2020",
    completedDateRange: {
      from: validation.expectedDates[0],
      to: validation.expectedDates.at(-1),
      timeZone: OBSERVATION_TIME_ZONE,
    },
  };
  const qualityFlags = [];
  if (input.readings.length === 0) qualityFlags.push("NO_DATA");
  if (validDayCount < OBSERVATION_WINDOW_DAYS) {
    qualityFlags.push("INCOMPLETE_OBSERVATION_WINDOW");
  }
  if (validDayCount > 0 && validDayCount < TREND_MINIMUM_VALID_DAYS) {
    qualityFlags.push("TREND_SUMMARY_WITHHELD");
  }
  if (validation.normalErrors.length > 0) {
    qualityFlags.push("MONTHLY_NORMAL_CONTRACT_INVALID");
  }
  if (missingNormalMonths.length > 0) {
    qualityFlags.push("MONTHLY_NORMAL_UNAVAILABLE");
  }

  if (validDayCount === 0) {
    return {
      state: "HOLD",
      coverage,
      blockingReasons: ["NO_VALID_OBSERVATION_DAYS"],
      missingInputs: unique(missingInputs),
      qualityFlags,
      result,
      evidence: [],
      normalContractErrors: validation.normalErrors,
    };
  }
  if (validDayCount < OBSERVATION_WINDOW_DAYS) {
    return {
      state: "PARTIAL",
      coverage,
      blockingReasons: [
        validDayCount < TREND_MINIMUM_VALID_DAYS
          ? "FEWER_THAN_5_VALID_OBSERVATION_DAYS"
          : "OBSERVATION_WINDOW_INCOMPLETE",
      ],
      missingInputs: unique(missingInputs),
      qualityFlags,
      result,
      evidence: [],
      normalContractErrors: validation.normalErrors,
    };
  }
  return {
    state: "READY",
    coverage,
    blockingReasons: [],
    missingInputs: unique(missingInputs),
    qualityFlags,
    result,
    evidence: [],
    normalContractErrors: validation.normalErrors,
  };
}

function validateReadings(readings, stationId, expectedDates, errors) {
  if (readings.length > OBSERVATION_WINDOW_DAYS) {
    errors.push(
      issue(
        "TOO_MANY_OBSERVATION_DAYS",
        "readings",
        "readings cannot contain more than seven completed days",
      ),
    );
  }
  const seenDates = new Set();
  readings.forEach((reading, index) => {
    const path = `readings[${index}]`;
    if (!isRecord(reading)) {
      errors.push(
        issue(
          "INVALID_OBSERVATION_DAY",
          path,
          "observation day must be an object",
        ),
      );
      return;
    }
    if (!isIsoDate(reading.date)) {
      errors.push(
        issue(
          "INVALID_OBSERVATION_DATE",
          `${path}.date`,
          "date must be a real ISO calendar date",
        ),
      );
    } else {
      if (seenDates.has(reading.date)) {
        errors.push(
          issue(
            "DUPLICATE_OBSERVATION_DATE",
            `${path}.date`,
            "completed-day observations must be unique by date",
          ),
        );
      }
      seenDates.add(reading.date);
      if (!expectedDates.has(reading.date)) {
        errors.push(
          issue(
            "OBSERVATION_DATE_OUTSIDE_COMPLETED_WINDOW",
            `${path}.date`,
            "date must be one of the latest seven completed Asia/Seoul days",
          ),
        );
      }
    }
    if (
      reading.stationId !== undefined &&
      reading.stationId !== stationId
    ) {
      errors.push(
        issue(
          "OBSERVATION_STATION_MISMATCH",
          `${path}.stationId`,
          "reading stationId must match the selected observation station",
        ),
      );
    }
    for (const field of DAILY_FIELDS) {
      if (!Object.hasOwn(reading, field)) {
        errors.push(
          issue(
            "MISSING_OBSERVATION_FIELD",
            `${path}.${field}`,
            `${field} must be explicitly finite or null`,
          ),
        );
      } else if (
        reading[field] !== null &&
        !Number.isFinite(reading[field])
      ) {
        errors.push(
          issue(
            "INVALID_OBSERVATION_VALUE",
            `${path}.${field}`,
            `${field} must be finite or null`,
          ),
        );
      }
    }
    if (
      Number.isFinite(reading.precipitationAmount) &&
      reading.precipitationAmount < 0
    ) {
      errors.push(
        issue(
          "INVALID_OBSERVATION_VALUE",
          `${path}.precipitationAmount`,
          "precipitationAmount cannot be negative",
        ),
      );
    }
    if (
      Number.isFinite(reading.minTemperature) &&
      Number.isFinite(reading.maxTemperature) &&
      reading.minTemperature > reading.maxTemperature
    ) {
      errors.push(
        issue(
          "INVALID_TEMPERATURE_ORDER",
          path,
          "minTemperature cannot exceed maxTemperature",
        ),
      );
    }
    if (
      Number.isFinite(reading.meanTemperature) &&
      Number.isFinite(reading.minTemperature) &&
      reading.meanTemperature < reading.minTemperature
    ) {
      errors.push(
        issue(
          "INVALID_TEMPERATURE_ORDER",
          path,
          "meanTemperature cannot be below minTemperature",
        ),
      );
    }
    if (
      Number.isFinite(reading.meanTemperature) &&
      Number.isFinite(reading.maxTemperature) &&
      reading.meanTemperature > reading.maxTemperature
    ) {
      errors.push(
        issue(
          "INVALID_TEMPERATURE_ORDER",
          path,
          "meanTemperature cannot exceed maxTemperature",
        ),
      );
    }
  });
}

function validateMonthlyNormals(normals, stationId, errors) {
  const seen = new Set();
  normals.forEach((normal, index) => {
    const path = `monthlyNormals[${index}]`;
    if (!isRecord(normal)) {
      errors.push(
        issue(
          "INVALID_MONTHLY_NORMAL",
          path,
          "monthly normal must be an object",
        ),
      );
      return;
    }
    requireText(
      normal.stationId,
      `${path}.stationId`,
      errors,
      "INVALID_MONTHLY_NORMAL",
    );
    if (!Number.isInteger(normal.month) || normal.month < 1 || normal.month > 12) {
      errors.push(
        issue(
          "INVALID_MONTHLY_NORMAL",
          `${path}.month`,
          "month must be an integer from 1 through 12",
        ),
      );
    }
    if (!Number.isFinite(normal.meanTemperature)) {
      errors.push(
        issue(
          "INVALID_MONTHLY_NORMAL",
          `${path}.meanTemperature`,
          "meanTemperature must be finite",
        ),
      );
    }
    if (
      normal.normalPeriod !== undefined &&
      normal.normalPeriod !== "1991-2020"
    ) {
      errors.push(
        issue(
          "INVALID_MONTHLY_NORMAL_PERIOD",
          `${path}.normalPeriod`,
          "only the reviewed 1991-2020 monthly normal is accepted",
        ),
      );
    }
    if (normal.stationId === stationId && Number.isInteger(normal.month)) {
      const key = `${normal.stationId}:${normal.month}`;
      if (seen.has(key)) {
        errors.push(
          issue(
            "DUPLICATE_MONTHLY_NORMAL",
            path,
            "monthly normal must be unique by station and month",
          ),
        );
      }
      seen.add(key);
    }
  });
}

function usableNormals(normals, stationId, normalErrors) {
  const invalidIndexes = new Set(
    normalErrors
      .map((error) => /^monthlyNormals\[(\d+)\]/u.exec(error.path)?.[1])
      .filter((index) => index !== undefined)
      .map(Number),
  );
  const duplicateKeys = new Set();
  const counts = new Map();
  normals.forEach((normal) => {
    if (!isRecord(normal) || normal.stationId !== stationId) return;
    const key = `${normal.stationId}:${normal.month}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  for (const [key, count] of counts) {
    if (count > 1) duplicateKeys.add(key);
  }

  const result = new Map();
  normals.forEach((normal, index) => {
    if (
      invalidIndexes.has(index) ||
      !isRecord(normal) ||
      normal.stationId !== stationId ||
      duplicateKeys.has(`${normal.stationId}:${normal.month}`)
    ) {
      return;
    }
    result.set(normal.month, normal.meanTemperature);
  });
  return result;
}

function emptyDay(date) {
  return {
    date,
    minTemperature: null,
    maxTemperature: null,
    meanTemperature: null,
    precipitationAmount: null,
    monthlyNormalDeviation: null,
  };
}

function isCompleteDay(day) {
  return DAILY_FIELDS.every((field) => Number.isFinite(day[field]));
}

function isCompleteReading(reading) {
  return DAILY_FIELDS.every((field) => Number.isFinite(reading[field]));
}

function normalizeInstant(value) {
  const resolved = typeof value === "function" ? value() : value;
  const date =
    resolved instanceof Date
      ? new Date(resolved.getTime())
      : resolved === undefined
        ? new Date()
        : new Date(resolved);
  return Number.isFinite(date.getTime()) ? date : null;
}

function seoulCalendarDate(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: OBSERVATION_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

function isIsoDate(value) {
  const match =
    typeof value === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
      : null;
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function requireText(
  value,
  path,
  errors,
  code = "INVALID_OBSERVATION_STATION",
) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(
      issue(
        code,
        path,
        `${path} must be a non-empty string`,
      ),
    );
  }
}

function issue(code, path, message) {
  return { code, path, message };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(values) {
  return [...new Set(values)];
}

export const OBSERVATION_CONTRACT = Object.freeze({
  timeZone: OBSERVATION_TIME_ZONE,
  windowDays: OBSERVATION_WINDOW_DAYS,
  trendMinimumValidDays: TREND_MINIMUM_VALID_DAYS,
  requiredDailyFields: DAILY_FIELDS,
});
