import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import * as XLSX from 'xlsx';
import type {
  AvatarConfig,
  ChatMessage,
  GameId,
  MissionConfig,
  PaiElement,
  ParticipantActivity,
  ParticipantState,
  QuestionItem,
  RoomSnapshot,
  TestimonialItem,
  AnswerLogEntry,
  DifficultyLevel,
  BuffType,
} from './src/types.ts';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ADMIN_CODE = 'gpaibeji';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'pai_db.json');

interface PersistedData {
  testimonials: TestimonialItem[];
  customElements: PaiElement[];
  customQuestions: QuestionItem[];
}

function loadDb(): PersistedData {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedData>;
      return {
        testimonials: Array.isArray(parsed.testimonials) ? parsed.testimonials : [],
        customElements: Array.isArray(parsed.customElements) ? parsed.customElements : [],
        customQuestions: Array.isArray(parsed.customQuestions) ? parsed.customQuestions : [],
      };
    }
  } catch (err) {
    console.warn('Could not load DB, starting fresh:', err);
  }
  return {
    testimonials: [],
    customElements: [],
    customQuestions: [],
  };
}

function saveDb(data: PersistedData): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist DB:', err);
  }
}

const persisted = loadDb();

const GAME_NAMES: Record<GameId, string> = {
  puncak_nalar: 'Puncak Nalar',
  sky_bridge: 'Sky Bridge Builder',
  grand_prix: '3D Grand Prix Edu-Race',
  lost_scroll: 'The Lost Scroll Maze',
  edu_craft: 'Edu-Craft Island',
  portal_dimension: 'Portal Dimension Explorer',
  board_adventure: '3D Board Adventure',
  astro_scanner: 'Astro-Scanner 3D',
  climb_summit: 'Climb the Summit 3D',
};

const mission: MissionConfig = {
  active: false,
  status: 'lobby',
  elementIds: ['quran_hadis', 'akidah', 'akhlak', 'fiqih', 'spi'],
  gameId: 'puncak_nalar',
  questionDurationSec: 25,
  gameDurationMin: 10,
  startedAt: null,
  endsAt: null,
};

let activeRoomCode = 'PAI2026';

function normalizeRoomCode(raw: unknown): string {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 12);
}

const participants = new Map<string, ParticipantState>();
const participantLastSeen = new Map<string, number>();
const socketToParticipantId = new Map<WebSocket, string>();
const teacherSockets = new Set<WebSocket>();
const sseClients = new Set<express.Response>();
let missionEndTimer: ReturnType<typeof setTimeout> | null = null;

// === MODERATED SAFE-FOR-STUDENTS CHAT STATE ===
const chatMessages: ChatMessage[] = [];
let chatMutedAll = false;
const mutedParticipantIds = new Set<string>();
const lastChatSentAt = new Map<string, number>();

const BLOCKED_WORDS = [
  'anjing',
  'anjir',
  'bangsat',
  'bajingan',
  'bego',
  'bodoh',
  'tolol',
  'goblok',
  'kampret',
  'kontol',
  'memek',
  'ngentot',
  'asu',
  'jancok',
  'jancuk',
  'kimak',
  'puki',
  'pantek',
  'setan',
  'brengsek',
  'sialan',
  'tai',
  'babi',
  'monyet',
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'damn',
  'stupid',
  'idiot',
];

const BLOCKED_WORD_REGEX = new RegExp(
  `\\b(${BLOCKED_WORDS.join('|')})\\b`,
  'i'
);
const URL_REGEX = /(https?:\/\/|www\.|\.[a-z]{2,}\/)/i;

function validateStudentMessage(
  senderId: string,
  rawText: string
): { ok: true; text: string } | { ok: false; reason: string } {
  const cleaned = rawText.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return { ok: false, reason: 'Pesan tidak boleh kosong.' };
  }
  if (cleaned.length > 180) {
    return { ok: false, reason: 'Pesan maksimal 180 karakter.' };
  }
  if (chatMutedAll) {
    return { ok: false, reason: 'Chat kelas sedang dibisukan sementara oleh Guru.' };
  }
  if (mutedParticipantIds.has(senderId)) {
    return { ok: false, reason: 'Akun chat kamu sedang dibisukan oleh Guru.' };
  }

  const now = Date.now();
  const prev = lastChatSentAt.get(senderId) ?? 0;
  if (now - prev < 1500) {
    return { ok: false, reason: 'Tunggu sebentar sebelum mengirim pesan berikutnya.' };
  }

  if (URL_REGEX.test(cleaned)) {
    return { ok: false, reason: 'Demi keamanan siswa, pengiriman tautan/link tidak diperbolehkan.' };
  }
  if (BLOCKED_WORD_REGEX.test(cleaned)) {
    return {
      ok: false,
      reason: 'Pesan ditahan oleh filter sopan santun. Gunakan bahasa yang baik dan santun ya!',
    };
  }

  lastChatSentAt.set(senderId, now);
  return { ok: true, text: cleaned };
}

function computeRanks(): ParticipantState[] {
  const list = Array.from(participants.values());
  list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.progressValue !== a.progressValue) return b.progressValue - a.progressValue;
    return b.correctCount - a.correctCount;
  });
  list.forEach((p, idx) => {
    p.rank = idx + 1;
  });
  return list;
}

function getSnapshot(): RoomSnapshot {
  return {
    roomCode: activeRoomCode,
    mission: { ...mission },
    participants: computeRanks(),
    testimonials: persisted.testimonials.slice(-60),
    customElements: persisted.customElements,
    customQuestions: persisted.customQuestions,
    chatMessages: chatMessages.filter((m) => !m.deleted).slice(-80),
    chatMutedAll,
    mutedParticipantIds: Array.from(mutedParticipantIds),
    serverTime: Date.now(),
  };
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

let wss: WebSocketServer | null = null;

function broadcast(payload: unknown, exclude?: WebSocket): void {
  const serialized = JSON.stringify(payload);
  if (wss) {
    for (const client of wss.clients) {
      if (client !== exclude && client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }
  if (sseClients.size > 0) {
    const sseFrame = `data: ${serialized}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(sseFrame);
      } catch {
        sseClients.delete(res);
      }
    }
  }
}

function broadcastSnapshot(): void {
  broadcast({ type: 'room:snapshot', snapshot: getSnapshot() });
}

function isParticipantStillOnAnotherSocket(participantId: string, closingWs: WebSocket): boolean {
  for (const [sock, pid] of socketToParticipantId.entries()) {
    if (sock !== closingWs && pid === participantId && sock.readyState === WebSocket.OPEN) {
      return true;
    }
  }
  return false;
}

function stopMission(reason: 'teacher' | 'timeout'): void {
  if (missionEndTimer) {
    clearTimeout(missionEndTimer);
    missionEndTimer = null;
  }
  mission.active = false;
  mission.status = 'finished';
  mission.endsAt = Date.now();
  for (const p of participants.values()) {
    if (p.activity === 'playing') {
      p.activity = 'finished';
    }
  }
  broadcast({ type: 'mission:ended', reason, snapshot: getSnapshot() });
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/state', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(getSnapshot());
  });

  // Shared server-authoritative student join helper (used by both WS and HTTP fallback)
  const registerStudent = (msg: Record<string, unknown>): {
    participant: ParticipantState;
    isNew: boolean;
  } => {
    const id =
      typeof msg.id === 'string' && msg.id.trim()
        ? msg.id.trim()
        : `stu_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const nama = String(msg.nama || 'Peserta').trim().slice(0, 40);
    const kelas = String(msg.kelas || '5').trim().slice(0, 16);
    const sekolah = String(msg.sekolah || 'SDN Nusantara').trim().slice(0, 60);
    const avatar = msg.avatar as AvatarConfig;
    const activity = (
      typeof msg.activity === 'string' ? msg.activity : 'avatar'
    ) as ParticipantActivity;

    const existing = participants.get(id);
    if (existing) {
      const wasOffline = !existing.connected;
      existing.nama = nama;
      existing.kelas = kelas;
      existing.sekolah = sekolah;
      if (avatar) existing.avatar = avatar;
      if (mission.status === 'playing' && existing.approvedForMission) {
        existing.activity = 'playing';
      } else {
        existing.activity = activity;
      }
      existing.connected = true;
      participantLastSeen.set(id, Date.now());
      return { participant: existing, isNew: wasOffline };
    }

    const idx = participants.size;
    const angle = idx * 0.85 - 1.2;
    const radius = 2.4 + (idx % 3) * 1.15;
    const reqPos = msg.pos as { x?: number; y?: number; z?: number } | undefined;
    const spawnPos =
      reqPos && Number.isFinite(reqPos.x) && Number.isFinite(reqPos.z)
        ? { x: Number(reqPos.x), y: 0.08, z: Number(reqPos.z) }
        : {
            x: Number((Math.sin(angle) * radius).toFixed(2)),
            y: 0.08,
            z: Number((4.6 + Math.cos(angle) * 1.6).toFixed(2)),
          };
    const canResumeApproved =
      mission.status === 'playing' &&
      Boolean(msg.wasApproved) &&
      typeof msg.resumeMissionStartedAt === 'number' &&
      msg.resumeMissionStartedAt === mission.startedAt;

    const created: ParticipantState = {
      id,
      nama,
      kelas,
      sekolah,
      avatar,
      score: 0,
      rank: idx + 1,
      level: 'sedang',
      streak: 0,
      maxStreak: 0,
      wrongStreak: 0,
      correctCount: 0,
      wrongCount: 0,
      activeBuff: 'none',
      progressValue: 0,
      progressLabel: 'Siap',
      pos: spawnPos,
      rotY: typeof msg.rotY === 'number' && Number.isFinite(msg.rotY) ? msg.rotY : Math.PI,
      activity: canResumeApproved ? 'playing' : activity,
      isReady: Boolean(msg.isReady),
      approvedForMission: canResumeApproved,
      connected: true,
      finishedReflection: false,
      answeredLog: [],
      joinedAt: Date.now(),
    };
    participants.set(id, created);
    participantLastSeen.set(id, Date.now());
    return { participant: created, isNew: true };
  };

  // Shared server-authoritative chat helper (used by both WS and HTTP fallback)
  const handleChatSendLogic = (
    msg: Record<string, unknown>,
    isTeacher: boolean,
    fallbackParticipantId?: string
  ): { ok: true; message: ChatMessage } | { ok: false; reason: string } => {
    const rawText = String(msg.text || '');

    if (isTeacher) {
      const cleaned = rawText.replace(/\s+/g, ' ').trim().slice(0, 260);
      if (!cleaned) return { ok: false, reason: 'Pesan tidak boleh kosong.' };
      const chatMsg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        senderId: 'teacher_admin',
        senderName: String(msg.senderName || 'Guru PAI').trim().slice(0, 40),
        senderRole: 'teacher',
        text: cleaned,
        createdAt: Date.now(),
        pinned: Boolean(msg.pin),
      };
      if (chatMsg.pinned) {
        chatMessages.forEach((m) => {
          m.pinned = false;
        });
      }
      chatMessages.push(chatMsg);
      if (chatMessages.length > 150) chatMessages.shift();
      return { ok: true, message: chatMsg };
    }

    const senderId = String(msg.senderId || fallbackParticipantId || '').trim();
    const p = participants.get(senderId);
    const resolvedId = p?.id || senderId;
    const resolvedName = p?.nama || String(msg.senderName || '').trim().slice(0, 40);
    const resolvedKelas = p?.kelas || (typeof msg.senderKelas === 'string' ? msg.senderKelas : undefined);

    if (!resolvedId || !resolvedName) {
      return {
        ok: false,
        reason: 'Silakan masuk sebagai peserta terlebih dahulu untuk mengirim pesan.',
      };
    }

    if (p) {
      p.connected = true;
      participantLastSeen.set(p.id, Date.now());
    }

    const check = validateStudentMessage(resolvedId, rawText);
    if (!check.ok) {
      return { ok: false, reason: check.reason };
    }

    const chatMsg: ChatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      senderId: resolvedId,
      senderName: resolvedName,
      senderRole: 'student',
      senderKelas: resolvedKelas,
      text: check.text,
      createdAt: Date.now(),
    };
    chatMessages.push(chatMsg);
    if (chatMessages.length > 150) chatMessages.shift();
    return { ok: true, message: chatMsg };
  };

  const validateStudentRoomCode = (
    msg: Record<string, unknown>
  ): { ok: true } | { ok: false; error: string } => {
    const id = typeof msg.id === 'string' ? msg.id.trim() : '';
    const isExistingParticipant = Boolean(id && participants.has(id));
    const entered = normalizeRoomCode(msg.roomCode);

    if (entered && entered === activeRoomCode) {
      return { ok: true };
    }
    if (isExistingParticipant && !entered) {
      return { ok: true };
    }
    return {
      ok: false,
      error: `Kode Ruang (Enter Code) tidak cocok! Minta kode yang sama persis dari Guru kamu.`,
    };
  };

  // === SERVER-SENT EVENTS (SSE) INSTANT REALTIME STREAM ===
  // Works reliably over standard HTTPS/HTTP2 proxies where WebSocket upgrades may drop
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    sseClients.add(res);
    // Send initial snapshot immediately upon subscribing
    res.write(`data: ${JSON.stringify({ type: 'room:snapshot', snapshot: getSnapshot() })}\n\n`);

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
        sseClients.delete(res);
      }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

  // Shared dispatcher for both WebSocket messages and HTTP /api/action mirror
  const executeRoomAction = (
    msg: Record<string, unknown>,
    opts: { isTeacher: boolean; senderWs?: WebSocket; fallbackParticipantId?: string }
  ): { ok: boolean; error?: string; payload?: Record<string, unknown> } => {
    const type = String(msg.type || '');
    const { isTeacher, senderWs, fallbackParticipantId } = opts;

    if (type === 'student:update_avatar') {
      const id = String(msg.id || fallbackParticipantId || '');
      const p = participants.get(id);
      if (p && msg.avatar) {
        p.avatar = msg.avatar as AvatarConfig;
        p.connected = true;
        participantLastSeen.set(id, Date.now());
        if (typeof msg.activity === 'string') {
          p.activity = msg.activity as ParticipantActivity;
        }
        broadcastSnapshot();
      }
      return { ok: true };
    }

    if (type === 'student:update_activity') {
      const id = String(msg.id || fallbackParticipantId || '');
      const p = participants.get(id);
      if (p && typeof msg.activity === 'string') {
        p.activity = msg.activity as ParticipantActivity;
        p.connected = true;
        participantLastSeen.set(id, Date.now());
        broadcastSnapshot();
      }
      return { ok: true };
    }

    if (type === 'student:set_ready') {
      const id = String(msg.id || fallbackParticipantId || '');
      const p = participants.get(id);
      if (p) {
        p.isReady = Boolean(msg.ready);
        p.connected = true;
        participantLastSeen.set(id, Date.now());
        broadcastSnapshot();
      }
      return { ok: true };
    }

    if (type === 'student:move') {
      const id = String(msg.id || fallbackParticipantId || '');
      const p = participants.get(id);
      const pos = msg.pos as { x: number; y: number; z: number } | undefined;
      const rotY =
        typeof msg.rotY === 'number' && Number.isFinite(msg.rotY) ? msg.rotY : p?.rotY ?? 0;
      if (p && pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
        p.pos = { x: pos.x, y: pos.y || 0.08, z: pos.z };
        p.rotY = rotY;
        p.connected = true;
        participantLastSeen.set(id, Date.now());
        broadcast({ type: 'player:moved', id, pos: p.pos, rotY: p.rotY }, senderWs);
      }
      return { ok: true };
    }

    if (type === 'student:sync_progress') {
      const id = String(msg.id || fallbackParticipantId || '');
      const p = participants.get(id);
      if (!p || !mission.active || !p.approvedForMission) return { ok: true };
      p.connected = true;
      participantLastSeen.set(id, Date.now());
      if (typeof msg.score === 'number') p.score = Math.max(0, Math.round(msg.score));
      if (typeof msg.level === 'string') p.level = msg.level as DifficultyLevel;
      if (typeof msg.streak === 'number') p.streak = msg.streak;
      if (typeof msg.maxStreak === 'number') p.maxStreak = Math.max(p.maxStreak, msg.maxStreak);
      if (typeof msg.wrongStreak === 'number') p.wrongStreak = msg.wrongStreak;
      if (typeof msg.correctCount === 'number') p.correctCount = msg.correctCount;
      if (typeof msg.wrongCount === 'number') p.wrongCount = msg.wrongCount;
      if (typeof msg.activeBuff === 'string') p.activeBuff = msg.activeBuff as BuffType;
      if (typeof msg.progressValue === 'number') p.progressValue = msg.progressValue;
      if (typeof msg.progressLabel === 'string') p.progressLabel = msg.progressLabel;
      if (msg.answerEntry && typeof msg.answerEntry === 'object') {
        p.answeredLog.push(msg.answerEntry as AnswerLogEntry);
      }
      broadcastSnapshot();
      return { ok: true };
    }

    if (type === 'student:attack_player') {
      const attackerId = String(msg.attackerId || fallbackParticipantId || '');
      const targetId = String(msg.targetId || '');
      const amount = Math.min(200, Math.max(50, Number(msg.amount) || 150));
      const attacker = participants.get(attackerId);
      const target = participants.get(targetId);
      if (
        attacker &&
        target &&
        attacker.id !== target.id &&
        mission.active &&
        attacker.approvedForMission
      ) {
        target.score = Math.max(0, target.score - amount);
        broadcast({
          type: 'buff:attacked',
          attackerName: attacker.nama,
          targetId: target.id,
          targetName: target.nama,
          amount,
          snapshot: getSnapshot(),
        });
      }
      return { ok: true };
    }

    if (type === 'student:submit_reflection') {
      const id = String(msg.id || fallbackParticipantId || '');
      const p = participants.get(id);
      const refleksi = String(msg.refleksi || '').trim().slice(0, 400);
      const komentar = String(msg.komentar || '').trim().slice(0, 300);
      const kritikSaran = String(msg.kritikSaran || '').trim().slice(0, 300);
      if (!refleksi) return { ok: false, error: 'Refleksi wajib diisi.' };

      const item: TestimonialItem = {
        id: `testi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        nama: p?.nama || String(msg.nama || 'Peserta'),
        kelas: p?.kelas || String(msg.kelas || '5'),
        sekolah: p?.sekolah || String(msg.sekolah || 'SDN Nusantara'),
        refleksi,
        komentar,
        kritikSaran,
        gameName: GAME_NAMES[mission.gameId] || mission.gameId,
        skor: p?.score ?? Number(msg.skor || 0),
        createdAt: Date.now(),
      };
      if (p) {
        p.finishedReflection = true;
        p.activity = 'schoolyard';
      }
      persisted.testimonials.push(item);
      saveDb(persisted);
      if (senderWs) sendJson(senderWs, { type: 'reflection:saved', item });
      broadcastSnapshot();
      return { ok: true, payload: { item } };
    }

    if (type === 'chat:typing') {
      const senderId = String(
        msg.senderId || fallbackParticipantId || (isTeacher ? 'teacher_admin' : '')
      );
      const senderName = String(msg.senderName || '').trim().slice(0, 40);
      const role = isTeacher || msg.role === 'teacher' ? 'teacher' : 'student';
      if (senderName) {
        broadcast({ type: 'chat:typing', senderId, senderName, role }, senderWs);
      }
      return { ok: true };
    }

    if (type === 'chat:delete') {
      if (!isTeacher) return { ok: false, error: 'Hanya Guru yang dapat menghapus pesan.' };
      const msgId = String(msg.messageId || '');
      const found = chatMessages.find((m) => m.id === msgId);
      if (found) {
        found.deleted = true;
        found.pinned = false;
        broadcastSnapshot();
      }
      return { ok: true };
    }

    if (type === 'chat:pin') {
      if (!isTeacher) return { ok: false, error: 'Hanya Guru yang dapat menyematkan pesan.' };
      const msgId = String(msg.messageId || '');
      const target = chatMessages.find((m) => m.id === msgId && !m.deleted);
      if (target) {
        const nextPinned = !target.pinned;
        chatMessages.forEach((m) => {
          m.pinned = false;
        });
        target.pinned = nextPinned;
        broadcastSnapshot();
      }
      return { ok: true };
    }

    if (type === 'chat:toggle_mute_all') {
      if (!isTeacher) return { ok: false, error: 'Hanya Guru yang dapat membisukan kelas.' };
      chatMutedAll = typeof msg.muted === 'boolean' ? msg.muted : !chatMutedAll;
      broadcastSnapshot();
      return { ok: true };
    }

    if (type === 'chat:toggle_mute_student') {
      if (!isTeacher) return { ok: false, error: 'Hanya Guru yang dapat membisukan siswa.' };
      const pid = String(msg.participantId || '');
      if (pid) {
        if (mutedParticipantIds.has(pid)) mutedParticipantIds.delete(pid);
        else mutedParticipantIds.add(pid);
        broadcastSnapshot();
      }
      return { ok: true };
    }

    if (type === 'teacher:set_room_code') {
      if (!isTeacher) return { ok: false, error: 'Akses Guru diperlukan.' };
      const nextCode = normalizeRoomCode(msg.roomCode);
      if (nextCode.length >= 3) {
        activeRoomCode = nextCode;
        broadcastSnapshot();
      }
      return { ok: true };
    }

    if (type === 'teacher:configure_mission') {
      if (!isTeacher) return { ok: false, error: 'Akses Guru diperlukan.' };
      if (Array.isArray(msg.elementIds) && msg.elementIds.length > 0) {
        mission.elementIds = msg.elementIds.map(String);
      }
      if (typeof msg.gameId === 'string' && msg.gameId in GAME_NAMES) {
        mission.gameId = msg.gameId as GameId;
      }
      if (typeof msg.questionDurationSec === 'number') {
        mission.questionDurationSec = Math.min(120, Math.max(10, Math.round(msg.questionDurationSec)));
      }
      if (typeof msg.gameDurationMin === 'number') {
        mission.gameDurationMin = Math.min(60, Math.max(1, Math.round(msg.gameDurationMin)));
      }
      broadcastSnapshot();
      return { ok: true };
    }

    if (type === 'teacher:start_mission') {
      if (!isTeacher) return { ok: false, error: 'Akses Guru diperlukan.' };
      if (missionEndTimer) {
        clearTimeout(missionEndTimer);
        missionEndTimer = null;
      }
      if (Array.isArray(msg.elementIds) && msg.elementIds.length > 0) {
        mission.elementIds = msg.elementIds.map(String);
      }
      if (typeof msg.gameId === 'string' && msg.gameId in GAME_NAMES) {
        mission.gameId = msg.gameId as GameId;
      }
      if (typeof msg.questionDurationSec === 'number') {
        mission.questionDurationSec = Math.min(120, Math.max(10, Math.round(msg.questionDurationSec)));
      }
      if (typeof msg.gameDurationMin === 'number') {
        mission.gameDurationMin = Math.min(60, Math.max(1, Math.round(msg.gameDurationMin)));
      }

      for (const p of participants.values()) {
        p.score = 0;
        p.level = 'sedang';
        p.streak = 0;
        p.maxStreak = 0;
        p.wrongStreak = 0;
        p.correctCount = 0;
        p.wrongCount = 0;
        p.activeBuff = 'none';
        p.progressValue = 0;
        p.progressLabel = 'Mulai';
        p.finishedReflection = false;
        p.answeredLog = [];
        p.approvedForMission = p.connected;
        if (p.connected) p.activity = 'playing';
      }

      const now = Date.now();
      mission.active = true;
      mission.status = 'playing';
      mission.startedAt = now;
      mission.endsAt = now + mission.gameDurationMin * 60_000;

      missionEndTimer = setTimeout(() => {
        stopMission('timeout');
      }, mission.gameDurationMin * 60_000);

      broadcast({ type: 'mission:started', snapshot: getSnapshot() });
      return { ok: true };
    }

    if (type === 'teacher:approve_student') {
      if (!isTeacher) return { ok: false, error: 'Akses Guru diperlukan.' };
      const pid = String(msg.participantId || '');
      const p = participants.get(pid);
      if (p) {
        p.approvedForMission = true;
        if (mission.status === 'playing') {
          p.activity = 'playing';
          broadcast({
            type: 'student:approved',
            participantId: pid,
            snapshot: getSnapshot(),
          });
        } else {
          broadcastSnapshot();
        }
      }
      return { ok: true };
    }

    if (type === 'teacher:approve_all_students') {
      if (!isTeacher) return { ok: false, error: 'Akses Guru diperlukan.' };
      const approvedIds: string[] = [];
      for (const p of participants.values()) {
        if (p.connected && !p.approvedForMission) {
          p.approvedForMission = true;
          if (mission.status === 'playing') p.activity = 'playing';
          approvedIds.push(p.id);
        }
      }
      if (mission.status === 'playing' && approvedIds.length > 0) {
        for (const pid of approvedIds) {
          broadcast({
            type: 'student:approved',
            participantId: pid,
            snapshot: getSnapshot(),
          });
        }
      } else {
        broadcastSnapshot();
      }
      return { ok: true };
    }

    if (type === 'teacher:stop_mission') {
      if (!isTeacher) return { ok: false, error: 'Akses Guru diperlukan.' };
      stopMission('teacher');
      return { ok: true };
    }

    if (type === 'teacher:return_lobby') {
      if (!isTeacher) return { ok: false, error: 'Akses Guru diperlukan.' };
      if (missionEndTimer) {
        clearTimeout(missionEndTimer);
        missionEndTimer = null;
      }
      mission.active = false;
      mission.status = 'lobby';
      mission.startedAt = null;
      mission.endsAt = null;
      for (const p of participants.values()) {
        p.approvedForMission = false;
        if (p.connected) p.activity = 'schoolyard';
      }
      broadcastSnapshot();
      return { ok: true };
    }

    if (type === 'teacher:add_element') {
      if (!isTeacher) return { ok: false, error: 'Akses Guru diperlukan.' };
      const el = msg.element as PaiElement | undefined;
      if (el && el.id && el.name && el.materialTitle) {
        persisted.customElements.push({ ...el, isCustom: true });
        saveDb(persisted);
        broadcastSnapshot();
      }
      return { ok: true };
    }

    if (type === 'teacher:add_question') {
      if (!isTeacher) return { ok: false, error: 'Akses Guru diperlukan.' };
      const q = msg.question as QuestionItem | undefined;
      if (q && q.id && q.elementId && q.prompt && Array.isArray(q.options)) {
        persisted.customQuestions.push(q);
        saveDb(persisted);
        broadcastSnapshot();
      }
      return { ok: true };
    }

    if (type === 'teacher:reset_room') {
      if (!isTeacher) return { ok: false, error: 'Akses Guru diperlukan.' };
      if (missionEndTimer) {
        clearTimeout(missionEndTimer);
        missionEndTimer = null;
      }
      mission.active = false;
      mission.status = 'lobby';
      mission.startedAt = null;
      mission.endsAt = null;
      for (const [pid, p] of participants.entries()) {
        if (!p.connected) {
          participants.delete(pid);
          participantLastSeen.delete(pid);
          mutedParticipantIds.delete(pid);
        } else {
          p.score = 0;
          p.streak = 0;
          p.correctCount = 0;
          p.wrongCount = 0;
          p.progressValue = 0;
          p.answeredLog = [];
          p.finishedReflection = false;
          p.approvedForMission = false;
          p.isReady = false;
          p.activity = 'schoolyard';
        }
      }
      broadcastSnapshot();
      return { ok: true };
    }

    return { ok: false, error: 'Aksi tidak dikenal.' };
  };

  // HTTP realtime login endpoint (instant registration + broadcasts to all WS & SSE clients)
  app.post('/api/student/join', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const codeCheck = validateStudentRoomCode(body);
    if (!codeCheck.ok) {
      res.status(403).json({ ok: false, error: codeCheck.error });
      return;
    }
    const { participant, isNew } = registerStudent(body);
    const snap = getSnapshot();
    if (isNew) {
      broadcast({ type: 'student:logged_in', participant, isNew: true, snapshot: snap });
    } else {
      broadcastSnapshot();
    }
    res.json({ ok: true, id: participant.id, snapshot: snap });
  });

  app.post('/api/student/heartbeat', (req, res) => {
    const id = String((req.body as Record<string, unknown>)?.id || '').trim();
    const p = participants.get(id);
    if (p) {
      const wasOffline = !p.connected;
      p.connected = true;
      participantLastSeen.set(id, Date.now());
      if (wasOffline) {
        broadcastSnapshot();
      }
    }
    res.json({ ok: true, serverTime: Date.now() });
  });

  app.post('/api/teacher/login', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = String(body.code || '').trim().toLowerCase();
    const sekolah = String(body.sekolah || '').trim();
    const reqRoom = normalizeRoomCode(body.roomCode);
    if (code === ADMIN_CODE && sekolah.length >= 2) {
      if (reqRoom.length >= 3) {
        activeRoomCode = reqRoom;
      }
      const snap = getSnapshot();
      broadcastSnapshot();
      res.json({ ok: true, sekolah, roomCode: activeRoomCode, snapshot: snap });
      return;
    }
    res.status(403).json({
      ok: false,
      error: 'Kode akun guru harus "gpaibeji" dan nama sekolah wajib diisi.',
    });
  });

  app.post('/api/student/leave', (req, res) => {
    const id = String((req.body as Record<string, unknown>)?.id || '');
    const p = participants.get(id);
    if (p) {
      p.connected = false;
      participantLastSeen.delete(id);
      broadcastSnapshot();
    }
    res.json({ ok: true });
  });

  app.post('/api/chat/send', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const isTeacher = body.role === 'teacher';
    const result = handleChatSendLogic(body, isTeacher);
    if (!result.ok) {
      res.status(400).json({ ok: false, reason: result.reason });
      return;
    }
    const snap = getSnapshot();
    broadcast({ type: 'chat:message', message: result.message, snapshot: snap });
    res.json({ ok: true, message: result.message, snapshot: snap });
  });

  // Unified HTTP action mirror so 100% of teacher & student actions work even if WS is blocked
  app.post('/api/action', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const adminCode = String(body.adminCode || '').trim().toLowerCase();
    const isTeacher = adminCode === ADMIN_CODE;
    const result = executeRoomAction(body, {
      isTeacher,
      fallbackParticipantId: typeof body.id === 'string' ? body.id : undefined,
    });
    if (!result.ok) {
      res.status(403).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, ...(result.payload ?? {}), snapshot: getSnapshot() });
  });

  app.get('/api/export-excel', (_req, res) => {
    const ranked = computeRanks();
    const activeGameName = GAME_NAMES[mission.gameId] || mission.gameId;

    const getPredikat = (total: number, acc: number): string => {
      if (total === 0) return 'Belum Mengerjakan';
      if (acc >= 85) return 'Sangat Baik (A)';
      if (acc >= 70) return 'Baik (B)';
      if (acc >= 55) return 'Cukup (C)';
      return 'Perlu Bimbingan (D)';
    };

    const activityLabels: Record<ParticipantActivity, string> = {
      avatar: 'Membuat Avatar',
      schoolyard: 'Halaman Sekolah',
      playing: 'Sedang Bermain',
      finished: 'Selesai Misi',
    };

    // Sheet 1: Rekap Nilai & Progres Peserta
    const pesertaRows = ranked.map((p) => {
      const total = p.correctCount + p.wrongCount;
      const accuracy = total > 0 ? Math.round((p.correctCount / total) * 100) : 0;
      const avgTime =
        p.answeredLog.length > 0
          ? Number(
              (
                p.answeredLog.reduce((sum, entry) => sum + entry.responseTimeSec, 0) /
                p.answeredLog.length
              ).toFixed(1)
            )
          : 0;
      return {
        Peringkat: p.rank,
        'Nama Peserta': p.nama,
        Kelas: p.kelas,
        'Asal Sekolah': p.sekolah,
        'Status Online': p.connected ? 'Online' : 'Offline',
        Aktivitas: activityLabels[p.activity] ?? p.activity,
        'Mini-Game': activeGameName,
        'Skor Akhir': p.score,
        'Nilai Konversi (0-100)': accuracy,
        'Predikat Capaian': getPredikat(total, accuracy),
        'Level AKM Akhir': p.level.toUpperCase(),
        'Jawaban Benar': p.correctCount,
        'Jawaban Salah': p.wrongCount,
        'Total Soal Dijawab': total,
        'Akurasi (%)': accuracy,
        'Streak Tertinggi': p.maxStreak,
        'Progres Minigame': `${p.progressValue} ${p.progressLabel}`,
        'Rata-rata Waktu Jawab (dtk)': avgTime,
        'Status Refleksi': p.finishedReflection ? 'Sudah Mengisi' : 'Belum',
      };
    });

    // Sheet 2: Penguasaan per Elemen PAI (for diagnostic performance assessment)
    const baseElements: Array<{ id: string; label: string }> = [
      { id: 'quran_hadis', label: "Al-Qur'an Hadis" },
      { id: 'akidah', label: 'Akidah' },
      { id: 'akhlak', label: 'Akhlak' },
      { id: 'fiqih', label: 'Fikih' },
      { id: 'spi', label: 'SPI' },
      ...persisted.customElements.map((el) => ({ id: el.id, label: el.shortName || el.name })),
    ];

    const elemenRows = ranked.map((p) => {
      const row: Record<string, string | number> = {
        Peringkat: p.rank,
        'Nama Peserta': p.nama,
        Kelas: p.kelas,
        'Asal Sekolah': p.sekolah,
        'Skor Akhir': p.score,
      };
      for (const el of baseElements) {
        const logs = p.answeredLog.filter((l) => l.elementId === el.id);
        if (logs.length === 0) {
          row[el.label] = '-';
        } else {
          const ok = logs.filter((l) => l.isCorrect).length;
          const pct = Math.round((ok / logs.length) * 100);
          row[el.label] = `${ok}/${logs.length} (${pct}%)`;
        }
      }
      return row;
    });

    // Sheet 3: Analisis Butir Soal AKM
    const questionStats = new Map<
      string,
      {
        questionId: string;
        elementId: string;
        difficulty: string;
        type: string;
        total: number;
        correct: number;
        wrong: number;
        totalTime: number;
      }
    >();

    for (const p of ranked) {
      for (const entry of p.answeredLog) {
        const cur = questionStats.get(entry.questionId) ?? {
          questionId: entry.questionId,
          elementId: entry.elementId,
          difficulty: entry.difficulty,
          type: entry.type,
          total: 0,
          correct: 0,
          wrong: 0,
          totalTime: 0,
        };
        cur.total += 1;
        if (entry.isCorrect) cur.correct += 1;
        else cur.wrong += 1;
        cur.totalTime += entry.responseTimeSec;
        questionStats.set(entry.questionId, cur);
      }
    }

    const soalRows = Array.from(questionStats.values()).map((s) => ({
      'ID Soal': s.questionId,
      Elemen: s.elementId,
      Kesukaran: s.difficulty.toUpperCase(),
      'Tipe AKM': s.type,
      'Total Dijawab': s.total,
      Benar: s.correct,
      Salah: s.wrong,
      'Tingkat Benar (%)': s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0,
      'Rata-rata Waktu (dtk)': s.total > 0 ? Number((s.totalTime / s.total).toFixed(1)) : 0,
    }));

    // Sheet 4: Refleksi & Testimoni Siswa
    const testimoniRows = persisted.testimonials.map((t) => ({
      Waktu: new Date(t.createdAt).toLocaleString('id-ID'),
      'Nama Peserta': t.nama,
      Kelas: t.kelas,
      Sekolah: t.sekolah,
      Minigame: t.gameName,
      Skor: t.skor,
      'Refleksi Belajar': t.refleksi,
      Komentar: t.komentar,
      'Kritik & Saran': t.kritikSaran,
    }));

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet(
      pesertaRows.length > 0 ? pesertaRows : [{ Info: 'Belum ada peserta terdaftar' }]
    );
    ws1['!cols'] = [
      { wch: 10 }, { wch: 22 }, { wch: 8 }, { wch: 20 }, { wch: 12 }, { wch: 16 },
      { wch: 22 }, { wch: 12 }, { wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 13 },
      { wch: 13 }, { wch: 16 }, { wch: 12 }, { wch: 15 }, { wch: 18 }, { wch: 22 }, { wch: 15 },
    ];

    const ws2 = XLSX.utils.json_to_sheet(
      elemenRows.length > 0 ? elemenRows : [{ Info: 'Belum ada data penguasaan elemen' }]
    );
    ws2['!cols'] = [
      { wch: 10 }, { wch: 22 }, { wch: 8 }, { wch: 20 }, { wch: 12 },
      ...baseElements.map(() => ({ wch: 18 })),
    ];

    const ws3 = XLSX.utils.json_to_sheet(
      soalRows.length > 0 ? soalRows : [{ Info: 'Belum ada data jawaban soal' }]
    );
    ws3['!cols'] = [
      { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 10 },
      { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 18 }, { wch: 20 },
    ];

    const ws4 = XLSX.utils.json_to_sheet(
      testimoniRows.length > 0 ? testimoniRows : [{ Info: 'Belum ada refleksi tersimpan' }]
    );
    ws4['!cols'] = [
      { wch: 20 }, { wch: 20 }, { wch: 8 }, { wch: 20 },
      { wch: 20 }, { wch: 10 }, { wch: 36 }, { wch: 30 }, { wch: 30 },
    ];

    XLSX.utils.book_append_sheet(wb, ws1, 'Rekap Nilai & Progres');
    XLSX.utils.book_append_sheet(wb, ws2, 'Penguasaan Elemen PAI');
    XLSX.utils.book_append_sheet(wb, ws3, 'Analisis Butir Soal');
    XLSX.utils.book_append_sheet(wb, ws4, 'Refleksi & Testimoni');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `Laporan_Penilaian_PAI_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  });

  const server = http.createServer(app);
  wss = new WebSocketServer({ server, path: '/ws' });

  // Keep WebSocket connections alive across cloud proxies
  const wsKeepAlive = setInterval(() => {
    if (!wss) return;
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }, 20_000);
  wss.on('close', () => clearInterval(wsKeepAlive));

  wss.on('connection', (ws) => {
    sendJson(ws, { type: 'room:snapshot', snapshot: getSnapshot() });

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = String(msg.type || '');

      if (type === 'ws:ping') {
        const pid = socketToParticipantId.get(ws);
        if (pid) {
          participantLastSeen.set(pid, Date.now());
          const p = participants.get(pid);
          if (p && !p.connected) {
            p.connected = true;
            broadcastSnapshot();
          }
        }
        sendJson(ws, { type: 'ws:pong', ts: Date.now() });
        return;
      }

      if (type === 'student:join') {
        const codeCheck = validateStudentRoomCode(msg);
        if (!codeCheck.ok) {
          sendJson(ws, { type: 'student:join_error', error: codeCheck.error });
          return;
        }
        const { participant, isNew } = registerStudent(msg);
        socketToParticipantId.set(ws, participant.id);
        const snap = getSnapshot();
        sendJson(ws, { type: 'student:joined', id: participant.id, snapshot: snap });
        if (isNew) {
          broadcast({ type: 'student:logged_in', participant, isNew: true, snapshot: snap }, ws);
        } else {
          broadcastSnapshot();
        }
        return;
      }

      if (type === 'student:leave') {
        const id = String(msg.id || socketToParticipantId.get(ws) || '');
        if (id) {
          const p = participants.get(id);
          if (p) {
            p.connected = false;
            participantLastSeen.delete(id);
            broadcastSnapshot();
          }
          socketToParticipantId.delete(ws);
        }
        return;
      }

      if (type === 'chat:send') {
        const isTeacher = teacherSockets.has(ws) || msg.role === 'teacher';
        const result = handleChatSendLogic(msg, isTeacher, socketToParticipantId.get(ws));
        if (!result.ok) {
          sendJson(ws, { type: 'chat:rejected', reason: result.reason });
          return;
        }
        broadcast({ type: 'chat:message', message: result.message, snapshot: getSnapshot() });
        return;
      }

      if (type === 'teacher:login') {
        const code = String(msg.code || '').trim().toLowerCase();
        const sekolah = String(msg.sekolah || '').trim();
        const reqRoom = normalizeRoomCode(msg.roomCode);
        if (code === ADMIN_CODE && sekolah.length >= 2) {
          teacherSockets.add(ws);
          if (reqRoom.length >= 3) {
            activeRoomCode = reqRoom;
          }
          const snap = getSnapshot();
          sendJson(ws, {
            type: 'teacher:auth',
            ok: true,
            sekolah,
            roomCode: activeRoomCode,
            snapshot: snap,
          });
          broadcastSnapshot();
        } else {
          sendJson(ws, {
            type: 'teacher:auth',
            ok: false,
            error: 'Kode akun guru harus "gpaibeji" dan nama sekolah wajib diisi.',
          });
        }
        return;
      }

      // Delegate all remaining student, chat moderation, and teacher actions to shared dispatcher
      executeRoomAction(msg, {
        isTeacher: teacherSockets.has(ws),
        senderWs: ws,
        fallbackParticipantId: socketToParticipantId.get(ws),
      });
    });

    ws.on('close', () => {
      teacherSockets.delete(ws);
      const id = socketToParticipantId.get(ws);
      if (id) {
        socketToParticipantId.delete(ws);
        // Grace period so transient WS reconnects or HTTP/SSE-only phones never flicker offline
        setTimeout(() => {
          if (isParticipantStillOnAnotherSocket(id, ws)) return;
          const lastSeen = participantLastSeen.get(id) ?? 0;
          if (Date.now() - lastSeen < 18_000) return;
          const p = participants.get(id);
          if (p && p.connected) {
            p.connected = false;
            broadcastSnapshot();
          }
        }, 12_000);
      }
    });
  });

  // Periodic stale presence sweep (marks silent HTTP-only students offline after 30s)
  const presenceSweep = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [pid, p] of participants.entries()) {
      if (!p.connected) continue;
      let hasActiveWs = false;
      for (const [sock, sid] of socketToParticipantId.entries()) {
        if (sid === pid && sock.readyState === WebSocket.OPEN) {
          hasActiveWs = true;
          break;
        }
      }
      if (hasActiveWs) {
        participantLastSeen.set(pid, now);
        continue;
      }
      const lastSeen = participantLastSeen.get(pid) ?? p.joinedAt;
      if (now - lastSeen > 30_000) {
        p.connected = false;
        changed = true;
      }
    }
    if (changed) {
      broadcastSnapshot();
    }
  }, 15_000);
  wss.on('close', () => clearInterval(presenceSweep));

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, HOST, () => {
    console.log(`PAI Nusantara 3D server listening on http://${HOST}:${PORT}`);
  });
}

void startServer();
