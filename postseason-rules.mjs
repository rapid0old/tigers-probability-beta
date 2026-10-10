// Verified against NPB's 2026-08-24 announcement on 2026-09-30.
export const CS_RULE_SOURCE = 'https://npb.jp/games/2026/info_cs.html';
export const UNKNOWN = 'UNKNOWN';
const freeze = value => Object.freeze(value);
function csRules(stage, maxPhysicalGames, advantageWins, winsNeeded) {
  return freeze({ruleset_id: `npb-2026-${stage}-${advantageWins}`, season: 2026, phase: 'POSTSEASON', competition: 'CS', stage,
    status: 'CONFIRMED_SERIES_FORMAT', source: CS_RULE_SOURCE, verifiedOn: '2026-09-30',
    maxPhysicalGames, advantageWins, winsNeeded, homeTeam: 'HIGHER_SEED', equalWinsWinner: 'HIGHER_SEED',
    tiesCountAsPhysicalGames: true, earlyClinch: true, extension: UNKNOWN, dh: UNKNOWN});
}
export function createCSFirstRules() { return csRules('FIRST', 3, 0, 2); }
export function usesTwoWinAdvantage({gamesBehind, challengerRegularWinPct}) {
  if (!Number.isFinite(gamesBehind) || gamesBehind < 0 || !Number.isFinite(challengerRegularWinPct) || challengerRegularWinPct < 0 || challengerRegularWinPct > 1) throw new Error('Confirmed Regular gamesBehind and winPct are required');
  return gamesBehind >= 10 || challengerRegularWinPct < .500;
}
export function createCSFinalRules(input) {
  return usesTwoWinAdvantage(input) ? csRules('FINAL', 7, 2, 5) : csRules('FINAL', 6, 1, 4);
}
// Small state suitable for a future memoized DP. Advantage remains a virtual count.
export function createCSSeriesState(rules) {
  validateRules(rules);
  return freeze({physicalGamesPlayed: 0, higherActualWins: 0, lowerActualWins: 0, ties: 0, schedulingClosed: false});
}
function validateRules(rules) {
  if (rules?.competition !== 'CS' || rules.season !== 2026 || rules.status !== 'CONFIRMED_SERIES_FORMAT' || !['FIRST', 'FINAL'].includes(rules.stage)) throw new Error('Confirmed CS series rules required');
  const expected = rules.stage === 'FIRST' ? [3, 0, 2] : rules.advantageWins === 1 ? [6, 1, 4] : rules.advantageWins === 2 ? [7, 2, 5] : [];
  if (expected.length !== 3 || [rules.maxPhysicalGames, rules.advantageWins, rules.winsNeeded].some((value, index) => value !== expected[index])) throw new Error('Invalid CS rules');
}
function validateState(rules, state) {
  validateRules(rules);
  for (const key of ['physicalGamesPlayed', 'higherActualWins', 'lowerActualWins', 'ties']) if (!Number.isInteger(state?.[key]) || state[key] < 0) throw new Error('Invalid physical series state');
  if (state.physicalGamesPlayed !== state.higherActualWins + state.lowerActualWins + state.ties || state.physicalGamesPlayed > rules.maxPhysicalGames || typeof state.schedulingClosed !== 'boolean') throw new Error('Inconsistent physical series state');
}
export function decideCSSeries(rules, state) {
  validateState(rules, state);
  const higher = state.higherActualWins + rules.advantageWins, lower = state.lowerActualWins;
  const remaining = state.schedulingClosed ? 0 : rules.maxPhysicalGames - state.physicalGamesPlayed;
  if (higher >= rules.winsNeeded) return freeze({finished: true, winner: 'HIGHER_SEED', reason: 'WINS_NEEDED'});
  if (lower >= rules.winsNeeded) return freeze({finished: true, winner: 'LOWER_SEED', reason: 'WINS_NEEDED'});
  if (higher >= lower + remaining) return freeze({finished: true, winner: 'HIGHER_SEED', reason: remaining ? 'CANNOT_BE_OVERTAKEN' : 'FINAL_WIN_COUNTS'});
  if (!remaining) return freeze({finished: true, winner: 'LOWER_SEED', reason: 'FINAL_WIN_COUNTS'});
  return freeze({finished: false, winner: null, reason: null});
}
export function recordCSPhysicalResult(rules, state, outcome) {
  if (decideCSSeries(rules, state).finished) throw new Error('Series has already finished');
  if (!['HIGHER_WIN', 'LOWER_WIN', 'TIE'].includes(outcome)) throw new Error('A played win/loss/tie is required; cancellation is not a physical game');
  return freeze({...state, physicalGamesPlayed: state.physicalGamesPlayed + 1,
    higherActualWins: state.higherActualWins + (outcome === 'HIGHER_WIN' ? 1 : 0),
    lowerActualWins: state.lowerActualWins + (outcome === 'LOWER_WIN' ? 1 : 0), ties: state.ties + (outcome === 'TIE' ? 1 : 0)});
}
export function closeCSSchedule(rules, state) { validateState(rules, state); return freeze({...state, schedulingClosed: true}); }
export function createJapanSeriesPlaceholder() {
  return freeze({ruleset_id: 'npb-2026-japan-series-unfinalized', season: 2026, phase: 'POSTSEASON', competition: 'JAPAN_SERIES', stage: 'JAPAN_SERIES',
    status: 'NOT_FINALIZED', source: 'https://npb.jp/nippons/2026/', verifiedOn: '2026-09-30',
    maxPhysicalGames: UNKNOWN, advantageWins: UNKNOWN, winsNeeded: UNKNOWN, extension: UNKNOWN, dh: UNKNOWN, tieHandling: UNKNOWN, game8Plus: UNKNOWN, rainPostponement: UNKNOWN});
}
