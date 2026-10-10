// Explicit Postseason-only persistence. No default browser storage or autosave.
import {validateSeriesRecord} from './cs-series-adapter.mjs';
import {restoreProbabilitySnapshot, assertProbabilitySnapshot} from './cs-probability-snapshot.mjs';
import {restoreSeriesResult} from './cs-series-coordinator.mjs';
import {canonicalSeriesJSON, copySeriesJSON, freezeSeriesJSON, hashSeriesJSON, seriesId, seriesPurpose, seriesRevision} from './cs-series-json.mjs';

export class PostseasonSeriesRepository {
  #storage; #context; #purpose;
  constructor({phaseContext, storage, purpose = 'PRODUCTION'}) {
    if (phaseContext?.season !== 2026 || phaseContext.phase !== 'POSTSEASON') throw new Error('Explicit Postseason storage context required');
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new Error('Explicit localStorage-compatible storage required');
    this.#storage = storage; this.#context = Object.freeze({season: phaseContext.season, phase: phaseContext.phase}); this.#purpose = seriesPurpose(purpose);
  }
  key(series_id) {
    return `tigersProbabilityBeta.${this.#context.season}.POSTSEASON.v1.series.${this.#purpose}.${encodeURIComponent(seriesId(series_id, 'series ID'))}.v1`;
  }
  async #validate(input, options) {
    const raw = copySeriesJSON(input);
    if (raw.schema_version !== 1 || raw.season !== this.#context.season || raw.phase !== 'POSTSEASON' || raw.purpose !== this.#purpose) throw new Error('Series store context/schema mismatch');
    const series = validateSeriesRecord(raw.series);
    if (series.context.season !== this.#context.season || series.purpose !== this.#purpose) throw new Error('Series storage owner mismatch');
    const snapshot = raw.snapshot === null ? null : await restoreProbabilitySnapshot(raw.snapshot, series, {...options, purpose: this.#purpose});
    if (raw.result !== null && snapshot === null) throw new Error('Stored Series result requires its ProbabilitySnapshot');
    const result = raw.result === null ? null : restoreSeriesResult(raw.result, {series, snapshot});
    const body = {schema_version: 1, season: this.#context.season, phase: 'POSTSEASON', purpose: this.#purpose, series, snapshot, result};
    const content_hash = await hashSeriesJSON(body), rebuilt = freezeSeriesJSON({...body, content_hash});
    if (canonicalSeriesJSON(raw) !== canonicalSeriesJSON(rebuilt)) throw new Error('Corrupt Series store integrity');
    return rebuilt;
  }
  async load(series_id, options = {}) {
    const key = this.key(series_id), raw = this.#storage.getItem(key);
    if (raw === null) return null;
    const value = await this.#validate(JSON.parse(raw), options);
    if (value.series.context.series_id !== series_id) throw new Error('Stored series ID does not match its key');
    if (this.#storage.getItem(key) !== raw) throw new Error('Series storage changed during reload');
    return value;
  }
  async save({series, snapshot = null, result = null}, options = {}) {
    // Pin JSON and compare the original stored bytes again after async validation.
    const record = validateSeriesRecord(series), key = this.key(record.context.series_id), before = this.#storage.getItem(key);
    const expected = options.expected_series_revision === undefined ? null : seriesRevision(options.expected_series_revision);
    const baseline = options.expected_series_record === undefined ? null : canonicalSeriesJSON(validateSeriesRecord(options.expected_series_record));
    // Only a new revision-zero Series can bootstrap an absent persistent record.
    if (before === null && expected !== null && expected !== 0) throw new Error('Stale persisted Series revision; record is missing');
    if (record.purpose !== this.#purpose) throw new Error('Series storage purpose mismatch');
    if (snapshot !== null) assertProbabilitySnapshot(snapshot, record, this.#purpose);
    const body = copySeriesJSON({schema_version: 1, season: this.#context.season, phase: 'POSTSEASON', purpose: this.#purpose, series: record, snapshot, result});
    const candidate = await this.#validate({...body, content_hash: await hashSeriesJSON(body)}, options);
    if (before !== null) {
      const previous = await this.#validate(JSON.parse(before), options);
      if (expected !== null && previous.series.series_revision !== expected) throw new Error('Stale persisted Series revision');
      if (baseline !== null && canonicalSeriesJSON(previous.series) !== baseline) throw new Error('Conflicting persisted Series baseline');
      if (previous.series.context.series_id !== record.context.series_id || previous.series.series_revision > record.series_revision ||
          previous.series.series_revision === record.series_revision && canonicalSeriesJSON(previous.series) !== canonicalSeriesJSON(record)) throw new Error('Stale or conflicting series save');
    }
    if (this.#storage.getItem(key) !== before) throw new Error('Series storage changed during save');
    options.beforeCommit?.();
    // The guard may itself consult external code. No await or callback follows this final comparison.
    if (this.#storage.getItem(key) !== before) throw new Error('Series storage changed before commit');
    this.#storage.setItem(key, canonicalSeriesJSON(candidate)); return candidate;
  }
}
