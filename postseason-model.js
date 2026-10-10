// Explicit Postseason data inputs; no DOM, ambient stats, storage or network reads.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TigersPostseason = api;
})(globalThis, function() {
  'use strict';
  const MODEL_VERSION = 'player-pipeline-v4.0.1';
  const SOURCE_KINDS = Object.freeze(['OFFICIAL_REGULAR_FINAL', 'NON_FINAL_REGULAR_SNAPSHOT', 'TEST_REGULAR_SNAPSHOT']);
  const BAT_FIELDS = ['pa','ab','h','s1','d2','t3','hr','bb','hbp','k','dp','sh','sf','sb','cs'];
  const PIT_FIELDS = ['bf','h','hr','bb','hbp','k','r','er','outs'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const compare = (a,b) => a<b?-1:a>b?1:0;
  function freeze(value) {
    if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
    return value;
  }
  function canonical(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    throw new Error('Only finite JSON values are supported');
  }
  async function hash(value) {
    const subtle = globalThis.crypto?.subtle || (typeof require === 'function' ? require('node:crypto').webcrypto.subtle : null);
    if (!subtle) throw new Error('SHA-256 is unavailable');
    const bytes = await subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
  }
  function string(value, label) { if (typeof value !== 'string' || !value.trim() || value.length > 300) throw new Error('Invalid '+label); return value; }
  function date(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || new Date(value+'T00:00:00Z').toISOString().slice(0,10) !== value) throw new Error('Invalid baseline date'); return value; }
  function timestamp(value) { string(value,'timestamp'); if (!Number.isFinite(Date.parse(value)) || !/Z$/.test(value)) throw new Error('An explicit UTC timestamp is required'); return value; }
  function phaseContext(context) { if (!Number.isInteger(context?.season) || context.phase !== 'POSTSEASON') throw new Error('Explicit Postseason context required'); return context; }
  function purpose(value) { if (!['PRODUCTION','TEST'].includes(value)) throw new Error('Explicit prediction purpose required'); }
  function playerId(value) { if (typeof value!=='string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/.test(value)) throw new Error('Stable player ID required; names are not IDs'); return value; }
  const playerKey = (team,id) => JSON.stringify([team,id]);
  function count(value) { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid aggregate count'); return value; }
  function normalizePlayers(players, type, teams) {
    if (!Array.isArray(players)) throw new Error('Explicit player aggregates required');
    const ids = new Set(), fields = type === 'bat' ? BAT_FIELDS : PIT_FIELDS;
    return players.map(source => {
      const id = playerId(source.player_id || source.id), team = string(source.team,'team');
      if (!teams.includes(team) || ids.has(playerKey(team,id))) throw new Error('Unknown team or duplicate player ID');
      ids.add(playerKey(team,id));
      const result = {id, team, name: string(source.name || id,'display name')};
      for (const field of fields) result[field] = count(source[field] ?? 0);
      for (const field of ['bats','throws','role']) if (source[field] !== undefined) result[field] = string(source[field],field);
      if (source.spd !== undefined) { if (!Number.isFinite(source.spd) || source.spd <= 0) throw new Error('Invalid speed'); result.spd = source.spd; }
      if (type === 'bat' && (result.h !== result.s1+result.d2+result.t3+result.hr || result.h > result.ab || result.ab > result.pa || result.s1+result.d2+result.t3+result.hr+result.bb+result.hbp+result.k > result.pa)) throw new Error('Inconsistent batting aggregates');
      if (type === 'pit' && (result.hr > result.h || result.h+result.bb+result.hbp+result.k > result.bf)) throw new Error('Inconsistent pitching aggregates');
      return result;
    }).sort((a,b) => compare(playerKey(a.team,a.id),playerKey(b.team,b.id)));
  }
  const sum = (rows,key) => rows.reduce((total,row) => total+(row[key] || 0),0);
  function ratesBat(rows) { const n=sum(rows,'pa')||1; return {n,...Object.fromEntries(['s1','d2','t3','hr','bb','hbp','k','dp'].map(k=>[k,sum(rows,k)/n]))}; }
  function ratesPit(rows) { const n=sum(rows,'bf')||1; return {n,...Object.fromEntries(['h','hr','bb','hbp','k','r'].map(k=>[k,sum(rows,k)/n]))}; }
  function buildModelData(dataset,teams) {
    const lb=ratesBat(dataset.bat),lp=ratesPit(dataset.pit),teamB={},teamP={},byBat={},byPit={};
    for (const team of teams) { teamB[team]=ratesBat(dataset.bat.filter(p=>p.team===team));teamP[team]=ratesPit(dataset.pit.filter(p=>p.team===team));byBat[team]=dataset.bat.filter(p=>p.team===team).sort((a,b)=>b.pa-a.pa);byPit[team]=dataset.pit.filter(p=>p.team===team).sort((a,b)=>b.bf-a.bf); }
    return {lb,lp,teamB,teamP,byBat,byPit};
  }
  function abilities(player,baseline,type) {
    const n=player[type==='bat'?'pa':'bf'],weight=type==='bat'?120:180;
    return Object.fromEntries((type==='bat'?['s1','d2','t3','hr','bb','hbp','k','dp']:['h','hr','bb','hbp','k']).map(k=>[k,((player[k]||0)+baseline[k]*weight)/(n+weight)]));
  }
  function normalizeEnvironment(dataset) {
    if (!dataset.parks?.factors || !dataset.platoon?.factors) throw new Error('Explicit park and platoon baselines required');
    const parks = {leagueRunsPerGame:dataset.parks.leagueRunsPerGame || 0, factors:{}};
    for (const [id,p] of Object.entries(dataset.parks.factors)) {
      if (!Number.isFinite(p.factor) || p.factor <= 0) throw new Error('Invalid park factor');
      parks.factors[id] = {id,name:String(p.name || id),games:count(p.games ?? 0),runsPerGame:p.runsPerGame || 0,factor:p.factor};
    }
    const platoon={factors:{}};
    for (const [key,value] of Object.entries(dataset.platoon.factors)) { if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid platoon factor');platoon.factors[key]=value; }
    return {parks,platoon};
  }
  function checkFinalization(kind,source) {
    if (kind !== 'OFFICIAL_REGULAR_FINAL') return;
    const f=source.finalization;
    if (f?.status !== 'FINAL' || f.remaining_games !== 0 || f.pending_reschedules !== 0 || !f.confirmation_id || !f.confirmed_at || Date.parse(f.confirmed_at) < Date.parse(source.source_baseline_date+'T00:00:00Z') || !Number.isFinite(Date.parse(f.confirmed_at))) throw new Error('Explicit confirmed final official dataset required');
  }
  function sourceHeader(source) {
    if (!source || !SOURCE_KINDS.includes(source.source_kind) || !Number.isInteger(source.season) || source.phase !== 'REGULAR') throw new Error('Explicit classified Regular dataset required');
    if (source.source_kind !== 'TEST_REGULAR_SNAPSHOT' && (source.origin !== 'NPB_OFFICIAL' || !/^https:\/\/npb\.jp\//.test(source.source_url || ''))) throw new Error('Official NPB Regular source required');
    const result={season:source.season,source_kind:source.source_kind,source_phase:'REGULAR',source_dataset_id:string(source.dataset_id,'dataset ID'),source_baseline_date:date(source.baseline_date),source_model_version:string(source.model_version,'model version'),source_url:source.source_url || null,origin:source.origin || 'TEST_FIXTURE',finalization:null};
    if (result.source_model_version !== MODEL_VERSION) throw new Error('Unsupported model version');
    if (source.source_kind === 'OFFICIAL_REGULAR_FINAL') result.finalization=clone(source.finalization || null);
    checkFinalization(result.source_kind,result);
    return result;
  }
  function normalizeAliases(aliases,players) {
    const out={bat:[],pit:[]};
    for (const type of ['bat','pit']) {
      const targets=new Set(players[type].map(p=>playerKey(p.team,p.id))),seen=new Set();
      for (const alias of aliases?.[type] || []) {
        const row={team:string(alias.team,'team'),alias_id:playerId(alias.alias_id),player_id:playerId(alias.player_id)},key=playerKey(row.team,row.alias_id);
        if (!targets.has(playerKey(row.team,row.player_id)) || seen.has(key) || targets.has(key) && row.alias_id!==row.player_id) throw new Error('Invalid explicit ID alias');
        seen.add(key);out[type].push(row);
      }
      out[type].sort((a,b)=>compare(canonical(a),canonical(b)));
    }
    return out;
  }
  function makePayload(dataset,teams,aliases) {
    const players={bat:normalizePlayers(dataset.bat,'bat',teams),pit:normalizePlayers(dataset.pit,'pit',teams)};
    if (!players.bat.length || !players.pit.length) throw new Error('Both batting and pitching aggregates required');
    const model=buildModelData(players,teams);
    return {teams,league_baseline:{batting:model.lb,pitching:model.lp},team_batting:model.teamB,team_pitching:model.teamP,
      batter_ability:players.bat.map(p=>({player_id:p.id,team:p.team,aggregates:p,ability:abilities(p,model.lb,'bat')})),
      pitcher_ability:players.pit.map(p=>({player_id:p.id,team:p.team,aggregates:p,ability:abilities(p,model.lp,'pit')})),
      identity_aliases:normalizeAliases(aliases,players),environment:normalizeEnvironment(dataset),
      model_parameters:{batter_shrinkage_pa:120,pitcher_shrinkage_bf:180,observation_prior_pa:48}};
  }
  function hashBody(prior) { const {prior_id,content_hash,created_at,...body}=prior;return body; }
  async function buildPrior(source,{created_at}={}) {
    const header=sourceHeader(source),dataset=source.dataset;
    if (!dataset || dataset.snapshotDate !== header.source_baseline_date) throw new Error('Dataset date does not match the explicit source');
    if (dataset.phase && dataset.phase!=='REGULAR' || dataset.season && dataset.season!==header.season) throw new Error('Regular dataset season/phase mismatch');
    if (header.source_kind==='OFFICIAL_REGULAR_FINAL' && (dataset.phase!=='REGULAR' || dataset.is_final!==true || canonical(dataset.finalization)!==canonical(header.finalization))) throw new Error('The dataset itself must carry confirmed finality; a source label cannot promote a non-final snapshot');
    const teams=[...new Set(source.teams || [])].sort();if (!teams.length || teams.some(t=>typeof t!=='string'||!t.trim())) throw new Error('Explicit team IDs required');
    const body={schema_version:1,...header,payload:makePayload(dataset,teams,source.identity_aliases)};
    const content_hash=await hash(body);
    return freeze({...body,prior_id:'prior-'+content_hash,created_at:timestamp(created_at),content_hash});
  }
  function assertConnection(prior,context,predictionPurpose='PRODUCTION') {
    phaseContext(context);purpose(predictionPurpose);
    if (prior.season !== context.season || prior.source_phase !== 'REGULAR' || !SOURCE_KINDS.includes(prior.source_kind)) throw new Error('Prior/context mismatch');
    if (predictionPurpose === 'PRODUCTION' && prior.source_kind !== 'OFFICIAL_REGULAR_FINAL') throw new Error('TEST/NON_FINAL prior cannot connect to production');
    checkFinalization(prior.source_kind,prior);
  }
  async function validatePrior(prior) {
    prior=clone(prior); // Pin caller-owned JSON before the asynchronous integrity check.
    if (prior?.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(prior.content_hash || '') || prior.prior_id !== 'prior-'+prior.content_hash || prior.source_phase !== 'REGULAR') throw new Error('Invalid PriorSnapshot schema');
    timestamp(prior.created_at);
    const header=sourceHeader({season:prior.season,phase:'REGULAR',source_kind:prior.source_kind,dataset_id:prior.source_dataset_id,baseline_date:prior.source_baseline_date,model_version:prior.source_model_version,source_url:prior.source_url,origin:prior.origin,finalization:prior.finalization});
    const p=prior.payload;
    if (!Array.isArray(p?.teams) || new Set(p.teams).size !== p.teams.length) throw new Error('Invalid teams');
    const rebuilt=makePayload({bat:p.batter_ability.map(x=>x.aggregates),pit:p.pitcher_ability.map(x=>x.aggregates),...p.environment},p.teams,p.identity_aliases);
    if (canonical(rebuilt)!==canonical(p) || canonical(header)!==canonical(Object.fromEntries(Object.keys(header).map(k=>[k,prior[k]]))) || await hash(hashBody(prior)) !== prior.content_hash) throw new Error('Corrupt or unsupported PriorSnapshot');
    return freeze(clone(prior));
  }
  function identity(prior,team,id,type) {
    if (!['bat','pit'].includes(type)) throw new Error('Invalid player type');
    const list=prior.payload[type==='bat'?'batter_ability':'pitcher_ability'];
    const direct=list.find(p=>p.team===team&&p.player_id===id);
    if (direct) return direct.player_id;
    return prior.payload.identity_aliases[type].find(a=>a.team===team&&a.alias_id===id)?.player_id || null;
  }
  function normalizeOfficial(input,prior) {
    if (!input) return freeze({schema_version:1,season:prior.season,phase:'POSTSEASON',source_kind:'EMPTY',dataset_id:null,bat:[],pit:[],coverage:{complete:false,game_ids:[],event_ids:[]}});
    if (input.schema_version!==1 || input.season!==prior.season || input.phase!=='POSTSEASON' || !['OFFICIAL_POSTSEASON','TEST_POSTSEASON'].includes(input.source_kind)) throw new Error('Explicit Postseason official data required');
    if (input.source_kind==='OFFICIAL_POSTSEASON' && (input.origin!=='NPB_OFFICIAL' || !/^https:\/\/npb\.jp\//.test(input.source_url||''))) throw new Error('Official Postseason source required');
    const coverage=input.coverage || {};
    if (typeof coverage.complete !== 'boolean') throw new Error('Explicit official coverage completeness required');
    const bat=normalizePlayers(input.bat,'bat',prior.payload.teams),pit=normalizePlayers(input.pit,'pit',prior.payload.teams);
    for (const type of ['bat','pit']) for (const player of type==='bat'?bat:pit) player.id=identity(prior,player.team,player.id,type)||player.id;
    if ([bat,pit].some(rows=>new Set(rows.map(p=>playerKey(p.team,p.id))).size!==rows.length)) throw new Error('Duplicate canonical official player');
    return freeze({schema_version:1,season:input.season,phase:'POSTSEASON',source_kind:input.source_kind,dataset_id:string(input.dataset_id,'Postseason dataset ID'),
      ...(input.source_kind==='OFFICIAL_POSTSEASON'?{origin:input.origin,source_url:input.source_url}:{}),
      bat,pit,coverage:{complete:coverage.complete,game_ids:[...new Set((coverage.game_ids||[]).map(x=>string(x,'game ID')))].sort(),event_ids:[...new Set((coverage.event_ids||[]).map(x=>string(x,'event ID')))].sort()}});
  }
  function observationKey(season,team,id) { return `${season}|POSTSEASON|${team}|${id}`; }
  function observationOverlay(prior,official,learning) {
    if (learning?.phase && learning.phase!=='POSTSEASON' || learning?.season && learning.season!==prior.season) throw new Error('Regular/other-season learning cannot enter Postseason prediction');
    const raw=clone(learning || {version:1,phase:'POSTSEASON',season:prior.season,entries:[],steals:[]}),effective={...raw,entries:[],steals:[]},excluded=[];
    const seen=new Set(),events=new Set(),hasOfficial=official.bat.length>0 || official.pit.length>0;
    for (const type of ['entries','steals']) for (const row of raw[type] || []) {
      let reason=null;
      const isPost=(row.phase || raw.phase)==='POSTSEASON' && (row.season || raw.season)===prior.season;
      if (!isPost) reason='UNVERIFIED_PHASE';
      const batter=identity(prior,row.team,type==='steals'?row.runner_id:row.batter_id,'bat'),pitcher=type==='entries'?identity(prior,row.defTeam,row.pitcher_id,'pit'):null;
      if (!reason && (!batter || type==='entries' && !pitcher)) reason='UNKNOWN_PLAYER_ID';
      const id=String(row.id || ''),event=row.official_event_id;
      if (!reason && (!id || seen.has(type+':'+id) || event && events.has(type+':'+event))) reason='DUPLICATE_OBSERVATION';
      if (!reason && (event && official.coverage.event_ids.includes(event) || row.game_id && official.coverage.game_ids.includes(row.game_id))) reason='OFFICIAL_COVERED';
      if (!reason && hasOfficial && !(official.coverage.complete && row.game_id && !official.coverage.game_ids.includes(row.game_id))) reason='AMBIGUOUS_OFFICIAL_OVERLAP';
      if (!reason && type==='entries' && !['1B','2B','3B','HR','BB','K','OUT',null].includes(row.outcome)) reason='INVALID_OUTCOME';
      if (!reason && type==='steals' && (typeof row.success!=='boolean' || ![1,2,3].includes(row.fromBase))) reason='INVALID_STEAL';
      if (reason) { excluded.push({id,type,reason});continue; }
      seen.add(type+':'+id);if(event)events.add(type+':'+event);
      effective[type].push({...row,...(type==='steals'?{runner_id:batter,runnerKey:observationKey(prior.season,row.team,batter)}:{batter_id:batter,pitcher_id:pitcher,batterKey:observationKey(prior.season,row.team,batter),pitcherKey:observationKey(prior.season,row.defTeam,pitcher)})});
    }
    return {observed:freeze(raw),effectiveLearning:freeze(effective),excluded:freeze(excluded)};
  }
  function mergedPlayers(prior,official,type) {
    const fields=type==='bat'?BAT_FIELDS:PIT_FIELDS,rows=prior.payload[type==='bat'?'batter_ability':'pitcher_ability'].map(p=>clone(p.aggregates)),map=new Map(rows.map(p=>[playerKey(p.team,p.id),p]));
    for (const actual of official[type]) {
      let target=map.get(playerKey(actual.team,actual.id));
      if (!target) { target={id:actual.id,team:actual.team,name:actual.name,...Object.fromEntries(fields.map(k=>[k,0]))};rows.push(target);map.set(playerKey(actual.team,actual.id),target); }
      for (const field of fields) target[field]=(target[field]||0)+(actual[field]||0);
      for (const field of ['bats','throws','role','spd']) if (actual[field]!==undefined && target[field]===undefined) target[field]=actual[field];
    }
    return rows;
  }
  function displayStats(official) {
    return freeze({schema_version:1,season:official.season,phase:'POSTSEASON',source_dataset_id:official.dataset_id,
      bat:official.bat.map(p=>({...clone(p),avg:p.ab?p.h/p.ab:null})),pit:clone(official.pit)});
  }
  function withObservations(layer,learning) { return {...layer,...observationOverlay(layer.prior,layer.official,learning)}; }
  async function createDataLayer(context) {
    phaseContext(context.phaseContext);purpose(context.purpose || 'PRODUCTION');
    const prior=await validatePrior(context.prior);assertConnection(prior,context.phaseContext,context.purpose || 'PRODUCTION');
    const official=normalizeOfficial(context.officialPostseasonData,prior);
    if ((context.purpose || 'PRODUCTION')==='PRODUCTION' && official.source_kind==='TEST_POSTSEASON') throw new Error('Test official data cannot enter production');
    const dataset={season:prior.season,phase:'POSTSEASON',bat:mergedPlayers(prior,official,'bat'),pit:mergedPlayers(prior,official,'pit'),updated:prior.content_hash,snapshotDate:prior.source_baseline_date};
    const model=buildModelData(dataset,prior.payload.teams);
    // The league prior stays frozen; only Postseason official aggregates update player/team input.
    model.lb=clone(prior.payload.league_baseline.batting);model.lp=clone(prior.payload.league_baseline.pitching);
    const layer={prior,official,dataset,model,environment:prior.payload.environment,displayStats:displayStats(official),purpose:context.purpose || 'PRODUCTION'};
    return withObservations(layer,context.learning);
  }
  class TestPriorRepository {
    constructor({phaseContext:context,storage}) { phaseContext(context);this.season=context.season;this.storage=storage;this.key=`tigersProbabilityBeta.${context.season}.POSTSEASON.v1.priorStore.test.v1`; }
    readStore() { const raw=this.storage.getItem(this.key);if(raw===null)return {schema_version:1,priors:{}};const value=JSON.parse(raw);if(value.schema_version!==1||!value.priors||Array.isArray(value.priors)||typeof value.priors!=='object')throw new Error('Invalid test prior store');return value; }
    async save(prior) {
      const snapshot=await validatePrior(prior);if(snapshot.source_kind!=='TEST_REGULAR_SNAPSHOT'||snapshot.season!==this.season)throw new Error('Stage 2 persists TEST priors only');
      const store=this.readStore(),existing=store.priors[snapshot.content_hash];
      if(existing) { await validatePrior(existing);return existing.prior_id; }
      store.priors[snapshot.content_hash]=snapshot;this.storage.setItem(this.key,JSON.stringify(store));return snapshot.prior_id;
    }
    async get(id) { const prior=Object.values(this.readStore().priors).find(p=>p.prior_id===id);if(!prior)return null;const validated=await validatePrior(prior);if(validated.source_kind!=='TEST_REGULAR_SNAPSHOT'||validated.season!==this.season)throw new Error('Invalid stored test prior');return validated; }
  }
  return Object.freeze({MODEL_VERSION,SOURCE_KINDS,buildPrior,validatePrior,assertConnection,identity,observationKey,normalizeOfficial,observationOverlay,buildModelData,abilities,createDataLayer,withObservations,displayStats,TestPriorRepository,canonical});
});
