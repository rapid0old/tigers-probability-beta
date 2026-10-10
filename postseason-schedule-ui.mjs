import {SCHEDULE_URL, SCHEDULE_TEAM_NAMES, validateScheduleManifest, describeScheduleSlot, prepareManifestBinding} from './postseason-schedule.mjs';
import {PostseasonSeriesRepository} from './cs-series-store.mjs';
import {createPregameProbabilityInput} from './postseason-pregame.mjs';

export function createScheduleSelector({root,runtime,storage,testAuthorized=false}) {
  let manifest=null,selected=null,pending=false,message='',loadEpoch=0,probabilityStatus='Regular最終公式prior未準備';
  const purpose=runtime.completionPurpose(),cacheKey='tigersProbabilityBeta.2026.POSTSEASON.v1.schedule.'+purpose;
  root.innerHTML=`<label>2026 セ・CS Final 試合<select data-schedule="game" aria-label="CS公式試合"></select></label>
    <p data-schedule="matchup"></p><p data-schedule="details"></p><p data-schedule="status" role="status"></p>
    <button type="button" data-schedule="bind">この試合を開始</button><button type="button" data-schedule="recheck">ルールを再確認・再開</button>
    <p data-schedule="prior"></p><p><a data-schedule="source" target="_blank" rel="noopener">確認元の公式日程</a></p>
    <details data-schedule="final"><summary>公式の最終結果をSeriesへ登録</summary><p>NPB公式で試合終了と最終スコアを確認した場合だけ使用します。Gameの入力履歴は変更しません。</p>
      <label>公式結果URL<input type="url" data-schedule="resultURL" placeholder="https://npb.jp/…"></label>
      <div class="row"><label>HOME最終得点<input type="number" min="0" max="999" data-schedule="homeScore"></label><label>AWAY最終得点<input type="number" min="0" max="999" data-schedule="awayScore"></label></div>
      <label>確認元revision（変更時は別の値）<input type="number" min="0" data-schedule="resultRevision" value="0"></label>
      <label>確認時刻（UTC）<input type="text" data-schedule="verifiedAt"></label><button type="button" data-schedule="register">公式終了を確認して登録</button>
    </details>`;
  const el=name=>root.querySelector('[data-schedule="'+name+'"]');el('verifiedAt').value=new Date().toISOString();
  function render() {
    root.hidden=runtime.current.context.phase!=='POSTSEASON';
    const active=runtime.getPostseasonGameBinding(),b=active.binding;
    el('recheck').disabled=pending||!b||root.hidden;
    el('register').disabled=pending||!b||root.hidden;
    if (!manifest || !selected) {el('status').textContent=message||'公式日程を読み込み中';el('bind').disabled=true;return}
    const d=describeScheduleSlot(manifest,selected),g=d.game,same=(b?.game_id??b?.official_game_id)===d.game_id;
    el('matchup').textContent=d.matchup;
    const time=g.scheduled_at?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'}).format(new Date(g.scheduled_at)):'開始時刻未定';
    el('details').textContent='CS '+g.stage+' · 第'+g.game_number+'戦 · '+g.date+' '+time+' · '+(g.venue?.name||'上位球団の本拠地（未確定）')+(g.requires_special_format?' · 特例7試合制の場合のみ':'');
    const note=d.reasons.length?d.reasons.join(' / '):d.canComplete?'終了ルール確認済み':'終了ルール未確認（BOUND・ルール不足の境界で停止）';
    el('status').textContent=(message||note)+' ｜ binding: '+(same?active.status:'未接続')+' ｜ rules: '+g.game_rules.status;
    el('bind').textContent=same?'この試合をresume':'この試合を開始';el('bind').disabled=pending||!d.canBind||root.hidden;
    const completion=runtime.getPostseasonCompletion();
    el('prior').textContent=completion?.result?'突破確率：計算済み'+(purpose==='TEST'?'（TEST）':''):'突破確率：準備中 · '+probabilityStatus;
    const source=manifest.sources[g.schedule_source_ref];el('source').href=source.url;
    el('source').textContent=(manifest.purpose==='TEST'?'TEST fixture（技術検証用）':'確認元の公式日程')+' · 確認 '+source.verified_at.slice(0,10);
  }
  function install(input) {
    const next=validateScheduleManifest(input,{testAuthorized});
    if(next.purpose!==purpose)throw new Error('Schedule/runtime purpose mismatch');
    manifest=next;message='';storage.setItem(cacheKey,JSON.stringify(next));
    const games=next.games.filter(g=>g.stage==='FINAL');el('game').replaceChildren();
    for(const g of games){const option=document.createElement('option');option.value=g.schedule_slot_id;option.textContent='第'+g.game_number+'戦 · '+g.date+(g.requires_special_format?'（条件付き）':'');el('game').appendChild(option)}
    const saved=runtime.current.savedPostseasonBindingRecord?.active;
    selected=games.some(g=>g.schedule_slot_id===selected)?selected:games.find(g=>g.schedule_slot_id===saved?.source?.schedule_slot_id)?.schedule_slot_id||games[0]?.schedule_slot_id||null;
    el('game').value=selected||'';render();return manifest;
  }
  async function load() {
    const request=++loadEpoch;
    try{
      const response=await fetch(SCHEDULE_URL,{cache:'no-store'});if(!response.ok)throw new Error('Official schedule unavailable');
      const input=await response.json();if(request===loadEpoch)install(input);
    }catch(error){if(request===loadEpoch){
      const cached=storage.getItem(cacheKey);
      try{if(!cached)throw error;install(JSON.parse(cached));message='最後に検証済みの日程を使用中';render()}
      catch{message='公式日程を読み込めません：'+error.message;render()}
    }}
    if(purpose==='PRODUCTION'&&runtime.current.context.phase==='POSTSEASON'){
      try{await runtime.loadProductionPostseasonPrior();probabilityStatus=runtime.getPostseasonProbabilityOptions().prior?(manifest?.games.some(g=>g.game_rules.max_innings>g.game_rules.regulation_innings&&g.game_rules.extra_inning_base_policy!=='EMPTY')?'延長開始時の走者条件の確認待ち（戦績登録は利用可能）':'公式試合接続待ち（終了・延長条件を接続時に確認）'):'Regular最終公式prior未準備'}
      catch(error){probabilityStatus='final prior接続待ち：'+error.message}
      render();
    }
  }
  function probabilityInput(owner,options){
    if(!options.prior)return null;
    return async series=>{
      const games=series.decision.finished?[]:owner.games.filter(g=>g.stage===series.context.stage&&g.game_number>series.state.physicalGamesPlayed&&g.game_number<=series.rules.maxPhysicalGames);
      const bindings=[];
      for(const g of games)bindings.push((await prepareManifestBinding({manifest:owner,slotId:g.schedule_slot_id,series,testAuthorized,probabilityOnly:true})).binding);
      const result=await createPregameProbabilityInput({prior:options.prior,priorAPI:options.priorAPI,series,bindings,testAuthorized,created_at:new Date().toISOString()});
      probabilityStatus=result.reason||'計算済み';return result.input;
    };
  }
  async function bind() {
    if(pending||!manifest||runtime.current.context.phase!=='POSTSEASON')return false;
    const owner=manifest,slot=selected,token=runtime.capture(),d=describeScheduleSlot(owner,slot);
    if(!d.canBind){message=d.reasons.join(' / ');render();return false}
    pending=true;message='接続中';render();
    try{
      const options=runtime.getPostseasonProbabilityOptions(),repository=new PostseasonSeriesRepository({phaseContext:token.context,storage,purpose:owner.purpose});
      const saved=await repository.load(d.series.context.series_id,options);
      const args=await prepareManifestBinding({manifest:owner,slotId:slot,series:saved?.series||null,testAuthorized});
      if(manifest!==owner||selected!==slot||!runtime.isCurrent(token))return false;
      const success=await runtime.bindPostseasonGame({...args,startGame:true,snapshotOptions:options,snapshotInput:probabilityInput(owner,options)});
      if(success){message='接続済み：'+runtime.getPostseasonGameBinding().status;try{await runtime.savePostseasonProbability()}catch(error){message+=' · 確率の保存は再試行が必要：'+error.message}}
      return success;
    }catch(error){message='接続できません：'+error.message;return false}
    finally{pending=false;render()}
  }
  async function recheck(){
    if(pending||!runtime.getPostseasonGameBinding().binding)return false;
    const b=runtime.getPostseasonGameBinding().binding,slot=b.source.schedule_slot_id;
    await load();if(!manifest||runtime.current.context.phase!=='POSTSEASON')return false;
    selected=slot;el('game').value=slot;
    if(!await bind())return false;
    const success=runtime.recheckPostseasonRules();message=success?'ルール再確認完了':'ルール不足：入力停止を維持';render();return success;
  }
  async function registerOfficialResult(){
    const b=runtime.getPostseasonGameBinding().binding;if(pending||!b)return false;
    const score=name=>{const value=el(name).value;if(!/^\d+$/.test(value))throw new Error('最終得点は整数で入力してください');return Number(value)};
    try{
      const homeScore=score('homeScore'),awayScore=score('awayScore'),source_revision=score('resultRevision');
      if(!confirm('NPB公式でこの試合の終了と最終スコアを確認しましたか？\n'+SCHEDULE_TEAM_NAMES[b.homeTeamId]+' '+homeScore+' − '+awayScore+' '+SCHEDULE_TEAM_NAMES[b.awayTeamId]))return false;
      pending=true;
      const outcome=await runtime.recordVerifiedOfficialResult({source:'VERIFIED_OFFICIAL_RESULT',status:'FINAL',confirmed:true,purpose:b.purpose,origin:b.purpose==='TEST'?'TEST_FIXTURE':'NPB_OFFICIAL',
        season:b.season,phase:b.phase,competition:b.competition,stage:b.stage,series_id:b.series_id,game_id:b.game_id??b.official_game_id,homeTeamId:b.homeTeamId,awayTeamId:b.awayTeamId,
        homeScore,awayScore,result:homeScore===awayScore?'TIE':homeScore>awayScore?'HOME_WIN':'AWAY_WIN',source_url:el('resultURL').value,source_revision,verified_at:el('verifiedAt').value});
      message='公式結果をSeriesへ登録しました';return outcome.registered;
    }catch(error){message='登録できません：'+error.message;return false}
    finally{pending=false;render()}
  }
  el('game').addEventListener('change',()=>{selected=el('game').value;message='';render()});
  el('bind').addEventListener('click',()=>{void bind()});el('recheck').addEventListener('click',()=>{void recheck()});el('register').addEventListener('click',()=>{void registerOfficialResult()});render();
  return Object.freeze({load,render,bind,recheck,registerOfficialResult,inspect:()=>({manifest,selected,pending,message,probabilityStatus}),
    installTestManifest(input){if(!testAuthorized||input.purpose!=='TEST')throw new Error('Boot-authorized TEST manifest required');loadEpoch++;return install(input)}});
}
