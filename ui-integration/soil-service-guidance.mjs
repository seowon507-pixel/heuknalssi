export function hasMissingSoilExamHistory(analysis) {
  const source = (analysis?.dataSources ?? []).find(
    (item) => item?.sourceId === "soil-exam-v2",
  );
  return source?.adapterState === "NO_DATA";
}
