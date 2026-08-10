// 귀농이 게임 API(출석·작물·토양검정 등)를 Vercel 서버리스 함수로 노출합니다.
// src/server.js의 handleRequest(req,res)를 그대로 재사용합니다 — 로컬(node src/server.js)과
// 이 함수가 완전히 같은 라우팅 로직을 씁니다.
// vercel.json의 rewrite가 /api/* 요청을 이 함수로 보냅니다
// (코어 분석 백엔드는 /core-api/*로 따로 노출되어 경로가 겹치지 않습니다).

import { handleRequest } from '../src/server.js';

export default async function handler(request, response) {
  restoreRequestUrl(request);
  await handleRequest(request, response);
}

function restoreRequestUrl(request) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const forwardedPath = url.searchParams.get('__vpath');
  if (forwardedPath !== null && forwardedPath.startsWith('/')) {
    url.searchParams.delete('__vpath');
    const pathname = forwardedPath.split('?')[0];
    request.url = `${pathname}${url.search}`;
  }
}
