// Reviewed manifest data only. Never fetch NPB pages, infer participants or promote priors.
import {copySeriesJSON, freezeSeriesJSON, canonicalSeriesJSON, seriesId, seriesRevision} from './cs-series-json.mjs';
import {createSeriesRecord, validateSeriesRecord} from './cs-series-adapter.mjs';
import {createCSFirstRules, createCSFinalRules} from './postseason-rules.mjs';
import {createPostseasonGameBinding, validateGameEndRulesProvenance} from './postseason-game-binding.mjs';

export const SCHEDULE_URL = './data/postseason-2026-central.json';
export const SCHEDULE_TEAM_NAMES = Object.freeze({Tigers:'阪神',Giants:'巨人',BayStars:'DeNA',Carp:'広島',Swallows:'ヤクルト',Dragons:'中日'});
export function scheduleGameIdentity(manifest, game) {
  return seriesId(`ps/${manifest.season}/${manifest.competition}/${game.stage}/${manifest.series[game.stage].series_id}/${game.game_number}`,'internal game ID');
}
export function validateScheduleManifest(input, {testAuthorized = false} = {}) {
  const m = copySeriesJSON(input);
  if (m.schema_version !== 1 || m.season !== 2026 || m.phase !== 'POSTSEASON' || m.competition !== 'CS' || m.league !== 'CENTRAL' || !['PRODUCTION','TEST'].includes(m.purpose)) throw new Error('Explicit Central CS manifest required');
  if (m.purpose === 'TEST' && testAuthorized !== true) throw new Error('TEST schedule requires boot-time authorization');
  seriesId(m.manifest_id); seriesRevision(m.source_revision);
  const evidence = id => {
    const s = m.sources[id];
    if (!s || typeof s.source_revision !== 'string' || !s.source_revision || !Number.isFinite(Date.parse(s.verified_at))) throw new Error('Verified source record required: '+id);
    if (m.purpose === 'PRODUCTION' && (s.type !== 'NPB_OFFICIAL' && s.type !== 'CLUB_OFFICIAL' || !/^https:\/\/(?:npb\.jp|hanshintigers\.jp)\//.test(s.url || ''))) throw new Error('Production schedule requires an official source');
    if (m.purpose === 'TEST' && s.type !== 'TEST_FIXTURE') throw new Error('TEST source must remain labelled');
    return s;
  };
  for (const p of Object.values(m.participants)) {
    if (!['CONFIRMED','TBD'].includes(p.status) || p.status === 'TBD' && (p.team_id !== null || p.source_ref !== null)) throw new Error('TBD cannot carry an invented participant');
    if (p.status === 'CONFIRMED') { if (!SCHEDULE_TEAM_NAMES[p.team_id]) throw new Error('Supported explicit team identity required'); evidence(p.source_ref); }
  }
  for (const stage of ['FIRST','FINAL']) {
    const s = m.series[stage]; seriesId(s.series_id); evidence(s.source_ref);
    if (!m.participants[s.higher_slot] || !m.participants[s.lower_slot]) throw new Error('Explicit participant slots required');
    if (s.qualification !== null) {
      const q = s.qualification; evidence(q.source_ref);
      if (q.higherTeamId !== m.participants[s.higher_slot].team_id || q.lowerTeamId !== m.participants[s.lower_slot].team_id) throw new Error('Qualification participant mismatch');
      createCSFinalRules(q); // Existing 2026 format resolver, never a default advantage.
    }
  }
  const ids = new Set(), numbers = new Set();
  if (!Array.isArray(m.games) || !m.games.length) throw new Error('Schedule slots required');
  for (const g of m.games) {
    seriesId(g.schedule_slot_id); if (ids.has(g.schedule_slot_id)) throw new Error('Duplicate schedule slot'); ids.add(g.schedule_slot_id);
    if (!['FIRST','FINAL'].includes(g.stage) || !Number.isSafeInteger(g.game_number) || g.game_number < 1 || g.game_number > (g.stage === 'FIRST' ? 3 : 7)) throw new Error('Explicit stage/game number required');
    const n = g.stage+':'+g.game_number; if (numbers.has(n)) throw new Error('Duplicate game number'); numbers.add(n);
    const s = m.series[g.stage];
    if (g.home_slot !== s.higher_slot || g.away_slot !== s.lower_slot) throw new Error('2026 CS higher seed must be HOME');
    if (!/^2026-10-\d{2}$/.test(g.date) || !['SCHEDULED','POSTPONED','CANCELED'].includes(g.schedule_status)) throw new Error('Explicit schedule date/status required');
    evidence(g.schedule_source_ref);
    if (g.scheduled_at !== null) {
      evidence(g.time_source_ref);
      if (!Number.isFinite(Date.parse(g.scheduled_at)) || new Date(g.scheduled_at).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}) !== g.date) throw new Error('Game time/date mismatch');
    }
    if (g.venue !== null) { seriesId(g.venue.id); evidence(g.venue.source_ref); if (typeof g.venue.name !== 'string') throw new Error('Venue name required'); }
    // Official metadata is optional; neither date nor NPB ID participates in the internal key.
    if (g.official_game_id !== null) {
      seriesId(g.official_game_id); evidence(g.identity_source_ref);
      if (g.official_game_id === g.schedule_slot_id) throw new Error('Schedule slot cannot impersonate official identity');
    }
    if (g.official_game_id !== null || g.official_url !== null) {
      evidence(g.identity_source_ref);
      if (m.purpose === 'PRODUCTION' && !/^https:\/\/npb\.jp\//.test(g.official_url || '')) throw new Error('Explicit NPB game URL required');
    } else if (g.identity_source_ref !== null) throw new Error('Unverified official identity must remain null');
    const r = g.game_rules;
    if (!r || !['UNKNOWN','RESOLVED'].includes(r.status)) throw new Error('Game End Rules status required');
    validateGameEndRulesProvenance(r,m.purpose,{required:false});
    if (r.status === 'UNKNOWN') {
      if (['ruleset_id','max_innings','tie_at_limit','walkoff_allowed'].some(k=>r[k] !== null)) throw new Error('UNKNOWN rules cannot contain inferred conditions');
      if (r.regulation_innings !== null) {
        if (!Number.isSafeInteger(r.regulation_innings) || r.regulation_innings < 1 || r.regulation_innings > 999) throw new Error('Invalid verified regulation innings');
        evidence(r.source_ref);
      } else if (r.source_ref !== null) throw new Error('Unspecified rules must remain UNKNOWN');
    } else evidence(r.source_ref);
  }
  return freezeSeriesJSON(m);
}

export function manifestSeries(manifest, stage) {
  const s = manifest.series[stage], higher = manifest.participants[s.higher_slot].team_id, lower = manifest.participants[s.lower_slot].team_id;
  const rules = higher && lower ? stage === 'FIRST' ? createCSFirstRules() : s.qualification ? createCSFinalRules(s.qualification) : null : null;
  return createSeriesRecord({purpose:manifest.purpose, context:{season:2026,competition:'CS',stage,series_id:s.series_id,higherTeamId:higher,lowerTeamId:lower,ruleset_id:rules?.ruleset_id || null},rules});
}
export function describeScheduleSlot(manifest, slotId) {
  const g = manifest.games.find(g=>g.schedule_slot_id===slotId); if (!g) throw new Error('Unknown schedule slot');
  const series = manifestSeries(manifest,g.stage), reasons = [];
  if (!manifest.participants[g.home_slot].team_id || !manifest.participants[g.away_slot].team_id) reasons.push('対戦相手確定待ち');
  if (!series.rules) reasons.push('Series形式確定待ち');
  if (series.rules && g.game_number > series.rules.maxPhysicalGames) reasons.push('この形式では第7戦を開催しません');
  if (g.schedule_status !== 'SCHEDULED') reasons.push('開催日程の再確認が必要');
  const name = slot => SCHEDULE_TEAM_NAMES[manifest.participants[slot].team_id] || 'TBD（'+manifest.participants[slot].label+'）';
  return freezeSeriesJSON({game:g,game_id:scheduleGameIdentity(manifest,g),series,canBind:reasons.length===0,canComplete:reasons.length===0&&g.game_rules.status==='RESOLVED',reasons,
    matchup:name(g.home_slot)+'（HOME） vs '+name(g.away_slot)+'（AWAY）'});
}
export async function prepareManifestBinding({manifest,slotId,series=null,testAuthorized=false,probabilityOnly=false}) {
  const m = validateScheduleManifest(manifest,{testAuthorized}), d = describeScheduleSlot(m,slotId), g = d.game;
  if (!d.canBind) throw new Error(d.reasons.join(' / '));
  const record = series === null ? d.series : validateSeriesRecord(series);
  if (record.purpose !== m.purpose || canonicalSeriesJSON(record.context) !== canonicalSeriesJSON(d.series.context) || canonicalSeriesJSON(record.rules) !== canonicalSeriesJSON(d.series.rules)) throw new Error('Persisted Series does not match verified manifest');
  if (record.decision.finished || record.closure.closed) throw new Error('Series終了済み');
  if (record.history.some(x=>x.game_id===d.game_id)) throw new Error('この試合は登録済みです');
  if (probabilityOnly ? g.game_number<=record.state.physicalGamesPlayed : g.game_number !== record.state.physicalGamesPlayed+1) throw new Error('未登録の試合を順番に選択してください');
  const source = ref => ({kind:m.purpose==='TEST'?'TEST_FIXTURE':'OFFICIAL',contract:m.purpose==='TEST'?'TEST_FIXTURE':'OFFICIAL_POSTSEASON_SCHEDULE',source_id:m.manifest_id,verification:m.sources[ref]});
  const rules = {...g.game_rules,season:2026,phase:'POSTSEASON',competition:'CS',stage:g.stage,series_ruleset_id:record.context.ruleset_id,
    provenance:{purpose:m.purpose,source:source(g.game_rules.source_ref || g.schedule_source_ref),runtime_authorization:m.purpose==='TEST'?'TEST_ONLY':'PRODUCTION'}};
  const binding = await createPostseasonGameBinding({series:record,testAuthorized,binding:{schema_version:1,purpose:m.purpose,season:2026,phase:'POSTSEASON',competition:'CS',stage:g.stage,series_id:record.context.series_id,
    game_id:d.game_id,official_game_id:g.official_game_id,game_number:g.game_number,homeTeamId:record.context.higherTeamId,awayTeamId:record.context.lowerTeamId,scheduled_at:g.scheduled_at,venue_id:g.venue?.id || null,
    source:{...source(g.schedule_source_ref),schedule_slot_id:g.schedule_slot_id,source_fixture_id:g.source_fixture_id,official_url:g.official_url,identity_verification:g.identity_source_ref ? m.sources[g.identity_source_ref] : null},source_revision:m.source_revision,schedule_status:g.schedule_status,
    series_ruleset_id:record.context.ruleset_id,game_ruleset_id:rules.ruleset_id,game_ruleset_fingerprint:null,game_rules_status:rules.status,binding_status:rules.status==='RESOLVED'?'READY':'BOUND',game_rules:rules}});
  return Object.freeze({series:record,binding});
}
