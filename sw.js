/* OPM Handy-App – Service Worker: entschlüsselt Dateien (_blob/<id>) auf dem Handy und hält den letzten Stand offline bereit. */
var BUILD = '25745f639ef79c12';
var SHELL = 'opm-shell-2', FILES = 'opm-files-2', EXT = 'opm-ext';   /* -2: alte Zwischenspeicher (vor dem Kalkulations-Schutz) werden gelöscht */
var dec = new TextDecoder();

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then(function(c){ return c.addAll(['./', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png']); }).catch(function(){}));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.filter(function(k){ return [SHELL, FILES, EXT].indexOf(k) < 0; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

function idbGet(k){
  return new Promise(function(res){
    var r = indexedDB.open('opm', 1);
    r.onupgradeneeded = function(){ r.result.createObjectStore('kv'); };
    r.onerror = function(){ res(null); };
    r.onsuccess = function(){
      try{ var q = r.result.transaction('kv', 'readonly').objectStore('kv').get(k); q.onsuccess = function(){ res(q.result || null); }; q.onerror = function(){ res(null); }; }
      catch(e){ res(null); }
    };
  });
}
var keyCache = {};
function imp(r){
  if(keyCache[r]) return Promise.resolve(keyCache[r]);
  var b = atob(r), u = new Uint8Array(b.length); for(var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return crypto.subtle.importKey('raw', u, {name: 'AES-GCM'}, false, ['decrypt']).then(function(k){ keyCache[r] = k; return k; });
}
/* Liste der Schlüssel dieses Handys: Team-Schlüssel, bei der Leitung zusätzlich der Leitungs-Schlüssel */
function schluessel(){
  return idbGet('key').then(function(s){
    if(!s) return [];
    return Promise.all([s.raw ? imp(s.raw) : null, s.raw2 ? imp(s.raw2) : null]).then(function(ks){ return ks.filter(Boolean); });
  });
}
function entschluesselMit(keys, u, i){
  if(i >= keys.length) return Promise.reject(new Error('kein Schlüssel'));
  return crypto.subtle.decrypt({name: 'AES-GCM', iv: u.slice(0, 12)}, keys[i], u.slice(12)).catch(function(){ return entschluesselMit(keys, u, i + 1); });
}

function datei(id, req){
  /* Dateien des Bereichs Airports (Kennzeichen a-) liegen im zweiten Repository: gleiche Herkunft, Nachbarordner */
  var pfad = (/^(k-)?a-/.test(id) ? '../opm-airports/f/' : 'f/') + id + '.enc';
  return caches.open(FILES).then(function(c){
    return c.match(pfad).then(function(hit){
      if(hit) return hit;
      return fetch(pfad).then(function(r){ if(r.ok) c.put(pfad, r.clone()); return r; });
    });
  }).then(function(r){
    if(!r.ok) return new Response('Diese Datei gibt es nur in der Datenbank am Rechner.', {status: 404, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
    return Promise.all([r.arrayBuffer(), schluessel()]).then(function(x){
      if(!x[1].length) return new Response('', {status: 403});
      var u = new Uint8Array(x[0]);
      return entschluesselMit(x[1], u, 0).then(function(p){
        p = new Uint8Array(p);
        var tl = (p[0] << 8) | p[1], typ = dec.decode(p.slice(2, 2 + tl)), body = p.slice(2 + tl), n = body.length;
        var range = req.headers.get('range'), m = range && /bytes=(\d*)-(\d*)/.exec(range);
        if(m){
          var a = m[1] === '' ? Math.max(0, n - Number(m[2])) : Number(m[1]);
          var b = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), n - 1) : n - 1;
          return new Response(body.slice(a, b + 1), {status: 206, headers: {'Content-Type': typ, 'Content-Range': 'bytes ' + a + '-' + b + '/' + n, 'Content-Length': String(b - a + 1), 'Accept-Ranges': 'bytes'}});
        }
        return new Response(body, {headers: {'Content-Type': typ, 'Content-Length': String(n), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'}});
      });
    });
  }).catch(function(){ return new Response('', {status: 503}); });
}

function netzZuerst(req, schluesselUrl){
  return fetch(req).then(function(r){
    if(r.ok){ var k = r.clone(); caches.open(SHELL).then(function(c){ c.put(schluesselUrl, k); }); }
    return r;
  }).catch(function(){ return caches.open(SHELL).then(function(c){ return c.match(schluesselUrl); }).then(function(h){ return h || new Response('', {status: 503}); }); });
}
function cacheZuerst(req, name){
  return caches.open(name).then(function(c){
    return c.match(req).then(function(h){
      var netz = fetch(req).then(function(r){ if(r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(function(){ return h; });
      return h || netz;
    });
  });
}

self.addEventListener('fetch', function(e){
  var req = e.request; if(req.method !== 'GET') return;
  var url = new URL(req.url);
  if(url.origin === location.origin){
    var m = url.pathname.match(/\/_blob\/([^\/]+)$/);
    if(m) return e.respondWith(datei(decodeURIComponent(m[1]), req));
    if(/\/version\.json$/.test(url.pathname)) return;               // immer frisch vom Netz
    if(/\/(app|data)\.enc$/.test(url.pathname)) return e.respondWith(netzZuerst(req, url.pathname));
    if(/\/geo\//.test(url.pathname)) return e.respondWith(cacheZuerst(req, SHELL));
    if(/\/f\//.test(url.pathname)) return;
    var schl = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html') ? './' : url.pathname;
    return e.respondWith(netzZuerst(req, schl));
  }
  if(/fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com/.test(url.host)) return e.respondWith(cacheZuerst(req, EXT));
});
