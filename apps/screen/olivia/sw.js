const CACHE='family-children-v7';
const LEGACY_PREFIXES=['family-children-','olivia-school-'];
const ASSETS=['./','./index.html','./style.css','./app.js','./manifest.webmanifest','./icon.svg'];

async function fresh(request){
  return fetch(request,{cache:'no-store'});
}

self.addEventListener('install',e=>e.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  for(const asset of ASSETS){
    try{
      const response=await fresh(new Request(asset,{cache:'reload'}));
      if(response.ok) await cache.put(asset,response.clone());
    }catch{}
  }
  await self.skipWaiting();
})()));

self.addEventListener('activate',e=>e.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k!==CACHE&&LEGACY_PREFIXES.some(p=>k.startsWith(p))).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  const url=new URL(e.request.url);
  if(url.origin!==self.location.origin) return;
  const inScope=url.pathname.startsWith(new URL(self.registration.scope).pathname);
  if(!inScope) return;

  e.respondWith((async()=>{
    try{
      const response=await fresh(e.request);
      if(response.ok){
        const cache=await caches.open(CACHE);
        await cache.put(e.request,response.clone());
      }
      return response;
    }catch{
      return (await caches.match(e.request)) || (e.request.mode==='navigate' ? await caches.match('./index.html') : Response.error());
    }
  })());
});

self.addEventListener('push',e=>{
  let d={title:'Barna',body:'Ny påminnelse'};
  try{d={...d,...e.data.json()}}catch{}
  e.waitUntil(self.registration.showNotification(d.title,{body:d.body,icon:'./icon.svg',badge:'./icon.svg',data:{url:d.url||'./'}}));
});

self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url||'./'));
});
