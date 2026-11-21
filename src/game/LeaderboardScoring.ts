import type { GameId, LeaderboardParams, ParticipantState } from '../types.ts';
import { getDefaultLeaderboardParams } from '../constants.ts';

export interface ParticipantLeaderboardMetrics {
  totalAnswered: number;
  accuracyPct: number;
  avgResponseSec: number;
  speedScore: number;      // 0..100
  progressNorm: number;    // 0..100
  compositeScore: number;  // Dynamic score combining accuracy, speed, progress, streak, penalty
}

export type RankedParticipant = ParticipantState & {
  metrics: ParticipantLeaderboardMetrics;
  effectiveRank: number;
};

export function normalizeLeaderboardParams(
  params: LeaderboardParams | undefined,
  gameId: GameId
): LeaderboardParams {
  const fallback = getDefaultLeaderboardParams(gameId);
  if (!params) return fallback;
  return {
    preset: params.preset ?? fallback.preset,
    sortBy: params.sortBy ?? fallback.sortBy,
    accuracyWeight: clampInt(params.accuracyWeight, 0, 100, fallback.accuracyWeight),
    speedWeight: clampInt(params.speedWeight, 0, 100, fallback.speedWeight),
    progressWeight: clampInt(params.progressWeight, 0, 100, fallback.progressWeight),
    streakBonus: clampInt(params.streakBonus, 0, 50, fallback.streakBonus),
    wrongPenalty: clampInt(params.wrongPenalty, 0, 50, fallback.wrongPenalty),
    fastThresholdSec: clampInt(params.fastThresholdSec, 3, 60, fallback.fastThresholdSec),
  };
}

function clampInt(val: number | undefined, min: number, max: number, def: number): number {
  if (typeof val !== 'number' || Number.isNaN(val)) return def;
  return Math.max(min, Math.min(max, Math.round(val)));
}

export function computeParticipantMetrics(
  p: ParticipantState,
  params: LeaderboardParams,
  gameId: GameId
): ParticipantLeaderboardMetrics {
  const totalAnswered = p.correctCount + p.wrongCount;
  const accuracyPct = totalAnswered > 0 ? Math.round((p.correctCount / totalAnswered) * 100) : 0;

  const log = p.answeredLog ?? [];
  let avgResponseSec = 0;
  let fastCorrectCount = 0;
  if (log.length > 0) {
    const sumSec = log.reduce((acc, item) => acc + (item.responseTimeSec || 0), 0);
    avgResponseSec = Number((sumSec / log.length).toFixed(1));
    fastCorrectCount = log.filter(
      (item) => item.isCorrect && item.responseTimeSec <= params.fastThresholdSec
    ).length;
  }

  // Speed score 0..100: higher when avg response time is fast relative to fastThresholdSec
  let speedScore = 0;
  if (totalAnswered > 0 && avgResponseSec > 0) {
    const ratio = Math.max(0, Math.min(1, 1 - (avgResponseSec - 2) / Math.max(8, params.fastThresholdSec * 2)));
    const fastRatio = fastCorrectCount / totalAnswered;
    speedScore = Math.round(Math.min(100, (ratio * 0.65 + fastRatio * 0.35) * 100));
  }

  // Normalize progress value based on minigame scale
  const progressScale = gameId === 'grand_prix' ? 1200 : gameId === 'board_adventure' ? 30 : 15;
  const progressNorm = Math.round(Math.min(100, ((p.progressValue || 0) / progressScale) * 100));

  // Normalize weights so they always blend meaningfully
  const totalWeight = Math.max(1, params.accuracyWeight + params.speedWeight + params.progressWeight);
  const wAcc = params.accuracyWeight / totalWeight;
  const wSpd = params.speedWeight / totalWeight;
  const wPrg = params.progressWeight / totalWeight;

  // Dynamic composite score:
  // Combines base earned quiz score with teacher-tuned weighting of accuracy, speed, progress, streak, and wrong penalty
  const baseWeightBonus = Math.round(
    (p.correctCount * 100 * wAcc * (accuracyPct / 100)) +
    (p.correctCount * 100 * wSpd * (speedScore / 100)) +
    (progressNorm * 6 * wPrg)
  );
  const streakTotal = (p.maxStreak || 0) * params.streakBonus;
  const penaltyTotal = (p.wrongCount || 0) * params.wrongPenalty;
  const compositeScore = Math.max(0, Math.round(p.score * 0.65 + baseWeightBonus + streakTotal - penaltyTotal));

  return {
    totalAnswered,
    accuracyPct,
    avgResponseSec,
    speedScore,
    progressNorm,
    compositeScore,
  };
}

export function rankParticipants(
  participants: ParticipantState[],
  params: LeaderboardParams,
  gameId: GameId
): RankedParticipant[] {
  const enriched: RankedParticipant[] = participants.map((p) => ({
    ...p,
    metrics: computeParticipantMetrics(p, params, gameId),
    effectiveRank: 1,
  }));

  enriched.sort((a, b) => {
    switch (params.sortBy) {
      case 'score':
        if (b.score !== a.score) return b.score - a.score;
        return b.metrics.compositeScore - a.metrics.compositeScore;
      case 'accuracy':
        if (b.metrics.accuracyPct !== a.metrics.accuracyPct) {
          return b.metrics.accuracyPct - a.metrics.accuracyPct;
        }
        if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
        return b.metrics.compositeScore - a.metrics.compositeScore;
      case 'speed': {
        const aHas = a.metrics.totalAnswered > 0;
        const bHas = b.metrics.totalAnswered > 0;
        if (aHas !== bHas) return aHas ? -1 : 1;
        if (b.metrics.speedScore !== a.metrics.speedScore) {
          return b.metrics.speedScore - a.metrics.speedScore;
        }
        return b.metrics.compositeScore - a.metrics.compositeScore;
      }
      case 'progress':
        if (b.progressValue !== a.progressValue) return b.progressValue - a.progressValue;
        return b.metrics.compositeScore - a.metrics.compositeScore;
      case 'composite':
      default:
        if (b.metrics.compositeScore !== a.metrics.compositeScore) {
          return b.metrics.compositeScore - a.metrics.compositeScore;
        }
        if (b.score !== a.score) return b.score - a.score;
        return b.progressValue - a.progressValue;
    }
  });

  enriched.forEach((p, idx) => {
    p.effectiveRank = idx + 1;
  });

  return enriched;
}

export function describeLeaderboardFormula(params: LeaderboardParams): string {
  const sortLabels: Record<LeaderboardParams['sortBy'], string> = {
    composite: 'Skor Terbobot',
    score: 'Skor Kuis Murni',
    accuracy: 'Ketepatan (%)',
    speed: 'Kecepatan Jawab',
    progress: 'Progres Arena',
  };
  return `${sortLabels[params.sortBy]} · Ketepatan ${params.accuracyWeight}% · Kecepatan ${params.speedWeight}% · Progres ${params.progressWeight}% · Cepat ≤${params.fastThresholdSec}d`;
}
