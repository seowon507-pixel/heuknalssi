export function parseAssistantActionRequest(value) {
  const question = String(value ?? "").trim();
  const command = /(?:(?:추가|등록|기록)\s*(?:해\s*)?(?:줘|주세요|줘요|주실래(?:요)?|달라)?|(?:넣어|올려)\s*(?:줘|주세요|줘요|주실래(?:요)?)?)[.!?\s]*$/u.exec(
    question,
  );
  if (!command) {
    return null;
  }
  const body = question.slice(0, command.index);
  if (!/(할\s*일|작업|일정|목록)/u.test(body)) {
    return null;
  }
  const tomorrow = /내일/u.test(question);
  const cleaned = body
    .replace(/(?:할\s*일|작업|일정)(?:\s*목록)?\s*(?:으로|로|에)?/gu, " ")
    .replace(/목록\s*(?:으로|에)?/gu, " ")
    .replace(/(?:오늘|내일)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/(?:을|를)\s*$/u, "")
    .trim()
    .slice(0, 100);
  return {
    tomorrow,
    title: cleaned || (tomorrow ? "농장 확인" : "농장 상태 확인"),
  };
}
