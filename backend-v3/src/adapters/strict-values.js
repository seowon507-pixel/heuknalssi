import { SchemaChangedError } from "./errors.js";

const DECIMAL_NUMBER =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseStrictFiniteNumber(
  value,
  {
    field = "value",
    min = -Infinity,
    max = Infinity,
    missingMarkers = ["-"]
  } = {}
) {
  if (value === null || value === undefined) return null;

  let parsed;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed === "" ||
      missingMarkers.some((marker) => trimmed === String(marker).trim())
    ) {
      return null;
    }
    if (!DECIMAL_NUMBER.test(trimmed)) {
      throw new SchemaChangedError(`${field} is not a strict decimal number.`);
    }
    parsed = Number(trimmed);
  } else {
    throw new SchemaChangedError(`${field} has an unsupported value type.`);
  }

  if (!Number.isFinite(parsed)) {
    throw new SchemaChangedError(`${field} must be finite.`);
  }
  if (parsed < min || parsed > max) {
    throw new SchemaChangedError(`${field} is outside its allowed range.`);
  }
  return parsed;
}

export function requireFiniteNumber(value, options) {
  const parsed = parseStrictFiniteNumber(value, options);
  if (parsed === null) {
    throw new SchemaChangedError(
      `${options?.field ?? "value"} is required and cannot be missing.`
    );
  }
  return parsed;
}

export function requireNonEmptyString(value, field = "value") {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SchemaChangedError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

export function parseStrictBoolean(value, field = "value") {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "y" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "n" || normalized === "0") {
      return false;
    }
  }
  throw new SchemaChangedError(`${field} must be an explicit boolean.`);
}

function calendarDateParts(dateText, field) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!match) {
    throw new SchemaChangedError(`${field} must be an ISO calendar date.`);
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new SchemaChangedError(`${field} is not a real calendar date.`);
  }
  return { year, month, day };
}

export function parseIsoDate(value, field = "date") {
  const text = requireNonEmptyString(value, field);
  calendarDateParts(text, field);
  return text;
}

export function parseIsoInstant(value, field = "timestamp") {
  const text = requireNonEmptyString(value, field);
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      text
    );
  if (!match) {
    throw new SchemaChangedError(
      `${field} must be an ISO-8601 timestamp with an explicit offset.`
    );
  }
  const [
    ,
    dateText,
    hourText,
    minuteText,
    secondText = "00",
    ,
    zone,
    offsetHourText,
    offsetMinuteText
  ] = match;
  calendarDateParts(dateText, field);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new SchemaChangedError(`${field} is not a real timestamp.`);
  }
  if (
    zone !== "Z" &&
    (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)
  ) {
    throw new SchemaChangedError(`${field} has an invalid UTC offset.`);
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new SchemaChangedError(`${field} is not a real timestamp.`);
  }
  return new Date(parsed).toISOString();
}

export function kmaDateTimeToIso(
  dateValue,
  timeValue,
  { field = "timestamp", offset = "+09:00" } = {}
) {
  const rawDate = String(dateValue ?? "").trim();
  const rawTime = String(timeValue ?? "").trim().padStart(4, "0");
  if (!/^\d{8}$/.test(rawDate) || !/^\d{4}$/.test(rawTime)) {
    throw new SchemaChangedError(
      `${field} must contain KMA YYYYMMDD and HHmm values.`
    );
  }

  const isoDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
  calendarDateParts(isoDate, field);
  const hour = Number(rawTime.slice(0, 2));
  const minute = Number(rawTime.slice(2, 4));
  if (hour > 23 || minute > 59) {
    throw new SchemaChangedError(`${field} contains an invalid time.`);
  }
  if (!/^[+-]\d{2}:\d{2}$/.test(offset)) {
    throw new SchemaChangedError(`${field} has an invalid UTC offset.`);
  }

  return parseIsoInstant(
    `${isoDate}T${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}:00${offset}`,
    field
  );
}
