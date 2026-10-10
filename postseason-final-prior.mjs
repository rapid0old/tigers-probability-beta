import {copySeriesJSON,freezeSeriesJSON,seriesId} from './cs-series-json.mjs';
export const FINAL_PRIOR_CATALOG_URL='./data/postseason-prior-2026.json';

// Input is an explicitly reviewed official aggregate export, never the current runtime dataset.
export function normalizeFinalDatasetSource(input,{test=false}={}) {
  const source=copySeriesJSON(input);
  if(source.season!==2026||source.phase!=='REGULAR'||source.source_kind!==(test?'TEST_REGULAR_SNAPSHOT':'OFFICIAL_REGULAR_FINAL'))throw new Error('Explicit classified final dataset input required');
  const d=source.dataset;
  if(!d||!Array.isArray(d.bat)||!Array.isArray(d.pit))throw new Error('Official batting/pitching aggregates required');
  if(!test&&(d.is_final!==true||d.phase!=='REGULAR'||d.finalization?.status!=='FINAL'||d.finalization.remaining_games!==0||d.finalization.pending_reschedules!==0))throw new Error('Dataset finality/remaining/pending confirmation required');
  const counts={bat:['pa','ab','h','s1','d2','t3','hr','bb','hbp','k','dp','sh','sf','sb','cs'],pit:['bf','h','hr','bb','hbp','k','r','er','outs']};
  for(const type of ['bat','pit'])for(const row of d[type]){
    for(const k of counts[type]){
      if(typeof row[k]==='string'&&/^\d+$/.test(row[k]))row[k]=Number(row[k]);
      if(row[k]!==undefined&&(!Number.isSafeInteger(row[k])||row[k]<0))throw new Error('Invalid aggregate count: '+type+'.'+k);
    }
  }
  return freezeSeriesJSON(source);
}
export async function buildFinalPriorAsset(input,{priorAPI,created_at,test=false}={}) {
  const source=normalizeFinalDatasetSource(input,{test});
  const prior=await priorAPI.buildPrior(source,{created_at});
  const checked=await priorAPI.validatePrior(prior);
  priorAPI.assertConnection(checked,{season:2026,phase:'POSTSEASON'},test?'TEST':'PRODUCTION');
  return checked;
}
export async function loadProductionFinalPrior({priorAPI,fetcher=fetch,catalogURL=FINAL_PRIOR_CATALOG_URL}={}) {
  const response=await fetcher(catalogURL,{cache:'no-store'});
  if(!response.ok)throw new Error('Final prior catalog unavailable');
  const c=copySeriesJSON(await response.json());
  if(c.schema_version!==1||c.season!==2026||c.purpose!=='PRODUCTION'||!['PENDING','READY'].includes(c.status))throw new Error('Production final prior catalog required');
  if(c.status==='PENDING'){
    if(c.asset!==null||c.prior_id!==null||c.content_hash!==null)throw new Error('Pending catalog cannot supply a prior');
    return null;
  }
  seriesId(c.prior_id);
  if(!/^\.\/data\/[A-Za-z0-9._-]+\.json$/.test(c.asset||''))throw new Error('Same-release prior asset required');
  const asset=await fetcher(c.asset,{cache:'no-store'});if(!asset.ok)throw new Error('Final prior asset unavailable');
  const prior=await priorAPI.validatePrior(await asset.json());priorAPI.assertConnection(prior,{season:2026,phase:'POSTSEASON'},'PRODUCTION');
  if(prior.prior_id!==c.prior_id||prior.content_hash!==c.content_hash)throw new Error('Final prior catalog/hash mismatch');
  return prior;
}
