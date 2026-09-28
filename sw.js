/* 오프라인 실행용 서비스워커 — 앱 파일만 캐시하고, GitHub API 요청은 건드리지 않는다 */
const V = "2.0.0";
const CACHE = "networth-" + V;
const SHELL = ["./", "index.html", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
  "js/engine.js?v=" + V, "js/holdings.js?v=" + V, "js/networth.js?v=" + V, "js/sync.js?v=" + V, "js/app.js?v=" + V];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith("networth-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if(req.method !== "GET") return;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;              // api.github.com 등 외부 요청은 그대로 통과
  if(req.mode === "navigate"){
    // 화면은 네트워크 우선 — 새 버전을 바로 받고, 오프라인이면 저장본
    e.respondWith(fetch(req).then(res => {
      if(res.ok){ const cp = res.clone(); caches.open(CACHE).then(c => c.put("index.html", cp)); }
      return res;
    }).catch(() => caches.match("index.html").then(r => r || caches.match("./"))));
    return;
  }
  // 버전이 붙은 앱 파일은 캐시 우선
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if(res.ok){ const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
    return res;
  })));
});
