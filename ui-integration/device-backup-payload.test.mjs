import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeFarmForDeviceBackup,
  sanitizeFarmsFromDeviceBackup,
} from "./device-backup-payload.mjs";

test("기존 버전의 추가 필드를 백업 계약에서 제거하고 작기 정보는 보존한다", () => {
  const result = sanitizeFarmForDeviceBackup({
    id: "farm-1",
    name: "인천 남동구 · 사과",
    updatedAt: "2026-08-04T00:00:00.000Z",
    situation: "growing",
    crops: ["APPLE", "apple", "unknown"],
    region: "인천광역시 남동구",
    legacyLocationToken: "must-not-leave-browser",
    cropSettings: {
      APPLE: {
        cultivation: "open-field",
        season: "annual",
        growth: "middle",
        legacyRecommendation: true,
        cycle: {
          seasonId: "season-apple-2026",
          anchorType: "FLOWERING",
          anchorDate: "2026-04-15",
          status: "ACTIVE",
          userConfirmed: true,
          serverRevision: 4,
        },
      },
    },
  });

  assert.deepEqual(result.crops, ["apple"]);
  assert.deepEqual(result.cropSettings.apple, {
    cultivation: "open-field",
    season: "annual",
    growth: "middle",
    cycle: {
      seasonId: "season-apple-2026",
      anchorType: "FLOWERING",
      anchorDate: "2026-04-15",
      status: "ACTIVE",
      userConfirmed: true,
    },
  });
  assert.equal("legacyLocationToken" in result, false);
  assert.equal("legacyRecommendation" in result.cropSettings.apple, false);
  assert.equal("serverRevision" in result.cropSettings.apple.cycle, false);
});

test("필수 농장 범위가 없으면 서버 백업 대상으로 만들지 않는다", () => {
  assert.equal(sanitizeFarmForDeviceBackup({ region: "인천광역시" }), null);
});

test("이전 대문자 작물 백업은 복원 전에 현재 소문자 계약으로 마이그레이션한다", () => {
  const [farm] = sanitizeFarmsFromDeviceBackup([{
    id: "farm-legacy",
    name: "기존 사과 농장",
    updatedAt: "2026-08-01T00:00:00.000Z",
    situation: "growing",
    crops: ["APPLE"],
    region: "인천광역시 남동구",
    cropSettings: {
      APPLE: {
        cultivation: "open-field",
        cycle: {
          seasonId: "season-legacy",
          anchorType: "FLOWERING",
          anchorDate: "2026-04-10",
          status: "ACTIVE",
        },
      },
    },
  }]);

  assert.deepEqual(farm.crops, ["apple"]);
  assert.equal(farm.cropSettings.apple.cultivation, "open-field");
  assert.equal(farm.cropSettings.apple.cycle.seasonId, "season-legacy");
  assert.equal("APPLE" in farm.cropSettings, false);
});
