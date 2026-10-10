// Snapshot-only Stage 3 connection and revision/epoch result ownership.
import {simulateCSSeries} from './cs-series-simulator.mjs';
import {validateSeriesRecord, seriesRecordKey} from './cs-series-adapter.mjs';
import {assertProbabilitySnapshot, createProbabilitySnapshot} from './cs-probability-snapshot.mjs';
import {canonicalSeriesJSON, copySeriesJSON, freezeSeriesJSON, seriesId, seriesRevision, seriesTimestamp} from './cs-series-json.mjs';

const verifiedResults = new WeakSet(), captures = new WeakSet();
export function calculateSeriesProbability({series, snapshot, calculated_at = new Date().toISOString(), calculation_token = null}) {
  const r = validateSeriesRecord(series), p = assertProbabilitySnapshot(snapshot, r, r.purpose);
  let token = null;
  if (calculation_token !== null) token = {coordinator_id: seriesId(calculation_token.coordinator_id, 'coordinator ID'), epoch: seriesRevision(calculation_token.epoch)};
  const probabilities = Object.freeze(p.games.map(g => Object.freeze({upperWin: g.upperWin, lowerWin: g.lowerWin, tie: g.tie})));
  // No callback, DOM, live data or shortened horizon is passed to the audited core.
  const dp = simulateCSSeries({rules: r.rules, state: r.state, gameProbabilities: probabilities});
  const result = freezeSeriesJSON({schema_version: 1, purpose: r.purpose, series_id: r.context.series_id, series_revision: r.series_revision,
    ruleset_id: r.context.ruleset_id, higherTeamId: r.context.higherTeamId, lowerTeamId: r.context.lowerTeamId,
    series_record_key: seriesRecordKey(r), probability_source_id: p.probability_source_id, probability_snapshot_id: p.probability_snapshot_id,
    calculated_at: seriesTimestamp(calculated_at), calculation_token: token, ...dp});
  verifiedResults.add(result); return result;
}

export function isCurrentSeriesResult(result, {series, snapshot, calculation_token = null}) {
  try {
    assertProbabilitySnapshot(snapshot, series, series.purpose);
    return verifiedResults.has(result) && result.purpose === series.purpose && result.series_id === series.context.series_id &&
      result.series_revision === series.series_revision && result.ruleset_id === series.context.ruleset_id &&
      result.series_record_key === seriesRecordKey(series) && result.probability_source_id === snapshot.probability_source_id &&
      result.probability_snapshot_id === snapshot.probability_snapshot_id && canonicalSeriesJSON(result.calculation_token) === canonicalSeriesJSON(calculation_token);
  } catch { return false; }
}

export function restoreSeriesResult(input, {series, snapshot}) {
  const raw = copySeriesJSON(input), rebuilt = calculateSeriesProbability({series, snapshot, calculated_at: raw.calculated_at, calculation_token: raw.calculation_token});
  if (canonicalSeriesJSON(raw) !== canonicalSeriesJSON(rebuilt)) throw new Error('Corrupt or stale Series result; DP replay mismatch');
  return rebuilt;
}

export class SeriesCalculationCoordinator {
  #series; #snapshot = null; #epoch = 0; #result = null;
  #seenSeries = new Map();
  #id = 'cs-coordinator-' + globalThis.crypto.randomUUID();
  constructor(series) { this.setSeries(series); }
  get series() { return this.#series; }
  get snapshot() { return this.#snapshot; }
  get result() { return this.#result; }
  setSeries(series) {
    const next = validateSeriesRecord(series), key = seriesRecordKey(next), seen = this.#seenSeries.get(next.context.series_id);
    if (seen && (next.series_revision < seen.revision || next.series_revision === seen.revision && key !== seen.key)) throw new Error('Series revision must advance for changed state/context');
    this.#seenSeries.set(next.context.series_id, {revision: next.series_revision, key});
    this.#series = next; this.#snapshot = null; this.#result = null; this.#epoch++; return next;
  }
  setSnapshot(snapshot) {
    assertProbabilitySnapshot(snapshot, this.#series, this.#series.purpose);
    this.#snapshot = snapshot; this.#result = null; this.#epoch++;
  }
  async prepareSnapshot(input, options = {}) {
    const pinned = copySeriesJSON(input), series = this.#series, epoch = ++this.#epoch;
    this.#snapshot = null; this.#result = null;
    try {
      const snapshot = await createProbabilitySnapshot({...pinned, series}, {...options, purpose: series.purpose});
      if (epoch !== this.#epoch) return null;
      this.setSnapshot(snapshot); return snapshot;
    } catch (error) {
      if (epoch !== this.#epoch) return null; // Obsolete errors cannot reach the active series either.
      throw error;
    }
  }
  invalidate() { this.#epoch++; this.#result = null; }
  capture() {
    assertProbabilitySnapshot(this.#snapshot, this.#series, this.#series.purpose);
    this.#epoch++; this.#result = null;
    const capture = freezeSeriesJSON({series: this.#series, snapshot: this.#snapshot, calculation_token: {coordinator_id: this.#id, epoch: this.#epoch}});
    captures.add(capture); return capture;
  }
  calculate(capture, options = {}) {
    if (!captures.has(capture) || capture.calculation_token.coordinator_id !== this.#id) throw new Error('Owned immutable calculation capture required');
    return calculateSeriesProbability({...options, series: capture.series, snapshot: capture.snapshot, calculation_token: capture.calculation_token});
  }
  accept(result) {
    const current = isCurrentSeriesResult(result, {series: this.#series, snapshot: this.#snapshot, calculation_token: {coordinator_id: this.#id, epoch: this.#epoch}});
    if (current) this.#result = result;
    return current;
  }
}
