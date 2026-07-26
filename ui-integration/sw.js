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
