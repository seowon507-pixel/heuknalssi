const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SHORT_RELEASE_HOURS = Object.freeze([2, 5, 8, 11, 14, 17, 20, 23]);

function pad(value) {
  return String(value).padStart(2, '0');
}

function kstParts(date) {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    shifted,
  };
}

function compactDate(parts) {
  return `${parts.year}${pad(parts.month)}${pad(parts.day)}`;
}

function previousKstDay(parts) {
  const shifted = new Date(parts.shifted.getTime() - 24 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function latestKmaShortIssue(date = new Date()) {
  const parts = kstParts(date);
  const available = SHORT_RELEASE_HOURS.filter(
    (hour) => hour < parts.hour || (hour === parts.hour && parts.minute >= 15),
  );
  if (available.length === 0) {
    return {
      baseDate: compactDate(previousKstDay(parts)),
      baseTime: '2300',
    };
  }
  return {
    baseDate: compactDate(parts),
    baseTime: `${pad(available.at(-1))}00`,
  };
}

export function latestKmaMidIssue(date = new Date()) {
  const parts = kstParts(date);
  let hour;
  let issueParts = parts;
  if (parts.hour > 18 || (parts.hour === 18 && parts.minute >= 30)) {
    hour = 18;
  } else if (parts.hour > 6 || (parts.hour === 6 && parts.minute >= 30)) {
    hour = 6;
  } else {
    hour = 18;
    issueParts = previousKstDay(parts);
  }
  return {
    tmFc: `${compactDate(issueParts)}${pad(hour)}00`,
  };
}
