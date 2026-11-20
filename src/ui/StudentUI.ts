import type {
  AvatarConfig,
  DifficultyLevel,
  GameId,
  QuestionItem,
  QuestionType,
  RoomSnapshot,
  TestimonialItem,
} from '../types.ts';
import {
  AVATAR_OPTIONS,
  DEFAULT_AVATAR_MUSLIM,
  DEFAULT_AVATAR_MUSLIMAH,
  getMinigameMeta,
  MINIGAMES,
} from '../constants.ts';
import { paiBank } from '../data/paiBank.ts';
import { realtimeClient } from '../services/RealtimeClient.ts';
import { QuizEngine } from '../game/QuizEngine.ts';
import { soundFX } from '../audio/SoundFX.ts';
import type { PaiWorldScript } from '../scene/PaiWorldScript.ts';

type StudentScreen = 'login' | 'avatar' | 'schoolyard' | 'playing';

export class StudentUI {
  private container: HTMLElement;
  private world: PaiWorldScript;
  private quiz = new QuizEngine();
  private onTeacherLoggedIn: (sekolah: string, snapshot: RoomSnapshot | null) => void;
  private onToggleXR: () => void;
  private onToast: (msg: string) => void;

  private screen: StudentScreen = 'login';
  private loginTab: 'student' | 'teacher' = 'student';
  private snapshot: RoomSnapshot | null = null;

  // Student identity
  private studentId: string | null = null;
  private nama = '';
  private kelas = '5';
  private sekolah = '';
  private avatar: AvatarConfig = { ...DEFAULT_AVATAR_MUSLIM };

  // Interactive modals & states
  private openMaterialElementId: string | null = null;
  private showSoloPicker = false;
  private isSoloMode = false;
  private soloEndsAt: number | null = null;
  private showBuffModal = false;
  private showReflectionModal = false;
  private reflectionSubmitted = false;
  private showMiniLeaderboard = false;

  // Active quiz UI state
  private selectedIndices: number[] = [];
  private awaitingNext = false;
  private lastFeedback: { isCorrect: boolean; delta: number; text: string } | null = null;
  private waitingForDiceRoll = false;
  private lastDiceNumber = 0;

  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    container: HTMLElement,
    world: PaiWorldScript,
    onTeacherLoggedIn: (sekolah: string, snapshot: RoomSnapshot | null) => void,
    onToggleXR: () => void,
    onToast: (msg: string) => void
  ) {
    this.container = container;
    this.world = world;
    this.onTeacherLoggedIn = onTeacherLoggedIn;
    this.onToggleXR = onToggleXR;
    this.onToast = onToast;

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
      onPlayerMoveSync: (pos) => {
        if (this.studentId) {
          realtimeClient.sendMove(this.studentId, pos);
        }
      },
    };
  }

  mount(snapshot: RoomSnapshot | null): void {
    this.snapshot = snapshot;
    if (snapshot) {
      paiBank.setCustomContent(snapshot.customElements, snapshot.customQuestions);
      this.world.setElements(paiBank.getAllElements());
    } else {
      this.world.setElements(paiBank.getAllElements());
    }
    this.screen = 'login';
    this.world.setViewMode('title');
    this.render();
    this.startTimerLoop();
  }

  unmount(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.container.innerHTML = '';
  }

  handleSnapshot(snapshot: RoomSnapshot): void {
    this.snapshot = snapshot;
    paiBank.setCustomContent(snapshot.customElements, snapshot.customQuestions);
    this.world.setElements(paiBank.getAllElements());
    this.world.syncPeers(snapshot.participants, this.studentId);

    // Only re-render when needed without interrupting active inputs
    if (this.screen === 'schoolyard' || this.showMiniLeaderboard || this.showBuffModal) {
      this.render();
    } else if (this.screen === 'login') {
      this.updateMarqueeOnly(snapshot.testimonials);
    }
  }

  handleJoined(id: string, snapshot: RoomSnapshot): void {
    this.studentId = id;
    this.snapshot = snapshot;
    this.world.syncPeers(snapshot.participants, this.studentId);
    if (snapshot.mission.status === 'playing' && this.screen === 'schoolyard') {
      this.beginMissionGame(false);
    }
  }

  handleMissionStarted(snapshot: RoomSnapshot): void {
    this.snapshot = snapshot;
    if (this.screen === 'schoolyard' || this.screen === 'avatar' || this.screen === 'playing') {
      this.beginMissionGame(false);
    }
  }

  handleMissionEnded(snapshot: RoomSnapshot): void {
    this.snapshot = snapshot;
    if (this.screen === 'playing' && !this.isSoloMode) {
      soundFX.playLevelUp();
      this.showBuffModal = false;
      this.showReflectionModal = true;
      this.reflectionSubmitted = false;
      this.render();
    }
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

  private startTimerLoop(): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.tickInterval = setInterval(() => {
      if (this.screen !== 'playing' || this.showReflectionModal || this.showBuffModal) return;

      // Update game timer
      const endsAt = this.isSoloMode ? this.soloEndsAt : this.snapshot?.mission.endsAt ?? null;
      const gTimerEl = this.container.querySelector<HTMLElement>('#hud-game-timer');
      if (endsAt && gTimerEl) {
        const remSec = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        const mm = String(Math.floor(remSec / 60)).padStart(2, '0');
        const ss = String(remSec % 60).padStart(2, '0');
        gTimerEl.textContent = `${mm}:${ss}`;
        if (remSec === 0 && this.isSoloMode) {
          this.finishSoloSession();
          return;
        }
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

  private beginMissionGame(solo: boolean, soloGameId?: GameId): void {
    this.isSoloMode = solo;
    this.showSoloPicker = false;
    this.openMaterialElementId = null;
    this.showBuffModal = false;
    this.showReflectionModal = false;
    this.reflectionSubmitted = false;
    this.lastFeedback = null;
    this.selectedIndices = [];
    this.awaitingNext = false;

    const mission = this.snapshot?.mission;
    const gameId: GameId = solo ? soloGameId ?? 'puncak_nalar' : mission?.gameId ?? 'puncak_nalar';
    const elementIds =
      mission?.elementIds && mission.elementIds.length > 0
        ? mission.elementIds
        : paiBank.getAllElements().map((e) => e.id);
    const qDur = mission?.questionDurationSec ?? 25;
    const gDurMin = mission?.gameDurationMin ?? 10;

    if (solo) {
      this.soloEndsAt = Date.now() + gDurMin * 60_000;
    }

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
    this.render();
  }

  private finishSoloSession(): void {
    soundFX.playLevelUp();
    this.showReflectionModal = true;
    this.reflectionSubmitted = false;
    this.render();
  }

  private loadNextQuestion(preferredType?: QuestionType): void {
    const q = this.quiz.nextQuestion(preferredType);
    this.selectedIndices = [];
    this.awaitingNext = false;
    this.lastFeedback = null;
    this.world.setQuestionVisuals(q, []);
  }

  private handleRollDice(): void {
    if (!this.waitingForDiceRoll) return;
    soundFX.playDiceRoll();
    const rolled = 1 + Math.floor(Math.random() * 6);
    this.lastDiceNumber = rolled;
    this.world.rollDiceVisual(rolled);

    // Tile colors cycle: 0=Blue(PG), 1=Purple(PGK), 2=Yellow(BS)
    const nextTileMod = (this.quiz.progressValue + rolled) % 3;
    const qType: QuestionType = nextTileMod === 0 ? 'PG' : nextTileMod === 1 ? 'PGK' : 'BS';
    this.waitingForDiceRoll = false;
    this.loadNextQuestion(qType);
    this.onToast(`Dadu keluar angka ${rolled}! Tantangan petak: ${qType === 'PG' ? 'Biru (PG)' : qType === 'PGK' ? 'Ungu (PGK Bonus)' : 'Kuning (Benar/Salah)'}`);
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

    // Sync to server if joined
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

    this.render();

    // Advance after brief feedback pause
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

  private render(): void {
    if (this.screen === 'login') {
      this.renderLoginScreen();
    } else if (this.screen === 'avatar') {
      this.renderAvatarStudio();
    } else if (this.screen === 'schoolyard') {
      this.renderSchoolyardHUD();
    } else {
      this.renderPlayingHUD();
    }
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
                5 Elemen PAI · 150 Soal AKM · 9 Mini-Game Petualangan
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
                    <button type="submit" class="btn-primary w-full py-3 text-base mt-2">
                      Masuk & Buat Avatar Roblox
                    </button>
                  </form>`
                : `<form id="form-teacher-login" class="space-y-3">
                    <div>
                      <label class="block text-xs font-semibold text-slate-300 mb-1">Kode Akun Guru (Admin)</label>
                      <input name="code" required class="input-dark" placeholder="Masukkan kode guru (gpaibeji)" />
                    </div>
                    <div>
                      <label class="block text-xs font-semibold text-slate-300 mb-1">Nama Sekolah</label>
                      <input name="sekolah" required class="input-dark" placeholder="Contoh: SDN 01 Beji" value="${this.esc(this.sekolah)}" />
                    </div>
                    <div id="teacher-login-err" class="text-xs text-rose-400 font-semibold hidden"></div>
                    <button type="submit" class="btn-gold w-full py-3 text-base mt-2">
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
    // Duplicate for seamless continuous scrolling
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
    stuForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      soundFX.playClick();
      const fd = new FormData(stuForm);
      this.nama = String(fd.get('nama') || '').trim();
      this.kelas = String(fd.get('kelas') || '5');
      this.sekolah = String(fd.get('sekolah') || '').trim();
      if (!this.nama || !this.sekolah) return;

      this.world.setPlayerIdentity(this.nama, this.kelas, this.avatar);
      this.screen = 'avatar';
      this.world.setViewMode('avatar_studio');
      this.render();
    });

    const tchForm = this.container.querySelector<HTMLFormElement>('#form-teacher-login');
    tchForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      soundFX.playClick();
      const fd = new FormData(tchForm);
      const code = String(fd.get('code') || '').trim();
      const sekolah = String(fd.get('sekolah') || '').trim();
      this.sekolah = sekolah;

      // Local fast validation + server auth
      if (code.toLowerCase() !== 'gpaibeji' || sekolah.length < 2) {
        const err = this.container.querySelector('#teacher-login-err');
        if (err) {
          err.textContent = 'Kode guru harus "gpaibeji" dan nama sekolah wajib diisi.';
          err.classList.remove('hidden');
        }
        soundFX.playWrong();
        return;
      }

      if (realtimeClient.connected) {
        realtimeClient.loginTeacher(code, sekolah);
      } else {
        this.onTeacherLoggedIn(sekolah, this.snapshot);
      }
    });
  }

  // =====================================================================
  // 2. AVATAR CUSTOMIZER STUDIO (Rambut/Peci/Hijab, Mata, Hidung, Mulut, Baju, Celana, Sepatu, Tas)
  // =====================================================================
  private renderAvatarStudio(): void {
    const a = this.avatar;
    this.container.innerHTML = `
      <div class="fixed inset-0 grid grid-cols-1 md:grid-cols-12 pointer-events-none">
        <!-- Left 3D Turntable Viewport -->
        <div class="md:col-span-6 lg:col-span-7 flex flex-col justify-between p-4">
          <div class="pointer-events-auto flex items-center justify-between">
            <div class="px-4 py-2 rounded-2xl bg-[#0f172a]/92 border border-sky-400/40">
              <div class="font-display font-bold text-lg text-amber-300">Studio Avatar Roblox PAI</div>
              <div class="text-xs text-slate-300">${this.esc(this.nama)} · Kelas ${this.esc(this.kelas)} · ${this.esc(this.sekolah)}</div>
            </div>
            <button id="btn-back-login" class="btn-secondary text-xs">Kembali</button>
          </div>

          <div class="pointer-events-auto flex items-center justify-center gap-3 mb-2">
            <button id="btn-rot-left" class="btn-secondary text-xs">⟲ Putar Kiri</button>
            <button id="btn-preset-muslim" class="btn-secondary text-xs text-sky-300">Preset Santri Muslim</button>
            <button id="btn-preset-muslimah" class="btn-secondary text-xs text-pink-300">Preset Santri Muslimah</button>
            <button id="btn-rot-right" class="btn-secondary text-xs">Putar Kanan ⟳</button>
          </div>
        </div>

        <!-- Right Customization Panel -->
        <aside class="md:col-span-6 lg:col-span-5 interactive-layer bg-[#0f172a]/96 border-l border-slate-700 p-4 flex flex-col overflow-hidden max-h-screen">
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
              Simpan Avatar & Masuk Halaman Sekolah
            </button>
          </div>
        </aside>
      </div>
    `;

    this.bindAvatarEvents();
  }

  private bindAvatarEvents(): void {
    this.container.querySelector('#btn-back-login')?.addEventListener('click', () => {
      soundFX.playClick();
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
      this.render();
    });
    this.container.querySelector('#btn-preset-muslimah')?.addEventListener('click', () => {
      soundFX.playClick();
      this.avatar = { ...DEFAULT_AVATAR_MUSLIMAH };
      this.world.updateAvatarPreview(this.avatar);
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
        this.render();
      });
    });

    const bindSelect = (id: string, key: keyof AvatarConfig) => {
      const sel = this.container.querySelector<HTMLSelectElement>(id);
      sel?.addEventListener('change', () => {
        soundFX.playClick();
        (this.avatar as unknown as Record<string, string>)[key] = sel.value;
        this.world.updateAvatarPreview(this.avatar);
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
      realtimeClient.joinStudent({
        id: this.studentId ?? undefined,
        nama: this.nama,
        kelas: this.kelas,
        sekolah: this.sekolah,
        avatar: this.avatar,
      });
      this.screen = 'schoolyard';
      this.world.setViewMode('schoolyard');
      if (this.snapshot) {
        this.world.syncPeers(this.snapshot.participants, this.studentId);
      }
      this.render();
      this.onToast('Selamat datang di Halaman Sekolah! Klik Kios 3D di depan untuk mempelajari materi PAI.');
    });
  }

  // =====================================================================
  // 3. SCHOOLYARD LOBBY HUD + PENGUASAAN MATERI MODAL + SOLO PRACTICE PICKER
  // =====================================================================
  private renderSchoolyardHUD(): void {
    const mission = this.snapshot?.mission;
    const gameMeta = getMinigameMeta(mission?.gameId ?? 'puncak_nalar');
    const onlineCount = (this.snapshot?.participants ?? []).filter((p) => p.connected).length;

    this.container.innerHTML = `
      <div class="fixed inset-0 flex flex-col justify-between p-3 md:p-4 pointer-events-none">
        <!-- Top Bar -->
        <div class="flex flex-wrap items-center justify-between gap-2 pointer-events-auto">
          <div class="px-3.5 py-2 rounded-2xl bg-[#0f172a]/92 border border-amber-400/45 flex items-center gap-3">
            <div>
              <div class="font-display font-bold text-sm md:text-base text-white">${this.esc(this.nama)} <span class="text-xs text-sky-300 font-normal">· Kls ${this.esc(this.kelas)}</span></div>
              <div class="text-[11px] text-slate-300">${this.esc(this.sekolah)} · ${onlineCount} Peserta Online</div>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button id="btn-open-materi" class="btn-primary text-xs">Penguasaan Materi PAI</button>
            <button id="btn-edit-avatar" class="btn-secondary text-xs">Ubah Avatar</button>
            <button id="btn-sy-mute" class="btn-secondary text-xs">${soundFX.muted ? 'Audio: Mati' : 'Audio: Aktif'}</button>
            <button id="btn-sy-xr" class="btn-secondary text-xs text-sky-300">Mode XR</button>
            <button id="btn-sy-logout" class="btn-secondary text-xs text-rose-300">Keluar</button>
          </div>
        </div>

        <!-- Bottom Mission Waiting Dock + Mobile D-Pad -->
        <div class="flex items-end justify-between gap-3">
          <!-- Compact Touch Move Pad -->
          <div class="pointer-events-auto grid grid-cols-3 gap-1 w-28 bg-[#0f172a]/85 p-1.5 rounded-2xl border border-slate-700">
            <div></div>
            <button data-dir="up" class="js-dpad h-8 rounded-lg bg-slate-800 text-white font-bold text-xs">▲</button>
            <div></div>
            <button data-dir="left" class="js-dpad h-8 rounded-lg bg-slate-800 text-white font-bold text-xs">◀</button>
            <button id="btn-sy-jump" class="h-8 rounded-lg bg-emerald-600 text-white font-bold text-[10px]">LMP</button>
            <button data-dir="right" class="js-dpad h-8 rounded-lg bg-slate-800 text-white font-bold text-xs">▶</button>
            <div></div>
            <button data-dir="down" class="js-dpad h-8 rounded-lg bg-slate-800 text-white font-bold text-xs">▼</button>
            <div></div>
          </div>

          <!-- Mission Status Banner -->
          <div class="pointer-events-auto flex-1 max-w-xl bg-[#0f172a]/94 border-2 border-amber-400/50 rounded-2xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div class="text-[11px] font-bold text-amber-300 uppercase">
                ${mission?.status === 'playing' ? 'Misi Kelas Sedang Berlangsung!' : 'Halaman Sekolah · Menunggu Guru Memulai Misi'}
              </div>
              <div class="font-display font-bold text-sm md:text-base text-white">
                Mini-Game: ${this.esc(gameMeta.name)} (${mission?.gameDurationMin ?? 10} mnt)
              </div>
              <div class="text-[11px] text-slate-300">
                Jalan (WASD/Panah) & klik Kios 3D di halaman sekolah untuk membaca 5 Materi PAI!
              </div>
            </div>
            <div class="flex items-center gap-2">
              ${
                mission?.status === 'playing'
                  ? `<button id="btn-join-active-mission" class="btn-gold text-xs py-2.5">Gabung Misi Sekarang</button>`
                  : `<button id="btn-open-solo" class="btn-gold text-xs py-2.5">Latihan Mandiri (9 Game)</button>`
              }
            </div>
          </div>
        </div>
      </div>

      ${this.openMaterialElementId ? this.renderMaterialModal(this.openMaterialElementId) : ''}
      ${this.showSoloPicker ? this.renderSoloPickerModal() : ''}
    `;

    this.bindSchoolyardEvents();
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

  private renderSoloPickerModal(): string {
    return `
      <div class="modal-backdrop">
        <div class="modal-card max-w-3xl">
          <div class="flex items-center justify-between pb-3 border-b border-slate-700 mb-4">
            <div>
              <h2 class="font-display font-bold text-xl text-amber-300">Pilih Mini-Game Latihan Mandiri</h2>
              <p class="text-xs text-slate-300">Uji pemahaman 5 Elemen PAI sebelum misi kelas dimulai oleh Guru!</p>
            </div>
            <button id="btn-close-solo" class="btn-secondary text-xs">Tutup ✕</button>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            ${MINIGAMES.map(
              (g) => `
              <button data-solo-game="${g.id}" class="js-solo-launch text-left p-3.5 rounded-xl bg-slate-900 border-2 border-slate-700 hover:border-amber-400 cursor-pointer transition">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-[11px] font-bold px-2 py-0.5 rounded text-slate-950" style="background:${g.accent}">#${g.number}</span>
                  <span class="text-[10px] text-slate-400">${this.esc(g.badge)}</span>
                </div>
                <div class="font-display font-bold text-sm text-white">${this.esc(g.name)}</div>
                <div class="text-[11px] text-slate-300 mt-1">${this.esc(g.subtitle)}</div>
              </button>`
            ).join('')}
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

    this.container.querySelector('#btn-edit-avatar')?.addEventListener('click', () => {
      soundFX.playClick();
      this.screen = 'avatar';
      this.world.setViewMode('avatar_studio');
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
      this.screen = 'login';
      this.world.setViewMode('title');
      this.render();
    });

    this.container.querySelector('#btn-open-solo')?.addEventListener('click', () => {
      soundFX.playClick();
      this.showSoloPicker = true;
      this.render();
    });
    this.container.querySelector('#btn-close-solo')?.addEventListener('click', () => {
      soundFX.playClick();
      this.showSoloPicker = false;
      this.render();
    });
    this.container.querySelectorAll<HTMLButtonElement>('.js-solo-launch').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.beginMissionGame(true, btn.dataset.soloGame as GameId);
      });
    });
    this.container.querySelector('#btn-join-active-mission')?.addEventListener('click', () => {
      this.beginMissionGame(false);
    });

    // D-pad touch movement
    this.container.querySelectorAll<HTMLButtonElement>('.js-dpad').forEach((btn) => {
      const dir = btn.dataset.dir;
      const start = (e: Event) => {
        e.preventDefault();
        if (dir === 'up') this.world.setJoystick(0, -1);
        else if (dir === 'down') this.world.setJoystick(0, 1);
        else if (dir === 'left') this.world.setJoystick(-1, 0);
        else if (dir === 'right') this.world.setJoystick(1, 0);
      };
      const stop = () => this.world.setJoystick(0, 0);
      btn.addEventListener('pointerdown', start);
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointerleave', stop);
    });
    this.container.querySelector('#btn-sy-jump')?.addEventListener('click', () => {
      soundFX.playJump();
      this.world.triggerJump();
    });
  }

  // =====================================================================
  // 4. ACTIVE GAME HUD (10% TOP BAR + 20% LEFT QUIZ PANEL + 80% 3D VIEWPORT)
  // =====================================================================
  private renderPlayingHUD(): void {
    const gameMeta = getMinigameMeta(this.quiz.gameId);
    const q = this.quiz.currentQuestion;
    const elInfo = q ? paiBank.getElementById(q.elementId) : null;
    const participants = this.snapshot?.participants ?? [];
    const myRank =
      participants.find((p) => p.id === this.studentId)?.rank ?? 1;

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
              Peringkat: <strong class="text-sky-300 tabular-nums">#${myRank}</strong>
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
            ${
              this.isSoloMode
                ? `<button id="btn-finish-solo" class="px-2.5 py-1.5 rounded-lg bg-rose-600 text-white font-bold text-[11px] cursor-pointer">Selesai</button>`
                : ''
            }
          </div>
        </header>

        <!-- LEFT PANEL (20%): QUESTION & CONTROLS -->
        <aside class="game-left-panel">
          ${
            this.waitingForDiceRoll
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
                  <div class="space-y-1.5">
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
                  <div class="p-3 rounded-xl bg-slate-900 border border-slate-700 text-xs md:text-sm text-white leading-relaxed ${
                    this.hasArabic(q.prompt) ? 'font-arabic' : ''
                  }">
                    ${this.esc(q.prompt)}
                  </div>

                  <!-- Options -->
                  <div class="space-y-2 flex-1">
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
                      ? `<button id="btn-submit-pgk" class="btn-gold w-full py-2.5 text-sm" ${
                          this.selectedIndices.length === 0 ? 'disabled style="opacity:0.5"' : ''
                        }>Kirim Jawaban PGK (${this.selectedIndices.length} dipilih)</button>`
                      : ''
                  }

                  ${
                    this.lastFeedback
                      ? `<div class="p-2.5 rounded-xl text-xs font-semibold border ${
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

        <!-- RIGHT 80% 3D VIEWPORT FLOATING CONTROLS -->
        <div class="game-viewport-overlay">
          <!-- Minigame Progress Pill Top-Right -->
          <div class="absolute top-3 right-3 pointer-events-auto flex flex-col items-end gap-2">
            <div class="px-3.5 py-2 rounded-xl bg-[#0f172a]/90 border border-slate-600 text-xs text-right">
              <div class="text-[10px] text-slate-400">${this.esc(gameMeta.leaderboardMetric)}</div>
              <div class="font-display font-bold text-base text-amber-300 tabular-nums">
                ${this.quiz.progressValue} ${this.esc(gameMeta.leaderboardUnit)}
              </div>
            </div>

            ${this.renderMinigameSpecialControls()}
          </div>

          <!-- Controls Hint Bottom-Left of 3D Viewport -->
          <div class="hidden md:block absolute bottom-3 left-3 px-3 py-1.5 rounded-xl bg-[#0f172a]/85 border border-slate-700 text-[11px] text-slate-300">
            ${this.esc(gameMeta.controlsHint)}
          </div>
        </div>
      </div>

      ${this.showMiniLeaderboard ? this.renderMiniLeaderboardModal(participants, gameMeta) : ''}
      ${this.showBuffModal ? this.renderBuffChoiceModal(participants) : ''}
      ${this.showReflectionModal ? this.renderReflectionModal(myRank) : ''}
    `;

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
                ? `<p class="text-xs text-slate-400 text-center py-6">Mode latihan mandiri — skor kamu: ${this.quiz.score}</p>`
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
    const others = participants.filter((p) => p.id !== this.studentId && p.connected);
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
    this.container.querySelector('#btn-finish-solo')?.addEventListener('click', () => {
      this.finishSoloSession();
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
        id: this.studentId ?? `solo_${Date.now()}`,
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
      this.render();
    });

    this.container.querySelector('#btn-ref-schoolyard')?.addEventListener('click', () => {
      soundFX.playClick();
      this.showReflectionModal = false;
      this.screen = 'schoolyard';
      this.world.setViewMode('schoolyard');
      this.render();
    });
    this.container.querySelector('#btn-ref-login')?.addEventListener('click', () => {
      soundFX.playClick();
      this.showReflectionModal = false;
      this.screen = 'login';
      this.world.setViewMode('title');
      this.render();
    });
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
