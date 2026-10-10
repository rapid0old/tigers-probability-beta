// Fixed future-game probabilities. This is a source boundary, not a pregame model.
import {validateCSGameProbability} from './cs-series-simulator.mjs';
import {validateSeriesRecord, seriesRecordKey} from './cs-series-adapter.mjs';
import {canonicalSeriesJSON, copySeriesJSON, freezeSeriesJSON, hashSeriesJSON, seriesId, seriesTimestamp, seriesPurpose} from './cs-series-json.mjs';

const verifiedSnapshots = new WeakSet();
export async function createProbabilitySnapshot(input, {prior = null, priorAPI = null, purpose = 'PRODUCTION'} = {}) {
  // Pin all values synchronously, before any asynchronous prior/hash validation.
  const raw = copySeriesJSON(input), pinnedPrior = prior === null ? null : copySeriesJSON(prior);
  const series = validateSeriesRecord(raw.series), mode = seriesPurpose(purpose);
  if (series.context.status !== 'CONFIRMED' || series.purpose !== mode) throw new Error('Confirmed matching-purpose series required');
  if (!Array.isArray(raw.games)) throw new Error('A fixed probability array is required; callbacks are not accepted');
  const expected = series.decision.finished ? 0 : series.rules.maxPhysicalGames - series.state.physicalGamesPlayed;
  if (raw.games.length !== expected) throw new Error('Snapshot must cover every remaining physical slot; missing probabilities do not shorten the schedule');
  const games = raw.games.map((g, i) => {
    if (g.physical_game_number !== series.state.physicalGamesPlayed + i + 1) throw new Error('Future physical-game order mismatch');
    validateCSGameProbability(g);
    // Preserve accepted rounding exactly; Stage 3 performs its existing normalization.
    return Object.freeze({physical_game_number: g.physical_game_number, upperWin: g.upperWin, lowerWin: g.lowerWin, tie: g.tie});
  });
  let source_kind = 'TEST_FIXTURE', prior_id = null, dataset_id = seriesId(raw.dataset_id, 'dataset ID'), source_model_version = null;
  if (pinnedPrior !== null) {
    if (!priorAPI || typeof priorAPI.validatePrior !== 'function' || typeof priorAPI.assertConnection !== 'function') throw new Error('Explicit Stage 2 prior validator required');
    const checked = await priorAPI.validatePrior(pinnedPrior);
    priorAPI.assertConnection(checked, {season: series.context.season, phase: 'POSTSEASON'}, mode);
    if (checked.source_kind !== pinnedPrior.source_kind || checked.prior_id !== pinnedPrior.prior_id || dataset_id !== checked.source_dataset_id) throw new Error('Prior source/dataset mismatch');
    source_kind = checked.source_kind; prior_id = checked.prior_id; source_model_version = checked.source_model_version;
  } else if (mode === 'PRODUCTION') throw new Error('Production Series probabilities require a validated OFFICIAL_REGULAR_FINAL prior');
  const body = {schema_version: 1, purpose: mode, season: series.context.season, phase: 'POSTSEASON',
    probability_source_id: seriesId(raw.probability_source_id, 'probability source ID'), created_at: seriesTimestamp(raw.created_at),
    series_id: series.context.series_id, series_revision: series.series_revision, ruleset_id: series.context.ruleset_id,
    series_record_key: seriesRecordKey(series), model_id: seriesId(raw.model_id, 'pregame model ID'), prior_id, dataset_id, source_model_version, source_kind, games};
  const content_hash = await hashSeriesJSON(body);
  const snapshot = freezeSeriesJSON({...body, content_hash, probability_snapshot_id: 'cs-prob-' + content_hash});
  verifiedSnapshots.add(snapshot); return snapshot;
}

export function assertProbabilitySnapshot(snapshot, series, purpose = 'PRODUCTION') {
  const r = validateSeriesRecord(series), mode = seriesPurpose(purpose);
  if (!verifiedSnapshots.has(snapshot) || snapshot.purpose !== mode || r.purpose !== mode ||
      snapshot.series_id !== r.context.series_id || snapshot.series_revision !== r.series_revision ||
      snapshot.ruleset_id !== r.context.ruleset_id || snapshot.series_record_key !== seriesRecordKey(r) ||
      mode === 'PRODUCTION' && snapshot.source_kind !== 'OFFICIAL_REGULAR_FINAL') throw new Error('Unverified, stale or incompatible probability snapshot');
  return snapshot;
}

export async function restoreProbabilitySnapshot(input, series, {prior = null, priorAPI = null, purpose = 'PRODUCTION'} = {}) {
  const raw = copySeriesJSON(input);
  if (raw.prior_id !== (prior?.prior_id ?? null)) throw new Error('Explicit matching prior required for snapshot reload');
  const rebuilt = await createProbabilitySnapshot({series, games: raw.games, probability_source_id: raw.probability_source_id,
    model_id: raw.model_id, dataset_id: raw.dataset_id, created_at: raw.created_at}, {prior, priorAPI, purpose});
  if (canonicalSeriesJSON(raw) !== canonicalSeriesJSON(rebuilt)) throw new Error('Corrupt or relabeled ProbabilitySnapshot');
  return rebuilt;
}
