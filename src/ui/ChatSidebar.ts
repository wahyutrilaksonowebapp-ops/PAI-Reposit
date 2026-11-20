import type { ChatMessage, RoomSnapshot } from '../types.ts';
import { realtimeClient } from '../services/RealtimeClient.ts';
import { soundFX } from '../audio/SoundFX.ts';

export interface ChatSidebarOptions {
  role: 'student' | 'teacher';
  selfId?: string | null;
  senderName: string;
  senderKelas?: string;
  compact?: boolean;
  onToast?: (msg: string) => void;
}

const STUDENT_QUICK_REPLIES = [
  "Assalamu'alaikum!",
  'Siap belajar & ikut misi!',
  'Saya sudah baca materinya',
  'Semangat teman-teman!',
];

const TEACHER_QUICK_REPLIES = [
  "Assalamu'alaikum anak-anak, silakan baca materi di Kios 3D ya!",
  'Sebentar lagi misi dimulai, bersiap semuanya!',
  'Bagus sekali, tetap jujur dan semangat!',
];

/**
 * Reusable moderated, safe-for-students chat sidebar component.
 * Supports surgical updates of the message list so typing in the input is never interrupted.
 */
export class ChatSidebar {
  private root: HTMLElement | null = null;
  private options: ChatSidebarOptions;
  private snapshot: RoomSnapshot | null = null;
  private lastMessageCount = 0;
  private typingClearTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTypingEmitAt = 0;

  constructor(options: ChatSidebarOptions) {
    this.options = options;
  }

  setOptions(partial: Partial<ChatSidebarOptions>): void {
    this.options = { ...this.options, ...partial };
  }

  mount(container: HTMLElement, snapshot: RoomSnapshot | null): void {
    this.root = container;
    this.snapshot = snapshot;
    this.renderShell();
    this.updateMessages(snapshot, true);
  }

  unmount(): void {
    if (this.typingClearTimer) {
      clearTimeout(this.typingClearTimer);
      this.typingClearTimer = null;
    }
    this.root = null;
  }

  showTyping(senderName: string, senderId: string): void {
    if (!this.root) return;
    if (this.options.role === 'student' && senderId === this.options.selfId) return;
    if (this.options.role === 'teacher' && senderId === 'teacher_admin') return;
    const typingEl = this.root.querySelector<HTMLElement>('.js-chat-typing');
    if (!typingEl) return;
    typingEl.textContent = `${senderName} sedang mengetik...`;
    typingEl.classList.remove('hidden');
    if (this.typingClearTimer) clearTimeout(this.typingClearTimer);
    this.typingClearTimer = setTimeout(() => {
      typingEl.classList.add('hidden');
      typingEl.textContent = '';
    }, 2600);
  }

  updateMessages(snapshot: RoomSnapshot | null, forceScroll = false): void {
    this.snapshot = snapshot;
    if (!this.root) return;

    const messages = snapshot?.chatMessages ?? [];
    const chatMutedAll = snapshot?.chatMutedAll ?? false;
    const mutedIds = new Set(snapshot?.mutedParticipantIds ?? []);
    const selfMuted =
      this.options.role === 'student' &&
      (chatMutedAll || (this.options.selfId ? mutedIds.has(this.options.selfId) : false));

    // Update online count in chat header
    const onlineBadge = this.root.querySelector<HTMLElement>('.js-chat-online-count');
    if (onlineBadge) {
      const onlineCount = (snapshot?.participants ?? []).filter((p) => p.connected).length;
      onlineBadge.textContent = `${onlineCount} Online`;
    }

    // Update mute button (teacher)
    const muteAllBtn = this.root.querySelector<HTMLButtonElement>('.js-chat-mute-all');
    if (muteAllBtn) {
      muteAllBtn.textContent = chatMutedAll ? 'Aktifkan Chat Kelas' : 'Bisukan Kelas';
      muteAllBtn.className = `js-chat-mute-all px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer transition ${
        chatMutedAll
          ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
          : 'bg-rose-600/90 text-white hover:bg-rose-500'
      }`;
    }

    // Update pinned banner
    const pinSlot = this.root.querySelector<HTMLElement>('.js-chat-pinned');
    const pinnedMsg = messages.find((m) => m.pinned && !m.deleted);
    if (pinSlot) {
      if (pinnedMsg) {
        pinSlot.classList.remove('hidden');
        pinSlot.innerHTML = `
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-[10px] font-bold uppercase tracking-wider text-amber-300">Pengumuman Guru</div>
              <div class="text-xs text-white leading-snug mt-0.5 break-words">${this.esc(pinnedMsg.text)}</div>
            </div>
            ${
              this.options.role === 'teacher'
                ? `<button data-pin-id="${pinnedMsg.id}" class="js-chat-pin shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 hover:text-white cursor-pointer">Lepas</button>`
                : ''
            }
          </div>
        `;
        this.bindMessageActionButtons(pinSlot);
      } else {
        pinSlot.classList.add('hidden');
        pinSlot.innerHTML = '';
      }
    }

    // Update message list
    const listEl = this.root.querySelector<HTMLElement>('.js-chat-list');
    if (listEl) {
      const wasAtBottom =
        forceScroll ||
        listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 60 ||
        messages.length !== this.lastMessageCount;

      if (messages.length === 0) {
        listEl.innerHTML = `
          <div class="text-center py-6 px-3 text-xs text-slate-400">
            <div class="font-semibold text-slate-300 mb-1">Ruang Diskusi Aman PAI</div>
            <div>Gunakan bahasa sopan dan santun. Pesan dilindungi filter otomatis & moderasi Guru.</div>
          </div>
        `;
      } else {
        listEl.innerHTML = messages.map((m) => this.renderMessageItem(m, mutedIds)).join('');
        this.bindMessageActionButtons(listEl);
      }

      if (wasAtBottom) {
        listEl.scrollTop = listEl.scrollHeight;
      }
    }

    // Update mute notice & input disabled state for student
    const muteNotice = this.root.querySelector<HTMLElement>('.js-chat-mute-notice');
    const inputEl = this.root.querySelector<HTMLInputElement>('.js-chat-input');
    const sendBtn = this.root.querySelector<HTMLButtonElement>('.js-chat-send');
    const quickWrap = this.root.querySelector<HTMLElement>('.js-chat-quick');

    if (muteNotice) {
      if (selfMuted) {
        muteNotice.classList.remove('hidden');
        muteNotice.textContent = chatMutedAll
          ? 'Mode Fokus aktif: Chat siswa sedang dibisukan sementara oleh Guru.'
          : 'Akun chat kamu sedang dibisukan sementara oleh Guru.';
      } else {
        muteNotice.classList.add('hidden');
      }
    }
    if (inputEl) {
      inputEl.disabled = selfMuted;
      inputEl.placeholder = selfMuted
        ? 'Chat sedang dibisukan oleh Guru...'
        : this.options.role === 'teacher'
          ? 'Tulis arahan / pesan untuk seluruh kelas...'
          : 'Tulis pesan sopan ke guru & teman...';
    }
    if (sendBtn) {
      sendBtn.disabled = selfMuted;
      sendBtn.style.opacity = selfMuted ? '0.45' : '1';
    }
    if (quickWrap) {
      quickWrap.style.opacity = selfMuted ? '0.45' : '1';
      quickWrap.style.pointerEvents = selfMuted ? 'none' : 'auto';
    }

    this.lastMessageCount = messages.length;
  }

  private renderShell(): void {
    if (!this.root) return;
    const isTeacher = this.options.role === 'teacher';
    const quickList = isTeacher ? TEACHER_QUICK_REPLIES : STUDENT_QUICK_REPLIES;

    this.root.innerHTML = `
      <div class="chat-panel flex flex-col h-full min-h-0">
        <!-- Header -->
        <div class="px-3 py-2.5 border-b border-slate-700/80 flex items-center justify-between gap-2 shrink-0 bg-slate-900/80">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
              <span class="font-display font-bold text-xs text-white truncate">
                ${isTeacher ? 'Live Chat Kelas (Admin)' : 'Live Chat Virtual PAI'}
              </span>
              <span class="js-chat-online-count text-[10px] px-1.5 py-0.2 rounded bg-emerald-950 border border-emerald-400/40 text-emerald-300 font-bold shrink-0">0 Online</span>
            </div>
            <div class="text-[10px] text-slate-400 truncate">
              ${isTeacher ? 'Percakapan virtual & moderasi realtime' : 'Ngobrol sopan dengan Guru & teman'}
            </div>
          </div>
          ${
            isTeacher
              ? `<button type="button" class="js-chat-mute-all px-2.5 py-1 rounded-lg text-[11px] font-bold bg-rose-600/90 text-white cursor-pointer">Bisukan Kelas</button>`
              : `<span class="text-[10px] px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-400/40 text-emerald-300 font-semibold shrink-0">Aman SD</span>`
          }
        </div>

        <!-- Pinned Teacher Announcement -->
        <div class="js-chat-pinned hidden px-3 py-2 bg-amber-950/55 border-b border-amber-400/45 shrink-0"></div>

        <!-- Messages List -->
        <div class="js-chat-list flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2"></div>

        <!-- Realtime Typing Indicator -->
        <div class="js-chat-typing hidden px-3 py-1 text-[11px] italic text-sky-300 bg-slate-900/60 shrink-0"></div>

        <!-- Student Mute Notice -->
        <div class="js-chat-mute-notice hidden px-3 py-1.5 bg-rose-950/75 border-t border-rose-500/40 text-[11px] text-rose-200 font-semibold shrink-0"></div>

        <!-- Quick Safe Replies -->
        <div class="js-chat-quick px-2.5 pt-2 pb-1 border-t border-slate-800 flex gap-1.5 overflow-x-auto shrink-0">
          ${quickList
            .map(
              (txt) =>
                `<button type="button" data-quick="${this.esc(txt)}" class="js-quick-chip shrink-0 px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] text-slate-200 cursor-pointer transition">${this.esc(
                  txt.length > 26 ? `${txt.slice(0, 26)}…` : txt
                )}</button>`
            )
            .join('')}
        </div>

        <!-- Input Bar -->
        <form class="js-chat-form p-2.5 pt-1.5 flex flex-col gap-1.5 shrink-0 bg-slate-900/70">
          ${
            isTeacher
              ? `<label class="flex items-center gap-1.5 text-[11px] text-amber-200 cursor-pointer select-none">
                  <input type="checkbox" class="js-chat-pin-check accent-amber-400" />
                  <span>Sematkan sebagai Pengumuman Kelas</span>
                </label>`
              : ''
          }
          <div class="flex items-center gap-1.5">
            <input
              type="text"
              maxlength="${isTeacher ? 260 : 180}"
              autocomplete="off"
              class="js-chat-input input-dark text-xs py-2 px-2.5 flex-1 min-w-0"
              placeholder="${isTeacher ? 'Tulis arahan untuk siswa...' : 'Tulis pesan sopan...'}"
            />
            <button type="submit" class="js-chat-send btn-primary py-2 px-3 text-xs shrink-0">
              Kirim
            </button>
          </div>
        </form>
      </div>
    `;

    this.bindShellEvents();
  }

  private renderMessageItem(m: ChatMessage, mutedIds: Set<string>): string {
    const isTeacherMsg = m.senderRole === 'teacher';
    const isSelf =
      (this.options.role === 'teacher' && isTeacherMsg) ||
      (this.options.role === 'student' && m.senderId === this.options.selfId);
    const time = new Date(m.createdAt).toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const senderMuted = mutedIds.has(m.senderId);

    return `
      <div class="rounded-xl p-2 text-xs border ${
        isTeacherMsg
          ? 'bg-amber-950/45 border-amber-400/50'
          : isSelf
            ? 'bg-emerald-950/45 border-emerald-400/40'
            : 'bg-slate-900/90 border-slate-700/80'
      }">
        <div class="flex items-center justify-between gap-1.5 mb-0.5">
          <div class="flex items-center gap-1.5 min-w-0">
            ${
              isTeacherMsg
                ? `<span class="px-1.5 py-0.2 rounded bg-amber-400 text-slate-950 font-bold text-[9px] shrink-0">GURU</span>`
                : ''
            }
            <span class="font-bold truncate ${isTeacherMsg ? 'text-amber-300' : 'text-sky-300'}">${this.esc(
              m.senderName
            )}</span>
            ${
              m.senderKelas
                ? `<span class="text-[10px] text-slate-400 shrink-0">Kls ${this.esc(m.senderKelas)}</span>`
                : ''
            }
          </div>
          <span class="text-[10px] text-slate-500 tabular-nums shrink-0">${time}</span>
        </div>

        <p class="text-slate-100 leading-snug break-words whitespace-pre-wrap">${this.esc(m.text)}</p>

        ${
          this.options.role === 'teacher'
            ? `<div class="mt-1.5 pt-1 border-t border-slate-800/80 flex flex-wrap items-center gap-1.5">
                <button type="button" data-pin-id="${m.id}" class="js-chat-pin text-[10px] px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 cursor-pointer">
                  ${m.pinned ? 'Lepas Pin' : 'Sematkan'}
                </button>
                <button type="button" data-del-id="${m.id}" class="js-chat-del text-[10px] px-1.5 py-0.5 rounded bg-slate-800 hover:bg-rose-700 text-rose-300 hover:text-white cursor-pointer">
                  Hapus
                </button>
                ${
                  !isTeacherMsg
                    ? `<button type="button" data-mute-pid="${m.senderId}" class="js-chat-mute-stu text-[10px] px-1.5 py-0.5 rounded cursor-pointer ${
                        senderMuted
                          ? 'bg-emerald-900 text-emerald-200 hover:bg-emerald-800'
                          : 'bg-slate-800 hover:bg-amber-700 text-slate-300 hover:text-white'
                      }">${senderMuted ? 'Buka Bisu' : 'Bisukan Siswa'}</button>`
                    : ''
                }
              </div>`
            : ''
        }
      </div>
    `;
  }

  private bindShellEvents(): void {
    if (!this.root) return;

    this.root.querySelector('.js-chat-mute-all')?.addEventListener('click', () => {
      soundFX.playClick();
      realtimeClient.toggleMuteAll();
    });

    this.root.querySelectorAll<HTMLButtonElement>('.js-quick-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const text = chip.dataset.quick || '';
        if (!text) return;
        soundFX.playClick();
        this.submitText(text, false);
      });
    });

    const form = this.root.querySelector<HTMLFormElement>('.js-chat-form');
    const input = this.root.querySelector<HTMLInputElement>('.js-chat-input');
    const pinCheck = this.root.querySelector<HTMLInputElement>('.js-chat-pin-check');

    input?.addEventListener('input', () => {
      const now = Date.now();
      if (now - this.lastTypingEmitAt > 1400 && input.value.trim().length > 0) {
        this.lastTypingEmitAt = now;
        realtimeClient.sendTyping({
          role: this.options.role,
          senderId: this.options.selfId ?? undefined,
          senderName: this.options.senderName,
        });
      }
    });

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!input) return;
      const text = input.value.trim();
      if (!text) return;
      const pin = Boolean(pinCheck?.checked);
      this.submitText(text, pin);
      input.value = '';
      if (pinCheck) pinCheck.checked = false;
    });
  }

  private bindMessageActionButtons(scope: HTMLElement): void {
    scope.querySelectorAll<HTMLButtonElement>('.js-chat-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundFX.playClick();
        const id = btn.dataset.delId;
        if (id) realtimeClient.deleteChatMessage(id);
      });
    });

    scope.querySelectorAll<HTMLButtonElement>('.js-chat-pin').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundFX.playClick();
        const id = btn.dataset.pinId;
        if (id) realtimeClient.pinChatMessage(id);
      });
    });

    scope.querySelectorAll<HTMLButtonElement>('.js-chat-mute-stu').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundFX.playClick();
        const pid = btn.dataset.mutePid;
        if (pid) realtimeClient.toggleMuteStudent(pid);
      });
    });
  }

  private submitText(text: string, pin: boolean): void {
    realtimeClient.sendChat({
      role: this.options.role,
      senderId: this.options.selfId ?? undefined,
      senderName: this.options.senderName,
      senderKelas: this.options.senderKelas,
      text,
      pin,
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
