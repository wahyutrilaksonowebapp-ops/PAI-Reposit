export type GameId =
  | 'puncak_nalar'
  | 'sky_bridge'
  | 'grand_prix'
  | 'lost_scroll'
  | 'edu_craft'
  | 'portal_dimension'
  | 'board_adventure'
  | 'astro_scanner'
  | 'climb_summit';

export type DifficultyLevel = 'mudah' | 'sedang' | 'sulit';
export type QuestionType = 'PG' | 'PGK' | 'BS';
export type BuffType = 'none' | 'double_risk' | 'boost_1_5';

export interface QuestionItem {
  id: string;
  elementId: string;
  difficulty: DifficultyLevel;
  cognitiveLevel: string;
  type: QuestionType;
  prompt: string;
  options: string[];
  correctIndices: number[]; // PG: [idx], PGK: [idx1, idx2, ...], BS: [0] = Benar, [1] = Salah
  explanation: string;
}

export interface MaterialTable {
  headers: string[];
  rows: string[][];
}

export interface MaterialSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  table?: MaterialTable;
  callout?: string;
}

export interface PaiElement {
  id: string;
  name: string;
  shortName: string;
  color: string;
  accentHex: number;
  materialTitle: string;
  subtitle: string;
  sections: MaterialSection[];
  isCustom?: boolean;
}

export interface AvatarConfig {
  preset: 'muslim' | 'muslimah' | 'custom';
  skinColor: string;
  hairStyle:
    | 'short_neat'
    | 'spiky'
    | 'curly'
    | 'peci_hitam'
    | 'peci_putih'
    | 'hijab_syari'
    | 'hijab_sporty'
    | 'topi_sekolah';
  hairColor: string;
  eyeStyle:
    | 'cheerful'
    | 'star'
    | 'round_glasses'
    | 'square_glasses'
    | 'smiling'
    | 'focused';
  noseStyle: 'button' | 'classic' | 'cute' | 'minimal' | 'round';
  mouthStyle: 'wide_smile' | 'gentle' | 'laugh' | 'serious' | 'proud' | 'surprised';
  shirtStyle:
    | 'seragam_sd'
    | 'koko_emas'
    | 'gamis_zamrud'
    | 'batik'
    | 'sport_jacket'
    | 'hoodie'
    | 'pramuka'
    | 'kemeja_langit';
  shirtColor: string;
  pantsStyle: 'celana_pendek' | 'celana_panjang' | 'rok_panjang' | 'jeans';
  pantsColor: string;
  shoeStyle: 'sneakers' | 'sport' | 'racing' | 'sandal_masjid' | 'boots';
  shoeColor: string;
  bagStyle: 'ransel_sd' | 'ransel_petualang' | 'jetpack' | 'tas_islami' | 'selempang' | 'none';
  bagColor: string;
}

export interface AnswerLogEntry {
  questionId: string;
  elementId: string;
  difficulty: DifficultyLevel;
  type: QuestionType;
  isCorrect: boolean;
  pointsDelta: number;
  responseTimeSec: number;
  timestamp: number;
}

export type ParticipantActivity = 'avatar' | 'schoolyard' | 'playing' | 'finished';

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderRole: 'teacher' | 'student';
  senderKelas?: string;
  text: string;
  createdAt: number;
  pinned?: boolean;
  deleted?: boolean;
}

export type LeaderboardPresetId =
  | 'balanced'
  | 'speed_rush'
  | 'accuracy_master'
  | 'progress_climb'
  | 'custom';

export type LeaderboardSortBy = 'composite' | 'score' | 'accuracy' | 'speed' | 'progress';

export interface LeaderboardParams {
  preset: LeaderboardPresetId;
  sortBy: LeaderboardSortBy;
  accuracyWeight: number;   // 0..100
  speedWeight: number;      // 0..100
  progressWeight: number;   // 0..100
  streakBonus: number;      // 0..50 extra bonus per streak milestone
  wrongPenalty: number;     // 0..50 penalty points on wrong answer
  fastThresholdSec: number; // 3..60 seconds threshold for max speed bonus
}

export type TeacherAlertKind =
  | 'off_mission_tab_switch'
  | 'off_mission_wrong_screen'
  | 'off_mission_idle'
  | 'chat_moderation_blocked'
  | 'chat_moderation_caps'
  | 'chat_moderation_spam';

export interface TeacherAlert {
  id: string;
  roomCode: string;
  kind: TeacherAlertKind;
  severity: 'warning' | 'danger';
  participantId: string;
  participantName: string;
  participantKelas?: string;
  detail: string;
  chatText?: string;
  createdAt: number;
}

export interface ParticipantState {
  id: string;
  nama: string;
  kelas: string;
  sekolah: string;
  avatar: AvatarConfig;
  score: number;
  rank: number;
  level: DifficultyLevel;
  streak: number;
  maxStreak: number;
  wrongStreak: number;
  correctCount: number;
  wrongCount: number;
  activeBuff: BuffType;
  progressValue: number; // Tier / Bridge / Gate / Buildings / Stars / Tile / Artifacts / Basecamp
  progressLabel: string;
  pos: { x: number; y: number; z: number };
  rotY: number;
  activity: ParticipantActivity;
  isReady: boolean;
  approvedForMission: boolean;
  connected: boolean;
  finishedReflection: boolean;
  answeredLog: AnswerLogEntry[];
  joinedAt: number;
  lastSeenAt?: number;
  typingAt?: number;
}

export interface MissionConfig {
  active: boolean;
  status: 'lobby' | 'playing' | 'finished';
  elementIds: string[];
  gameId: GameId;
  questionDurationSec: number;
  gameDurationMin: number;
  startedAt: number | null;
  endsAt: number | null;
  leaderboardParams?: LeaderboardParams;
}

export interface TestimonialItem {
  id: string;
  nama: string;
  kelas: string;
  sekolah: string;
  refleksi: string;
  komentar: string;
  kritikSaran: string;
  gameName: string;
  skor: number;
  createdAt: number;
}

export interface MinigameMeta {
  id: GameId;
  number: number;
  name: string;
  subtitle: string;
  badge: string;
  accent: string;
  leaderboardMetric: string;
  leaderboardUnit: string;
  description: string;
  controlsHint: string;
}

export interface RoomSnapshot {
  roomCode: string;
  mission: MissionConfig;
  participants: ParticipantState[];
  testimonials: TestimonialItem[];
  customElements: PaiElement[];
  customQuestions: QuestionItem[];
  chatMessages: ChatMessage[];
  chatMutedAll: boolean;
  mutedParticipantIds: string[];
  teacherAlerts?: TeacherAlert[];
  serverTime: number;
}
