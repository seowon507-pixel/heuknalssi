const SAMPLE_PNU = "4611010100101830025";

const PROVIDERS = Object.freeze([
  Object.freeze({
    id: "soil-exam-v2",
    endpoint:
      "https://apis.data.go.kr/1390802/SoilEnviron/SoilExam/V2/getSoilExam",
  }),
  Object.freeze({
    id: "soil-character-v3",
    endpoint:
      "https://apis.data.go.kr/1390802/SoilEnviron/SoilCharac/V3/getSoilCharacter",
  }),
]);

function extractResultCode(xml) {
  return (
    /<(?:Result_Code|result_Code)>([^<]+)<\/(?:Result_Code|result_Code)>/iu.exec(
      xml,
    )?.[1]?.trim() ?? null
  );
}

function extractFieldNames(xml) {
  const item =
    /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/iu.exec(xml)?.[1] ?? "";
  return [
    ...new Set(
      [...item.matchAll(/<([A-Za-z_][\w.-]*)>/gu)].map((match) => match[1]),
    ),
  ].filter((field) => !/pnu/iu.test(field));
}

function safeErrorCode(error) {
  if (error?.name === "TimeoutError") return "TIMEOUT";
  return "NETWORK_ERROR";
}

async function probe({ id, endpoint }, serviceKey) {
  const url = new URL(endpoint);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("PNU_Code", SAMPLE_PNU);
  const response = await fetch(url, {
    headers: { Accept: "application/xml, text/xml" },
    signal: AbortSignal.timeout(10_000),
  });
  const xml = await response.text();
  return {
    id,
    httpStatus: response.status,
    resultCode: extractResultCode(xml),
    fields: extractFieldNames(xml),
  };
}

const serviceKey = String(process.env.DATA_GO_KR_SERVICE_KEY ?? "").trim();
if (!serviceKey) {
  console.log(
    JSON.stringify({ state: "NOT_CONFIGURED", providers: [] }, null, 2),
  );
  process.exitCode = 1;
} else {
  const providers = [];
  for (const provider of PROVIDERS) {
    try {
      providers.push(await probe(provider, serviceKey));
    } catch (error) {
      providers.push({
        id: provider.id,
        errorCode: safeErrorCode(error),
      });
    }
  }
  console.log(JSON.stringify({ state: "COMPLETE", providers }, null, 2));
}
