// Release readiness 2026-10-11: availability labels updated; storage is retained.
import {RELEASE_CACHE,CORE_ASSETS} from './postseason-release-assets.mjs';
import {validateScheduleManifest,SCHEDULE_URL} from './postseason-schedule.mjs';
import {FINAL_PRIOR_CATALOG_URL,loadProductionFinalPrior} from './postseason-final-prior.mjs';
import './postseason-model.js';
const CACHE=RELEASE_CACHE,CORE=CORE_ASSETS;
const urlFor=asset=>new URL(asset,self.location.href).href;

async function verifiedSchedule(request,cache){
  try{
    const response=await fetch(request,{cache:'no-store'});if(!response.ok)throw new Error('Schedule unavailable');
    validateScheduleManifest(await response.clone().json());
    await cache.put(urlFor(SCHEDULE_URL),response.clone());return response;
  }catch(error){const cached=await cache.match(urlFor(SCHEDULE_URL));if(cached)return cached;throw error}
}
async function verifiedPriorCatalog(request,cache){
  try{
    const responses=new Map();
    await loadProductionFinalPrior({priorAPI:globalThis.TigersPostseason,fetcher:async asset=>{
      const response=await fetch(urlFor(asset),{cache:'no-store'});responses.set(asset,response.clone());return response;
    }});
    // Publish the catalog after its validated asset. Offline reload always gets a matching prior.
    for(const [asset,response]of responses)if(asset!==FINAL_PRIOR_CATALOG_URL)await cache.put(urlFor(asset),response);
    const response=responses.get(FINAL_PRIOR_CATALOG_URL);await cache.put(urlFor(FINAL_PRIOR_CATALOG_URL),response.clone());return response;
  }catch(error){const cached=await cache.match(urlFor(FINAL_PRIOR_CATALOG_URL));if(cached)return cached;throw error}
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await cache.addAll(CORE.filter(a=>a!==SCHEDULE_URL&&a!==FINAL_PRIOR_CATALOG_URL));
  const response=await fetch(urlFor(SCHEDULE_URL),{cache:'no-store'});if(!response.ok)throw new Error('Schedule missing');
  validateScheduleManifest(await response.clone().json());await cache.put(urlFor(SCHEDULE_URL),response);
  await verifiedPriorCatalog(new Request(urlFor(FINAL_PRIOR_CATALOG_URL)),cache);
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  await Promise.all((await caches.keys()).filter(k=>k!==CACHE&&(k.startsWith('tigers-probability-beta-'))).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  const schedule=url.pathname===new URL(SCHEDULE_URL,self.location.href).pathname;
  const catalog=url.pathname===new URL(FINAL_PRIOR_CATALOG_URL,self.location.href).pathname;
  const core=CORE.some(asset=>new URL(asset,self.location.href).pathname===url.pathname);
  const possiblePrior=/\/data\/[^/]+\.json$/.test(url.pathname);
  if(!core&&!possiblePrior)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    if(schedule)return verifiedSchedule(request,cache);
    if(catalog)return verifiedPriorCatalog(request,cache);
    if(possiblePrior&&!core){
      const c=await cache.match(urlFor(FINAL_PRIOR_CATALOG_URL)),meta=c?await c.json():null;
      if(meta?.asset&&url.href===urlFor(meta.asset)){const prior=await cache.match(urlFor(meta.asset));if(prior)return prior}
      return fetch(request); // Other JSON files are not added to the release cache.
    }
    if(request.mode==='navigate'){
      try{const response=await fetch(request);if(!response.ok)throw new Error('Navigation unavailable');await cache.put('./index.html',response.clone());return response}
      catch{return cache.match('./index.html')}
    }
    return await cache.match(request)||fetch(request);
  })());
});
