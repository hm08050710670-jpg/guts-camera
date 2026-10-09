/* ==========================================================
   GUTS CAMERA  Service Worker
   - アプリ本体（HTML / CSS / JS / アイコン）だけをキャッシュする。
     動画は IndexedDB に保存し、ここではキャッシュしない。
   - 表示はキャッシュ優先（電波が弱い練習場でもすぐ起動）。
     同時に裏で最新版を確認し、変更があればキャッシュを更新して
     画面に「新しいバージョンがあります」と知らせる。
   - そのため、ファイルを更新するたびにこのファイルを書き換える必要はない。
   ========================================================== */
var CACHE = 'guts-camera-shell-v1';
var SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(SHELL.map(function (url) {
        return fetch(url, { cache: 'reload' }).then(function (res) {
          if (res.ok) return cache.put(url, res);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE && k.indexOf('guts-camera-shell-') === 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  var x = new Uint8Array(a), y = new Uint8Array(b);
  for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function notifyUpdated() {
  return self.clients.matchAll({ type: 'window' }).then(function (list) {
    list.forEach(function (c) { c.postMessage({ type: 'app-updated' }); });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return;

  // ページの表示は常に index.html を返す
  var key = req.mode === 'navigate' ? new URL('./index.html', self.registration.scope).href : url.origin + url.pathname;

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(key).then(function (cached) {
        var cachedCopy = cached ? cached.clone() : null;
        var refresh = fetch(key, { cache: 'no-cache' }).then(function (res) {
          if (!res || !res.ok) return res;
          var fresh = res.clone();
          if (!cachedCopy) return cache.put(key, fresh).then(function () { return res; });
          return Promise.all([cachedCopy.arrayBuffer(), res.clone().arrayBuffer()]).then(function (bufs) {
            if (sameBytes(bufs[0], bufs[1])) return res;
            return cache.put(key, fresh).then(notifyUpdated).then(function () { return res; });
          });
        }).catch(function () { return null; });

        if (cached) {
          event.waitUntil(refresh);
          return cached;
        }
        return refresh.then(function (res) {
          return res || new Response('オフラインのため表示できません。', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        });
      });
    })
  );
});
