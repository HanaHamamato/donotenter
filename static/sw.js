self.addEventListener('install', e=>{
  self.skipWaiting();
});
self.addEventListener('activate', e=>{
  e.waitUntil(clients.claim());
});
self.addEventListener('fetch', e=>{
  // cache static assets only, not websockets
  if(e.request.url.includes('/ws')) return;
  e.respondWith(
    caches.open('vanguard-v1').then(cache=>{
      return cache.match(e.request).then(res=>{
        return res || fetch(e.request).then(net=>{
          if(e.request.method==='GET' && net.ok) cache.put(e.request, net.clone());
          return net;
        });
      });
    }).catch(()=>fetch(e.request))
  );
});
