import * as xb from 'xrblocks';
import { PaiWorldScript } from './scene/PaiWorldScript.ts';
import { realtimeClient } from './services/RealtimeClient.ts';
import { StudentUI } from './ui/StudentUI.ts';
import { TeacherUI } from './ui/TeacherUI.ts';
import { paiBank } from './data/paiBank.ts';
import { clearSession, loadSession } from './services/SessionStorage.ts';

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(msg: string): void {
  let el = document.getElementById('pai-toast-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pai-toast-banner';
    el.className = 'toast-banner';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (el) el.style.display = 'none';
  }, 3600);
}

async function bootstrap(): Promise<void> {
  const worldScript = new PaiWorldScript();

  const options = new xb.Options();
  options.setAppTitle('PAI Nusantara 3D');
  options.setAppDescription('Edu-Game & Kuis AKM Interaktif PAI SD');
  options.xrButton.enabled = false;
  options.enableSimulator = false;
  options.reticles.enabled = false;
  options.controllers.visualizeRays = false;

  xb.add(worldScript);
  await xb.init(options);

  const appRoot = document.getElementById('app-root') ?? document.body;
  let activeRole: 'student' | 'teacher' = 'student';

  const toggleXR = () => {
    try {
      const xrMgr = (xb.core as unknown as { webXRSessionManager?: { startSession?: () => Promise<void> } }).webXRSessionManager;
      if (xrMgr?.startSession) {
        void xrMgr.startSession().catch(() => {
          showToast('Perangkat ini berjalan dalam mode pratinjau 3D Desktop/Mobile.');
        });
      } else {
        showToast('Mode XR siap digunakan pada perangkat Android XR (Galaxy XR / XREAL AURA).');
      }
    } catch {
      showToast('Mode pratinjau 3D aktif di browser ini.');
    }
  };

  let studentUI!: StudentUI;
  let teacherUI!: TeacherUI;

  teacherUI = new TeacherUI(
    appRoot,
    () => {
      activeRole = 'student';
      teacherUI.unmount(true);
      clearSession();
      studentUI.mount(realtimeClient.snapshot);
    },
    showToast
  );

  studentUI = new StudentUI(
    appRoot,
    worldScript,
    (sekolah, snap) => {
      activeRole = 'teacher';
      studentUI.unmount();
      teacherUI.mount(sekolah, snap);
    },
    toggleXR,
    showToast
  );

  // Realtime event routing
  realtimeClient.on('snapshot', (snap) => {
    paiBank.setCustomContent(snap.customElements, snap.customQuestions);
    if (activeRole === 'teacher') {
      teacherUI.applySnapshot(snap);
    } else {
      studentUI.handleSnapshot(snap);
    }
  });

  realtimeClient.on('joined', ({ id, snapshot }) => {
    if (activeRole === 'student') {
      studentUI.handleJoined(id, snapshot);
    }
  });

  realtimeClient.on('teacherAuth', (res) => {
    if (res.ok && res.sekolah) {
      if (activeRole === 'teacher') {
        if (res.snapshot) teacherUI.applySnapshot(res.snapshot);
        return;
      }
      activeRole = 'teacher';
      studentUI.unmount();
      teacherUI.mount(res.sekolah, res.snapshot ?? realtimeClient.snapshot);
      showToast('Berhasil masuk sebagai Guru Admin PAI.');
    } else if (res.error) {
      showToast(res.error);
    }
  });

  realtimeClient.on('missionStarted', (snap) => {
    if (activeRole === 'student') {
      studentUI.handleMissionStarted(snap);
    } else {
      teacherUI.applySnapshot(snap);
    }
  });

  realtimeClient.on('missionEnded', ({ snapshot }) => {
    if (activeRole === 'student') {
      studentUI.handleMissionEnded(snapshot);
    } else {
      teacherUI.applySnapshot(snapshot);
    }
  });

  realtimeClient.on('studentApproved', ({ participantId, snapshot }) => {
    if (activeRole === 'student') {
      studentUI.handleStudentApproved(participantId, snapshot);
    } else {
      teacherUI.applySnapshot(snapshot);
    }
  });

  realtimeClient.on('playerMoved', ({ id, pos, rotY }) => {
    worldScript.updatePeerPosition(id, pos, rotY);
  });

  realtimeClient.on('chatMessage', ({ message, snapshot }) => {
    if (activeRole === 'student') {
      studentUI.handleChatMessage(message, snapshot);
    } else {
      teacherUI.handleChatMessage(message, snapshot);
    }
  });

  realtimeClient.on('chatRejected', (reason) => {
    if (activeRole === 'student') {
      studentUI.handleChatRejected(reason);
    } else {
      showToast(reason);
    }
  });

  realtimeClient.on('buffAttacked', (payload) => {
    if (activeRole === 'student') {
      studentUI.handleBuffAttacked(payload);
    }
  });

  // Initial state, reload session restoration & live WebSocket connection
  const initial = await realtimeClient.fetchInitialState();
  const saved = loadSession();

  if (saved?.role === 'teacher') {
    activeRole = 'teacher';
    teacherUI.mount(saved.sekolah, initial, saved.activeTab, saved.code);
    realtimeClient.loginTeacher(saved.code, saved.sekolah);
    showToast('Dashboard Guru dilanjutkan otomatis.');
  } else if (saved?.role === 'student') {
    activeRole = 'student';
    studentUI.restoreSession(saved, initial);
  } else {
    activeRole = 'student';
    studentUI.mount(initial);
  }

  realtimeClient.connect();
}

document.addEventListener('DOMContentLoaded', () => {
  void bootstrap();
});
