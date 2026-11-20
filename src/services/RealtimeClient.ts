import type {
  AnswerLogEntry,
  AvatarConfig,
  BuffType,
  ChatMessage,
  DifficultyLevel,
  GameId,
  PaiElement,
  ParticipantActivity,
  QuestionItem,
  RoomSnapshot,
  TestimonialItem,
} from '../types.ts';

export type RealtimeEventMap = {
  snapshot: RoomSnapshot;
  joined: { id: string; snapshot: RoomSnapshot };
  teacherAuth: { ok: boolean; sekolah?: string; error?: string; snapshot?: RoomSnapshot };
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
  chatRejected: string;
  reflectionSaved: TestimonialItem;
  connectionChange: boolean;
};

type Listener<K extends keyof RealtimeEventMap> = (payload: RealtimeEventMap[K]) => void;

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Map<keyof RealtimeEventMap, Set<Listener<never>>>();
  private lastJoinPayload: Record<string, unknown> | null = null;
  private lastTeacherLogin: { code: string; sekolah: string } | null = null;
  private pendingQueue: Record<string, unknown>[] = [];
  public connected = false;
  public snapshot: RoomSnapshot | null = null;

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.connected = true;
      this.emit('connectionChange', true);

      if (this.lastTeacherLogin) {
        this.sendImmediate({
          type: 'teacher:login',
          code: this.lastTeacherLogin.code,
          sekolah: this.lastTeacherLogin.sekolah,
        });
      }
      if (this.lastJoinPayload) {
        this.sendImmediate(this.lastJoinPayload);
      }

      // Flush any queued messages (skip duplicates of join/login already sent above)
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

      if (data.snapshot) {
        this.snapshot = data.snapshot as RoomSnapshot;
      }

      switch (data.type) {
        case 'room:snapshot':
          if (this.snapshot) this.emit('snapshot', this.snapshot);
          break;
        case 'student:joined':
          if (this.snapshot) {
            const joinedId = String(data.id);
            if (this.lastJoinPayload) {
              this.lastJoinPayload = { ...this.lastJoinPayload, id: joinedId };
            }
            this.emit('joined', { id: joinedId, snapshot: this.snapshot });
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
            error: typeof data.error === 'string' ? data.error : undefined,
            snapshot: this.snapshot ?? undefined,
          });
          break;
        case 'mission:started':
          if (this.snapshot) {
            this.emit('missionStarted', this.snapshot);
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
            this.emit('studentApproved', {
              participantId: String(data.participantId || ''),
              snapshot: this.snapshot,
            });
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
            this.emit('chatMessage', {
              message: data.message as ChatMessage,
              snapshot: this.snapshot,
            });
            this.emit('snapshot', this.snapshot);
          }
          break;
        case 'chat:rejected':
          this.emit('chatRejected', String(data.reason || 'Pesan tidak dapat dikirim.'));
          break;
        case 'reflection:saved':
          if (data.item) this.emit('reflectionSaved', data.item as TestimonialItem);
          break;
      }
    });

    this.ws.addEventListener('close', () => {
      this.connected = false;
      this.emit('connectionChange', false);
      this.scheduleReconnect();
    });

    this.ws.addEventListener('error', () => {
      this.ws?.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
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

  private send(payload: Record<string, unknown>, queueIfOffline = true): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else if (queueIfOffline) {
      this.pendingQueue.push(payload);
      if (this.pendingQueue.length > 30) {
        this.pendingQueue.shift();
      }
    }
  }

  async fetchInitialState(): Promise<RoomSnapshot | null> {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return null;
      const snap = (await res.json()) as RoomSnapshot;
      this.snapshot = snap;
      this.emit('snapshot', snap);
      return snap;
    } catch {
      return null;
    }
  }

  joinStudent(payload: {
    id?: string;
    nama: string;
    kelas: string;
    sekolah: string;
    avatar: AvatarConfig;
    activity?: ParticipantActivity;
  }): void {
    const msg = { type: 'student:join', ...payload };
    this.lastJoinPayload = msg;
    this.send(msg, true);
  }

  clearStudentSession(): void {
    this.lastJoinPayload = null;
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

  // === MODERATED CHAT ===
  sendChat(payload: {
    role: 'student' | 'teacher';
    senderId?: string;
    senderName?: string;
    text: string;
    pin?: boolean;
  }): void {
    this.send({ type: 'chat:send', ...payload }, true);
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

  // === TEACHER ADMIN & APPROVAL ===
  loginTeacher(code: string, sekolah: string): void {
    this.lastTeacherLogin = { code, sekolah };
    this.send({ type: 'teacher:login', code, sekolah }, true);
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
