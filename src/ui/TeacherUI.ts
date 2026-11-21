import * as XLSX from 'xlsx';
import type {
  ChatMessage,
  DifficultyLevel,
  GameId,
  LeaderboardParams,
  LeaderboardPresetId,
  LeaderboardSortBy,
  PaiElement,
  ParticipantState,
  QuestionItem,
  QuestionType,
  RoomSnapshot,
  TeacherAlert,
} from '../types.ts';
import {
  getDefaultLeaderboardParams,
  getMinigameMeta,
  LEADERBOARD_PRESETS,
  MINIGAMES,
} from '../constants.ts';
import {
  describeLeaderboardFormula,
  normalizeLeaderboardParams,
  rankParticipants,
} from '../game/LeaderboardScoring.ts';
import { paiBank } from '../data/paiBank.ts';
import { realtimeClient } from '../services/RealtimeClient.ts';
import { soundFX } from '../audio/SoundFX.ts';
import { ChatSidebar } from './ChatSidebar.ts';
import { TeacherAnalyticsOverlay } from './TeacherAnalyticsOverlay.ts';
import { clearSession, saveSession } from '../services/SessionStorage.ts';

export type TeacherTab = 'misi' | 'leaderboard' | 'materi' | 'soal' | 'laporan';

interface ActiveToastEntry {
  alert: TeacherAlert;
  timer: ReturnType<typeof setTimeout> | null;
}

export class TeacherUI {
  private container: HTMLElement;
  private sekolah = '';
  private adminCode = 'gpaibeji';
  private roomCode = 'PAI2026';
  private activeTab: TeacherTab = 'misi';
  private snapshot: RoomSnapshot | null = null;
  private onLogout: () => void;
  private onToast: (msg: string) => void;
  private exportingExcel = false;
  private isConnected = true;
  private recentLoginIds = new Map<string, number>();

  // Local mission draft synced with Firestore realtime
  private selectedElements = new Set<string>(['quran_hadis', 'akidah', 'akhlak', 'fiqih', 'spi']);
  private selectedGameId: GameId = 'puncak_nalar';
  private leaderboardParams: LeaderboardParams = getDefaultLeaderboardParams('puncak_nalar');
  private questionDurationSec = 25;
  private gameDurationMin = 10;
  private questionFilterElement = 'all';
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  // Persistent moderated chat sidebar state (active by default on desktop/tablet)
  private chatOpen = window.innerWidth >= 900;
  private unreadChatCount = 0;
  private chatSidebar: ChatSidebar;
  private analyticsOverlay: TeacherAnalyticsOverlay;
  private mounted = false;

  // Teacher Toast Notification & Moderation Alerts state
  private activeToasts: ActiveToastEntry[] = [];
  private alertsDrawerOpen = false;
  private unreadAlertCount = 0;

  constructor(
    container: HTMLElement,
    onLogout: () => void,
    onToast: (msg: string) => void
  ) {
    this.container = container;
    this.onLogout = onLogout;
    this.onToast = onToast;

    this.chatSidebar = new ChatSidebar({
      role: 'teacher',
      senderName: 'Guru PAI (Admin)',
      onToast: this.onToast,
    });

    this.analyticsOverlay = new TeacherAnalyticsOverlay({
      onClose: () => {},
      onExportExcel: () => {
        void this.downloadExcelReport();
      },
      onFocusElement: (elementId, elementName) => {
        this.selectedElements = new Set([elementId]);
        this.pushMissionConfig();
        this.analyticsOverlay.close();
        this.activeTab = 'misi';
        this.persistTeacherSession();
        this.renderNav();
        this.renderMainContent();
        this.onToast(
          `Misi berikutnya difokuskan ke elemen "${elementName}" untuk penguatan kelas!`
        );
      },
    });
  }

  mount(
    sekolah: string,
    snapshot: RoomSnapshot | null,
    initialTab?: TeacherTab,
    code = 'gpaibeji',
    roomCode?: string
  ): void {
    this.sekolah = sekolah;
    this.adminCode = code;
    this.roomCode =
      (roomCode || snapshot?.roomCode || this.roomCode || 'PAI2026').toUpperCase();
    if (initialTab) this.activeTab = initialTab;
    this.mounted = true;
    this.isConnected = realtimeClient.connected;
    this.persistTeacherSession();
    this.chatSidebar.setOptions({ senderName: `Guru PAI · ${sekolah}` });
    if (snapshot) {
      this.syncStateFromSnapshot(snapshot);
    }
    this.renderShell();
    this.renderNav();
    this.renderMainContent();
    this.mountChatIfOpen();
    this.updateHeaderCounters();
    this.updateClockDisplay();

    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => this.updateClockDisplay(), 500);
  }

  private persistTeacherSession(): void {
    saveSession({
      role: 'teacher',
      code: this.adminCode,
      roomCode: this.roomCode,
      sekolah: this.sekolah,
      activeTab: this.activeTab,
      savedAt: Date.now(),
    });
  }

  openAnalyticsOverlay(): void {
    if (!this.mounted) return;
    soundFX.playClick();
    this.analyticsOverlay.open(this.container, this.snapshot);
  }

  async downloadExcelReport(): Promise<void> {
    if (this.exportingExcel) return;
    this.exportingExcel = true;
    soundFX.playClick();
    this.onToast('Menyiapkan file Excel (.xlsx) nilai & progres peserta...');
    try {
      const snap = this.snapshot;
      const participants = snap?.participants ?? [];
      const gameMeta = getMinigameMeta(this.selectedGameId);
      const lp = normalizeLeaderboardParams(this.leaderboardParams, this.selectedGameId);
      const ranked = rankParticipants(participants, lp, this.selectedGameId);
      const elements = paiBank.getAllElements();

      const wb = XLSX.utils.book_new();

      // Sheet 1: Rekap Nilai & Progres
      const sheet1Rows = ranked.map((p) => {
        const pred =
          p.metrics.totalAnswered === 0
            ? 'Belum Mulai'
            : p.metrics.accuracyPct >= 85
              ? 'Sangat Baik (A)'
              : p.metrics.accuracyPct >= 70
                ? 'Baik (B)'
                : p.metrics.accuracyPct >= 55
                  ? 'Cukup (C)'
                  : 'Perlu Bimbingan';
        return {
          Peringkat: p.effectiveRank,
          'Nama Peserta': p.nama,
          Kelas: p.kelas,
          Sekolah: p.sekolah,
          'Mini-Game': gameMeta.name,
          'Skor Terbobot': p.metrics.compositeScore,
          'Skor Kuis': p.score,
          Benar: p.correctCount,
          Salah: p.wrongCount,
          'Akurasi (%)': p.metrics.accuracyPct,
          'Rata-rata Waktu (dtk)': p.metrics.avgResponseSec,
          'Skor Kecepatan': p.metrics.speedScore,
          Predikat: pred,
          'Level AKM': p.level.toUpperCase(),
          'Streak Maks': p.maxStreak,
          [`Progres (${gameMeta.leaderboardMetric})`]: `${p.progressValue} ${gameMeta.leaderboardUnit}`,
        };
      });
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          sheet1Rows.length > 0 ? sheet1Rows : [{ Info: 'Belum ada peserta terekam.' }]
        ),
        'Rekap Nilai'
      );

      // Sheet 2: Penguasaan per Elemen PAI
      const sheet2Rows = elements.map((el) => {
        let correct = 0;
        let total = 0;
        for (const p of participants) {
          for (const a of p.answeredLog ?? []) {
            if (a.elementId === el.id) {
              total += 1;
              if (a.isCorrect) correct += 1;
            }
          }
        }
        return {
          'Elemen PAI': el.name,
          Materi: el.materialTitle,
          'Total Dijawab': total,
          Benar: correct,
          Salah: total - correct,
          'Ketuntasan (%)': total > 0 ? Math.round((correct / total) * 100) : 0,
        };
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet2Rows), 'Per Elemen PAI');

      // Sheet 3: Log Jawaban Butir AKM
      const sheet3Rows: Array<Record<string, unknown>> = [];
      for (const p of participants) {
        for (const a of p.answeredLog ?? []) {
          sheet3Rows.push({
            Peserta: p.nama,
            Kelas: p.kelas,
            'ID Soal': a.questionId,
            Elemen: a.elementId,
            Kesukaran: a.difficulty.toUpperCase(),
            Tipe: a.type,
            Hasil: a.isCorrect ? 'Benar' : 'Salah',
            'Delta Poin': a.pointsDelta,
            'Waktu Jawab (dtk)': a.responseTimeSec,
          });
        }
      }
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          sheet3Rows.length > 0 ? sheet3Rows : [{ Info: 'Belum ada log jawaban soal.' }]
        ),
        'Analisis Butir AKM'
      );

      // Sheet 4: Refleksi & Testimoni Siswa
      const sheet4Rows = (snap?.testimonials ?? []).map((t) => ({
        Nama: t.nama,
        Kelas: t.kelas,
        Sekolah: t.sekolah,
        'Mini-Game': t.gameName,
        Skor: t.skor,
        Refleksi: t.refleksi,
        Komentar: t.komentar,
        'Kritik & Saran': t.kritikSaran,
      }));
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          sheet4Rows.length > 0 ? sheet4Rows : [{ Info: 'Belum ada refleksi siswa.' }]
        ),
        'Refleksi Siswa'
      );

      const dateStr = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `Laporan_Penilaian_PAI_${this.roomCode}_${dateStr}.xlsx`);
      soundFX.playCorrect();
      this.onToast('Laporan Penilaian Excel (.xlsx) berhasil diunduh!');
    } catch {
      soundFX.playWrong();
      this.onToast('Gagal mengekspor Excel. Silakan coba lagi.');
    } finally {
      this.exportingExcel = false;
    }
  }

  unmount(clearSaved = false): void {
    this.mounted = false;
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    for (const t of this.activeToasts) {
      if (t.timer) clearTimeout(t.timer);
    }
    this.activeToasts = [];
    this.analyticsOverlay.destroy();
    this.chatSidebar.unmount();
    if (clearSaved) {
      realtimeClient.clearTeacherSession();
      clearSession();
    }
    this.container.innerHTML = '';
  }

  private syncStateFromSnapshot(snapshot: RoomSnapshot): void {
    this.snapshot = snapshot;
    paiBank.setCustomContent(snapshot.customElements, snapshot.customQuestions);
    this.selectedGameId = snapshot.mission.gameId;
    this.leaderboardParams = normalizeLeaderboardParams(
      snapshot.mission.leaderboardParams,
      snapshot.mission.gameId
    );
    this.questionDurationSec = snapshot.mission.questionDurationSec;
    this.gameDurationMin = snapshot.mission.gameDurationMin;
    if (snapshot.roomCode && snapshot.roomCode !== this.roomCode) {
      this.roomCode = snapshot.roomCode;
      this.persistTeacherSession();
    }
    if (snapshot.mission.elementIds.length > 0) {
      this.selectedElements = new Set(snapshot.mission.elementIds);
    }
  }

  applySnapshot(snapshot: RoomSnapshot, rerender = true): void {
    this.syncStateFromSnapshot(snapshot);
    if (!this.mounted) return;

    this.chatSidebar.updateMessages(snapshot);
    this.analyticsOverlay.update(snapshot);
    this.updateHeaderCounters();
    this.updateAlertsUI();
    this.updateClockDisplay();

    if (!rerender) return;

    // Avoid interrupting text typing inside "Kelola Materi" or "Bank Soal" forms or dragging range sliders
    const mainEl = this.container.querySelector('#teacher-main-content');
    const active = document.activeElement as HTMLElement | null;
    const isInteractingWithInput =
      Boolean(mainEl && active && mainEl.contains(active)) &&
      ((active?.tagName === 'INPUT' && (active as HTMLInputElement).type === 'range') ||
        ((active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA' || active?.tagName === 'SELECT') &&
          (this.activeTab === 'materi' || this.activeTab === 'soal')));

    this.renderNav();
    if (!isInteractingWithInput) {
      this.renderMainContent();
    }
  }

  handleStudentLoggedIn(
    participant: ParticipantState,
    isNew: boolean,
    snapshot: RoomSnapshot
  ): void {
    this.recentLoginIds.set(participant.id, Date.now());
    soundFX.playCorrect();
    this.onToast(
      isNew
        ? `Peserta baru login: ${participant.nama} (Kelas ${participant.kelas} · ${participant.sekolah})`
        : `Peserta kembali online: ${participant.nama} (Kelas ${participant.kelas})`
    );
    this.applySnapshot(snapshot, true);
  }

  handleTeacherAlert(alert: TeacherAlert, snapshot: RoomSnapshot): void {
    this.snapshot = snapshot;
    if (!this.mounted) return;

    if (alert.severity === 'danger') {
      soundFX.playWrong();
    } else {
      soundFX.playSabotage();
    }

    if (!this.alertsDrawerOpen) {
      this.unreadAlertCount += 1;
    }
    this.pushToastAlert(alert);
    this.updateAlertsUI();
  }

  private pushToastAlert(alert: TeacherAlert): void {
    // Deduplicate identical toast ID
    if (this.activeToasts.some((t) => t.alert.id === alert.id)) return;
    // Keep max 4 visible toasts simultaneously
    while (this.activeToasts.length >= 4) {
      const oldest = this.activeToasts.shift();
      if (oldest?.timer) clearTimeout(oldest.timer);
    }

    const entry: ActiveToastEntry = {
      alert,
      timer: setTimeout(() => {
        this.dismissToastCard(alert.id);
      }, 10_000),
    };
    this.activeToasts.push(entry);
    this.renderToastStack();
  }

  private dismissToastCard(alertId: string): void {
    const idx = this.activeToasts.findIndex((t) => t.alert.id === alertId);
    if (idx < 0) return;
    const [removed] = this.activeToasts.splice(idx, 1);
    if (removed?.timer) clearTimeout(removed.timer);
    this.renderToastStack();
  }

  private getAlertBadgeMeta(kind: TeacherAlert['kind']): { title: string; badge: string; isChat: boolean } {
    switch (kind) {
      case 'chat_moderation_blocked':
        return { title: 'Moderasi Chat · Pesan Diblokir', badge: 'KATA TERLARANG', isChat: true };
      case 'chat_moderation_caps':
        return { title: 'Moderasi Chat · Huruf Kapital', badge: 'PERLU PANTAUAN', isChat: true };
      case 'chat_moderation_spam':
        return { title: 'Moderasi Chat · Spam Cepat', badge: 'ANTI SPAM', isChat: true };
      case 'off_mission_tab_switch':
        return { title: 'Deteksi Luar Misi · Pindah Tab', badge: 'KELUAR LAYAR', isChat: false };
      case 'off_mission_wrong_screen':
        return { title: 'Deteksi Luar Misi · Menu Lain', badge: 'DI LUAR MISI', isChat: false };
      case 'off_mission_idle':
      default:
        return { title: 'Deteksi Luar Misi · Tidak Aktif', badge: 'IDLE >45 DTK', isChat: false };
    }
  }

  private renderToastStack(): void {
    const stack = this.container.querySelector<HTMLElement>('#teacher-toast-container');
    if (!stack) return;

    const mutedIds = new Set(this.snapshot?.mutedParticipantIds ?? []);
    stack.innerHTML = this.activeToasts
      .map(({ alert }) => {
        const meta = this.getAlertBadgeMeta(alert.kind);
        const isDanger = alert.severity === 'danger';
        const isMuted = mutedIds.has(alert.participantId);
        const timeStr = new Date(alert.createdAt).toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        return `
          <div
            data-toast-id="${this.esc(alert.id)}"
            class="pointer-events-auto w-80 sm:w-96 rounded-2xl p-3.5 shadow-2xl border backdrop-blur-md transition ${
              isDanger
                ? 'bg-[#2a0f18]/95 border-rose-500/80 text-rose-50'
                : 'bg-[#241b0c]/95 border-amber-400/80 text-amber-50'
            }"
          >
            <div class="flex items-start justify-between gap-2 mb-1.5">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="px-1.5 py-0.5 rounded text-[10px] font-extrabold tracking-wide ${
                  isDanger ? 'bg-rose-500 text-white' : 'bg-amber-400 text-slate-950'
                }">${meta.badge}</span>
                <span class="text-xs font-bold">${meta.title}</span>
              </div>
              <button
                type="button"
                data-dismiss-toast="${this.esc(alert.id)}"
                class="js-dismiss-toast text-xs opacity-75 hover:opacity-100 px-1.5 py-0.5 rounded bg-black/25 cursor-pointer"
                title="Tutup notifikasi"
              >✕</button>
            </div>
            <p class="text-xs leading-relaxed opacity-95">${this.esc(alert.detail)}</p>
            ${
              alert.chatText
                ? `<div class="mt-2 px-2.5 py-1.5 rounded-lg bg-black/35 border border-white/10 text-[11px] italic text-rose-200 truncate">“${this.esc(alert.chatText)}”</div>`
                : ''
            }
            <div class="mt-2.5 flex items-center justify-between gap-2 pt-2 border-t border-white/10">
              <span class="text-[10px] opacity-70 tabular-nums">${timeStr}</span>
              <div class="flex items-center gap-1.5">
                <button
                  type="button"
                  data-toast-mute="${this.esc(alert.participantId)}"
                  class="js-toast-mute px-2 py-1 rounded-lg text-[11px] font-bold cursor-pointer ${
                    isMuted
                      ? 'bg-emerald-500 text-slate-950'
                      : 'bg-rose-600 hover:bg-rose-500 text-white'
                  }"
                >${isMuted ? 'Buka Bisu' : 'Bisukan Siswa'}</button>
                ${
                  meta.isChat
                    ? `<button type="button" data-toast-open-chat="${this.esc(alert.id)}" class="js-toast-open-chat px-2 py-1 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-[11px] font-bold cursor-pointer">Buka Chat</button>`
                    : `<button type="button" data-toast-focus-student="${this.esc(alert.id)}" class="js-toast-focus-student px-2 py-1 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-[11px] font-bold cursor-pointer">Pantau</button>`
                }
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    stack.querySelectorAll<HTMLButtonElement>('.js-dismiss-toast').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.dismissToast;
        if (id) this.dismissToastCard(id);
      });
    });

    stack.querySelectorAll<HTMLButtonElement>('.js-toast-mute').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pid = btn.dataset.toastMute;
        if (!pid) return;
        soundFX.playClick();
        realtimeClient.toggleMuteStudent(pid);
        this.onToast('Status bisu chat siswa diperbarui secara realtime.');
        this.renderToastStack();
      });
    });

    stack.querySelectorAll<HTMLButtonElement>('.js-toast-open-chat').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundFX.playClick();
        this.openChatSidebar();
        const id = btn.dataset.toastOpenChat;
        if (id) this.dismissToastCard(id);
      });
    });

    stack.querySelectorAll<HTMLButtonElement>('.js-toast-focus-student').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundFX.playClick();
        if (this.activeTab !== 'misi') {
          this.activeTab = 'misi';
          this.persistTeacherSession();
          this.renderNav();
          this.renderMainContent();
        }
        const id = btn.dataset.toastFocusStudent;
        if (id) this.dismissToastCard(id);
      });
    });
  }

  private openChatSidebar(): void {
    if (this.chatOpen) {
      this.chatSidebar.focusInput();
      return;
    }
    this.chatOpen = true;
    const aside = this.container.querySelector<HTMLElement>('#teacher-chat-sidebar');
    const btn = this.container.querySelector<HTMLButtonElement>('#btn-toggle-teacher-chat');
    if (aside) {
      aside.classList.remove('hidden');
      aside.classList.add('flex');
    }
    if (btn) {
      btn.innerHTML = `Sembunyikan Chat <span id="teacher-chat-badge" class="hidden ml-1 px-1.5 py-0.5 rounded-full bg-amber-400 text-slate-950 font-bold text-[10px]">0</span>`;
    }
    this.unreadChatCount = 0;
    this.mountChatIfOpen();
    this.updateChatBadge();
    this.chatSidebar.focusInput();
  }

  private updateAlertsUI(): void {
    const alerts = this.snapshot?.teacherAlerts ?? [];
    const badge = this.container.querySelector<HTMLElement>('#teacher-alerts-badge');
    if (badge) {
      const count = this.unreadAlertCount > 0 ? this.unreadAlertCount : alerts.length;
      if (count > 0) {
        badge.textContent = String(count);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
    if (this.alertsDrawerOpen) {
      this.renderAlertsDrawer();
    }
  }

  private renderAlertsDrawer(): void {
    const drawer = this.container.querySelector<HTMLElement>('#teacher-alerts-drawer');
    if (!drawer) return;
    drawer.classList.toggle('hidden', !this.alertsDrawerOpen);
    if (!this.alertsDrawerOpen) return;

    const alerts = this.snapshot?.teacherAlerts ?? [];
    const mutedIds = new Set(this.snapshot?.mutedParticipantIds ?? []);

    drawer.innerHTML = `
      <div class="flex items-center justify-between gap-2 pb-2.5 mb-2.5 border-b border-slate-700">
        <div>
          <div class="font-display font-bold text-sm text-amber-300">Log Notifikasi Moderasi & Luar Misi (${alerts.length})</div>
          <div class="text-[11px] text-slate-400">Otomatis mendeteksi pindah tab, idle, dan kata tidak sopan di forum chat.</div>
        </div>
        <div class="flex items-center gap-1.5">
          ${
            alerts.length > 0
              ? `<button id="btn-clear-all-alerts" type="button" class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-rose-700 text-[11px] font-semibold text-rose-200 cursor-pointer">Bersihkan</button>`
              : ''
          }
          <button id="btn-close-alerts-drawer" type="button" class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-200 cursor-pointer">Tutup ✕</button>
        </div>
      </div>
      ${
        alerts.length === 0
          ? `<div class="py-8 text-center text-xs text-slate-400">Belum ada peringatan moderasi atau aktivitas di luar misi. Kelas terpantau kondusif!</div>`
          : `<div class="space-y-2 max-h-72 overflow-y-auto pr-1">
              ${alerts
                .map((a) => {
                  const meta = this.getAlertBadgeMeta(a.kind);
                  const isMuted = mutedIds.has(a.participantId);
                  const timeStr = new Date(a.createdAt).toLocaleTimeString('id-ID', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  });
                  return `
                    <div class="p-2.5 rounded-xl border text-xs ${
                      a.severity === 'danger'
                        ? 'bg-rose-950/50 border-rose-500/50'
                        : 'bg-amber-950/40 border-amber-400/40'
                    }">
                      <div class="flex items-center justify-between gap-2 mb-1">
                        <span class="font-bold ${a.severity === 'danger' ? 'text-rose-300' : 'text-amber-300'}">${meta.title}</span>
                        <span class="text-[10px] text-slate-400 tabular-nums">${timeStr}</span>
                      </div>
                      <p class="text-slate-100 leading-snug">${this.esc(a.detail)}</p>
                      ${a.chatText ? `<div class="mt-1 text-[11px] italic text-rose-200">“${this.esc(a.chatText)}”</div>` : ''}
                      <div class="mt-2 flex items-center justify-end gap-1.5">
                        <button type="button" data-drawer-mute="${this.esc(a.participantId)}" class="js-drawer-mute px-2 py-0.5 rounded bg-slate-800 hover:bg-rose-700 text-[10px] font-bold text-slate-200 cursor-pointer">
                          ${isMuted ? 'Buka Bisu Chat' : 'Bisukan Siswa'}
                        </button>
                        <button type="button" data-drawer-del="${this.esc(a.id)}" class="js-drawer-del px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-300 cursor-pointer">
                          Hapus
                        </button>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>`
      }
    `;

    drawer.querySelector('#btn-close-alerts-drawer')?.addEventListener('click', () => {
      this.alertsDrawerOpen = false;
      this.renderAlertsDrawer();
    });
    drawer.querySelector('#btn-clear-all-alerts')?.addEventListener('click', () => {
      soundFX.playClick();
      realtimeClient.clearTeacherAlerts();
      this.unreadAlertCount = 0;
      this.updateAlertsUI();
      this.onToast('Seluruh log notifikasi moderasi dibersihkan.');
    });
    drawer.querySelectorAll<HTMLButtonElement>('.js-drawer-mute').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pid = btn.dataset.drawerMute;
        if (pid) realtimeClient.toggleMuteStudent(pid);
      });
    });
    drawer.querySelectorAll<HTMLButtonElement>('.js-drawer-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.drawerDel;
        if (id) realtimeClient.dismissTeacherAlert(id);
      });
    });
  }

  handleChatMessage(message: ChatMessage, snapshot: RoomSnapshot): void {
    this.snapshot = snapshot;
    if (!this.mounted) return;
    this.chatSidebar.updateMessages(snapshot);
    if (!this.chatOpen && message.senderRole === 'student') {
      this.unreadChatCount += 1;
      this.updateChatBadge();
    }
  }

  handleChatTyping(senderName: string, senderId: string): void {
    if (!this.mounted) return;
    this.chatSidebar.showTyping(senderName, senderId);
  }

  setConnectionStatus(connected: boolean): void {
    this.isConnected = connected;
    if (!this.mounted) return;
    const statusEl = this.container.querySelector<HTMLElement>('#teacher-rt-status');
    if (statusEl) {
      const transport = realtimeClient.transportLabel;
      statusEl.title = connected
        ? `Koneksi realtime terintegrasi (${transport})`
        : 'Menyambung ulang koneksi realtime...';
      statusEl.innerHTML = connected
        ? `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span><span>Realtime Aktif</span>`
        : `<span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span><span>Menyambung…</span>`;
      statusEl.className = `inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-bold ${
        connected
          ? 'bg-emerald-950/70 border-emerald-400/40 text-emerald-300'
          : 'bg-amber-950/70 border-amber-400/40 text-amber-300'
      }`;
    }
    this.updateHeaderCounters();
  }

  private generateRandomRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let suffix = '';
    for (let i = 0; i < 4; i++) {
      suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    return `PAI-${suffix}`;
  }

  private buildShareableJoinUrl(): string {
    const url = new URL(window.location.href);
    url.searchParams.set('code', this.roomCode);
    return url.toString();
  }

  private updateHeaderCounters(): void {
    const participants = this.snapshot?.participants ?? [];
    const onlineCount = participants.filter((p) => p.connected).length;
    const onlineEl = this.container.querySelector<HTMLElement>('#teacher-online-count');
    if (onlineEl) {
      const dotClass = this.isConnected
        ? onlineCount > 0
          ? 'bg-emerald-400 animate-pulse'
          : 'bg-sky-400 animate-pulse'
        : 'bg-amber-400 animate-pulse';
      onlineEl.innerHTML = `<span class="w-2 h-2 rounded-full ${dotClass} shrink-0"></span><span>Peserta Online: <span class="text-emerald-400 tabular-nums font-bold">${onlineCount}</span> / ${participants.length}</span>`;
    }
    const codeDisp = this.container.querySelector<HTMLElement>('#teacher-room-code-display');
    if (codeDisp) {
      codeDisp.textContent = this.roomCode;
    }
    const codeInp = this.container.querySelector<HTMLInputElement>('#inp-room-code-inline');
    if (codeInp && document.activeElement !== codeInp) {
      codeInp.value = this.roomCode;
    }
  }

  private updateChatBadge(): void {
    const badge = this.container.querySelector<HTMLElement>('#teacher-chat-badge');
    if (!badge) return;
    if (this.unreadChatCount > 0 && !this.chatOpen) {
      badge.textContent = String(this.unreadChatCount);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  private updateClockDisplay(): void {
    const el = this.container.querySelector<HTMLElement>('#teacher-mission-clock');
    if (!el || !this.snapshot) return;
    const m = this.snapshot.mission;
    if (m.status === 'playing' && m.endsAt) {
      const remSec = Math.max(0, Math.ceil((m.endsAt - Date.now()) / 1000));
      const mm = String(Math.floor(remSec / 60)).padStart(2, '0');
      const ss = String(remSec % 60).padStart(2, '0');
      el.textContent = `${mm}:${ss}`;
    } else if (m.status === 'finished') {
      el.textContent = 'SELESAI';
    } else {
      el.textContent = 'MENUNGGU';
    }
  }

  private renderShell(): void {
    this.container.innerHTML = `
      <div class="interactive-layer fixed inset-0 bg-[#0b1220] text-slate-100 flex flex-col overflow-hidden">
        <!-- Top Header -->
        <header class="bg-[#111c33] border-b border-slate-700 px-4 py-3 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-amber-400 text-slate-950 font-display font-bold text-lg flex items-center justify-center">
              GP
            </div>
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <h1 class="font-display font-bold text-lg leading-tight text-amber-300">
                  Dashboard Guru PAI · Nusantara 3D
                </h1>
                <span id="teacher-rt-status" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-bold ${
                  this.isConnected
                    ? 'bg-emerald-950/70 border-emerald-400/40 text-emerald-300'
                    : 'bg-amber-950/70 border-amber-400/40 text-amber-300'
                }">
                  <span class="w-2 h-2 rounded-full ${this.isConnected ? 'bg-emerald-400' : 'bg-amber-400'} animate-pulse"></span>
                  <span>${this.isConnected ? 'Realtime Aktif' : 'Menyambung…'}</span>
                </span>
              </div>
              <p class="text-xs text-slate-300">${this.esc(this.sekolah)} · Kode Admin: gpaibeji</p>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <!-- Enter Code / Kode Ruang Pill -->
            <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-indigo-950/80 border border-indigo-400/50 text-xs">
              <span class="text-[10px] font-bold uppercase text-indigo-300">Kode Ruang:</span>
              <strong id="teacher-room-code-display" class="font-display text-sm tracking-wider text-amber-300 select-all">${this.esc(this.roomCode)}</strong>
              <button id="btn-copy-room-code" type="button" class="px-1.5 py-0.5 rounded bg-indigo-900 hover:bg-indigo-800 text-[10px] font-bold text-white cursor-pointer" title="Salin Kode Ruang">Salin</button>
              <button id="btn-toggle-edit-code" type="button" class="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-bold text-sky-300 cursor-pointer" title="Ubah Kode Ruang">Ubah</button>
            </div>

            <div
              id="teacher-online-count"
              role="button"
              tabindex="0"
              title="Klik untuk menyegarkan & pantau daftar peserta realtime"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700/90 border border-slate-600 hover:border-emerald-400/70 text-xs font-semibold cursor-pointer transition select-none"
            >
              <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
              <span>Peserta Online: <span class="text-emerald-400 tabular-nums font-bold">0</span> / 0</span>
            </div>
            <div class="px-3 py-1.5 rounded-lg bg-slate-800 border border-amber-400/50 text-xs font-semibold">
              Status Misi: <span id="teacher-mission-clock" class="text-amber-300 tabular-nums font-bold">MENUNGGU</span>
            </div>
            <button id="btn-open-analytics-top" type="button" class="px-3 py-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-emerald-400 hover:brightness-110 text-slate-950 font-bold text-xs cursor-pointer shadow-md transition">
              Analitik Kelas
            </button>
            <button id="btn-export-excel-top" class="btn-gold text-xs py-1.5 px-3">
              Unduh Excel (.xlsx)
            </button>
            <button id="btn-toggle-alerts" type="button" class="btn-secondary text-xs relative" title="Notifikasi luar misi & moderasi chat">
              Notifikasi
              <span id="teacher-alerts-badge" class="hidden ml-1 px-1.5 py-0.5 rounded-full bg-rose-500 text-white font-bold text-[10px]">0</span>
            </button>
            <button id="btn-toggle-teacher-chat" class="btn-secondary text-xs relative">
              ${this.chatOpen ? 'Sembunyikan Chat' : 'Buka Live Chat'}
              <span id="teacher-chat-badge" class="hidden ml-1 px-1.5 py-0.5 rounded-full bg-amber-400 text-slate-950 font-bold text-[10px]">0</span>
            </button>
            <button id="btn-copy-link" class="btn-secondary text-xs">Salin Link</button>
            <button id="btn-teacher-logout" class="btn-secondary text-xs text-rose-300">Keluar</button>
          </div>

          <!-- Collapsible Inline Room Code Editor Bar -->
          <form id="form-edit-room-code" class="hidden w-full pt-2 mt-1 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-slate-300 font-semibold">Ubah Enter Code (Kode Ruang Kelas):</span>
              <input
                id="inp-room-code-inline"
                type="text"
                maxlength="12"
                required
                value="${this.esc(this.roomCode)}"
                class="input-dark text-xs py-1 px-2.5 w-36 uppercase font-bold tracking-wider"
                placeholder="Cth: PAI5A"
              />
              <button id="btn-random-room-code" type="button" class="btn-secondary text-[11px] py-1 px-2.5">Acak Kode</button>
              <button type="submit" class="btn-primary text-[11px] py-1 px-3">Simpan Kode Baru</button>
              <button id="btn-cancel-edit-code" type="button" class="btn-secondary text-[11px] py-1 px-2.5">Batal</button>
            </div>
            <span class="text-[11px] text-slate-400">Murid wajib memasukkan kode yang sama agar dapat masuk ke ruang kelas ini.</span>
          </form>

          <!-- Collapsible Alerts Drawer -->
          <div id="teacher-alerts-drawer" class="hidden w-full mt-2 p-3.5 rounded-2xl bg-[#0d1527] border border-amber-400/40 shadow-xl"></div>
        </header>

        <!-- Navigation Tabs -->
        <nav id="teacher-nav" class="bg-[#0f172a] border-b border-slate-800 px-4 py-2 flex gap-2 overflow-x-auto shrink-0"></nav>

        <!-- Split Workspace: Main Content + Persistent Moderated Chat Sidebar -->
        <div class="flex-1 min-h-0 flex overflow-hidden">
          <main id="teacher-main-content" class="flex-1 min-w-0 overflow-y-auto p-4 md:p-6"></main>
          <aside
            id="teacher-chat-sidebar"
            class="${this.chatOpen ? 'flex' : 'hidden'} w-80 lg:w-96 max-w-[90vw] border-l border-slate-700 bg-[#0f172a] shrink-0 flex-col min-h-0"
          ></aside>
        </div>

        <!-- Floating Teacher Moderation & Off-Mission Toast Stack -->
        <div id="teacher-toast-container" class="pointer-events-none fixed top-20 right-4 z-[70] flex flex-col gap-2.5 items-end"></div>
      </div>
    `;

    this.container.querySelector('#btn-toggle-alerts')?.addEventListener('click', () => {
      soundFX.playClick();
      this.alertsDrawerOpen = !this.alertsDrawerOpen;
      if (this.alertsDrawerOpen) {
        this.unreadAlertCount = 0;
      }
      this.updateAlertsUI();
      this.renderAlertsDrawer();
    });

    this.container.querySelector('#btn-open-analytics-top')?.addEventListener('click', () => {
      this.openAnalyticsOverlay();
    });

    const syncAndFocusParticipants = () => {
      soundFX.playClick();
      void realtimeClient.forceSyncNow().then((snap) => {
        const list = snap?.participants ?? this.snapshot?.participants ?? [];
        const on = list.filter((p) => p.connected).length;
        this.onToast(`Sinkronisasi realtime selesai · ${on} dari ${list.length} peserta sedang online.`);
      });
      if (this.activeTab !== 'misi') {
        this.activeTab = 'misi';
        this.persistTeacherSession();
        this.renderNav();
        this.renderMainContent();
      }
      requestAnimationFrame(() => {
        const panel = this.container.querySelector<HTMLElement>('#teacher-participants-panel');
        if (panel) {
          panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          panel.classList.add('ring-2', 'ring-emerald-400');
          setTimeout(() => panel.classList.remove('ring-2', 'ring-emerald-400'), 1400);
        }
      });
    };

    const onlineCountEl = this.container.querySelector<HTMLElement>('#teacher-online-count');
    onlineCountEl?.addEventListener('click', syncAndFocusParticipants);
    onlineCountEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        syncAndFocusParticipants();
      }
    });

    this.container.querySelector('#btn-copy-room-code')?.addEventListener('click', () => {
      soundFX.playClick();
      void navigator.clipboard?.writeText(this.roomCode);
      this.onToast(`Kode Ruang "${this.roomCode}" disalin! Bagikan kepada siswa untuk login.`);
    });

    const editForm = this.container.querySelector<HTMLFormElement>('#form-edit-room-code');
    const codeInput = this.container.querySelector<HTMLInputElement>('#inp-room-code-inline');

    this.container.querySelector('#btn-toggle-edit-code')?.addEventListener('click', () => {
      soundFX.playClick();
      editForm?.classList.toggle('hidden');
      if (codeInput && editForm && !editForm.classList.contains('hidden')) {
        codeInput.value = this.roomCode;
        codeInput.focus();
      }
    });

    this.container.querySelector('#btn-cancel-edit-code')?.addEventListener('click', () => {
      soundFX.playClick();
      editForm?.classList.add('hidden');
    });

    this.container.querySelector('#btn-random-room-code')?.addEventListener('click', () => {
      soundFX.playClick();
      if (codeInput) codeInput.value = this.generateRandomRoomCode();
    });

    editForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = (codeInput?.value || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
      if (raw.length < 3) {
        soundFX.playWrong();
        this.onToast('Kode Ruang minimal 3 karakter (huruf/angka).');
        return;
      }
      this.roomCode = raw;
      this.persistTeacherSession();
      realtimeClient.setRoomCode(raw);
      this.updateHeaderCounters();
      editForm.classList.add('hidden');
      soundFX.playCorrect();
      this.onToast(`Kode Ruang diperbarui menjadi "${raw}". Bagikan ke siswa untuk login!`);
    });

    this.container.querySelector('#btn-export-excel-top')?.addEventListener('click', () => {
      void this.downloadExcelReport();
    });

    this.container.querySelector('#btn-copy-link')?.addEventListener('click', () => {
      soundFX.playClick();
      const link = this.buildShareableJoinUrl();
      void navigator.clipboard?.writeText(link);
      this.onToast(
        `Link kelas dengan Kode Ruang "${this.roomCode}" berhasil disalin! Siswa yang membuka link langsung terisi kodenya.`
      );
    });

    this.container.querySelector('#btn-teacher-logout')?.addEventListener('click', () => {
      soundFX.playClick();
      clearSession();
      realtimeClient.clearTeacherSession();
      this.onLogout();
    });

    this.container.querySelector('#btn-toggle-teacher-chat')?.addEventListener('click', () => {
      soundFX.playClick();
      this.chatOpen = !this.chatOpen;
      const aside = this.container.querySelector<HTMLElement>('#teacher-chat-sidebar');
      const btn = this.container.querySelector<HTMLButtonElement>('#btn-toggle-teacher-chat');
      if (aside) {
        aside.classList.toggle('hidden', !this.chatOpen);
        aside.classList.toggle('flex', this.chatOpen);
      }
      if (btn) {
        btn.innerHTML = `${this.chatOpen ? 'Sembunyikan Chat' : 'Buka Live Chat'} <span id="teacher-chat-badge" class="hidden ml-1 px-1.5 py-0.5 rounded-full bg-amber-400 text-slate-950 font-bold text-[10px]">0</span>`;
      }
      if (this.chatOpen) {
        this.unreadChatCount = 0;
        this.mountChatIfOpen();
      } else {
        this.chatSidebar.unmount();
      }
      this.updateChatBadge();
    });
  }

  private mountChatIfOpen(): void {
    const aside = this.container.querySelector<HTMLElement>('#teacher-chat-sidebar');
    if (this.chatOpen && aside) {
      this.chatSidebar.mount(aside, this.snapshot);
    }
  }

  private renderNav(): void {
    const nav = this.container.querySelector<HTMLElement>('#teacher-nav');
    if (!nav) return;
    const gameMeta = getMinigameMeta(this.selectedGameId);
    nav.innerHTML = `
      ${this.tabBtn('misi', '1. Kontrol Misi & Peserta')}
      ${this.tabBtn('leaderboard', `2. Leaderboard (${gameMeta.name})`)}
      ${this.tabBtn('materi', '3. Kelola Materi & Elemen')}
      ${this.tabBtn('soal', `4. Bank Soal (${paiBank.getAllQuestions().length})`)}
      ${this.tabBtn('laporan', '5. Laporan & Excel (.xlsx)')}
    `;
    nav.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundFX.playClick();
        this.activeTab = btn.dataset.tab as TeacherTab;
        this.persistTeacherSession();
        this.renderNav();
        this.renderMainContent();
      });
    });
  }

  private renderMainContent(): void {
    const main = this.container.querySelector<HTMLElement>('#teacher-main-content');
    if (!main) return;
    const snap = this.snapshot;
    const participants = snap?.participants ?? [];
    const mission = snap?.mission;
    const gameMeta = getMinigameMeta(this.selectedGameId);

    main.innerHTML = `
      <div class="max-w-6xl mx-auto">
        ${this.activeTab === 'misi' ? this.renderMisiTab(mission, participants) : ''}
        ${this.activeTab === 'leaderboard' ? this.renderLeaderboardTab(participants, gameMeta) : ''}
        ${this.activeTab === 'materi' ? this.renderMateriTab() : ''}
        ${this.activeTab === 'soal' ? this.renderSoalTab() : ''}
        ${this.activeTab === 'laporan' ? this.renderLaporanTab(participants, snap?.testimonials ?? []) : ''}
      </div>
    `;

    this.bindMainEvents();
  }

  private tabBtn(id: TeacherTab, label: string): string {
    const active = this.activeTab === id;
    return `<button data-tab="${id}" class="px-4 py-2 rounded-lg text-sm font-bold whitespace-nowrap cursor-pointer transition ${
      active
        ? 'bg-emerald-500 text-slate-950'
        : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700'
    }">${label}</button>`;
  }

  private getActivityMeta(p: ParticipantState): { label: string; cls: string } {
    if (!p.connected) return { label: 'Offline', cls: 'bg-slate-800 text-slate-400' };
    if (p.activity === 'playing') return { label: 'Sedang Bermain', cls: 'bg-emerald-900 text-emerald-300' };
    if (p.activity === 'finished') return { label: 'Selesai / Refleksi', cls: 'bg-indigo-900 text-indigo-200' };
    if (p.activity === 'avatar') return { label: 'Buat Avatar', cls: 'bg-sky-900 text-sky-200' };
    if (p.isReady) return { label: 'Siap Misi', cls: 'bg-amber-400 text-slate-950 font-bold' };
    return { label: 'Halaman Sekolah', cls: 'bg-teal-900/80 text-teal-200' };
  }

  private renderMisiTab(
    mission: RoomSnapshot['mission'] | undefined,
    participants: RoomSnapshot['participants']
  ): string {
    const elements = paiBank.getAllElements();
    const isPlaying = mission?.status === 'playing';
    const isFinished = mission?.status === 'finished';
    const mutedIds = new Set(this.snapshot?.mutedParticipantIds ?? []);
    const waitingApproval = isPlaying
      ? participants.filter((p) => p.connected && !p.approvedForMission)
      : [];
    const readyCount = participants.filter((p) => p.connected && p.isReady).length;

    return `
      <div class="grid grid-cols-1 xl:grid-cols-12 gap-5">
        <!-- Left 7 cols: Mission Config -->
        <section class="xl:col-span-7 space-y-5">
          <!-- Admin Control Notice -->
          <div class="p-3.5 rounded-2xl bg-emerald-950/50 border border-emerald-400/40 text-xs text-emerald-200 flex items-center justify-between gap-3">
            <div>
              <strong>Kendali Penuh Guru (Admin):</strong> Mode mandiri siswa dinonaktifkan. Seluruh peserta yang mengakses link langsung terpantau di sini & berkumpul di Halaman Sekolah hingga Anda memulai atau menyetujui mereka masuk misi.
            </div>
          </div>

          <!-- Step A: Select PAI Elements -->
          <div class="bg-[#111c33] border border-slate-700 rounded-2xl p-4">
            <div class="flex items-center justify-between mb-3">
              <h2 class="font-display font-bold text-base text-amber-300">
                A. Pilih Elemen PAI untuk Misi
              </h2>
              <span class="text-xs text-slate-400">Aktif: ${this.selectedElements.size} elemen</span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              ${elements
                .map((el) => {
                  const checked = this.selectedElements.has(el.id);
                  const qCount = paiBank.countQuestionsByElement(el.id);
                  return `
                  <label class="flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer transition ${
                    checked
                      ? 'bg-emerald-950/50 border-emerald-400'
                      : 'bg-slate-900/70 border-slate-700 hover:border-slate-500'
                  }">
                    <input type="checkbox" class="mt-1 accent-emerald-400 js-el-check" value="${el.id}" ${
                      checked ? 'checked' : ''
                    } />
                    <div class="min-w-0">
                      <div class="font-bold text-sm text-white truncate">${this.esc(el.name)}</div>
                      <div class="text-xs text-slate-300 truncate">${this.esc(el.materialTitle)}</div>
                      <div class="text-[11px] text-emerald-300 mt-0.5">${qCount} butir soal AKM</div>
                    </div>
                  </label>`;
                })
                .join('')}
            </div>
          </div>

          <!-- Step B: Choose from 9 Minigames -->
          <div class="bg-[#111c33] border border-slate-700 rounded-2xl p-4">
            <h2 class="font-display font-bold text-base text-amber-300 mb-3">
              B. Pilih Mini-Game 3D (9 Pilihan Interaktif)
            </h2>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              ${MINIGAMES.map((g) => {
                const active = this.selectedGameId === g.id;
                return `
                  <button data-game="${g.id}" class="js-game-pick text-left p-3 rounded-xl border-2 cursor-pointer transition ${
                    active
                      ? 'bg-sky-950/70 border-amber-400'
                      : 'bg-slate-900/70 border-slate-700 hover:border-sky-400'
                  }">
                    <div class="flex items-center justify-between gap-1 mb-1">
                      <span class="text-[11px] font-bold px-2 py-0.5 rounded bg-slate-800 text-amber-300">#${g.number}</span>
                      <span class="text-[10px] text-slate-400">${this.esc(g.badge)}</span>
                    </div>
                    <div class="font-display font-bold text-sm text-white">${this.esc(g.name)}</div>
                    <div class="text-[11px] text-slate-300 mt-1 line-clamp-2">${this.esc(g.subtitle)}</div>
                  </button>
                `;
              }).join('')}
            </div>
          </div>

          <!-- Step C: Realtime Leaderboard Parameters (Speed vs Accuracy vs Progress) -->
          ${this.renderLeaderboardParamsPanel()}

          <!-- Step D: Timers & Launch Controls -->
          <div class="bg-[#111c33] border border-slate-700 rounded-2xl p-4">
            <h2 class="font-display font-bold text-base text-amber-300 mb-3">
              D. Durasi & Kendali Misi Kelas
            </h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="block text-xs font-semibold text-slate-300 mb-1">
                  Durasi Jawab per Soal: <span id="lbl-qdur" class="text-sky-300 font-bold tabular-nums">${this.questionDurationSec} detik</span>
                </label>
                <input id="inp-qdur" type="range" min="10" max="90" step="5" value="${this.questionDurationSec}" class="w-full accent-sky-400" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-300 mb-1">
                  Durasi Total Permainan: <span id="lbl-gdur" class="text-amber-300 font-bold tabular-nums">${this.gameDurationMin} menit</span>
                </label>
                <input id="inp-gdur" type="range" min="1" max="30" step="1" value="${this.gameDurationMin}" class="w-full accent-amber-400" />
              </div>
            </div>

            <div class="flex flex-wrap gap-3">
              ${
                !isPlaying
                  ? `<button id="btn-start-mission" class="btn-gold flex-1 text-base py-3">MULAI MISI & IZINKAN SEMUA PESERTA</button>`
                  : `<button id="btn-stop-mission" class="px-5 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold flex-1 cursor-pointer">AKHIRI MISI & BUKA REFLEKSI</button>`
              }
              ${
                isFinished
                  ? `<button id="btn-return-lobby" class="btn-primary">Kembali ke Halaman Sekolah</button>`
                  : ''
              }
              <button id="btn-save-config" class="btn-secondary">Simpan Pengaturan</button>
              <button id="btn-reset-room" class="btn-secondary text-rose-300">Reset Sesi</button>
            </div>
          </div>
        </section>

        <!-- Right 5 cols: Live Monitored Participants & Approval Controls -->
        <section id="teacher-participants-panel" class="xl:col-span-5 bg-[#111c33] border border-slate-700 rounded-2xl p-4 flex flex-col transition">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div>
              <h2 class="font-display font-bold text-base text-emerald-300">
                Pemantauan Peserta (${participants.length})
              </h2>
              <div class="text-[11px] text-slate-400">Online: ${participants.filter((p) => p.connected).length} · Siap Misi: ${readyCount} · Realtime</div>
            </div>
            <div class="flex items-center gap-1.5">
              <button id="btn-refresh-participants" type="button" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-[11px] font-semibold text-sky-300 cursor-pointer transition">
                Segarkan
              </button>
              ${
                waitingApproval.length > 0
                  ? `<button id="btn-approve-all" class="btn-gold text-[11px] py-1.5 px-3">Setujui Semua (${waitingApproval.length})</button>`
                  : ''
              }
            </div>
          </div>

          ${
            participants.length === 0
              ? `<div class="flex-1 flex flex-col items-center justify-center text-center py-12 text-slate-400 text-sm">
                  <p class="font-semibold text-slate-200 mb-1">Belum ada peserta di ruang kelas.</p>
                  <p>Bagikan link aplikasi kepada murid. Begitu murid masuk, nama dan posisi mereka di Halaman Sekolah langsung tampil di sini.</p>
                </div>`
              : `<div class="space-y-2 overflow-y-auto max-h-[600px] pr-1">
                  ${participants
                    .map((p) => {
                      const act = this.getActivityMeta(p);
                      const isMuted = mutedIds.has(p.id);
                      const needsApproval = isPlaying && p.connected && !p.approvedForMission;
                      const recentTs = this.recentLoginIds.get(p.id) ?? 0;
                      const isJustLoggedIn = Date.now() - recentTs < 25_000;
                      const loginTime = new Date(p.joinedAt).toLocaleTimeString('id-ID', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      });
                      return `
                    <div class="p-3 rounded-xl bg-slate-900/90 border ${
                      needsApproval
                        ? 'border-amber-400/70'
                        : isJustLoggedIn
                          ? 'border-emerald-400/80 shadow-md shadow-emerald-500/10'
                          : 'border-slate-700/80'
                    } space-y-2">
                      <div class="flex items-center justify-between gap-2">
                        <div class="min-w-0">
                          <div class="flex flex-wrap items-center gap-1.5">
                            <span class="w-2 h-2 rounded-full shrink-0 ${p.connected ? 'bg-emerald-400' : 'bg-slate-600'}"></span>
                            <span class="font-bold text-sm text-white truncate">${this.esc(p.nama)}</span>
                            <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-sky-300">Kls ${this.esc(p.kelas)}</span>
                            <span class="text-[10px] px-1.5 py-0.5 rounded ${act.cls}">${act.label}</span>
                            ${
                              isJustLoggedIn
                                ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500 text-slate-950 font-bold animate-pulse">BARU LOGIN</span>`
                                : ''
                            }
                            ${
                              isPlaying && p.approvedForMission
                                ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950 border border-emerald-400/40 text-emerald-300">Disetujui</span>`
                                : needsApproval
                                  ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-950 border border-amber-400/50 text-amber-300 font-bold">Menunggu Izin</span>`
                                  : ''
                            }
                          </div>
                          <div class="text-[11px] text-slate-400 truncate mt-0.5">${this.esc(p.sekolah)} · Level: ${p.level.toUpperCase()} · Masuk ${loginTime}</div>
                        </div>
                        <div class="text-right shrink-0">
                          <div class="font-display font-bold text-amber-300 tabular-nums">${p.score} pts</div>
                          <div class="text-[10px] text-slate-400">${p.progressValue} ${this.esc(p.progressLabel)}</div>
                        </div>
                      </div>

                      <div class="flex flex-wrap items-center justify-end gap-1.5 pt-1.5 border-t border-slate-800/80">
                        ${
                          needsApproval
                            ? `<button data-approve-id="${p.id}" class="js-approve-student px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-[11px] cursor-pointer">Setujui Masuk Misi</button>`
                            : ''
                        }
                        <button data-mute-pid="${p.id}" class="js-mute-participant px-2 py-1 rounded-lg text-[11px] font-semibold cursor-pointer ${
                          isMuted
                            ? 'bg-emerald-900 text-emerald-200 hover:bg-emerald-800'
                            : 'bg-slate-800 text-slate-300 hover:bg-rose-700 hover:text-white'
                        }">
                          ${isMuted ? 'Buka Bisu Chat' : 'Bisukan Chat'}
                        </button>
                      </div>
                    </div>`;
                    })
                    .join('')}
                </div>`
          }
        </section>
      </div>
    `;
  }

  private renderLeaderboardParamsPanel(): string {
    const gameMeta = getMinigameMeta(this.selectedGameId);
    const lp = normalizeLeaderboardParams(this.leaderboardParams, this.selectedGameId);
    const presetKeys = Object.keys(LEADERBOARD_PRESETS) as Array<Exclude<LeaderboardPresetId, 'custom'>>;
    const totalWeight = Math.max(1, lp.accuracyWeight + lp.speedWeight + lp.progressWeight);
    const accShare = Math.round((lp.accuracyWeight / totalWeight) * 100);
    const spdShare = Math.round((lp.speedWeight / totalWeight) * 100);
    const prgShare = Math.max(0, 100 - accShare - spdShare);

    return `
      <div class="bg-[#111c33] border border-sky-500/40 rounded-2xl p-4 space-y-3.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="font-display font-bold text-base text-sky-300">
              C. Parameter Leaderboard Realtime — ${this.esc(gameMeta.name)}
            </h2>
            <p class="text-[11px] text-slate-300 mt-0.5">
              Atur bobot <strong>Kecepatan vs Ketepatan vs Progres</strong> secara realtime. Perubahan langsung memperbarui peringkat kelas & perhitungan poin kuis!
            </p>
          </div>
          <button
            type="button"
            id="btn-reset-lp-default"
            class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-[11px] font-semibold text-amber-300 cursor-pointer"
          >
            Default ${this.esc(gameMeta.name)}
          </button>
        </div>

        <!-- One-Click Presets -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          ${presetKeys
            .map((key) => {
              const item = LEADERBOARD_PRESETS[key];
              const isAct = lp.preset === key;
              return `
                <button
                  type="button"
                  data-lp-preset="${key}"
                  class="js-lp-preset text-left p-2.5 rounded-xl border transition cursor-pointer ${
                    isAct
                      ? 'bg-sky-950/80 border-sky-400 text-white shadow-sm shadow-sky-500/20'
                      : 'bg-slate-900/70 border-slate-700 text-slate-300 hover:border-slate-500'
                  }"
                >
                  <div class="font-bold text-xs ${isAct ? 'text-sky-300' : 'text-white'}">${item.label}</div>
                  <div class="text-[10px] text-slate-400 mt-0.5 leading-snug">${item.shortDesc}</div>
                </button>
              `;
            })
            .join('')}
        </div>

        <!-- Visual Balance Bar -->
        <div class="space-y-1">
          <div class="flex items-center justify-between text-[11px] font-semibold">
            <span class="text-emerald-300">Ketepatan ${accShare}%</span>
            <span class="text-amber-300">Kecepatan ${spdShare}%</span>
            <span class="text-sky-300">Progres (${this.esc(gameMeta.leaderboardMetric)}) ${prgShare}%</span>
          </div>
          <div class="w-full h-2.5 rounded-full overflow-hidden bg-slate-800 flex">
            <div style="width:${accShare}%" class="bg-emerald-400 transition-all duration-200"></div>
            <div style="width:${spdShare}%" class="bg-amber-400 transition-all duration-200"></div>
            <div style="width:${prgShare}%" class="bg-sky-400 transition-all duration-200"></div>
          </div>
        </div>

        <!-- Weight & Scoring Sliders -->
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
            <label class="flex items-center justify-between text-slate-300 font-semibold mb-1">
              <span>Bobot Ketepatan</span>
              <span id="lbl-lp-acc" class="text-emerald-300 font-bold tabular-nums">${lp.accuracyWeight}%</span>
            </label>
            <input id="inp-lp-acc" type="range" min="0" max="100" step="5" value="${lp.accuracyWeight}" class="w-full accent-emerald-400" />
          </div>
          <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
            <label class="flex items-center justify-between text-slate-300 font-semibold mb-1">
              <span>Bobot Kecepatan</span>
              <span id="lbl-lp-spd" class="text-amber-300 font-bold tabular-nums">${lp.speedWeight}%</span>
            </label>
            <input id="inp-lp-spd" type="range" min="0" max="100" step="5" value="${lp.speedWeight}" class="w-full accent-amber-400" />
          </div>
          <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
            <label class="flex items-center justify-between text-slate-300 font-semibold mb-1">
              <span>Bobot Progres</span>
              <span id="lbl-lp-prg" class="text-sky-300 font-bold tabular-nums">${lp.progressWeight}%</span>
            </label>
            <input id="inp-lp-prg" type="range" min="0" max="100" step="5" value="${lp.progressWeight}" class="w-full accent-sky-400" />
          </div>
        </div>

        <!-- Advanced Fine-Tuning Row -->
        <div class="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
          <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
            <label class="flex items-center justify-between text-slate-300 font-semibold mb-1">
              <span>Batas Cepat</span>
              <span id="lbl-lp-fast" class="text-amber-300 font-bold tabular-nums">≤ ${lp.fastThresholdSec} dtk</span>
            </label>
            <input id="inp-lp-fast" type="range" min="4" max="45" step="1" value="${lp.fastThresholdSec}" class="w-full accent-amber-400" />
          </div>
          <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
            <label class="flex items-center justify-between text-slate-300 font-semibold mb-1">
              <span>Bonus Streak</span>
              <span id="lbl-lp-streak" class="text-emerald-300 font-bold tabular-nums">+${lp.streakBonus}</span>
            </label>
            <input id="inp-lp-streak" type="range" min="0" max="40" step="2" value="${lp.streakBonus}" class="w-full accent-emerald-400" />
          </div>
          <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
            <label class="flex items-center justify-between text-slate-300 font-semibold mb-1">
              <span>Penalti Salah</span>
              <span id="lbl-lp-penalty" class="text-rose-300 font-bold tabular-nums">-${lp.wrongPenalty}</span>
            </label>
            <input id="inp-lp-penalty" type="range" min="0" max="40" step="2" value="${lp.wrongPenalty}" class="w-full accent-rose-400" />
          </div>
          <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
            <label class="block text-slate-300 font-semibold mb-1">Urutan Utama</label>
            <select id="sel-lp-sort" class="input-dark text-xs py-1 px-2">
              <option value="composite" ${lp.sortBy === 'composite' ? 'selected' : ''}>Skor Terbobot (Auto)</option>
              <option value="score" ${lp.sortBy === 'score' ? 'selected' : ''}>Skor Kuis Murni</option>
              <option value="accuracy" ${lp.sortBy === 'accuracy' ? 'selected' : ''}>Ketepatan (%)</option>
              <option value="speed" ${lp.sortBy === 'speed' ? 'selected' : ''}>Kecepatan Jawab</option>
              <option value="progress" ${lp.sortBy === 'progress' ? 'selected' : ''}>Progres ${this.esc(gameMeta.leaderboardMetric)}</option>
            </select>
          </div>
        </div>
      </div>
    `;
  }

  private renderLeaderboardTab(
    participants: RoomSnapshot['participants'],
    gameMeta: ReturnType<typeof getMinigameMeta>
  ): string {
    const lp = normalizeLeaderboardParams(this.leaderboardParams, gameMeta.id);
    const ranked = rankParticipants(participants, lp, gameMeta.id);
    const maxComposite = Math.max(100, ...ranked.map((p) => Math.max(p.metrics.compositeScore, p.score)));

    return `
      <div class="space-y-5">
        ${this.renderLeaderboardParamsPanel()}

        <div class="bg-[#111c33] border border-slate-700 rounded-2xl p-5">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-5 pb-4 border-b border-slate-700">
            <div>
              <span class="text-xs font-bold px-2.5 py-1 rounded-md text-slate-950" style="background:${gameMeta.accent}">
                MINI-GAME #${gameMeta.number} · ${this.esc(gameMeta.badge)}
              </span>
              <h2 class="font-display font-bold text-2xl text-white mt-2">
                Leaderboard Realtime — ${this.esc(gameMeta.name)}
              </h2>
              <p class="text-xs text-sky-300 mt-0.5 font-semibold">${this.esc(describeLeaderboardFormula(lp))}</p>
            </div>
            <div class="flex flex-wrap items-center gap-2.5">
              <div class="text-right">
                <div class="text-xs text-slate-400">Metrik Khusus Permainan</div>
                <div class="font-display font-bold text-lg text-amber-300">${this.esc(gameMeta.leaderboardMetric)} (${this.esc(gameMeta.leaderboardUnit)})</div>
              </div>
              <button type="button" class="js-open-analytics px-3.5 py-2.5 rounded-xl bg-gradient-to-r from-sky-500 to-emerald-400 hover:brightness-110 text-slate-950 font-bold text-xs cursor-pointer shrink-0">
                Buka Analitik Kelas
              </button>
              <button type="button" class="js-export-excel btn-gold text-xs py-2.5 px-3.5 shrink-0">
                Ekspor Excel (.xlsx)
              </button>
            </div>
          </div>

          ${
            ranked.length === 0
              ? `<p class="text-center py-12 text-slate-400">Belum ada skor peserta yang tercatat.</p>`
              : `<div class="space-y-3">
                  ${ranked
                    .map((p, idx) => {
                      const mainVal = lp.sortBy === 'score' ? p.score : p.metrics.compositeScore;
                      const pct = Math.min(100, Math.round((mainVal / maxComposite) * 100));
                      const medal =
                        idx === 0
                          ? 'bg-amber-400 text-slate-950'
                          : idx === 1
                            ? 'bg-slate-300 text-slate-950'
                            : idx === 2
                              ? 'bg-orange-400 text-slate-950'
                              : 'bg-slate-800 text-slate-200';
                      return `
                        <div class="p-4 rounded-xl bg-slate-900/90 border border-slate-700">
                          <div class="flex flex-wrap items-center justify-between gap-3 mb-2">
                            <div class="flex items-center gap-3">
                              <div class="w-9 h-9 rounded-xl font-display font-bold flex items-center justify-center ${medal}">
                                #${idx + 1}
                              </div>
                              <div>
                                <div class="font-bold text-base text-white">${this.esc(p.nama)} <span class="text-xs font-normal text-sky-300">(Kelas ${this.esc(p.kelas)})</span></div>
                                <div class="text-xs text-slate-400">
                                  ${this.esc(p.sekolah)} · Level ${p.level.toUpperCase()} · Akurasi <strong class="text-emerald-300">${p.metrics.accuracyPct}%</strong> · Rata-rata <strong class="text-amber-300">${p.metrics.avgResponseSec > 0 ? `${p.metrics.avgResponseSec}d` : '-'}</strong> · Streak ${p.streak}x
                                </div>
                              </div>
                            </div>
                            <div class="flex items-center gap-4">
                              <div class="text-right">
                                <div class="text-[11px] text-slate-400">${this.esc(gameMeta.leaderboardMetric)}</div>
                                <div class="font-bold text-sky-300 tabular-nums">${p.progressValue} ${this.esc(gameMeta.leaderboardUnit)}</div>
                              </div>
                              <div class="text-right">
                                <div class="text-[11px] text-slate-400">Skor Kuis</div>
                                <div class="font-bold text-slate-200 tabular-nums">${p.score}</div>
                              </div>
                              <div class="text-right">
                                <div class="text-[11px] text-slate-400">${lp.sortBy === 'score' ? 'Skor Utama' : 'Skor Terbobot'}</div>
                                <div class="font-display font-bold text-xl text-amber-300 tabular-nums">${mainVal}</div>
                              </div>
                            </div>
                          </div>
                          <div class="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                            <div class="h-full rounded-full transition-all duration-300" style="width:${Math.max(4, pct)}%; background:${gameMeta.accent}"></div>
                          </div>
                        </div>`;
                    })
                    .join('')}
                </div>`
          }
        </div>
      </div>
    `;
  }

  private renderMateriTab(): string {
    const elements = paiBank.getAllElements();
    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div class="lg:col-span-7 space-y-3">
          <h2 class="font-display font-bold text-lg text-amber-300">Elemen & Materi PAI Aktif (${elements.length})</h2>
          ${elements
            .map(
              (el) => `
            <div class="p-4 rounded-2xl bg-[#111c33] border border-slate-700">
              <div class="flex items-center justify-between gap-2 mb-1">
                <span class="font-display font-bold text-base text-white">${this.esc(el.name)}</span>
                <span class="text-xs px-2 py-0.5 rounded-md font-bold text-slate-950" style="background:${el.color}">
                  ${paiBank.countQuestionsByElement(el.id)} Soal
                </span>
              </div>
              <div class="text-sm font-semibold text-sky-300">${this.esc(el.materialTitle)}</div>
              <p class="text-xs text-slate-300 mt-1">${this.esc(el.subtitle)}</p>
            </div>`
            )
            .join('')}
        </div>

        <form id="form-add-element" class="lg:col-span-5 bg-[#111c33] border border-slate-700 rounded-2xl p-5 space-y-3 h-fit">
          <h3 class="font-display font-bold text-lg text-emerald-300">Tambah Elemen / Materi Baru</h3>
          <p class="text-xs text-slate-400">Elemen baru langsung muncul di Kios 3D Halaman Sekolah & dapat ditambahkan bank soalnya.</p>
          <div>
            <label class="block text-xs font-semibold mb-1">Nama Elemen PAI</label>
            <input name="name" required class="input-dark" placeholder="Contoh: Al-Qur'an & Tajwid Lanjutan" />
          </div>
          <div>
            <label class="block text-xs font-semibold mb-1">Judul Materi</label>
            <input name="materialTitle" required class="input-dark" placeholder="Contoh: Materi 6: Q.S. Al-Ma'un" />
          </div>
          <div>
            <label class="block text-xs font-semibold mb-1">Ringkasan Singkat</label>
            <input name="subtitle" required class="input-dark" placeholder="Peduli anak yatim & fakir miskin" />
          </div>
          <div>
            <label class="block text-xs font-semibold mb-1">Isi Materi Pembelajaran</label>
            <textarea name="body" rows="5" required class="input-dark" placeholder="Tulis poin-poin materi pelajaran yang akan dibaca siswa di kios 3D..."></textarea>
          </div>
          <div>
            <label class="block text-xs font-semibold mb-1">Warna Kios 3D</label>
            <input name="color" type="color" value="#14b8a6" class="h-10 w-24 rounded bg-slate-900 border border-slate-600 cursor-pointer" />
          </div>
          <button type="submit" class="btn-primary w-full">Simpan Elemen & Materi Baru</button>
        </form>
      </div>
    `;
  }

  private renderSoalTab(): string {
    const elements = paiBank.getAllElements();
    const allQ = paiBank.getAllQuestions();
    const filtered =
      this.questionFilterElement === 'all'
        ? allQ
        : allQ.filter((q) => q.elementId === this.questionFilterElement);

    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <form id="form-add-question" class="lg:col-span-5 bg-[#111c33] border border-slate-700 rounded-2xl p-5 space-y-3 h-fit">
          <h3 class="font-display font-bold text-lg text-emerald-300">Tambah Soal AKM Baru</h3>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-xs font-semibold mb-1">Elemen PAI</label>
              <select name="elementId" class="input-dark text-xs">
                ${elements.map((e) => `<option value="${e.id}">${this.esc(e.name)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold mb-1">Tingkat Kesukaran</label>
              <select name="difficulty" class="input-dark text-xs">
                <option value="mudah">Mudah (Mengetahui)</option>
                <option value="sedang">Sedang (Menerapkan)</option>
                <option value="sulit">Sulit (Merefleksi)</option>
              </select>
            </div>
          </div>
          <div>
            <label class="block text-xs font-semibold mb-1">Tipe Soal AKM</label>
            <select name="type" id="sel-q-type" class="input-dark text-xs">
              <option value="PG">Pilihan Ganda (PG - 1 Kunci)</option>
              <option value="PGK">Pilihan Ganda Kompleks (PGK - Multi Kunci)</option>
              <option value="BS">Benar / Salah (B/S)</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold mb-1">Pertanyaan</label>
            <textarea name="prompt" rows="3" required class="input-dark text-xs" placeholder="Tulis pertanyaan di sini..."></textarea>
          </div>
          <div id="pg-options-wrap" class="space-y-2">
            <input name="opt0" class="input-dark text-xs" placeholder="Pilihan A (atau Benar)" />
            <input name="opt1" class="input-dark text-xs" placeholder="Pilihan B (atau Salah)" />
            <input name="opt2" class="input-dark text-xs" placeholder="Pilihan C (kosongkan jika B/S)" />
            <input name="opt3" class="input-dark text-xs" placeholder="Pilihan D (kosongkan jika B/S)" />
          </div>
          <div>
            <label class="block text-xs font-semibold mb-1">Kunci Jawaban (indeks 1-4, pisahkan koma untuk PGK, cth: 1 atau 1,3)</label>
            <input name="keys" required class="input-dark text-xs" placeholder="Contoh: 1 (untuk A/Benar) atau 1,3 (untuk PGK)" value="1" />
          </div>
          <div>
            <label class="block text-xs font-semibold mb-1">Pembahasan Singkat</label>
            <input name="explanation" required class="input-dark text-xs" placeholder="Penjelasan singkat mengapa jawaban ini benar" />
          </div>
          <button type="submit" class="btn-primary w-full">Tambahkan ke Bank Soal</button>
        </form>

        <div class="lg:col-span-7 bg-[#111c33] border border-slate-700 rounded-2xl p-4 flex flex-col">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 class="font-display font-bold text-base text-amber-300">
              Daftar Bank Soal (${filtered.length} butir)
            </h3>
            <select id="filter-q-el" class="input-dark text-xs w-auto">
              <option value="all" ${this.questionFilterElement === 'all' ? 'selected' : ''}>Semua Elemen (${allQ.length})</option>
              ${elements
                .map(
                  (e) =>
                    `<option value="${e.id}" ${this.questionFilterElement === e.id ? 'selected' : ''}>${this.esc(e.shortName)} (${paiBank.countQuestionsByElement(e.id)})</option>`
                )
                .join('')}
            </select>
          </div>
          <div class="space-y-2 overflow-y-auto max-h-[580px] pr-1">
            ${filtered
              .slice(0, 60)
              .map(
                (q, idx) => `
              <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-700/80 text-xs">
                <div class="flex items-center gap-2 mb-1">
                  <span class="font-bold text-amber-300">#${idx + 1}</span>
                  <span class="px-1.5 py-0.5 rounded bg-sky-900 text-sky-200 font-bold">${q.type}</span>
                  <span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 uppercase">${q.difficulty}</span>
                  <span class="text-slate-400">${this.esc(q.cognitiveLevel)}</span>
                </div>
                <p class="text-slate-100 leading-relaxed">${this.esc(q.prompt)}</p>
              </div>`
              )
              .join('')}
            ${
              filtered.length > 60
                ? `<p class="text-center text-xs text-slate-400 py-2">Menampilkan 60 dari ${filtered.length} soal. Gunakan filter elemen untuk melihat lebih spesifik.</p>`
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }

  private renderLaporanTab(
    participants: RoomSnapshot['participants'],
    testimonials: RoomSnapshot['testimonials']
  ): string {
    const totalAnswered = participants.reduce((acc, p) => acc + p.correctCount + p.wrongCount, 0);
    const totalCorrect = participants.reduce((acc, p) => acc + p.correctCount, 0);
    const avgAcc = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;

    return `
      <div class="space-y-5">
        <div class="bg-[#111c33] border border-amber-400/40 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 class="font-display font-bold text-xl text-amber-300">
              Ekspor Laporan Penilaian & Progres Siswa (.xlsx)
            </h2>
            <p class="text-xs text-slate-300 mt-1">
              Berisi 4 lembar kerja penilaian lengkap: <strong>Rekap Nilai & Progres</strong>, <strong>Penguasaan per Elemen PAI</strong>, <strong>Analisis Butir Soal AKM</strong>, dan <strong>Refleksi & Testimoni Siswa</strong>.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2.5">
            <button type="button" class="js-open-analytics px-4 py-3 rounded-xl bg-gradient-to-r from-sky-500 to-emerald-400 hover:brightness-110 text-slate-950 font-bold text-sm cursor-pointer">
              Buka Grafik Analitik Kelas
            </button>
            <button type="button" class="js-export-excel btn-gold inline-flex items-center gap-2 text-sm py-3 px-5">
              Unduh Laporan Excel (.xlsx)
            </button>
          </div>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div class="p-4 rounded-xl bg-[#111c33] border border-slate-700">
            <div class="text-xs text-slate-400">Total Peserta</div>
            <div class="font-display font-bold text-2xl text-white tabular-nums">${participants.length}</div>
          </div>
          <div class="p-4 rounded-xl bg-[#111c33] border border-slate-700">
            <div class="text-xs text-slate-400">Total Jawaban</div>
            <div class="font-display font-bold text-2xl text-sky-300 tabular-nums">${totalAnswered}</div>
          </div>
          <div class="p-4 rounded-xl bg-[#111c33] border border-slate-700">
            <div class="text-xs text-slate-400">Rata-rata Ketuntasan</div>
            <div class="font-display font-bold text-2xl text-emerald-400 tabular-nums">${avgAcc}%</div>
          </div>
          <div class="p-4 rounded-xl bg-[#111c33] border border-slate-700">
            <div class="text-xs text-slate-400">Refleksi Tersimpan</div>
            <div class="font-display font-bold text-2xl text-amber-300 tabular-nums">${testimonials.length}</div>
          </div>
        </div>

        <!-- Live Preview Table of Scores & Progress Included in Excel Export -->
        <div class="bg-[#111c33] border border-slate-700 rounded-2xl p-5">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 class="font-display font-bold text-base text-emerald-300">
              Pratinjau Data Penilaian Peserta (Siap Ekspor Excel)
            </h3>
            <span class="text-xs text-slate-400">${participants.length} peserta terekam</span>
          </div>
          ${
            participants.length === 0
              ? `<p class="text-sm text-slate-400 py-6 text-center">Belum ada peserta yang terekam pada sesi ini.</p>`
              : `<div class="overflow-x-auto">
                  <table class="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr class="bg-slate-900 text-amber-300 border-b border-slate-700">
                        <th class="p-2.5">#</th>
                        <th class="p-2.5">Nama Peserta</th>
                        <th class="p-2.5">Kelas</th>
                        <th class="p-2.5">Skor</th>
                        <th class="p-2.5">Benar / Salah</th>
                        <th class="p-2.5">Akurasi</th>
                        <th class="p-2.5">Predikat</th>
                        <th class="p-2.5">Level</th>
                        <th class="p-2.5">Progres</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${participants
                        .map((p) => {
                          const total = p.correctCount + p.wrongCount;
                          const acc = total > 0 ? Math.round((p.correctCount / total) * 100) : 0;
                          const pred =
                            total === 0
                              ? 'Belum Mulai'
                              : acc >= 85
                                ? 'Sangat Baik (A)'
                                : acc >= 70
                                  ? 'Baik (B)'
                                  : acc >= 55
                                    ? 'Cukup (C)'
                                    : 'Perlu Bimbingan';
                          return `
                            <tr class="border-b border-slate-800 hover:bg-slate-900/60">
                              <td class="p-2.5 font-bold text-amber-300 tabular-nums">#${p.rank}</td>
                              <td class="p-2.5 font-semibold text-white">${this.esc(p.nama)}</td>
                              <td class="p-2.5 text-sky-300">Kls ${this.esc(p.kelas)}</td>
                              <td class="p-2.5 font-bold text-amber-300 tabular-nums">${p.score}</td>
                              <td class="p-2.5 tabular-nums"><span class="text-emerald-400">${p.correctCount}</span> / <span class="text-rose-400">${p.wrongCount}</span></td>
                              <td class="p-2.5 font-bold text-emerald-300 tabular-nums">${acc}%</td>
                              <td class="p-2.5 text-slate-200">${pred}</td>
                              <td class="p-2.5 uppercase text-slate-300">${p.level}</td>
                              <td class="p-2.5 text-slate-300">${p.progressValue} ${this.esc(p.progressLabel)}</td>
                            </tr>`;
                        })
                        .join('')}
                    </tbody>
                  </table>
                </div>`
          }
        </div>

        <div class="bg-[#111c33] border border-slate-700 rounded-2xl p-5">
          <h3 class="font-display font-bold text-base text-white mb-3">
            Catatan Refleksi, Komentar, Kritik & Saran Siswa (Tersimpan Permanen)
          </h3>
          ${
            testimonials.length === 0
              ? `<p class="text-sm text-slate-400 py-6 text-center">Belum ada refleksi siswa yang dikirimkan.</p>`
              : `<div class="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[380px] overflow-y-auto pr-1">
                  ${testimonials
                    .slice()
                    .reverse()
                    .map(
                      (t) => `
                    <div class="p-3.5 rounded-xl bg-slate-900/90 border border-slate-700 text-xs space-y-1.5">
                      <div class="flex items-center justify-between">
                        <span class="font-bold text-amber-300">${this.esc(t.nama)} (Kls ${this.esc(t.kelas)})</span>
                        <span class="text-emerald-400 font-bold tabular-nums">${t.skor} pts</span>
                      </div>
                      <div class="text-[11px] text-slate-400">${this.esc(t.sekolah)} · ${this.esc(t.gameName)}</div>
                      <p class="text-slate-100"><strong>Refleksi:</strong> ${this.esc(t.refleksi)}</p>
                      ${t.komentar ? `<p class="text-slate-300"><strong>Komentar:</strong> ${this.esc(t.komentar)}</p>` : ''}
                      ${t.kritikSaran ? `<p class="text-sky-300"><strong>Saran:</strong> ${this.esc(t.kritikSaran)}</p>` : ''}
                    </div>`
                    )
                    .join('')}
                </div>`
          }
        </div>
      </div>
    `;
  }

  private bindMainEvents(): void {
    const main = this.container.querySelector<HTMLElement>('#teacher-main-content');
    if (!main) return;

    main.querySelectorAll<HTMLButtonElement>('.js-open-analytics').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.openAnalyticsOverlay();
      });
    });

    main.querySelectorAll<HTMLButtonElement>('.js-export-excel').forEach((btn) => {
      btn.addEventListener('click', () => {
        void this.downloadExcelReport();
      });
    });

    main.querySelectorAll<HTMLInputElement>('.js-el-check').forEach((chk) => {
      chk.addEventListener('change', () => {
        soundFX.playClick();
        if (chk.checked) this.selectedElements.add(chk.value);
        else if (this.selectedElements.size > 1) this.selectedElements.delete(chk.value);
        else chk.checked = true;
        this.pushMissionConfig();
      });
    });

    main.querySelectorAll<HTMLButtonElement>('.js-game-pick').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundFX.playClick();
        const nextGame = btn.dataset.game as GameId;
        this.selectedGameId = nextGame;
        this.leaderboardParams = getDefaultLeaderboardParams(nextGame);
        this.pushMissionConfig();
        this.renderNav();
        this.renderMainContent();
        const gm = getMinigameMeta(nextGame);
        this.onToast(
          `Mini-game "${gm.name}" dipilih · Parameter leaderboard otomatis disesuaikan!`
        );
      });
    });

    // Realtime Leaderboard Parameter Presets & Sliders
    main.querySelector('#btn-reset-lp-default')?.addEventListener('click', () => {
      soundFX.playClick();
      this.leaderboardParams = getDefaultLeaderboardParams(this.selectedGameId);
      this.pushMissionConfig();
      this.renderMainContent();
      this.onToast('Parameter leaderboard dikembalikan ke rekomendasi default mini-game.');
    });

    main.querySelectorAll<HTMLButtonElement>('.js-lp-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.lpPreset as Exclude<LeaderboardPresetId, 'custom'>;
        const preset = LEADERBOARD_PRESETS[key];
        if (!preset) return;
        soundFX.playClick();
        this.leaderboardParams = { ...preset.params };
        this.pushMissionConfig();
        this.renderMainContent();
        this.onToast(`Mode leaderboard diubah ke "${preset.label}" secara realtime!`);
      });
    });

    const bindRangeParam = (
      inputSel: string,
      labelSel: string,
      format: (v: number) => string,
      assign: (v: number) => void
    ) => {
      const inp = main.querySelector<HTMLInputElement>(inputSel);
      const lbl = main.querySelector<HTMLElement>(labelSel);
      inp?.addEventListener('input', () => {
        const val = Number(inp.value);
        assign(val);
        this.leaderboardParams.preset = 'custom';
        if (lbl) lbl.textContent = format(val);
      });
      inp?.addEventListener('change', () => {
        this.pushMissionConfig();
        this.renderMainContent();
      });
    };

    bindRangeParam(
      '#inp-lp-acc',
      '#lbl-lp-acc',
      (v) => `${v}%`,
      (v) => (this.leaderboardParams.accuracyWeight = v)
    );
    bindRangeParam(
      '#inp-lp-spd',
      '#lbl-lp-spd',
      (v) => `${v}%`,
      (v) => (this.leaderboardParams.speedWeight = v)
    );
    bindRangeParam(
      '#inp-lp-prg',
      '#lbl-lp-prg',
      (v) => `${v}%`,
      (v) => (this.leaderboardParams.progressWeight = v)
    );
    bindRangeParam(
      '#inp-lp-fast',
      '#lbl-lp-fast',
      (v) => `≤ ${v} dtk`,
      (v) => (this.leaderboardParams.fastThresholdSec = v)
    );
    bindRangeParam(
      '#inp-lp-streak',
      '#lbl-lp-streak',
      (v) => `+${v}`,
      (v) => (this.leaderboardParams.streakBonus = v)
    );
    bindRangeParam(
      '#inp-lp-penalty',
      '#lbl-lp-penalty',
      (v) => `-${v}`,
      (v) => (this.leaderboardParams.wrongPenalty = v)
    );

    const sortSel = main.querySelector<HTMLSelectElement>('#sel-lp-sort');
    sortSel?.addEventListener('change', () => {
      soundFX.playClick();
      this.leaderboardParams.sortBy = sortSel.value as LeaderboardSortBy;
      this.pushMissionConfig();
      this.renderMainContent();
    });

    const qDur = main.querySelector<HTMLInputElement>('#inp-qdur');
    const qLbl = main.querySelector<HTMLElement>('#lbl-qdur');
    qDur?.addEventListener('input', () => {
      this.questionDurationSec = Number(qDur.value);
      if (qLbl) qLbl.textContent = `${this.questionDurationSec} detik`;
    });

    const gDur = main.querySelector<HTMLInputElement>('#inp-gdur');
    const gLbl = main.querySelector<HTMLElement>('#lbl-gdur');
    gDur?.addEventListener('input', () => {
      this.gameDurationMin = Number(gDur.value);
      if (gLbl) gLbl.textContent = `${this.gameDurationMin} menit`;
    });

    main.querySelector('#btn-save-config')?.addEventListener('click', () => {
      soundFX.playClick();
      this.pushMissionConfig();
      this.onToast('Pengaturan misi & parameter leaderboard diperbarui ke semua peserta.');
    });

    main.querySelector('#btn-start-mission')?.addEventListener('click', () => {
      soundFX.playLevelUp();
      realtimeClient.startMission({
        elementIds: Array.from(this.selectedElements),
        gameId: this.selectedGameId,
        questionDurationSec: this.questionDurationSec,
        gameDurationMin: this.gameDurationMin,
        leaderboardParams: { ...this.leaderboardParams },
      });
      this.onToast('Misi dimulai! Seluruh peserta online disetujui masuk ke arena 3D.');
    });

    main.querySelector('#btn-stop-mission')?.addEventListener('click', () => {
      soundFX.playClick();
      realtimeClient.stopMission();
      this.onToast('Misi diakhiri. Form refleksi siswa telah ditampilkan.');
    });

    main.querySelector('#btn-return-lobby')?.addEventListener('click', () => {
      soundFX.playClick();
      realtimeClient.returnToLobby();
      this.onToast('Ruang kelas kembali ke Halaman Sekolah.');
    });

    main.querySelector('#btn-reset-room')?.addEventListener('click', () => {
      soundFX.playClick();
      realtimeClient.resetRoom();
      this.onToast('Sesi skor & peserta offline dibersihkan.');
    });

    // Refresh & Approval & moderation buttons in participant cards
    main.querySelector('#btn-refresh-participants')?.addEventListener('click', () => {
      soundFX.playClick();
      void realtimeClient.forceSyncNow().then((snap) => {
        const list = snap?.participants ?? this.snapshot?.participants ?? [];
        const on = list.filter((p) => p.connected).length;
        this.onToast(`Daftar peserta disegarkan · ${on} online dari ${list.length} peserta.`);
      });
    });

    main.querySelector('#btn-approve-all')?.addEventListener('click', () => {
      soundFX.playLevelUp();
      realtimeClient.approveAllStudents();
      this.onToast('Semua peserta yang menunggu telah disetujui masuk ke arena misi!');
    });

    main.querySelectorAll<HTMLButtonElement>('.js-approve-student').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pid = btn.dataset.approveId;
        if (!pid) return;
        soundFX.playCorrect();
        realtimeClient.approveStudent(pid);
        this.onToast('Peserta telah disetujui masuk ke arena misi!');
      });
    });

    main.querySelectorAll<HTMLButtonElement>('.js-mute-participant').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pid = btn.dataset.mutePid;
        if (!pid) return;
        soundFX.playClick();
        realtimeClient.toggleMuteStudent(pid);
      });
    });

    // Add Element form
    const elForm = main.querySelector<HTMLFormElement>('#form-add-element');
    elForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(elForm);
      const name = String(fd.get('name') || '').trim();
      const materialTitle = String(fd.get('materialTitle') || '').trim();
      const subtitle = String(fd.get('subtitle') || '').trim();
      const body = String(fd.get('body') || '').trim();
      const color = String(fd.get('color') || '#14b8a6');
      if (!name || !materialTitle) return;

      const element: PaiElement = {
        id: `custom_${Date.now()}`,
        name,
        shortName: name.slice(0, 18),
        color,
        accentHex: parseInt(color.replace('#', ''), 16) || 0x14b8a6,
        materialTitle,
        subtitle,
        sections: [
          {
            heading: 'Ringkasan Materi',
            paragraphs: body.split('\n').filter((l) => l.trim().length > 0),
          },
        ],
        isCustom: true,
      };
      realtimeClient.addElement(element);
      soundFX.playCorrect();
      this.onToast(`Elemen "${name}" berhasil ditambahkan secara permanen!`);
      elForm.reset();
    });

    // Add Question form
    const qForm = main.querySelector<HTMLFormElement>('#form-add-question');
    qForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(qForm);
      const elementId = String(fd.get('elementId') || 'quran_hadis');
      const difficulty = String(fd.get('difficulty') || 'mudah') as DifficultyLevel;
      const type = String(fd.get('type') || 'PG') as QuestionType;
      const prompt = String(fd.get('prompt') || '').trim();
      const explanation = String(fd.get('explanation') || '').trim();
      const keysRaw = String(fd.get('keys') || '1');

      const options =
        type === 'BS'
          ? ['Benar', 'Salah']
          : [
              String(fd.get('opt0') || 'Pilihan A').trim(),
              String(fd.get('opt1') || 'Pilihan B').trim(),
              String(fd.get('opt2') || 'Pilihan C').trim(),
              String(fd.get('opt3') || 'Pilihan D').trim(),
            ].filter(Boolean);

      const correctIndices = keysRaw
        .split(',')
        .map((s) => Math.max(0, Math.min(options.length - 1, Number(s.trim()) - 1)))
        .filter((n) => !Number.isNaN(n));

      const question: QuestionItem = {
        id: `custom_q_${Date.now()}`,
        elementId,
        difficulty,
        cognitiveLevel:
          difficulty === 'mudah'
            ? 'Mengetahui'
            : difficulty === 'sedang'
              ? 'Menerapkan'
              : 'Merefleksi & Mengevaluasi',
        type,
        prompt,
        options,
        correctIndices: correctIndices.length > 0 ? correctIndices : [0],
        explanation: explanation || 'Jawaban sesuai materi PAI.',
      };
      realtimeClient.addQuestion(question);
      soundFX.playCorrect();
      this.onToast('Soal baru berhasil ditambahkan ke Bank Soal permanen!');
      qForm.reset();
    });

    const filterSel = main.querySelector<HTMLSelectElement>('#filter-q-el');
    filterSel?.addEventListener('change', () => {
      this.questionFilterElement = filterSel.value;
      this.renderMainContent();
    });
  }

  private pushMissionConfig(): void {
    realtimeClient.configureMission({
      elementIds: Array.from(this.selectedElements),
      gameId: this.selectedGameId,
      questionDurationSec: this.questionDurationSec,
      gameDurationMin: this.gameDurationMin,
      leaderboardParams: { ...this.leaderboardParams },
    });
  }

  private esc(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
