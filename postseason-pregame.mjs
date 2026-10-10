import {copySeriesJSON,freezeSeriesJSON,canonicalSeriesJSON,hashSeriesJSON} from './cs-series-json.mjs';
import {validateSeriesRecord} from './cs-series-adapter.mjs';
import {createPostseasonGameBinding} from './postseason-game-binding.mjs';
import {createRegularPregameKernel} from './regular-pregame-kernel.mjs';
export const PREGAME_MODEL_ID='regular-player-pa-v4.0.1-pregame-4500';

// Pregame use of Regular's existing smoothed PA/base engine, from 0-0 and empty bases.
// No live learning, current-game score, What-if or empirical Regular tie rate enters it.
function predict(model,binding,seed) {
  const k=createRegularPregameKernel(model),rng=k.seeded(seed),r=binding.game_rules;
  const home=binding.homeTeamId,away=binding.awayTeamId,probabilities={};
  for(const [team,def]of [[home,away],[away,home]]){
    const lineup=model.byBat[team].slice(0,9);
    probabilities[team]=Array.from({length:9},(_,i)=>k.eventProbs(lineup[i]||lineup[0],null,def));
  }
  let homeWins=0,awayWins=0,ties=0;const N=4500;
  for(let sample=0;sample<N;sample++){
    let hs=0,as=0;const positions={[home]:0,[away]:0};
    for(let inning=1;inning<=r.max_innings;inning++){
      for(const team of [away,home]){
        if(team===home&&inning>=r.regulation_innings&&hs>as)break;
        let outs=0,bases=0,guard=0;
        while(outs<3&&guard++<80){
          const pr=probabilities[team][positions[team]%9],res=k.applyEvent(k.pickEvent(pr,rng),bases,outs,rng,pr.dpCond);
          positions[team]=(positions[team]+1)%9;bases=res.b;outs=res.o;
          if(team===home)hs+=res.runs;else as+=res.runs;
          if(team===home&&r.walkoff_allowed&&inning>=r.regulation_innings&&hs>as)break;
        }
      }
      if(inning>=r.regulation_innings&&hs!==as)break;
    }
    if(hs>as)homeWins++;else if(as>hs)awayWins++;else ties++;
  }
  return {homeWin:homeWins/N,awayWin:awayWins/N,tie:ties/N};
}
export async function createPregameProbabilityInput({prior,priorAPI,series,bindings,model_id=PREGAME_MODEL_ID,testAuthorized=false,created_at}) {
  const pinnedPrior=prior==null?null:copySeriesJSON(prior),record=validateSeriesRecord(series),raw=copySeriesJSON(bindings);
  if(!pinnedPrior)return Object.freeze({status:'PENDING',reason:'Regular最終公式prior未準備',input:null});
  if(record.purpose==='TEST'&&!testAuthorized)throw new Error('TEST probability requires boot authorization');
  if(model_id!==PREGAME_MODEL_ID)throw new Error('Unsupported explicit pregame model identity');
  const checked=await priorAPI.validatePrior(pinnedPrior);priorAPI.assertConnection(checked,{season:2026,phase:'POSTSEASON'},record.purpose);
  const expected=record.decision.finished?0:record.rules.maxPhysicalGames-record.state.physicalGamesPlayed;
  if(raw.length!==expected)throw new Error('Every remaining schedule slot must have an explicit binding');
  const verified=[];
  for(let i=0;i<raw.length;i++){
    if(raw[i].game_number!==record.state.physicalGamesPlayed+i+1)throw new Error('Pregame physical slot order mismatch');
    verified.push(await createPostseasonGameBinding({binding:raw[i],series:record,testAuthorized}));
  }
  const seriesEquivalent=verified.some(b=>b.game_rules.clinch_tie_called_game===true);
  for(const b of verified){
    const r=b.game_rules;
    if(b.binding_status!=='READY'||r.tie_at_limit!==true||r.max_innings>30)return Object.freeze({status:'PENDING',reason:'確率計算に必要な終了・延長条件の公式確認待ち',input:null});
    if(r.max_innings>r.regulation_innings&&r.extra_inning_base_policy!=='EMPTY')return Object.freeze({status:'PENDING',reason:'延長開始時の走者条件が未確認または未対応（戦績登録は利用可能）',input:null});
    if(r.clinch_tie_called_game===true&&(r.regulation_innings!==9||r.max_innings!==12||r.walkoff_allowed!==true||r.tie_replay!==false||b.homeTeamId!==record.context.higherTeamId))return Object.freeze({status:'PENDING',reason:'Series突破確率と等価性を確認できない終了条件（戦績登録は利用可能）',input:null});
  }
  const layer=await priorAPI.createDataLayer({phaseContext:{season:2026,phase:'POSTSEASON'},prior:checked,purpose:record.purpose});
  if(verified.some(b=>![b.homeTeamId,b.awayTeamId].every(t=>layer.model.byBat[t]?.length&&layer.model.byPit[t]?.length)))return Object.freeze({status:'PENDING',reason:'対戦球団のfinal dataset不足',input:null});
  const cache=new Map(),games=[];
  for(const b of verified){
    const key=canonicalSeriesJSON({prior_id:checked.prior_id,model_id,home:b.homeTeamId,away:b.awayTeamId,rules:b.game_ruleset_fingerprint});
    if(!cache.has(key))cache.set(key,predict(layer.model,b,key));
    const p=cache.get(key),higherHome=b.homeTeamId===record.context.higherTeamId;
    games.push({physical_game_number:b.game_number,upperWin:higherHome?p.homeWin:p.awayWin,lowerWin:higherHome?p.awayWin:p.homeWin,tie:p.tie});
  }
  const provenance=await hashSeriesJSON({prior_id:checked.prior_id,model_id,bindings:verified});
  // CS12 called ties move only HOME-win mass into TIE at states where both
  // children already advance HIGHER. The unchanged DP gives both children value
  // 1 and zero further games. Thus this ordinary CS12 kernel is Series-equivalent,
  // including expected game count, but NOT the official individual-game W/L/T
  // distribution at those states. Keep that distinction in persisted provenance.
  const prefix=seriesEquivalent?'pregame/cs12-series-equivalent-v1/':'pregame/';
  return freezeSeriesJSON({status:'READY',reason:null,input:{games,probability_source_id:prefix+provenance,model_id,dataset_id:checked.source_dataset_id,created_at}});
}
