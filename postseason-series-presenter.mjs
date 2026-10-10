// Presentation only: the audited adapter owns replay, verification and calculation.
import {validateSeriesRecord} from './cs-series-adapter.mjs';
import {isCurrentSeriesResult} from './cs-series-coordinator.mjs';

export const SERIES_TEAM_NAMES = Object.freeze({T: '阪神', G: '巨人', DB: 'DeNA', C: '広島', D: '中日', S: 'ヤクルト'});
const teamName = (id, names, fallback) => id === null ? fallback : names[id] || SERIES_TEAM_NAMES[id] || fallback;

function presentNextGame(next, series, names) {
  const c = series.context, s = series.state;
  if (!next || !s || series.decision.finished || next.series_id !== c.series_id || next.series_revision !== series.series_revision ||
      next.physical_game_number !== s.physicalGamesPlayed + 1 || next.homeTeamId !== c.higherTeamId || next.awayTeamId !== c.lowerTeamId ||
      !['SCHEDULED', 'POSTPONED', 'CANCELED'].includes(next.status)) return null;
  let date = '日時未定';
  if (next.scheduled_at != null) {
    if (typeof next.scheduled_at !== 'string' || !Number.isFinite(Date.parse(next.scheduled_at))) return null;
    date = new Intl.DateTimeFormat('ja-JP', {timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}).format(new Date(next.scheduled_at));
  }
  if (next.venue != null && typeof next.venue !== 'string') return null;
  return Object.freeze({heading: `第${next.physical_game_number}戦`, date, venue: next.venue || '球場未定',
    matchup: `${teamName(next.homeTeamId, names, '上位球団')}（ホーム） vs ${teamName(next.awayTeamId, names, '下位球団')}`,
    status: {SCHEDULED: '開催予定', POSTPONED: '順延・日時再確認', CANCELED: '中止・次戦未定'}[next.status]});
}

export function presentSeries({series, snapshot = null, result = null, calculation_token = null, purpose = 'PRODUCTION', teamNames = {}, nextGame = null, pending = false}) {
  if (!['PRODUCTION', 'TEST'].includes(purpose)) throw new Error('Explicit UI purpose required');
  const r = validateSeriesRecord(series);
  if (r.purpose !== purpose) throw new Error('Series/UI purpose mismatch');
  const c = r.context, s = r.state, rules = r.rules;
  const higher = teamName(c.higherTeamId, teamNames, '上位球団未確定'), lower = teamName(c.lowerTeamId, teamNames, '下位球団未確定');
  const status = c.status === 'UNCONFIRMED' ? 'UNCONFIRMED' : r.decision.finished ? 'COMPLETED' : s.physicalGamesPlayed > 0 ? 'IN_PROGRESS' : 'READY';
  const winner = status === 'COMPLETED' ? (r.decision.winner === 'HIGHER_SEED' ? higher : lower) : null;
  const ready = status !== 'UNCONFIRMED' && !pending &&
    (purpose === 'TEST' || snapshot?.source_kind === 'OFFICIAL_REGULAR_FINAL' && snapshot.prior_id !== null) &&
    isCurrentSeriesResult(result, {series: r, snapshot, calculation_token});
  let probability = null;
  if (ready) {
    // Display complementary tenths so rounding cannot make the displayed sum 99.9/100.1.
    const upperTenths = Math.round(result.upperAdvanceProbability * 1000);
    probability = Object.freeze({upper: (upperTenths / 10).toFixed(1) + '%', lower: ((1000 - upperTenths) / 10).toFixed(1) + '%',
      expectedRemaining: result.expectedRemainingPhysicalGames.toFixed(2) + '試合'});
  }
  return Object.freeze({purpose, test: purpose === 'TEST', stage: c.stage, title: c.stage === 'FIRST' ? 'CS First Stage' : 'CS Final Stage',
    subtitle: `${c.season} クライマックスシリーズ`, status,
    statusLabel: {UNCONFIRMED: '対戦相手未確定', READY: '開幕前', IN_PROGRESS: 'シリーズ進行中', COMPLETED: 'シリーズ終了'}[status],
    matchup: c.status === 'UNCONFIRMED' ? '対戦相手未確定' : `${higher} vs ${lower}`, higher, lower, winner,
    actualHigher: s ? `${s.higherActualWins}勝 ${s.lowerActualWins}敗` : '未確定',
    actualLower: s ? `${s.lowerActualWins}勝 ${s.higherActualWins}敗` : '未確定', ties: s ? `${s.ties}分` : '未確定',
    advantage: rules ? `${higher} +${rules.advantageWins}勝` : '未確定',
    effectiveHigher: s ? `計算上：${s.higherActualWins + rules.advantageWins}勝相当` : '',
    played: s ? `${s.physicalGamesPlayed}試合` : '未確定', maximum: rules ? `${rules.maxPhysicalGames}試合` : '未確定',
    winsNeeded: rules ? `${rules.winsNeeded}勝（アドバンテージ込み）` : '未確定',
    probability, probabilityLabel: ready ? (purpose === 'TEST' ? '突破確率（TEST）' : '突破確率') : pending ? '再計算中' : snapshot ? '未計算' : '確率計算準備中',
    probabilityNote: ready ? '' : status === 'UNCONFIRMED' ? '対戦カード確定後に計算します。' : snapshot ? '最新のシリーズ状況で再計算します。' : 'レギュラーシーズン最終データ確定後に計算します。',
    nextGame: presentNextGame(nextGame, r, teamNames)});
}
