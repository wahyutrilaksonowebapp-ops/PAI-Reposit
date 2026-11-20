import type {
  AvatarConfig,
  ChatMessage,
  DifficultyLevel,
  GameId,
  ParticipantState,
  QuestionType,
  RoomSnapshot,
  TestimonialItem,
} from '../types.ts';
import {
  AVATAR_OPTIONS,
  DEFAULT_AVATAR_MUSLIM,
  DEFAULT_AVATAR_MUSLIMAH,
  getMinigameMeta,
} from '../constants.ts';
import { paiBank } from '../data/paiBank.ts';
import { realtimeClient } from '../services/RealtimeClient.ts';
import { QuizEngine } from '../game/QuizEngine.ts';
import { soundFX } from '../audio/SoundFX.ts';
import type { PaiWorldScript } from '../scene/PaiWorldScript.ts';
import { ChatSidebar } from './ChatSidebar.ts';
import {
  clearSession,
  saveSession,
  type SavedStudentSession,
} from '../services/SessionStorage.ts';

type StudentScreen = 'login' | 'avatar' | 'schoolyard' | 'playing';
type GameSidebarTab = 'quiz' | 'chat';

export class StudentUI {
  private container: HTMLElement;
  private world: PaiWorldScript;
  private quiz = new QuizEngine();
  private onTeacherLoggedIn: (
    sekolah: string,
    roomCode: string,
    snapshot: RoomSnapshot | null
  ) => void;
  private onToggleXR: () => void;
  private onToast: (msg: string) => void;

  private screen: StudentScreen = 'login';
  private loginTab: 'student' | 'teacher' = 'student';
  private snapshot: RoomSnapshot | null = null;

  // Student identity & matching Enter Code
  private studentId: string | null = null;
  private nama = '';
  private kelas = '5';
  private sekolah = '';
  private roomCode = '';
  private teacherDraftRoomCode = 'PAI2026';
  private avatar: AvatarConfig = { ...DEFAULT_AVATAR_MUSLIM };
  private isReady = false;
  private lastPos: { x: number; y: number; z: number } = { x: 0, y: 0.08, z: 4.8 };
  private lastRotY = Math.PI;
  private submittingLogin = false;

  // Interactive modals & sidebar states
  private openMaterialElementId: string | null = null;
  private showBuffModal = false;
  private showReflectionModal = false;
  private reflectionSubmitted = false;
  private showMiniLeaderboard = false;
  private avatarChatOpen = false;
  private schoolyardChatOpen = window.innerWidth >= 768;
  private gameSidebarTab: GameSidebarTab = 'quiz';
  private unreadChatCount = 0;

  private chatSidebar: ChatSidebar;

  // Active quiz UI state
  private selectedIndices: number[] = [];
  private awaitingNext = false;
  private lastFeedback: { isCorrect: boolean; delta: number; text: string } | null = null;
  private waitingForDiceRoll = false;
  private lastDiceNumber = 0;

  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private onResizeBound = () => this.syncCameraCentering();
  private onBeforeUnloadBound = () => this.persistStudentSession();
  private onVisibilityChangeBound = () => {
    if (document.visibilityState === 'hidden') {
      this.persistStudentSession();
    }
  };

  constructor(
    container: HTMLElement,
    world: PaiWorldScript,
    onTeacherLoggedIn: (
      sekolah: string,
      roomCode: string,
      snapshot: RoomSnapshot | null
    ) => void,
    onToggleXR: () => void,
    onToast: (msg: string) => void
  ) {
    this.container = container;
    this.world = world;
    this.onTeacherLoggedIn = onTeacherLoggedIn;
    this.onToggleXR = onToggleXR;
    this.onToast = onToast;

    // Auto-read ?code=... from shared link so student Enter Code is prefilled
    const urlCode = new URLSearchParams(window.location.search).get('code');
    if (urlCode) {
      this.roomCode = urlCode.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
    }

    this.chatSidebar = new ChatSidebar({
      role: 'student',
      selfId: null,
      senderName: 'Peserta',
      senderKelas: this.kelas,
      onToast: this.onToast,
    });

    // Bind 3D World click callbacks
    this.world.callbacks = {
      onClickKiosk: (elementId) => {
        if (this.screen === 'schoolyard') {
          soundFX.playClick();
          this.openMaterialElementId = elementId;
          this.render();
        }
      },
      onClickOption: (idx) => {
        if (this.screen === 'playing' && !this.awaitingNext && !this.showBuffModal) {
          this.handleOptionInteraction(idx);
        }
      },
      onClickPortal: (diff) => {
        if (this.screen === 'playing' && this.quiz.gameId === 'portal_dimension') {
          this.switchPortalDimension(diff);
        }
      },
      onClickDice: () => {
        if (this.screen === 'playing' && this.quiz.gameId === 'board_adventure') {
          this.handleRollDice();
        }
      },
      onClickCraftTable: () => {
        if (this.screen === 'playing' && this.quiz.gameId === 'edu_craft') {
          soundFX.playBuild();
          this.onToast('Jawab soal di panel kiri untuk merakit bangunan 3D baru!');
        }
      },
      onClickArtifact: (idx) => {
        if (this.screen === 'playing' && this.quiz.gameId === 'astro_scanner') {
          soundFX.playScan();
          this.onToast(`Memindai Artefak #${idx + 1}! Jawab kuis di kiri untuk membuka lencana orbit.`);
        }
      },
      onPlayerMoveSync: (pos, rotY) => {
        this.lastPos = pos;
        this.lastRotY = rotY;
        if (this.studentId) {
          realtimeClient.sendMove(this.studentId, pos, rotY);
          this.persistStudentSession();
        }
      },
      onQuickSelectOption: (idx) => {
        if (
          this.screen === 'playing' &&
          !this.awaitingNext &&
          !this.showBuffModal &&
          !this.showReflectionModal &&
          !this.waitingForDiceRoll &&
          this.quiz.currentQuestion &&
          idx < this.quiz.currentQuestion.options.length
        ) {
          this.handleOptionInteraction(idx);
        }
      },
    };
  }

  private persistStudentSession(): void {
    if (this.screen === 'login' || !this.studentId || !this.nama || !this.sekolah) return;
    const self = this.getSelfParticipant();
    saveSession({
      role: 'student',
      studentId: this.studentId,
      roomCode: this.roomCode || this.snapshot?.roomCode || 'PAI2026',
      nama: this.nama,
      kelas: this.kelas,
      sekolah: this.sekolah,
      avatar: { ...this.avatar },
      screen: this.screen,
      isReady: this.isReady,
      pos: { ...this.lastPos },
      rotY: this.lastRotY,
      missionStartedAt: this.snapshot?.mission.startedAt ?? null,
      missionGameId: this.quiz.gameId,
      approvedForMission: Boolean(self?.approvedForMission || this.screen === 'playing'),
      quizState: this.screen === 'playing' ? this.quiz.exportState() : null,
      waitingForDiceRoll: this.waitingForDiceRoll,
      lastDiceNumber: this.lastDiceNumber,
      showReflectionModal: this.showReflectionModal,
      reflectionSubmitted: this.reflectionSubmitted,
      savedAt: Date.now(),
    });
  }

  mount(snapshot: RoomSnapshot | null): void {
    this.snapshot = snapshot;
    if (snapshot) {
      paiBank.setCustomContent(snapshot.customElements, snapshot.customQuestions);
    }
    this.world.setElements(paiBank.getAllElements());
    this.screen = 'login';
    this.world.setViewMode('title');
    this.render();
    this.startTimerLoop();
    window.addEventListener('resize', this.onResizeBound);
    window.addEventListener('beforeunload', this.onBeforeUnloadBound);
    document.addEventListener('visibilitychange', this.onVisibilityChangeBound);
  }

  restoreSession(saved: SavedStudentSession, snapshot: RoomSnapshot | null): void {
    this.snapshot = snapshot;
    if (snapshot) {
      paiBank.setCustomContent(snapshot.customElements, snapshot.customQuestions);
    }
    this.world.setElements(paiBank.getAllElements());

    this.studentId = saved.studentId;
    this.nama = saved.nama;
    this.kelas = saved.kelas;
    this.sekolah = saved.sekolah;
    this.roomCode = saved.roomCode || snapshot?.roomCode || 'PAI2026';
    this.avatar = { ...saved.avatar };
    this.isReady = Boolean(saved.isReady);
    if (saved.pos) this.lastPos = { ...saved.pos };
    if (typeof saved.rotY === 'number') this.lastRotY = saved.rotY;

    this.world.setPlayerIdentity(this.nama, this.kelas, this.avatar);
    this.chatSidebar.setOptions({
      selfId: this.studentId,
      senderName: this.nama,
      senderKelas: this.kelas,
    });

    const handleRestoreJoinResult = (res: { ok: boolean; error?: string }) => {
      if (!res.ok) {
        clearSession();
        realtimeClient.clearStudentSession();
        this.screen = 'login';
        this.world.setViewMode('title');
        this.render();
        this.onToast(res.error || 'Kode Ruang kelas telah berubah. Silakan masukkan Kode Ruang baru dari Guru.');
      }
    };

    const mission = snapshot?.mission;
    const serverSelf = snapshot?.participants.find((p) => p.id === this.studentId);
    const canResumePlaying =
      mission?.status === 'playing' &&
      Boolean(
        serverSelf?.approvedForMission ||
          (saved.approvedForMission &&
            saved.missionStartedAt != null &&
            saved.missionStartedAt === mission.startedAt)
      );

    if (canResumePlaying && mission) {
      this.screen = 'playing';
      this.showBuffModal = false;
      this.showReflectionModal = false;
      this.reflectionSubmitted = false;
      this.awaitingNext = false;
      this.selectedIndices = [];
      this.lastFeedback = null;

      if (saved.quizState && saved.quizState.gameId === mission.gameId) {
        this.quiz.restoreState(saved.quizState);
      } else {
        this.quiz.reset({
          gameId: mission.gameId,
          elementIds:
            mission.elementIds.length > 0
              ? mission.elementIds
              : paiBank.getAllElements().map((e) => e.id),
          questionDurationSec: mission.questionDurationSec,
        });
        if (serverSelf) {
          this.quiz.score = serverSelf.score;
          this.quiz.level = serverSelf.level;
          this.quiz.streak = serverSelf.streak;
          this.quiz.maxStreak = serverSelf.maxStreak;
          this.quiz.correctCount = serverSelf.correctCount;
          this.quiz.wrongCount = serverSelf.wrongCount;
          this.quiz.progressValue = serverSelf.progressValue;
          this.quiz.activeBuff = serverSelf.activeBuff;
        }
      }

      this.world.setViewMode('minigame', mission.gameId);
      this.world.setCurrentProgress(this.quiz.progressValue);
      if (mission.gameId === 'portal_dimension') {
        this.world.setActivePortal(this.quiz.portalDimensionLevel);
      }

      this.waitingForDiceRoll =
        mission.gameId === 'board_adventure' && Boolean(saved.waitingForDiceRoll);
      this.lastDiceNumber = saved.lastDiceNumber ?? 0;

      if (this.waitingForDiceRoll) {
        this.quiz.currentQuestion = null;
        this.world.setQuestionVisuals(null, []);
      } else if (!this.quiz.currentQuestion) {
        this.loadNextQuestion();
      } else {
        this.world.setQuestionVisuals(this.quiz.currentQuestion, []);
      }

      void realtimeClient
        .joinStudent({
          id: this.studentId,
          roomCode: this.roomCode,
          nama: this.nama,
          kelas: this.kelas,
          sekolah: this.sekolah,
          avatar: this.avatar,
          activity: 'playing',
          pos: this.lastPos,
          rotY: this.lastRotY,
          isReady: this.isReady,
          wasApproved: true,
          resumeMissionStartedAt: mission.startedAt,
        })
        .then(handleRestoreJoinResult);

      this.onToast('Permainan dilanjutkan otomatis! Skor & progres kamu tetap tersimpan.');
    } else if (
      mission?.status === 'finished' &&
      saved.screen === 'playing' &&
      !saved.reflectionSubmitted
    ) {
      if (saved.quizState) {
        this.quiz.restoreState(saved.quizState);
      }
      this.screen = 'playing';
      this.showReflectionModal = true;
      this.reflectionSubmitted = false;
      this.world.setViewMode('minigame', mission.gameId);
      void realtimeClient
        .joinStudent({
          id: this.studentId,
          roomCode: this.roomCode,
          nama: this.nama,
          kelas: this.kelas,
          sekolah: this.sekolah,
          avatar: this.avatar,
          activity: 'finished',
          pos: this.lastPos,
          rotY: this.lastRotY,
          isReady: this.isReady,
        })
        .then(handleRestoreJoinResult);
      this.onToast('Sesi dilanjutkan ke form refleksi belajar!');
    } else if (saved.screen === 'avatar') {
      this.screen = 'avatar';
      this.world.setViewMode('avatar_studio');
      void realtimeClient
        .joinStudent({
          id: this.studentId,
          roomCode: this.roomCode,
          nama: this.nama,
          kelas: this.kelas,
          sekolah: this.sekolah,
          avatar: this.avatar,
          activity: 'avatar',
          pos: this.lastPos,
          rotY: this.lastRotY,
          isReady: this.isReady,
        })
        .then(handleRestoreJoinResult);
      this.onToast('Studio Avatar dilanjutkan otomatis.');
    } else {
      this.screen = 'schoolyard';
      this.world.setViewMode('schoolyard');
      this.world.setPlayerPosition(this.lastPos, this.lastRotY);
      void realtimeClient
        .joinStudent({
          id: this.studentId,
          roomCode: this.roomCode,
          nama: this.nama,
          kelas: this.kelas,
          sekolah: this.sekolah,
          avatar: this.avatar,
          activity: 'schoolyard',
          pos: this.lastPos,
          rotY: this.lastRotY,
          isReady: this.isReady,
        })
        .then(handleRestoreJoinResult);
      this.onToast('Kembali ke Halaman Sekolah — sesi kamu tetap aktif!');
    }

    if (snapshot) {
      this.world.syncPeers(snapshot.participants, this.studentId);
    }

    this.render();
    this.persistStudentSession();
    this.startTimerLoop();
    window.addEventListener('resize', this.onResizeBound);
    window.addEventListener('beforeunload', this.onBeforeUnloadBound);
    document.addEventListener('visibilitychange', this.onVisibilityChangeBound);
  }

  unmount(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    window.removeEventListener('resize', this.onResizeBound);
    window.removeEventListener('beforeunload', this.onBeforeUnloadBound);
    document.removeEventListener('visibilitychange', this.onVisibilityChangeBound);
    this.chatSidebar.unmount();
    this.world.setViewportMargins({ left: 0, right: 0, top: 0, bottom: 0 });
    this.container.innerHTML = '';
  }

  private getSelfParticipant(snap: RoomSnapshot | null = this.snapshot): ParticipantState | undefined {
    if (!snap || !this.studentId) return undefined;
    return snap.participants.find((p) => p.id === this.studentId);
  }

  handleSnapshot(snapshot: RoomSnapshot): void {
    this.snapshot = snapshot;
    paiBank.setCustomContent(snapshot.customElements, snapshot.customQuestions);
    this.world.setElements(paiBank.getAllElements());
    this.world.syncPeers(snapshot.participants, this.studentId);

    const self = this.getSelfParticipant(snapshot);
    if (self) {
      this.isReady = self.isReady;
    }

    // If teacher returned room to lobby while student was in game / reflection
    if (snapshot.mission.status === 'lobby' && this.screen === 'playing' && !this.showReflectionModal) {
      this.screen = 'schoolyard';
      this.world.setViewMode('schoolyard');
      this.world.syncPeers(snapshot.participants, this.studentId);
      this.persistStudentSession();
      this.onToast('Guru mengembalikan ruang kelas ke Halaman Sekolah.');
      this.render();
      return;
    }

    // Always update mounted chat sidebar surgically without losing input focus
    this.chatSidebar.updateMessages(snapshot);

    if (this.screen === 'schoolyard') {
      this.updateSchoolyardLiveRegions(snapshot);
    } else if (this.showMiniLeaderboard || this.showBuffModal) {
      this.render();
    } else if (this.screen === 'login') {
      this.updateMarqueeOnly(snapshot.testimonials);
    } else if (this.screen === 'playing') {
      const rankEl = this.container.querySelector<HTMLElement>('#hud-my-rank');
      if (rankEl && self) {
        rankEl.textContent = `#${self.rank}`;
      }
    }
  }

  handleJoined(id: string, snapshot: RoomSnapshot): void {
    this.studentId = id;
    this.snapshot = snapshot;
    if (snapshot.roomCode) this.roomCode = snapshot.roomCode;
    this.chatSidebar.setOptions({
      selfId: id,
      senderName: this.nama || 'Peserta',
      senderKelas: this.kelas,
    });
    this.world.syncPeers(snapshot.participants, this.studentId);

    // Sync current screen's activity cleanly
    if (this.screen === 'schoolyard') {
      this.updateSchoolyardLiveRegions(snapshot);
      this.chatSidebar.updateMessages(snapshot);
    } else if (this.screen === 'avatar' && this.avatarChatOpen) {
      this.chatSidebar.updateMessages(snapshot);
    }

    const self = this.getSelfParticipant(snapshot);
    if (snapshot.mission.status === 'playing' && self?.approvedForMission && this.screen !== 'playing') {
      this.beginMissionGame();
    }
  }

  handleJoinError(reason: string): void {
    soundFX.playWrong();
    this.onToast(reason);
    const errEl = this.container.querySelector<HTMLElement>('#student-login-err');
    if (errEl) {
      errEl.textContent = reason;
      errEl.classList.remove('hidden');
    }
  }

  handleMissionStarted(snapshot: RoomSnapshot): void {
    this.snapshot = snapshot;
    const self = this.getSelfParticipant(snapshot);
    // Strict admin-approval gate: only enter gameplay when approved by teacher
    if (
      self?.approvedForMission &&
      (this.screen === 'schoolyard' || this.screen === 'avatar' || this.screen === 'playing')
    ) {
      this.beginMissionGame();
    } else if (this.screen === 'schoolyard') {
      this.updateSchoolyardLiveRegions(snapshot);
      this.onToast('Misi telah dimulai oleh Guru! Menunggu persetujuan Guru untuk bergabung.');
    }
  }

  handleStudentApproved(participantId: string, snapshot: RoomSnapshot): void {
    this.snapshot = snapshot;
    if (participantId === this.studentId && snapshot.mission.status === 'playing') {
      this.onToast('Guru telah menyetujui kamu masuk ke arena misi!');
      this.beginMissionGame();
    } else if (this.screen === 'schoolyard') {
      this.updateSchoolyardLiveRegions(snapshot);
    }
  }

  handleMissionEnded(snapshot: RoomSnapshot): void {
    this.snapshot = snapshot;
    if (this.screen === 'playing') {
      soundFX.playLevelUp();
      this.showBuffModal = false;
      this.showReflectionModal = true;
      this.reflectionSubmitted = false;
      this.persistStudentSession();
      this.render();
    } else if (this.screen === 'schoolyard') {
      this.updateSchoolyardLiveRegions(snapshot);
    }
  }

  handleChatMessage(message: ChatMessage, snapshot: RoomSnapshot): void {
    this.snapshot = snapshot;
    this.chatSidebar.updateMessages(snapshot);

    // Show floating 3D speech bubble in Schoolyard above the speaking student's avatar
    if (this.screen === 'schoolyard' && message.senderRole === 'student') {
      this.world.showAvatarChatBubble(message.senderId, this.studentId, message.text);
    }

    const isFromOther = message.senderId !== this.studentId;
    if (isFromOther) {
      const chatVisible =
        (this.screen === 'avatar' && this.avatarChatOpen) ||
        (this.screen === 'schoolyard' && this.schoolyardChatOpen) ||
        (this.screen === 'playing' && this.gameSidebarTab === 'chat');
      if (
        !chatVisible &&
        (this.screen === 'avatar' || this.screen === 'schoolyard' || this.screen === 'playing')
      ) {
        this.unreadChatCount += 1;
        this.updateUnreadBadges();
        if (message.senderRole === 'teacher') {
          this.onToast(`Pesan Guru: ${message.text.slice(0, 72)}`);
        }
      }
    }
  }

  handleChatTyping(senderName: string, senderId: string): void {
    this.chatSidebar.showTyping(senderName, senderId);
  }

  handleChatRejected(reason: string): void {
    soundFX.playWrong();
    this.onToast(reason);
  }

  handleBuffAttacked(payload: {
    attackerName: string;
    targetId: string;
    targetName: string;
    amount: number;
  }): void {
    if (payload.targetId === this.studentId) {
      this.quiz.receiveSabotage(payload.amount);
      soundFX.playSabotage();
      this.onToast(`${payload.attackerName} memakai Buff Serangan! Skormu berkurang -${payload.amount} poin!`);
      if (this.screen === 'playing') this.render();
    } else if (this.screen === 'playing') {
      this.onToast(`${payload.attackerName} menyerang ${payload.targetName} (-${payload.amount} poin)!`);
    }
  }

  private updateUnreadBadges(): void {
    const ids = ['#av-chat-badge', '#sy-chat-badge', '#game-chat-badge'];
    for (const sel of ids) {
      const el = this.container.querySelector<HTMLElement>(sel);
      if (!el) continue;
      if (this.unreadChatCount > 0) {
        el.textContent = String(this.unreadChatCount);
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  }

  private startTimerLoop(): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.tickInterval = setInterval(() => {
      if (this.screen !== 'playing' || this.showReflectionModal || this.showBuffModal) return;

      // Update game timer from teacher-controlled mission
      const endsAt = this.snapshot?.mission.endsAt ?? null;
      const gTimerEl = this.container.querySelector<HTMLElement>('#hud-game-timer');
      if (endsAt && gTimerEl) {
        const remSec = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        const mm = String(Math.floor(remSec / 60)).padStart(2, '0');
        const ss = String(remSec % 60).padStart(2, '0');
        gTimerEl.textContent = `${mm}:${ss}`;
      }

      // Update per-question countdown bar
      if (!this.awaitingNext && !this.waitingForDiceRoll && this.quiz.currentQuestion) {
        const rem = this.quiz.getRemainingSeconds();
        const pct = Math.max(0, Math.min(100, (rem / this.quiz.questionDurationSec) * 100));
        const bar = this.container.querySelector<HTMLElement>('#q-timer-bar');
        const txt = this.container.querySelector<HTMLElement>('#q-timer-text');
        if (bar) {
          bar.style.width = `${pct}%`;
          bar.style.background = rem < 6 ? '#ef4444' : rem < 12 ? '#f59e0b' : '#38bdf8';
        }
        if (txt) txt.textContent = `${Math.ceil(rem)} dtk`;

        if (rem <= 0) {
          this.submitAnswer(true);
        }
      }
    }, 150);
  }

  private beginMissionGame(): void {
    this.openMaterialElementId = null;
    this.showBuffModal = false;
    this.showReflectionModal = false;
    this.reflectionSubmitted = false;
    this.lastFeedback = null;
    this.selectedIndices = [];
    this.awaitingNext = false;
    this.gameSidebarTab = 'quiz';

    const mission = this.snapshot?.mission;
    const gameId: GameId = mission?.gameId ?? 'puncak_nalar';
    const elementIds =
      mission?.elementIds && mission.elementIds.length > 0
        ? mission.elementIds
        : paiBank.getAllElements().map((e) => e.id);
    const qDur = mission?.questionDurationSec ?? 25;

    this.quiz.reset({ gameId, elementIds, questionDurationSec: qDur });
    this.screen = 'playing';
    this.world.setViewMode('minigame', gameId);
    if (this.snapshot) {
      this.world.syncPeers(this.snapshot.participants, this.studentId);
    }

    if (gameId === 'board_adventure') {
      this.waitingForDiceRoll = true;
      this.lastDiceNumber = 0;
      this.quiz.currentQuestion = null;
      this.world.setQuestionVisuals(null, []);
    } else {
      this.waitingForDiceRoll = false;
      this.loadNextQuestion();
    }

    soundFX.playLevelUp();
    this.persistStudentSession();
    this.render();
  }

  private loadNextQuestion(preferredType?: QuestionType): void {
    const q = this.quiz.nextQuestion(preferredType);
    this.selectedIndices = [];
    this.awaitingNext = false;
    this.lastFeedback = null;
    this.world.setQuestionVisuals(q, []);
    this.persistStudentSession();
  }

  private handleRollDice(): void {
    if (!this.waitingForDiceRoll) return;
    soundFX.playDiceRoll();
    const rolled = 1 + Math.floor(Math.random() * 6);
    this.lastDiceNumber = rolled;
    this.world.rollDiceVisual(rolled);

    const nextTileMod = (this.quiz.progressValue + rolled) % 3;
    const qType: QuestionType = nextTileMod === 0 ? 'PG' : nextTileMod === 1 ? 'PGK' : 'BS';
    this.waitingForDiceRoll = false;
    this.loadNextQuestion(qType);
    this.onToast(
      `Dadu keluar angka ${rolled}! Tantangan petak: ${qType === 'PG' ? 'Biru (PG)' : qType === 'PGK' ? 'Ungu (PGK Bonus)' : 'Kuning (Benar/Salah)'}`
    );
    this.render();
  }

  private switchPortalDimension(diff: DifficultyLevel): void {
    soundFX.playJump();
    this.quiz.setPortalDimension(diff);
    this.world.setActivePortal(diff);
    this.loadNextQuestion();
    this.onToast(`Berpindah ke Dimensi ${diff.toUpperCase()}!`);
    this.render();
  }

  private handleOptionInteraction(idx: number): void {
    const q = this.quiz.currentQuestion;
    if (!q || this.awaitingNext) return;
    soundFX.playClick();

    if (q.type === 'PGK') {
      const pos = this.selectedIndices.indexOf(idx);
      if (pos >= 0) this.selectedIndices.splice(pos, 1);
      else this.selectedIndices.push(idx);
      this.world.setQuestionVisuals(q, this.selectedIndices);
      this.render();
    } else {
      this.selectedIndices = [idx];
      this.submitAnswer(false, idx);
    }
  }

  private submitAnswer(timedOut = false, chosenSingleIdx?: number): void {
    if (!this.quiz.currentQuestion || this.awaitingNext) return;
    this.awaitingNext = true;

    const result = this.quiz.evaluate(this.selectedIndices, timedOut);
    this.lastFeedback = {
      isCorrect: result.isCorrect,
      delta: result.pointsDelta,
      text: timedOut
        ? `Waktu habis! ${result.explanation}`
        : result.isCorrect
          ? `Benar! (+${result.pointsDelta} poin) ${result.explanation}`
          : `Kurang tepat (${result.pointsDelta} poin). ${result.explanation}`,
    };

    if (result.isCorrect) {
      if (this.quiz.gameId === 'grand_prix') soundFX.playTurbo();
      else if (this.quiz.gameId === 'edu_craft') soundFX.playBuild();
      else if (this.quiz.gameId === 'astro_scanner') soundFX.playScan();
      else soundFX.playCorrect();
    } else {
      soundFX.playWrong();
    }

    if (result.levelChanged === 'up') {
      soundFX.playLevelUp();
      this.onToast(`Naik Level Kesukaran ke ${result.newLevel.toUpperCase()}!`);
    }

    this.world.setProgressAndFeedback(
      this.quiz.progressValue,
      result.isCorrect,
      chosenSingleIdx ?? this.selectedIndices[0]
    );

    if (this.studentId) {
      realtimeClient.syncProgress({
        id: this.studentId,
        score: this.quiz.score,
        level: this.quiz.level,
        streak: this.quiz.streak,
        maxStreak: this.quiz.maxStreak,
        wrongStreak: this.quiz.wrongStreak,
        correctCount: this.quiz.correctCount,
        wrongCount: this.quiz.wrongCount,
        activeBuff: this.quiz.activeBuff,
        progressValue: this.quiz.progressValue,
        progressLabel: this.quiz.progressLabel,
        answerEntry: result.answerEntry,
      });
    }

    this.persistStudentSession();
    this.render();

    setTimeout(() => {
      if (this.screen !== 'playing' || this.showReflectionModal) return;
      if (result.triggeredBuffChoice) {
        soundFX.playBuffFanfare();
        this.showBuffModal = true;
        this.render();
        return;
      }
      this.advanceToNextTurn();
    }, 1550);
  }

  private advanceToNextTurn(): void {
    if (this.quiz.gameId === 'board_adventure') {
      this.waitingForDiceRoll = true;
      this.awaitingNext = false;
      this.quiz.currentQuestion = null;
      this.world.setQuestionVisuals(null, []);
    } else {
      this.loadNextQuestion();
    }
    this.render();
  }

  /**
   * Keeps the 3D scene centered precisely inside the remaining unobstructed viewport area
   * across Login, Avatar Studio, Schoolyard, and Active Minigame screens.
   */
  private syncCameraCentering(): void {
    requestAnimationFrame(() => {
      if (this.screen === 'login') {
        this.world.setViewportMargins({ left: 0, right: 0, top: 0, bottom: 0 });
        return;
      }

      if (this.screen === 'avatar') {
        const aside = this.container.querySelector<HTMLElement>('#avatar-right-aside');
        if (aside && window.innerWidth >= 768) {
          const rect = aside.getBoundingClientRect();
          this.world.setViewportMargins({ left: 0, right: rect.width, top: 24, bottom: 24 });
        } else {
          this.world.setViewportMargins({ left: 0, right: 0, top: 48, bottom: Math.round(window.innerHeight * 0.45) });
        }
        return;
      }

      if (this.screen === 'schoolyard') {
        const rightSidebar = this.container.querySelector<HTMLElement>('#sy-right-sidebar');
        const topBar = this.container.querySelector<HTMLElement>('#sy-topbar');
        const bottomDock = this.container.querySelector<HTMLElement>('#sy-bottom-dock');
        const rightW =
          this.schoolyardChatOpen && rightSidebar && window.innerWidth >= 820
            ? rightSidebar.getBoundingClientRect().width
            : 0;
        const topH = topBar ? topBar.getBoundingClientRect().height : 56;
        const bottomH = bottomDock ? Math.min(110, bottomDock.getBoundingClientRect().height) : 76;
        this.world.setViewportMargins({ left: 0, right: rightW, top: topH, bottom: bottomH });
        return;
      }

      if (this.screen === 'playing') {
        const topBar = this.container.querySelector<HTMLElement>('.game-topbar');
        const leftPanel = this.container.querySelector<HTMLElement>('.game-left-panel');
        const topH = topBar ? topBar.getBoundingClientRect().height : 60;
        if (window.innerWidth > 820) {
          const leftW = leftPanel ? leftPanel.getBoundingClientRect().width : 280;
          this.world.setViewportMargins({ left: leftW, right: 0, top: topH, bottom: 0 });
        } else {
          const bottomH = leftPanel ? leftPanel.getBoundingClientRect().height : 240;
          this.world.setViewportMargins({ left: 0, right: 0, top: topH, bottom: bottomH });
        }
      }
    });
  }

  private render(): void {
    this.chatSidebar.unmount();

    if (this.screen === 'login') {
      this.renderLoginScreen();
    } else if (this.screen === 'avatar') {
      this.renderAvatarStudio();
    } else if (this.screen === 'schoolyard') {
      this.renderSchoolyardHUD();
    } else {
      this.renderPlayingHUD();
    }

    this.syncCameraCentering();
  }

  // =====================================================================
  // 1. LOGIN SCREEN + PERMANENT MARQUEE TESTIMONIALS
  // =====================================================================
  private renderLoginScreen(): void {
    const testimonials = this.snapshot?.testimonials ?? [];

    this.container.innerHTML = `
      <div class="fixed inset-0 flex flex-col justify-between p-4 md:p-6 pointer-events-none">
        <!-- Top Brand Header -->
        <div class="flex items-center justify-between gap-3 pointer-events-auto">
          <div class="px-4 py-2 rounded-2xl bg-[#0f172a]/92 border border-amber-400/40 flex items-center gap-3 shadow-xl">
            <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-400 to-sky-500 text-slate-950 font-display font-bold text-lg flex items-center justify-center">
              PAI
            </div>
            <div>
              <div class="font-display font-bold text-base md:text-lg text-amber-300 leading-tight">
                PAI Nusantara 3D
              </div>
              <div class="text-[11px] text-slate-300">Edu-Game & Kuis AKM · SD Kelas 1–6</div>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button id="btn-login-mute" class="btn-secondary text-xs">${soundFX.muted ? 'Audio: Mati' : 'Audio: Aktif'}</button>
            <button id="btn-login-xr" class="btn-secondary text-xs text-sky-300">Mode XR</button>
          </div>
        </div>

        <!-- Center Login Card -->
        <div class="flex-1 flex items-center justify-center my-2">
          <div class="interactive-layer w-full max-w-md bg-[#0f172a]/95 border-2 border-amber-400/50 rounded-3xl p-6 shadow-2xl">
            <div class="text-center mb-4">
              <h1 class="font-display font-bold text-2xl text-white">Selamat Datang di Sekolah 3D!</h1>
              <p class="text-xs text-slate-300 mt-1">
                5 Elemen PAI · 150 Soal AKM · Dipandu Langsung oleh Guru
              </p>
            </div>

            <!-- Role Switcher Tabs -->
            <div class="grid grid-cols-2 gap-2 p-1 rounded-xl bg-slate-900 border border-slate-700 mb-4">
              <button id="tab-student" class="py-2 rounded-lg text-sm font-bold cursor-pointer transition ${
                this.loginTab === 'student'
                  ? 'bg-emerald-500 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }">Akun Peserta</button>
              <button id="tab-teacher" class="py-2 rounded-lg text-sm font-bold cursor-pointer transition ${
                this.loginTab === 'teacher'
                  ? 'bg-amber-400 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }">Akun Guru</button>
            </div>

            ${
              this.loginTab === 'student'
                ? `<form id="form-student-login" class="space-y-3">
                    <div>
                      <label class="block text-xs font-bold text-amber-300 mb-1">Enter Code (Kode Ruang dari Guru)</label>
                      <input
                        name="roomCode"
                        required
                        maxlength="12"
                        autocomplete="off"
                        class="input-dark uppercase font-display font-bold tracking-widest text-center text-base border-amber-400/60"
                        placeholder="Masukkan Kode Ruang (cth: PAI2026)"
                        value="${this.esc(this.roomCode)}"
                      />
                    </div>
                    <div>
                      <label class="block text-xs font-semibold text-slate-300 mb-1">Nama Peserta</label>
                      <input name="nama" required class="input-dark" placeholder="Contoh: Aisyah Putri" value="${this.esc(this.nama)}" />
                    </div>
                    <div class="grid grid-cols-3 gap-2.5">
                      <div>
                        <label class="block text-xs font-semibold text-slate-300 mb-1">Kelas</label>
                        <select name="kelas" class="input-dark">
                          ${['1', '2', '3', '4', '5', '6']
                            .map((k) => `<option value="${k}" ${this.kelas === k ? 'selected' : ''}>Kelas ${k}</option>`)
                            .join('')}
                        </select>
                      </div>
                      <div class="col-span-2">
                        <label class="block text-xs font-semibold text-slate-300 mb-1">Nama Sekolah</label>
                        <input name="sekolah" required class="input-dark" placeholder="Contoh: SDN 01 Beji" value="${this.esc(this.sekolah)}" />
                      </div>
                    </div>
                    <div id="student-login-err" class="hidden p-2.5 rounded-xl bg-rose-950/80 border border-rose-500/60 text-xs text-rose-200 font-semibold"></div>
                    <p class="text-[11px] text-slate-400 leading-snug">
                      Samakan Enter Code dengan Guru. Begitu masuk, kehadiranmu langsung terbaca realtime di Dashboard Guru.
                    </p>
                    <button id="btn-student-submit" type="submit" class="btn-primary w-full py-3 text-base mt-1">
                      Masuk Ruang & Buat Avatar Roblox
                    </button>
                  </form>`
                : `<form id="form-teacher-login" class="space-y-3">
                    <div>
                      <label class="block text-xs font-semibold text-slate-300 mb-1">Kode Akun Guru (Admin)</label>
                      <input name="code" required class="input-dark" placeholder="Masukkan kode guru (gpaibeji)" />
                    </div>
                    <div>
                      <label class="block text-xs font-bold text-amber-300 mb-1">Enter Code (Kode Ruang Kelas untuk Murid)</label>
                      <div class="flex gap-2">
                        <input
                          id="inp-teacher-room-code"
                          name="roomCode"
                          required
                          maxlength="12"
                          autocomplete="off"
                          class="input-dark uppercase font-display font-bold tracking-widest text-sm flex-1 border-amber-400/60"
                          placeholder="Cth: PAI2026"
                          value="${this.esc(this.snapshot?.roomCode || this.teacherDraftRoomCode)}"
                        />
                        <button id="btn-teacher-rand-code" type="button" class="btn-secondary text-xs px-3 shrink-0">Acak</button>
                      </div>
                      <p class="text-[10px] text-slate-400 mt-1">Kode ini wajib dimasukkan oleh siswa agar masuk ke sesi yang sama.</p>
                    </div>
                    <div>
                      <label class="block text-xs font-semibold text-slate-300 mb-1">Nama Sekolah</label>
                      <input name="sekolah" required class="input-dark" placeholder="Contoh: SDN 01 Beji" value="${this.esc(this.sekolah)}" />
                    </div>
                    <div id="teacher-login-err" class="hidden p-2.5 rounded-xl bg-rose-950/80 border border-rose-500/60 text-xs text-rose-200 font-semibold"></div>
                    <button id="btn-teacher-submit" type="submit" class="btn-gold w-full py-3 text-base mt-2">
                      Buka Dashboard Guru
                    </button>
                  </form>`
            }
          </div>
        </div>

        <!-- Bottom Running Marquee Testimonials Panel -->
        <div class="interactive-layer bg-[#0f172a]/92 border border-slate-700 rounded-2xl px-4 py-2.5 shadow-xl">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-[11px] font-bold uppercase tracking-wider text-amber-300">
              Papan Testimoni & Refleksi Belajar Siswa
            </span>
            <span class="text-[11px] text-slate-400">${testimonials.length} catatan tersimpan</span>
          </div>
          <div id="login-marquee-box" class="marquee-viewport">
            ${this.buildMarqueeHtml(testimonials)}
          </div>
        </div>
      </div>
    `;

    this.bindLoginEvents();
  }

  private buildMarqueeHtml(items: TestimonialItem[]): string {
    if (items.length === 0) {
      return `<div class="text-xs text-slate-300 py-1">
        Belum ada testimoni. Selesaikan misi permainan dan tuliskan refleksi belajarmu agar tampil di sini secara permanen!
      </div>`;
    }
    const cards = items
      .map(
        (t) => `
      <div class="shrink-0 max-w-xs px-3.5 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs">
        <div class="flex items-center justify-between gap-2 mb-0.5">
          <span class="font-bold text-amber-300 truncate">${this.esc(t.nama)} · Kls ${this.esc(t.kelas)}</span>
          <span class="text-emerald-400 font-bold tabular-nums">${t.skor} pts</span>
        </div>
        <p class="text-slate-200 truncate">"${this.esc(t.refleksi)}"</p>
        <div class="text-[10px] text-slate-400 truncate">${this.esc(t.sekolah)} · ${this.esc(t.gameName)}</div>
      </div>`
      )
      .join('');
    return `<div class="marquee-track">${cards}${cards}</div>`;
  }

  private updateMarqueeOnly(items: TestimonialItem[]): void {
    const box = this.container.querySelector('#login-marquee-box');
    if (box) box.innerHTML = this.buildMarqueeHtml(items);
  }

  private bindLoginEvents(): void {
    this.container.querySelector('#btn-login-mute')?.addEventListener('click', () => {
      soundFX.toggleMute();
      this.render();
    });
    this.container.querySelector('#btn-login-xr')?.addEventListener('click', () => {
      soundFX.playClick();
      this.onToggleXR();
    });
    this.container.querySelector('#tab-student')?.addEventListener('click', () => {
      soundFX.playClick();
      this.loginTab = 'student';
      this.render();
    });
    this.container.querySelector('#tab-teacher')?.addEventListener('click', () => {
      soundFX.playClick();
      this.loginTab = 'teacher';
      this.render();
    });

    const stuForm = this.container.querySelector<HTMLFormElement>('#form-student-login');
    stuForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this.submittingLogin) return;
      soundFX.playClick();
      const fd = new FormData(stuForm);
      const enteredCode = String(fd.get('roomCode') || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, '')
        .slice(0, 12);
      this.nama = String(fd.get('nama') || '').trim();
      this.kelas = String(fd.get('kelas') || '5');
      this.sekolah = String(fd.get('sekolah') || '').trim();
      const errEl = this.container.querySelector<HTMLElement>('#student-login-err');
      const submitBtn = this.container.querySelector<HTMLButtonElement>('#btn-student-submit');

      if (!enteredCode || enteredCode.length < 3) {
        if (errEl) {
          errEl.textContent = 'Enter Code (Kode Ruang) wajib diisi minimal 3 karakter.';
          errEl.classList.remove('hidden');
        }
        soundFX.playWrong();
        return;
      }
      if (!this.nama || !this.sekolah) return;

      this.submittingLogin = true;
      if (errEl) errEl.classList.add('hidden');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Memverifikasi Kode Ruang…';
      }

      const candidateId =
        this.studentId ?? `stu_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      try {
        // Strict server roomCode verification + immediate realtime broadcast to Teacher Dashboard
        const res = await realtimeClient.joinStudent({
          id: candidateId,
          roomCode: enteredCode,
          nama: this.nama,
          kelas: this.kelas,
          sekolah: this.sekolah,
          avatar: this.avatar,
          activity: 'avatar',
        });

        if (!res.ok) {
          soundFX.playWrong();
          if (errEl) {
            errEl.textContent =
              res.error || 'Kode Ruang tidak cocok! Pastikan sama dengan Kode Ruang Guru.';
            errEl.classList.remove('hidden');
          }
          return;
        }

        this.studentId = res.id ?? candidateId;
        this.roomCode = res.snapshot?.roomCode || enteredCode;
        if (res.snapshot) this.snapshot = res.snapshot;
        this.world.setPlayerIdentity(this.nama, this.kelas, this.avatar);
        this.chatSidebar.setOptions({
          senderName: this.nama,
          senderKelas: this.kelas,
          selfId: this.studentId,
        });

        this.screen = 'avatar';
        this.world.setViewMode('avatar_studio');
        this.persistStudentSession();
        this.render();
        soundFX.playCorrect();
        this.onToast(
          `Berhasil masuk Ruang ${this.roomCode}! Kehadiranmu langsung terbaca Guru.`
        );
      } finally {
        this.submittingLogin = false;
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Masuk Ruang & Buat Avatar Roblox';
        }
      }
    });

    this.container.querySelector('#btn-teacher-rand-code')?.addEventListener('click', () => {
      soundFX.playClick();
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let suffix = '';
      for (let i = 0; i < 4; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
      this.teacherDraftRoomCode = `PAI-${suffix}`;
      const inp = this.container.querySelector<HTMLInputElement>('#inp-teacher-room-code');
      if (inp) inp.value = this.teacherDraftRoomCode;
    });

    const tchForm = this.container.querySelector<HTMLFormElement>('#form-teacher-login');
    tchForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this.submittingLogin) return;
      soundFX.playClick();
      const fd = new FormData(tchForm);
      const code = String(fd.get('code') || '').trim();
      const sekolah = String(fd.get('sekolah') || '').trim();
      const roomCode =
        String(fd.get('roomCode') || '')
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9-]/g, '')
          .slice(0, 12) || 'PAI2026';
      this.sekolah = sekolah;
      this.teacherDraftRoomCode = roomCode;

      const err = this.container.querySelector<HTMLElement>('#teacher-login-err');
      const submitBtn = this.container.querySelector<HTMLButtonElement>('#btn-teacher-submit');

      if (code.toLowerCase() !== 'gpaibeji' || sekolah.length < 2 || roomCode.length < 3) {
        if (err) {
          err.textContent =
            'Kode guru harus "gpaibeji", Enter Code minimal 3 karakter, dan nama sekolah wajib diisi.';
          err.classList.remove('hidden');
        }
        soundFX.playWrong();
        return;
      }

      this.submittingLogin = true;
      if (err) err.classList.add('hidden');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Membuka Ruang Guru…';
      }

      try {
        const res = await realtimeClient.loginTeacher(code, sekolah, roomCode);
        if (!res.ok) {
          soundFX.playWrong();
          if (err) {
            err.textContent = res.error || 'Kode guru tidak valid.';
            err.classList.remove('hidden');
          }
          return;
        }
        this.onTeacherLoggedIn(
          res.sekolah || sekolah,
          res.roomCode || roomCode,
          res.snapshot ?? this.snapshot
        );
      } finally {
        this.submittingLogin = false;
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Buka Dashboard Guru';
        }
      }
    });
  }

  // =====================================================================
  // 2. AVATAR CUSTOMIZER STUDIO (+ FLOATING LIVE CHAT DRAWER)
  // =====================================================================
  private renderAvatarStudio(): void {
    const a = this.avatar;
    this.container.innerHTML = `
      <div class="fixed inset-0 grid grid-cols-1 md:grid-cols-12 pointer-events-none">
        <!-- Left 3D Turntable Viewport -->
        <div class="md:col-span-6 lg:col-span-7 flex flex-col justify-between p-4 relative">
          <div class="pointer-events-auto flex flex-wrap items-center justify-between gap-2">
            <div class="px-4 py-2 rounded-2xl bg-[#0f172a]/92 border border-sky-400/40">
              <div class="flex items-center gap-2">
                <div class="font-display font-bold text-lg text-amber-300">Studio Avatar Roblox PAI</div>
                <span class="px-2 py-0.5 rounded bg-indigo-950 border border-indigo-400/50 text-[10px] font-bold text-amber-300 tracking-wider">${this.esc(this.roomCode || 'PAI2026')}</span>
              </div>
              <div class="text-xs text-slate-300">${this.esc(this.nama)} · Kelas ${this.esc(this.kelas)} · ${this.esc(this.sekolah)}</div>
            </div>
            <div class="flex items-center gap-1.5">
              <button id="btn-av-toggle-chat" class="btn-secondary text-xs relative">
                ${this.avatarChatOpen ? 'Tutup Live Chat' : 'Live Chat'}
                <span id="av-chat-badge" class="${this.unreadChatCount > 0 && !this.avatarChatOpen ? '' : 'hidden'} ml-1 px-1.5 py-0.5 rounded-full bg-amber-400 text-slate-950 font-bold text-[10px]">${this.unreadChatCount}</span>
              </button>
              <button id="btn-back-login" class="btn-secondary text-xs text-rose-300">Keluar</button>
            </div>
          </div>

          ${
            this.avatarChatOpen
              ? `<div id="avatar-chat-drawer" class="interactive-layer absolute left-4 top-20 bottom-20 w-80 max-w-[85vw] bg-[#0f172a]/96 border border-emerald-400/45 rounded-2xl overflow-hidden shadow-2xl z-20 flex flex-col"></div>`
              : ''
          }

          <div class="pointer-events-auto flex flex-wrap items-center justify-center gap-2 mb-2">
            <button id="btn-rot-left" class="btn-secondary text-xs">⟲ Putar Kiri</button>
            <button id="btn-preset-muslim" class="btn-secondary text-xs text-sky-300">Preset Santri Muslim</button>
            <button id="btn-preset-muslimah" class="btn-secondary text-xs text-pink-300">Preset Santri Muslimah</button>
            <button id="btn-rot-right" class="btn-secondary text-xs">Putar Kanan ⟳</button>
          </div>
        </div>

        <!-- Right Customization Panel -->
        <aside id="avatar-right-aside" class="md:col-span-6 lg:col-span-5 interactive-layer bg-[#0f172a]/96 border-l border-slate-700 p-4 flex flex-col overflow-hidden max-h-screen">
          <div class="flex-1 overflow-y-auto space-y-4 pr-1 text-xs">
            <!-- Skin Color -->
            <div>
              <div class="font-bold text-amber-300 mb-1.5">1. Warna Kulit</div>
              <div class="flex flex-wrap gap-2">
                ${AVATAR_OPTIONS.skinColors
                  .map(
                    (c) => `<button data-av-key="skinColor" data-av-val="${c.id}" class="js-av-opt w-8 h-8 rounded-full border-2 cursor-pointer ${
                      a.skinColor === c.id ? 'border-amber-400 scale-110' : 'border-slate-600'
                    }" style="background:${c.id}" title="${c.label}"></button>`
                  )
                  .join('')}
              </div>
            </div>

            <!-- Hair / Peci / Hijab / Hat -->
            <div>
              <div class="font-bold text-amber-300 mb-1.5">2. Rambut / Peci / Hijab / Topi</div>
              <div class="grid grid-cols-2 gap-1.5 mb-2">
                ${AVATAR_OPTIONS.hairStyles
                  .map(
                    (h) => `<button data-av-key="hairStyle" data-av-val="${h.id}" class="js-av-opt px-2.5 py-1.5 rounded-lg border text-left cursor-pointer ${
                      a.hairStyle === h.id
                        ? 'bg-emerald-900/70 border-emerald-400 text-white font-bold'
                        : 'bg-slate-900 border-slate-700 text-slate-300'
                    }">${h.label}</button>`
                  )
                  .join('')}
              </div>
              <div class="flex flex-wrap gap-1.5">
                ${AVATAR_OPTIONS.hairColors
                  .map(
                    (c) => `<button data-av-key="hairColor" data-av-val="${c.id}" class="js-av-opt w-6 h-6 rounded-full border-2 cursor-pointer ${
                      a.hairColor === c.id ? 'border-amber-400 scale-110' : 'border-slate-600'
                    }" style="background:${c.id}" title="${c.label}"></button>`
                  )
                  .join('')}
              </div>
            </div>

            <!-- Eyes, Nose, Mouth -->
            <div class="grid grid-cols-3 gap-2">
              <div>
                <div class="font-bold text-amber-300 mb-1">3. Mata</div>
                <select id="sel-eye" class="input-dark text-xs py-1.5">
                  ${AVATAR_OPTIONS.eyeStyles
                    .map((e) => `<option value="${e.id}" ${a.eyeStyle === e.id ? 'selected' : ''}>${e.label}</option>`)
                    .join('')}
                </select>
              </div>
              <div>
                <div class="font-bold text-amber-300 mb-1">4. Hidung</div>
                <select id="sel-nose" class="input-dark text-xs py-1.5">
                  ${AVATAR_OPTIONS.noseStyles
                    .map((n) => `<option value="${n.id}" ${a.noseStyle === n.id ? 'selected' : ''}>${n.label}</option>`)
                    .join('')}
                </select>
              </div>
              <div>
                <div class="font-bold text-amber-300 mb-1">5. Mulut</div>
                <select id="sel-mouth" class="input-dark text-xs py-1.5">
                  ${AVATAR_OPTIONS.mouthStyles
                    .map((m) => `<option value="${m.id}" ${a.mouthStyle === m.id ? 'selected' : ''}>${m.label}</option>`)
                    .join('')}
                </select>
              </div>
            </div>

            <!-- Shirt / Pakaian -->
            <div>
              <div class="font-bold text-amber-300 mb-1.5">6. Kaos / Baju / Seragam</div>
              <div class="grid grid-cols-2 gap-1.5 mb-2">
                ${AVATAR_OPTIONS.shirtStyles
                  .map(
                    (s) => `<button data-av-key="shirtStyle" data-av-val="${s.id}" class="js-av-opt px-2.5 py-1.5 rounded-lg border text-left cursor-pointer ${
                      a.shirtStyle === s.id
                        ? 'bg-sky-900/70 border-sky-400 text-white font-bold'
                        : 'bg-slate-900 border-slate-700 text-slate-300'
                    }">${s.label}</button>`
                  )
                  .join('')}
              </div>
              <div class="flex flex-wrap gap-1.5">
                ${AVATAR_OPTIONS.shirtColors
                  .map(
                    (c) => `<button data-av-key="shirtColor" data-av-val="${c}" class="js-av-opt w-6 h-6 rounded-full border-2 cursor-pointer ${
                      a.shirtColor === c ? 'border-amber-400 scale-110' : 'border-slate-600'
                    }" style="background:${c}"></button>`
                  )
                  .join('')}
              </div>
            </div>

            <!-- Pants / Rok -->
            <div>
              <div class="font-bold text-amber-300 mb-1.5">7. Celana / Rok</div>
              <div class="grid grid-cols-2 gap-1.5 mb-2">
                ${AVATAR_OPTIONS.pantsStyles
                  .map(
                    (p) => `<button data-av-key="pantsStyle" data-av-val="${p.id}" class="js-av-opt px-2.5 py-1.5 rounded-lg border text-left cursor-pointer ${
                      a.pantsStyle === p.id
                        ? 'bg-sky-900/70 border-sky-400 text-white font-bold'
                        : 'bg-slate-900 border-slate-700 text-slate-300'
                    }">${p.label}</button>`
                  )
                  .join('')}
              </div>
              <div class="flex flex-wrap gap-1.5">
                ${AVATAR_OPTIONS.pantsColors
                  .map(
                    (c) => `<button data-av-key="pantsColor" data-av-val="${c}" class="js-av-opt w-6 h-6 rounded-full border-2 cursor-pointer ${
                      a.pantsColor === c ? 'border-amber-400 scale-110' : 'border-slate-600'
                    }" style="background:${c}"></button>`
                  )
                  .join('')}
              </div>
            </div>

            <!-- Shoes & Bag -->
            <div class="grid grid-cols-2 gap-3">
              <div>
                <div class="font-bold text-amber-300 mb-1">8. Sepatu</div>
                <select id="sel-shoe" class="input-dark text-xs py-1.5 mb-1.5">
                  ${AVATAR_OPTIONS.shoeStyles
                    .map((s) => `<option value="${s.id}" ${a.shoeStyle === s.id ? 'selected' : ''}>${s.label}</option>`)
                    .join('')}
                </select>
                <div class="flex flex-wrap gap-1">
                  ${AVATAR_OPTIONS.shoeColors
                    .map(
                      (c) => `<button data-av-key="shoeColor" data-av-val="${c}" class="js-av-opt w-5 h-5 rounded-full border cursor-pointer ${
                        a.shoeColor === c ? 'border-amber-400 scale-110' : 'border-slate-600'
                      }" style="background:${c}"></button>`
                    )
                    .join('')}
                </div>
              </div>
              <div>
                <div class="font-bold text-amber-300 mb-1">9. Tas / Jetpack</div>
                <select id="sel-bag" class="input-dark text-xs py-1.5 mb-1.5">
                  ${AVATAR_OPTIONS.bagStyles
                    .map((b) => `<option value="${b.id}" ${a.bagStyle === b.id ? 'selected' : ''}>${b.label}</option>`)
                    .join('')}
                </select>
                <div class="flex flex-wrap gap-1">
                  ${AVATAR_OPTIONS.bagColors
                    .map(
                      (c) => `<button data-av-key="bagColor" data-av-val="${c}" class="js-av-opt w-5 h-5 rounded-full border cursor-pointer ${
                        a.bagColor === c ? 'border-amber-400 scale-110' : 'border-slate-600'
                      }" style="background:${c}"></button>`
                    )
                    .join('')}
                </div>
              </div>
            </div>
          </div>

          <div class="pt-3 mt-3 border-t border-slate-700 shrink-0">
            <button id="btn-enter-schoolyard" class="btn-gold w-full py-3 text-base">
              Simpan Avatar & Berkumpul di Halaman Sekolah
            </button>
          </div>
        </aside>
      </div>
    `;

    const avChatMount = this.container.querySelector<HTMLElement>('#avatar-chat-drawer');
    if (avChatMount) {
      this.unreadChatCount = 0;
      this.chatSidebar.setOptions({
        role: 'student',
        selfId: this.studentId,
        senderName: this.nama || 'Peserta',
        senderKelas: this.kelas,
      });
      this.chatSidebar.mount(avChatMount, this.snapshot);
    }

    this.bindAvatarEvents();
  }

  private bindAvatarEvents(): void {
    this.container.querySelector('#btn-av-toggle-chat')?.addEventListener('click', () => {
      soundFX.playClick();
      this.avatarChatOpen = !this.avatarChatOpen;
      if (this.avatarChatOpen) this.unreadChatCount = 0;
      this.render();
    });

    this.container.querySelector('#btn-back-login')?.addEventListener('click', () => {
      soundFX.playClick();
      realtimeClient.leaveStudent(this.studentId);
      clearSession();
      realtimeClient.clearStudentSession();
      this.screen = 'login';
      this.world.setViewMode('title');
      this.render();
    });
    this.container.querySelector('#btn-rot-left')?.addEventListener('click', () => {
      this.world.rotateStudioAvatar(-0.55);
    });
    this.container.querySelector('#btn-rot-right')?.addEventListener('click', () => {
      this.world.rotateStudioAvatar(0.55);
    });
    this.container.querySelector('#btn-preset-muslim')?.addEventListener('click', () => {
      soundFX.playClick();
      this.avatar = { ...DEFAULT_AVATAR_MUSLIM };
      this.world.updateAvatarPreview(this.avatar);
      this.persistStudentSession();
      this.render();
    });
    this.container.querySelector('#btn-preset-muslimah')?.addEventListener('click', () => {
      soundFX.playClick();
      this.avatar = { ...DEFAULT_AVATAR_MUSLIMAH };
      this.world.updateAvatarPreview(this.avatar);
      this.persistStudentSession();
      this.render();
    });

    this.container.querySelectorAll<HTMLButtonElement>('.js-av-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundFX.playClick();
        const key = btn.dataset.avKey as keyof AvatarConfig;
        const val = btn.dataset.avVal!;
        (this.avatar as unknown as Record<string, string>)[key] = val;
        this.avatar.preset = 'custom';
        this.world.updateAvatarPreview(this.avatar);
        this.persistStudentSession();
        this.render();
      });
    });

    const bindSelect = (id: string, key: keyof AvatarConfig) => {
      const sel = this.container.querySelector<HTMLSelectElement>(id);
      sel?.addEventListener('change', () => {
        soundFX.playClick();
        (this.avatar as unknown as Record<string, string>)[key] = sel.value;
        this.world.updateAvatarPreview(this.avatar);
        this.persistStudentSession();
      });
    };
    bindSelect('#sel-eye', 'eyeStyle');
    bindSelect('#sel-nose', 'noseStyle');
    bindSelect('#sel-mouth', 'mouthStyle');
    bindSelect('#sel-shoe', 'shoeStyle');
    bindSelect('#sel-bag', 'bagStyle');

    this.container.querySelector('#btn-enter-schoolyard')?.addEventListener('click', () => {
      soundFX.playLevelUp();
      this.world.setPlayerIdentity(this.nama, this.kelas, this.avatar);
      if (this.studentId) {
        realtimeClient.updateAvatar(this.studentId, this.avatar, 'schoolyard');
      } else {
        this.studentId = `stu_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        void realtimeClient.joinStudent({
          id: this.studentId,
          roomCode: this.roomCode || this.snapshot?.roomCode || 'PAI2026',
          nama: this.nama,
          kelas: this.kelas,
          sekolah: this.sekolah,
          avatar: this.avatar,
          activity: 'schoolyard',
        });
      }
      this.screen = 'schoolyard';
      this.world.setViewMode('schoolyard');
      if (this.snapshot) {
        this.world.syncPeers(this.snapshot.participants, this.studentId);
      }
      this.persistStudentSession();
      this.render();
      this.onToast('Selamat datang di Halaman Sekolah! Berkumpul bersama teman & tunggu persetujuan Guru untuk memulai misi.');
    });
  }

  // =====================================================================
  // 3. SCHOOLYARD GATHERING ARENA + SIDEBAR CHAT + PENGUASAAN MATERI
  // =====================================================================
  private renderSchoolyardHUD(): void {
    const participants = this.snapshot?.participants ?? [];
    const onlinePeers = participants.filter((p) => p.connected);

    this.container.innerHTML = `
      <div class="fixed inset-0 flex pointer-events-none">
        <!-- Main Left/Center 3D Schoolyard Overlay -->
        <div class="flex-1 min-w-0 flex flex-col justify-between p-3 md:p-4">
          <!-- Top Bar -->
          <div id="sy-topbar" class="flex flex-wrap items-center justify-between gap-2 pointer-events-auto">
            <div class="px-3.5 py-2 rounded-2xl bg-[#0f172a]/92 border border-amber-400/45 flex items-center gap-3">
              <div>
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="font-display font-bold text-sm md:text-base text-white">${this.esc(this.nama)}</span>
                  <span class="text-xs text-sky-300 font-normal">· Kls ${this.esc(this.kelas)}</span>
                  <span class="px-1.5 py-0.5 rounded bg-indigo-950 border border-indigo-400/50 text-[10px] font-bold text-amber-300 tracking-wider">KODE: ${this.esc(this.roomCode || this.snapshot?.roomCode || 'PAI2026')}</span>
                </div>
                <div id="sy-online-summary" class="text-[11px] text-slate-300">${this.esc(this.sekolah)} · ${onlinePeers.length} Peserta di Halaman Sekolah</div>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-1.5">
              <button id="btn-open-materi" class="btn-primary text-xs py-2 px-3">Penguasaan Materi PAI</button>
              <button id="btn-edit-avatar" class="btn-secondary text-xs py-2 px-3">Ubah Avatar</button>
              <button id="btn-toggle-sy-chat" class="btn-secondary text-xs py-2 px-3 relative">
                ${this.schoolyardChatOpen ? 'Tutup Live Chat' : 'Live Chat & Teman'}
                <span id="sy-chat-badge" class="${this.unreadChatCount > 0 && !this.schoolyardChatOpen ? '' : 'hidden'} ml-1 px-1.5 py-0.5 rounded-full bg-amber-400 text-slate-950 font-bold text-[10px]">${this.unreadChatCount}</span>
              </button>
              <button id="btn-sy-mute" class="btn-secondary text-xs py-2 px-2.5">${soundFX.muted ? '🔇' : '🔊'}</button>
              <button id="btn-sy-xr" class="btn-secondary text-xs py-2 px-2.5 text-sky-300">XR</button>
              <button id="btn-sy-logout" class="btn-secondary text-xs py-2 px-2.5 text-rose-300">Keluar</button>
            </div>
          </div>

          <!-- Bottom Mission Waiting Dock + 360° Mobile Touch Joystick & Jump -->
          <div id="sy-bottom-dock" class="flex items-end justify-between gap-3">
            <!-- Smooth 360° Touch Joystick + Jump Button -->
            ${this.renderTouchControlsHtml(false, false)}

            <!-- Teacher-Gated Mission Status Banner (NO Solo Mode) -->
            <div id="sy-mission-banner" class="pointer-events-auto flex-1 max-w-xl bg-[#0f172a]/94 border-2 border-amber-400/50 rounded-2xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              ${this.buildSchoolyardMissionBannerHtml()}
            </div>
          </div>
        </div>

        <!-- Right Collapsible Schoolyard Sidebar: Online Classmates + Moderated Safe Chat -->
        ${
          this.schoolyardChatOpen
            ? `<aside id="sy-right-sidebar" class="interactive-layer w-80 max-w-[88vw] h-full bg-[#0f172a]/96 border-l border-slate-700 flex flex-col shrink-0 shadow-2xl">
                <!-- Classmates Gathered in Arena -->
                <div class="px-3 py-2.5 border-b border-slate-700/80 shrink-0 bg-slate-900/60">
                  <div class="flex items-center justify-between mb-1.5">
                    <span class="font-display font-bold text-xs text-amber-300">Berkumpul di Halaman Sekolah</span>
                    <span id="sy-peer-count" class="text-[11px] font-bold text-emerald-400 tabular-nums">${onlinePeers.length} Online</span>
                  </div>
                  <div id="sy-peer-chips" class="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
                    ${this.buildSchoolyardPeerChipsHtml(onlinePeers)}
                  </div>
                </div>

                <!-- Moderated Live Chat Slot -->
                <div id="sy-chat-mount" class="flex-1 min-h-0"></div>
              </aside>`
            : ''
        }
      </div>

      ${this.openMaterialElementId ? this.renderMaterialModal(this.openMaterialElementId) : ''}
    `;

    // Mount ChatSidebar if open
    const chatMount = this.container.querySelector<HTMLElement>('#sy-chat-mount');
    if (chatMount) {
      this.unreadChatCount = 0;
      this.chatSidebar.setOptions({
        role: 'student',
        selfId: this.studentId,
        senderName: this.nama || 'Peserta',
        senderKelas: this.kelas,
      });
      this.chatSidebar.mount(chatMount, this.snapshot);
    }

    this.bindSchoolyardEvents();
  }

  private buildSchoolyardPeerChipsHtml(onlinePeers: ParticipantState[]): string {
    if (onlinePeers.length === 0) {
      return `<span class="text-[11px] text-slate-400">Menunggu teman sekelas bergabung...</span>`;
    }
    return onlinePeers
      .map((p) => {
        const isMe = p.id === this.studentId;
        const badge = p.isReady
          ? `<span class="text-[9px] px-1 rounded bg-emerald-500 text-slate-950 font-bold">Siap</span>`
          : p.activity === 'avatar'
            ? `<span class="text-[9px] px-1 rounded bg-sky-900 text-sky-200">Avatar</span>`
            : '';
        return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] border ${
          isMe
            ? 'bg-emerald-950/70 border-emerald-400/50 text-emerald-200 font-bold'
            : 'bg-slate-800/90 border-slate-700 text-slate-200'
        }">${this.esc(p.nama)} ${badge}</span>`;
      })
      .join('');
  }

  private buildSchoolyardMissionBannerHtml(): string {
    const mission = this.snapshot?.mission;
    const gameMeta = getMinigameMeta(mission?.gameId ?? 'puncak_nalar');
    const self = this.getSelfParticipant();
    const isPlaying = mission?.status === 'playing';
    const awaitingApproval = isPlaying && !self?.approvedForMission;

    return `
      <div class="min-w-0 flex-1">
        <div class="text-[11px] font-bold uppercase ${awaitingApproval ? 'text-sky-300' : 'text-amber-300'}">
          ${
            awaitingApproval
              ? 'Misi Sedang Berjalan · Menunggu Persetujuan Guru (Admin)'
              : 'Halaman Sekolah · Menunggu Guru Memulai Misi'
          }
        </div>
        <div class="font-display font-bold text-sm md:text-base text-white truncate">
          Mini-Game: ${this.esc(gameMeta.name)} (${mission?.gameDurationMin ?? 10} mnt)
        </div>
        <div class="text-[11px] text-slate-300">
          ${
            awaitingApproval
              ? 'Guru akan menyetujui masuknya kamu dari Dashboard Admin. Sambil menunggu, baca materi PAI di Kios 3D!'
              : 'Gerakkan karakter: Joystick Sentuh / Ketuk Tanah (HP) atau WASD·Panah + Spasi Lompat (Keyboard).'
          }
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button id="btn-toggle-ready" class="text-xs py-2.5 px-3.5 rounded-xl font-bold cursor-pointer transition ${
          this.isReady
            ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
            : 'btn-gold'
        }">
          ${this.isReady ? '✓ Siap Ikut Misi' : 'Tandai Siap Misi'}
        </button>
      </div>
    `;
  }

  private updateSchoolyardLiveRegions(snapshot: RoomSnapshot): void {
    const onlinePeers = snapshot.participants.filter((p) => p.connected);
    const summaryEl = this.container.querySelector<HTMLElement>('#sy-online-summary');
    if (summaryEl) {
      summaryEl.textContent = `${this.sekolah} · ${onlinePeers.length} Peserta di Halaman Sekolah`;
    }
    const peerCountEl = this.container.querySelector<HTMLElement>('#sy-peer-count');
    if (peerCountEl) {
      peerCountEl.textContent = `${onlinePeers.length} Online`;
    }
    const peerChipsEl = this.container.querySelector<HTMLElement>('#sy-peer-chips');
    if (peerChipsEl) {
      peerChipsEl.innerHTML = this.buildSchoolyardPeerChipsHtml(onlinePeers);
    }
    const bannerEl = this.container.querySelector<HTMLElement>('#sy-mission-banner');
    if (bannerEl) {
      bannerEl.innerHTML = this.buildSchoolyardMissionBannerHtml();
      this.bindReadyButton();
    }
  }

  private bindReadyButton(): void {
    this.container.querySelector('#btn-toggle-ready')?.addEventListener('click', () => {
      soundFX.playClick();
      this.isReady = !this.isReady;
      if (this.studentId) {
        realtimeClient.setReady(this.studentId, this.isReady);
      }
      this.persistStudentSession();
      this.onToast(
        this.isReady
          ? 'Status Siap dikirim ke Guru! Tunggu aba-aba mulai dari Guru.'
          : 'Status Siap dibatalkan.'
      );
      if (this.snapshot) {
        this.updateSchoolyardLiveRegions(this.snapshot);
      }
    });
  }

  private renderMaterialModal(activeId: string): string {
    const elements = paiBank.getAllElements();
    const el = elements.find((e) => e.id === activeId) ?? elements[0];
    return `
      <div class="modal-backdrop">
        <div class="modal-card max-w-3xl">
          <div class="flex items-center justify-between gap-2 pb-3 border-b border-slate-700">
            <div>
              <span class="text-[11px] font-bold px-2.5 py-0.5 rounded text-slate-950" style="background:${el.color}">
                ELEMEN PAI · ${this.esc(el.name)}
              </span>
              <h2 class="font-display font-bold text-xl text-white mt-1">${this.esc(el.materialTitle)}</h2>
              <p class="text-xs text-slate-300">${this.esc(el.subtitle)}</p>
            </div>
            <button id="btn-close-materi" class="btn-secondary text-xs">Tutup ✕</button>
          </div>

          <!-- Element Tabs -->
          <div class="flex gap-1.5 overflow-x-auto py-3">
            ${elements
              .map(
                (item) => `<button data-mat-id="${item.id}" class="js-mat-tab px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap cursor-pointer ${
                  item.id === el.id
                    ? 'bg-amber-400 text-slate-950'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }">${this.esc(item.shortName)}</button>`
              )
              .join('')}
          </div>

          <!-- Sections -->
          <div class="space-y-4 mt-1 text-sm">
            ${el.sections
              .map(
                (sec) => `
              <div class="p-4 rounded-xl bg-slate-900/90 border border-slate-700/80 space-y-2.5">
                <h3 class="font-display font-bold text-base text-amber-300">${this.esc(sec.heading)}</h3>
                ${
                  sec.paragraphs
                    ? sec.paragraphs
                        .map((p) => `<p class="text-slate-200 leading-relaxed ${this.hasArabic(p) ? 'font-arabic' : ''}">${this.esc(p)}</p>`)
                        .join('')
                    : ''
                }
                ${
                  sec.bullets
                    ? `<ul class="list-disc pl-5 space-y-1.5 text-slate-200">
                        ${sec.bullets
                          .map((b) => `<li class="leading-relaxed ${this.hasArabic(b) ? 'font-arabic' : ''}">${this.esc(b)}</li>`)
                          .join('')}
                      </ul>`
                    : ''
                }
                ${
                  sec.table
                    ? `<div class="overflow-x-auto">
                        <table class="w-full text-xs border-collapse">
                          <thead>
                            <tr class="bg-slate-800 text-amber-300">
                              ${sec.table.headers.map((h) => `<th class="p-2 text-left border border-slate-700">${this.esc(h)}</th>`).join('')}
                            </tr>
                          </thead>
                          <tbody>
                            ${sec.table.rows
                              .map(
                                (r) => `<tr class="border-b border-slate-800">
                                  ${r
                                    .map(
                                      (cell) =>
                                        `<td class="p-2 border border-slate-700 text-slate-200 ${this.hasArabic(cell) ? 'font-arabic' : ''}">${this.esc(cell)}</td>`
                                    )
                                    .join('')}
                                </tr>`
                              )
                              .join('')}
                          </tbody>
                        </table>
                      </div>`
                    : ''
                }
                ${
                  sec.callout
                    ? `<div class="p-3 rounded-lg bg-emerald-950/70 border border-emerald-400/50 text-emerald-200 text-xs font-semibold">
                        ${this.esc(sec.callout)}
                      </div>`
                    : ''
                }
              </div>`
              )
              .join('')}
          </div>
        </div>
      </div>
    `;
  }

  private bindSchoolyardEvents(): void {
    this.container.querySelector('#btn-open-materi')?.addEventListener('click', () => {
      soundFX.playClick();
      this.openMaterialElementId = paiBank.getAllElements()[0]?.id ?? 'quran_hadis';
      this.render();
    });
    this.container.querySelector('#btn-close-materi')?.addEventListener('click', () => {
      soundFX.playClick();
      this.openMaterialElementId = null;
      this.render();
    });
    this.container.querySelectorAll<HTMLButtonElement>('.js-mat-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundFX.playClick();
        this.openMaterialElementId = btn.dataset.matId ?? null;
        this.render();
      });
    });

    this.container.querySelector('#btn-toggle-sy-chat')?.addEventListener('click', () => {
      soundFX.playClick();
      this.schoolyardChatOpen = !this.schoolyardChatOpen;
      if (this.schoolyardChatOpen) this.unreadChatCount = 0;
      this.render();
    });

    this.container.querySelector('#btn-edit-avatar')?.addEventListener('click', () => {
      soundFX.playClick();
      if (this.studentId) {
        realtimeClient.updateActivity(this.studentId, 'avatar');
      }
      this.screen = 'avatar';
      this.world.setViewMode('avatar_studio');
      this.persistStudentSession();
      this.render();
    });
    this.container.querySelector('#btn-sy-mute')?.addEventListener('click', () => {
      soundFX.toggleMute();
      this.render();
    });
    this.container.querySelector('#btn-sy-xr')?.addEventListener('click', () => {
      soundFX.playClick();
      this.onToggleXR();
    });
    this.container.querySelector('#btn-sy-logout')?.addEventListener('click', () => {
      soundFX.playClick();
      realtimeClient.leaveStudent(this.studentId);
      clearSession();
      realtimeClient.clearStudentSession();
      this.screen = 'login';
      this.world.setViewMode('title');
      this.render();
    });

    this.bindReadyButton();
    this.bindTouchControls(this.container);
  }

  /**
   * Renders a responsive 360° virtual thumb joystick + tactile Jump button
   * (plus left/right lane steer buttons in Grand Prix) for mobile touchscreen play.
   */
  private renderTouchControlsHtml(compact: boolean, isGrandPrix: boolean): string {
    const padSize = compact ? 'w-24 h-24' : 'w-28 h-28';
    const knobSize = compact ? 'w-10 h-10' : 'w-11 h-11';
    const jumpSize = compact ? 'w-14 h-14 text-[10px]' : 'w-16 h-16 text-xs';

    return `
      <div class="pointer-events-auto flex items-end gap-2.5 select-none shrink-0" style="touch-action: none;">
        <!-- 360° Analog Virtual Thumb Joystick -->
        <div
          class="js-touch-joy relative ${padSize} rounded-full bg-[#0f172a]/85 border-2 border-sky-400/50 shadow-xl flex items-center justify-center cursor-grab active:cursor-grabbing"
          style="touch-action: none;"
          aria-label="Joystick Gerak Karakter"
        >
          <span class="absolute top-1.5 text-[9px] text-sky-300/70 pointer-events-none">▲</span>
          <span class="absolute bottom-1.5 text-[9px] text-sky-300/70 pointer-events-none">▼</span>
          <span class="absolute left-2 text-[9px] text-sky-300/70 pointer-events-none">◀</span>
          <span class="absolute right-2 text-[9px] text-sky-300/70 pointer-events-none">▶</span>
          <div
            class="js-touch-knob ${knobSize} rounded-full bg-gradient-to-br from-sky-400 to-emerald-400 border-2 border-white/80 shadow-lg pointer-events-none transition-transform duration-75"
            style="transform: translate3d(0px, 0px, 0px);"
          ></div>
        </div>

        <!-- Action Buttons: Jump (+ Grand Prix Lane Steer) -->
        <div class="flex flex-col items-center gap-1.5">
          ${
            isGrandPrix
              ? `<div class="flex items-center gap-1.5">
                  <button type="button" class="js-touch-lane-left px-2.5 py-1.5 rounded-xl bg-amber-400/90 active:scale-95 text-slate-950 font-bold text-xs shadow cursor-pointer" style="touch-action: none;">◀ Kiri</button>
                  <button type="button" class="js-touch-lane-right px-2.5 py-1.5 rounded-xl bg-amber-400/90 active:scale-95 text-slate-950 font-bold text-xs shadow cursor-pointer" style="touch-action: none;">Kanan ▶</button>
                </div>`
              : ''
          }
          <button
            type="button"
            class="js-touch-jump ${jumpSize} rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 active:scale-90 border-2 border-emerald-200/80 text-slate-950 font-display font-bold shadow-xl flex items-center justify-center cursor-pointer"
            style="touch-action: none;"
          >
            LOMPAT
          </button>
        </div>
      </div>
    `;
  }

  private bindTouchControls(scope: HTMLElement): void {
    scope.querySelectorAll<HTMLElement>('.js-touch-joy').forEach((pad) => {
      const knob = pad.querySelector<HTMLElement>('.js-touch-knob');
      let activePointerId: number | null = null;

      const updateFromPointer = (clientX: number, clientY: number) => {
        const rect = pad.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const maxR = Math.max(24, rect.width * 0.36);
        let dx = clientX - cx;
        let dy = clientY - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > maxR) {
          dx = (dx / dist) * maxR;
          dy = (dy / dist) * maxR;
        }
        if (knob) {
          knob.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0px)`;
        }
        const nx = Math.abs(dx / maxR) < 0.1 ? 0 : dx / maxR;
        const ny = Math.abs(dy / maxR) < 0.1 ? 0 : dy / maxR;
        this.world.setJoystick(nx, ny);
      };

      const release = () => {
        activePointerId = null;
        if (knob) knob.style.transform = 'translate3d(0px, 0px, 0px)';
        this.world.setJoystick(0, 0);
      };

      pad.addEventListener('pointerdown', (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        activePointerId = e.pointerId;
        try {
          pad.setPointerCapture(e.pointerId);
        } catch {
          // ignore if synthetic pointer
        }
        updateFromPointer(e.clientX, e.clientY);
      });

      pad.addEventListener('pointermove', (e: PointerEvent) => {
        if (activePointerId !== e.pointerId) return;
        e.preventDefault();
        updateFromPointer(e.clientX, e.clientY);
      });

      pad.addEventListener('pointerup', (e: PointerEvent) => {
        if (activePointerId === e.pointerId) release();
      });

      pad.addEventListener('pointercancel', (e: PointerEvent) => {
        if (activePointerId === e.pointerId) release();
      });
    });

    scope.querySelectorAll<HTMLButtonElement>('.js-touch-jump').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        soundFX.playJump();
        this.world.triggerJump();
      });
    });

    scope.querySelectorAll<HTMLButtonElement>('.js-touch-lane-left').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        soundFX.playClick();
        this.world.steerLane(-1);
      });
    });

    scope.querySelectorAll<HTMLButtonElement>('.js-touch-lane-right').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        soundFX.playClick();
        this.world.steerLane(1);
      });
    });
  }

  // =====================================================================
  // 4. ACTIVE GAME HUD (TOP BAR + LEFT QUIZ/CHAT SIDEBAR + CENTERED 3D VIEWPORT)
  // =====================================================================
  private renderPlayingHUD(): void {
    const gameMeta = getMinigameMeta(this.quiz.gameId);
    const q = this.quiz.currentQuestion;
    const elInfo = q ? paiBank.getElementById(q.elementId) : null;
    const participants = this.snapshot?.participants ?? [];
    const myRank = participants.find((p) => p.id === this.studentId)?.rank ?? 1;

    const buffLabel =
      this.quiz.activeBuff === 'double_risk'
        ? 'Buff 2x (-100)'
        : this.quiz.activeBuff === 'boost_1_5'
          ? 'Buff 1.5x (-50)'
          : 'Normal';

    const levelColor =
      this.quiz.level === 'mudah'
        ? 'bg-emerald-500 text-slate-950'
        : this.quiz.level === 'sedang'
          ? 'bg-sky-400 text-slate-950'
          : 'bg-amber-400 text-slate-950';

    this.container.innerHTML = `
      <div class="game-shell">
        <!-- TOP PANEL (10%) -->
        <header class="game-topbar">
          <div class="flex items-center gap-2.5 shrink-0">
            <span class="px-2.5 py-1 rounded-lg font-display font-bold text-xs text-slate-950" style="background:${gameMeta.accent}">
              ${this.esc(gameMeta.name)}
            </span>
            <div class="hidden sm:block">
              <div class="font-bold text-xs text-white leading-tight">${this.esc(this.nama)} (Kls ${this.esc(this.kelas)})</div>
              <div class="text-[10px] text-slate-400">${this.esc(this.sekolah)}</div>
            </div>
          </div>

          <div class="flex items-center gap-2 md:gap-3 shrink-0 text-xs">
            <div class="px-2.5 py-1 rounded-lg bg-slate-800 border border-amber-400/50">
              Skor: <strong class="text-amber-300 tabular-nums text-sm">${this.quiz.score}</strong>
            </div>
            <div class="px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700">
              Peringkat: <strong id="hud-my-rank" class="text-sky-300 tabular-nums">#${myRank}</strong>
            </div>
            <div class="px-2.5 py-1 rounded-lg font-bold uppercase ${levelColor}">
              ${this.quiz.level}
            </div>
            <div class="px-2.5 py-1 rounded-lg bg-slate-800 border border-orange-400/40 tabular-nums">
              Streak: <strong class="text-orange-300">${this.quiz.streak}/10</strong>
            </div>
            <div class="hidden md:block px-2.5 py-1 rounded-lg bg-slate-800 border border-purple-400/40 text-purple-200 font-semibold">
              ${buffLabel}
            </div>
            <div class="px-2.5 py-1 rounded-lg bg-slate-900 border border-rose-400/50 font-display font-bold text-amber-300 tabular-nums" id="hud-game-timer">
              --:--
            </div>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <button id="btn-toggle-lb" class="btn-secondary text-[11px] py-1.5 px-2.5">Klasemen</button>
            <button id="btn-game-mute" class="btn-secondary text-[11px] py-1.5 px-2.5">${soundFX.muted ? '🔇' : '🔊'}</button>
          </div>
        </header>

        <!-- LEFT SIDEBAR: SOAL AKM & CHAT KELAS TABS -->
        <aside class="game-left-panel">
          <div class="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-900 border border-slate-700/80 shrink-0">
            <button id="tab-game-quiz" class="py-1.5 rounded-lg text-xs font-bold cursor-pointer transition ${
              this.gameSidebarTab === 'quiz'
                ? 'bg-sky-500 text-slate-950'
                : 'text-slate-300 hover:text-white'
            }">Soal AKM</button>
            <button id="tab-game-chat" class="py-1.5 rounded-lg text-xs font-bold cursor-pointer transition flex items-center justify-center gap-1 ${
              this.gameSidebarTab === 'chat'
                ? 'bg-emerald-500 text-slate-950'
                : 'text-slate-300 hover:text-white'
            }">
              <span>Chat Kelas</span>
              <span id="game-chat-badge" class="${this.unreadChatCount > 0 && this.gameSidebarTab !== 'chat' ? '' : 'hidden'} px-1.5 py-0.2 rounded-full bg-amber-400 text-slate-950 text-[10px] font-bold">${this.unreadChatCount}</span>
            </button>
          </div>

          ${
            this.gameSidebarTab === 'chat'
              ? `<div id="game-chat-mount" class="flex-1 min-h-0 -mx-3 -mb-3 border-t border-slate-800"></div>`
              : this.waitingForDiceRoll
                ? `<div class="flex-1 flex flex-col items-center justify-center text-center gap-3 p-2">
                    <div class="font-display font-bold text-lg text-amber-300">Giliran Lempar Dadu 3D!</div>
                    <p class="text-xs text-slate-300">
                      Klik dadu raksasa di arena 3D atau tekan tombol di bawah untuk melangkah & membuka tantangan soal.
                    </p>
                    <button id="btn-roll-dice-left" class="btn-gold w-full py-3 text-sm">
                      Lempar Dadu 3D
                    </button>
                  </div>`
                : q
                  ? `
                    <!-- Question Header & Countdown -->
                    <div class="space-y-1.5 shrink-0">
                      <div class="flex flex-wrap items-center justify-between gap-1">
                        <span class="text-[10px] font-bold px-2 py-0.5 rounded text-slate-950" style="background:${elInfo?.color ?? '#10b981'}">
                          ${this.esc(elInfo?.shortName ?? q.elementId)}
                        </span>
                        <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-900 text-indigo-200">
                          ${q.type === 'PG' ? 'Pilihan Ganda' : q.type === 'PGK' ? 'PG Kompleks (Multi)' : 'Benar / Salah'}
                        </span>
                        <span id="q-timer-text" class="text-xs font-bold text-sky-300 tabular-nums">${this.quiz.questionDurationSec} dtk</span>
                      </div>
                      <div class="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div id="q-timer-bar" class="h-full bg-sky-400 transition-all duration-150" style="width:100%"></div>
                      </div>
                      <div class="text-[10px] text-slate-400">Kognitif: ${this.esc(q.cognitiveLevel)}</div>
                    </div>

                    <!-- Prompt -->
                    <div class="p-3 rounded-xl bg-slate-900 border border-slate-700 text-xs md:text-sm text-white leading-relaxed shrink-0 ${
                      this.hasArabic(q.prompt) ? 'font-arabic' : ''
                    }">
                      ${this.esc(q.prompt)}
                    </div>

                    <!-- Options -->
                    <div class="space-y-2 flex-1 overflow-y-auto pr-0.5">
                      ${q.options
                        .map((opt, idx) => {
                          const isSel = this.selectedIndices.includes(idx);
                          let stateCls = isSel ? 'selected' : '';
                          if (this.awaitingNext) {
                            if (q.correctIndices.includes(idx)) stateCls = 'correct';
                            else if (isSel) stateCls = 'wrong';
                          }
                          const badge =
                            q.type === 'BS'
                              ? idx === 0
                                ? 'B'
                                : 'S'
                              : ['A', 'B', 'C', 'D'][idx];
                          return `
                          <button data-opt="${idx}" class="js-opt-btn option-btn ${stateCls} ${
                            this.hasArabic(opt) ? 'font-arabic' : ''
                          }" ${this.awaitingNext ? 'disabled' : ''}>
                            <span class="w-6 h-6 rounded-lg shrink-0 flex items-center justify-center font-display font-bold text-xs ${
                              q.type === 'BS'
                                ? idx === 0
                                  ? 'bg-emerald-600 text-white'
                                  : 'bg-rose-600 text-white'
                                : isSel
                                  ? 'bg-amber-400 text-slate-950'
                                  : 'bg-slate-800 text-sky-300'
                            }">${q.type === 'PGK' ? (isSel ? '✓' : '☐') : badge}</span>
                            <span>${this.esc(opt)}</span>
                          </button>`;
                        })
                        .join('')}
                    </div>

                    ${
                      q.type === 'PGK' && !this.awaitingNext
                        ? `<button id="btn-submit-pgk" class="btn-gold w-full py-2.5 text-sm shrink-0" ${
                            this.selectedIndices.length === 0 ? 'disabled style="opacity:0.5"' : ''
                          }>Kirim Jawaban PGK (${this.selectedIndices.length} dipilih)</button>`
                        : ''
                    }

                    ${
                      this.lastFeedback
                        ? `<div class="p-2.5 rounded-xl text-xs font-semibold border shrink-0 ${
                            this.lastFeedback.isCorrect
                              ? 'bg-emerald-950/90 border-emerald-400 text-emerald-200'
                              : 'bg-rose-950/90 border-rose-400 text-rose-200'
                          }">
                            ${this.esc(this.lastFeedback.text)}
                          </div>`
                        : ''
                    }
                  `
                  : ''
          }
        </aside>

        <!-- RIGHT CENTERED 3D VIEWPORT FLOATING CONTROLS -->
        <div class="game-viewport-overlay">
          <div class="absolute top-3 right-3 pointer-events-auto flex flex-col items-end gap-2">
            <div class="px-3.5 py-2 rounded-xl bg-[#0f172a]/90 border border-slate-600 text-xs text-right">
              <div class="text-[10px] text-slate-400">${this.esc(gameMeta.leaderboardMetric)}</div>
              <div class="font-display font-bold text-base text-amber-300 tabular-nums">
                ${this.quiz.progressValue} ${this.esc(gameMeta.leaderboardUnit)}
              </div>
            </div>

            ${this.renderMinigameSpecialControls()}
          </div>

          <!-- Touchscreen 360° Joystick + Jump Controls inside Active Minigame -->
          <div class="absolute bottom-3 right-3 z-10">
            ${this.renderTouchControlsHtml(true, this.quiz.gameId === 'grand_prix')}
          </div>

          <!-- Keyboard & Touch Controls Hint -->
          <div class="hidden md:block absolute bottom-3 left-3 max-w-sm px-3 py-1.5 rounded-xl bg-[#0f172a]/88 border border-slate-700 text-[11px] text-slate-300">
            <div>${this.esc(gameMeta.controlsHint)}</div>
            <div class="text-[10px] text-sky-300 mt-0.5">Keyboard: WASD/Panah Gerak · Spasi Lompat · Shift Lari · Tombol 1–4 Pilih Jawaban</div>
          </div>
        </div>
      </div>

      ${this.showMiniLeaderboard ? this.renderMiniLeaderboardModal(participants, gameMeta) : ''}
      ${this.showBuffModal ? this.renderBuffChoiceModal(participants) : ''}
      ${this.showReflectionModal ? this.renderReflectionModal(myRank) : ''}
    `;

    // Mount ChatSidebar if Chat tab is active
    const gameChatMount = this.container.querySelector<HTMLElement>('#game-chat-mount');
    if (gameChatMount) {
      this.unreadChatCount = 0;
      this.chatSidebar.setOptions({
        role: 'student',
        selfId: this.studentId,
        senderName: this.nama || 'Peserta',
        senderKelas: this.kelas,
      });
      this.chatSidebar.mount(gameChatMount, this.snapshot);
    }

    this.bindPlayingEvents();
  }

  private renderMinigameSpecialControls(): string {
    const id = this.quiz.gameId;
    if (id === 'portal_dimension') {
      const s = this.quiz.portalStars;
      return `
        <div class="p-2.5 rounded-xl bg-[#0f172a]/92 border border-indigo-400/50 space-y-1.5 text-xs">
          <div class="font-bold text-indigo-200">Pilih Portal Dimensi:</div>
          <button data-portal="mudah" class="js-portal-btn w-full px-2.5 py-1.5 rounded-lg font-bold cursor-pointer ${
            this.quiz.portalDimensionLevel === 'mudah' ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-emerald-300'
          }">Hijau · Mudah (★ ${s.mudah}/5)</button>
          <button data-portal="sedang" class="js-portal-btn w-full px-2.5 py-1.5 rounded-lg font-bold cursor-pointer ${
            this.quiz.portalDimensionLevel === 'sedang' ? 'bg-sky-500 text-slate-950' : 'bg-slate-800 text-sky-300'
          }">Biru · Sedang (★ ${s.sedang}/5)</button>
          <button data-portal="sulit" class="js-portal-btn w-full px-2.5 py-1.5 rounded-lg font-bold cursor-pointer ${
            this.quiz.portalDimensionLevel === 'sulit' ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-amber-300'
          }">Emas · Sulit (★ ${s.sulit}/5)</button>
        </div>`;
    }
    if (id === 'climb_summit') {
      const st = this.quiz.getSummitPacketStatus();
      return `
        <div class="p-2.5 rounded-xl bg-[#0f172a]/92 border border-orange-400/50 text-xs">
          <div class="font-bold text-orange-300">Pos Basecamp #${st.basecamp + 1}</div>
          <div class="text-slate-200 mt-0.5">Paket 3 Soal: <strong>${st.step}/3</strong> (Berikutnya: ${st.nextType})</div>
        </div>`;
    }
    if (id === 'edu_craft') {
      const names = ['Masjid', 'Perpustakaan', 'Taman', 'Pasar Madinah', 'Jembatan'];
      const next = names[this.quiz.progressValue] ?? 'Pulau Lengkap!';
      return `
        <div class="p-2.5 rounded-xl bg-[#0f172a]/92 border border-emerald-400/50 text-xs">
          <div class="font-bold text-emerald-300">Edu-Craft Target:</div>
          <div class="text-white">${next} (${Math.min(5, this.quiz.progressValue)}/5)</div>
        </div>`;
    }
    if (id === 'board_adventure' && this.waitingForDiceRoll) {
      return `<button id="btn-roll-dice-3d" class="btn-gold text-xs py-2">Lempar Dadu 3D</button>`;
    }
    if (id === 'board_adventure' && this.lastDiceNumber > 0) {
      return `<div class="px-3 py-1.5 rounded-xl bg-[#0f172a]/90 border border-pink-400/50 text-xs font-bold text-pink-300">Dadu Terakhir: ${this.lastDiceNumber}</div>`;
    }
    return '';
  }

  private renderMiniLeaderboardModal(
    participants: RoomSnapshot['participants'],
    gameMeta: ReturnType<typeof getMinigameMeta>
  ): string {
    return `
      <div class="modal-backdrop">
        <div class="modal-card max-w-lg">
          <div class="flex items-center justify-between pb-3 border-b border-slate-700 mb-3">
            <h3 class="font-display font-bold text-lg text-amber-300">Klasemen Live · ${this.esc(gameMeta.name)}</h3>
            <button id="btn-close-lb" class="btn-secondary text-xs">Tutup ✕</button>
          </div>
          <div class="space-y-2 max-h-[60vh] overflow-y-auto">
            ${
              participants.length === 0
                ? `<p class="text-xs text-slate-400 text-center py-6">Menunggu data skor kelas...</p>`
                : participants
                    .map(
                      (p, i) => `
                  <div class="p-2.5 rounded-xl flex items-center justify-between text-xs border ${
                    p.id === this.studentId
                      ? 'bg-emerald-950/70 border-emerald-400'
                      : 'bg-slate-900 border-slate-700'
                  }">
                    <div>
                      <span class="font-bold text-amber-300 mr-2">#${i + 1}</span>
                      <span class="font-bold text-white">${this.esc(p.nama)}</span>
                      <span class="text-slate-400 ml-1">(${p.progressValue} ${this.esc(gameMeta.leaderboardUnit)})</span>
                    </div>
                    <span class="font-display font-bold text-amber-300 tabular-nums">${p.score} pts</span>
                  </div>`
                    )
                    .join('')
            }
          </div>
        </div>
      </div>
    `;
  }

  private renderBuffChoiceModal(participants: RoomSnapshot['participants']): string {
    const others = participants.filter((p) => p.id !== this.studentId && p.connected && p.approvedForMission);
    return `
      <div class="modal-backdrop">
        <div class="modal-card max-w-2xl">
          <div class="text-center mb-4">
            <span class="px-3 py-1 rounded-full bg-amber-400 text-slate-950 font-display font-bold text-xs">
              STREAK 10x BENAR BERUNTUN!
            </span>
            <h2 class="font-display font-bold text-2xl text-white mt-2">Pilih 1 dari 3 Buff Spesial!</h2>
            <p class="text-xs text-slate-300 mt-1">Strategi berhadiah untuk melejitkan peringkatmu di papan skor.</p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <button data-buff="double_risk" class="js-choose-buff p-4 rounded-2xl bg-slate-900 border-2 border-amber-400 hover:bg-amber-950/40 text-left cursor-pointer">
              <div class="font-display font-bold text-lg text-amber-300">Buff 1: 2x Risiko</div>
              <p class="text-xs text-slate-200 mt-2">Jika benar poin <strong>dikalikan 2x</strong>! Namun jika salah, poin berkurang <strong>-100</strong>.</p>
            </button>

            <button data-buff="boost_1_5" class="js-choose-buff p-4 rounded-2xl bg-slate-900 border-2 border-sky-400 hover:bg-sky-950/40 text-left cursor-pointer">
              <div class="font-display font-bold text-lg text-sky-300">Buff 2: 1.5x Aman</div>
              <p class="text-xs text-slate-200 mt-2">Jika benar poin <strong>dikalikan 1.5x</strong>! Jika salah, poin hanya berkurang <strong>-50</strong>.</p>
            </button>

            <div class="p-4 rounded-2xl bg-slate-900 border-2 border-rose-400 text-left flex flex-col justify-between">
              <div>
                <div class="font-display font-bold text-lg text-rose-300">Buff 3: Serang -150</div>
                <p class="text-xs text-slate-200 mt-1">Poin tetap 1x, pilih 1 peserta online untuk dikurangi <strong>150 poin</strong>!</p>
              </div>
              <div class="mt-3 space-y-1.5 max-h-28 overflow-y-auto">
                ${
                  others.length === 0
                    ? `<button data-buff="none" class="js-choose-buff btn-secondary w-full text-xs">Tidak ada lawan online (+50 bonus)</button>`
                    : others
                        .map(
                          (o) => `<button data-attack="${o.id}" class="js-attack-btn w-full px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs cursor-pointer">
                            Serang ${this.esc(o.nama)} (${o.score} pts)
                          </button>`
                        )
                        .join('')
                }
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderReflectionModal(rank: number): string {
    const total = this.quiz.correctCount + this.quiz.wrongCount;
    const acc = total > 0 ? Math.round((this.quiz.correctCount / total) * 100) : 0;

    return `
      <div class="modal-backdrop">
        <div class="modal-card max-w-xl">
          <div class="text-center mb-4">
            <span class="px-3 py-1 rounded-full bg-emerald-400 text-slate-950 font-display font-bold text-xs">
              MISI SELESAI · HASIL BELAJAR PAI
            </span>
            <h2 class="font-display font-bold text-2xl text-white mt-2">Hebat, ${this.esc(this.nama)}!</h2>
            <div class="grid grid-cols-4 gap-2 mt-3">
              <div class="p-2.5 rounded-xl bg-slate-900 border border-slate-700">
                <div class="text-[10px] text-slate-400">Skor Akhir</div>
                <div class="font-display font-bold text-lg text-amber-300 tabular-nums">${this.quiz.score}</div>
              </div>
              <div class="p-2.5 rounded-xl bg-slate-900 border border-slate-700">
                <div class="text-[10px] text-slate-400">Peringkat</div>
                <div class="font-display font-bold text-lg text-sky-300 tabular-nums">#${rank}</div>
              </div>
              <div class="p-2.5 rounded-xl bg-slate-900 border border-slate-700">
                <div class="text-[10px] text-slate-400">Akurasi</div>
                <div class="font-display font-bold text-lg text-emerald-400 tabular-nums">${acc}%</div>
              </div>
              <div class="p-2.5 rounded-xl bg-slate-900 border border-slate-700">
                <div class="text-[10px] text-slate-400">Max Streak</div>
                <div class="font-display font-bold text-lg text-orange-300 tabular-nums">${this.quiz.maxStreak}x</div>
              </div>
            </div>
          </div>

          ${
            !this.reflectionSubmitted
              ? `<form id="form-reflection" class="space-y-3 text-xs">
                  <div class="p-3 rounded-xl bg-amber-950/40 border border-amber-400/40 text-amber-200">
                    Sebelum keluar dari permainan, tuliskan <strong>Refleksi Belajar</strong>, <strong>Komentar</strong>, serta <strong>Kritik & Saran</strong>! Catatanmu akan tersimpan permanen di papan testimoni halaman depan.
                  </div>
                  <div>
                    <label class="block font-bold text-slate-200 mb-1">1. Refleksi Belajar Hari Ini (Wajib)</label>
                    <textarea name="refleksi" required rows="2" class="input-dark text-xs" placeholder="Contoh: Hari ini saya belajar bahwa tawakal harus diawali dengan ikhtiar dan doa..."></textarea>
                  </div>
                  <div>
                    <label class="block font-bold text-slate-200 mb-1">2. Komentar Tentang Permainan (Wajib)</label>
                    <input name="komentar" required class="input-dark text-xs" placeholder="Contoh: Seru banget main balap hover-kart sambil belajar PAI!" />
                  </div>
                  <div>
                    <label class="block font-bold text-slate-200 mb-1">3. Kritik & Saran (Wajib)</label>
                    <input name="kritikSaran" required class="input-dark text-xs" placeholder="Contoh: Tambahkan lebih banyak kostum avatar Nusantara!" />
                  </div>
                  <button type="submit" class="btn-gold w-full py-3 text-sm">
                    Kirim Refleksi & Simpan Permanen
                  </button>
                </form>`
              : `<div class="text-center space-y-4 py-4">
                  <div class="text-emerald-400 font-display font-bold text-lg">
                    Terima kasih! Refleksi & testimonimu sudah tersimpan permanen.
                  </div>
                  <div class="flex justify-center gap-3">
                    <button id="btn-ref-schoolyard" class="btn-primary">Kembali ke Halaman Sekolah</button>
                    <button id="btn-ref-login" class="btn-secondary">Lihat di Halaman Depan</button>
                  </div>
                </div>`
          }
        </div>
      </div>
    `;
  }

  private bindPlayingEvents(): void {
    this.container.querySelector('#tab-game-quiz')?.addEventListener('click', () => {
      soundFX.playClick();
      this.gameSidebarTab = 'quiz';
      this.render();
    });
    this.container.querySelector('#tab-game-chat')?.addEventListener('click', () => {
      soundFX.playClick();
      this.gameSidebarTab = 'chat';
      this.unreadChatCount = 0;
      this.render();
    });

    this.container.querySelector('#btn-toggle-lb')?.addEventListener('click', () => {
      soundFX.playClick();
      this.showMiniLeaderboard = !this.showMiniLeaderboard;
      this.render();
    });
    this.container.querySelector('#btn-close-lb')?.addEventListener('click', () => {
      soundFX.playClick();
      this.showMiniLeaderboard = false;
      this.render();
    });
    this.container.querySelector('#btn-game-mute')?.addEventListener('click', () => {
      soundFX.toggleMute();
      this.render();
    });

    this.container.querySelector('#btn-roll-dice-left')?.addEventListener('click', () => {
      this.handleRollDice();
    });
    this.container.querySelector('#btn-roll-dice-3d')?.addEventListener('click', () => {
      this.handleRollDice();
    });

    this.container.querySelectorAll<HTMLButtonElement>('.js-portal-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.switchPortalDimension(btn.dataset.portal as DifficultyLevel);
      });
    });

    this.container.querySelectorAll<HTMLButtonElement>('.js-opt-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.handleOptionInteraction(Number(btn.dataset.opt));
      });
    });

    this.container.querySelector('#btn-submit-pgk')?.addEventListener('click', () => {
      if (this.selectedIndices.length > 0) {
        this.submitAnswer(false);
      }
    });

    // Buff modal
    this.container.querySelectorAll<HTMLButtonElement>('.js-choose-buff').forEach((btn) => {
      btn.addEventListener('click', () => {
        const buff = btn.dataset.buff as 'double_risk' | 'boost_1_5' | 'none';
        if (buff === 'none') {
          this.quiz.score += 50;
          this.onToast('Bonus +50 poin diterima!');
        } else {
          this.quiz.applyBuff(buff);
          this.onToast(
            buff === 'double_risk'
              ? 'Buff 2x Risiko Aktif! Hati-hati jika salah (-100).'
              : 'Buff 1.5x Aman Aktif!'
          );
        }
        soundFX.playBuffFanfare();
        this.showBuffModal = false;
        this.advanceToNextTurn();
      });
    });

    this.container.querySelectorAll<HTMLButtonElement>('.js-attack-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.attack!;
        if (this.studentId) {
          realtimeClient.attackPlayer(this.studentId, targetId, 150);
        }
        soundFX.playSabotage();
        this.onToast('Serangan -150 poin berhasil diluncurkan!');
        this.showBuffModal = false;
        this.advanceToNextTurn();
      });
    });

    // Mandatory Reflection Form
    const refForm = this.container.querySelector<HTMLFormElement>('#form-reflection');
    refForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(refForm);
      const refleksi = String(fd.get('refleksi') || '').trim();
      const komentar = String(fd.get('komentar') || '').trim();
      const kritikSaran = String(fd.get('kritikSaran') || '').trim();
      if (!refleksi || !komentar || !kritikSaran) return;

      realtimeClient.submitReflection({
        id: this.studentId ?? `stu_${Date.now()}`,
        nama: this.nama,
        kelas: this.kelas,
        sekolah: this.sekolah,
        skor: this.quiz.score,
        refleksi,
        komentar,
        kritikSaran,
      });
      soundFX.playCorrect();
      this.reflectionSubmitted = true;
      this.persistStudentSession();
      this.render();
    });

    this.container.querySelector('#btn-ref-schoolyard')?.addEventListener('click', () => {
      soundFX.playClick();
      this.showReflectionModal = false;
      this.screen = 'schoolyard';
      if (this.studentId) {
        realtimeClient.updateActivity(this.studentId, 'schoolyard');
      }
      this.world.setViewMode('schoolyard');
      if (this.snapshot) {
        this.world.syncPeers(this.snapshot.participants, this.studentId);
      }
      this.persistStudentSession();
      this.render();
    });
    this.container.querySelector('#btn-ref-login')?.addEventListener('click', () => {
      soundFX.playClick();
      this.showReflectionModal = false;
      realtimeClient.leaveStudent(this.studentId);
      clearSession();
      realtimeClient.clearStudentSession();
      this.screen = 'login';
      this.world.setViewMode('title');
      this.render();
    });

    this.bindTouchControls(this.container);
  }

  private hasArabic(text: string): boolean {
    return /[\u0600-\u06FF]/.test(text);
  }

  private esc(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
