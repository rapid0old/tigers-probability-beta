// Live input and immutable completion use the same termination boundary.
// A hypothetical tie is evaluated by the existing Series rules; it is never appended.
import {validateSeriesRecord} from './cs-series-adapter.mjs';
import {recordCSPhysicalResult,decideCSSeries} from './postseason-rules.mjs';

export function tieWouldClinchForHome(binding,series) {
  const r=validateSeriesRecord(series),c=r.context;
  if(r.decision.finished)return false;
  for(const k of ['season','phase','competition','stage','series_id'])if(binding[k]!==c[k])throw new Error('Termination SeriesContext mismatch: '+k);
  if(![c.higherTeamId,c.lowerTeamId].includes(binding.homeTeamId)||![c.higherTeamId,c.lowerTeamId].includes(binding.awayTeamId)||binding.homeTeamId===binding.awayTeamId)throw new Error('Termination participant mismatch');
  const d=decideCSSeries(r.rules,recordCSPhysicalResult(r.rules,r.state,'TIE'));
  return d.finished&&(d.winner==='HIGHER_SEED'?c.higherTeamId:c.lowerTeamId)===binding.homeTeamId;
}
const end=endReason=>Object.freeze({status:'END',endReason});
const pending=reason=>Object.freeze({status:'PENDING',reason});
const continuing=Object.freeze({status:'CONTINUE'});
export function resolvePostseasonGameEnd({binding,series,inning,half,homeScore,awayScore,outs,boundary,halfStart=null}) {
  const r=binding.game_rules;
  if(!['top','bottom'].includes(half)||!['SCORE','HALF_END'].includes(boundary)||!Number.isSafeInteger(inning)||inning<1||
    ![homeScore,awayScore].every(x=>Number.isSafeInteger(x)&&x>=0&&x<=999))return pending('INVALID_TERMINATION_INPUT');
  if(r.status!=='RESOLVED')return pending('POSTSEASON_CONTINUATION_UNCONNECTED');
  if(inning>r.max_innings)return pending('GAME_RULE_HORIZON_EXCEEDED');
  if(inning<r.regulation_innings)return continuing;
  const special=r.clinch_tie_called_game===true&&inning===12&&tieWouldClinchForHome(binding,series);
  if(special&&half==='top'&&boundary==='HALF_END'&&homeScore===awayScore)return end('clinch-tie-after-top');
  if(special&&half==='bottom'&&homeScore>=awayScore){
    const known=halfStart?.inning===inning&&halfStart.half===half&&halfStart.homeTeamId===binding.homeTeamId&&halfStart.awayTeamId===binding.awayTeamId&&
      [halfStart.homeScore,halfStart.awayScore].every(x=>Number.isSafeInteger(x)&&x>=0&&x<=999);
    if(!known)return pending('CLINCH_HALF_START_UNCONFIRMED');
    if(halfStart.homeScore<halfStart.awayScore){
      // The public CS rule stops at the tying run. Do not infer a final score for an
      // atomic multi-run input (including HR) that skips over that score.
      if(homeScore>awayScore)return pending('CLINCH_MULTI_RUN_OFFICIAL_RESULT_REQUIRED');
      if(boundary==='SCORE'&&Number.isInteger(outs)&&outs<3)return end('clinch-tie-during-bottom');
    }
  }
  if(boundary==='SCORE')return half==='bottom'&&homeScore>awayScore&&r.walkoff_allowed!==false&&outs<3?end('walkoff'):continuing;
  if(half==='top')return homeScore>awayScore?end('home-lead-after-top'):continuing;
  if(homeScore!==awayScore)return end(homeScore>awayScore?'home-win-after-bottom':'away-win-after-bottom');
  if(inning===r.max_innings)return r.tie_at_limit?end('draw-at-limit'):pending('POSTSEASON_CONTINUATION_UNCONNECTED');
  return continuing;
}
