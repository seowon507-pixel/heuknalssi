import assert from "node:assert/strict";
import test from "node:test";

import { suggestAdministrativeAddresses } from "./address-suggestions.mjs";

test("광역시 이름을 입력하면 소속 군·구 후보를 모두 제공한다", () => {
  assert.deepEqual(suggestAdministrativeAddresses("인천광역시"), [
    "인천광역시 중구",
    "인천광역시 동구",
    "인천광역시 미추홀구",
    "인천광역시 연수구",
    "인천광역시 남동구",
    "인천광역시 부평구",
    "인천광역시 계양구",
    "인천광역시 서구",
    "인천광역시 강화군",
    "인천광역시 옹진군",
  ]);
});

test("지역 별칭과 뒷부분 입력도 공식 행정구역 이름으로 정리한다", () => {
  assert.ok(
    suggestAdministrativeAddresses("인천").includes("인천광역시 남동구"),
  );
  assert.deepEqual(suggestAdministrativeAddresses("인천 남동"), [
    "인천광역시 남동구",
  ]);
  assert.ok(
    suggestAdministrativeAddresses("강원도 평창").includes(
      "강원특별자치도 평창군",
    ),
  );
});

test("두 글자 미만 입력과 일치하지 않는 입력에는 후보를 만들지 않는다", () => {
  assert.deepEqual(suggestAdministrativeAddresses("인"), []);
  assert.deepEqual(suggestAdministrativeAddresses("존재하지 않는 지역"), []);
});
