import assert from "node:assert/strict";
import test from "node:test";
import { parseAssistantActionRequest } from "./assistant-action-request.mjs";

test("챗봇 할 일 요청에서 명령 표현과 조사만 제거한다", () => {
  assert.deepEqual(
    parseAssistantActionRequest("내일 관수시설 확인을 할 일로 추가해줘"),
    { tomorrow: true, title: "관수시설 확인" },
  );
});

test("일반 농업 질문은 쓰기 제안으로 바꾸지 않는다", () => {
  assert.equal(parseAssistantActionRequest("내일 비가 오나요?"), null);
});

test("등록된 할 일 조회 문장은 쓰기 제안으로 오인하지 않는다", () => {
  for (const question of [
    "등록된 할 일 보여줘",
    "기록한 작업 목록 알려줘",
    "내일 일정이 뭐야?",
    "할 일 추가 방법을 알려줘",
  ]) {
    assert.equal(parseAssistantActionRequest(question), null, question);
  }
});

test("시간 표현이 제목 뒤에 있어도 제목 어순을 보존한다", () => {
  assert.deepEqual(
    parseAssistantActionRequest("관수시설 확인을 내일 할 일로 추가해줘"),
    { tomorrow: true, title: "관수시설 확인" },
  );
});

test("목록에 넣어줘를 명시적인 추가 요청으로 인식한다", () => {
  assert.deepEqual(
    parseAssistantActionRequest("내일 관수시설 확인을 목록에 넣어줘"),
    { tomorrow: true, title: "관수시설 확인" },
  );
});
