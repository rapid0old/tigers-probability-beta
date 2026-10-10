// Memoized acyclic DP. External per-game W/L/T probabilities; no ratings or RNG.
import {recordCSPhysicalResult} from './postseason-rules.mjs';
import {validateCSSeriesRules, copyCSSeriesState, remainingCSSeriesGames, decideCSSeriesWithRemaining, cssSeriesStateKey} from './cs-series-state.mjs';

export const CS_PROBABILITY_TOLERANCE = 1e-12;
const OUTCOMES = ['HIGHER_WIN', 'LOWER_WIN', 'TIE'];

export function validateCSGameProbability(input) {
  const values = [input?.upperWin, input?.lowerWin, input?.tie];
  if (values.some(p => !Number.isFinite(p) || p < 0 || p > 1)) throw new Error('Finite non-negative upperWin/lowerWin/tie probabilities are required');
  const sum = values.reduce((total, p) => total + p, 0);
  if (Math.abs(sum - 1) > CS_PROBABILITY_TOLERANCE) throw new Error('Game probabilities must sum to one');
  return Object.freeze({upperWin: values[0] / sum, lowerWin: values[1] / sum, tie: values[2] / sum});
}

export function simulateCSSeries({rules, state, remainingPhysicalGames, gameProbabilities}) {
  const confirmedRules = validateCSSeriesRules(rules), initialState = copyCSSeriesState(confirmedRules, state);
  const remaining = remainingCSSeriesGames(confirmedRules, initialState, remainingPhysicalGames);
  const physicalLimit = initialState.physicalGamesPlayed + remaining;
  const memo = new Map();
  let memoHits = 0, probabilityEvaluations = 0;

  function visit(current) {
    const remainingGames = physicalLimit - current.physicalGamesPlayed;
    const key = cssSeriesStateKey(confirmedRules, current, remainingGames);
    if (memo.has(key)) { memoHits++; return memo.get(key); }
    const decision = decideCSSeriesWithRemaining(confirmedRules, current, remainingGames);
    if (decision.finished) {
      const result = {upper: Number(decision.winner === 'HIGHER_SEED'), lower: Number(decision.winner === 'LOWER_SEED'), expectedRemaining: 0};
      memo.set(key, result); return result;
    }
    const gameIndex = current.physicalGamesPlayed - initialState.physicalGamesPlayed;
    const input = typeof gameProbabilities === 'function' ? gameProbabilities(current, gameIndex) :
      Array.isArray(gameProbabilities) ? gameProbabilities[gameIndex] : undefined;
    const probability = validateCSGameProbability(input);
    probabilityEvaluations++;
    const weights = [probability.upperWin, probability.lowerWin, probability.tie];
    const result = {upper: 0, lower: 0, expectedRemaining: 1};
    for (let index = 0; index < OUTCOMES.length; index++) {
      if (weights[index] === 0) continue;
      const child = visit(recordCSPhysicalResult(confirmedRules, current, OUTCOMES[index]));
      result.upper += weights[index] * child.upper;
      result.lower += weights[index] * child.lower;
      result.expectedRemaining += weights[index] * child.expectedRemaining;
    }
    memo.set(key, result); return result;
  }

  const result = visit(initialState), mass = result.upper + result.lower;
  if (!Number.isFinite(mass) || Math.abs(mass - 1) > CS_PROBABILITY_TOLERANCE) throw new Error('Invalid terminal probability mass');
  return Object.freeze({
    upperAdvanceProbability: result.upper / mass, lowerAdvanceProbability: result.lower / mass,
    expectedPhysicalGames: initialState.physicalGamesPlayed + result.expectedRemaining,
    expectedRemainingPhysicalGames: result.expectedRemaining,
    diagnostics: Object.freeze({visitedStates: memo.size, memoEntries: memo.size, memoHits, probabilityEvaluations})
  });
}
