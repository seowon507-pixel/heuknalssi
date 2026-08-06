import { domainAssert } from "./errors.js";

export function expandSeasonMonths(startMonth, endMonth) {
  assertMonth(startMonth, "startMonth");
  assertMonth(endMonth, "endMonth");

  if (startMonth <= endMonth) {
    return range(startMonth, endMonth);
  }
  return [...range(startMonth, 12), ...range(1, endMonth)];
}

function assertMonth(value, field) {
  domainAssert(
    Number.isInteger(value) && value >= 1 && value <= 12,
    "INVALID_SEASON_MONTH",
    `${field} must be an integer from 1 through 12`,
    { field, value },
  );
}

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}
