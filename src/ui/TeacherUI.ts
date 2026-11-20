import type {
  DifficultyLevel,
  GameId,
  PaiElement,
  QuestionItem,
  QuestionType,
  RoomSnapshot,
} from '../types.ts';
import { getMinigameMeta, MINIGAMES } from '../constants.ts';
import { paiBank } from '../data/paiBank.ts';
import { realtimeClient } from '../services/RealtimeClient.ts';
import { soundFX } from '../audio/SoundFX.ts';

type TeacherTab = 'misi' | 'leaderboard' | 'materi' | 'soal' | 'laporan';

export class TeacherUI {
  private container: HTMLElement;
  private sekolah = '';
  private activeTab: TeacherTab = 'misi';
  private snapshot: RoomSnapshot | null = null;
  private onLogout: () => void;
  private onToast: (msg: string) => void;

  // Local mission draft synced with server
  private selectedElements = new Set<string>(['quran_hadis', 'akidah', 'akhlak', 'fiqih', 'spi']);
  private selectedGameId: GameId = 'puncak_nalar';
  private questionDurationSec = 25;
  private gameDurationMin = 10;
  private questionFilterElement = 'all';
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    container: HTMLElement,
    onLogout: () => void,
    onToast: (msg: string) => void
  ) {
    this.container = container;
    this.onLogout = onLogout;
    this.onToast = onToast;
  }

  mount(sekolah: string, snapshot: RoomSnapshot | null): void {
    this.sekolah = sekolah;
    if (snapshot) {
      this.applySnapshot(snapshot, false);
    }
    this.render();
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => this.updateClockDisplay(), 500);
  }

  unmount(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.container.innerHTML = '';
  }

  applySnapshot(snapshot: RoomSnapshot, rerender = true): void {
    this.snapshot = snapshot;
    paiBank.setCustomContent(snapshot.customElements, snapshot.customQuestions);
    this.selectedGameId = snapshot.mission.gameId;
    this.questionDurationSec = snapshot.mission.questionDurationSec;
    this.gameDurationMin = snapshot.mission.gameDurationMin;
    if (snapshot.mission.elementIds.length > 0) {
      this.selectedElements = new Set(snapshot.mission.elementIds);
    }
    if (rerender) this.render();
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

  private render(): void {
    const snap = this.snapshot;
    const participants = snap?.participants ?? [];
    const onlineCount = participants.filter((p) => p.connected).length;
    const mission = snap?.mission;
    const gameMeta = getMinigameMeta(this.selectedGameId);

    this.container.innerHTML = `
      <div class="interactive-layer fixed inset-0 bg-[#0b1220] text-slate-100 flex flex-col overflow-hidden">
        <!-- Top Header -->
        <header class="bg-[#111c33] border-b border-slate-700 px-4 py-3 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-amber-400 text-slate-950 font-display font-bold text-lg flex items-center justify-center">
              GP
            </div>
            <div>
              <h1 class="font-display font-bold text-lg leading-tight text-amber-300">
                Dashboard Guru PAI · Nusantara 3D
              </h1>
              <p class="text-xs text-slate-300">${this.esc(this.sekolah)} · Kode Admin: gpaibeji</p>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <div class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-xs font-semibold">
              Peserta Online: <span class="text-emerald-400 tabular-nums font-bold">${onlineCount}</span> / ${participants.length}
            </div>
            <div class="px-3 py-1.5 rounded-lg bg-slate-800 border border-amber-400/50 text-xs font-semibold">
              Status Misi: <span id="teacher-mission-clock" class="text-amber-300 tabular-nums font-bold">MENUNGGU</span>
            </div>
            <button id="btn-copy-link" class="btn-secondary text-xs">Salin Link Kelas</button>
            <button id="btn-teacher-logout" class="btn-secondary text-xs text-rose-300">Keluar</button>
          </div>
        </header>

        <!-- Navigation Tabs -->
        <nav class="bg-[#0f172a] border-b border-slate-800 px-4 py-2 flex gap-2 overflow-x-auto shrink-0">
          ${this.tabBtn('misi', '1. Kontrol Misi & Peserta')}
          ${this.tabBtn('leaderboard', `2. Leaderboard (${gameMeta.name})`)}
          ${this.tabBtn('materi', '3. Kelola Materi & Elemen')}
          ${this.tabBtn('soal', `4. Bank Soal (${paiBank.getAllQuestions().length})`)}
          ${this.tabBtn('laporan', '5. Laporan & Excel (.xlsx)')}
        </nav>

        <!-- Body -->
        <main class="flex-1 overflow-y-auto p-4 md:p-6">
          <div class="max-w-7xl mx-auto">
            ${this.activeTab === 'misi' ? this.renderMisiTab(mission, participants) : ''}
            ${this.activeTab === 'leaderboard' ? this.renderLeaderboardTab(participants, gameMeta) : ''}
            ${this.activeTab === 'materi' ? this.renderMateriTab() : ''}
            ${this.activeTab === 'soal' ? this.renderSoalTab() : ''}
            ${this.activeTab === 'laporan' ? this.renderLaporanTab(participants, snap?.testimonials ?? []) : ''}
          </div>
        </main>
      </div>
    `;

    this.bindEvents();
    this.updateClockDisplay();
  }

  private tabBtn(id: TeacherTab, label: string): string {
    const active = this.activeTab === id;
    return `<button data-tab="${id}" class="px-4 py-2 rounded-lg text-sm font-bold whitespace-nowrap cursor-pointer transition ${
      active
        ? 'bg-emerald-500 text-slate-950'
        : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700'
    }">${label}</button>`;
  }

  private renderMisiTab(
    mission: RoomSnapshot['mission'] | undefined,
    participants: RoomSnapshot['participants']
  ): string {
    const elements = paiBank.getAllElements();
    const isPlaying = mission?.status === 'playing';
    const isFinished = mission?.status === 'finished';

    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <!-- Left 7 cols: Mission Config -->
        <section class="lg:col-span-7 space-y-5">
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

          <!-- Step C: Timers & Launch Controls -->
          <div class="bg-[#111c33] border border-slate-700 rounded-2xl p-4">
            <h2 class="font-display font-bold text-base text-amber-300 mb-3">
              C. Durasi & Kendali Misi Kelas
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
                  ? `<button id="btn-start-mission" class="btn-gold flex-1 text-base py-3">MULAI MISI SEKARANG</button>`
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

        <!-- Right 5 cols: Live Participants -->
        <section class="lg:col-span-5 bg-[#111c33] border border-slate-700 rounded-2xl p-4 flex flex-col">
          <div class="flex items-center justify-between mb-3">
            <h2 class="font-display font-bold text-base text-emerald-300">
              Peserta Bergabung (${participants.length})
            </h2>
            <span class="text-xs text-slate-400">Sinkronisasi Real-Time</span>
          </div>

          ${
            participants.length === 0
              ? `<div class="flex-1 flex flex-col items-center justify-center text-center py-12 text-slate-400 text-sm">
                  <p class="font-semibold text-slate-200 mb-1">Belum ada peserta di ruang kelas.</p>
                  <p>Bagikan link aplikasi kepada murid. Murid login menggunakan Nama, Kelas, dan Asal Sekolah.</p>
                </div>`
              : `<div class="space-y-2 overflow-y-auto max-h-[560px] pr-1">
                  ${participants
                    .map(
                      (p) => `
                    <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-700/80 flex items-center justify-between gap-2">
                      <div class="min-w-0">
                        <div class="flex items-center gap-2">
                          <span class="font-bold text-sm text-white truncate">${this.esc(p.nama)}</span>
                          <span class="text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-sky-300">Kls ${this.esc(p.kelas)}</span>
                          <span class="text-[10px] px-1.5 py-0.5 rounded ${
                            p.connected ? 'bg-emerald-900 text-emerald-300' : 'bg-slate-800 text-slate-400'
                          }">${p.connected ? 'Online' : 'Offline'}</span>
                        </div>
                        <div class="text-xs text-slate-400 truncate">${this.esc(p.sekolah)} · Level: ${p.level.toUpperCase()}</div>
                      </div>
                      <div class="text-right shrink-0">
                        <div class="font-display font-bold text-amber-300 tabular-nums">${p.score} pts</div>
                        <div class="text-[11px] text-slate-400">${p.progressValue} ${this.esc(p.progressLabel)}</div>
                      </div>
                    </div>`
                    )
                    .join('')}
                </div>`
          }
        </section>
      </div>
    `;
  }

  private renderLeaderboardTab(
    participants: RoomSnapshot['participants'],
    gameMeta: ReturnType<typeof getMinigameMeta>
  ): string {
    const maxScore = Math.max(100, ...participants.map((p) => p.score));
    return `
      <div class="bg-[#111c33] border border-slate-700 rounded-2xl p-5">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-5 pb-4 border-b border-slate-700">
          <div>
            <span class="text-xs font-bold px-2.5 py-1 rounded-md text-slate-950" style="background:${gameMeta.accent}">
              MINI-GAME #${gameMeta.number} · ${this.esc(gameMeta.badge)}
            </span>
            <h2 class="font-display font-bold text-2xl text-white mt-2">
              Leaderboard Realtime — ${this.esc(gameMeta.name)}
            </h2>
            <p class="text-xs text-slate-300 mt-0.5">${this.esc(gameMeta.description)}</p>
          </div>
          <div class="text-right">
            <div class="text-xs text-slate-400">Metrik Khusus Permainan</div>
            <div class="font-display font-bold text-lg text-amber-300">${this.esc(gameMeta.leaderboardMetric)} (${this.esc(gameMeta.leaderboardUnit)})</div>
          </div>
        </div>

        ${
          participants.length === 0
            ? `<p class="text-center py-12 text-slate-400">Belum ada skor peserta yang tercatat.</p>`
            : `<div class="space-y-3">
                ${participants
                  .map((p, idx) => {
                    const pct = Math.min(100, Math.round((p.score / maxScore) * 100));
                    const total = p.correctCount + p.wrongCount;
                    const acc = total > 0 ? Math.round((p.correctCount / total) * 100) : 0;
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
                              <div class="text-xs text-slate-400">${this.esc(p.sekolah)} · Level ${p.level.toUpperCase()} · Akurasi ${acc}% · Streak ${p.streak}x</div>
                            </div>
                          </div>
                          <div class="flex items-center gap-4">
                            <div class="text-right">
                              <div class="text-[11px] text-slate-400">${this.esc(gameMeta.leaderboardMetric)}</div>
                              <div class="font-bold text-sky-300 tabular-nums">${p.progressValue} ${this.esc(gameMeta.leaderboardUnit)}</div>
                            </div>
                            <div class="text-right">
                              <div class="text-[11px] text-slate-400">Total Skor</div>
                              <div class="font-display font-bold text-xl text-amber-300 tabular-nums">${p.score}</div>
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
        <!-- Add Question Form -->
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

        <!-- Question Bank Viewer -->
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
              Ekspor Laporan Analisis Excel (.xlsx)
            </h2>
            <p class="text-xs text-slate-300 mt-1">
              Berisi 3 lembar kerja lengkap: <strong>Rekap Peserta</strong>, <strong>Analisis Butir Soal AKM</strong>, dan <strong>Refleksi & Testimoni Siswa</strong>.
            </p>
          </div>
          <a href="/api/export-excel" download class="btn-gold no-underline inline-flex items-center gap-2 text-sm">
            Unduh Laporan Excel (.xlsx)
          </a>
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

  private bindEvents(): void {
    this.container.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundFX.playClick();
        this.activeTab = btn.dataset.tab as TeacherTab;
        this.render();
      });
    });

    this.container.querySelector('#btn-copy-link')?.addEventListener('click', () => {
      soundFX.playClick();
      void navigator.clipboard?.writeText(window.location.href);
      this.onToast('Link ruang kelas berhasil disalin! Bagikan kepada seluruh peserta.');
    });

    this.container.querySelector('#btn-teacher-logout')?.addEventListener('click', () => {
      soundFX.playClick();
      this.onLogout();
    });

    // Element checkboxes
    this.container.querySelectorAll<HTMLInputElement>('.js-el-check').forEach((chk) => {
      chk.addEventListener('change', () => {
        soundFX.playClick();
        if (chk.checked) this.selectedElements.add(chk.value);
        else if (this.selectedElements.size > 1) this.selectedElements.delete(chk.value);
        else chk.checked = true;
        this.pushMissionConfig();
      });
    });

    // Game picker
    this.container.querySelectorAll<HTMLButtonElement>('.js-game-pick').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundFX.playClick();
        this.selectedGameId = btn.dataset.game as GameId;
        this.pushMissionConfig();
        this.render();
      });
    });

    // Sliders
    const qDur = this.container.querySelector<HTMLInputElement>('#inp-qdur');
    const qLbl = this.container.querySelector<HTMLElement>('#lbl-qdur');
    qDur?.addEventListener('input', () => {
      this.questionDurationSec = Number(qDur.value);
      if (qLbl) qLbl.textContent = `${this.questionDurationSec} detik`;
    });

    const gDur = this.container.querySelector<HTMLInputElement>('#inp-gdur');
    const gLbl = this.container.querySelector<HTMLElement>('#lbl-gdur');
    gDur?.addEventListener('input', () => {
      this.gameDurationMin = Number(gDur.value);
      if (gLbl) gLbl.textContent = `${this.gameDurationMin} menit`;
    });

    this.container.querySelector('#btn-save-config')?.addEventListener('click', () => {
      soundFX.playClick();
      this.pushMissionConfig();
      this.onToast('Pengaturan misi berhasil diperbarui ke semua peserta.');
    });

    this.container.querySelector('#btn-start-mission')?.addEventListener('click', () => {
      soundFX.playLevelUp();
      realtimeClient.startMission({
        elementIds: Array.from(this.selectedElements),
        gameId: this.selectedGameId,
        questionDurationSec: this.questionDurationSec,
        gameDurationMin: this.gameDurationMin,
      });
      this.onToast('Misi dimulai! Semua peserta langsung masuk ke arena 3D.');
    });

    this.container.querySelector('#btn-stop-mission')?.addEventListener('click', () => {
      soundFX.playClick();
      realtimeClient.stopMission();
      this.onToast('Misi diakhiri. Form refleksi siswa telah ditampilkan.');
    });

    this.container.querySelector('#btn-return-lobby')?.addEventListener('click', () => {
      soundFX.playClick();
      realtimeClient.returnToLobby();
      this.onToast('Ruang kelas kembali ke Halaman Sekolah.');
    });

    this.container.querySelector('#btn-reset-room')?.addEventListener('click', () => {
      soundFX.playClick();
      realtimeClient.resetRoom();
      this.onToast('Sesi skor & peserta offline dibersihkan.');
    });

    // Add Element form
    const elForm = this.container.querySelector<HTMLFormElement>('#form-add-element');
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
    const qForm = this.container.querySelector<HTMLFormElement>('#form-add-question');
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

    const filterSel = this.container.querySelector<HTMLSelectElement>('#filter-q-el');
    filterSel?.addEventListener('change', () => {
      this.questionFilterElement = filterSel.value;
      this.render();
    });
  }

  private pushMissionConfig(): void {
    realtimeClient.configureMission({
      elementIds: Array.from(this.selectedElements),
      gameId: this.selectedGameId,
      questionDurationSec: this.questionDurationSec,
      gameDurationMin: this.gameDurationMin,
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
