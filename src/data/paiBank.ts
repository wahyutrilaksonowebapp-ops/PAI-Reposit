import type { DifficultyLevel, PaiElement, QuestionItem, QuestionType } from '../types.ts';
import { CORE_PAI_ELEMENTS } from './materials.ts';
import { QUESTIONS_QURAN } from './questions_quran.ts';
import { QUESTIONS_AKIDAH } from './questions_akidah.ts';
import { QUESTIONS_AKHLAK } from './questions_akhlak.ts';
import { QUESTIONS_FIQIH } from './questions_fiqih.ts';
import { QUESTIONS_SPI } from './questions_spi.ts';

export const CORE_QUESTIONS: QuestionItem[] = [
  ...QUESTIONS_QURAN,
  ...QUESTIONS_AKIDAH,
  ...QUESTIONS_AKHLAK,
  ...QUESTIONS_FIQIH,
  ...QUESTIONS_SPI,
];

export class PaiBank {
  private customElements: PaiElement[] = [];
  private customQuestions: QuestionItem[] = [];

  setCustomContent(elements: PaiElement[], questions: QuestionItem[]): void {
    this.customElements = [...elements];
    this.customQuestions = [...questions];
  }

  getAllElements(): PaiElement[] {
    return [...CORE_PAI_ELEMENTS, ...this.customElements];
  }

  getElementById(id: string): PaiElement | undefined {
    return this.getAllElements().find((el) => el.id === id);
  }

  getAllQuestions(): QuestionItem[] {
    return [...CORE_QUESTIONS, ...this.customQuestions];
  }

  getQuestionsForElements(elementIds: string[]): QuestionItem[] {
    const activeSet = new Set(elementIds.length > 0 ? elementIds : CORE_PAI_ELEMENTS.map((e) => e.id));
    return this.getAllQuestions().filter((q) => activeSet.has(q.elementId));
  }

  getQuestionById(id: string): QuestionItem | undefined {
    return this.getAllQuestions().find((q) => q.id === id);
  }

  countQuestionsByElement(elementId: string): number {
    return this.getAllQuestions().filter((q) => q.elementId === elementId).length;
  }

  pickQuestion(params: {
    elementIds: string[];
    difficulty: DifficultyLevel;
    preferredType?: QuestionType;
    excludeIds?: Set<string>;
  }): QuestionItem {
    const pool = this.getQuestionsForElements(params.elementIds);
    const exclude = params.excludeIds ?? new Set<string>();

    const filterBy = (diff?: DifficultyLevel, type?: QuestionType, respectExclude = true) =>
      pool.filter((q) => {
        if (diff && q.difficulty !== diff) return false;
        if (type && q.type !== type) return false;
        if (respectExclude && exclude.has(q.id)) return false;
        return true;
      });

    let candidates = filterBy(params.difficulty, params.preferredType, true);
    if (candidates.length === 0 && params.preferredType) {
      candidates = filterBy(params.difficulty, undefined, true);
    }
    if (candidates.length === 0) {
      candidates = filterBy(params.difficulty, params.preferredType, false);
    }
    if (candidates.length === 0) {
      candidates = filterBy(undefined, params.preferredType, false);
    }
    if (candidates.length === 0) {
      candidates = pool.length > 0 ? pool : CORE_QUESTIONS;
    }

    const idx = Math.floor(Math.random() * candidates.length);
    return candidates[idx];
  }
}

export const paiBank = new PaiBank();
