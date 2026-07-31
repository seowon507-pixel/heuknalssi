// 흙날씨 서비스워커.
// 홈 화면 설치와 알림 표시를 담당한다. 자료를 캐시하지 않는다 —
// 분석 결과는 항상 서버에서 새로 받아야 하고, 오래된 예보를 보여주면
// 위험하기 때문이다.

const NOTIFICATION_TAG = "heuknalssi-daily";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data ?? {};
  if (data.type !== "SHOW_NOTIFICATION") return;
  event.waitUntil(
    self.registration.showNotification(data.title ?? "흙날씨 알림", {
      body: data.body ?? "",
      tag: data.tag ?? NOTIFICATION_TAG,
      renotify: true,
      requireInteraction: false,
      badge: "/icons/icon-fullbleed-192.png",
      icon: "/icons/icon-fullbleed-192.png",
      lang: "ko",
      data: { url: "/" },
    }),
  );
});

// 앱을 나가 있어도 뜨는 알림은 이 경로로만 온다. 페이지의 타이머는
// 홈 화면으로 나가는 순간 멈추기 때문이다.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    /* 규격 밖 본문이면 기본 문구로 띄운다 */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "흙날씨 알림", {
      body: payload.body || "앱을 열어 확인해 주세요.",
      tag: payload.tag || NOTIFICATION_TAG,
      renotify: true,
      requireInteraction: false,
      badge: "/icons/icon-fullbleed-192.png",
      icon: "/icons/icon-fullbleed-192.png",
      lang: "ko",
      data: { url: payload.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) return client.focus();
        }
        return self.clients.openWindow(target);
      }),
  );
});
