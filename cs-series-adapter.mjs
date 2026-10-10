// Ordered actual-result replay. Stage 1 rules and Stage 3 core stay unchanged.
import {createCSSeriesState, decideCSSeries, recordCSPhysicalResult, closeCSSchedule} from './postseason-rules.mjs';
import {validateCSSeriesRules} from './cs-series-state.mjs';
import {canonicalSeriesJSON, copySeriesJSON, freezeSeriesJSON, seriesId, seriesRevision, seriesTimestamp, seriesPurpose} from './cs-series-json.mjs';
import {validateOfficialFinalResult} from './postseason-official-result.mjs';

export function createSeriesContext(input) {
  const c = copySeriesJSON(input);
  if (c.season !== 2026 || c.competition !== 'CS' || !['FIRST', 'FINAL'].includes(c.stage) || c.phase !== undefined && c.phase !== 'POSTSEASON') throw new Error('Supported explicit Postseason CS context required');
  const higher = c.higherTeamId === 'UNKNOWN' ? null : c.higherTeamId ?? null;
  const lower = c.lowerTeamId === 'UNKNOWN' ? null : c.lowerTeamId ?? null;
  for (const team of [higher, lower]) if (team !== null) seriesId(team, 'team ID');
  if (higher !== null && higher === lower) throw new Error('Distinct series teams required');
  const status = c.status ?? (higher && lower && c.ruleset_id ? 'CONFIRMED' : 'UNCONFIRMED');
  if (!['CONFIRMED', 'UNCONFIRMED'].includes(status) || status === 'CONFIRMED' && (!higher || !lower || !c.ruleset_id)) throw new Error('Confirmed series opponents and ruleset required');
  return freezeSeriesJSON({schema_version: 1, season: c.season, phase: 'POSTSEASON', competition: c.competition, stage: c.stage,
    series_id: seriesId(c.series_id, 'series ID'), higherTeamId: higher, lowerTeamId: lower,
    ruleset_id: c.ruleset_id == null ? null : seriesId(c.ruleset_id, 'ruleset ID'), status});
}

export function mapSeriesGameResult(context, game) {
  const c = createSeriesContext(context);
  if (c.status !== 'CONFIRMED') throw new Error('Series opponent is unconfirmed');
  const home = seriesId(game.homeTeamId, 'home team ID'), away = seriesId(game.awayTeamId, 'away team ID');
  if (home === away || ![home, away].includes(c.higherTeamId) || ![home, away].includes(c.lowerTeamId)) throw new Error('Game teams do not match SeriesContext');
  const higherSide = home === c.higherTeamId ? 'HOME' : 'AWAY';
  if (!['HOME_WIN', 'AWAY_WIN', 'TIE', 'CANCELED', 'POSTPONED'].includes(game.result)) throw new Error('Actual game result required; virtual advantage is not history');
  const physical = !['CANCELED', 'POSTPONED'].includes(game.result);
  const outcome = !physical ? null : game.result === 'TIE' ? 'TIE' :
    (game.result === higherSide + '_WIN' ? 'HIGHER_WIN' : 'LOWER_WIN');
  return Object.freeze({higherSide, physical_game: physical, seriesOutcome: outcome});
}

function normalizeGame(c, input, sequence, purpose) {
  const g = copySeriesJSON(input), mapping = mapSeriesGameResult(c, g);
  if (g.sequence !== sequence) throw new Error('History sequence must be contiguous and ordered');
  if (purpose === 'PRODUCTION' && mapping.higherSide !== 'HOME') throw new Error('Confirmed CS games require the higher seed at home');
  if (!g.source || !['OFFICIAL', 'MANUAL', 'TEST_FIXTURE'].includes(g.source.kind) || purpose === 'PRODUCTION' && g.source.kind === 'TEST_FIXTURE') throw new Error('Explicit compatible game result source required');
  for (const name of ['higherSide', 'physical_game', 'seriesOutcome']) if (g[name] !== undefined && g[name] !== mapping[name]) throw new Error('Inconsistent physical result mapping');
  let evidence={};
  if(g.source.method!==undefined){
    if(g.source.method!=='VERIFIED_OFFICIAL_RESULT')throw new Error('Unsupported official result method');
    const result=validateOfficialFinalResult(g.source.official_result,{purpose,testAuthorized:purpose==='TEST'});
    for(const k of ['game_id','homeTeamId','awayTeamId','result'])if(result[k]!==g[k])throw new Error('Official history evidence mismatch');
    for(const k of ['season','phase','competition','stage','series_id'])if(result[k]!==c[k])throw new Error('Official history context mismatch');
    evidence={method:g.source.method,official_result:result};
  }
  return freezeSeriesJSON({game_id: seriesId(g.game_id, 'game ID'), sequence, homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId,
    result: g.result, ...mapping, rescheduled_from_game_id: g.rescheduled_from_game_id == null ? null : seriesId(g.rescheduled_from_game_id, 'rescheduled game ID'),
    source: {kind: g.source.kind, source_id: seriesId(g.source.source_id, 'result source ID'), recorded_at: seriesTimestamp(g.source.recorded_at),...evidence}});
}

const OPEN_SCHEDULE = Object.freeze({closed: false, reason: null, decision_id: null, decided_at: null});
function normalizeClosure(input = OPEN_SCHEDULE) {
  const c = copySeriesJSON(input);
  if (typeof c.closed !== 'boolean') throw new Error('Explicit schedule closure required');
  if (!c.closed) {
    if (['reason', 'decision_id', 'decided_at'].some(k => c[k] != null)) throw new Error('Open schedule cannot carry a closure decision');
    return OPEN_SCHEDULE;
  }
  if (!['OFFICIAL_SCHEDULE_ENDED', 'OFFICIAL_NO_MORE_GAMES'].includes(c.reason)) throw new Error('Official schedule closure reason required; cancellation is not closure');
  return Object.freeze({closed: true, reason: c.reason, decision_id: seriesId(c.decision_id, 'official closure decision ID'), decided_at: seriesTimestamp(c.decided_at)});
}

export function createSeriesRecord({context, rules = null, history = [], closure, series_revision = history.length, purpose = 'PRODUCTION'}) {
  const c = createSeriesContext(context), mode = seriesPurpose(purpose), closing = normalizeClosure(closure);
  seriesRevision(series_revision);
  if (!Array.isArray(history) || history.length > 100 || series_revision < history.length) throw new Error('Bounded history and compatible revision required');
  if (c.status === 'UNCONFIRMED') {
    if (rules !== null || history.length || closing.closed) throw new Error('Unconfirmed series cannot have rules/results/closure');
    return freezeSeriesJSON({schema_version: 1, purpose: mode, context: c, rules: null, series_revision, history: [], closure: closing, state: null, decision: null});
  }
  const r = validateCSSeriesRules(rules);
  if (c.season !== r.season || c.competition !== r.competition || c.stage !== r.stage || c.ruleset_id !== r.ruleset_id) throw new Error('Series context/ruleset mismatch');
  let state = createCSSeriesState(r), decision = decideCSSeries(r, state);
  const ids = new Map(), games = [];
  for (const input of history) {
    const game = normalizeGame(c, input, games.length + 1, mode);
    if (ids.has(game.game_id)) throw new Error('Duplicate game ID; use explicit correction');
    if (game.rescheduled_from_game_id !== null) {
      const previous = ids.get(game.rescheduled_from_game_id);
      if (!previous || previous.physical_game || games.some(g => g.rescheduled_from_game_id === previous.game_id)) throw new Error('Invalid or duplicate reschedule reference');
    }
    decision = decideCSSeries(r, state);
    if (game.physical_game) {
      if (decision.finished) throw new Error('Physical result after series termination');
      state = recordCSPhysicalResult(r, state, game.seriesOutcome);
    }
    decision = decideCSSeries(r, state);
    ids.set(game.game_id, game); games.push(game);
  }
  if (closing.closed) state = closeCSSchedule(r, state);
  decision = decideCSSeries(r, state);
  return freezeSeriesJSON({schema_version: 1, purpose: mode, context: c, rules: r, series_revision, history: games, closure: closing, state, decision});
}

// Raw saved aggregate state never overrides replay; every saved field must agree.
export function validateSeriesRecord(input) {
  const raw = copySeriesJSON(input), rebuilt = createSeriesRecord(raw);
  if (canonicalSeriesJSON(raw) !== canonicalSeriesJSON(rebuilt)) throw new Error('Corrupt or noncanonical series record; replay mismatch');
  return rebuilt;
}
export const seriesRecordKey = input => canonicalSeriesJSON(validateSeriesRecord(input));
export function appendSeriesGame(input, game) {
  const r = validateSeriesRecord(input);
  if (r.closure.closed) throw new Error('Schedule is officially closed');
  return createSeriesRecord({...r, history: [...r.history, game], series_revision: nextRevision(r)});
}
export function replaceSeriesGame(input, game_id, correction) {
  const r = validateSeriesRecord(input), index = r.history.findIndex(g => g.game_id === game_id);
  if (index < 0 || correction.game_id !== game_id || correction.sequence !== index + 1) throw new Error('Explicit same-game correction required');
  const history = [...r.history]; history[index] = correction;
  return createSeriesRecord({...r, history, series_revision: nextRevision(r)});
}
export function closeSeriesSchedule(input, decision) {
  const r = validateSeriesRecord(input), closure = normalizeClosure({...decision, closed: true});
  if (r.closure.closed) {
    if (canonicalSeriesJSON(r.closure) !== canonicalSeriesJSON(closure)) throw new Error('Conflicting official closure decision');
    return r;
  }
  return createSeriesRecord({...r, closure, series_revision: nextRevision(r)});
}
function nextRevision(r) { return seriesRevision(r.series_revision + 1); }
