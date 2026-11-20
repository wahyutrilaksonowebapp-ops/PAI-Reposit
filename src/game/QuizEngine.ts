import type {
  AnswerLogEntry,
  BuffType,
  DifficultyLevel,
  GameId,
  QuestionItem,
  QuestionType,
} from '../types.ts';
import { paiBank } from '../data/paiBank.ts';

export interface EvaluationResult {
  isCorrect: boolean;
  pointsDelta: number;
  newScore: number;
  newLevel: DifficultyLevel;
  levelChanged: 'up' | 'down' | 'same';
  streak: number;
  triggeredBuffChoice: boolean;
  explanation: string;
  answerEntry: AnswerLogEntry;
}

export interface SerializedQuizState {
  score: number;
  level: DifficultyLevel;
  streak: number;
  maxStreak: number;
  levelCorrectStreak: number;
  wrongStreak: number;
  correctCount: number;
  wrongCount: number;
  activeBuff: BuffType;
  progressValue: number;
  progressLabel: string;
  questionDurationSec: number;
  questionElapsedSec: number;
  elementIds: string[];
  gameId: GameId;
  askedIds: string[];
  currentQuestionId: string | null;
  summitPacketIndex: number;
  summitBasecamp: number;
  summitPacketPassed: number;
  portalDimensionLevel: DifficultyLevel;
  portalStars: Record<DifficultyLevel, number>;
}

export class QuizEngine {
  public score = 0;
  public level: DifficultyLevel = 'sedang';
  public streak = 0;
  public maxStreak = 0;
  public levelCorrectStreak = 0;
  public wrongStreak = 0;
  public correctCount = 0;
  public wrongCount = 0;
  public activeBuff: BuffType = 'none';
  public progressValue = 0;
  public progressLabel = 'Tingkat';

  public currentQuestion: QuestionItem | null = null;
  public questionDurationSec = 25;
  public questionStartedAt = 0;
  public elementIds: string[] = ['quran_hadis', 'akidah', 'akhlak', 'fiqih', 'spi'];
  public gameId: GameId = 'puncak_nalar';

  private askedIds = new Set<string>();
  private summitPacketIndex = 0; // 0: PG, 1: PGK, 2: BS
  public summitBasecamp = 0;
  public summitPacketPassed = 0;
  public portalDimensionLevel: DifficultyLevel = 'mudah';
  public portalStars: Record<DifficultyLevel, number> = { mudah: 0, sedang: 0, sulit: 0 };

  reset(params: {
    gameId: GameId;
    elementIds: string[];
    questionDurationSec: number;
  }): void {
    this.gameId = params.gameId;
    this.elementIds = params.elementIds.length > 0 ? [...params.elementIds] : ['quran_hadis'];
    this.questionDurationSec = Math.max(10, params.questionDurationSec);

    this.score = 0;
    this.level = params.gameId === 'portal_dimension' ? 'mudah' : 'sedang';
    this.streak = 0;
    this.maxStreak = 0;
    this.levelCorrectStreak = 0;
    this.wrongStreak = 0;
    this.correctCount = 0;
    this.wrongCount = 0;
    this.activeBuff = 'none';
    this.progressValue = 0;
    this.askedIds.clear();
    this.summitPacketIndex = 0;
    this.summitBasecamp = 0;
    this.summitPacketPassed = 0;
    this.portalDimensionLevel = 'mudah';
    this.portalStars = { mudah: 0, sedang: 0, sulit: 0 };
    this.progressLabel = this.getMetricLabel(params.gameId);
    this.currentQuestion = null;
  }

  getMetricLabel(gameId: GameId): string {
    switch (gameId) {
      case 'puncak_nalar':
        return 'Tingkat';
      case 'sky_bridge':
        return 'Segmen';
      case 'grand_prix':
        return 'Meter';
      case 'lost_scroll':
        return 'Gerbang';
      case 'edu_craft':
        return 'Karya';
      case 'portal_dimension':
        return 'Bintang';
      case 'board_adventure':
        return 'Petak';
      case 'astro_scanner':
        return 'Artefak';
      case 'climb_summit':
        return 'Basecamp';
    }
  }

  setPortalDimension(diff: DifficultyLevel): void {
    this.portalDimensionLevel = diff;
    this.level = diff;
  }

  nextQuestion(preferredType?: QuestionType): QuestionItem {
    let typeToPick = preferredType;
    if (this.gameId === 'climb_summit' && !typeToPick) {
      const order: QuestionType[] = ['PG', 'PGK', 'BS'];
      typeToPick = order[this.summitPacketIndex % 3];
    }
    const difficultyToUse =
      this.gameId === 'portal_dimension' ? this.portalDimensionLevel : this.level;

    if (this.askedIds.size > 110) {
      this.askedIds.clear();
    }

    const q = paiBank.pickQuestion({
      elementIds: this.elementIds,
      difficulty: difficultyToUse,
      preferredType: typeToPick,
      excludeIds: this.askedIds,
    });
    this.askedIds.add(q.id);
    this.currentQuestion = q;
    this.questionStartedAt = performance.now();
    return q;
  }

  getRemainingSeconds(): number {
    if (!this.currentQuestion) return this.questionDurationSec;
    const elapsed = (performance.now() - this.questionStartedAt) / 1000;
    return Math.max(0, this.questionDurationSec - elapsed);
  }

  applyBuff(buff: BuffType): void {
    this.activeBuff = buff;
  }

  receiveSabotage(amount: number): void {
    this.score = Math.max(0, this.score - amount);
  }

  evaluate(selectedIndices: number[], timedOut = false): EvaluationResult {
    const q = this.currentQuestion;
    if (!q) {
      throw new Error('No active question to evaluate');
    }

    const elapsedSec = Math.min(
      this.questionDurationSec,
      Math.max(0.4, (performance.now() - this.questionStartedAt) / 1000)
    );
    const remainingRatio = Math.max(0, (this.questionDurationSec - elapsedSec) / this.questionDurationSec);

    let isCorrect = false;
    if (!timedOut) {
      const sortedSel = [...new Set(selectedIndices)].sort((a, b) => a - b);
      const sortedKey = [...q.correctIndices].sort((a, b) => a - b);
      isCorrect =
        sortedSel.length === sortedKey.length &&
        sortedSel.every((v, idx) => v === sortedKey[idx]);
    }

    let pointsDelta = 0;
    const prevLevel = this.level;
    let levelChanged: 'up' | 'down' | 'same' = 'same';
    let triggeredBuffChoice = false;

    if (isCorrect) {
      // Speed-based base score: 45 to 100 points
      const basePoints = Math.round(45 + 55 * remainingRatio);
      if (this.activeBuff === 'double_risk') {
        pointsDelta = basePoints * 2;
      } else if (this.activeBuff === 'boost_1_5') {
        pointsDelta = Math.round(basePoints * 1.5);
      } else {
        pointsDelta = basePoints;
      }

      // Bonus for Sulit or PGK
      if (q.difficulty === 'sulit') pointsDelta += 15;
      if (q.type === 'PGK') pointsDelta += 10;

      this.score += pointsDelta;
      this.correctCount += 1;
      this.streak += 1;
      this.maxStreak = Math.max(this.maxStreak, this.streak);
      this.wrongStreak = 0;
      this.levelCorrectStreak += 1;

      // Exact AKM Adaptive Difficulty Rules:
      // 2x benar beruntun di mudah -> sedang
      // 3x benar beruntun di sedang -> sulit
      if (this.gameId !== 'portal_dimension') {
        if (this.level === 'mudah' && this.levelCorrectStreak >= 2) {
          this.level = 'sedang';
          this.levelCorrectStreak = 0;
          levelChanged = 'up';
        } else if (this.level === 'sedang' && this.levelCorrectStreak >= 3) {
          this.level = 'sulit';
          this.levelCorrectStreak = 0;
          levelChanged = 'up';
        }
      }

      // 10x benar beruntun -> Buff pilihan!
      if (this.streak > 0 && this.streak % 10 === 0) {
        triggeredBuffChoice = true;
      }

      this.advanceProgressOnCorrect(q);
    } else {
      // Wrong answer rules
      if (this.activeBuff === 'double_risk') {
        pointsDelta = -100;
      } else if (this.activeBuff === 'boost_1_5') {
        pointsDelta = -50;
      } else if (this.gameId === 'puncak_nalar') {
        pointsDelta = -10;
      } else {
        pointsDelta = 0;
      }

      this.score = Math.max(0, this.score + pointsDelta);
      this.wrongCount += 1;
      this.streak = 0;
      this.levelCorrectStreak = 0;
      this.wrongStreak += 1;

      // Exact AKM Adaptive Difficulty Down Rules:
      // 2x salah berturut-turut di awal/umum -> mudah
      // 3x salah di sedang -> mudah; 3x salah di sulit -> sedang
      if (this.gameId !== 'portal_dimension') {
        if (this.level === 'sulit' && this.wrongStreak >= 3) {
          this.level = 'sedang';
          this.wrongStreak = 0;
          levelChanged = 'down';
        } else if (this.level === 'sedang' && this.wrongStreak >= 2) {
          this.level = 'mudah';
          this.wrongStreak = 0;
          levelChanged = 'down';
        }
      }

      this.handleProgressOnWrong();
    }

    if (prevLevel !== this.level && levelChanged === 'same') {
      levelChanged = 'down';
    }

    const answerEntry: AnswerLogEntry = {
      questionId: q.id,
      elementId: q.elementId,
      difficulty: q.difficulty,
      type: q.type,
      isCorrect,
      pointsDelta,
      responseTimeSec: Number(elapsedSec.toFixed(1)),
      timestamp: Date.now(),
    };

    return {
      isCorrect,
      pointsDelta,
      newScore: this.score,
      newLevel: this.level,
      levelChanged,
      streak: this.streak,
      triggeredBuffChoice,
      explanation: q.explanation,
      answerEntry,
    };
  }

  private advanceProgressOnCorrect(q: QuestionItem): void {
    switch (this.gameId) {
      case 'puncak_nalar':
        this.progressValue += 1;
        break;
      case 'sky_bridge':
        this.progressValue += q.type === 'PGK' ? 2 : 1;
        break;
      case 'grand_prix':
        this.progressValue += q.type === 'PGK' ? 160 : 120;
        break;
      case 'lost_scroll':
        this.progressValue += q.type === 'PGK' ? 2 : 1;
        break;
      case 'edu_craft':
        this.progressValue += 1;
        break;
      case 'portal_dimension':
        this.portalStars[this.portalDimensionLevel] = Math.min(
          5,
          this.portalStars[this.portalDimensionLevel] + 1
        );
        this.progressValue =
          this.portalStars.mudah + this.portalStars.sedang + this.portalStars.sulit;
        break;
      case 'board_adventure':
        this.progressValue += q.type === 'PGK' ? 3 : 2;
        break;
      case 'astro_scanner':
        this.progressValue += 1;
        break;
      case 'climb_summit':
        this.summitPacketPassed += 1;
        this.summitPacketIndex = (this.summitPacketIndex + 1) % 3;
        if (this.summitPacketPassed >= 3) {
          this.summitBasecamp += 1;
          this.summitPacketPassed = 0;
          this.progressValue = this.summitBasecamp;
        }
        break;
    }
  }

  private handleProgressOnWrong(): void {
    switch (this.gameId) {
      case 'puncak_nalar':
        this.progressValue = Math.max(0, this.progressValue - 1);
        break;
      case 'climb_summit':
        // Safe at current basecamp, retry the packet from question 1
        this.summitPacketPassed = 0;
        this.summitPacketIndex = 0;
        break;
      default:
        break;
    }
  }

  getSummitPacketStatus(): { basecamp: number; step: number; nextType: QuestionType } {
    const order: QuestionType[] = ['PG', 'PGK', 'BS'];
    return {
      basecamp: this.summitBasecamp,
      step: this.summitPacketPassed,
      nextType: order[this.summitPacketIndex % 3],
    };
  }

  exportState(): SerializedQuizState {
    const elapsedSec = this.currentQuestion
      ? Math.max(0, (performance.now() - this.questionStartedAt) / 1000)
      : 0;
    return {
      score: this.score,
      level: this.level,
      streak: this.streak,
      maxStreak: this.maxStreak,
      levelCorrectStreak: this.levelCorrectStreak,
      wrongStreak: this.wrongStreak,
      correctCount: this.correctCount,
      wrongCount: this.wrongCount,
      activeBuff: this.activeBuff,
      progressValue: this.progressValue,
      progressLabel: this.progressLabel,
      questionDurationSec: this.questionDurationSec,
      questionElapsedSec: Number(elapsedSec.toFixed(2)),
      elementIds: [...this.elementIds],
      gameId: this.gameId,
      askedIds: Array.from(this.askedIds),
      currentQuestionId: this.currentQuestion?.id ?? null,
      summitPacketIndex: this.summitPacketIndex,
      summitBasecamp: this.summitBasecamp,
      summitPacketPassed: this.summitPacketPassed,
      portalDimensionLevel: this.portalDimensionLevel,
      portalStars: { ...this.portalStars },
    };
  }

  restoreState(saved: SerializedQuizState): QuestionItem | null {
    this.score = Math.max(0, saved.score || 0);
    this.level = saved.level || 'sedang';
    this.streak = saved.streak || 0;
    this.maxStreak = saved.maxStreak || 0;
    this.levelCorrectStreak = saved.levelCorrectStreak || 0;
    this.wrongStreak = saved.wrongStreak || 0;
    this.correctCount = saved.correctCount || 0;
    this.wrongCount = saved.wrongCount || 0;
    this.activeBuff = saved.activeBuff || 'none';
    this.progressValue = saved.progressValue || 0;
    this.progressLabel = saved.progressLabel || this.getMetricLabel(saved.gameId);
    this.questionDurationSec = Math.max(10, saved.questionDurationSec || 25);
    this.elementIds = saved.elementIds?.length ? [...saved.elementIds] : ['quran_hadis'];
    this.gameId = saved.gameId || 'puncak_nalar';
    this.askedIds = new Set(saved.askedIds || []);
    this.summitPacketIndex = saved.summitPacketIndex || 0;
    this.summitBasecamp = saved.summitBasecamp || 0;
    this.summitPacketPassed = saved.summitPacketPassed || 0;
    this.portalDimensionLevel = saved.portalDimensionLevel || 'mudah';
    this.portalStars = saved.portalStars
      ? { ...saved.portalStars }
      : { mudah: 0, sedang: 0, sulit: 0 };

    if (saved.currentQuestionId) {
      const found = paiBank.getAllQuestions().find((q) => q.id === saved.currentQuestionId) ?? null;
      this.currentQuestion = found;
      if (found) {
        // Give the student at least 6 seconds remaining after a page refresh so reload never causes an unfair timeout
        const cappedElapsed = Math.max(
          0,
          Math.min(this.questionDurationSec - 6, saved.questionElapsedSec || 0)
        );
        this.questionStartedAt = performance.now() - cappedElapsed * 1000;
        return found;
      }
    }
    this.currentQuestion = null;
    return null;
  }
}
