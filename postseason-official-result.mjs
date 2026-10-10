import {copySeriesJSON,freezeSeriesJSON,seriesId,seriesRevision,seriesTimestamp} from './cs-series-json.mjs';

export function validateOfficialFinalResult(input,{purpose,testAuthorized=false}={}) {
  const r=copySeriesJSON(input);
  if(r.source!=='VERIFIED_OFFICIAL_RESULT'||r.confirmed!==true||r.status!=='FINAL'||r.purpose!==purpose||
      r.season!==2026||r.phase!=='POSTSEASON'||r.competition!=='CS'||!['FIRST','FINAL'].includes(r.stage))throw new Error('Explicit confirmed official FINAL result required');
  if(purpose==='TEST'&&(!testAuthorized||r.origin!=='TEST_FIXTURE'))throw new Error('TEST result requires boot-authorized fixture');
  if(purpose==='PRODUCTION'&&(r.origin!=='NPB_OFFICIAL'||!/^https:\/\/npb\.jp\//.test(r.source_url||'')))throw new Error('Verified NPB official result URL required');
  for(const k of ['game_id','series_id','homeTeamId','awayTeamId'])seriesId(r[k],k);
  if(r.homeTeamId===r.awayTeamId)throw new Error('Distinct result participants required');
  seriesRevision(r.source_revision);seriesTimestamp(r.verified_at);
  if(![r.homeScore,r.awayScore].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=999))throw new Error('Strict final score required');
  const result=r.homeScore===r.awayScore?'TIE':r.homeScore>r.awayScore?'HOME_WIN':'AWAY_WIN';
  if(r.result!==result)throw new Error('Official final score/result mismatch');
  return freezeSeriesJSON(r);
}
