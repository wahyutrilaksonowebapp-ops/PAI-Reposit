import type { AvatarConfig, DifficultyLevel, GameId } from '../types.ts';
import type { SerializedQuizState } from '../game/QuizEngine.ts';

export type PersistedStudentScreen = 'avatar' | 'schoolyard' | 'playing';
export type PersistedTeacherTab = 'misi' | 'leaderboard' | 'materi' | 'soal' | 'laporan';

export interface SavedTeacherSession {
  role: 'teacher';
  code: string;
  roomCode: string;
  sekolah: string;
  activeTab: PersistedTeacherTab;
  savedAt: number;
}

export interface SavedStudentSession {
  role: 'student';
  studentId: string;
  roomCode: string;
  nama: string;
  kelas: string;
  sekolah: string;
  avatar: AvatarConfig;
  screen: PersistedStudentScreen;
  isReady: boolean;
  pos?: { x: number; y: number; z: number };
  rotY?: number;
  missionStartedAt?: number | null;
  missionGameId?: GameId;
  approvedForMission?: boolean;
  quizState?: SerializedQuizState | null;
  waitingForDiceRoll?: boolean;
  lastDiceNumber?: number;
  showReflectionModal?: boolean;
  reflectionSubmitted?: boolean;
  portalDimensionLevel?: DifficultyLevel;
  savedAt: number;
}

export type SavedSession = SavedTeacherSession | SavedStudentSession;

const SESSION_KEY = 'pai_nusantara_session_v2';

export function saveSession(session: SavedSession): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Ignore storage quota or sandbox restrictions
  }
}

export function loadSession(): SavedSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSession;
    if (!parsed || (parsed.role !== 'teacher' && parsed.role !== 'student')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore storage errors
  }
}
