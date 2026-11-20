import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import * as XLSX from 'xlsx';
import type {
  AvatarConfig,
  GameId,
  MissionConfig,
  PaiElement,
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

const participants = new Map<string, ParticipantState>();
const socketToParticipantId = new Map<WebSocket, string>();
let missionEndTimer: ReturnType<typeof setTimeout> | null = null;

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
    mission: { ...mission },
    participants: computeRanks(),
    testimonials: persisted.testimonials.slice(-60),
    customElements: persisted.customElements,
    customQuestions: persisted.customQuestions,
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
  if (!wss) return;
  const serialized = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

function broadcastSnapshot(): void {
  broadcast({ type: 'room:snapshot', snapshot: getSnapshot() });
}

function stopMission(reason: 'teacher' | 'timeout'): void {
  if (missionEndTimer) {
    clearTimeout(missionEndTimer);
    missionEndTimer = null;
  }
  mission.active = false;
  mission.status = 'finished';
  mission.endsAt = Date.now();
  broadcast({ type: 'mission:ended', reason, snapshot: getSnapshot() });
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/state', (_req, res) => {
    res.json(getSnapshot());
  });

  app.get('/api/export-excel', (_req, res) => {
    const ranked = computeRanks();

    // Sheet 1: Rekap Peserta
    const pesertaRows = ranked.map((p) => {
      const total = p.correctCount + p.wrongCount;
      const accuracy = total > 0 ? Math.round((p.correctCount / total) * 100) : 0;
      return {
        Peringkat: p.rank,
        'Nama Peserta': p.nama,
        Kelas: p.kelas,
        'Asal Sekolah': p.sekolah,
        'Skor Akhir': p.score,
        'Level Akhir': p.level.toUpperCase(),
        'Jawaban Benar': p.correctCount,
        'Jawaban Salah': p.wrongCount,
        'Akurasi (%)': accuracy,
        'Streak Tertinggi': p.maxStreak,
        'Progres Minigame': `${p.progressValue} ${p.progressLabel}`,
        'Status Refleksi': p.finishedReflection ? 'Sudah Mengisi' : 'Belum',
      };
    });

    // Sheet 2: Analisis Butir Soal
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

    // Sheet 3: Refleksi & Testimoni
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
    const ws2 = XLSX.utils.json_to_sheet(
      soalRows.length > 0 ? soalRows : [{ Info: 'Belum ada data jawaban soal' }]
    );
    const ws3 = XLSX.utils.json_to_sheet(
      testimoniRows.length > 0 ? testimoniRows : [{ Info: 'Belum ada refleksi tersimpan' }]
    );

    XLSX.utils.book_append_sheet(wb, ws1, 'Rekap Peserta');
    XLSX.utils.book_append_sheet(wb, ws2, 'Analisis Butir Soal');
    XLSX.utils.book_append_sheet(wb, ws3, 'Refleksi & Testimoni');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `Laporan_PAI_Nusantara_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  });

  const server = http.createServer(app);
  wss = new WebSocketServer({ server, path: '/ws' });

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

      if (type === 'student:join') {
        const id =
          typeof msg.id === 'string' && msg.id.trim()
            ? msg.id.trim()
            : `stu_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const nama = String(msg.nama || 'Peserta').trim().slice(0, 40);
        const kelas = String(msg.kelas || '5').trim().slice(0, 16);
        const sekolah = String(msg.sekolah || 'SDN Nusantara').trim().slice(0, 60);
        const avatar = msg.avatar as AvatarConfig;

        const existing = participants.get(id);
        if (existing) {
          existing.nama = nama;
          existing.kelas = kelas;
          existing.sekolah = sekolah;
          if (avatar) existing.avatar = avatar;
          existing.connected = true;
        } else {
          const angle = participants.size * 1.15;
          const radius = 2.6 + (participants.size % 3) * 1.1;
          participants.set(id, {
            id,
            nama,
            kelas,
            sekolah,
            avatar,
            score: 0,
            rank: participants.size + 1,
            level: 'sedang',
            streak: 0,
            maxStreak: 0,
            wrongStreak: 0,
            correctCount: 0,
            wrongCount: 0,
            activeBuff: 'none',
            progressValue: 0,
            progressLabel: 'Siap',
            pos: {
              x: Number((Math.cos(angle) * radius).toFixed(2)),
              y: 0,
              z: Number((Math.sin(angle) * radius + 2.5).toFixed(2)),
            },
            connected: true,
            finishedReflection: false,
            answeredLog: [],
            joinedAt: Date.now(),
          });
        }
        socketToParticipantId.set(ws, id);
        sendJson(ws, { type: 'student:joined', id, snapshot: getSnapshot() });
        broadcastSnapshot();
        return;
      }

      if (type === 'student:update_avatar') {
        const id = String(msg.id || socketToParticipantId.get(ws) || '');
        const p = participants.get(id);
        if (p && msg.avatar) {
          p.avatar = msg.avatar as AvatarConfig;
          broadcastSnapshot();
        }
        return;
      }

      if (type === 'student:move') {
        const id = String(msg.id || socketToParticipantId.get(ws) || '');
        const p = participants.get(id);
        const pos = msg.pos as { x: number; y: number; z: number } | undefined;
        if (p && pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
          p.pos = { x: pos.x, y: pos.y || 0, z: pos.z };
          broadcast({ type: 'player:moved', id, pos: p.pos }, ws);
        }
        return;
      }

      if (type === 'student:sync_progress') {
        const id = String(msg.id || socketToParticipantId.get(ws) || '');
        const p = participants.get(id);
        if (!p) return;
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
        return;
      }

      if (type === 'student:attack_player') {
        const attackerId = String(msg.attackerId || socketToParticipantId.get(ws) || '');
        const targetId = String(msg.targetId || '');
        const amount = Math.min(200, Math.max(50, Number(msg.amount) || 150));
        const attacker = participants.get(attackerId);
        const target = participants.get(targetId);
        if (attacker && target && attacker.id !== target.id) {
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
        return;
      }

      if (type === 'student:submit_reflection') {
        const id = String(msg.id || socketToParticipantId.get(ws) || '');
        const p = participants.get(id);
        const refleksi = String(msg.refleksi || '').trim().slice(0, 400);
        const komentar = String(msg.komentar || '').trim().slice(0, 300);
        const kritikSaran = String(msg.kritikSaran || '').trim().slice(0, 300);
        if (!refleksi) return;

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
        if (p) p.finishedReflection = true;
        persisted.testimonials.push(item);
        saveDb(persisted);
        sendJson(ws, { type: 'reflection:saved', item });
        broadcastSnapshot();
        return;
      }

      if (type === 'teacher:login') {
        const code = String(msg.code || '').trim().toLowerCase();
        const sekolah = String(msg.sekolah || '').trim();
        if (code === ADMIN_CODE && sekolah.length >= 2) {
          sendJson(ws, { type: 'teacher:auth', ok: true, sekolah, snapshot: getSnapshot() });
        } else {
          sendJson(ws, {
            type: 'teacher:auth',
            ok: false,
            error: 'Kode akun guru harus "gpaibeji" dan nama sekolah wajib diisi.',
          });
        }
        return;
      }

      if (type === 'teacher:configure_mission') {
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
        return;
      }

      if (type === 'teacher:start_mission') {
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
        return;
      }

      if (type === 'teacher:stop_mission') {
        stopMission('teacher');
        return;
      }

      if (type === 'teacher:return_lobby') {
        if (missionEndTimer) {
          clearTimeout(missionEndTimer);
          missionEndTimer = null;
        }
        mission.active = false;
        mission.status = 'lobby';
        mission.startedAt = null;
        mission.endsAt = null;
        broadcastSnapshot();
        return;
      }

      if (type === 'teacher:add_element') {
        const el = msg.element as PaiElement | undefined;
        if (el && el.id && el.name && el.materialTitle) {
          persisted.customElements.push({ ...el, isCustom: true });
          saveDb(persisted);
          broadcastSnapshot();
        }
        return;
      }

      if (type === 'teacher:add_question') {
        const q = msg.question as QuestionItem | undefined;
        if (q && q.id && q.elementId && q.prompt && Array.isArray(q.options)) {
          persisted.customQuestions.push(q);
          saveDb(persisted);
          broadcastSnapshot();
        }
        return;
      }

      if (type === 'teacher:reset_room') {
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
          } else {
            p.score = 0;
            p.streak = 0;
            p.correctCount = 0;
            p.wrongCount = 0;
            p.progressValue = 0;
            p.answeredLog = [];
            p.finishedReflection = false;
          }
        }
        broadcastSnapshot();
      }
    });

    ws.on('close', () => {
      const id = socketToParticipantId.get(ws);
      if (id) {
        socketToParticipantId.delete(ws);
        const p = participants.get(id);
        if (p) {
          p.connected = false;
          broadcastSnapshot();
        }
      }
    });
  });

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
