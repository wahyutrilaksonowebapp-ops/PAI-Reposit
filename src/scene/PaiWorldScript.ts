import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as xb from 'xrblocks';
import type {
  AvatarConfig,
  DifficultyLevel,
  GameId,
  PaiElement,
  ParticipantState,
  QuestionItem,
} from '../types.ts';
import { DEFAULT_AVATAR_MUSLIM } from '../constants.ts';
import { RobloxAvatar } from './RobloxAvatar.ts';
import {
  buildMinigameWorld,
  buildSchoolyardWorld,
  type BuiltWorld,
  type InteractiveHitMeta,
} from './WorldBuilders.ts';

export type SceneViewMode = 'title' | 'avatar_studio' | 'schoolyard' | 'minigame';

export interface WorldInteractionCallbacks {
  onClickKiosk?: (elementId: string) => void;
  onClickOption?: (optionIndex: number) => void;
  onClickPortal?: (difficulty: DifficultyLevel) => void;
  onClickDice?: () => void;
  onClickCraftTable?: () => void;
  onClickArtifact?: (index: number) => void;
  onPlayerMoveSync?: (pos: { x: number; y: number; z: number }) => void;
}

interface BurstParticle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

export class PaiWorldScript extends xb.Script {
  private pmremGenerator: THREE.PMREMGenerator | null = null;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;
  private isSoftwareGl = false;

  private activeWorld: BuiltWorld | null = null;
  private viewMode: SceneViewMode = 'title';
  private activeGameId: GameId = 'puncak_nalar';
  private cachedElements: PaiElement[] = [];

  private playerAvatar: RobloxAvatar | null = null;
  private playerConfig: AvatarConfig = { ...DEFAULT_AVATAR_MUSLIM };
  private playerName = 'Peserta';
  private playerSub = 'PAI 3D';
  private playerPos = new THREE.Vector3(0, 0.08, 4.8);
  private playerVelY = 0;
  private playerGrounded = true;
  private playerLane = 1; // 0..3 for Grand Prix
  private currentProgress = 0;
  private feedbackTimer = 0;
  private feedbackAnim: 'celebrate' | 'fall' | null = null;

  private peerAvatars = new Map<string, { avatar: RobloxAvatar; target: THREE.Vector3 }>();
  private particles: BurstParticle[] = [];
  private particleGeo = new THREE.BoxGeometry(0.18, 0.18, 0.18);

  private studioGroup = new THREE.Group();
  private studioTurnAngle = 0;

  private keys = new Set<string>();
  private joyVec = { x: 0, y: 0 };
  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  private camPos = new THREE.Vector3(0, 6, 12);
  private camLook = new THREE.Vector3(0, 2, 0);
  private shakeIntensity = 0;
  private clockElapsed = 0;
  private lastMoveSyncAt = 0;

  public callbacks: WorldInteractionCallbacks = {};

  private onKeyDownBound = (e: KeyboardEvent) => this.handleKeyDown(e);
  private onKeyUpBound = (e: KeyboardEvent) => this.handleKeyUp(e);
  private onPointerDownBound = (e: PointerEvent) => this.handlePointerDown(e);

  init(): void {
    const renderer = xb.core.renderer as THREE.WebGLRenderer;
    const scene = xb.core.scene;

    // Detect software WebGL to cap DPR/shadows smoothly without removing features
    const gl = renderer.getContext?.();
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    const rendererName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.isSoftwareGl = /SwiftShader|llvmpipe|Software|Mesa/i.test(rendererName);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.isSoftwareGl ? 1 : 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = !this.isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Studio IBL reflections via RoomEnvironment
    this.pmremGenerator = new THREE.PMREMGenerator(renderer);
    this.envRenderTarget = this.pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = this.envRenderTarget.texture;

    // Balanced daylight 3-point lighting
    const hemi = new THREE.HemisphereLight(0xdbeafe, 0x64748b, 1.35);
    this.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff4d6, 2.3);
    sun.position.set(16, 28, 14);
    if (!this.isSoftwareGl) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.near = 2;
      sun.shadow.camera.far = 90;
      const d = 26;
      sun.shadow.camera.left = -d;
      sun.shadow.camera.right = d;
      sun.shadow.camera.top = d;
      sun.shadow.camera.bottom = -d;
      sun.shadow.bias = -0.0005;
    }
    this.add(sun);

    const rim = new THREE.DirectionalLight(0x93c5fd, 0.7);
    rim.position.set(-14, 12, -16);
    this.add(rim);

    // Avatar Studio Turntable Stage
    const podium = new THREE.Mesh(
      new THREE.CylinderGeometry(1.45, 1.75, 0.4, 24),
      new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.3, metalness: 0.5 })
    );
    podium.position.set(0, -0.2, 0);
    this.studioGroup.add(podium);

    const glowRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.5, 0.06, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
    );
    glowRing.rotation.x = Math.PI / 2;
    glowRing.position.y = 0.02;
    this.studioGroup.add(glowRing);
    this.studioGroup.visible = false;
    this.add(this.studioGroup);

    // Player Avatar
    this.playerAvatar = new RobloxAvatar(this.playerConfig, this.playerName, this.playerSub);
    this.playerAvatar.group.position.copy(this.playerPos);
    this.add(this.playerAvatar.group);

    window.addEventListener('keydown', this.onKeyDownBound);
    window.addEventListener('keyup', this.onKeyUpBound);
    renderer.domElement.addEventListener('pointerdown', this.onPointerDownBound);

    // Start with welcoming sunlit Schoolyard backdrop on Login screen
    this.setViewMode('title');
  }

  setElements(elements: PaiElement[]): void {
    this.cachedElements = elements;
    if (this.viewMode === 'schoolyard' || this.viewMode === 'title') {
      this.rebuildSchoolyard();
    }
  }

  setPlayerIdentity(nama: string, kelas: string, avatar: AvatarConfig): void {
    this.playerName = nama;
    this.playerSub = `Kelas ${kelas}`;
    this.playerConfig = { ...avatar };
    if (this.playerAvatar) {
      this.playerAvatar.applyConfig(this.playerConfig);
      this.playerAvatar.setLabel(this.playerName, this.playerSub);
    }
  }

  updateAvatarPreview(avatar: AvatarConfig): void {
    this.playerConfig = { ...avatar };
    this.playerAvatar?.applyConfig(this.playerConfig);
  }

  rotateStudioAvatar(deltaRad: number): void {
    this.studioTurnAngle += deltaRad;
  }

  setJoystick(x: number, y: number): void {
    this.joyVec.x = x;
    this.joyVec.y = y;
  }

  triggerJump(): void {
    if (this.playerGrounded && (this.viewMode === 'schoolyard' || this.viewMode === 'minigame')) {
      this.playerVelY = 7.4;
      this.playerGrounded = false;
    }
  }

  setViewMode(mode: SceneViewMode, gameId?: GameId): void {
    this.viewMode = mode;
    if (gameId) this.activeGameId = gameId;

    this.studioGroup.visible = mode === 'avatar_studio';

    if (mode === 'avatar_studio') {
      this.clearWorld();
      xb.core.scene.fog = new THREE.Fog(0x0f172a, 16, 48);
      xb.core.scene.background = new THREE.Color(0x0f172a);
      if (this.playerAvatar) {
        this.playerAvatar.group.visible = true;
        this.playerAvatar.group.position.set(0, 0, 0);
        this.playerAvatar.animState = 'idle';
      }
      this.hidePeers(true);
      return;
    }

    if (mode === 'title' || mode === 'schoolyard') {
      this.rebuildSchoolyard();
      if (this.playerAvatar) {
        this.playerAvatar.group.visible = mode === 'schoolyard';
        this.playerPos.copy(this.activeWorld!.playerSpawn);
        this.playerAvatar.group.position.copy(this.playerPos);
      }
      this.hidePeers(mode === 'title');
      return;
    }

    if (mode === 'minigame') {
      this.clearWorld();
      this.activeWorld = buildMinigameWorld(this.activeGameId);
      this.add(this.activeWorld.root);
      xb.core.scene.fog = new THREE.Fog(
        this.activeWorld.fogColor,
        this.activeWorld.fogNear,
        this.activeWorld.fogFar
      );
      this.currentProgress = 0;
      this.playerLane = 1;
      this.playerPos.copy(this.activeWorld.playerSpawn);
      if (this.playerAvatar) {
        this.playerAvatar.group.visible = true;
        this.playerAvatar.group.position.copy(this.playerPos);
        this.playerAvatar.group.rotation.y = Math.PI;
      }
      this.hidePeers(false);
    }
  }

  private rebuildSchoolyard(): void {
    this.clearWorld();
    this.activeWorld = buildSchoolyardWorld(this.cachedElements);
    this.add(this.activeWorld.root);
    xb.core.scene.fog = new THREE.Fog(
      this.activeWorld.fogColor,
      this.activeWorld.fogNear,
      this.activeWorld.fogFar
    );
  }

  private clearWorld(): void {
    if (this.activeWorld) {
      this.remove(this.activeWorld.root);
      this.activeWorld.dispose();
      this.activeWorld = null;
    }
  }

  private hidePeers(hide: boolean): void {
    for (const entry of this.peerAvatars.values()) {
      entry.avatar.group.visible = !hide;
    }
  }

  syncPeers(participants: ParticipantState[], selfId: string | null): void {
    const seen = new Set<string>();
    participants.forEach((p, idx) => {
      if (p.id === selfId || !p.connected) return;
      seen.add(p.id);
      let entry = this.peerAvatars.get(p.id);
      if (!entry) {
        const av = new RobloxAvatar(p.avatar, p.nama, `${p.score} pts`);
        const initial = new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z);
        av.group.position.copy(initial);
        this.add(av.group);
        entry = { avatar: av, target: initial };
        this.peerAvatars.set(p.id, entry);
      } else {
        entry.avatar.setLabel(p.nama, `${p.score} pts`);
      }

      if (this.viewMode === 'schoolyard') {
        entry.target.set(p.pos.x, 0.08, p.pos.z);
        entry.avatar.group.visible = true;
      } else if (this.viewMode === 'minigame') {
        // Show classmates sharing the minigame progression!
        const offsetX = ((idx % 4) - 1.5) * 1.65;
        if (this.activeWorld?.getPlayerTargetPos) {
          const base = this.activeWorld.getPlayerTargetPos(p.progressValue, idx % 4);
          entry.target.set(base.x + offsetX, base.y, base.z + 0.9);
        } else {
          entry.target.set(offsetX * 1.4, 0, 2.8);
        }
        entry.avatar.group.visible = true;
      } else {
        entry.avatar.group.visible = false;
      }
    });

    for (const [id, entry] of this.peerAvatars.entries()) {
      if (!seen.has(id)) {
        this.remove(entry.avatar.group);
        entry.avatar.dispose();
        this.peerAvatars.delete(id);
      }
    }
  }

  updatePeerPosition(id: string, pos: { x: number; y: number; z: number }): void {
    const entry = this.peerAvatars.get(id);
    if (entry && this.viewMode === 'schoolyard') {
      entry.target.set(pos.x, 0.08, pos.z);
    }
  }

  setQuestionVisuals(q: QuestionItem | null, selectedIndices: number[]): void {
    this.activeWorld?.updateQuestionVisuals?.(q, selectedIndices);
  }

  setProgressAndFeedback(
    progress: number,
    isCorrect: boolean,
    chosenIndex?: number
  ): void {
    this.currentProgress = progress;
    if (typeof chosenIndex === 'number' && this.activeGameId === 'grand_prix') {
      this.playerLane = Math.max(0, Math.min(3, chosenIndex));
    }
    this.activeWorld?.triggerFeedback?.(isCorrect, chosenIndex);
    this.feedbackAnim = isCorrect ? 'celebrate' : 'fall';
    this.feedbackTimer = 1.25;
    this.shakeIntensity = isCorrect ? 0.12 : 0.28;
    this.spawnParticles(
      this.playerPos.clone().add(new THREE.Vector3(0, 1.5, 0)),
      isCorrect ? 0x22c55e : 0xef4444,
      isCorrect ? 22 : 14
    );
  }

  setActivePortal(diff: DifficultyLevel): void {
    this.activeWorld?.setActivePortal?.(diff);
    this.spawnParticles(
      this.playerPos.clone().add(new THREE.Vector3(0, 1.4, -2)),
      diff === 'mudah' ? 0x22c55e : diff === 'sedang' ? 0x3b82f6 : 0xfacc15,
      18
    );
  }

  rollDiceVisual(result: number): void {
    this.activeWorld?.rollDiceVisual?.(result);
    this.spawnParticles(new THREE.Vector3(0, 4.4, -1.2), 0xfacc15, 16);
  }

  private spawnParticles(origin: THREE.Vector3, hex: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(
        this.particleGeo,
        new THREE.MeshBasicMaterial({ color: hex })
      );
      mesh.position.copy(origin);
      this.add(mesh);
      this.particles.push({
        mesh,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 6.5,
          2.2 + Math.random() * 4.5,
          (Math.random() - 0.5) * 6.5
        ),
        life: 0.75 + Math.random() * 0.45,
      });
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const key = e.key.toLowerCase();
    this.keys.add(key);

    if (key === ' ') {
      this.triggerJump();
    }
    if (this.viewMode === 'minigame' && this.activeGameId === 'grand_prix') {
      if (key === 'a' || key === 'arrowleft') {
        this.playerLane = Math.max(0, this.playerLane - 1);
      } else if (key === 'd' || key === 'arrowright') {
        this.playerLane = Math.min(3, this.playerLane + 1);
      }
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.key.toLowerCase());
  }

  private handlePointerDown(e: PointerEvent): void {
    if (!this.activeWorld || this.viewMode === 'title' || this.viewMode === 'avatar_studio') {
      return;
    }
    const dom = (xb.core.renderer as THREE.WebGLRenderer).domElement;
    if (!dom) return;
    const rect = dom.getBoundingClientRect();
    this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointerNdc, xb.core.camera);
    const hits = this.raycaster.intersectObjects(this.activeWorld.interactables, true);
    if (hits.length === 0) return;

    const meta = hits[0].object.userData?.interact as InteractiveHitMeta | undefined;
    if (!meta) return;

    if (meta.kind === 'material_kiosk' && meta.elementId) {
      this.callbacks.onClickKiosk?.(meta.elementId);
    } else if (meta.kind === 'answer_option' && typeof meta.optionIndex === 'number') {
      this.callbacks.onClickOption?.(meta.optionIndex);
    } else if (meta.kind === 'portal' && meta.difficulty) {
      this.callbacks.onClickPortal?.(meta.difficulty);
    } else if (meta.kind === 'dice') {
      this.callbacks.onClickDice?.();
    } else if (meta.kind === 'craft_table') {
      this.callbacks.onClickCraftTable?.();
    } else if (meta.kind === 'artifact_capsule' && typeof meta.optionIndex === 'number') {
      this.callbacks.onClickArtifact?.(meta.optionIndex);
    }
  }

  update(): void {
    const dt = Math.min(0.05, xb.getDeltaTime() || 0.016);
    this.clockElapsed += dt;

    // Update particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.vel.y -= 9.8 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += dt * 5;
      p.mesh.scale.setScalar(Math.max(0.01, p.life));
      if (p.life <= 0) {
        this.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
      }
    }

    // Update active world
    this.activeWorld?.updateWorld(dt, this.clockElapsed, this.currentProgress);

    // Update peers smoothly
    for (const entry of this.peerAvatars.values()) {
      const dist = entry.avatar.group.position.distanceTo(entry.target);
      if (dist > 0.06) {
        entry.avatar.group.position.lerp(entry.target, Math.min(1, dt * 6));
        entry.avatar.animState = 'walk';
      } else {
        entry.avatar.animState = 'idle';
      }
      entry.avatar.update(dt);
    }

    const cam = xb.core.camera;

    // Camera & Player modes
    if (this.viewMode === 'title') {
      // Sweeping sunlit panorama of the Indonesian Schoolyard & waving Merah-Putih flag
      const angle = Math.sin(this.clockElapsed * 0.22) * 0.55;
      cam.position.set(Math.sin(angle) * 14, 5.4, Math.cos(angle) * 12 + 2.5);
      cam.lookAt(0, 3.6, -4.5);
      return;
    }

    if (this.viewMode === 'avatar_studio') {
      this.studioTurnAngle += dt * 0.35;
      if (this.playerAvatar) {
        this.playerAvatar.group.rotation.y = this.studioTurnAngle;
        this.playerAvatar.animState = 'idle';
        this.playerAvatar.update(dt);
      }
      cam.position.set(0, 1.45, 3.85);
      cam.lookAt(0, 1.15, 0);
      return;
    }

    if (this.viewMode === 'schoolyard') {
      let mx = this.joyVec.x;
      let mz = this.joyVec.y;
      if (this.keys.has('w') || this.keys.has('arrowup')) mz -= 1;
      if (this.keys.has('s') || this.keys.has('arrowdown')) mz += 1;
      if (this.keys.has('a') || this.keys.has('arrowleft')) mx -= 1;
      if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;

      const moving = Math.hypot(mx, mz) > 0.1;
      if (moving) {
        const len = Math.hypot(mx, mz);
        const speed = 6.2;
        this.playerPos.x = THREE.MathUtils.clamp(this.playerPos.x + (mx / len) * speed * dt, -11.2, 11.2);
        this.playerPos.z = THREE.MathUtils.clamp(this.playerPos.z + (mz / len) * speed * dt, -5.8, 9.6);
        if (this.playerAvatar) {
          this.playerAvatar.group.rotation.y = Math.atan2(mx, mz);
        }
        if (performance.now() - this.lastMoveSyncAt > 180) {
          this.lastMoveSyncAt = performance.now();
          this.callbacks.onPlayerMoveSync?.({
            x: Number(this.playerPos.x.toFixed(2)),
            y: Number(this.playerPos.y.toFixed(2)),
            z: Number(this.playerPos.z.toFixed(2)),
          });
        }
      }

      // Gravity & jump
      if (!this.playerGrounded) {
        this.playerVelY -= 19 * dt;
        this.playerPos.y += this.playerVelY * dt;
        if (this.playerPos.y <= 0.08) {
          this.playerPos.y = 0.08;
          this.playerVelY = 0;
          this.playerGrounded = true;
        }
      }

      if (this.playerAvatar) {
        this.playerAvatar.group.position.copy(this.playerPos);
        this.playerAvatar.animState = !this.playerGrounded
          ? 'jump'
          : moving
            ? 'walk'
            : 'idle';
        this.playerAvatar.update(dt);
      }

      const desiredCam = this.playerPos.clone().add(this.activeWorld!.cameraOffset);
      const desiredLook = this.playerPos.clone().add(this.activeWorld!.cameraLookOffset);
      this.camPos.lerp(desiredCam, Math.min(1, dt * 6));
      this.camLook.lerp(desiredLook, Math.min(1, dt * 8));
      cam.position.copy(this.camPos);
      cam.lookAt(this.camLook);
      return;
    }

    // === ACTIVE MINIGAME UPDATE ===
    if (this.viewMode === 'minigame' && this.activeWorld) {
      if (this.feedbackTimer > 0) {
        this.feedbackTimer = Math.max(0, this.feedbackTimer - dt);
        if (this.feedbackTimer === 0) this.feedbackAnim = null;
      }

      if (this.activeWorld.getPlayerTargetPos) {
        const target = this.activeWorld.getPlayerTargetPos(this.currentProgress, this.playerLane);
        this.playerPos.lerp(target, Math.min(1, dt * 6.5));
      } else {
        // Free-roam inside Edu-Craft / Maze / Portal / Astro
        let mx = this.joyVec.x;
        let mz = this.joyVec.y;
        if (this.keys.has('w') || this.keys.has('arrowup')) mz -= 1;
        if (this.keys.has('s') || this.keys.has('arrowdown')) mz += 1;
        if (this.keys.has('a') || this.keys.has('arrowleft')) mx -= 1;
        if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;
        if (Math.hypot(mx, mz) > 0.1) {
          const len = Math.hypot(mx, mz);
          this.playerPos.x = THREE.MathUtils.clamp(this.playerPos.x + (mx / len) * 5.2 * dt, -6.8, 6.8);
          this.playerPos.z = THREE.MathUtils.clamp(this.playerPos.z + (mz / len) * 5.2 * dt, -5.2, 5.2);
          if (this.playerAvatar) {
            this.playerAvatar.group.rotation.y = Math.atan2(mx, mz);
          }
        }
      }

      if (this.playerAvatar) {
        this.playerAvatar.group.position.copy(this.playerPos);
        if (this.feedbackAnim) {
          this.playerAvatar.animState = this.feedbackAnim;
        } else if (this.activeGameId === 'grand_prix') {
          this.playerAvatar.animState = 'drive';
          this.playerAvatar.group.rotation.y = Math.PI;
        } else if (this.activeGameId === 'astro_scanner') {
          this.playerAvatar.animState = 'fly';
          this.playerAvatar.group.rotation.y = Math.PI;
        } else {
          this.playerAvatar.animState = 'idle';
        }
        this.playerAvatar.update(dt);
      }

      const desiredCam = this.playerPos.clone().add(this.activeWorld.cameraOffset);
      const desiredLook = this.playerPos.clone().add(this.activeWorld.cameraLookOffset);
      this.camPos.lerp(desiredCam, Math.min(1, dt * 5.5));
      this.camLook.lerp(desiredLook, Math.min(1, dt * 7));

      // Micro screen-shake on answer impact
      if (this.shakeIntensity > 0.005) {
        this.shakeIntensity *= 0.88;
        cam.position.set(
          this.camPos.x + (Math.random() - 0.5) * this.shakeIntensity,
          this.camPos.y + (Math.random() - 0.5) * this.shakeIntensity,
          this.camPos.z
        );
      } else {
        cam.position.copy(this.camPos);
      }
      cam.lookAt(this.camLook);
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDownBound);
    window.removeEventListener('keyup', this.onKeyUpBound);
    xb.core.renderer?.domElement?.removeEventListener('pointerdown', this.onPointerDownBound);
    this.clearWorld();
    this.playerAvatar?.dispose();
    for (const entry of this.peerAvatars.values()) {
      entry.avatar.dispose();
    }
    this.peerAvatars.clear();
    this.particleGeo.dispose();
    this.envRenderTarget?.dispose();
    this.pmremGenerator?.dispose();
  }
}
