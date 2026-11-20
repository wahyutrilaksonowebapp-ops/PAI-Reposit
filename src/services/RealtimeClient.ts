import type {
  AnswerLogEntry,
  AvatarConfig,
  BuffType,
  ChatMessage,
  DifficultyLevel,
  GameId,
  PaiElement,
  ParticipantActivity,
  ParticipantState,
  QuestionItem,
  RoomSnapshot,
  TestimonialItem,
} from '../types.ts';

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
  reflectionSaved: TestimonialItem;
  connectionChange: boolean;
};

type Listener<K extends keyof RealtimeEventMap> = (payload: RealtimeEventMap[K]) => void;

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private sse: EventSource | null = null;
  private channel: BroadcastChannel | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private studentHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private fallbackPollTimer: ReturnType<typeof setInterval> | null = null;
  private channelSyncDebounce: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Map<keyof RealtimeEventMap, Set<Listener<never>>>();
  private lastJoinPayload: Record<string, unknown> | null = null;
  private lastTeacherLogin: { code: string; sekolah: string; roomCode: string } | null = null;
  private pendingQueue: Record<string, unknown>[] = [];

  private wsConnected = false;
  private sseConnected = false;
  private seenChatIds = new Set<string>();
  private seenLoginKeys = new Set<string>();
  private seenApprovalKeys = new Set<string>();
  private lastMissionStartedAt: number | null = null;
  private initialSeedDone = false;

  public connected = false;
  public snapshot: RoomSnapshot | null = null;

  get transportLabel(): string {
    if (this.wsConnected && this.sseConnected) return 'WS+SSE';
    if (this.wsConnected) return 'WS';
    if (this.sseConnected) return 'SSE';
    return 'Offline';
  }

  connect(): void {
    this.initBroadcastChannel();
    this.connectSSE();
    this.connectWebSocket();
  }

  private updateConnectionState(): void {
    const next = this.wsConnected || this.sseConnected;
    if (next) {
      this.stopFallbackPolling();
    } else {
      this.startFallbackPolling();
    }
    if (next !== this.connected) {
      this.connected = next;
      this.emit('connectionChange', next);
    }
  }

  private initBroadcastChannel(): void {
    if (this.channel || typeof BroadcastChannel === 'undefined') return;
    try {
      this.channel = new BroadcastChannel('pai_nusantara_rt');
      this.channel.onmessage = () => {
        if (this.channelSyncDebounce) return;
        this.channelSyncDebounce = setTimeout(() => {
          this.channelSyncDebounce = null;
          void this.fetchInitialState();
        }, 120);
      };
    } catch {
      this.channel = null;
    }
  }

  private notifySiblingTabs(): void {
    try {
      this.channel?.postMessage({ type: 'sync', ts: Date.now() });
    } catch {
      // Ignore BroadcastChannel posting errors in restricted frames
    }
  }

  private connectSSE(): void {
    if (typeof EventSource === 'undefined') return;
    if (
      this.sse &&
      (this.sse.readyState === EventSource.OPEN || this.sse.readyState === EventSource.CONNECTING)
    ) {
      return;
    }

    try {
      const es = new EventSource('/api/events');
      this.sse = es;

      es.onopen = () => {
        this.sseConnected = true;
        this.updateConnectionState();
      };

      es.onmessage = (ev) => {
        this.sseConnected = true;
        this.updateConnectionState();
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        this.handleIncomingMessage(data);
      };

      es.onerror = () => {
        this.sseConnected = false;
        this.updateConnectionState();
        es.close();
        if (this.sse === es) this.sse = null;
        if (!this.sseReconnectTimer) {
          this.sseReconnectTimer = setTimeout(() => {
            this.sseReconnectTimer = null;
            this.connectSSE();
          }, 2500);
        }
      };
    } catch {
      this.sseConnected = false;
      this.updateConnectionState();
    }
  }

  private connectWebSocket(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch {
      this.wsConnected = false;
      this.updateConnectionState();
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.wsConnected = true;
      this.startHeartbeat();
      this.updateConnectionState();

      if (this.lastTeacherLogin) {
        this.sendImmediate({
          type: 'teacher:login',
          code: this.lastTeacherLogin.code,
          sekolah: this.lastTeacherLogin.sekolah,
          roomCode: this.lastTeacherLogin.roomCode,
        });
      }
      if (this.lastJoinPayload) {
        this.sendImmediate(this.lastJoinPayload);
      }

      // Flush queued messages (skip duplicates of join/login already sent above)
      const queue = this.pendingQueue.splice(0, this.pendingQueue.length);
      for (const item of queue) {
        if (item.type === 'student:join' && this.lastJoinPayload) continue;
        if (item.type === 'teacher:login' && this.lastTeacherLogin) continue;
        this.sendImmediate(item);
      }
    });

    this.ws.addEventListener('message', (ev) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handleIncomingMessage(data);
    });

    this.ws.addEventListener('close', () => {
      this.wsConnected = false;
      this.stopHeartbeat();
      this.updateConnectionState();
      this.scheduleReconnect();
    });

    this.ws.addEventListener('error', () => {
      this.ws?.close();
    });
  }

  private recordBounded(set: Set<string>, key: string, max = 220): boolean {
    if (set.has(key)) return false;
    set.add(key);
    if (set.size > max) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
    return true;
  }

  private seedSeenFromSnapshot(snap: RoomSnapshot): void {
    if (this.initialSeedDone) return;
    this.initialSeedDone = true;
    for (const m of snap.chatMessages) {
      this.recordBounded(this.seenChatIds, m.id);
    }
    for (const p of snap.participants) {
      if (p.connected) {
        this.recordBounded(this.seenLoginKeys, `${p.id}:${p.joinedAt}`);
      }
    }
    if (snap.mission.startedAt) {
      this.lastMissionStartedAt = snap.mission.startedAt;
    }
  }

  private handleIncomingMessage(data: Record<string, unknown>): void {
    if (data.snapshot) {
      const snap = data.snapshot as RoomSnapshot;
      if (!this.initialSeedDone) {
        this.seedSeenFromSnapshot(snap);
      }
      this.snapshot = snap;
    }

    switch (data.type) {
      case 'ws:pong':
        break;
      case 'room:snapshot':
        if (this.snapshot) this.emit('snapshot', this.snapshot);
        break;
      case 'student:joined':
        if (this.snapshot) {
          const joinedId = String(data.id);
          if (this.lastJoinPayload) {
            this.lastJoinPayload = { ...this.lastJoinPayload, id: joinedId };
          }
          this.startStudentHeartbeat();
          this.emit('joined', { id: joinedId, snapshot: this.snapshot });
          this.emit('snapshot', this.snapshot);
        }
        break;
      case 'student:join_error':
        this.lastJoinPayload = null;
        this.stopStudentHeartbeat();
        this.emit('joinError', String(data.error || 'Kode Ruang tidak cocok.'));
        break;
      case 'student:logged_in':
        if (this.snapshot && data.participant) {
          const participant = data.participant as ParticipantState;
          const key = `${participant.id}:${participant.joinedAt}`;
          if (this.recordBounded(this.seenLoginKeys, key)) {
            this.emit('studentLoggedIn', {
              participant,
              isNew: Boolean(data.isNew),
              snapshot: this.snapshot,
            });
          }
          this.emit('snapshot', this.snapshot);
        }
        break;
      case 'teacher:auth':
        if (!data.ok) {
          this.lastTeacherLogin = null;
        }
        this.emit('teacherAuth', {
          ok: Boolean(data.ok),
          sekolah: typeof data.sekolah === 'string' ? data.sekolah : undefined,
          roomCode: typeof data.roomCode === 'string' ? data.roomCode : undefined,
          error: typeof data.error === 'string' ? data.error : undefined,
          snapshot: this.snapshot ?? undefined,
        });
        break;
      case 'mission:started':
        if (this.snapshot) {
          const startedAt = this.snapshot.mission.startedAt;
          if (!startedAt || startedAt !== this.lastMissionStartedAt) {
            this.lastMissionStartedAt = startedAt;
            this.emit('missionStarted', this.snapshot);
          }
          this.emit('snapshot', this.snapshot);
        }
        break;
      case 'mission:ended':
        if (this.snapshot) {
          this.emit('missionEnded', {
            reason: String(data.reason || 'teacher'),
            snapshot: this.snapshot,
          });
          this.emit('snapshot', this.snapshot);
        }
        break;
      case 'student:approved':
        if (this.snapshot) {
          const participantId = String(data.participantId || '');
          const approvalKey = `${participantId}:${this.snapshot.mission.startedAt ?? 0}`;
          if (this.recordBounded(this.seenApprovalKeys, approvalKey)) {
            this.emit('studentApproved', {
              participantId,
              snapshot: this.snapshot,
            });
          }
          this.emit('snapshot', this.snapshot);
        }
        break;
      case 'player:moved':
        this.emit('playerMoved', {
          id: String(data.id),
          pos: data.pos as { x: number; y: number; z: number },
          rotY: typeof data.rotY === 'number' ? data.rotY : 0,
        });
        break;
      case 'buff:attacked':
        if (this.snapshot) {
          this.emit('buffAttacked', {
            attackerName: String(data.attackerName),
            targetId: String(data.targetId),
            targetName: String(data.targetName),
            amount: Number(data.amount),
            snapshot: this.snapshot,
          });
          this.emit('snapshot', this.snapshot);
        }
        break;
      case 'chat:message':
        if (this.snapshot && data.message) {
          const message = data.message as ChatMessage;
          if (this.recordBounded(this.seenChatIds, message.id)) {
            this.emit('chatMessage', {
              message,
              snapshot: this.snapshot,
            });
          }
          this.emit('snapshot', this.snapshot);
        }
        break;
      case 'chat:typing':
        if (typeof data.senderName === 'string') {
          this.emit('chatTyping', {
            senderId: String(data.senderId || ''),
            senderName: data.senderName,
            role: data.role === 'teacher' ? 'teacher' : 'student',
          });
        }
        break;
      case 'chat:rejected':
        this.emit('chatRejected', String(data.reason || 'Pesan tidak dapat dikirim.'));
        break;
      case 'reflection:saved':
        if (data.item) this.emit('reflectionSaved', data.item as TestimonialItem);
        break;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ws:ping' }));
      }
    }, 15_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startStudentHeartbeat(): void {
    if (this.studentHeartbeatTimer) return;
    this.studentHeartbeatTimer = setInterval(() => {
      const id = this.lastJoinPayload?.id;
      if (typeof id !== 'string' || !id) return;
      void fetch('/api/student/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
        keepalive: true,
      }).catch(() => {});
    }, 8_000);
  }

  private stopStudentHeartbeat(): void {
    if (this.studentHeartbeatTimer) {
      clearInterval(this.studentHeartbeatTimer);
      this.studentHeartbeatTimer = null;
    }
  }

  private startFallbackPolling(): void {
    if (this.fallbackPollTimer) return;
    this.fallbackPollTimer = setInterval(() => {
      if (!this.connected) {
        void this.fetchInitialState();
      }
    }, 2200);
  }

  private stopFallbackPolling(): void {
    if (this.fallbackPollTimer) {
      clearInterval(this.fallbackPollTimer);
      this.fallbackPollTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 1800);
  }

  on<K extends keyof RealtimeEventMap>(event: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as Listener<never>);
    return () => set?.delete(cb as Listener<never>);
  }

  private emit<K extends keyof RealtimeEventMap>(event: K, payload: RealtimeEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      (cb as Listener<K>)(payload);
    }
  }

  private sendImmediate(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private isActionMirroredViaHttp(type: string): boolean {
    return (
      type.startsWith('teacher:') ||
      type.startsWith('chat:') ||
      type === 'student:update_avatar' ||
      type === 'student:update_activity' ||
      type === 'student:set_ready' ||
      type === 'student:move' ||
      type === 'student:sync_progress' ||
      type === 'student:attack_player' ||
      type === 'student:submit_reflection'
    );
  }

  private send(payload: Record<string, unknown>, queueIfOffline = true): void {
    const type = String(payload.type || '');
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      if (type !== 'student:move' && type !== 'ws:ping') {
        this.notifySiblingTabs();
      }
      return;
    }

    // Immediate HTTPS action mirror when WS is unavailable or reconnecting
    if (this.isActionMirroredViaHttp(type) && type !== 'teacher:login') {
      const body: Record<string, unknown> = { ...payload };
      if (
        (type.startsWith('teacher:') ||
          type === 'chat:delete' ||
          type === 'chat:pin' ||
          type === 'chat:toggle_mute_all' ||
          type === 'chat:toggle_mute_student') &&
        this.lastTeacherLogin?.code
      ) {
        body.adminCode = this.lastTeacherLogin.code;
      }

      void fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          if (!res.ok) return;
          const json = (await res.json()) as {
            ok?: boolean;
            snapshot?: RoomSnapshot;
            item?: TestimonialItem;
          };
          if (json.snapshot) {
            this.applyPulledSnapshot(json.snapshot);
          }
          if (json.item) {
            this.emit('reflectionSaved', json.item);
          }
          if (type !== 'student:move') {
            this.notifySiblingTabs();
          }
        })
        .catch(() => {
          if (queueIfOffline) {
            this.pendingQueue.push(payload);
            if (this.pendingQueue.length > 30) this.pendingQueue.shift();
          }
        });
      return;
    }

    if (queueIfOffline) {
      this.pendingQueue.push(payload);
      if (this.pendingQueue.length > 30) {
        this.pendingQueue.shift();
      }
    }
  }

  private applyPulledSnapshot(snap: RoomSnapshot): void {
    const prev = this.snapshot;
    if (!this.initialSeedDone) {
      this.seedSeenFromSnapshot(snap);
      this.snapshot = snap;
      this.emit('snapshot', snap);
      return;
    }

    this.snapshot = snap;

    if (prev) {
      const prevMap = new Map(prev.participants.map((p) => [p.id, p]));
      for (const p of snap.participants) {
        const old = prevMap.get(p.id);
        if (p.connected && (!old || !old.connected)) {
          const key = `${p.id}:${p.joinedAt}`;
          if (this.recordBounded(this.seenLoginKeys, key)) {
            this.emit('studentLoggedIn', {
              participant: p,
              isNew: !old,
              snapshot: snap,
            });
          }
        }
      }

      for (const m of snap.chatMessages) {
        if (!m.deleted && this.recordBounded(this.seenChatIds, m.id)) {
          this.emit('chatMessage', { message: m, snapshot: snap });
        }
      }
    }

    this.emit('snapshot', snap);
  }

  async fetchInitialState(): Promise<RoomSnapshot | null> {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) return null;
      const snap = (await res.json()) as RoomSnapshot;
      this.applyPulledSnapshot(snap);
      return snap;
    } catch {
      return null;
    }
  }

  async forceSyncNow(): Promise<RoomSnapshot | null> {
    if (!this.wsConnected) this.connectWebSocket();
    if (!this.sseConnected) this.connectSSE();
    return this.fetchInitialState();
  }

  async joinStudent(payload: {
    id?: string;
    roomCode: string;
    nama: string;
    kelas: string;
    sekolah: string;
    avatar: AvatarConfig;
    activity?: ParticipantActivity;
    pos?: { x: number; y: number; z: number };
    rotY?: number;
    isReady?: boolean;
    wasApproved?: boolean;
    resumeMissionStartedAt?: number | null;
  }): Promise<{ ok: boolean; id?: string; error?: string; snapshot?: RoomSnapshot }> {
    const msg = { type: 'student:join', ...payload };

    try {
      // Validate roomCode & register instantaneously via HTTP so teacher sees student immediately
      const res = await fetch('/api/student/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        id?: string;
        error?: string;
        snapshot?: RoomSnapshot;
      };
      if (!res.ok || !json.ok) {
        return { ok: false, error: json.error || 'Kode Ruang tidak cocok.' };
      }

      const resolvedId = json.id || payload.id;
      this.lastJoinPayload = { ...msg, id: resolvedId };
      this.startStudentHeartbeat();
      if (json.snapshot) {
        this.snapshot = json.snapshot;
      }

      // Bind this WebSocket connection to the participant ID too
      this.send(this.lastJoinPayload, true);
      this.notifySiblingTabs();

      if (resolvedId && json.snapshot) {
        this.emit('joined', { id: resolvedId, snapshot: json.snapshot });
        this.emit('snapshot', json.snapshot);
      }
      return { ok: true, id: resolvedId, snapshot: json.snapshot };
    } catch {
      // Fallback to WS-only if fetch failed transiently
      this.lastJoinPayload = msg;
      this.startStudentHeartbeat();
      this.send(msg, true);
      return { ok: true, id: payload.id, snapshot: this.snapshot ?? undefined };
    }
  }

  leaveStudent(id?: string | null): void {
    const targetId = id || (this.lastJoinPayload?.id as string | undefined);
    this.lastJoinPayload = null;
    this.stopStudentHeartbeat();
    if (!targetId) return;
    this.send({ type: 'student:leave', id: targetId }, false);
    void fetch('/api/student/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: targetId }),
      keepalive: true,
    })
      .then(() => this.notifySiblingTabs())
      .catch(() => {});
  }

  clearStudentSession(): void {
    this.lastJoinPayload = null;
    this.stopStudentHeartbeat();
  }

  updateAvatar(id: string, avatar: AvatarConfig, activity?: ParticipantActivity): void {
    if (this.lastJoinPayload) {
      this.lastJoinPayload = {
        ...this.lastJoinPayload,
        avatar,
        ...(activity ? { activity } : {}),
      };
    }
    this.send({ type: 'student:update_avatar', id, avatar, activity }, true);
  }

  updateActivity(id: string, activity: ParticipantActivity): void {
    if (this.lastJoinPayload) {
      this.lastJoinPayload = { ...this.lastJoinPayload, activity };
    }
    this.send({ type: 'student:update_activity', id, activity }, true);
  }

  setReady(id: string, ready: boolean): void {
    this.send({ type: 'student:set_ready', id, ready }, true);
  }

  sendMove(id: string, pos: { x: number; y: number; z: number }, rotY = 0): void {
    this.send({ type: 'student:move', id, pos, rotY }, false);
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
    this.send({ type: 'student:sync_progress', ...payload }, true);
  }

  attackPlayer(attackerId: string, targetId: string, amount = 150): void {
    this.send({ type: 'student:attack_player', attackerId, targetId, amount }, true);
  }

  submitReflection(payload: {
    id: string;
    nama: string;
    kelas: string;
    sekolah: string;
    skor: number;
    refleksi: string;
    komentar: string;
    kritikSaran: string;
  }): void {
    this.send({ type: 'student:submit_reflection', ...payload }, true);
  }

  // === MODERATED LIVE CHAT ===
  sendChat(payload: {
    role: 'student' | 'teacher';
    senderId?: string;
    senderName?: string;
    senderKelas?: string;
    text: string;
    pin?: boolean;
  }): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'chat:send', ...payload }));
      this.notifySiblingTabs();
      return;
    }

    // Immediate HTTP fallback if WS is reconnecting so virtual forum chat never drops
    void fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        const json = (await res.json()) as {
          ok?: boolean;
          reason?: string;
          message?: ChatMessage;
          snapshot?: RoomSnapshot;
        };
        if (!res.ok || !json.ok) {
          this.emit('chatRejected', json.reason || 'Pesan tidak dapat dikirim.');
          return;
        }
        if (json.snapshot) {
          this.snapshot = json.snapshot;
          if (json.message && this.recordBounded(this.seenChatIds, json.message.id)) {
            this.emit('chatMessage', { message: json.message, snapshot: json.snapshot });
          }
          this.emit('snapshot', json.snapshot);
        }
        this.notifySiblingTabs();
      })
      .catch(() => {
        this.emit('chatRejected', 'Koneksi terputus. Pesan gagal terkirim, coba lagi.');
      });
  }

  sendTyping(payload: {
    role: 'student' | 'teacher';
    senderId?: string;
    senderName: string;
  }): void {
    this.send({ type: 'chat:typing', ...payload }, false);
  }

  deleteChatMessage(messageId: string): void {
    this.send({ type: 'chat:delete', messageId }, true);
  }

  pinChatMessage(messageId: string): void {
    this.send({ type: 'chat:pin', messageId }, true);
  }

  toggleMuteAll(muted?: boolean): void {
    this.send({ type: 'chat:toggle_mute_all', muted }, true);
  }

  toggleMuteStudent(participantId: string): void {
    this.send({ type: 'chat:toggle_mute_student', participantId }, true);
  }

  // === TEACHER ADMIN, ROOM CODE & APPROVAL ===
  async loginTeacher(
    code: string,
    sekolah: string,
    roomCode: string
  ): Promise<{ ok: boolean; sekolah?: string; roomCode?: string; error?: string; snapshot?: RoomSnapshot }> {
    const cleanRoom = roomCode.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12) || 'PAI2026';
    this.lastTeacherLogin = { code, sekolah, roomCode: cleanRoom };
    this.send({ type: 'teacher:login', code, sekolah, roomCode: cleanRoom }, true);

    try {
      const res = await fetch('/api/teacher/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, sekolah, roomCode: cleanRoom }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        sekolah?: string;
        roomCode?: string;
        error?: string;
        snapshot?: RoomSnapshot;
      };
      if (!res.ok || !json.ok) {
        this.lastTeacherLogin = null;
        return { ok: false, error: json.error || 'Kode guru tidak valid.' };
      }
      if (json.snapshot) {
        this.applyPulledSnapshot(json.snapshot);
      }
      this.notifySiblingTabs();
      return {
        ok: true,
        sekolah: json.sekolah || sekolah,
        roomCode: json.roomCode || cleanRoom,
        snapshot: json.snapshot,
      };
    } catch {
      return { ok: true, sekolah, roomCode: cleanRoom, snapshot: this.snapshot ?? undefined };
    }
  }

  setRoomCode(roomCode: string): void {
    const cleanRoom = roomCode.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
    if (cleanRoom.length < 3) return;
    if (this.lastTeacherLogin) {
      this.lastTeacherLogin = { ...this.lastTeacherLogin, roomCode: cleanRoom };
    }
    this.send({ type: 'teacher:set_room_code', roomCode: cleanRoom }, true);
  }

  clearTeacherSession(): void {
    this.lastTeacherLogin = null;
  }

  configureMission(payload: {
    elementIds: string[];
    gameId: GameId;
    questionDurationSec: number;
    gameDurationMin: number;
  }): void {
    this.send({ type: 'teacher:configure_mission', ...payload }, true);
  }

  startMission(payload: {
    elementIds: string[];
    gameId: GameId;
    questionDurationSec: number;
    gameDurationMin: number;
  }): void {
    this.send({ type: 'teacher:start_mission', ...payload }, true);
  }

  approveStudent(participantId: string): void {
    this.send({ type: 'teacher:approve_student', participantId }, true);
  }

  approveAllStudents(): void {
    this.send({ type: 'teacher:approve_all_students' }, true);
  }

  stopMission(): void {
    this.send({ type: 'teacher:stop_mission' });
  }

  returnToLobby(): void {
    this.send({ type: 'teacher:return_lobby' });
  }

  addElement(element: PaiElement): void {
    this.send({ type: 'teacher:add_element', element });
  }

  addQuestion(question: QuestionItem): void {
    this.send({ type: 'teacher:add_question', question });
  }

  resetRoom(): void {
    this.send({ type: 'teacher:reset_room' });
  }
}

export const realtimeClient = new RealtimeClient();
