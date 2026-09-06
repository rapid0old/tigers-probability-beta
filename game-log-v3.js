(() => {
'use strict';

const APP_VERSION = 'v3.0.0';
const MODEL_VERSION = 'probability-v2.0.2-snapshot-2026-09-04';
const STORE_KEY = 'tigersGameLogV3';
const STORE_VERSION = 1;
const TIGERS = 'Tigers';
const AVERAGE_BATTER_ID = '__avg__';
const LINEUP_PITCHER_ID = '__pitcher__';
const AVERAGE_PITCHER_ID = '__avg_pitcher__';
const GAME_TYPES = new Set(['REGULAR', 'CS_FIRST', 'CS_FINAL', 'JAPAN_SERIES']);
const PRIMARY_VENUE = {
  Giants: 'tokyo-dome', Tigers: 'koshien', BayStars: 'yokohama', Carp: 'mazda',
  Dragons: 'vantelin', Swallows: 'jingu', Hawks: 'paypay', Fighters: 'escon',
  Buffaloes: 'kyocera', Eagles: 'rakuten-mobile', Lions: 'belluna', Marines: 'zozo',
};
const RESULT_MAP = {
  OUT: 'OUT', K: 'K', ADV: 'ADV', SF: 'SF', SAC: 'SAC', BB: 'BB_HBP',
  '1B': '1B', '2B': '2B', '3B': '3B', HR: 'HR', DP: 'DP', E: 'E', FC: 'FC',
};
const OFFICIAL_AT_BAT = new Set(['OUT', 'K', 'ADV', '1B', '2B', '3B', 'HR', 'DP', 'E', 'FC']);
const OUTS_ON_PLAY = { OUT: 1, K: 1, ADV: 1, SF: 1, SAC: 1, DP: 2 };

let client = null;
let session = null;
let store = loadStore();
let masters = null;
let syncing = false;
let authGeneration = 0;
let pendingPlatePlay = '';
let statusMessage = '';
let lastStableState = null;

function emptyStore() {
  return { version: STORE_VERSION, profiles: {} };
}

function loadStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return parsed?.version === STORE_VERSION && parsed.profiles ? parsed : emptyStore();
  } catch (error) {
    return emptyStore();
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (error) {
    setStatus('端末内のログ保存に失敗しました');
  }
  renderPanel();
}

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  return [...bytes].map((value, index) => `${index === 4 || index === 6 || index === 8 || index === 10 ? '-' : ''}${value.toString(16).padStart(2, '0')}`).join('');
}

function currentProfile(create = false) {
  const userId = session?.user?.id;
  if (!userId) return null;
  if (!store.profiles[userId] && create) {
    store.profiles[userId] = {
      activeGameId: null,
      games: {},
      seriesIds: {},
      logSetup: { gameType: 'REGULAR', seriesGameNumber: 1 },
    };
  }
  const profile = store.profiles[userId] || null;
  if (profile) {
    profile.seriesIds ||= {};
    profile.logSetup ||= { gameType: 'REGULAR', seriesGameNumber: 1 };
  }
  return profile;
}

function currentGame() {
  const profile = currentProfile();
  return profile?.games?.[profile.activeGameId] || null;
}

function pendingCount(profile = currentProfile()) {
  if (!profile) return 0;
  return Object.values(profile.games || {}).reduce((sum, game) => sum + (game.events || []).filter((event) => !event.syncedAt).length, 0);
}

function setStatus(message) {
  statusMessage = message || '';
  renderPanel();
}

function safeSnapshot() {
  try {
    if (typeof snapshot !== 'function') return null;
    const raw = snapshot();
    const opponent = raw.opponent || document.getElementById('opponent')?.value;
    const homeAway = raw.homeAway || document.getElementById('homeAway')?.value || 'home';
    const homeTeam = homeAway === 'home' ? TIGERS : opponent;
    const awayTeam = homeAway === 'home' ? opponent : TIGERS;
    const half = raw.half === 'bottom' ? 'BOTTOM' : 'TOP';
    const battingTeam = half === 'TOP' ? awayTeam : homeTeam;
    const fieldingTeam = half === 'TOP' ? homeTeam : awayTeam;
    const tigersScore = nonnegative(raw.tigersScore);
    const opponentScore = nonnegative(raw.oppScore);
    const homeScore = homeAway === 'home' ? tigersScore : opponentScore;
    const awayScore = homeAway === 'home' ? opponentScore : tigersScore;
    const tPos = bounded(raw.tPos, 0, 8);
    const oPos = bounded(raw.oPos, 0, 8);
    const tLine = Array.isArray(raw.tLine) ? [...raw.tLine] : [];
    const oLine = Array.isArray(raw.oLine) ? [...raw.oLine] : [];
    let batterSourceId = battingTeam === TIGERS ? tLine[tPos] : oLine[oPos];
    const pitcherSourceId = fieldingTeam === TIGERS ? raw.tPitcher : raw.oPitcher;
    if (batterSourceId === LINEUP_PITCHER_ID) {
      batterSourceId = battingTeam === TIGERS ? raw.tPitcher : raw.oPitcher;
    }
    const venueSelection = raw.ballpark || document.getElementById('ballpark')?.value || 'auto';
    const winText = document.getElementById('wText')?.textContent || '';
    const winProbability = Number.parseFloat(winText.replace('%', ''));
    return {
      inning: bounded(raw.inning, 1, 99), half, outs: bounded(raw.outs, 0, 3),
      balls: bounded(raw.balls, 0, 3), strikes: bounded(raw.strikes, 0, 2),
      homeScore, awayScore, tigersScore, opponentScore,
      runners: {
        1: cleanPlayerSourceId(raw.baseRunners?.[1]),
        2: cleanPlayerSourceId(raw.baseRunners?.[2]),
        3: cleanPlayerSourceId(raw.baseRunners?.[3]),
      },
      opponent, homeAway, homeTeam, awayTeam, battingTeam, fieldingTeam,
      batterSourceId: cleanPlayerSourceId(batterSourceId),
      pitcherSourceId: cleanPlayerSourceId(pitcherSourceId),
      tLine, oLine, tPos, oPos,
      venueCode: venueSelection === 'auto' ? PRIMARY_VENUE[homeTeam] : venueSelection,
      gameEnded: Boolean(raw.gameEnded),
      gameEndReason: raw.gameEndReason || '',
      winProbability: Number.isFinite(winProbability) ? winProbability / 100 : null,
      pitchLoads: raw.pitchLoads || {},
    };
  } catch (error) {
    return null;
  }
}

function bounded(value, minimum, maximum) {
  const number = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? Math.trunc(number) : minimum));
}

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function cleanPlayerSourceId(value) {
  const sourceId = String(value || '');
  return sourceId || null;
}

function isPlaceholderPlayer(sourceId) {
  return !sourceId || [AVERAGE_BATTER_ID, LINEUP_PITCHER_ID, AVERAGE_PITCHER_ID].includes(sourceId);
}

function stateKey(state) {
  if (!state) return '';
  return JSON.stringify({
    inning: state.inning, half: state.half, outs: state.outs,
    balls: state.balls, strikes: state.strikes,
    homeScore: state.homeScore, awayScore: state.awayScore,
    runners: state.runners, opponent: state.opponent, homeAway: state.homeAway,
    batterSourceId: state.batterSourceId, pitcherSourceId: state.pitcherSourceId,
    tLine: state.tLine, oLine: state.oLine, tPos: state.tPos, oPos: state.oPos,
    venueCode: state.venueCode, gameEnded: state.gameEnded, pitchLoads: state.pitchLoads,
  });
}

function normalizeGameType(value) {
  return GAME_TYPES.has(value) ? value : 'REGULAR';
}

function metadataFromState(state, profile) {
  const now = new Date();
  const season = now.getFullYear();
  const gameType = normalizeGameType(profile.logSetup?.gameType);
  let seriesId = null;
  let seriesGameNumber = null;
  if (gameType !== 'REGULAR') {
    const seriesKey = `${season}:${gameType}`;
    profile.seriesIds[seriesKey] ||= uuid();
    seriesId = profile.seriesIds[seriesKey];
    seriesGameNumber = bounded(profile.logSetup?.seriesGameNumber, 1, 99);
  }
  const startsAtBeginning = state.inning === 1 && state.half === 'TOP'
    && state.outs === 0 && state.homeScore === 0 && state.awayScore === 0;
  return {
    season,
    gameDate: localDate(now),
    gameType,
    seriesId,
    seriesGameNumber,
    homeTeamCode: state.homeTeam,
    awayTeamCode: state.awayTeam,
    venueCode: state.venueCode || null,
    captureLevel: startsAtBeginning
      ? 'PLATE_APPEARANCE_WITH_COUNT_SNAPSHOTS'
      : 'PARTIAL_PLATE_APPEARANCE_WITH_COUNT_SNAPSHOTS',
    startedAt: now.toISOString(),
  };
}

function localDate(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function createGame(state) {
  const profile = currentProfile(true);
  const clientGameId = uuid();
  const game = {
    clientGameId,
    remoteGameId: null,
    recording: true,
    countObserved: false,
    status: 'IN_PROGRESS',
    nextSeq: 1,
    nextPa: 1,
    metadata: metadataFromState(state, profile),
    runnerSlots: { 1: null, 2: null, 3: null },
    eventStack: [],
    redoStack: [],
    events: [],
  };
  profile.games[clientGameId] = game;
  profile.activeGameId = clientGameId;
  queueGameStart(game, state);
  saveStore();
  setStatus('試合記録を開始しました');
  void syncPending();
  return game;
}

function startOrResumeRecording() {
  if (!session?.user) {
    setStatus('先にログインしてください');
    return;
  }
  const state = safeSnapshot();
  if (!state) {
    setStatus('現在の試合状態を読み取れませんでした');
    return;
  }
  const game = currentGame();
  if (game && game.status === 'IN_PROGRESS') {
    game.recording = true;
    saveStore();
    setStatus('試合記録を再開しました');
    return;
  }
  const profile = currentProfile(true);
  profile.logSetup.gameType = normalizeGameType(document.getElementById('dbLogGameType')?.value);
  profile.logSetup.seriesGameNumber = bounded(document.getElementById('dbLogSeriesGameNumber')?.value, 1, 99);
  createGame(state);
}

function pauseRecording() {
  const game = currentGame();
  if (!game) return;
  game.recording = false;
  game.countObserved = false;
  game.metadata.captureLevel = 'PARTIAL_PLATE_APPEARANCE_WITH_COUNT_SNAPSHOTS';
  saveStore();
  setStatus('試合記録を一時停止しました');
}

function makeRunnerSlot(sourceId, originClientEventId, instanceId = uuid()) {
  return { sourceId: sourceId || AVERAGE_BATTER_ID, instanceId, originClientEventId };
}

function queueGameStart(game, state) {
  state = { ...state, countObserved: false };
  const clientEventId = uuid();
  const runnerEvents = [];
  for (const base of [1, 2, 3]) {
    const sourceId = state.runners[base];
    if (!sourceId) continue;
    const slot = makeRunnerSlot(sourceId, clientEventId);
    game.runnerSlots[base] = slot;
    runnerEvents.push(localRunnerEvent(slot, 0, base, 'STATE_AT_START', false, false, clientEventId));
  }
  appendLocalEvent(game, {
    clientEventId,
    type: 'GAME_START',
    inputMode: 'AUTOMATIC',
    before: state,
    after: state,
    runnerBefore: cloneSlots(game.runnerSlots),
    runnerAfter: cloneSlots(game.runnerSlots),
    payload: { capture_started_at: game.metadata.startedAt },
    runnerEvents,
    prediction: predictionFromState(state),
  });
}

function cloneSlots(slots) {
  return Object.fromEntries([1, 2, 3].map((base) => [base, slots[base] ? { ...slots[base] } : null]));
}

function appendLocalEvent(game, event) {
  const entry = {
    ...event,
    eventSeq: game.nextSeq++,
    createdAt: new Date().toISOString(),
    syncedAt: null,
  };
  game.events.push(entry);
  return entry;
}

function predictionFromState(state) {
  if (!Number.isFinite(state?.winProbability)) return null;
  return {
    model_version: MODEL_VERSION,
    prediction_context: 'BEFORE_EVENT',
    tigers_win_probability: Math.min(1, Math.max(0, state.winProbability)),
  };
}

function localRunnerEvent(slot, fromBase, toBase, type, isOut, runScored, originClientEventId = slot.originClientEventId) {
  return {
    runner_source_id: slot.sourceId || AVERAGE_BATTER_ID,
    runner_instance_id: slot.instanceId,
    origin_client_event_id: originClientEventId,
    from_base: fromBase,
    to_base: toBase,
    runner_event_type: type,
    is_out: Boolean(isOut),
    run_scored: Boolean(runScored),
    created_at: new Date().toISOString(),
  };
}

function alignSlots(slots, state, fallbackOrigin) {
  const aligned = { 1: null, 2: null, 3: null };
  const unused = new Set([1, 2, 3].filter((base) => slots[base]));
  for (const base of [1, 2, 3]) {
    const sourceId = state.runners[base];
    if (!sourceId) continue;
    if (slots[base]?.sourceId === sourceId) {
      aligned[base] = { ...slots[base] };
      unused.delete(base);
    }
  }
  for (const base of [1, 2, 3]) {
    const sourceId = state.runners[base];
    if (!sourceId || aligned[base]) continue;
    const match = [...unused].find((candidate) => slots[candidate]?.sourceId === sourceId);
    if (match) {
      aligned[base] = { ...slots[match] };
      unused.delete(match);
    } else {
      aligned[base] = makeRunnerSlot(sourceId, fallbackOrigin);
    }
  }
  return aligned;
}

function reconcileRunners(game, before, after, action, clientEventId, emit = true) {
  const previous = alignSlots(game.runnerSlots, before, game.events[0]?.clientEventId || clientEventId);
  const next = { 1: null, 2: null, 3: null };
  const runnerEvents = [];
  const usedBefore = new Set();
  const changedAtSameBase = new Set();

  for (const base of [1, 2, 3]) {
    if (previous[base] && after.runners[base] === previous[base].sourceId) {
      next[base] = { ...previous[base] };
      usedBefore.add(base);
    }
  }

  if (action.type === 'PINCH_RUNNER') {
    for (const base of [1, 2, 3]) {
      if (!next[base] && previous[base] && after.runners[base]) {
        const replacement = { ...previous[base], sourceId: after.runners[base] };
        next[base] = replacement;
        usedBefore.add(base);
        changedAtSameBase.add(base);
        if (emit) runnerEvents.push(localRunnerEvent(replacement, base, base, 'PINCH_RUNNER', false, false));
      }
    }
  }

  for (const base of [1, 2, 3]) {
    const sourceId = after.runners[base];
    if (!sourceId || next[base]) continue;
    const fromBase = [1, 2, 3].find((candidate) => !usedBefore.has(candidate) && previous[candidate]?.sourceId === sourceId);
    if (fromBase) {
      next[base] = { ...previous[fromBase] };
      usedBefore.add(fromBase);
      if (emit && fromBase !== base) {
        const moveType = action.stealSuccess ? 'STEAL' : action.swap ? 'SWAP' : 'ADVANCE';
        runnerEvents.push(localRunnerEvent(next[base], fromBase, base, moveType, false, false));
      }
    }
  }

  for (const base of [1, 2, 3]) {
    const sourceId = after.runners[base];
    if (!sourceId || next[base]) continue;
    const slot = makeRunnerSlot(sourceId, clientEventId);
    next[base] = slot;
    if (emit) {
      const type = action.type === 'PLATE_RESULT' && sourceId === before.batterSourceId
        ? 'BATTER_REACHED' : 'MANUAL_SET';
      runnerEvents.push(localRunnerEvent(slot, 0, base, type, false, false, clientEventId));
    }
  }

  const removed = [1, 2, 3].filter((base) => previous[base] && !usedBefore.has(base) && !changedAtSameBase.has(base));
  let scoresRemaining = battingRuns(before, after);
  for (const base of removed.sort((left, right) => right - left)) {
    const slot = previous[base];
    if (!emit) continue;
    if (scoresRemaining > 0) {
      runnerEvents.push(localRunnerEvent(slot, base, 4, 'SCORE', false, true));
      scoresRemaining--;
    } else {
      const caught = action.stealFailure;
      const runnerOut = caught || action.play === 'DP';
      const type = caught ? 'CAUGHT_STEAL' : runnerOut ? 'OUT' : 'MANUAL_REMOVE';
      runnerEvents.push(localRunnerEvent(slot, base, base, type, runnerOut, false));
    }
  }

  if (emit && action.type === 'PLATE_RESULT' && scoresRemaining > 0 && before.batterSourceId) {
    const batterSlot = makeRunnerSlot(before.batterSourceId, clientEventId);
    runnerEvents.push(localRunnerEvent(batterSlot, 0, 4, 'SCORE', false, true, clientEventId));
  }

  game.runnerSlots = next;
  return { before: previous, after: next, runnerEvents };
}

function battingRuns(before, after) {
  if (before.battingTeam === before.homeTeam) return Math.max(0, after.homeScore - before.homeScore);
  return Math.max(0, after.awayScore - before.awayScore);
}

function plateAppearance(game, action, before, after) {
  const resultCode = RESULT_MAP[action.play];
  if (!resultCode) return null;
  return {
    pa_number: game.nextPa++,
    batter_source_id: before.batterSourceId || AVERAGE_BATTER_ID,
    pitcher_source_id: before.pitcherSourceId,
    batting_team_code: before.battingTeam,
    fielding_team_code: before.fieldingTeam,
    inning: before.inning,
    half: before.half,
    outs_before: Math.min(2, before.outs),
    balls_at_end: before.countObserved ? before.balls : null,
    strikes_at_end: before.countObserved ? before.strikes : null,
    result_code: resultCode,
    rbi: null,
    runs_scored: battingRuns(before, after),
    outs_on_play: OUTS_ON_PLAY[action.play] || 0,
    is_official_at_bat: OFFICIAL_AT_BAT.has(action.play),
    created_at: new Date().toISOString(),
  };
}

function operationPayload(action, before, after) {
  const payload = {
    action: action.name || action.type,
    batter_source_id: before.batterSourceId,
    pitcher_source_id: before.pitcherSourceId,
    runner_source_ids_before: before.runners,
    runner_source_ids_after: after.runners,
    count_observed_before: Boolean(before.countObserved),
    count_observed_after: Boolean(after.countObserved),
  };
  if (action.play) payload.result_code = RESULT_MAP[action.play] || action.play;
  if (action.destinations) payload.runner_destinations = action.destinations;
  if (action.controlId) payload.control_id = action.controlId;
  if (action.type === 'LINEUP_CHANGE' || action.type === 'GAME_CONFIG_CHANGE') {
    payload.lineup_before = { Tigers: before.tLine, opponent: before.oLine };
    payload.lineup_after = { Tigers: after.tLine, opponent: after.oLine };
  }
  return payload;
}

function recordOperation(action, before, after) {
  const game = currentGame();
  if (!game?.recording || game.status !== 'IN_PROGRESS') return;
  const clientEventId = uuid();
  let relatedClientEventId = null;

  if (action.type === 'UNDO') {
    relatedClientEventId = game.eventStack.pop() || null;
    if (relatedClientEventId) game.redoStack.push(relatedClientEventId);
  } else if (action.type === 'REDO') {
    relatedClientEventId = game.redoStack.pop() || null;
    if (relatedClientEventId) game.eventStack.push(relatedClientEventId);
  }

  const related = game.events.find((event) => event.clientEventId === relatedClientEventId);
  before = { ...before, countObserved: Boolean(game.countObserved) };
  after = { ...after, countObserved: before.countObserved };
  if (action.type === 'COUNT_CHANGE') {
    before.countObserved = true;
    after.countObserved = true;
  } else if (action.type === 'UNDO' || action.type === 'REDO') {
    after.countObserved = Boolean(action.type === 'UNDO' ? related?.before.countObserved : related?.after.countObserved);
  } else if (action.type === 'PLATE_RESULT' || action.type === 'INNING_CHANGE'
      || before.batterSourceId !== after.batterSourceId || before.half !== after.half
      || before.inning !== after.inning || before.tPos !== after.tPos || before.oPos !== after.oPos) {
    after.countObserved = false;
  }
  game.countObserved = after.countObserved;
  let runnerState;
  if (related && ['UNDO', 'REDO'].includes(action.type)) {
    const restored = cloneSlots(action.type === 'UNDO' ? related.runnerBefore : related.runnerAfter);
    runnerState = { before: cloneSlots(game.runnerSlots), after: restored, runnerEvents: [] };
    game.runnerSlots = restored;
  } else {
    runnerState = reconcileRunners(game, before, after, action, clientEventId, !['UNDO', 'REDO'].includes(action.type));
  }
  const entry = appendLocalEvent(game, {
    clientEventId,
    type: action.type,
    inputMode: inputModeFor(action, before, after),
    relatedClientEventId,
    before,
    after,
    runnerBefore: runnerState.before,
    runnerAfter: runnerState.after,
    payload: operationPayload(action, before, after),
    plateAppearance: action.type === 'PLATE_RESULT' ? plateAppearance(game, action, before, after) : null,
    runnerEvents: runnerState.runnerEvents,
    prediction: predictionFromState(before),
  });
  if (!['UNDO', 'REDO'].includes(action.type)) {
    game.eventStack.push(entry.clientEventId);
    game.redoStack = [];
  }
  saveStore();
  void syncPending();
}

function inputModeFor(action, before, after) {
  if (action.type === 'UNDO') return 'UNDO';
  if (action.type === 'REDO') return 'REDO';
  if (action.type === 'COUNT_CHANGE') {
    const delta = Math.abs(after.balls - before.balls) + Math.abs(after.strikes - before.strikes);
    return delta > 1 ? 'BULK' : 'DIRECT';
  }
  if (action.automatic) return 'AUTOMATIC';
  return action.manual ? 'MANUAL' : 'DIRECT';
}

function queueGameEnd(game, state) {
  if (!game || game.status === 'FINISHED') return;
  state = { ...state, countObserved: Boolean(game.countObserved) };
  const clientEventId = uuid();
  const result = state.homeScore > state.awayScore ? 'HOME_WIN'
    : state.homeScore < state.awayScore ? 'AWAY_WIN' : 'DRAW';
  appendLocalEvent(game, {
    clientEventId,
    type: 'GAME_END',
    inputMode: 'AUTOMATIC',
    before: state,
    after: state,
    runnerBefore: cloneSlots(game.runnerSlots),
    runnerAfter: cloneSlots(game.runnerSlots),
    payload: {
      reason: state.gameEndReason,
      final_home_score: state.homeScore,
      final_away_score: state.awayScore,
      result,
      finished_at: new Date().toISOString(),
    },
    runnerEvents: [],
    prediction: predictionFromState(state),
  });
  game.status = 'FINISHED';
  game.recording = false;
  const profile = currentProfile();
  const gameType = normalizeGameType(game.metadata.gameType);
  if (profile && gameType !== 'REGULAR') {
    profile.logSetup.gameType = gameType;
    profile.logSetup.seriesGameNumber = Math.min(99, bounded(game.metadata.seriesGameNumber, 1, 99) + 1);
  }
  saveStore();
  void syncPending();
}

function queueGameReopen(game, state) {
  if (!game || game.status !== 'FINISHED') return;
  state = { ...state, countObserved: Boolean(game.countObserved) };
  game.status = 'IN_PROGRESS';
  game.recording = true;
  const clientEventId = uuid();
  appendLocalEvent(game, {
    clientEventId,
    type: 'GAME_REOPEN',
    inputMode: 'MANUAL',
    before: state,
    after: state,
    runnerBefore: cloneSlots(game.runnerSlots),
    runnerAfter: cloneSlots(game.runnerSlots),
    payload: { reopened_at: new Date().toISOString() },
    runnerEvents: [],
    prediction: predictionFromState(state),
  });
}

function identifyAction(target, eventName) {
  const button = target.closest?.('button');
  if (eventName === 'click' && button) {
    if (button.classList.contains('playBtn')) {
      pendingPlatePlay = button.dataset.play || '';
      return { type: 'PLATE_RESULT', play: pendingPlatePlay, name: 'plate_result' };
    }
    if (button.id === 'confirmRunnerAdvance') {
      const destinations = Object.fromEntries([...document.querySelectorAll('#runnerAdvanceRows select[data-runner-from]')]
        .map((select) => [select.dataset.runnerFrom, Number(select.value)]));
      return { type: 'PLATE_RESULT', play: pendingPlatePlay, destinations, name: 'plate_result_with_runner_choice' };
    }
    if (button.id === 'undoBtn') return { type: 'UNDO', name: 'undo' };
    if (button.id === 'redoBtn') return { type: 'REDO', name: 'redo' };
    if (button.id === 'nextHalf' || button.id === 'topBtn' || button.id === 'botBtn') return { type: 'INNING_CHANGE', name: button.id };
    if (button.classList.contains('outBtn')) return { type: 'OUTS_CHANGE', name: 'outs_button' };
    if (button.classList.contains('ballBtn') || button.classList.contains('strikeBtn')) return { type: 'COUNT_CHANGE', name: 'count_button' };
    if (/^b[123]$/.test(button.id)) return { type: 'RUNNER_MOVE', name: 'base_toggle', manual: true };
    if (button.dataset.advanceRunner) return { type: 'RUNNER_MOVE', name: 'runner_advance', manual: true, swap: true };
    if (button.id === 'stealSuccess') return { type: 'RUNNER_MOVE', name: 'steal_success', stealSuccess: true };
    if (button.id === 'stealFailure') return { type: 'RUNNER_MOVE', name: 'caught_stealing', stealFailure: true };
    if (button.id === 'applyPinchHitter') return { type: 'PINCH_HITTER', name: 'pinch_hitter' };
    if (button.id === 'applyPinchRunner') return { type: 'PINCH_RUNNER', name: 'pinch_runner' };
    if (button.id === 'applyReliefPitcher') return { type: 'PITCHER_CHANGE', name: 'relief_pitcher' };
    if (button.id === 'clearOpponentLineup') return { type: 'LINEUP_CHANGE', name: 'clear_opponent_lineup', manual: true };
    if (button.id === 'startNextGame') return { type: 'NEW_GAME', name: 'start_next_game' };
    return null;
  }

  if (eventName !== 'change') return null;
  const id = target.id || '';
  if (id === 'tigersScore' || id === 'oppScore') return { type: 'SCORE_CHANGE', controlId: id, name: 'score_input', manual: true };
  if (id === 'inning') return { type: 'INNING_CHANGE', controlId: id, name: 'inning_select', manual: true };
  if (id === 'runner1' || id === 'runner2' || id === 'runner3') return { type: 'RUNNER_MOVE', controlId: id, name: 'runner_select', manual: true };
  if (id === 'tigersPitcher' || id === 'oppPitcher') return { type: 'PITCHER_CHANGE', controlId: id, name: 'pitcher_select', manual: true };
  if (id === 'pitcherFatigue') return { type: 'PITCHER_WORKLOAD_CHANGE', controlId: id, name: 'pitch_count_bucket', manual: true };
  if (id === 'ballpark') return { type: 'VENUE_CHANGE', controlId: id, name: 'venue_select', manual: true };
  if (id === 'opponent' || id === 'homeAway') return { type: 'GAME_CONFIG_CHANGE', controlId: id, name: 'game_config', manual: true };
  if (id === 'tigersBatterPos' || id === 'oppBatterPos' || /^tLine[0-8]$/.test(id) || /^oLine[0-8]$/.test(id)) {
    return { type: 'LINEUP_CHANGE', controlId: id, name: 'lineup_or_batter_position', manual: true };
  }
  return null;
}

function captureOperation(domEvent) {
  const action = identifyAction(domEvent.target, domEvent.type);
  const game = currentGame();
  if (!action) return;
  const canStartNext = action.type === 'NEW_GAME' && game?.status === 'FINISHED';
  const before = domEvent.type === 'change' && lastStableState ? lastStableState : safeSnapshot();
  if (!before) return;
  const shouldRecord = Boolean(game?.recording || canStartNext || (game?.status === 'FINISHED' && before.gameEnded));
  queueMicrotask(() => {
    if (shouldRecord) finalizeOperation(action, before);
    else lastStableState = safeSnapshot() || before;
  });
}

function finalizeOperation(action, before) {
  const after = safeSnapshot();
  const game = currentGame();
  if (!after || !game) return;
  lastStableState = after;

  if (action.type === 'NEW_GAME') {
    if (game.status === 'FINISHED' && session?.user) createGame(after);
    return;
  }

  if (before.gameEnded && !after.gameEnded && game.status === 'FINISHED') {
    queueGameReopen(game, before);
  }

  const endedNow = !before.gameEnded && after.gameEnded;
  const changed = stateKey(before) !== stateKey(after)
    || (action.type === 'COUNT_CHANGE' && !game.countObserved);
  if (changed && !(endedNow && action.type === 'INNING_CHANGE'
      && coreBaseballStateKey(before) === coreBaseballStateKey(after))) {
    recordOperation(action, before, after);
  }
  if (endedNow) queueGameEnd(game, after);
  if (action.type === 'PLATE_RESULT' && changed) pendingPlatePlay = '';
}

function coreBaseballStateKey(state) {
  return JSON.stringify({
    inning: state.inning, half: state.half, outs: state.outs, balls: state.balls,
    strikes: state.strikes, homeScore: state.homeScore, awayScore: state.awayScore,
    runners: state.runners, batter: state.batterSourceId, pitcher: state.pitcherSourceId,
  });
}

function configState() {
  const config = window.TIGERS_SUPABASE_CONFIG || {};
  const url = String(config.url || '').trim();
  const key = String(config.publishableKey || '').trim();
  const secretPrefix = ['sb', 'secret'].join('_') + '_';
  const serviceRole = ['service', 'role'].join('_');
  const unsafe = key.toLowerCase().includes(secretPrefix)
    || /service[_-]?role/i.test(key)
    || decodeJwtRole(key) === serviceRole;
  const validUrl = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url);
  return {
    enabled: config.enabled === true,
    url,
    key,
    safe: !unsafe,
    valid: config.enabled === true && validUrl && key.length > 20 && !unsafe,
  };
}

function decodeJwtRole(key) {
  try {
    const payload = key.split('.')[1];
    if (!payload) return '';
    return JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))).role || '';
  } catch (error) {
    return '';
  }
}

async function initializeSupabase() {
  const config = configState();
  if (!config.safe) {
    setStatus('危険な秘密キーを検出したため接続を停止しました');
    return;
  }
  if (!config.valid || !window.supabase?.createClient) {
    renderPanel();
    return;
  }
  client = window.supabase.createClient(config.url, config.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store', signal: AbortSignal.timeout(10000) }) },
  });
  const { data, error } = await client.auth.getSession();
  if (error) setStatus('ログイン状態を確認できませんでした');
  session = data?.session || null;
  client.auth.onAuthStateChange((_event, nextSession) => {
    if (session?.user?.id !== nextSession?.user?.id) {
      authGeneration++;
      statusMessage = '';
    }
    session = nextSession;
    masters = null;
    renderPanel();
    if (session) setTimeout(() => void syncPending(), 0);
  });
  renderPanel();
  if (session) void syncPending();
}

async function sendMagicLink() {
  if (!client) return;
  const email = document.getElementById('dbLogEmail')?.value.trim();
  if (!email) {
    setStatus('メールアドレスを入力してください');
    return;
  }
  const redirect = `${location.origin}${location.pathname}`;
  const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
  setStatus(error ? `ログインメールを送れませんでした: ${error.message}` : 'ログイン用メールを送信しました');
}

async function signOut() {
  if (!client) return;
  const game = currentGame();
  if (game) {
    game.recording = false;
    game.countObserved = false;
  }
  authGeneration++;
  session = null;
  masters = null;
  statusMessage = '';
  saveStore();
  await client.auth.signOut();
  session = null;
  masters = null;
  renderPanel();
}

async function loadMasters() {
  if (masters) return masters;
  const [teamsResult, venuesResult, playersResult] = await Promise.all([
    client.from('teams').select('team_id,team_code'),
    client.from('venues').select('venue_id,venue_code'),
    client.from('players').select('player_id,source_system,source_player_id'),
  ]);
  const error = teamsResult.error || venuesResult.error || playersResult.error;
  if (error) throw error;
  masters = {
    teams: new Map((teamsResult.data || []).map((row) => [row.team_code, row.team_id])),
    venues: new Map((venuesResult.data || []).map((row) => [row.venue_code, row.venue_id])),
    players: new Map((playersResult.data || [])
      .filter((row) => row.source_system === 'npb_snapshot_2026')
      .map((row) => [row.source_player_id, row.player_id])),
  };
  return masters;
}

function mappedPlayer(sourceId, map) {
  return isPlaceholderPlayer(sourceId) ? null : (map.get(sourceId) || null);
}

async function ensureRemoteGame(game, maps, userId) {
  if (game.remoteGameId) return game.remoteGameId;
  const metadata = game.metadata;
  const homeTeamId = maps.teams.get(metadata.homeTeamCode);
  const awayTeamId = maps.teams.get(metadata.awayTeamCode);
  if (!homeTeamId || !awayTeamId) throw new Error('球団マスタが未設定です。seed.sqlを確認してください');
  const row = {
    user_id: userId,
    client_game_id: game.clientGameId,
    season: metadata.season,
    game_date: metadata.gameDate,
    game_type: metadata.gameType || 'REGULAR',
    series_id: metadata.seriesId || null,
    series_game_number: metadata.seriesGameNumber || null,
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    venue_id: maps.venues.get(metadata.venueCode) || null,
    result: 'IN_PROGRESS',
    capture_level: metadata.captureLevel,
    app_version: APP_VERSION,
    model_version: MODEL_VERSION,
    snapshot_date: '2026-09-04',
    started_at: metadata.startedAt,
  };
  const { data, error } = await client.from('games')
    .upsert(row, { onConflict: 'user_id,client_game_id' })
    .select('game_id')
    .single();
  if (error) throw error;
  game.remoteGameId = data.game_id;
  saveStore();
  return game.remoteGameId;
}

function mapEventForRpc(event, maps) {
  const state = (prefix, source) => ({
    [`inning_${prefix}`]: source.inning,
    [`half_${prefix}`]: source.half,
    [`outs_${prefix}`]: source.outs,
    [`balls_${prefix}`]: source.countObserved ? source.balls : null,
    [`strikes_${prefix}`]: source.countObserved ? source.strikes : null,
    [`home_score_${prefix}`]: source.homeScore,
    [`away_score_${prefix}`]: source.awayScore,
  });
  const runnerFields = {};
  for (const base of [1, 2, 3]) {
    runnerFields[`runner_${base}_before`] = mappedPlayer(event.runnerBefore[base]?.sourceId, maps.players);
    runnerFields[`runner_${base}_after`] = mappedPlayer(event.runnerAfter[base]?.sourceId, maps.players);
    runnerFields[`runner_${base}_instance_before`] = event.runnerBefore[base]?.instanceId || null;
    runnerFields[`runner_${base}_instance_after`] = event.runnerAfter[base]?.instanceId || null;
  }
  return {
    client_event_id: event.clientEventId,
    event_seq: event.eventSeq,
    event_type: event.type,
    ...state('before', event.before),
    ...state('after', event.after),
    ...runnerFields,
    batting_team_id: maps.teams.get(event.before.battingTeam),
    fielding_team_id: maps.teams.get(event.before.fieldingTeam),
    batter_id: mappedPlayer(event.before.batterSourceId, maps.players),
    pitcher_id: mappedPlayer(event.before.pitcherSourceId, maps.players),
    input_mode: event.inputMode,
    related_client_event_id: event.relatedClientEventId,
    event_payload: event.payload,
    created_at: event.createdAt,
  };
}

function mapPlateAppearance(pa, maps) {
  if (!pa) return null;
  return {
    ...pa,
    batter_id: mappedPlayer(pa.batter_source_id, maps.players),
    pitcher_id: mappedPlayer(pa.pitcher_source_id, maps.players),
    batting_team_id: maps.teams.get(pa.batting_team_code),
    fielding_team_id: maps.teams.get(pa.fielding_team_code),
  };
}

function mapRunnerEvents(events, maps) {
  return (events || []).map((event) => ({
    ...event,
    runner_id: mappedPlayer(event.runner_source_id, maps.players),
  }));
}

async function syncPending() {
  if (syncing || !client || !session?.user || !pendingCount()) return;
  const userId = session.user.id;
  const generation = authGeneration;
  const stillOwner = () => session?.user?.id === userId && authGeneration === generation;
  syncing = true;
  renderPanel();
  try {
    const profile = currentProfile();
    if (!profile) return;
    const maps = await loadMasters();
    if (!stillOwner()) return;
    const games = Object.values(profile.games || {}).sort((a, b) => a.metadata.startedAt.localeCompare(b.metadata.startedAt));
    for (const game of games) {
      if (!(game.events || []).some((event) => !event.syncedAt)) continue;
      if (!stillOwner()) return;
      const remoteGameId = await ensureRemoteGame(game, maps, userId);
      while (stillOwner()) {
        const event = game.events.find((item) => !item.syncedAt);
        if (!event) break;
        const params = {
          p_game_id: remoteGameId,
          p_event: mapEventForRpc(event, maps),
          p_plate_appearance: mapPlateAppearance(event.plateAppearance, maps),
          p_runner_events: mapRunnerEvents(event.runnerEvents, maps),
          p_prediction: event.prediction,
        };
        const { error } = await client.rpc('append_game_event', params);
        if (!stillOwner()) return;
        if (error) throw error;
        event.syncedAt = new Date().toISOString();
        saveStore();
      }
    }
    if (stillOwner()) setStatus('DBへの同期が完了しました');
  } catch (error) {
    if (stillOwner()) setStatus(`DBへ接続できません。端末内に保持しています: ${error.message || error}`);
  } finally {
    syncing = false;
    renderPanel();
    if (session?.user && (!stillOwner() || statusMessage === 'DBへの同期が完了しました') && pendingCount()) {
      setTimeout(() => void syncPending(), 0);
    }
  }
}

function createPanel() {
  if (document.getElementById('dbLogPanel')) return;
  const panel = document.createElement('details');
  panel.id = 'dbLogPanel';
  panel.className = 'dbLogPanel';
  panel.innerHTML = `
    <summary><span>試合記録DB</span><span id="dbLogSummaryStatus" class="dbLogSummaryStatus">未接続</span></summary>
    <div class="dbLogBody">
      <div id="dbLogAuth"></div>
      <div id="dbLogControls" class="dbLogControls"></div>
      <p id="dbLogStatus" class="dbLogStatus" aria-live="polite"></p>
      <p class="dbLogNote">試合確率チェッカーはログインなしで利用できます。長期保存だけが認証後に本人の領域へ同期されます。</p>
    </div>`;
  const footer = document.querySelector('footer');
  if (footer) footer.parentNode.insertBefore(panel, footer);
  else document.body.appendChild(panel);
  panel.addEventListener('click', panelClick);
  panel.addEventListener('change', panelChange);
}

function panelClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'dbLogSendLink') void sendMagicLink();
  if (button.id === 'dbLogSignOut') void signOut();
  if (button.id === 'dbLogStart') startOrResumeRecording();
  if (button.id === 'dbLogPause') pauseRecording();
  if (button.id === 'dbLogSync') void syncPending();
}

function panelChange(event) {
  if (!session?.user) return;
  const profile = currentProfile(true);
  const game = currentGame();
  if (game?.status === 'IN_PROGRESS') return;
  if (event.target.id === 'dbLogGameType') {
    profile.logSetup.gameType = normalizeGameType(event.target.value);
  } else if (event.target.id === 'dbLogSeriesGameNumber') {
    profile.logSetup.seriesGameNumber = bounded(event.target.value, 1, 99);
  } else {
    return;
  }
  saveStore();
}

function renderPanel() {
  createPanel();
  const auth = document.getElementById('dbLogAuth');
  const controls = document.getElementById('dbLogControls');
  const summary = document.getElementById('dbLogSummaryStatus');
  const status = document.getElementById('dbLogStatus');
  if (!auth || !controls || !summary || !status) return;
  const config = configState();
  const profile = session?.user ? currentProfile(true) : null;
  const game = currentGame();
  const waiting = pendingCount(profile);

  if (!config.safe) {
    auth.innerHTML = '<strong>接続停止</strong><br>秘密キーはブラウザへ配置できません。';
    controls.innerHTML = '';
    summary.textContent = '安全確認が必要';
  } else if (!config.valid) {
    auth.innerHTML = '<strong>Supabase未設定</strong><br>公開用URLとpublishableキーの設定後に利用できます。';
    controls.innerHTML = '';
    summary.textContent = '未設定';
  } else if (!session?.user) {
    auth.innerHTML = '<label for="dbLogEmail">メールアドレス</label><div class="dbLogLoginRow"><input id="dbLogEmail" type="email" autocomplete="email"><button type="button" id="dbLogSendLink">ログインメール</button></div>';
    controls.innerHTML = '';
    summary.textContent = 'ログイン待ち';
  } else {
    const openGame = game?.status === 'IN_PROGRESS';
    const gameType = openGame ? normalizeGameType(game.metadata.gameType) : normalizeGameType(profile.logSetup?.gameType);
    const seriesGameNumber = openGame
      ? bounded(game.metadata.seriesGameNumber, 1, 99)
      : bounded(profile.logSetup?.seriesGameNumber, 1, 99);
    const selected = (value) => gameType === value ? 'selected' : '';
    const setupDisabled = openGame ? 'disabled' : '';
    const seriesDisabled = openGame || gameType === 'REGULAR' ? 'disabled' : '';
    auth.innerHTML = `<div class="dbLogAccount"><span>${escapeHtml(session.user.email || 'ログイン済み')}</span><button type="button" id="dbLogSignOut">ログアウト</button></div>`;
    controls.innerHTML = `
      <div class="dbLogGameMeta">
        <label for="dbLogGameType">試合区分
          <select id="dbLogGameType" ${setupDisabled}>
            <option value="REGULAR" ${selected('REGULAR')}>レギュラーシーズン</option>
            <option value="CS_FIRST" ${selected('CS_FIRST')}>CS ファースト</option>
            <option value="CS_FINAL" ${selected('CS_FINAL')}>CS ファイナル</option>
            <option value="JAPAN_SERIES" ${selected('JAPAN_SERIES')}>日本シリーズ</option>
          </select>
        </label>
        <label for="dbLogSeriesGameNumber">シリーズ
          <span class="dbLogSeriesNumber">第 <input id="dbLogSeriesGameNumber" type="number" inputmode="numeric" min="1" max="99" value="${seriesGameNumber}" ${seriesDisabled}> 戦</span>
        </label>
      </div>
      <div class="dbLogControlButtons">
        <button type="button" id="dbLogStart" ${game?.recording ? 'disabled' : ''}>${game?.status === 'IN_PROGRESS' ? '記録を再開' : 'この試合を記録'}</button>
        <button type="button" id="dbLogPause" ${!game?.recording ? 'disabled' : ''}>一時停止</button>
        <button type="button" id="dbLogSync" ${syncing || !waiting ? 'disabled' : ''}>今すぐ同期</button>
      </div>`;
    summary.textContent = game?.recording ? `記録中${waiting ? `・待機${waiting}` : ''}` : waiting ? `同期待ち ${waiting}` : '接続済み';
  }
  status.textContent = syncing ? 'DBへ同期しています…' : statusMessage;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

document.addEventListener('click', captureOperation, true);
document.addEventListener('change', captureOperation, true);
window.addEventListener('online', () => void syncPending());
window.addEventListener('storage', (event) => {
  if (event.key !== STORE_KEY) return;
  store = loadStore();
  renderPanel();
});

window.TigersGameLog = Object.freeze({
  version: APP_VERSION,
  getStatus: () => ({
    configured: configState().valid,
    authenticated: Boolean(session?.user),
    recording: Boolean(currentGame()?.recording),
    pendingEvents: pendingCount(),
  }),
  sync: syncPending,
});

createPanel();
renderPanel();
lastStableState = safeSnapshot();
void initializeSupabase().catch(() => setStatus('接続状態を確認できません。試合入力は引き続き利用できます'));
})();
