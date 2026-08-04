// dateUtil.js
// 출석 판정은 "며칠인가"만 중요하고 시/분/초는 필요 없으므로
// 날짜를 'YYYY-MM-DD' 문자열(dateKey)로 다룹니다.

/** Date 객체(또는 지금)를 'YYYY-MM-DD' 로컬 날짜 문자열로 변환 */
export function toDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 'YYYY-MM-DD' 문자열을 자정 기준 Date로 변환 */
export function fromDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * 두 날짜 문자열 사이의 "일(day) 차이" (b - a).
 * 예) diffDays('2026-08-04', '2026-08-05') === 1
 */
export function diffDays(aKey, bKey) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const a = fromDateKey(aKey).getTime();
  const b = fromDateKey(bKey).getTime();
  return Math.round((b - a) / MS_PER_DAY);
}
