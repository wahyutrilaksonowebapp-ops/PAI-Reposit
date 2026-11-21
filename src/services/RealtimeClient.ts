import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  BLOCKED_CHAT_WORDS,
  getDefaultLeaderboardParams,
  getMinigameMeta,
  TEACHER_ADMIN_CODE,
} from '../constants.ts';
import { normalizeLeaderboardParams, rankParticipants } from '../game/LeaderboardScoring.ts';
import type {
  AnswerLogEntry,
  AvatarConfig,
  BuffType,
  ChatMessage,
  DifficultyLevel,
  GameId,
  LeaderboardParams,
  MissionConfig,
  PaiElement,
  ParticipantActivity,
  ParticipantState,
  QuestionItem,
  RoomSnapshot,
  TeacherAlert,
  TeacherAlertKind,
  TestimonialItem,
} from '../types.ts';
import { db, logFirestoreError, OperationType } from './firebase.ts';

export type RealtimeEventMap = {
  snapshot: RoomSnapshot;
  joined: { id: string; snapshot: RoomSnapshot };
  joinError: string;
  studentLoggedIn: { participant: ParticipantState; isNew: boolean; snapshot: RoomSnapshot };
  teacherAuth: {
    ok: boolean;
    sekolah?: string;
    roomCode?: string;
    error?: string;
    snapshot?: RoomSnapshot;
  };
  missionStarted: RoomSnapshot;
  missionEnded: { reason: string; snapshot: RoomSnapshot };
  studentApproved: { participantId: string; snapshot: RoomSnapshot };
  playerMoved: { id: string; pos: { x: number; y: number; z: number }; rotY: number };
  buffAttacked: {
    attackerName: string;
    targetId: string;
    targetName: string;
    amount: number;
    snapshot: RoomSnapshot;
  };
  chatMessage: { message: ChatMessage; snapshot: RoomSnapshot };
  chatTyping: { senderId: string; senderName: string; role: 'teacher' | 'student' };
  chatRejected: string;
  teacherAlert: { alert: TeacherAlert; snapshot: RoomSnapshot };
  reflectionSaved: TestimonialItem;
  connectionChange: boolean;
};

type Listener<K extends keyof RealtimeEventMap> = (payload: RealtimeEventMap[K]) => void;

const ONLINE_STALE_MS = 50_000;
const HEARTBEAT_INTERVAL_MS = 12_000;
const PRESENCE_SWEEP_MS = 15_000;
const DEFAULT_ROOM_CODE = 'PAI2026';
const DEFAULT_SEKOLAH = 'SDN Kedungringin I Beji';

interface FirestoreRoomDoc {
  roomCode: string;
  sekolah?: string;
  mission: MissionConfig;
  chatMutedAll: boolean;
  mutedParticipantIds: string[];
  teacherUid?: string;
  updatedAt: number;
}

interface FirestoreParticipantDoc extends ParticipantState {
  roomCode: string;
  lastSeenAt: number;
  typingAt?: number;
  lastSabotagedBy?: string;
  lastSabotageAmount?: number;
  lastSabotageAt?: number;
}

interface FirestoreChatDoc extends ChatMessage {
  roomCode: string;
}

function normalizeRoomCode(raw?: string): string {
  const cleaned = (raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 12);
  return cleaned.length >= 3 ? cleaned : DEFAULT_ROOM_CODE;
}

function safeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function clampStr(val: unknown, maxLen: number, fallback = ''): string {
  const s = typeof val === 'string' ? val.trim() : fallback;
  return s.slice(0, maxLen);
}

function defaultMission(gameId: GameId = 'puncak_nalar'): MissionConfig {
  return {
    active: false,
    status: 'lobby',
    elementIds: ['quran_hadis', 'akidah', 'akhlak', 'fiqih', 'spi'],
    gameId,
    questionDurationSec: 25,
    gameDurationMin: 10,
    startedAt: null,
    endsAt: null,
    leaderboardParams: getDefaultLeaderboardParams(gameId),
  };
}

function defaultRoomDoc(roomCode: string, sekolah = DEFAULT_SEKOLAH): FirestoreRoomDoc {
  return {
    roomCode,
    sekolah: clampStr(sekolah, 120, DEFAULT_SEKOLAH),
    mission: defaultMission('puncak_nalar'),
    chatMutedAll: false,
    mutedParticipantIds: [],
    updatedAt: Date.now(),
  };
}

function containsBlockedWord(text: string): string | null {
  const lower = text.toLowerCase();
  const normalized = lower
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/[^a-z0-9\s]/g, ' ');
  const tokens = normalized.split(/\s+/).filter(Boolean);
  for (const bad of BLOCKED_CHAT_WORDS) {
    if (tokens.includes(bad)) return bad;
    if (bad.length >= 5 && normalized.includes(bad)) return bad;
  }
  return null;
}

function isExcessiveCaps(text: string): boolean {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 12) return false;
  const uppers = letters.replace(/[^A-Z]/g, '').length;
  return uppers / letters.length >= 0.78;
}

export class RealtimeClient {
  private listeners = new Map<keyof RealtimeEventMap, Set<Listener<never>>>();
  private roomUnsubs: Unsubscribe[] = [];
  private globalUnsubs: Unsubscribe[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private presenceSweepTimer: ReturnType<typeof setInterval> | null = null;
  private missionTimer: ReturnType<typeof setTimeout> | null = null;
  private moveThrottleAt = 0;
  private typingThrottleAt = 0;
  private recentChatTimestamps = new Map<string, number[]>();
  private alertThrottleMap = new Map<string, number>();

  private activeRoomCode = DEFAULT_ROOM_CODE;
  private activeSekolah = DEFAULT_SEKOLAH;
  private activeStudentId: string | null = null;
  private isTeacherSession = false;

  // Live reactive caches hydrated by Firestore onSnapshot
  private roomDoc: FirestoreRoomDoc = defaultRoomDoc(DEFAULT_ROOM_CODE);
  private participantsMap = new Map<string, FirestoreParticipantDoc>();
  private messagesMap = new Map<string, FirestoreChatDoc>();
  private alertsMap = new Map<string, TeacherAlert>();
  private testimonialsList: TestimonialItem[] = [];
  private customElementsList: PaiElement[] = [];
  private customQuestionsList: QuestionItem[] = [];

  // Deduplication sets so we only fire one-shot UI notifications for genuinely new events
  private seenChatIds = new Set<string>();
  private seenAlertIds = new Set<string>();
  private seenOnlineIds = new Set<string>();
  private seenApprovedIds = new Set<string>();
  private seenSabotageTs = new Map<string, number>();
  private seenTypingTs = new Map<string, number>();
  private lastMissionStartedAt: number | null = null;
  private lastMissionStatus: MissionConfig['status'] = 'lobby';
  private roomHydrated = false;
  private alertsHydrated = false;
  private messagesHydrated = false;
  private participantsHydrated = false;
  private unloadBound = false;

  public connected = false;
  public snapshot: RoomSnapshot | null = null;

  get transportLabel(): string {
    return this.connected ? 'Cloud Firestore' : 'Menyambung';
  }

  get currentRoomCode(): string {
    return this.activeRoomCode;
  }

  on<K extends keyof RealtimeEventMap>(event: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<never>);
    return () => set?.delete(fn as Listener<never>);
  }

  private emit<K extends keyof RealtimeEventMap>(event: K, payload: RealtimeEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as Listener<K>)(payload);
      } catch (err) {
        console.error(`RealtimeClient listener error (${String(event)}):`, err);
      }
    }
  }

  private setConnected(next: boolean): void {
    if (this.connected !== next) {
      this.connected = next;
      this.emit('connectionChange', next);
    }
  }

  private buildSnapshot(): RoomSnapshot {
    const now = Date.now();
    const gameId = this.roomDoc.mission.gameId;
    const lp = normalizeLeaderboardParams(this.roomDoc.mission.leaderboardParams, gameId);
    const mission: MissionConfig = {
      ...this.roomDoc.mission,
      leaderboardParams: lp,
    };

    const rawParticipants: ParticipantState[] = Array.from(this.participantsMap.values()).map(
      (p) => {
        const lastSeen = p.lastSeenAt || p.joinedAt || 0;
        const isFresh = Boolean(p.connected) && now - lastSeen < ONLINE_STALE_MS;
        return {
          id: p.id,
          nama: p.nama,
          kelas: p.kelas,
          sekolah: p.sekolah,
          avatar: p.avatar,
          score: p.score ?? 0,
          rank: p.rank ?? 1,
          level: p.level ?? 'sedang',
          streak: p.streak ?? 0,
          maxStreak: p.maxStreak ?? 0,
          wrongStreak: p.wrongStreak ?? 0,
          correctCount: p.correctCount ?? 0,
          wrongCount: p.wrongCount ?? 0,
          activeBuff: p.activeBuff ?? 'none',
          progressValue: p.progressValue ?? 0,
          progressLabel: p.progressLabel ?? '',
          pos: p.pos ?? { x: 0, y: 0, z: 0 },
          rotY: p.rotY ?? 0,
          activity: p.activity ?? 'schoolyard',
          isReady: Boolean(p.isReady),
          approvedForMission: Boolean(p.approvedForMission),
          connected: isFresh,
          finishedReflection: Boolean(p.finishedReflection),
          answeredLog: Array.isArray(p.answeredLog) ? p.answeredLog : [],
          joinedAt: p.joinedAt ?? now,
          lastSeenAt: lastSeen,
          typingAt: p.typingAt,
        };
      }
    );

    const ranked = rankParticipants(rawParticipants, lp, gameId);
    const participants: ParticipantState[] = ranked.map((rp) => ({
      ...rp,
      rank: rp.effectiveRank,
    }));

    const chatMessages: ChatMessage[] = Array.from(this.messagesMap.values())
      .map((m) => ({
        id: m.id,
        senderId: m.senderId,
        senderName: m.senderName,
        senderRole: m.senderRole,
        senderKelas: m.senderKelas,
        text: m.text,
        createdAt: m.createdAt,
        pinned: Boolean(m.pinned),
        deleted: Boolean(m.deleted),
      }))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-150);

    const teacherAlerts: TeacherAlert[] = Array.from(this.alertsMap.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 60);

    const snap: RoomSnapshot = {
      roomCode: this.activeRoomCode,
      mission,
      participants,
      testimonials: [...this.testimonialsList].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60),
      customElements: [...this.customElementsList],
      customQuestions: [...this.customQuestionsList],
      chatMessages,
      chatMutedAll: Boolean(this.roomDoc.chatMutedAll),
      mutedParticipantIds: Array.isArray(this.roomDoc.mutedParticipantIds)
        ? [...this.roomDoc.mutedParticipantIds]
        : [],
      teacherAlerts,
      serverTime: now,
    };

    this.snapshot = snap;
    return snap;
  }

  private emitSnapshot(): RoomSnapshot {
    const snap = this.buildSnapshot();
    this.emit('snapshot', snap);
    return snap;
  }

  private async ensureRoomDocument(roomCode: string, sekolah?: string): Promise<FirestoreRoomDoc> {
    const code = normalizeRoomCode(roomCode);
    const roomRef = doc(db, 'rooms', code);
    try {
      const existingSnap = await getDoc(roomRef);
      if (existingSnap.exists()) {
        const data = existingSnap.data() as FirestoreRoomDoc;
        if (!data.mission.leaderboardParams) {
          data.mission.leaderboardParams = getDefaultLeaderboardParams(data.mission.gameId);
        }
        return data;
      }
      const fresh = defaultRoomDoc(code, sekolah || this.activeSekolah);
      await setDoc(roomRef, fresh);
      return fresh;
    } catch (error) {
      logFirestoreError(error, OperationType.WRITE, `rooms/${code}`);
      return defaultRoomDoc(code, sekolah || this.activeSekolah);
    }
  }

  private async publishActiveRoomPointer(roomCode: string, sekolah?: string): Promise<void> {
    const code = normalizeRoomCode(roomCode);
    const pointerRef = doc(db, 'meta', 'activeRoom');
    try {
      await setDoc(pointerRef, {
        activeRoomCode: code,
        sekolah: clampStr(sekolah || this.activeSekolah, 120, DEFAULT_SEKOLAH),
        updatedAt: Date.now(),
      });
    } catch (error) {
      logFirestoreError(error, OperationType.WRITE, 'meta/activeRoom');
    }
  }

  async fetchInitialState(preferredRoomCode?: string): Promise<RoomSnapshot | null> {
    try {
      let targetRoom = preferredRoomCode ? normalizeRoomCode(preferredRoomCode) : '';
      if (!targetRoom) {
        try {
          const ptrSnap = await getDoc(doc(db, 'meta', 'activeRoom'));
          if (ptrSnap.exists()) {
            const ptr = ptrSnap.data() as { activeRoomCode?: string; sekolah?: string };
            if (ptr.activeRoomCode) targetRoom = normalizeRoomCode(ptr.activeRoomCode);
            if (ptr.sekolah) this.activeSekolah = ptr.sekolah;
          }
        } catch (err) {
          logFirestoreError(err, OperationType.GET, 'meta/activeRoom');
        }
      }
      if (!targetRoom) targetRoom = DEFAULT_ROOM_CODE;

      this.activeRoomCode = targetRoom;
      this.roomDoc = await this.ensureRoomDocument(targetRoom, this.activeSekolah);

      // Hydrate initial subcollections + global collections in parallel
      const [partSnap, msgSnap, alertSnap, testiSnap, elemSnap, qSnap] = await Promise.all([
        getDocs(
          query(collection(db, 'rooms', targetRoom, 'participants'), where('roomCode', '==', targetRoom))
        ).catch((e) => {
          logFirestoreError(e, OperationType.LIST, `rooms/${targetRoom}/participants`);
          return null;
        }),
        getDocs(
          query(collection(db, 'rooms', targetRoom, 'messages'), where('roomCode', '==', targetRoom))
        ).catch((e) => {
          logFirestoreError(e, OperationType.LIST, `rooms/${targetRoom}/messages`);
          return null;
        }),
        getDocs(
          query(collection(db, 'rooms', targetRoom, 'alerts'), where('roomCode', '==', targetRoom))
        ).catch((e) => {
          logFirestoreError(e, OperationType.LIST, `rooms/${targetRoom}/alerts`);
          return null;
        }),
        getDocs(
          query(collection(db, 'testimonials'), where('visibility', '==', 'classroom'))
        ).catch((e) => {
          logFirestoreError(e, OperationType.LIST, 'testimonials');
          return null;
        }),
        getDocs(
          query(collection(db, 'customElements'), where('visibility', '==', 'classroom'))
        ).catch((e) => {
          logFirestoreError(e, OperationType.LIST, 'customElements');
          return null;
        }),
        getDocs(
          query(collection(db, 'customQuestions'), where('visibility', '==', 'classroom'))
        ).catch((e) => {
          logFirestoreError(e, OperationType.LIST, 'customQuestions');
          return null;
        }),
      ]);

      this.participantsMap.clear();
      if (partSnap) {
        partSnap.forEach((d) => {
          const p = d.data() as FirestoreParticipantDoc;
          this.participantsMap.set(d.id, p);
          if (p.connected) this.seenOnlineIds.add(p.id);
          if (p.approvedForMission) this.seenApprovedIds.add(p.id);
        });
      }

      this.messagesMap.clear();
      if (msgSnap) {
        msgSnap.forEach((d) => {
          const m = d.data() as FirestoreChatDoc;
          this.messagesMap.set(d.id, m);
          this.seenChatIds.add(m.id);
        });
      }

      this.alertsMap.clear();
      if (alertSnap) {
        alertSnap.forEach((d) => {
          const a = d.data() as TeacherAlert;
          this.alertsMap.set(d.id, a);
          this.seenAlertIds.add(a.id);
        });
      }

      if (testiSnap) {
        this.testimonialsList = testiSnap.docs.map((d) => d.data() as TestimonialItem);
      }
      if (elemSnap) {
        this.customElementsList = elemSnap.docs.map((d) => d.data() as PaiElement);
      }
      if (qSnap) {
        this.customQuestionsList = qSnap.docs.map((d) => d.data() as QuestionItem);
      }

      this.lastMissionStartedAt = this.roomDoc.mission.startedAt;
      this.lastMissionStatus = this.roomDoc.mission.status;
      this.setConnected(true);
      return this.buildSnapshot();
    } catch (err) {
      logFirestoreError(err, OperationType.GET, `rooms/${this.activeRoomCode}`);
      return this.buildSnapshot();
    }
  }

  connect(): void {
    this.subscribeGlobalCollections();
    this.subscribeRoom(this.activeRoomCode);
    this.startPresenceSweep();
    this.bindUnloadHandlers();
  }

  private bindUnloadHandlers(): void {
    if (this.unloadBound || typeof window === 'undefined') return;
    this.unloadBound = true;
    window.addEventListener('pagehide', () => {
      if (this.activeStudentId) {
        void this.markStudentDisconnected(this.activeStudentId);
      }
    });
  }

  private startPresenceSweep(): void {
    if (this.presenceSweepTimer) return;
    this.presenceSweepTimer = setInterval(() => {
      if (this.snapshot) {
        this.emitSnapshot();
      }
    }, PRESENCE_SWEEP_MS);
  }

  private subscribeGlobalCollections(): void {
    if (this.globalUnsubs.length > 0) return;

    // 1. Testimonials
    const uTesti = onSnapshot(
      query(collection(db, 'testimonials'), where('visibility', '==', 'classroom')),
      (snap) => {
        this.testimonialsList = snap.docs.map((d) => d.data() as TestimonialItem);
        this.emitSnapshot();
      },
      (error) => logFirestoreError(error, OperationType.LIST, 'testimonials')
    );

    // 2. Custom Elements
    const uElem = onSnapshot(
      query(collection(db, 'customElements'), where('visibility', '==', 'classroom')),
      (snap) => {
        this.customElementsList = snap.docs.map((d) => d.data() as PaiElement);
        this.emitSnapshot();
      },
      (error) => logFirestoreError(error, OperationType.LIST, 'customElements')
    );

    // 3. Custom Questions
    const uQuest = onSnapshot(
      query(collection(db, 'customQuestions'), where('visibility', '==', 'classroom')),
      (snap) => {
        this.customQuestionsList = snap.docs.map((d) => d.data() as QuestionItem);
        this.emitSnapshot();
      },
      (error) => logFirestoreError(error, OperationType.LIST, 'customQuestions')
    );

    this.globalUnsubs.push(uTesti, uElem, uQuest);
  }

  private clearRoomSubscriptions(): void {
    for (const unsub of this.roomUnsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.roomUnsubs = [];
    this.roomHydrated = false;
    this.participantsHydrated = false;
    this.messagesHydrated = false;
    this.alertsHydrated = false;
  }

  private subscribeRoom(roomCode: string): void {
    const code = normalizeRoomCode(roomCode);
    this.clearRoomSubscriptions();
    this.activeRoomCode = code;

    // 1. Room state doc
    const roomRef = doc(db, 'rooms', code);
    const uRoom = onSnapshot(
      roomRef,
      (docSnap) => {
        this.setConnected(true);
        if (!docSnap.exists()) {
          void this.ensureRoomDocument(code, this.activeSekolah);
          return;
        }
        const data = docSnap.data() as FirestoreRoomDoc;
        if (!data.mission.leaderboardParams) {
          data.mission.leaderboardParams = getDefaultLeaderboardParams(data.mission.gameId);
        }
        const prevStatus = this.lastMissionStatus;
        const prevStartedAt = this.lastMissionStartedAt;

        this.roomDoc = data;
        this.lastMissionStatus = data.mission.status;
        this.lastMissionStartedAt = data.mission.startedAt;

        const snap = this.emitSnapshot();

        if (this.roomHydrated) {
          if (
            data.mission.status === 'playing' &&
            data.mission.startedAt &&
            data.mission.startedAt !== prevStartedAt
          ) {
            this.emit('missionStarted', snap);
          } else if (prevStatus === 'playing' && data.mission.status === 'finished') {
            this.emit('missionEnded', { reason: 'teacher_or_timeout', snapshot: snap });
          }
        }
        this.roomHydrated = true;
        this.scheduleTeacherMissionAutoEnd();
      },
      (error) => {
        logFirestoreError(error, OperationType.GET, `rooms/${code}`);
        this.setConnected(false);
      }
    );

    // 2. Participants subcollection
    const partQuery = query(
      collection(db, 'rooms', code, 'participants'),
      where('roomCode', '==', code)
    );
    const uPart = onSnapshot(
      partQuery,
      (qSnap) => {
        this.setConnected(true);
        const prevMap = new Map(this.participantsMap);
        this.participantsMap.clear();
        const now = Date.now();

        const newlyLoggedIn: Array<{ p: ParticipantState; isNew: boolean }> = [];
        const newlyApproved: string[] = [];
        const newlyMoved: Array<{ id: string; pos: { x: number; y: number; z: number }; rotY: number }> = [];
        const newlyTyping: Array<{ id: string; nama: string }> = [];
        const newlySabotaged: Array<{ attackerName: string; targetId: string; targetName: string; amount: number }> = [];

        qSnap.forEach((d) => {
          const p = d.data() as FirestoreParticipantDoc;
          this.participantsMap.set(d.id, p);

          const prev = prevMap.get(d.id);
          const isFresh = Boolean(p.connected) && now - (p.lastSeenAt || p.joinedAt || 0) < ONLINE_STALE_MS;

          if (this.participantsHydrated) {
            if (isFresh && (!prev || !this.seenOnlineIds.has(p.id))) {
              this.seenOnlineIds.add(p.id);
              newlyLoggedIn.push({ p, isNew: !prev });
            } else if (!isFresh) {
              this.seenOnlineIds.delete(p.id);
            }

            if (p.approvedForMission && !this.seenApprovedIds.has(p.id)) {
              this.seenApprovedIds.add(p.id);
              newlyApproved.push(p.id);
            } else if (!p.approvedForMission) {
              this.seenApprovedIds.delete(p.id);
            }

            if (
              prev &&
              p.pos &&
              (prev.pos?.x !== p.pos.x || prev.pos?.z !== p.pos.z || prev.rotY !== p.rotY)
            ) {
              newlyMoved.push({ id: p.id, pos: p.pos, rotY: p.rotY ?? 0 });
            }

            if (p.typingAt && now - p.typingAt < 4500) {
              const lastNotifiedTyping = this.seenTypingTs.get(p.id) ?? 0;
              if (p.typingAt > lastNotifiedTyping) {
                this.seenTypingTs.set(p.id, p.typingAt);
                newlyTyping.push({ id: p.id, nama: p.nama });
              }
            }

            if (p.lastSabotageAt && p.lastSabotagedBy && p.lastSabotageAmount) {
              const lastSab = this.seenSabotageTs.get(p.id) ?? 0;
              if (p.lastSabotageAt > lastSab && now - p.lastSabotageAt < 15_000) {
                this.seenSabotageTs.set(p.id, p.lastSabotageAt);
                newlySabotaged.push({
                  attackerName: p.lastSabotagedBy,
                  targetId: p.id,
                  targetName: p.nama,
                  amount: p.lastSabotageAmount,
                });
              }
            }
          } else {
            if (isFresh) this.seenOnlineIds.add(p.id);
            if (p.approvedForMission) this.seenApprovedIds.add(p.id);
            if (p.lastSabotageAt) this.seenSabotageTs.set(p.id, p.lastSabotageAt);
            if (p.typingAt) this.seenTypingTs.set(p.id, p.typingAt);
          }
        });

        const snap = this.emitSnapshot();
        this.participantsHydrated = true;

        for (const item of newlyLoggedIn) {
          this.emit('studentLoggedIn', {
            participant: snap.participants.find((x) => x.id === item.p.id) ?? item.p,
            isNew: item.isNew,
            snapshot: snap,
          });
        }
        for (const pid of newlyApproved) {
          this.emit('studentApproved', { participantId: pid, snapshot: snap });
        }
        for (const mv of newlyMoved) {
          this.emit('playerMoved', mv);
        }
        for (const tp of newlyTyping) {
          this.emit('chatTyping', { senderId: tp.id, senderName: tp.nama, role: 'student' });
        }
        for (const sb of newlySabotaged) {
          this.emit('buffAttacked', { ...sb, snapshot: snap });
        }
      },
      (error) => logFirestoreError(error, OperationType.LIST, `rooms/${code}/participants`)
    );

    // 3. Live Chat Messages subcollection
    const msgQuery = query(
      collection(db, 'rooms', code, 'messages'),
      where('roomCode', '==', code)
    );
    const uMsg = onSnapshot(
      msgQuery,
      (qSnap) => {
        this.setConnected(true);
        const newMessages: ChatMessage[] = [];
        this.messagesMap.clear();

        qSnap.forEach((d) => {
          const m = d.data() as FirestoreChatDoc;
          this.messagesMap.set(d.id, m);
          if (this.messagesHydrated && !this.seenChatIds.has(m.id)) {
            this.seenChatIds.add(m.id);
            newMessages.push(m);
          } else if (!this.messagesHydrated) {
            this.seenChatIds.add(m.id);
          }
        });

        const snap = this.emitSnapshot();
        this.messagesHydrated = true;

        newMessages.sort((a, b) => a.createdAt - b.createdAt);
        for (const message of newMessages) {
          this.emit('chatMessage', { message, snapshot: snap });
        }
      },
      (error) => logFirestoreError(error, OperationType.LIST, `rooms/${code}/messages`)
    );

    // 4. Teacher Alerts subcollection
    const alertQuery = query(
      collection(db, 'rooms', code, 'alerts'),
      where('roomCode', '==', code)
    );
    const uAlert = onSnapshot(
      alertQuery,
      (qSnap) => {
        this.setConnected(true);
        const newAlerts: TeacherAlert[] = [];
        this.alertsMap.clear();

        qSnap.forEach((d) => {
          const a = d.data() as TeacherAlert;
          this.alertsMap.set(d.id, a);
          if (this.alertsHydrated && !this.seenAlertIds.has(a.id)) {
            this.seenAlertIds.add(a.id);
            newAlerts.push(a);
          } else if (!this.alertsHydrated) {
            this.seenAlertIds.add(a.id);
          }
        });

        const snap = this.emitSnapshot();
        this.alertsHydrated = true;

        newAlerts.sort((a, b) => a.createdAt - b.createdAt);
        for (const alert of newAlerts) {
          this.emit('teacherAlert', { alert, snapshot: snap });
        }
      },
      (error) => logFirestoreError(error, OperationType.LIST, `rooms/${code}/alerts`)
    );

    this.roomUnsubs.push(uRoom, uPart, uMsg, uAlert);
  }

  private scheduleTeacherMissionAutoEnd(): void {
    if (this.missionTimer) {
      clearTimeout(this.missionTimer);
      this.missionTimer = null;
    }
    if (!this.isTeacherSession) return;
    if (this.roomDoc.mission.status !== 'playing' || !this.roomDoc.mission.endsAt) return;
    const msLeft = this.roomDoc.mission.endsAt - Date.now();
    if (msLeft <= 0) {
      this.stopMission();
      return;
    }
    this.missionTimer = setTimeout(() => {
      if (this.isTeacherSession && this.roomDoc.mission.status === 'playing') {
        this.stopMission();
      }
    }, msLeft + 400);
  }

  async forceSyncNow(): Promise<RoomSnapshot | null> {
    return this.fetchInitialState(this.activeRoomCode);
  }

  // ---------------------------------------------------------------------------
  // Student Session & Presence
  // ---------------------------------------------------------------------------
  private startStudentHeartbeat(studentId: string): void {
    this.stopStudentHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.activeStudentId || this.activeStudentId !== studentId) return;
      const pRef = doc(db, 'rooms', this.activeRoomCode, 'participants', studentId);
      void updateDoc(pRef, {
        connected: true,
        lastSeenAt: Date.now(),
      }).catch((err) => {
        logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}/participants/${studentId}`);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopStudentHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async markStudentDisconnected(studentId: string): Promise<void> {
    const pRef = doc(db, 'rooms', this.activeRoomCode, 'participants', studentId);
    try {
      await updateDoc(pRef, {
        connected: false,
        lastSeenAt: Date.now(),
      });
    } catch {
      // ignore on unload
    }
  }

  clearStudentSession(): void {
    this.stopStudentHeartbeat();
    this.activeStudentId = null;
  }

  clearTeacherSession(): void {
    this.isTeacherSession = false;
    if (this.missionTimer) {
      clearTimeout(this.missionTimer);
      this.missionTimer = null;
    }
  }

  async joinStudent(payload: {
    id?: string;
    nama: string;
    kelas: string;
    sekolah: string;
    avatar: AvatarConfig;
    roomCode?: string;
    activity?: ParticipantActivity;
    pos?: { x: number; y: number; z: number };
    rotY?: number;
    isReady?: boolean;
    wasApproved?: boolean;
    resumeMissionStartedAt?: number | null;
  }): Promise<{ ok: boolean; id?: string; error?: string; snapshot?: RoomSnapshot }> {
    const requestedCode = normalizeRoomCode(payload.roomCode || this.activeRoomCode);

    // Check if the room exists; if it's the default code, auto-bootstrap it, otherwise verify teacher's code!
    const roomRef = doc(db, 'rooms', requestedCode);
    let roomSnapData: FirestoreRoomDoc | null = null;
    try {
      const rSnap = await getDoc(roomRef);
      if (rSnap.exists()) {
        roomSnapData = rSnap.data() as FirestoreRoomDoc;
      } else if (requestedCode === DEFAULT_ROOM_CODE || requestedCode === this.activeRoomCode) {
        roomSnapData = await this.ensureRoomDocument(requestedCode, payload.sekolah);
      } else {
        const msg = `Kode ruang "${requestedCode}" belum dibuka oleh Guru. Periksa Enter Code dari guru Anda!`;
        this.emit('joinError', msg);
        return { ok: false, error: msg };
      }
    } catch (error) {
      logFirestoreError(error, OperationType.GET, `rooms/${requestedCode}`);
      const msg = 'Gagal terhubung ke server Cloud Firestore. Coba periksa koneksi internet.';
      this.emit('joinError', msg);
      return { ok: false, error: msg };
    }

    // Switch live subscriptions if room code changed
    if (requestedCode !== this.activeRoomCode || this.roomUnsubs.length === 0) {
      this.roomDoc = roomSnapData;
      this.participantsMap.clear();
      this.messagesMap.clear();
      this.alertsMap.clear();
      this.subscribeRoom(requestedCode);
    }

    const participantId =
      payload.id && /^[a-zA-Z0-9_-]{3,80}$/.test(payload.id) ? payload.id : safeId('stu');
    const now = Date.now();
    const pRef = doc(db, 'rooms', requestedCode, 'participants', participantId);
    const canResumeApproved = Boolean(
      payload.wasApproved &&
        roomSnapData.mission.status === 'playing' &&
        payload.resumeMissionStartedAt &&
        roomSnapData.mission.startedAt === payload.resumeMissionStartedAt
    );

    try {
      const existingPart = await getDoc(pRef);
      if (existingPart.exists()) {
        await updateDoc(pRef, {
          nama: clampStr(payload.nama, 64, 'Peserta'),
          kelas: clampStr(payload.kelas, 16, '5A'),
          sekolah: clampStr(payload.sekolah, 120, DEFAULT_SEKOLAH),
          avatar: payload.avatar,
          activity: payload.activity ?? (existingPart.data().activity as ParticipantActivity) ?? 'avatar',
          connected: true,
          lastSeenAt: now,
        });
      } else {
        const angle = Math.random() * Math.PI * 2;
        const radius = 2.4 + Math.random() * 4.2;
        const newDoc: FirestoreParticipantDoc = {
          id: participantId,
          roomCode: requestedCode,
          nama: clampStr(payload.nama, 64, 'Peserta'),
          kelas: clampStr(payload.kelas, 16, '5A'),
          sekolah: clampStr(payload.sekolah, 120, DEFAULT_SEKOLAH),
          avatar: payload.avatar,
          score: 0,
          rank: 1,
          level: 'sedang',
          streak: 0,
          maxStreak: 0,
          wrongStreak: 0,
          correctCount: 0,
          wrongCount: 0,
          activeBuff: 'none',
          progressValue: 0,
          progressLabel: 'Tingkat',
          pos: payload.pos
            ? {
                x: Math.max(-400, Math.min(400, Number(payload.pos.x.toFixed(2)))),
                y: Math.max(-50, Math.min(400, Number(payload.pos.y.toFixed(2)))),
                z: Math.max(-400, Math.min(400, Number(payload.pos.z.toFixed(2)))),
              }
            : {
                x: Number((Math.cos(angle) * radius).toFixed(2)),
                y: 0,
                z: Number((Math.sin(angle) * radius).toFixed(2)),
              },
          rotY: typeof payload.rotY === 'number' ? Number(payload.rotY.toFixed(2)) : 0,
          activity: payload.activity ?? 'avatar',
          isReady: Boolean(payload.isReady),
          approvedForMission: canResumeApproved,
          connected: true,
          finishedReflection: false,
          answeredLog: [],
          joinedAt: now,
          lastSeenAt: now,
        };
        await setDoc(pRef, newDoc);
        this.participantsMap.set(participantId, newDoc);
      }

      this.activeStudentId = participantId;
      this.startStudentHeartbeat(participantId);
      const snap = this.emitSnapshot();
      this.emit('joined', { id: participantId, snapshot: snap });
      return { ok: true, id: participantId, snapshot: snap };
    } catch (error) {
      logFirestoreError(error, OperationType.WRITE, `rooms/${requestedCode}/participants/${participantId}`);
      const msg = 'Gagal mendaftar ke ruang kelas Cloud. Silakan coba lagi.';
      this.emit('joinError', msg);
      return { ok: false, error: msg };
    }
  }

  leaveStudent(id: string | null | undefined): void {
    this.stopStudentHeartbeat();
    if (!id) return;
    if (this.activeStudentId === id) {
      this.activeStudentId = null;
    }
    void this.markStudentDisconnected(id);
  }

  updateAvatar(id: string, avatar: AvatarConfig, activity?: ParticipantActivity): void {
    if (!id) return;
    const pRef = doc(db, 'rooms', this.activeRoomCode, 'participants', id);
    const patch: Record<string, unknown> = {
      avatar,
      lastSeenAt: Date.now(),
    };
    if (activity) {
      patch.activity = activity;
      const p = this.participantsMap.get(id);
      if (p) {
        patch.nama = p.nama;
        patch.kelas = p.kelas;
        patch.sekolah = p.sekolah;
        patch.connected = true;
      }
    }
    void updateDoc(pRef, patch).catch((err) => {
      logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}/participants/${id}`);
    });
  }

  updateActivity(id: string, activity: ParticipantActivity): void {
    if (!id) return;
    const pRef = doc(db, 'rooms', this.activeRoomCode, 'participants', id);
    void updateDoc(pRef, {
      activity,
      lastSeenAt: Date.now(),
    }).catch((err) => {
      logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}/participants/${id}`);
    });
  }

  setReady(id: string, isReady: boolean): void {
    if (!id) return;
    const pRef = doc(db, 'rooms', this.activeRoomCode, 'participants', id);
    void updateDoc(pRef, {
      activity: 'schoolyard',
      isReady: Boolean(isReady),
      lastSeenAt: Date.now(),
    }).catch((err) => {
      logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}/participants/${id}`);
    });
  }

  sendMove(id: string, pos: { x: number; y: number; z: number }, rotY: number): void {
    if (!id) return;
    const now = performance.now();
    if (now - this.moveThrottleAt < 280) return;
    this.moveThrottleAt = now;

    const pRef = doc(db, 'rooms', this.activeRoomCode, 'participants', id);
    void updateDoc(pRef, {
      pos: {
        x: Math.max(-400, Math.min(400, Number(pos.x.toFixed(2)))),
        y: Math.max(-50, Math.min(400, Number(pos.y.toFixed(2)))),
        z: Math.max(-400, Math.min(400, Number(pos.z.toFixed(2)))),
      },
      rotY: Number(rotY.toFixed(2)),
      lastSeenAt: Date.now(),
    }).catch(() => {
      // ignore transient movement errors
    });
  }

  syncProgress(payload: {
    id: string;
    score: number;
    level: DifficultyLevel;
    streak: number;
    maxStreak: number;
    wrongStreak: number;
    correctCount: number;
    wrongCount: number;
    activeBuff: BuffType;
    progressValue: number;
    progressLabel: string;
    answerEntry?: AnswerLogEntry;
  }): void {
    if (!payload.id) return;
    const existing = this.participantsMap.get(payload.id);
    const nextLog = existing?.answeredLog ? [...existing.answeredLog] : [];
    if (payload.answerEntry) {
      nextLog.push(payload.answerEntry);
    }
    const boundedLog = nextLog.slice(-200);

    const pRef = doc(db, 'rooms', this.activeRoomCode, 'participants', payload.id);
    void updateDoc(pRef, {
      score: Math.max(0, Math.min(1_000_000, Math.round(payload.score))),
      level: payload.level,
      streak: Math.max(0, Math.round(payload.streak)),
      maxStreak: Math.max(0, Math.round(payload.maxStreak)),
      wrongStreak: Math.max(0, Math.round(payload.wrongStreak)),
      correctCount: Math.max(0, Math.round(payload.correctCount)),
      wrongCount: Math.max(0, Math.round(payload.wrongCount)),
      activeBuff: payload.activeBuff,
      progressValue: Math.max(0, Math.round(payload.progressValue)),
      progressLabel: clampStr(payload.progressLabel, 40, 'Tingkat'),
      answeredLog: boundedLog,
      activity: 'playing',
      lastSeenAt: Date.now(),
    }).catch((err) => {
      logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}/participants/${payload.id}`);
    });
  }

  attackPlayer(attackerId: string, targetId: string, amount = 150): void {
    const attacker = this.participantsMap.get(attackerId);
    const target = this.participantsMap.get(targetId);
    if (!target) return;

    const deduct = Math.max(10, Math.min(500, Math.round(amount)));
    const nextScore = Math.max(0, (target.score || 0) - deduct);
    const pRef = doc(db, 'rooms', this.activeRoomCode, 'participants', targetId);
    void updateDoc(pRef, {
      score: nextScore,
      lastSabotagedBy: clampStr(attacker?.nama || 'Teman Sekelas', 64),
      lastSabotageAmount: deduct,
      lastSabotageAt: Date.now(),
    }).catch((err) => {
      logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}/participants/${targetId}`);
    });
  }

  submitReflection(payload: {
    id?: string;
    participantId?: string;
    nama: string;
    kelas: string;
    sekolah: string;
    refleksi: string;
    komentar: string;
    kritikSaran: string;
    gameName?: string;
    skor: number;
  }): void {
    const id = safeId('testi');
    const resolvedGameName =
      payload.gameName || getMinigameMeta(this.roomDoc.mission.gameId).name;
    const item: TestimonialItem & { visibility: 'classroom' } = {
      id,
      visibility: 'classroom',
      nama: clampStr(payload.nama, 64, 'Peserta'),
      kelas: clampStr(payload.kelas, 16, '5A'),
      sekolah: clampStr(payload.sekolah, 120, DEFAULT_SEKOLAH),
      refleksi: clampStr(payload.refleksi, 400, 'Belajar PAI sangat menyenangkan!'),
      komentar: clampStr(payload.komentar, 300, ''),
      kritikSaran: clampStr(payload.kritikSaran, 300, ''),
      gameName: clampStr(resolvedGameName, 80, 'Puncak Nalar'),
      skor: Math.max(0, Math.min(1_000_000, Math.round(payload.skor || 0))),
      createdAt: Date.now(),
    };

    void setDoc(doc(db, 'testimonials', id), item)
      .then(() => {
        this.emit('reflectionSaved', item);
      })
      .catch((err) => {
        logFirestoreError(err, OperationType.CREATE, `testimonials/${id}`);
      });

    const participantId = payload.participantId ?? payload.id;
    if (participantId && this.participantsMap.has(participantId)) {
      const pRef = doc(db, 'rooms', this.activeRoomCode, 'participants', participantId);
      void updateDoc(pRef, {
        finishedReflection: true,
        activity: 'finished',
        lastSeenAt: Date.now(),
      }).catch(() => {
        // ignore if participant removed
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Teacher Auth & Mission Controls
  // ---------------------------------------------------------------------------
  async loginTeacher(
    code: string,
    sekolah: string,
    roomCode?: string
  ): Promise<{
    ok: boolean;
    sekolah?: string;
    roomCode?: string;
    error?: string;
    snapshot?: RoomSnapshot;
  }> {
    if (code.trim().toLowerCase() !== TEACHER_ADMIN_CODE) {
      const errRes = { ok: false, error: 'Kode Admin Guru salah! Gunakan kode resmi: gpaibeji' };
      this.emit('teacherAuth', errRes);
      return errRes;
    }

    const cleanSchool = clampStr(sekolah, 120, DEFAULT_SEKOLAH);
    const targetRoom = normalizeRoomCode(roomCode || this.activeRoomCode);
    this.isTeacherSession = true;
    this.activeSekolah = cleanSchool;

    this.roomDoc = await this.ensureRoomDocument(targetRoom, cleanSchool);
    await this.publishActiveRoomPointer(targetRoom, cleanSchool);

    if (targetRoom !== this.activeRoomCode || this.roomUnsubs.length === 0) {
      this.participantsMap.clear();
      this.messagesMap.clear();
      this.alertsMap.clear();
      this.subscribeRoom(targetRoom);
    }

    const snap = (await this.fetchInitialState(targetRoom)) ?? this.buildSnapshot();
    const res = {
      ok: true,
      sekolah: cleanSchool,
      roomCode: targetRoom,
      snapshot: snap,
    };
    this.emit('teacherAuth', res);
    return res;
  }

  setRoomCode(newRoomCode: string): void {
    const clean = normalizeRoomCode(newRoomCode);
    void (async () => {
      this.roomDoc = await this.ensureRoomDocument(clean, this.activeSekolah);
      await this.publishActiveRoomPointer(clean, this.activeSekolah);
      this.participantsMap.clear();
      this.messagesMap.clear();
      this.alertsMap.clear();
      this.subscribeRoom(clean);
      await this.fetchInitialState(clean);
    })();
  }

  configureMission(cfg: {
    elementIds?: string[];
    gameId?: GameId;
    questionDurationSec?: number;
    gameDurationMin?: number;
    leaderboardParams?: LeaderboardParams;
  }): void {
    const nextGameId = cfg.gameId ?? this.roomDoc.mission.gameId;
    const gameChanged = cfg.gameId !== undefined && cfg.gameId !== this.roomDoc.mission.gameId;

    const nextLeaderboardParams = cfg.leaderboardParams
      ? normalizeLeaderboardParams(cfg.leaderboardParams, nextGameId)
      : gameChanged
        ? getDefaultLeaderboardParams(nextGameId)
        : normalizeLeaderboardParams(this.roomDoc.mission.leaderboardParams, nextGameId);

    const nextMission: MissionConfig = {
      ...this.roomDoc.mission,
      elementIds:
        cfg.elementIds && cfg.elementIds.length > 0
          ? cfg.elementIds.slice(0, 20)
          : this.roomDoc.mission.elementIds,
      gameId: nextGameId,
      questionDurationSec: Math.max(
        5,
        Math.min(180, Math.round(cfg.questionDurationSec ?? this.roomDoc.mission.questionDurationSec))
      ),
      gameDurationMin: Math.max(
        1,
        Math.min(120, Math.round(cfg.gameDurationMin ?? this.roomDoc.mission.gameDurationMin))
      ),
      leaderboardParams: nextLeaderboardParams,
    };

    this.roomDoc = {
      ...this.roomDoc,
      mission: nextMission,
      updatedAt: Date.now(),
    };
    this.emitSnapshot();

    const roomRef = doc(db, 'rooms', this.activeRoomCode);
    void updateDoc(roomRef, {
      mission: nextMission,
      updatedAt: this.roomDoc.updatedAt,
    }).catch((err) => {
      logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}`);
    });
  }

  setLeaderboardParams(params: LeaderboardParams): void {
    this.configureMission({ leaderboardParams: params });
  }

  startMission(cfg: {
    elementIds: string[];
    gameId: GameId;
    questionDurationSec: number;
    gameDurationMin: number;
    leaderboardParams?: LeaderboardParams;
  }): void {
    const now = Date.now();
    const durationMin = Math.max(1, Math.min(120, Math.round(cfg.gameDurationMin)));
    const nextLeaderboardParams = normalizeLeaderboardParams(
      cfg.leaderboardParams ?? this.roomDoc.mission.leaderboardParams,
      cfg.gameId
    );
    const nextMission: MissionConfig = {
      active: true,
      status: 'playing',
      elementIds: cfg.elementIds.length > 0 ? cfg.elementIds.slice(0, 20) : ['quran_hadis'],
      gameId: cfg.gameId,
      questionDurationSec: Math.max(5, Math.min(180, Math.round(cfg.questionDurationSec))),
      gameDurationMin: durationMin,
      startedAt: now,
      endsAt: now + durationMin * 60_000,
      leaderboardParams: nextLeaderboardParams,
    };

    void (async () => {
      try {
        const batch = writeBatch(db);
        const roomRef = doc(db, 'rooms', this.activeRoomCode);
        batch.update(roomRef, {
          mission: nextMission,
          updatedAt: now,
        });

        for (const p of this.participantsMap.values()) {
          const pRef = doc(db, 'rooms', this.activeRoomCode, 'participants', p.id);
          batch.update(pRef, {
            score: 0,
            rank: 1,
            level: cfg.gameId === 'portal_dimension' ? 'mudah' : 'sedang',
            streak: 0,
            maxStreak: 0,
            wrongStreak: 0,
            correctCount: 0,
            wrongCount: 0,
            activeBuff: 'none',
            progressValue: 0,
            progressLabel: 'Tingkat',
            answeredLog: [],
            finishedReflection: false,
            approvedForMission: true,
            activity: 'playing',
            isReady: true,
          });
        }
        await batch.commit();
      } catch (err) {
        logFirestoreError(err, OperationType.WRITE, `rooms/${this.activeRoomCode}`);
      }
    })();
  }

  stopMission(): void {
    const now = Date.now();
    const nextMission: MissionConfig = {
      ...this.roomDoc.mission,
      active: false,
      status: 'finished',
      endsAt: now,
    };
    const roomRef = doc(db, 'rooms', this.activeRoomCode);
    void updateDoc(roomRef, {
      mission: nextMission,
      updatedAt: now,
    }).catch((err) => {
      logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}`);
    });
  }

  returnToLobby(): void {
    const now = Date.now();
    const nextMission: MissionConfig = {
      ...this.roomDoc.mission,
      active: false,
      status: 'lobby',
      startedAt: null,
      endsAt: null,
    };
    void (async () => {
      try {
        const batch = writeBatch(db);
        batch.update(doc(db, 'rooms', this.activeRoomCode), {
          mission: nextMission,
          updatedAt: now,
        });
        for (const p of this.participantsMap.values()) {
          batch.update(doc(db, 'rooms', this.activeRoomCode, 'participants', p.id), {
            approvedForMission: false,
            activity: 'schoolyard',
          });
        }
        await batch.commit();
      } catch (err) {
        logFirestoreError(err, OperationType.WRITE, `rooms/${this.activeRoomCode}`);
      }
    })();
  }

  resetRoom(): void {
    const now = Date.now();
    const nextMission: MissionConfig = {
      ...this.roomDoc.mission,
      active: false,
      status: 'lobby',
      startedAt: null,
      endsAt: null,
    };
    void (async () => {
      try {
        const batch = writeBatch(db);
        batch.update(doc(db, 'rooms', this.activeRoomCode), {
          mission: nextMission,
          updatedAt: now,
        });
        for (const p of this.participantsMap.values()) {
          batch.update(doc(db, 'rooms', this.activeRoomCode, 'participants', p.id), {
            score: 0,
            rank: 1,
            level: 'sedang',
            streak: 0,
            maxStreak: 0,
            wrongStreak: 0,
            correctCount: 0,
            wrongCount: 0,
            activeBuff: 'none',
            progressValue: 0,
            progressLabel: 'Tingkat',
            answeredLog: [],
            finishedReflection: false,
            approvedForMission: false,
            activity: 'schoolyard',
            isReady: false,
          });
        }
        await batch.commit();
      } catch (err) {
        logFirestoreError(err, OperationType.WRITE, `rooms/${this.activeRoomCode}`);
      }
    })();
  }

  approveStudent(participantId: string): void {
    if (!participantId) return;
    const pRef = doc(db, 'rooms', this.activeRoomCode, 'participants', participantId);
    const patch: Record<string, unknown> = { approvedForMission: true };
    if (this.roomDoc.mission.status === 'playing') {
      patch.activity = 'playing';
    }
    void updateDoc(pRef, patch).catch((err) => {
      logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}/participants/${participantId}`);
    });
  }

  approveAllStudents(): void {
    void (async () => {
      try {
        const batch = writeBatch(db);
        for (const p of this.participantsMap.values()) {
          const patch: Record<string, unknown> = { approvedForMission: true };
          if (this.roomDoc.mission.status === 'playing') {
            patch.activity = 'playing';
          }
          batch.update(doc(db, 'rooms', this.activeRoomCode, 'participants', p.id), patch);
        }
        await batch.commit();
      } catch (err) {
        logFirestoreError(err, OperationType.WRITE, `rooms/${this.activeRoomCode}/participants`);
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Custom PAI Elements & Questions
  // ---------------------------------------------------------------------------
  addElement(element: PaiElement): void {
    const id = element.id && /^[a-zA-Z0-9_-]{3,80}$/.test(element.id) ? element.id : safeId('elem');
    const docPayload = {
      id,
      visibility: 'classroom' as const,
      name: clampStr(element.name, 100, 'Elemen Baru'),
      shortName: clampStr(element.shortName, 40, 'Elemen'),
      color: clampStr(element.color, 20, '#10b981'),
      accentHex: typeof element.accentHex === 'number' ? element.accentHex : 0x10b981,
      materialTitle: clampStr(element.materialTitle, 160, element.name),
      subtitle: clampStr(element.subtitle, 200, ''),
      sections: Array.isArray(element.sections) && element.sections.length > 0
        ? element.sections.slice(0, 15)
        : [{ heading: 'Ringkasan', paragraphs: ['Materi PAI'] }],
      isCustom: true,
    };
    void setDoc(doc(db, 'customElements', id), docPayload).catch((err) => {
      logFirestoreError(err, OperationType.CREATE, `customElements/${id}`);
    });
  }

  addQuestion(question: QuestionItem): void {
    const id = question.id && /^[a-zA-Z0-9_-]{3,80}$/.test(question.id) ? question.id : safeId('q');
    const docPayload = {
      id,
      visibility: 'classroom' as const,
      elementId: clampStr(question.elementId, 80, 'quran_hadis'),
      difficulty: question.difficulty ?? 'sedang',
      cognitiveLevel: clampStr(question.cognitiveLevel, 60, 'L2 - Penerapan'),
      type: question.type ?? 'PG',
      prompt: clampStr(question.prompt, 600, 'Pertanyaan PAI'),
      options: (question.options ?? []).slice(0, 6).map((o) => clampStr(o, 220)),
      correctIndices: (question.correctIndices ?? [0]).slice(0, 6),
      explanation: clampStr(question.explanation, 400, 'Pembahasan soal.'),
    };
    void setDoc(doc(db, 'customQuestions', id), docPayload).catch((err) => {
      logFirestoreError(err, OperationType.CREATE, `customQuestions/${id}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Moderated Live Chat & Teacher Moderation Alerts
  // ---------------------------------------------------------------------------
  sendChat(payload: {
    senderId?: string;
    senderName: string;
    senderRole?: 'teacher' | 'student';
    role?: 'teacher' | 'student';
    senderKelas?: string;
    text: string;
    pinned?: boolean;
    pin?: boolean;
  }): void {
    const text = clampStr(payload.text, 280);
    if (!text) return;

    const resolvedRole: 'teacher' | 'student' = payload.senderRole ?? payload.role ?? 'student';
    const resolvedSenderId =
      payload.senderId ||
      (resolvedRole === 'teacher' ? 'teacher_admin' : this.activeStudentId || 'student');
    const resolvedPinned = Boolean(
      resolvedRole === 'teacher' && (payload.pinned ?? payload.pin)
    );

    const isStudent = resolvedRole === 'student';
    if (isStudent) {
      if (this.roomDoc.chatMutedAll) {
        this.emit('chatRejected', 'Chat kelas sedang dibisukan sementara oleh Guru.');
        return;
      }
      if (this.roomDoc.mutedParticipantIds.includes(resolvedSenderId)) {
        this.emit('chatRejected', 'Akun Anda sedang dibisukan oleh Guru. Fokus pada misi terlebih dahulu.');
        return;
      }

      // 1. Spam / rapid flood check
      const now = Date.now();
      const history = (this.recentChatTimestamps.get(resolvedSenderId) ?? []).filter(
        (t) => now - t < 8_000
      );
      if (history.length >= 3) {
        this.emit('chatRejected', 'Terlalu cepat mengirim pesan! Tunggu beberapa detik sebelum chat lagi.');
        void this.reportTeacherAlert({
          kind: 'chat_moderation_spam',
          severity: 'warning',
          participantId: resolvedSenderId,
          participantName: payload.senderName,
          participantKelas: payload.senderKelas,
          detail: `${payload.senderName} mengirim pesan bertubi-tubi (indikasi spam chat).`,
          chatText: text.slice(0, 120),
        });
        return;
      }
      history.push(now);
      this.recentChatTimestamps.set(resolvedSenderId, history);

      // 2. Profanity / unsafe words check
      const blockedHit = containsBlockedWord(text);
      if (blockedHit) {
        this.emit(
          'chatRejected',
          'Pesan ditahan otomatis karena mengandung kata tidak sopan. Mari jaga akhlak mulia di forum kelas!'
        );
        void this.reportTeacherAlert({
          kind: 'chat_moderation_blocked',
          severity: 'danger',
          participantId: resolvedSenderId,
          participantName: payload.senderName,
          participantKelas: payload.senderKelas,
          detail: `Pesan ${payload.senderName} diblokir filter akhlak (terdeteksi kata tidak pantas).`,
          chatText: text.slice(0, 160),
        });
        return;
      }

      // 3. Excessive ALL-CAPS shouting alert (allow message but alert teacher for moderation)
      if (isExcessiveCaps(text)) {
        void this.reportTeacherAlert({
          kind: 'chat_moderation_caps',
          severity: 'warning',
          participantId: resolvedSenderId,
          participantName: payload.senderName,
          participantKelas: payload.senderKelas,
          detail: `${payload.senderName} mengirim pesan dengan HURUF KAPITAL berlebihan di forum kelas.`,
          chatText: text.slice(0, 160),
        });
      }
    }

    const id = safeId('msg');
    const msgDoc: FirestoreChatDoc = {
      id,
      roomCode: this.activeRoomCode,
      senderId: clampStr(resolvedSenderId, 80, 'user'),
      senderName: clampStr(payload.senderName, 80, 'Pengguna'),
      senderRole: resolvedRole,
      senderKelas: clampStr(payload.senderKelas ?? '', 16),
      text,
      createdAt: Date.now(),
      pinned: resolvedPinned,
      deleted: false,
    };

    void setDoc(doc(db, 'rooms', this.activeRoomCode, 'messages', id), msgDoc).catch((err) => {
      logFirestoreError(err, OperationType.CREATE, `rooms/${this.activeRoomCode}/messages/${id}`);
      this.emit('chatRejected', 'Gagal mengirim pesan ke Cloud. Periksa koneksi internet Anda.');
    });
  }

  sendTyping(payload: { senderId?: string; senderName: string; role: 'teacher' | 'student' }): void {
    const now = Date.now();
    if (now - this.typingThrottleAt < 2200) return;
    this.typingThrottleAt = now;

    if (payload.role === 'student' && payload.senderId) {
      const pRef = doc(db, 'rooms', this.activeRoomCode, 'participants', payload.senderId);
      void updateDoc(pRef, {
        typingAt: now,
        lastSeenAt: now,
      }).catch(() => {
        // ignore transient typing errors
      });
    }
  }

  deleteChatMessage(messageId: string): void {
    if (!messageId) return;
    const mRef = doc(db, 'rooms', this.activeRoomCode, 'messages', messageId);
    void updateDoc(mRef, { deleted: true }).catch((err) => {
      logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}/messages/${messageId}`);
    });
  }

  pinChatMessage(messageId: string): void {
    if (!messageId) return;
    const existing = this.messagesMap.get(messageId);
    const nextPinned = !(existing?.pinned ?? false);
    const mRef = doc(db, 'rooms', this.activeRoomCode, 'messages', messageId);
    void updateDoc(mRef, { pinned: nextPinned }).catch((err) => {
      logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}/messages/${messageId}`);
    });
  }

  toggleMuteAll(): void {
    const nextMuted = !this.roomDoc.chatMutedAll;
    const roomRef = doc(db, 'rooms', this.activeRoomCode);
    void updateDoc(roomRef, {
      chatMutedAll: nextMuted,
      updatedAt: Date.now(),
    }).catch((err) => {
      logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}`);
    });
  }

  toggleMuteStudent(participantId: string): void {
    if (!participantId) return;
    const current = new Set(this.roomDoc.mutedParticipantIds ?? []);
    if (current.has(participantId)) {
      current.delete(participantId);
    } else {
      current.add(participantId);
    }
    const nextList = Array.from(current).slice(0, 100);
    const roomRef = doc(db, 'rooms', this.activeRoomCode);
    void updateDoc(roomRef, {
      mutedParticipantIds: nextList,
      updatedAt: Date.now(),
    }).catch((err) => {
      logFirestoreError(err, OperationType.UPDATE, `rooms/${this.activeRoomCode}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Teacher Toast Alert System (Off-Mission & Chat Moderation)
  // ---------------------------------------------------------------------------
  async reportTeacherAlert(payload: {
    kind: TeacherAlertKind;
    severity: 'warning' | 'danger';
    participantId: string;
    participantName: string;
    participantKelas?: string;
    detail: string;
    chatText?: string;
  }): Promise<void> {
    // Throttle duplicate alerts per student + kind (12s cooldown, except blocked chat which always notifies)
    const throttleKey = `${payload.participantId}:${payload.kind}`;
    const now = Date.now();
    const lastSent = this.alertThrottleMap.get(throttleKey) ?? 0;
    const cooldownMs = payload.kind === 'chat_moderation_blocked' ? 3_000 : 18_000;
    if (now - lastSent < cooldownMs) return;
    this.alertThrottleMap.set(throttleKey, now);

    const id = safeId('alrt');
    const alertDoc: TeacherAlert = {
      id,
      roomCode: this.activeRoomCode,
      kind: payload.kind,
      severity: payload.severity,
      participantId: clampStr(payload.participantId, 80, 'student'),
      participantName: clampStr(payload.participantName, 80, 'Peserta'),
      participantKelas: clampStr(payload.participantKelas ?? '', 16),
      detail: clampStr(payload.detail, 280),
      chatText: clampStr(payload.chatText ?? '', 200),
      createdAt: now,
    };

    try {
      await setDoc(doc(db, 'rooms', this.activeRoomCode, 'alerts', id), alertDoc);
    } catch (err) {
      logFirestoreError(err, OperationType.CREATE, `rooms/${this.activeRoomCode}/alerts/${id}`);
    }
  }

  dismissTeacherAlert(alertId: string): void {
    if (!alertId) return;
    void deleteDoc(doc(db, 'rooms', this.activeRoomCode, 'alerts', alertId)).catch((err) => {
      logFirestoreError(err, OperationType.DELETE, `rooms/${this.activeRoomCode}/alerts/${alertId}`);
    });
  }

  clearTeacherAlerts(): void {
    void (async () => {
      try {
        const batch = writeBatch(db);
        for (const alert of this.alertsMap.values()) {
          batch.delete(doc(db, 'rooms', this.activeRoomCode, 'alerts', alert.id));
        }
        await batch.commit();
      } catch (err) {
        logFirestoreError(err, OperationType.DELETE, `rooms/${this.activeRoomCode}/alerts`);
      }
    })();
  }
}

export const realtimeClient = new RealtimeClient();
