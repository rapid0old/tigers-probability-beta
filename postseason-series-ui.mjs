import {createSeriesRecord, validateSeriesRecord} from './cs-series-adapter.mjs';
import {SeriesCalculationCoordinator} from './cs-series-coordinator.mjs';
import {copySeriesJSON} from './cs-series-json.mjs';
import {presentSeries} from './postseason-series-presenter.mjs';

export function unconfirmedSeries(stage = 'FIRST', purpose = 'PRODUCTION') {
  return createSeriesRecord({purpose, context: {season: 2026, phase: 'POSTSEASON', competition: 'CS', stage,
    series_id: `cs-2026-central-${stage.toLowerCase()}`, higherTeamId: null, lowerTeamId: null, ruleset_id: null}});
}

// Explicit, read-only presentation adapter. No storage writes or ambient prior/stats.
export function createSeriesView({root, phaseContext, purpose = 'PRODUCTION'}) {
  if (!root || phaseContext?.season !== 2026 || phaseContext.phase !== 'POSTSEASON') throw new Error('Explicit Postseason view context required');
  if (!['PRODUCTION', 'TEST'].includes(purpose)) throw new Error('Explicit UI purpose required');
  const context = Object.freeze({season: phaseContext.season, phase: phaseContext.phase});
  let coordinator = new SeriesCalculationCoordinator(unconfirmedSeries('FIRST', purpose));
  let teamNames = {}, nextGame = null, active = true, epoch = 0, pending = false;
  const stageViews = new Map();
  const knownSeries = new Map();
  function rememberStage() {
    knownSeries.set(coordinator.series.context.series_id, coordinator.series);
    stageViews.set(coordinator.series.context.stage, {series: coordinator.series, snapshot: coordinator.snapshot, teamNames, nextGame});
  }
  root.innerHTML = `<div class="seriesViewHeading"><div><h2 data-series="title"></h2><p data-series="subtitle"></p></div><span class="seriesTestBadge" data-series="test" hidden>TEST</span></div>
    <label class="seriesStageLabel">ステージ<select data-series="stage" aria-label="CSステージ"><option value="FIRST">CS First Stage</option><option value="FINAL">CS Final Stage</option></select></label>
    <section class="card seriesCard" aria-label="シリーズ状況">
      <div class="seriesStatus" data-series="status" role="status" aria-live="polite"></div>
      <h3 class="seriesMatchup" data-series="matchup"></h3>
      <div class="seriesActualHeading">実戦績 <span data-series="ties"></span></div>
      <dl class="seriesActual"><div><dt><span class="seriesSeed">上位</span> <span data-series="higher"></span></dt><dd data-series="actualHigher"></dd></div><div><dt><span class="seriesSeed">下位</span> <span data-series="lower"></span></dt><dd data-series="actualLower"></dd></div></dl>
      <div class="seriesAdvantage"><span>アドバンテージ（仮想勝）</span><strong data-series="advantage"></strong><small data-series="effectiveHigher"></small></div>
      <p class="seriesWinner" data-series="winner" hidden></p>
      <section class="seriesProbability" aria-label="シリーズ突破確率" aria-live="polite"><h4 data-series="probabilityLabel"></h4><p data-series="probabilityNote"></p><div class="seriesProbabilityNumbers" data-series="numbers" hidden><div><span data-series="probHigherName"></span><strong data-series="probUpper"></strong></div><div><span data-series="probLowerName"></span><strong data-series="probLower"></strong></div></div><p data-series="expected" hidden></p></section>
      <section class="seriesNextGame" aria-label="次戦"><h4>次戦 <span data-series="nextHeading"></span></h4><p data-series="next"></p></section>
      <details class="seriesRules"><summary>シリーズ形式・実施数</summary><dl><div><dt>実施試合数</dt><dd data-series="played"></dd></div><div><dt>最大実試合数</dt><dd data-series="maximum"></dd></div><div><dt>必要勝数</dt><dd data-series="winsNeeded"></dd></div></dl><p>全試合上位球団ホーム。同勝数の場合は上位球団が突破します。アドバンテージは実戦績に含みません。</p></details>
    </section>`;
  const el = name => root.querySelector(`[data-series="${name}"]`);
  function render() {
    const model = presentSeries({series: coordinator.series, snapshot: coordinator.snapshot, result: coordinator.result,
      calculation_token: coordinator.result?.calculation_token ?? null, purpose, teamNames, nextGame, pending});
    for (const name of ['title', 'subtitle', 'matchup', 'higher', 'lower', 'actualHigher', 'actualLower', 'ties', 'advantage', 'effectiveHigher', 'played', 'maximum', 'winsNeeded', 'probabilityLabel', 'probabilityNote']) el(name).textContent = model[name];
    el('stage').value = model.stage; el('status').textContent = model.statusLabel; root.dataset.seriesStatus = model.status;
    el('test').hidden = !model.test;
    el('winner').hidden = !model.winner; el('winner').textContent = model.winner ? `${model.winner}がシリーズ突破` : '';
    el('numbers').hidden = !model.probability; el('expected').hidden = !model.probability;
    el('probHigherName').textContent = model.higher; el('probLowerName').textContent = model.lower;
    el('probUpper').textContent = model.probability?.upper || ''; el('probLower').textContent = model.probability?.lower || '';
    el('expected').textContent = model.probability ? `期待残り試合数：${model.probability.expectedRemaining}` : '';
    el('nextHeading').textContent = model.nextGame?.heading || '';
    el('next').textContent = model.nextGame ? `${model.nextGame.date} · ${model.nextGame.venue} · ${model.nextGame.status}\n${model.nextGame.matchup}` : model.status === 'COMPLETED' ? 'このシリーズの次戦はありません。' : '次戦情報は未登録です。';
    return model;
  }
  const api = Object.freeze({
    phaseContext: context, purpose,
    // Completion setup stages a separate owner. Nothing is exposed until synchronous commit.
    prepareCompletionUpdate({series, snapshot = null, teamNames: names = {}}) {
      const record = validateSeriesRecord(series), pinnedNames = copySeriesJSON(names);
      if (record.purpose !== purpose || record.context.season !== context.season) throw new Error('Series view owner mismatch');
      if (Object.values(pinnedNames).some(name => typeof name !== 'string')) throw new Error('Team display names must be strings');
      const owner = coordinator, request = epoch, staged = new SeriesCalculationCoordinator(owner.series);
      // Retain Stage 4A revision checks for every previously displayed Series identity.
      for (const previous of knownSeries.values()) staged.setSeries(previous);
      staged.setSeries(record);
      if (snapshot) {
        staged.setSnapshot(snapshot);
        if (active) staged.accept(staged.calculate(staged.capture()));
      }
      presentSeries({series:staged.series, snapshot:staged.snapshot, result:staged.result,
        calculation_token:staged.result?.calculation_token ?? null, purpose, teamNames:pinnedNames, nextGame:null, pending:false});
      return Object.freeze({commit({durable = false, beforePublish = null} = {}) {
        if (coordinator !== owner || epoch !== request) throw new Error('Stale Series view preparation');
        const previous = {teamNames, nextGame, pending};
        // A committed physical result must not leave old numbers visible if rendering fails.
        if (durable) { el('numbers').hidden = true; el('expected').hidden = true; }
        coordinator = staged; teamNames = pinnedNames; nextGame = null; pending = false; epoch++;
        try { const model = render(); beforePublish?.(); rememberStage(); return model; }
        catch (error) {
          if (durable) { rememberStage(); throw error; }
          coordinator = owner; teamNames = previous.teamNames; nextGame = previous.nextGame; pending = previous.pending; epoch = request;
          try { render(); } catch { /* Internal ownership is restored even if the DOM is unavailable. */ }
          throw error;
        }
      }});
    },
    setSeries(series, presentation = {}) {
      epoch++; coordinator.setSeries(coordinator.series); pending = false; render();
      const record = validateSeriesRecord(series);
      if (record.purpose !== purpose || record.context.season !== context.season) throw new Error('Series view owner mismatch');
      const names = copySeriesJSON(presentation.teamNames || {}), next = presentation.nextGame == null ? null : copySeriesJSON(presentation.nextGame);
      if (Object.values(names).some(name => typeof name !== 'string')) throw new Error('Team display names must be strings');
      coordinator.setSeries(record); teamNames = names; nextGame = next; rememberStage(); return render();
    },
    setSnapshot(snapshot) { epoch++; coordinator.setSeries(coordinator.series); pending = false; rememberStage(); render(); coordinator.setSnapshot(snapshot); rememberStage(); return render(); },
    capture() { const capture = coordinator.capture(); pending = true; render(); return capture; },
    calculate(capture) { return coordinator.calculate(capture); },
    accept(result) { if (!active || !coordinator.accept(result)) return false; pending = false; render(); return true; },
    calculateCurrent() { const capture = api.capture(), result = api.calculate(capture); return api.accept(result); },
    async prepareSnapshot(input, options = {}) {
      const request = ++epoch; pending = true; const promise = coordinator.prepareSnapshot(input, options); render();
      try { const snapshot = await promise; if (request !== epoch || !active) return null; pending = false; rememberStage(); render(); return snapshot; }
      catch (error) { if (request !== epoch || !active) return null; pending = false; render(); throw error; }
    },
    async load({repository, series_id, prior = null, priorAPI = null, teamNames: names = {}, nextGame: next = null}) {
      const request = ++epoch; coordinator.setSeries(coordinator.series); pending = true; rememberStage(); render();
      try {
        const saved = await repository.load(series_id, {prior, priorAPI});
        if (request !== epoch || !active) return false;
        pending = false;
        if (saved === null) { render(); return false; }
        if (saved.series.context.series_id !== series_id) throw new Error('Loaded series ID mismatch');
        api.setSeries(saved.series, {teamNames: names, nextGame: next});
        if (saved.snapshot) { api.setSnapshot(saved.snapshot); api.calculateCurrent(); }
        return true;
      } catch (error) { if (request !== epoch || !active) return false; pending = false; render(); throw error; }
    },
    deactivate() { active = false; epoch++; coordinator.invalidate(); pending = false; render(); },
    activate() { active = true; if (coordinator.snapshot) api.calculateCurrent(); else render(); },
    inspect() { return Object.freeze({phaseContext: context, purpose, active, epoch, series: coordinator.series, snapshot: coordinator.snapshot, result: coordinator.result, presentation: render()}); }
  });
  el('stage').addEventListener('change', () => {
    const stage = el('stage').value;
    rememberStage();
    const saved = stageViews.get(stage);
    api.setSeries(saved?.series || unconfirmedSeries(stage, purpose), saved || {});
    if (saved?.snapshot) { api.setSnapshot(saved.snapshot); if (active) api.calculateCurrent(); }
  });
  rememberStage();
  render(); return api;
}
