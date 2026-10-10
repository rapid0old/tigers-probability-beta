// Explicit verified-source boundary. No feed, identity generation or Regular rule defaults.
import {copySeriesJSON, freezeSeriesJSON, canonicalSeriesJSON, hashSeriesJSON, seriesId, seriesRevision, seriesTimestamp, seriesPurpose} from './cs-series-json.mjs';
import {validateSeriesRecord, mapSeriesGameResult} from './cs-series-adapter.mjs';

const issued = new WeakSet();
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const BINDING_STATUSES = Object.freeze(['UNBOUND', 'BOUND', 'RULE_PENDING', 'READY']);
// New schedule bindings own an internal key. Legacy explicit bindings retain their old key.
export const gameIdentity = binding => binding.game_id ?? binding.official_game_id;

// Rules carry their own origin. Binding provenance cannot authorize a TEST rules artifact.
// The legacy low-level completion contract may omit it; the live adapter supplies it explicitly.
export function validateGameEndRulesProvenance(rules, purpose, {required = true} = {}) {
  const origin = rules?.provenance;
  if (!origin) {
    if (required) throw new Error('Explicit Game End Rules provenance required');
    if (rules?.purpose !== undefined && rules.purpose !== purpose || purpose === 'PRODUCTION' &&
        (rules?.source?.kind === 'TEST_FIXTURE' || rules?.runtime_authorization === 'TEST_ONLY')) throw new Error('Game End Rules purpose/provenance mismatch');
    return;
  }
  if (origin.purpose !== purpose) throw new Error('Game End Rules purpose/provenance mismatch');
  const source = origin.source;
  if (!source || !['OFFICIAL','MANUAL','TEST_FIXTURE'].includes(source.kind)) throw new Error('Explicit Game End Rules source provenance required');
  seriesId(source.source_id, 'Game End Rules source ID');
  if (!['TEST_FIXTURE','OFFICIAL_POSTSEASON_SCHEDULE','EXPLICIT_COMPLETION_V1'].includes(source.contract) ||
      source.contract === 'TEST_FIXTURE' && (source.kind !== 'TEST_FIXTURE' || purpose !== 'TEST') ||
      source.contract === 'OFFICIAL_POSTSEASON_SCHEDULE' && (source.kind !== 'OFFICIAL' || purpose !== 'PRODUCTION') ||
      purpose === 'PRODUCTION' && source.kind === 'TEST_FIXTURE') throw new Error('Game End Rules source/purpose provenance mismatch');
  if (origin.runtime_authorization !== (purpose === 'TEST' ? 'TEST_ONLY' : 'PRODUCTION')) throw new Error('Game End Rules runtime authorization mismatch');
  for (const key of ['purpose','source','runtime_authorization']) {
    if (rules[key] !== undefined && canonicalSeriesJSON(rules[key]) !== canonicalSeriesJSON(origin[key])) throw new Error('Game End Rules provenance marker mismatch: '+key);
  }
}

function normalizeBinding(input) {
  const b = copySeriesJSON(input);
  if (b.schema_version !== 1 || b.season !== 2026 || b.phase !== 'POSTSEASON' || b.competition !== 'CS' || !['FIRST','FINAL'].includes(b.stage)) throw new Error('Explicit supported Postseason binding schema required');
  seriesPurpose(b.purpose);
  for (const key of ['series_id','homeTeamId','awayTeamId','series_ruleset_id']) seriesId(b[key], key);
  seriesId(gameIdentity(b), 'stable game ID');
  if (b.official_game_id !== null) seriesId(b.official_game_id, 'NPB official game ID');
  if (b.homeTeamId === b.awayTeamId) throw new Error('Distinct binding participants required');
  if (!Number.isSafeInteger(b.game_number) || b.game_number < 1) throw new Error('Explicit positive game number required');
  seriesRevision(b.source_revision);
  if (b.scheduled_at !== null) seriesTimestamp(b.scheduled_at);
  if (b.venue_id !== null) seriesId(b.venue_id, 'venue ID');
  if (!['SCHEDULED','POSTPONED','CANCELED'].includes(b.schedule_status)) throw new Error('Explicit schedule status required');
  const source = b.source;
  if (!source || !['TEST_FIXTURE','OFFICIAL','MANUAL'].includes(source.kind)) throw new Error('Explicit binding source required');
  seriesId(source.source_id, 'binding source ID');
  if (!['TEST_FIXTURE','OFFICIAL_POSTSEASON_SCHEDULE','EXPLICIT_COMPLETION_V1'].includes(source.contract) ||
      source.contract === 'TEST_FIXTURE' && (source.kind !== 'TEST_FIXTURE' || b.purpose !== 'TEST') ||
      source.contract === 'OFFICIAL_POSTSEASON_SCHEDULE' && (source.kind !== 'OFFICIAL' || b.purpose !== 'PRODUCTION') ||
      b.purpose === 'PRODUCTION' && source.kind === 'TEST_FIXTURE') throw new Error('Binding source/purpose mismatch');
  const rules = b.game_rules;
  if (!rules || !['UNKNOWN','RESOLVED'].includes(rules.status)) throw new Error('Explicit Game End Rules status required');
  validateGameEndRulesProvenance(rules, b.purpose);
  for (const key of ['season','phase','competition','stage','series_ruleset_id']) if (rules[key] !== b[key]) throw new Error('Game End Rules applicability mismatch: '+key);
  if (rules.status === 'RESOLVED') {
    seriesId(rules.ruleset_id, 'Game End Rules ID');
    if (rules.ruleset_id === b.series_ruleset_id || b.game_ruleset_id !== rules.ruleset_id) throw new Error('Separate Game End Rules identity required');
    if (!Number.isSafeInteger(rules.regulation_innings) || rules.regulation_innings < 1 || !Number.isSafeInteger(rules.max_innings) || rules.max_innings < rules.regulation_innings || rules.max_innings > 999 ||
        typeof rules.tie_at_limit !== 'boolean' || typeof rules.walkoff_allowed !== 'boolean') throw new Error('Explicit resolved Game End Rules required');
    if(Object.hasOwn(rules,'clinch_tie_called_game')&&(typeof rules.clinch_tie_called_game!=='boolean'||rules.clinch_tie_called_game&&(rules.max_innings!==12||rules.regulation_innings!==9||!rules.tie_at_limit)))throw new Error('Explicit compatible clinch-tie Game End Rules required');
    if (b.game_ruleset_fingerprint !== null && !fingerprint(b.game_ruleset_fingerprint)) throw new Error('Invalid Game End Rules fingerprint');
  } else {
    if (b.game_ruleset_id !== null || b.game_ruleset_fingerprint !== null || rules.ruleset_id !== null || rules.max_innings !== null || rules.tie_at_limit !== null || rules.walkoff_allowed !== null ||
        rules.regulation_innings !== null && (!Number.isSafeInteger(rules.regulation_innings) || rules.regulation_innings < 1 || rules.regulation_innings > 999)) throw new Error('UNKNOWN rules must not supply an inferred termination horizon');
  }
  const status = rules.status === 'RESOLVED' && b.schedule_status === 'SCHEDULED' ? 'READY' : 'BOUND';
  if (b.game_rules_status !== rules.status || b.binding_status !== status) throw new Error('Binding status does not match explicit rules/schedule');
  return freezeSeriesJSON({schema_version:1, purpose:b.purpose, season:b.season, phase:b.phase, competition:b.competition, stage:b.stage,
    series_id:b.series_id, ...(b.game_id ? {game_id:b.game_id} : {}), official_game_id:b.official_game_id, game_number:b.game_number, homeTeamId:b.homeTeamId, awayTeamId:b.awayTeamId,
    scheduled_at:b.scheduled_at, venue_id:b.venue_id, source:source, source_revision:b.source_revision, schedule_status:b.schedule_status,
    series_ruleset_id:b.series_ruleset_id, game_ruleset_id:b.game_ruleset_id, game_ruleset_fingerprint:b.game_ruleset_fingerprint,
    game_rules_status:b.game_rules_status, binding_status:status, game_rules:rules});
}
export function validateBindingSeriesContext(binding, series) {
  const r = validateSeriesRecord(series), c = r.context;
  for (const key of ['season','phase','competition','stage','series_id']) if (binding[key] !== c[key]) throw new Error('Binding SeriesContext mismatch: '+key);
  if (binding.purpose !== r.purpose || binding.series_ruleset_id !== c.ruleset_id) throw new Error('Binding purpose/Series ruleset mismatch');
  const mapping = mapSeriesGameResult(c, {...binding, result:'TIE'});
  // Preserve the confirmed production CS restriction in Stage 4A; TEST covers either side.
  if (r.purpose === 'PRODUCTION' && mapping.higherSide !== 'HOME') throw new Error('Production CS home mapping mismatch');
  return r;
}
export async function createPostseasonGameBinding({binding, series, testAuthorized = false}) {
  const b = normalizeBinding(binding); // Pins every caller field before the first await.
  validateBindingSeriesContext(b, series);
  if (b.purpose === 'TEST' && testAuthorized !== true) throw new Error('TEST binding requires boot-time test harness');
  const hash = b.game_rules_status === 'RESOLVED' ? await hashSeriesJSON(b.game_rules) : null;
  if (b.game_ruleset_fingerprint !== null && b.game_ruleset_fingerprint !== hash) throw new Error('Game End Rules fingerprint mismatch');
  const result = freezeSeriesJSON({...b, game_ruleset_fingerprint:hash});
  issued.add(result); return result;
}
export function validateReadyPostseasonBinding(binding, series) {
  if (!issued.has(binding) || binding.binding_status !== 'READY' || binding.schedule_status !== 'SCHEDULED') throw new Error('Verified active READY binding required');
  validateBindingSeriesContext(binding, series);
  return binding;
}
export function validateIssuedPostseasonBinding(binding, series) {
  if (!issued.has(binding) || binding.schedule_status !== 'SCHEDULED') throw new Error('Verified active scheduled binding required');
  validateBindingSeriesContext(binding, series); return binding;
}
export const bindingKey = binding => canonicalSeriesJSON(binding);
export function bindingIdentity(b) {
  return {season:b.season, phase:b.phase, competition:b.competition, stage:b.stage, series_id:b.series_id,
    ...(b.game_id ? {game_id:b.game_id} : {official_game_id:b.official_game_id}), homeTeamId:b.homeTeamId, awayTeamId:b.awayTeamId, series_ruleset_id:b.series_ruleset_id, purpose:b.purpose};
}
// Compatibility adapter: only the old caller's explicit stable ID is used. No DOM/date identity.
export function upgradeExplicitCompletionBinding(binding, series) {
  const b = copySeriesJSON(binding), r = validateSeriesRecord(series), rules = {...b.game_rules, walkoff_allowed:true};
  validateGameEndRulesProvenance(rules, r.purpose, {required:false});
  if (!rules.provenance) rules.provenance = {purpose:r.purpose, source:{...b.source, contract:'EXPLICIT_COMPLETION_V1'},
    runtime_authorization:r.purpose === 'TEST' ? 'TEST_ONLY' : 'PRODUCTION'};
  return {schema_version:1, purpose:r.purpose, season:b.season, phase:b.phase, competition:b.competition, stage:b.stage, series_id:b.series_id,
    official_game_id:b.game_id, game_number:r.state.physicalGamesPlayed+1, homeTeamId:b.homeTeamId, awayTeamId:b.awayTeamId,
    scheduled_at:null, venue_id:null, source:{...b.source, contract:'EXPLICIT_COMPLETION_V1'}, source_revision:0, schedule_status:'SCHEDULED',
    series_ruleset_id:rules.series_ruleset_id, game_ruleset_id:rules.ruleset_id, game_ruleset_fingerprint:null,
    game_rules_status:rules.status, binding_status:'READY', game_rules:rules};
}

export async function validateBindingRecord(input) {
  if (input === null) return null;
  const raw = copySeriesJSON(input), {content_hash, ...body} = raw;
  if (raw.schema_version !== 1 || !Array.isArray(raw.known_games) || !Array.isArray(raw.sources) || !fingerprint(content_hash) || await hashSeriesJSON(body) !== content_hash) throw new Error('Corrupt binding record');
  const active = normalizeBinding(raw.active);
  if (active.game_rules_status === 'RESOLVED' && await hashSeriesJSON(active.game_rules) !== active.game_ruleset_fingerprint) throw new Error('Saved Game End Rules fingerprint mismatch');
  const ids = new Set(), sources = new Set();
  for (const g of raw.known_games) {
    const id = gameIdentity(g); seriesId(id); seriesRevision(g.source_revision); seriesId(g.source_id);
    if (ids.has(id) || gameIdentity(g.identity) !== id || typeof g.canonical_binding !== 'string') throw new Error('Invalid binding identity ledger');
    const historical = normalizeBinding(JSON.parse(g.canonical_binding));
    if (bindingKey(historical)!==g.canonical_binding || canonicalSeriesJSON(bindingIdentity(historical))!==canonicalSeriesJSON(g.identity) || historical.source.source_id!==g.source_id || historical.source_revision!==g.source_revision) throw new Error('Corrupt historical binding');
    if (historical.game_rules_status==='RESOLVED' && await hashSeriesJSON(historical.game_rules)!==historical.game_ruleset_fingerprint) throw new Error('Historical rules fingerprint mismatch');
    ids.add(id);
  }
  for (const s of raw.sources) { seriesId(s.source_id); seriesRevision(s.source_revision); if (sources.has(s.source_id)) throw new Error('Invalid source revision ledger'); sources.add(s.source_id); }
  const known = raw.known_games.find(g=>gameIdentity(g)===gameIdentity(active)), source = raw.sources.find(s=>s.source_id===active.source.source_id);
  if (!known || canonicalSeriesJSON(known.identity)!==canonicalSeriesJSON(bindingIdentity(active)) || known.source_id!==active.source.source_id || known.source_revision!==active.source_revision || !source ||
      active.source.revision_order === 'MONOTONIC_INTEGER' && source.source_revision<active.source_revision) throw new Error('Saved binding ledger mismatch');
  return freezeSeriesJSON(raw);
}
export async function prepareBindingRecord(previous, candidate) {
  if (!issued.has(candidate)) throw new Error('Verified binding required');
  const old = await validateBindingRecord(previous);
  const known = old?.known_games.find(g=>gameIdentity(g)===gameIdentity(candidate));
  const source = old?.sources.find(s=>s.source_id===candidate.source.source_id);
  if (known && (canonicalSeriesJSON(known.identity)!==canonicalSeriesJSON(bindingIdentity(candidate)) || known.source_id!==candidate.source.source_id)) throw new Error('Same official game has conflicting identity/source; explicit correction required');
  // Numeric ordering belongs to an explicitly declared source contract, not to the revision field itself.
  if (candidate.source.revision_order === 'MONOTONIC_INTEGER' &&
      (source && candidate.source_revision < source.source_revision || known && candidate.source_revision < known.source_revision)) throw new Error('Stale binding source revision');
  if (old && bindingKey(old.active) === bindingKey(candidate)) return Object.freeze({record:old, noOp:true});
  if (known && candidate.source_revision === known.source_revision && known.canonical_binding!==bindingKey(candidate)) throw new Error('Changed binding requires a newer source revision');
  const games = (old?.known_games || []).filter(g=>gameIdentity(g)!==gameIdentity(candidate));
  games.push({...(candidate.game_id ? {game_id:candidate.game_id} : {official_game_id:candidate.official_game_id}), identity:bindingIdentity(candidate), source_id:candidate.source.source_id, source_revision:candidate.source_revision, canonical_binding:bindingKey(candidate)});
  const sources = (old?.sources || []).filter(s=>s.source_id!==candidate.source.source_id);
  sources.push({source_id:candidate.source.source_id, source_revision:candidate.source_revision});
  games.sort((a,b)=>gameIdentity(a).localeCompare(gameIdentity(b))); sources.sort((a,b)=>a.source_id.localeCompare(b.source_id));
  const body = {schema_version:1, active:candidate, known_games:games, sources};
  return Object.freeze({record:freezeSeriesJSON({...body, content_hash:await hashSeriesJSON(body)}), noOp:false});
}
