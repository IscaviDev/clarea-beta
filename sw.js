/* Clarea service worker.
   - Each published version has its own cache, filled when the new version is downloaded.
   - The new version waits until the user taps "Actualizar" (message SKIP_WAITING), then the page reloads.
   - Works without internet: everything is answered from the cache. */
const CACHE = "clarea-20261116185330";
// las páginas y todo lo de assets/ (la lista la escribe el build: tools/vite-clarea.js)
const CORE = ["./","./index.html","./repaso-pj6.html","./proyecto.html","./preguntas.html","./privacidad.html","./manifest.webmanifest","./assets/css/index-BLRu3dGO.css","./assets/css/preguntas-CjqYiaPv.css","./assets/css/privacidad-MprRahGH.css","./assets/css/proyecto-CrSnqvIi.css","./assets/css/repaso-pj6-BMJF5Q73.css","./assets/img/apple-touch-icon.png","./assets/img/favicon.png","./assets/img/icon-192.png","./assets/img/icon-512.png","./assets/js/arranque-7fc6e0b3.js","./assets/js/arriba-DqIk59Ij.js","./assets/js/comun-Bf72GwyB.js","./assets/js/ia-B9FJbrQ-.js","./assets/js/index-CwTVABnR.js","./assets/js/menu-paginas-DpUgNuBW.js","./assets/js/preguntas-Cocyr9KE.js","./assets/js/proyecto-j-JCMhq1.js","./assets/js/repaso-pj6-DVWfH17B.js"];

function pageKey(req){ const p = new URL(req.url).pathname; return /repaso-pj6\.html$/.test(p) ? "./repaso-pj6.html" : /proyecto\.html$/.test(p) ? "./proyecto.html" : /preguntas\.html$/.test(p) ? "./preguntas.html" : /privacidad\.html$/.test(p) ? "./privacidad.html" : "./index.html"; }

self.addEventListener("install", e => {
  // download the new version completely (bypassing the browser cache), but don't take over yet
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, {cache: "reload"})))));
});

self.addEventListener("message", e => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const mine = await caches.open(CACHE);
    for (const k of await caches.keys()) {
      if (k === CACHE) continue;
      // keep the downloaded fonts so the app still looks right offline, then drop the old version
      const old = await caches.open(k);
      for (const req of await old.keys()) if (/fonts\.(googleapis|gstatic)\.com/.test(req.url)) { const r = await old.match(req); if (r) await mine.put(req, r); }
      await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  // only this app's files and its fonts are cached; the cloud (sync) always goes to the network
  const host = new URL(req.url);
  if (host.origin !== self.location.origin && !/^fonts\.(googleapis|gstatic)\.com$/.test(host.hostname)) return;
  const isPage = req.mode === "navigate";
  e.respondWith(caches.open(CACHE).then(c =>
    c.match(isPage ? pageKey(req) : req).then(hit => hit || fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque") && !isPage) c.put(req, res.clone());
      return res;
    }).catch(() => hit || Response.error()))
  ));
});

// tapping a notification opens (or brings to the front) the page it talks about
// a reminder sent by the Clarea push Worker (arrives also with Clarea closed)
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = {title: "Clarea", body: e.data ? e.data.text() : ""}; }
  e.waitUntil(self.registration.showNotification(d.title || "Clarea", {body: d.body || "", icon: "assets/img/icon-192.png", badge: "assets/img/icon-192.png", tag: d.tag || undefined, data: {url: d.url || "./"}}));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type: "window", includeUncontrolled: true}).then(list => {
    for (const c of list) if ("focus" in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
