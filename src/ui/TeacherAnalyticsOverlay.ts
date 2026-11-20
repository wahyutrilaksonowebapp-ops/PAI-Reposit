import Chart from 'chart.js/auto';
import type {
  AnswerLogEntry,
  PaiElement,
  ParticipantState,
  RoomSnapshot,
} from '../types.ts';
import { paiBank } from '../data/paiBank.ts';
import { getMinigameMeta } from '../constants.ts';
import { soundFX } from '../audio/SoundFX.ts';

export interface TeacherAnalyticsOverlayCallbacks {
  onClose: () => void;
  onExportExcel: () => void;
  onFocusElement: (elementId: string, elementName: string) => void;
}

interface ElementDiagnostic {
  element: PaiElement;
  total: number;
  correct: number;
  wrong: number;
  accuracy: number;
  errorRate: number;
  avgTimeSec: number;
  status: 'untested' | 'remedial' | 'developing' | 'mastered';
}

interface QuestionDiagnostic {
  questionId: string;
  elementName: string;
  elementColor: string;
  difficulty: string;
  type: string;
  prompt: string;
  total: number;
  wrong: number;
  errorRate: number;
}

/**
 * Dedicated analytics overlay exclusively for the Teacher Dashboard.
 * Visualizes student progress distribution and highlights which PAI learning
 * elements the class is struggling with most using interactive Chart.js charts.
 */
export class TeacherAnalyticsOverlay {
  private host: HTMLElement | null = null;
  private overlayEl: HTMLElement | null = null;
  private snapshot: RoomSnapshot | null = null;
  private callbacks: TeacherAnalyticsOverlayCallbacks;
  private openState = false;
  private classFilter = 'all';
  private scoreChartMode: 'histogram' | 'students' = 'histogram';
  private charts = new Map<string, Chart>();
  private onKeyDownBound = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.openState) {
      this.close();
    }
  };

  constructor(callbacks: TeacherAnalyticsOverlayCallbacks) {
    this.callbacks = callbacks;
  }

  isOpen(): boolean {
    return this.openState;
  }

  open(host: HTMLElement, snapshot: RoomSnapshot | null): void {
    this.host = host;
    this.snapshot = snapshot;
    this.openState = true;
    this.renderShell();
    this.refreshData(true);
    window.addEventListener('keydown', this.onKeyDownBound);
  }

  update(snapshot: RoomSnapshot | null): void {
    this.snapshot = snapshot;
    if (!this.openState || !this.overlayEl) return;
    this.refreshData(false);
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    window.removeEventListener('keydown', this.onKeyDownBound);
    this.destroyCharts();
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
    this.callbacks.onClose();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDownBound);
    this.destroyCharts();
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
    this.openState = false;
  }

  private destroyCharts(): void {
    for (const chart of this.charts.values()) {
      chart.destroy();
    }
    this.charts.clear();
  }

  private renderShell(): void {
    if (!this.host) return;
    this.destroyCharts();
    if (this.overlayEl) {
      this.overlayEl.remove();
    }

    const el = document.createElement('div');
    el.id = 'teacher-analytics-overlay';
    el.className =
      'interactive-layer fixed inset-0 z-[70] bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-3 md:p-5';

    el.innerHTML = `
      <div class="w-full max-w-7xl h-[94vh] bg-[#0d1629] border border-sky-400/40 rounded-3xl shadow-2xl flex flex-col overflow-hidden">
        <!-- Overlay Top Bar -->
        <header class="px-5 py-3.5 bg-[#111c33] border-b border-slate-700/90 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-400 to-emerald-400 text-slate-950 font-display font-bold text-base flex items-center justify-center shrink-0">
              AN
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h2 class="font-display font-bold text-lg md:text-xl text-white truncate">
                  Analitik Progres & Kesulitan Elemen PAI
                </h2>
                <span class="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-950 border border-emerald-400/40 text-[10px] font-bold text-emerald-300">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  Khusus Guru · Live
                </span>
              </div>
              <p id="an-subtitle" class="text-xs text-slate-300 truncate">
                Visualisasi distribusi progres kelas & pemetaan elemen PAI yang paling menantang
              </p>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <select id="an-class-filter" class="input-dark text-xs py-1.5 px-2.5 w-auto">
              <option value="all">Semua Kelas</option>
              <option value="1">Kelas 1</option>
              <option value="2">Kelas 2</option>
              <option value="3">Kelas 3</option>
              <option value="4">Kelas 4</option>
              <option value="5">Kelas 5</option>
              <option value="6">Kelas 6</option>
            </select>
            <button id="an-btn-excel" type="button" class="btn-gold text-xs py-1.5 px-3">
              Unduh Excel (.xlsx)
            </button>
            <button id="an-btn-close" type="button" class="btn-secondary text-xs py-1.5 px-3 text-slate-200">
              Tutup ✕
            </button>
          </div>
        </header>

        <!-- Scrollable Analytics Body -->
        <div class="flex-1 min-h-0 overflow-y-auto p-4 md:p-5 space-y-4">
          <!-- KPI Summary Cards -->
          <section id="an-kpi-row" class="grid grid-cols-2 lg:grid-cols-5 gap-3"></section>

          <!-- Struggling Element Diagnostic Callout -->
          <section id="an-struggle-banner"></section>

          <!-- 2x2 Interactive Charts Grid -->
          <section class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <!-- Chart 1: PAI Element Mastery vs Error Rate -->
            <div class="bg-[#111c33] border border-slate-700/90 rounded-2xl p-4 flex flex-col">
              <div class="flex items-start justify-between gap-2 mb-2">
                <div>
                  <h3 class="font-display font-bold text-sm md:text-base text-amber-300">
                    1. Penguasaan vs Kesalahan per Elemen PAI
                  </h3>
                  <p class="text-[11px] text-slate-400">
                    Diurutkan dari elemen paling sulit agar mudah menentukan fokus remedial kelas
                  </p>
                </div>
                <span class="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-semibold shrink-0">
                  % Benar / Salah
                </span>
              </div>
              <div class="relative h-64 w-full">
                <canvas id="an-chart-elements"></canvas>
              </div>
            </div>

            <!-- Chart 2: Student Progress & Predikat Distribution -->
            <div class="bg-[#111c33] border border-slate-700/90 rounded-2xl p-4 flex flex-col">
              <div class="flex items-start justify-between gap-2 mb-2">
                <div>
                  <h3 class="font-display font-bold text-sm md:text-base text-emerald-300">
                    2. Distribusi Predikat & Ketuntasan Siswa
                  </h3>
                  <p class="text-[11px] text-slate-400">
                    Sebaran jumlah peserta pada tiap kategori capaian akurasi
                  </p>
                </div>
                <span id="an-dist-count" class="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-emerald-300 font-semibold shrink-0">
                  0 Siswa
                </span>
              </div>
              <div class="relative h-64 w-full">
                <canvas id="an-chart-distribution"></canvas>
              </div>
            </div>

            <!-- Chart 3: Score / Progress Distribution -->
            <div class="bg-[#111c33] border border-slate-700/90 rounded-2xl p-4 flex flex-col">
              <div class="flex flex-wrap items-start justify-between gap-2 mb-2">
                <div>
                  <h3 class="font-display font-bold text-sm md:text-base text-sky-300">
                    3. Distribusi Skor & Progres Peserta
                  </h3>
                  <p class="text-[11px] text-slate-400">
                    Pantau rentang skor kelas atau bandingkan progres antar siswa secara langsung
                  </p>
                </div>
                <div class="flex items-center gap-1 p-0.5 rounded-lg bg-slate-900 border border-slate-700">
                  <button type="button" data-score-mode="histogram" class="js-score-mode px-2 py-0.5 rounded text-[10px] font-bold cursor-pointer bg-sky-500 text-slate-950">
                    Rentang Skor
                  </button>
                  <button type="button" data-score-mode="students" class="js-score-mode px-2 py-0.5 rounded text-[10px] font-bold cursor-pointer text-slate-300">
                    Per Siswa
                  </button>
                </div>
              </div>
              <div class="relative h-64 w-full">
                <canvas id="an-chart-scores"></canvas>
              </div>
            </div>

            <!-- Chart 4: AKM Difficulty & Question Type Mastery -->
            <div class="bg-[#111c33] border border-slate-700/90 rounded-2xl p-4 flex flex-col">
              <div class="flex items-start justify-between gap-2 mb-2">
                <div>
                  <h3 class="font-display font-bold text-sm md:text-base text-purple-300">
                    4. Akurasi per Tingkat Kesukaran & Tipe AKM
                  </h3>
                  <p class="text-[11px] text-slate-400">
                    Identifikasi apakah kesulitan ada di level HOTS (Sulit) atau format soal PGK / B-S
                  </p>
                </div>
                <span class="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-purple-200 font-semibold shrink-0">
                  AKM Adaptif
                </span>
              </div>
              <div class="relative h-64 w-full">
                <canvas id="an-chart-akm"></canvas>
              </div>
            </div>
          </section>

          <!-- Bottom Diagnostic Breakdowns -->
          <section class="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <!-- Detailed Element Ranking -->
            <div class="lg:col-span-6 bg-[#111c33] border border-slate-700/90 rounded-2xl p-4">
              <h3 class="font-display font-bold text-sm md:text-base text-amber-300 mb-3">
                Peringkat Kesulitan Elemen PAI (Prioritas Pembahasan)
              </h3>
              <div id="an-element-list" class="space-y-2.5"></div>
            </div>

            <!-- Most Missed Questions -->
            <div class="lg:col-span-6 bg-[#111c33] border border-slate-700/90 rounded-2xl p-4">
              <h3 class="font-display font-bold text-sm md:text-base text-rose-300 mb-3">
                Butir Soal Paling Sering Salah Dijawab
              </h3>
              <div id="an-hardest-questions" class="space-y-2.5"></div>
            </div>
          </section>
        </div>
      </div>
    `;

    this.host.appendChild(el);
    this.overlayEl = el;

    // Close on backdrop click
    el.addEventListener('click', (e) => {
      if (e.target === el) {
        soundFX.playClick();
        this.close();
      }
    });

    el.querySelector('#an-btn-close')?.addEventListener('click', () => {
      soundFX.playClick();
      this.close();
    });

    el.querySelector('#an-btn-excel')?.addEventListener('click', () => {
      this.callbacks.onExportExcel();
    });

    const classSelect = el.querySelector<HTMLSelectElement>('#an-class-filter');
    if (classSelect) {
      classSelect.value = this.classFilter;
      classSelect.addEventListener('change', () => {
        soundFX.playClick();
        this.classFilter = classSelect.value;
        this.refreshData(false);
      });
    }

    el.querySelectorAll<HTMLButtonElement>('.js-score-mode').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundFX.playClick();
        this.scoreChartMode = btn.dataset.scoreMode === 'students' ? 'students' : 'histogram';
        el.querySelectorAll<HTMLButtonElement>('.js-score-mode').forEach((b) => {
          const isAct = b.dataset.scoreMode === this.scoreChartMode;
          b.className = `js-score-mode px-2 py-0.5 rounded text-[10px] font-bold cursor-pointer ${
            isAct ? 'bg-sky-500 text-slate-950' : 'text-slate-300 hover:text-white'
          }`;
        });
        this.refreshData(false);
      });
    });
  }

  private getFilteredParticipants(): ParticipantState[] {
    const all = this.snapshot?.participants ?? [];
    if (this.classFilter === 'all') return all;
    return all.filter((p) => p.kelas === this.classFilter);
  }

  private computeElementDiagnostics(
    participants: ParticipantState[]
  ): ElementDiagnostic[] {
    const elements = paiBank.getAllElements();
    const allLogs: AnswerLogEntry[] = participants.flatMap((p) => p.answeredLog);

    const list: ElementDiagnostic[] = elements.map((element) => {
      const logs = allLogs.filter((l) => l.elementId === element.id);
      const total = logs.length;
      const correct = logs.filter((l) => l.isCorrect).length;
      const wrong = total - correct;
      const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
      const errorRate = total > 0 ? 100 - accuracy : 0;
      const avgTimeSec =
        total > 0
          ? Number(
              (logs.reduce((acc, l) => acc + l.responseTimeSec, 0) / total).toFixed(1)
            )
          : 0;

      let status: ElementDiagnostic['status'] = 'untested';
      if (total > 0) {
        if (accuracy < 60) status = 'remedial';
        else if (accuracy < 80) status = 'developing';
        else status = 'mastered';
      }

      return {
        element,
        total,
        correct,
        wrong,
        accuracy,
        errorRate,
        avgTimeSec,
        status,
      };
    });

    // Sort: tested elements with lowest accuracy (most struggling) first, then untested
    list.sort((a, b) => {
      if (a.total === 0 && b.total === 0) return 0;
      if (a.total === 0) return 1;
      if (b.total === 0) return -1;
      if (a.accuracy !== b.accuracy) return a.accuracy - b.accuracy;
      return b.wrong - a.wrong;
    });

    return list;
  }

  private computeHardestQuestions(
    participants: ParticipantState[]
  ): QuestionDiagnostic[] {
    const allLogs = participants.flatMap((p) => p.answeredLog);
    const map = new Map<
      string,
      { elementId: string; difficulty: string; type: string; total: number; wrong: number }
    >();

    for (const log of allLogs) {
      const cur = map.get(log.questionId) ?? {
        elementId: log.elementId,
        difficulty: log.difficulty,
        type: log.type,
        total: 0,
        wrong: 0,
      };
      cur.total += 1;
      if (!log.isCorrect) cur.wrong += 1;
      map.set(log.questionId, cur);
    }

    const qById = new Map(paiBank.getAllQuestions().map((q) => [q.id, q]));
    const rows: QuestionDiagnostic[] = [];

    for (const [qid, stat] of map.entries()) {
      if (stat.wrong === 0) continue;
      const el = paiBank.getElementById(stat.elementId);
      const qObj = qById.get(qid);
      rows.push({
        questionId: qid,
        elementName: el?.shortName ?? stat.elementId,
        elementColor: el?.color ?? '#38bdf8',
        difficulty: stat.difficulty,
        type: stat.type,
        prompt: qObj?.prompt ?? `Soal ${qid}`,
        total: stat.total,
        wrong: stat.wrong,
        errorRate: Math.round((stat.wrong / stat.total) * 100),
      });
    }

    rows.sort((a, b) => {
      if (b.errorRate !== a.errorRate) return b.errorRate - a.errorRate;
      return b.wrong - a.wrong;
    });

    return rows.slice(0, 6);
  }

  private refreshData(isInitial: boolean): void {
    if (!this.overlayEl) return;

    const participants = this.getFilteredParticipants();
    const onlineCount = participants.filter((p) => p.connected).length;
    const activeLearners = participants.filter((p) => p.correctCount + p.wrongCount > 0).length;
    const totalAnswered = participants.reduce((s, p) => s + p.correctCount + p.wrongCount, 0);
    const totalCorrect = participants.reduce((s, p) => s + p.correctCount, 0);
    const classAccuracy = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;
    const avgScore =
      participants.length > 0
        ? Math.round(participants.reduce((s, p) => s + p.score, 0) / participants.length)
        : 0;

    const gameMeta = getMinigameMeta(this.snapshot?.mission.gameId ?? 'puncak_nalar');
    const elementDiagnostics = this.computeElementDiagnostics(participants);
    const testedElements = elementDiagnostics.filter((d) => d.total > 0);
    const mostStruggling = testedElements[0] ?? null;

    // Subtitle
    const subEl = this.overlayEl.querySelector<HTMLElement>('#an-subtitle');
    if (subEl) {
      const scopeLabel = this.classFilter === 'all' ? 'Semua Kelas' : `Kelas ${this.classFilter}`;
      subEl.textContent = `${scopeLabel} · Mini-Game: ${gameMeta.name} · ${onlineCount} Online dari ${participants.length} Peserta`;
    }

    // Distribution badge
    const distBadge = this.overlayEl.querySelector<HTMLElement>('#an-dist-count');
    if (distBadge) {
      distBadge.textContent = `${participants.length} Peserta`;
    }

    // 1. Render KPI Row
    const kpiRow = this.overlayEl.querySelector<HTMLElement>('#an-kpi-row');
    if (kpiRow) {
      kpiRow.innerHTML = `
        <div class="p-3.5 rounded-2xl bg-[#111c33] border border-slate-700">
          <div class="text-[11px] text-slate-400">Peserta Terpantau</div>
          <div class="font-display font-bold text-2xl text-white tabular-nums mt-0.5">${participants.length}</div>
          <div class="text-[11px] text-emerald-400">${onlineCount} online · ${activeLearners} menjawab</div>
        </div>
        <div class="p-3.5 rounded-2xl bg-[#111c33] border border-slate-700">
          <div class="text-[11px] text-slate-400">Ketuntasan Kelas</div>
          <div class="font-display font-bold text-2xl tabular-nums mt-0.5 ${
            totalAnswered === 0
              ? 'text-slate-300'
              : classAccuracy >= 75
                ? 'text-emerald-400'
                : classAccuracy >= 55
                  ? 'text-amber-300'
                  : 'text-rose-400'
          }">${classAccuracy}%</div>
          <div class="text-[11px] text-slate-400">${totalCorrect} benar / ${totalAnswered} soal</div>
        </div>
        <div class="p-3.5 rounded-2xl bg-[#111c33] border border-slate-700">
          <div class="text-[11px] text-slate-400">Rata-rata Skor</div>
          <div class="font-display font-bold text-2xl text-amber-300 tabular-nums mt-0.5">${avgScore}</div>
          <div class="text-[11px] text-slate-400">poin per peserta</div>
        </div>
        <div class="p-3.5 rounded-2xl bg-[#111c33] border border-slate-700">
          <div class="text-[11px] text-slate-400">Elemen Sudah Diuji</div>
          <div class="font-display font-bold text-2xl text-sky-300 tabular-nums mt-0.5">${testedElements.length} / ${elementDiagnostics.length}</div>
          <div class="text-[11px] text-slate-400">elemen PAI terekam</div>
        </div>
        <div class="p-3.5 rounded-2xl col-span-2 lg:col-span-1 border ${
          mostStruggling && mostStruggling.accuracy < 75
            ? 'bg-rose-950/50 border-rose-500/60'
            : 'bg-[#111c33] border-slate-700'
        }">
          <div class="text-[11px] ${mostStruggling && mostStruggling.accuracy < 75 ? 'text-rose-200' : 'text-slate-400'}">
            Elemen Paling Menantang
          </div>
          <div class="font-display font-bold text-lg text-white truncate mt-0.5">
            ${mostStruggling ? this.esc(mostStruggling.element.shortName) : 'Belum Ada Data'}
          </div>
          <div class="text-[11px] ${mostStruggling ? 'text-rose-300 font-semibold' : 'text-slate-400'}">
            ${
              mostStruggling
                ? `Akurasi ${mostStruggling.accuracy}% (${mostStruggling.wrong} salah)`
                : 'Mulai misi untuk melihat'
            }
          </div>
        </div>
      `;
    }

    // 2. Render Struggling Element Diagnostic Banner
    const bannerEl = this.overlayEl.querySelector<HTMLElement>('#an-struggle-banner');
    if (bannerEl) {
      if (mostStruggling) {
        const isCritical = mostStruggling.accuracy < 60;
        const isModerate = mostStruggling.accuracy >= 60 && mostStruggling.accuracy < 80;
        const bannerBorder = isCritical
          ? 'bg-rose-950/45 border-rose-500/60'
          : isModerate
            ? 'bg-amber-950/40 border-amber-400/55'
            : 'bg-emerald-950/40 border-emerald-400/50';
        const tagText = isCritical
          ? 'PRIORITAS REMEDIAL TINGGI'
          : isModerate
            ? 'PERLU PENGUATAN KONSEP'
            : 'CAPAIAN TERENDAH SAAT INI (SUDAH TUNTAS)';
        const tagCls = isCritical
          ? 'bg-rose-500 text-white'
          : isModerate
            ? 'bg-amber-400 text-slate-950'
            : 'bg-emerald-500 text-slate-950';

        bannerEl.innerHTML = `
          <div class="p-4 rounded-2xl border ${bannerBorder} flex flex-wrap items-center justify-between gap-4">
            <div class="space-y-1 min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ${tagCls}">${tagText}</span>
                <span class="text-xs font-bold text-white">${this.esc(mostStruggling.element.name)}</span>
              </div>
              <p class="text-xs md:text-sm text-slate-200 leading-relaxed">
                Elemen <strong>${this.esc(mostStruggling.element.name)}</strong> (${this.esc(mostStruggling.element.materialTitle)}) mencatat tingkat ketuntasan paling rendah sebesar
                <strong class="text-rose-300">${mostStruggling.accuracy}%</strong>
                (<strong>${mostStruggling.wrong} salah</strong> dari ${mostStruggling.total} jawaban, rata-rata waktu jawab <strong>${mostStruggling.avgTimeSec} detik</strong>).
              </p>
            </div>
            <button
              type="button"
              id="an-btn-focus-struggle"
              data-el-id="${mostStruggling.element.id}"
              data-el-name="${this.esc(mostStruggling.element.name)}"
              class="btn-gold text-xs py-2.5 px-4 shrink-0"
            >
              Fokuskan Misi Berikutnya ke Elemen Ini
            </button>
          </div>
        `;

        bannerEl.querySelector('#an-btn-focus-struggle')?.addEventListener('click', (e) => {
          const btn = e.currentTarget as HTMLButtonElement;
          const elId = btn.dataset.elId;
          const elName = btn.dataset.elName || '';
          if (elId) {
            soundFX.playCorrect();
            this.callbacks.onFocusElement(elId, elName);
          }
        });
      } else {
        bannerEl.innerHTML = `
          <div class="p-4 rounded-2xl bg-sky-950/35 border border-sky-400/40 text-xs text-sky-100 flex flex-wrap items-center justify-between gap-3">
            <div>
              <strong class="text-sky-300">Siap Merekam Analitik Realtime:</strong>
              Grafik di bawah akan langsung terisi otomatis begitu peserta mulai menjawab kuis AKM pada misi yang Anda mulai. Semua 5 elemen PAI siap dipetakan secara diagnostik.
            </div>
          </div>
        `;
      }
    }

    // 3. Render / Update the 4 Chart.js visualizations
    this.upsertElementChart(elementDiagnostics, isInitial);
    this.upsertDistributionChart(participants, isInitial);
    this.upsertScoreChart(participants, isInitial);
    this.upsertAkmChart(participants, isInitial);

    // 4. Render Detailed Element Ranking List
    const listEl = this.overlayEl.querySelector<HTMLElement>('#an-element-list');
    if (listEl) {
      listEl.innerHTML = elementDiagnostics
        .map((d, idx) => {
          const badge =
            d.status === 'untested'
              ? { txt: 'Belum Diuji', cls: 'bg-slate-800 text-slate-400' }
              : d.status === 'remedial'
                ? { txt: 'Perlu Remedial', cls: 'bg-rose-600 text-white' }
                : d.status === 'developing'
                  ? { txt: 'Perlu Penguatan', cls: 'bg-amber-400 text-slate-950' }
                  : { txt: 'Tuntas', cls: 'bg-emerald-500 text-slate-950' };

          const barColor =
            d.status === 'untested'
              ? '#475569'
              : d.status === 'remedial'
                ? '#f43f5e'
                : d.status === 'developing'
                  ? '#f59e0b'
                  : '#10b981';

          return `
            <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-700/80 space-y-1.5">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="w-5 h-5 rounded-md bg-slate-800 text-slate-300 font-bold text-[10px] flex items-center justify-center shrink-0">${idx + 1}</span>
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${d.element.color}"></span>
                  <span class="font-bold text-xs text-white truncate">${this.esc(d.element.name)}</span>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <span class="text-[10px] font-bold px-2 py-0.5 rounded ${badge.cls}">${badge.txt}</span>
                  <span class="font-display font-bold text-sm tabular-nums ${
                    d.status === 'remedial' ? 'text-rose-400' : d.status === 'developing' ? 'text-amber-300' : 'text-emerald-400'
                  }">${d.total > 0 ? `${d.accuracy}%` : '—'}</span>
                </div>
              </div>
              <div class="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                <div class="h-full rounded-full transition-all duration-300" style="width:${d.total > 0 ? Math.max(4, d.accuracy) : 0}%; background:${barColor}"></div>
              </div>
              <div class="flex items-center justify-between text-[11px] text-slate-400">
                <span>Benar: <strong class="text-emerald-300">${d.correct}</strong> · Salah: <strong class="text-rose-300">${d.wrong}</strong> (Total ${d.total})</span>
                <span>Rata-rata waktu: ${d.total > 0 ? `${d.avgTimeSec} dtk` : '-'}</span>
              </div>
            </div>
          `;
        })
        .join('');
    }

    // 5. Render Most Missed Questions
    const hardEl = this.overlayEl.querySelector<HTMLElement>('#an-hardest-questions');
    if (hardEl) {
      const hardQs = this.computeHardestQuestions(participants);
      if (hardQs.length === 0) {
        hardEl.innerHTML = `
          <div class="py-10 text-center text-xs text-slate-400">
            Belum ada butir soal dengan kesalahan jawaban pada filter saat ini.
          </div>
        `;
      } else {
        hardEl.innerHTML = hardQs
          .map(
            (q) => `
          <div class="p-3 rounded-xl bg-slate-900/90 border border-rose-500/35 text-xs space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="px-1.5 py-0.5 rounded text-[10px] font-bold text-slate-950" style="background:${q.elementColor}">${this.esc(q.elementName)}</span>
                <span class="px-1.5 py-0.5 rounded bg-slate-800 text-sky-300 text-[10px] font-bold">${q.type}</span>
                <span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] uppercase">${q.difficulty}</span>
              </div>
              <span class="text-rose-400 font-display font-bold tabular-nums shrink-0">${q.errorRate}% Salah (${q.wrong}/${q.total})</span>
            </div>
            <p class="text-slate-200 leading-snug line-clamp-2">${this.esc(q.prompt)}</p>
          </div>
        `
          )
          .join('');
      }
    }
  }

  private upsertElementChart(diagnostics: ElementDiagnostic[], isInitial: boolean): void {
    const canvas = this.overlayEl?.querySelector<HTMLCanvasElement>('#an-chart-elements');
    if (!canvas) return;

    const labels = diagnostics.map((d) => d.element.shortName);
    const correctData = diagnostics.map((d) => d.accuracy);
    const wrongData = diagnostics.map((d) => d.errorRate);

    const existing = this.charts.get('elements');
    if (existing) {
      existing.data.labels = labels;
      existing.data.datasets[0].data = correctData;
      existing.data.datasets[1].data = wrongData;
      existing.update(isInitial ? undefined : 'none');
      return;
    }

    const chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: '% Benar (Penguasaan)',
            data: correctData,
            backgroundColor: 'rgba(16, 185, 129, 0.85)',
            borderColor: '#10b981',
            borderWidth: 1,
            borderRadius: 6,
          },
          {
            label: '% Salah (Kesulitan)',
            data: wrongData,
            backgroundColor: 'rgba(244, 63, 94, 0.85)',
            borderColor: '#f43f5e',
            borderWidth: 1,
            borderRadius: 6,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            stacked: true,
            min: 0,
            max: 100,
            ticks: {
              color: '#94a3b8',
              callback: (v) => `${v}%`,
            },
            grid: { color: 'rgba(148, 163, 184, 0.12)' },
          },
          y: {
            stacked: true,
            ticks: { color: '#f8fafc', font: { size: 11, weight: 'bold' } },
            grid: { display: false },
          },
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#cbd5e1', boxWidth: 12, font: { size: 11 } },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.x}%`,
            },
          },
        },
      },
    });
    this.charts.set('elements', chart);
  }

  private upsertDistributionChart(
    participants: ParticipantState[],
    isInitial: boolean
  ): void {
    const canvas = this.overlayEl?.querySelector<HTMLCanvasElement>('#an-chart-distribution');
    if (!canvas) return;

    let bandA = 0; // >= 85
    let bandB = 0; // 70 - 84
    let bandC = 0; // 55 - 69
    let bandD = 0; // < 55
    let bandNone = 0; // 0 answered

    for (const p of participants) {
      const total = p.correctCount + p.wrongCount;
      if (total === 0) {
        bandNone += 1;
      } else {
        const acc = Math.round((p.correctCount / total) * 100);
        if (acc >= 85) bandA += 1;
        else if (acc >= 70) bandB += 1;
        else if (acc >= 55) bandC += 1;
        else bandD += 1;
      }
    }

    const dataArr = [bandA, bandB, bandC, bandD, bandNone];
    const labels = [
      'Sangat Baik (≥85%)',
      'Baik (70–84%)',
      'Cukup (55–69%)',
      'Perlu Bimbingan (<55%)',
      'Belum Mengerjakan',
    ];

    const existing = this.charts.get('distribution');
    if (existing) {
      existing.data.datasets[0].data = dataArr;
      existing.update(isInitial ? undefined : 'none');
      return;
    }

    const chart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [
          {
            data: dataArr,
            backgroundColor: [
              '#10b981',
              '#38bdf8',
              '#facc15',
              '#f43f5e',
              '#475569',
            ],
            borderColor: '#111c33',
            borderWidth: 2,
            hoverOffset: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: '#e2e8f0',
              boxWidth: 12,
              padding: 10,
              font: { size: 11 },
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.label}: ${ctx.parsed} siswa`,
            },
          },
        },
      },
    });
    this.charts.set('distribution', chart);
  }

  private upsertScoreChart(participants: ParticipantState[], isInitial: boolean): void {
    const canvas = this.overlayEl?.querySelector<HTMLCanvasElement>('#an-chart-scores');
    if (!canvas) return;

    let labels: string[] = [];
    let values: number[] = [];
    let colors: string[] = [];
    let datasetLabel = 'Jumlah Siswa';

    if (this.scoreChartMode === 'histogram') {
      const bins = [0, 0, 0, 0, 0];
      for (const p of participants) {
        if (p.score === 0) bins[0] += 1;
        else if (p.score <= 200) bins[1] += 1;
        else if (p.score <= 500) bins[2] += 1;
        else if (p.score <= 900) bins[3] += 1;
        else bins[4] += 1;
      }
      labels = ['0 pts', '1–200', '201–500', '501–900', '>900 pts'];
      values = bins;
      colors = ['#64748b', '#f43f5e', '#f59e0b', '#38bdf8', '#10b981'];
      datasetLabel = 'Jumlah Siswa';
    } else {
      const top = participants.slice(0, 12);
      labels = top.map((p) => (p.nama.length > 12 ? `${p.nama.slice(0, 12)}…` : p.nama));
      values = top.map((p) => p.score);
      colors = top.map((p) =>
        p.level === 'sulit' ? '#facc15' : p.level === 'sedang' ? '#38bdf8' : '#10b981'
      );
      datasetLabel = 'Skor Peserta';
    }

    const existing = this.charts.get('scores');
    if (existing) {
      existing.data.labels = labels;
      existing.data.datasets[0].label = datasetLabel;
      existing.data.datasets[0].data = values;
      existing.data.datasets[0].backgroundColor = colors;
      existing.update(isInitial ? undefined : 'none');
      return;
    }

    const chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: datasetLabel,
            data: values,
            backgroundColor: colors,
            borderRadius: 8,
            maxBarThickness: 42,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            ticks: { color: '#e2e8f0', font: { size: 11 } },
            grid: { display: false },
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#94a3b8', precision: 0 },
            grid: { color: 'rgba(148, 163, 184, 0.12)' },
          },
        },
        plugins: {
          legend: { display: false },
        },
      },
    });
    this.charts.set('scores', chart);
  }

  private upsertAkmChart(participants: ParticipantState[], isInitial: boolean): void {
    const canvas = this.overlayEl?.querySelector<HTMLCanvasElement>('#an-chart-akm');
    if (!canvas) return;

    const allLogs = participants.flatMap((p) => p.answeredLog);
    const calcAcc = (fn: (l: AnswerLogEntry) => boolean): number => {
      const sub = allLogs.filter(fn);
      if (sub.length === 0) return 0;
      const ok = sub.filter((l) => l.isCorrect).length;
      return Math.round((ok / sub.length) * 100);
    };

    const labels = [
      'Level Mudah',
      'Level Sedang',
      'Level Sulit',
      'Tipe PG',
      'Tipe PGK',
      'Benar/Salah',
    ];
    const dataArr = [
      calcAcc((l) => l.difficulty === 'mudah'),
      calcAcc((l) => l.difficulty === 'sedang'),
      calcAcc((l) => l.difficulty === 'sulit'),
      calcAcc((l) => l.type === 'PG'),
      calcAcc((l) => l.type === 'PGK'),
      calcAcc((l) => l.type === 'BS'),
    ];
    const bgColors = [
      'rgba(16, 185, 129, 0.8)',
      'rgba(56, 189, 248, 0.8)',
      'rgba(250, 204, 21, 0.85)',
      'rgba(129, 140, 248, 0.85)',
      'rgba(192, 132, 252, 0.85)',
      'rgba(244, 114, 182, 0.85)',
    ];

    const existing = this.charts.get('akm');
    if (existing) {
      existing.data.datasets[0].data = dataArr;
      existing.update(isInitial ? undefined : 'none');
      return;
    }

    const chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Akurasi Kelas (%)',
            data: dataArr,
            backgroundColor: bgColors,
            borderRadius: 8,
            maxBarThickness: 38,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            ticks: { color: '#e2e8f0', font: { size: 10.5 } },
            grid: { display: false },
          },
          y: {
            beginAtZero: true,
            max: 100,
            ticks: {
              color: '#94a3b8',
              callback: (v) => `${v}%`,
            },
            grid: { color: 'rgba(148, 163, 184, 0.12)' },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `Akurasi: ${ctx.parsed.y}%`,
            },
          },
        },
      },
    });
    this.charts.set('akm', chart);
  }

  private esc(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
