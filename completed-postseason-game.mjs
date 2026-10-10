// Immutable completion boundary. No ambient stats, UI, or Regular defaults.
import {copySeriesJSON, freezeSeriesJSON, canonicalSeriesJSON, hashSeriesJSON, seriesId, seriesRevision, seriesTimestamp} from './cs-series-json.mjs';
import {validateSeriesRecord, mapSeriesGameResult, appendSeriesGame} from './cs-series-adapter.mjs';
import {SeriesCalculationCoordinator} from './cs-series-coordinator.mjs';
import {validateReadyPostseasonBinding, validateIssuedPostseasonBinding, gameIdentity, bindingKey, validateGameEndRulesProvenance} from './postseason-game-binding.mjs';
import {validateOfficialFinalResult} from './postseason-official-result.mjs';
import {resolvePostseasonGameEnd} from './postseason-game-end.mjs';
export {resolvePostseasonGameEnd} from './postseason-game-end.mjs';
export {seriesRecordKey} from './cs-series-adapter.mjs';
const verified = new WeakMap();
export function pinCompletionSnapshotOptions({prior = null, priorAPI = null} = {}) {
  return Object.freeze({prior:prior === null ? null : freezeSeriesJSON(copySeriesJSON(prior)),
    priorAPI:priorAPI === null ? null : Object.freeze({...priorAPI})});
}
export function validateCompletionBinding(input, series) {
  if (input.schema_version === 1 && Object.hasOwn(input, 'official_game_id')) {
    const official = validateReadyPostseasonBinding(input, series);
    return official;
  }
  const b = copySeriesJSON(input), r = validateSeriesRecord(series), c = r.context;
  for (const key of ['season','phase','competition','stage','series_id']) if (b[key] !== c[key]) throw new Error('Completion SeriesContext mismatch: ' + key);
  seriesId(b.game_id, 'game ID');
  const mapping = mapSeriesGameResult(c, {...b, result:'TIE'});
  if (r.purpose === 'PRODUCTION' && mapping.higherSide !== 'HOME') throw new Error('Production CS home mapping mismatch');
  const rules = b.game_rules;
  if (!rules || rules.status !== 'RESOLVED' || rules.season !== b.season || rules.phase !== b.phase || rules.competition !== b.competition || rules.stage !== b.stage || rules.series_ruleset_id !== c.ruleset_id) throw new Error('Resolved applicable game termination rules required');
  validateGameEndRulesProvenance(rules, r.purpose, {required:false});
  seriesId(rules.ruleset_id, 'game ruleset ID');
  if (!Number.isInteger(rules.regulation_innings) || rules.regulation_innings < 1 || !Number.isInteger(rules.max_innings) || rules.max_innings < rules.regulation_innings || typeof rules.tie_at_limit !== 'boolean') throw new Error('Explicit game termination horizon required');
  if (!b.source || !['OFFICIAL','MANUAL','TEST_FIXTURE'].includes(b.source.kind) || r.purpose === 'PRODUCTION' && b.source.kind === 'TEST_FIXTURE') throw new Error('Compatible completion source required');
  seriesId(b.source.source_id, 'source ID');
  return freezeSeriesJSON(b);
}
// Synchronous validation also serves the UI eligibility check; it does not issue an event.
export function validateCompletedPostseasonGame({binding, series, state, token, current, completed_at}) {
  if (token.context.phase !== 'POSTSEASON' || canonicalSeriesJSON(token) !== canonicalSeriesJSON(current)) throw new Error('Stale or non-Postseason completion capture');
  const original = validateCompletionBinding(binding, series);
  const modern = original.schema_version === 1 && Object.hasOwn(original,'official_game_id');
  const b = modern ? {...original, game_id:gameIdentity(original)} : original, s = copySeriesJSON(state), rules = b.game_rules;
  if (modern && (!token.postseasonBinding || bindingKey(token.postseasonBinding) !== bindingKey(original))) throw new Error('Stale active GameSession binding');
  if(token.context.season !== b.season) throw new Error('Game capture season mismatch');
  for (const key of ['competition','stage','series_id','game_id']) if (token.context[key] !== undefined && token.context[key] !== b[key]) throw new Error('GameSession identity mismatch: ' + key);
  seriesId(token.sessionId, 'GameSession ID');
  seriesRevision(token.revision); seriesRevision(token.epoch);
  if (!s.gameEnded || s.ruleStatus !== 'ACTIVE') throw new Error('Resolved completed game required; RULE_PENDING is not a result');
  const inning = Number(s.inning), homeScore = s.homeScore, awayScore = s.awayScore;
  if (!Number.isInteger(inning) || inning < rules.regulation_innings || inning > rules.max_innings || ![homeScore,awayScore].every(x => Number.isSafeInteger(x) && x >= 0 && x <= 999)) throw new Error('Valid final inning and scores required');
  const reason = s.gameEndReason;
  const during=reason==='walkoff'||reason==='clinch-tie-during-bottom';
  const resolved=resolvePostseasonGameEnd({binding:b,series,inning,half:s.half,homeScore,awayScore,outs:s.completionBoundary?.outs,
    boundary:during?'SCORE':'HALF_END',halfStart:s.postseasonHalfStart});
  if (resolved.status!=='END'||resolved.endReason!==reason || !s.completionBoundary || s.completionBoundary.reason !== reason || s.completionBoundary.inning !== inning || s.completionBoundary.half !== s.half || !Number.isInteger(s.completionBoundary.outs) || s.completionBoundary.outs < 0 || (during ? s.completionBoundary.outs >= 3 : s.completionBoundary.outs !== 3)) throw new Error('Final score/end reason does not resolve termination');
  const payload = freezeSeriesJSON({schema_version:1, purpose:validateSeriesRecord(series).purpose, season:b.season, phase:b.phase, competition:b.competition, stage:b.stage, series_id:b.series_id,
    game_id:b.game_id, game_revision:token.revision, game_ruleset_id:rules.ruleset_id, homeTeamId:b.homeTeamId, awayTeamId:b.awayTeamId,
    homeScore, awayScore, result:homeScore === awayScore ? 'TIE' : homeScore > awayScore ? 'HOME_WIN' : 'AWAY_WIN', endReason:reason,
    completed_at:seriesTimestamp(completed_at), source:b.source, capture:copySeriesJSON(token),
    ...(modern ? {official_game_id:b.official_game_id, binding_revision:b.source_revision, binding_identity:bindingKey(original)} : {})});
  return Object.freeze({payload, rules:b.game_rules});
}
export async function createCompletedPostseasonGame(input) {
  // Every field is pinned and checked before either digest yields to another task.
  const {payload,rules} = validateCompletedPostseasonGame(input);
  const body = {...payload, game_rules_fingerprint:await hashSeriesJSON(rules)};
  const event = freezeSeriesJSON({...body, event_id:'completed/' + await hashSeriesJSON(body)});
  verified.set(event, canonicalSeriesJSON(rules)); return event;
}
// Official final-result registration is independent of the live Game termination state/rules.
export async function createVerifiedOfficialResultEvent({binding,series,result,token,current,testAuthorized=false}) {
  const b=validateIssuedPostseasonBinding(binding,series), r=validateOfficialFinalResult(result,{purpose:b.purpose,testAuthorized});
  if (canonicalSeriesJSON(token)!==canonicalSeriesJSON(current) || token.context.phase!=='POSTSEASON' ||
      !token.postseasonBinding || bindingKey(token.postseasonBinding)!==bindingKey(b)) throw new Error('Stale official result capture');
  for(const k of ['season','phase','competition','stage','series_id','homeTeamId','awayTeamId']) if(r[k]!==b[k]) throw new Error('Official result binding mismatch: '+k);
  if(r.game_id!==gameIdentity(b))throw new Error('Official result game identity mismatch');
  const body=freezeSeriesJSON({schema_version:1,purpose:b.purpose,season:b.season,phase:b.phase,competition:b.competition,stage:b.stage,series_id:b.series_id,
    game_id:r.game_id,game_revision:token.revision,homeTeamId:r.homeTeamId,awayTeamId:r.awayTeamId,homeScore:r.homeScore,awayScore:r.awayScore,result:r.result,
    endReason:'verified-official-final',completed_at:r.verified_at,source:{kind:b.purpose==='TEST'?'TEST_FIXTURE':'OFFICIAL',source_id:'verified-final',method:'VERIFIED_OFFICIAL_RESULT',official_result:r},
    capture:copySeriesJSON(token),official_game_id:b.official_game_id,binding_revision:b.source_revision,binding_identity:bindingKey(b)});
  const event=freezeSeriesJSON({...body,event_id:'official-final/'+await hashSeriesJSON(body)});
  verified.set(event,'VERIFIED_OFFICIAL_RESULT');return event;
}
// Save first, publish second. A single in-flight command owns the revision.
export class PostseasonCompletionCoordinator {
  #series; #repository; #binding; #isCurrent; #busy = false; #calculation; #snapshotInput; #snapshotOptions; #notify;
  constructor({series, repository, binding, isCurrent, snapshotInput = null, snapshotOptions = {}, initialSnapshot=null, onChange = () => {}}) {
    this.#series = validateSeriesRecord(series); this.#binding = binding.schema_version===1 && Object.hasOwn(binding,'official_game_id') ? validateIssuedPostseasonBinding(binding,this.#series) : validateCompletionBinding(binding, this.#series);
    if (!repository || typeof isCurrent !== 'function') throw new Error('Explicit repository and current capture guard required');
    this.#repository = repository; this.#isCurrent = isCurrent; this.#snapshotInput = snapshotInput; this.#snapshotOptions = pinCompletionSnapshotOptions(snapshotOptions); this.#notify = onChange;
    this.#calculation = new SeriesCalculationCoordinator(this.#series);
    if(initialSnapshot){this.#calculation.setSnapshot(initialSnapshot);this.#calculation.accept(this.#calculation.calculate(this.#calculation.capture()))}
  }
  get series() { return this.#series; }
  get binding() { return this.#binding; }
  get snapshot() { return this.#calculation.snapshot; }
  get result() { return this.#calculation.result; }
  #publish() { try { this.#notify(this); } catch { /* Durable registration is independent of presentation. */ } }
  async recalculateProbability() {
    const series = this.#series;
    if (!this.#snapshotInput) return false;
    const input = await this.#snapshotInput(series);
    if (this.#series !== series) return false;
    if (!input) {this.#calculation.setSeries(series);return false;}
    const snapshot = await this.#calculation.prepareSnapshot(input, this.#snapshotOptions);
    if (!snapshot) return false;
    const capture = this.#calculation.capture();
    const accepted = this.#calculation.accept(this.#calculation.calculate(capture));
    if (accepted) this.#publish();
    return accepted;
  }
  async recordCompletedPostseasonGame({event, expected_series_revision}) {
    if (!verified.has(event)) throw new Error('Verified immutable completion event required');
    if (event.purpose !== this.#series.purpose) throw new Error('Completion purpose mismatch');
    if (expected_series_revision !== this.#series.series_revision) throw new Error('Stale expected Series revision');
    if (this.#busy) throw new Error('Completion command already in flight');
    const b = this.#binding;
    for (const k of ['season','phase','competition','stage','series_id','game_id','homeTeamId','awayTeamId']) if (event[k] !== (k==='game_id' ? gameIdentity(b) ?? b.game_id : b[k])) throw new Error('Completion identity mismatch: ' + k);
    if (b.schema_version===1 && Object.hasOwn(b,'official_game_id') && (event.binding_revision !== b.source_revision || event.binding_identity !== bindingKey(b))) throw new Error('Stale completion binding revision/identity');
    if (verified.get(event)!=='VERIFIED_OFFICIAL_RESULT' && (event.game_ruleset_id !== b.game_rules.ruleset_id || verified.get(event) !== canonicalSeriesJSON(b.game_rules))) throw new Error('Completion termination rules mismatch');
    if (!this.#isCurrent(event.capture)) throw new Error('Stale completion event');
    if (this.#series.history.some(g => g.game_id === event.game_id)) throw new Error('Duplicate game ID; explicit correction required');
    const candidate = appendSeriesGame(this.#series, {game_id:event.game_id, sequence:this.#series.history.length+1, homeTeamId:event.homeTeamId, awayTeamId:event.awayTeamId, result:event.result,
      source:{...event.source, source_id:event.event_id, recorded_at:event.completed_at}});
    const original = this.#series;
    const guard = () => { if (this.#series !== original || !this.#isCurrent(event.capture)) throw new Error('Stale completion before commit'); };
    this.#busy = true;
    try {
      await this.#repository.save({series:candidate, snapshot:null, result:null}, {...this.#snapshotOptions,
        expected_series_revision, expected_series_record:original, beforeCommit:guard});
      this.#series = candidate; this.#calculation.setSeries(candidate); // Old probability is invalid immediately on durable acceptance.
      this.#publish();
    } finally { this.#busy = false; }
    // Probability failure cannot turn a durable history registration into a failed registration.
    let probabilityError = null;
    try { await this.recalculateProbability(); } catch (e) { probabilityError = e.message; }
    return Object.freeze({registered:true, event_id:event.event_id, series_revision:candidate.series_revision, probabilityError});
  }
  async saveProbability({beforeCommit}={}) {
    if(!this.snapshot)return false;
    await this.#repository.save({series:this.#series,snapshot:this.snapshot,result:this.result},{...this.#snapshotOptions,
      expected_series_revision:this.#series.series_revision,expected_series_record:this.#series,beforeCommit});
    return true;
  }
}
