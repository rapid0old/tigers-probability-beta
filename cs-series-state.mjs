// Numeric CS state adapter. No game/player statistics, storage or prediction model.
import {CS_RULE_SOURCE, createCSSeriesState, decideCSSeries, closeCSSchedule} from './postseason-rules.mjs';

const STATE_FIELDS = ['physicalGamesPlayed', 'higherActualWins', 'lowerActualWins', 'ties'];
const freeze = Object.freeze;

export function validateCSSeriesRules(rules) {
  createCSSeriesState(rules); // Reuse Stage 1's confirmed FIRST / FINAL formats.
  if (rules.phase !== 'POSTSEASON' || rules.source !== CS_RULE_SOURCE ||
      rules.ruleset_id !== `npb-2026-${rules.stage}-${rules.advantageWins}` ||
      rules.homeTeam !== 'HIGHER_SEED' || rules.equalWinsWinner !== 'HIGHER_SEED' ||
      rules.tiesCountAsPhysicalGames !== true || rules.earlyClinch !== true) {
    throw new Error('Unsupported CS ruleset semantics');
  }
  return freeze(Object.fromEntries([
    'ruleset_id', 'season', 'phase', 'competition', 'stage', 'status', 'source', 'verifiedOn',
    'maxPhysicalGames', 'advantageWins', 'winsNeeded', 'homeTeam', 'equalWinsWinner',
    'tiesCountAsPhysicalGames', 'earlyClinch', 'extension', 'dh'
  ].map(key => [key, rules[key]])));
}

export function copyCSSeriesState(rules, state = createCSSeriesState(rules)) {
  validateCSSeriesRules(rules);
  if (STATE_FIELDS.some(key => !Number.isSafeInteger(state?.[key]) || state[key] < 0) ||
      typeof state?.schedulingClosed !== 'boolean') throw new Error('Invalid physical series state');
  const copy = freeze({...Object.fromEntries(STATE_FIELDS.map(key => [key, state[key]])), schedulingClosed: state.schedulingClosed});
  decideCSSeries(rules, copy); // Stage 1 validates physical counts and official maximum.
  if (copy.higherActualWins > rules.winsNeeded - rules.advantageWins || copy.lowerActualWins > rules.winsNeeded) {
    throw new Error('Actual wins exceed a completed series');
  }
  return copy;
}

// Optional stable team identity envelope; numeric state keeps the Stage 1 shape.
export function createCSSeries({rules, upperTeamId, lowerTeamId, state}) {
  for (const id of [upperTeamId, lowerTeamId]) if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/.test(id)) throw new Error('Stable team ID required');
  if (upperTeamId === lowerTeamId) throw new Error('Two distinct teams are required');
  const confirmedRules = validateCSSeriesRules(rules);
  return freeze({rules: confirmedRules, state: copyCSSeriesState(confirmedRules, state), upperTeamId, lowerTeamId});
}

export function remainingCSSeriesGames(rules, state, remainingPhysicalGames) {
  const maximum = state.schedulingClosed ? 0 : rules.maxPhysicalGames - state.physicalGamesPlayed;
  const remaining = remainingPhysicalGames === undefined ? maximum : remainingPhysicalGames;
  if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > maximum) throw new Error('Invalid remaining physical games');
  return remaining;
}

export function decideCSSeriesWithRemaining(rules, state, remainingPhysicalGames) {
  const copy = copyCSSeriesState(rules, state);
  const remaining = remainingCSSeriesGames(rules, copy, remainingPhysicalGames);
  const decision = decideCSSeries(rules, copy);
  if (decision.finished) return decision;
  if (!remaining) return decideCSSeries(rules, closeCSSchedule(rules, copy));
  // Only a shorter explicitly supplied physical horizon needs an extra bound.
  // The ordinary max-game decisions and all advancement thresholds stay in Stage 1.
  if (copy.higherActualWins + rules.advantageWins >= copy.lowerActualWins + remaining) {
    return freeze({finished: true, winner: 'HIGHER_SEED', reason: 'CANNOT_BE_OVERTAKEN'});
  }
  return decision;
}

export function cssSeriesStateKey(rules, state, remainingPhysicalGames) {
  const copy = copyCSSeriesState(rules, state);
  const remaining = remainingCSSeriesGames(rules, copy, remainingPhysicalGames);
  return JSON.stringify([rules.ruleset_id, copy.physicalGamesPlayed + remaining,
    copy.physicalGamesPlayed, copy.higherActualWins, copy.lowerActualWins, copy.ties,
    Number(copy.schedulingClosed)]);
}
