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

export interface ViewportMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface WorldInteractionCallbacks {
  onClickKiosk?: (elementId: string) => void;
  onClickOption?: (optionIndex: number) => void;
  onClickPortal?: (difficulty: DifficultyLevel) => void;
  onClickDice?: () => void;
  onClickCraftTable?: () => void;
  onClickArtifact?: (index: number) => void;
  onPlayerMoveSync?: (pos: { x: number; y: number; z: number }, rotY: number) => void;
  onQuickSelectOption?: (optionIndex: number) => void;
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

  private peerAvatars = new Map<
    string,
    { avatar: RobloxAvatar; target: THREE.Vector3; targetRotY: number; avatarSig: string }
  >();
  private particles: BurstParticle[] = [];
  private particleGeo = new THREE.BoxGeometry(0.18, 0.18, 0.18);

  private studioGroup = new THREE.Group();
  private studioTurnAngle = 0;

  private keys = new Set<string>();
  private joyVec = { x: 0, y: 0 };
  private walkTarget: THREE.Vector3 | null = null;
  private walkMarker: THREE.Mesh | null = null;
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.08);
  private minigameOffset = new THREE.Vector3(0, 0, 0);
  private lastJoyLaneAt = 0;
  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  private camPos = new THREE.Vector3(0, 6, 12);
  private camLook = new THREE.Vector3(0, 2, 0);
  private shakeIntensity = 0;
  private clockElapsed = 0;
  private lastMoveSyncAt = 0;
  private viewportMargins: ViewportMargins = { left: 0, right: 0, top: 0, bottom: 0 };

  public callbacks: WorldInteractionCallbacks = {};

  private onKeyDownBound = (e: KeyboardEvent) => this.handleKeyDown(e);
  private onKeyUpBound = (e: KeyboardEvent) => this.handleKeyUp(e);
  private onWindowBlurBound = () => {
    this.keys.clear();
    this.joyVec.x = 0;
    this.joyVec.y = 0;
  };
  private onPointerDownBound = (e: PointerEvent) => this.handlePointerDown(e);
  private onResizeBound = () => this.applyCameraViewportOffset();

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

    // Tap-to-walk target ring indicator on Schoolyard floor
    this.walkMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.5, 24),
      new THREE.MeshBasicMaterial({
        color: 0x34d399,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
      })
    );
    this.walkMarker.rotation.x = -Math.PI / 2;
    this.walkMarker.position.y = 0.12;
    this.walkMarker.visible = false;
    this.add(this.walkMarker);

    window.addEventListener('keydown', this.onKeyDownBound);
    window.addEventListener('keyup', this.onKeyUpBound);
    window.addEventListener('blur', this.onWindowBlurBound);
    window.addEventListener('resize', this.onResizeBound);
    renderer.domElement.addEventListener('pointerdown', this.onPointerDownBound);

    // Start with welcoming sunlit Schoolyard backdrop on Login screen
    this.setViewMode('title');
  }

  /**
   * Centers the 3D scene's optical focal point inside the remaining open viewport
   * after accounting for sidebars / top bars / bottom panels.
   */
  setViewportMargins(margins: Partial<ViewportMargins>): void {
    this.viewportMargins = {
      left: Math.max(0, margins.left ?? 0),
      right: Math.max(0, margins.right ?? 0),
      top: Math.max(0, margins.top ?? 0),
      bottom: Math.max(0, margins.bottom ?? 0),
    };
    this.applyCameraViewportOffset();
  }

  private applyCameraViewportOffset(): void {
    const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
    const cam = xb.core.camera as THREE.PerspectiveCamera | undefined;
    if (!cam || !(cam instanceof THREE.PerspectiveCamera)) return;
    if (renderer?.xr?.isPresenting) {
      cam.clearViewOffset();
      return;
    }

    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const { left, right, top, bottom } = this.viewportMargins;

    if (left === 0 && right === 0 && top === 0 && bottom === 0) {
      cam.clearViewOffset();
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      return;
    }

    // Optical center shifts to (w/2 - offsetX, h/2 - offsetY).
    // Desired center of remaining area is (w/2 + (left - right)/2, h/2 + (top - bottom)/2),
    // so offsetX = (right - left)/2 and offsetY = (bottom - top)/2.
    const offsetX = Math.round((right - left) / 2);
    const offsetY = Math.round((bottom - top) / 2);
    cam.setViewOffset(w, h, offsetX, offsetY, w, h);
    cam.updateProjectionMatrix();
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

  setPlayerPosition(pos: { x: number; y: number; z: number }, rotY?: number): void {
    this.playerPos.set(pos.x, pos.y || 0.08, pos.z);
    if (this.playerAvatar) {
      this.playerAvatar.group.position.copy(this.playerPos);
      if (typeof rotY === 'number' && Number.isFinite(rotY)) {
        this.playerAvatar.group.rotation.y = rotY;
      }
    }
  }

  setCurrentProgress(progress: number): void {
    this.currentProgress = Math.max(0, progress);
  }

  rotateStudioAvatar(deltaRad: number): void {
    this.studioTurnAngle += deltaRad;
  }

  setJoystick(x: number, y: number): void {
    this.joyVec.x = THREE.MathUtils.clamp(x, -1, 1);
    this.joyVec.y = THREE.MathUtils.clamp(y, -1, 1);
    if (Math.hypot(x, y) > 0.15) {
      this.walkTarget = null;
      if (this.walkMarker) this.walkMarker.visible = false;
    }
  }

  steerLane(delta: -1 | 1): void {
    if (this.viewMode === 'minigame' && this.activeGameId === 'grand_prix') {
      this.playerLane = Math.max(0, Math.min(3, this.playerLane + delta));
    }
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
      this.walkTarget = null;
      if (this.walkMarker) this.walkMarker.visible = false;
      this.minigameOffset.set(0, 0, 0);
      this.playerVelY = 0;
      this.playerGrounded = true;
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
      const sig = JSON.stringify(p.avatar);
      const subLabel =
        this.viewMode === 'schoolyard'
          ? p.isReady
            ? `Kls ${p.kelas} · Siap!`
            : `Kls ${p.kelas}`
          : `${p.score} pts`;

      let entry = this.peerAvatars.get(p.id);
      if (!entry) {
        const av = new RobloxAvatar(p.avatar, p.nama, subLabel);
        const initial = new THREE.Vector3(p.pos.x, 0.08, p.pos.z);
        av.group.position.copy(initial);
        av.group.rotation.y = typeof p.rotY === 'number' ? p.rotY : Math.PI;
        this.add(av.group);
        entry = {
          avatar: av,
          target: initial,
          targetRotY: typeof p.rotY === 'number' ? p.rotY : Math.PI,
          avatarSig: sig,
        };
        this.peerAvatars.set(p.id, entry);
      } else {
        if (entry.avatarSig !== sig) {
          entry.avatar.applyConfig(p.avatar);
          entry.avatarSig = sig;
        }
        entry.avatar.setLabel(p.nama, subLabel);
      }

      if (this.viewMode === 'schoolyard') {
        entry.target.set(p.pos.x, 0.08, p.pos.z);
        if (typeof p.rotY === 'number') entry.targetRotY = p.rotY;
        entry.avatar.group.visible = true;
      } else if (this.viewMode === 'minigame') {
        // Show classmates sharing the minigame progression
        const offsetX = ((idx % 4) - 1.5) * 1.65;
        if (this.activeWorld?.getPlayerTargetPos) {
          const base = this.activeWorld.getPlayerTargetPos(p.progressValue, idx % 4);
          entry.target.set(base.x + offsetX, base.y, base.z + 0.9);
        } else {
          entry.target.set(offsetX * 1.4, 0, 2.8);
        }
        entry.targetRotY = Math.PI;
        entry.avatar.group.visible = p.approvedForMission;
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

  updatePeerPosition(id: string, pos: { x: number; y: number; z: number }, rotY?: number): void {
    const entry = this.peerAvatars.get(id);
    if (entry && this.viewMode === 'schoolyard') {
      entry.target.set(pos.x, 0.08, pos.z);
      if (typeof rotY === 'number' && Number.isFinite(rotY)) {
        entry.targetRotY = rotY;
      }
    }
  }

  showAvatarChatBubble(senderId: string, selfId: string | null, text: string): void {
    if (this.viewMode !== 'schoolyard') return;
    if (selfId && senderId === selfId) {
      this.playerAvatar?.showChatBubble(text);
      return;
    }
    const peer = this.peerAvatars.get(senderId);
    if (peer) {
      peer.avatar.showChatBubble(text);
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

    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) {
      e.preventDefault();
    }

    this.keys.add(key);

    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      this.walkTarget = null;
      if (this.walkMarker) this.walkMarker.visible = false;
    }

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
    if (this.viewMode === 'minigame') {
      if (key === '1') this.callbacks.onQuickSelectOption?.(0);
      else if (key === '2') this.callbacks.onQuickSelectOption?.(1);
      else if (key === '3') this.callbacks.onQuickSelectOption?.(2);
      else if (key === '4') this.callbacks.onQuickSelectOption?.(3);
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
    if (hits.length > 0) {
      const meta = hits[0].object.userData?.interact as InteractiveHitMeta | undefined;
      if (meta) {
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
        return;
      }
    }

    // Touch / Click-to-Walk on empty ground in Schoolyard (great for phones & tablets!)
    if (this.viewMode === 'schoolyard') {
      const groundHit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.groundPlane, groundHit)) {
        groundHit.x = THREE.MathUtils.clamp(groundHit.x, -11.0, 11.0);
        groundHit.z = THREE.MathUtils.clamp(groundHit.z, -5.6, 9.4);
        groundHit.y = 0.08;
        this.walkTarget = groundHit;
        if (this.walkMarker) {
          this.walkMarker.position.set(groundHit.x, 0.12, groundHit.z);
          this.walkMarker.visible = true;
        }
      }
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

    // Update peers smoothly (position + facing angle)
    for (const entry of this.peerAvatars.values()) {
      const dist = entry.avatar.group.position.distanceTo(entry.target);
      if (dist > 0.06) {
        entry.avatar.group.position.lerp(entry.target, Math.min(1, dt * 7));
        entry.avatar.animState = 'walk';
      } else {
        entry.avatar.animState = 'idle';
      }
      // Smooth shortest-arc yaw interpolation
      let dYaw = entry.targetRotY - entry.avatar.group.rotation.y;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      entry.avatar.group.rotation.y += dYaw * Math.min(1, dt * 9);
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

      // Tap-to-walk fallback when no manual directional input is active
      if (Math.hypot(mx, mz) <= 0.1 && this.walkTarget) {
        const dx = this.walkTarget.x - this.playerPos.x;
        const dz = this.walkTarget.z - this.playerPos.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.28) {
          mx = dx / dist;
          mz = dz / dist;
        } else {
          this.walkTarget = null;
          if (this.walkMarker) this.walkMarker.visible = false;
        }
      }

      if (this.walkMarker && this.walkMarker.visible) {
        const pulse = 1 + Math.sin(this.clockElapsed * 6) * 0.14;
        this.walkMarker.scale.setScalar(pulse);
      }

      const inputMag = Math.hypot(mx, mz);
      const moving = inputMag > 0.1;
      if (moving) {
        const scale = Math.min(1, inputMag);
        const sprintBoost = this.keys.has('shift') ? 1.38 : 1.0;
        const speed = 6.4 * scale * sprintBoost;
        this.playerPos.x = THREE.MathUtils.clamp(
          this.playerPos.x + (mx / inputMag) * speed * dt,
          -11.2,
          11.2
        );
        this.playerPos.z = THREE.MathUtils.clamp(
          this.playerPos.z + (mz / inputMag) * speed * dt,
          -5.8,
          9.6
        );
        if (this.playerAvatar) {
          this.playerAvatar.group.rotation.y = Math.atan2(mx, mz);
        }
        if (performance.now() - this.lastMoveSyncAt > 140) {
          this.lastMoveSyncAt = performance.now();
          this.callbacks.onPlayerMoveSync?.(
            {
              x: Number(this.playerPos.x.toFixed(2)),
              y: Number(this.playerPos.y.toFixed(2)),
              z: Number(this.playerPos.z.toFixed(2)),
            },
            Number((this.playerAvatar?.group.rotation.y ?? 0).toFixed(2))
          );
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

      let mx = this.joyVec.x;
      let mz = this.joyVec.y;
      if (this.keys.has('w') || this.keys.has('arrowup')) mz -= 1;
      if (this.keys.has('s') || this.keys.has('arrowdown')) mz += 1;
      if (this.keys.has('a') || this.keys.has('arrowleft')) mx -= 1;
      if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;
      const inputMag = Math.hypot(mx, mz);
      const isMovingInput = inputMag > 0.14;

      // Touchscreen joystick lane steering in Grand Prix
      if (this.activeGameId === 'grand_prix' && Math.abs(this.joyVec.x) > 0.55) {
        const now = performance.now();
        if (now - this.lastJoyLaneAt > 260) {
          this.lastJoyLaneAt = now;
          this.playerLane = Math.max(0, Math.min(3, this.playerLane + (this.joyVec.x > 0 ? 1 : -1)));
        }
      }

      // Jump arc offset (works in ALL minigames!)
      if (!this.playerGrounded) {
        this.playerVelY -= 19 * dt;
        this.minigameOffset.y += this.playerVelY * dt;
        if (this.minigameOffset.y <= 0) {
          this.minigameOffset.y = 0;
          this.playerVelY = 0;
          this.playerGrounded = true;
        }
      }

      if (this.activeWorld.getPlayerTargetPos) {
        const target = this.activeWorld.getPlayerTargetPos(this.currentProgress, this.playerLane);

        // Allow responsive local step-around on platform/stage via touch joystick or WASD/Arrows
        if (this.activeGameId !== 'grand_prix' && isMovingInput) {
          const speed = 4.2 * Math.min(1, inputMag);
          this.minigameOffset.x = THREE.MathUtils.clamp(
            this.minigameOffset.x + (mx / inputMag) * speed * dt,
            -2.1,
            2.1
          );
          this.minigameOffset.z = THREE.MathUtils.clamp(
            this.minigameOffset.z + (mz / inputMag) * speed * dt,
            -1.2,
            1.2
          );
          if (this.playerAvatar) {
            this.playerAvatar.group.rotation.y = Math.atan2(mx, mz);
          }
        } else if (this.activeGameId === 'grand_prix') {
          this.minigameOffset.x = 0;
          this.minigameOffset.z = 0;
        }

        const goal = new THREE.Vector3(
          target.x + this.minigameOffset.x,
          target.y + this.minigameOffset.y,
          target.z + this.minigameOffset.z
        );
        this.playerPos.lerp(goal, Math.min(1, dt * 8.5));
      } else {
        // Free-roam inside Edu-Craft / Maze / Portal / Astro
        const baseY = this.activeWorld.playerSpawn.y;
        if (isMovingInput) {
          const speed = 5.6 * Math.min(1, inputMag);
          this.playerPos.x = THREE.MathUtils.clamp(
            this.playerPos.x + (mx / inputMag) * speed * dt,
            -6.8,
            6.8
          );
          this.playerPos.z = THREE.MathUtils.clamp(
            this.playerPos.z + (mz / inputMag) * speed * dt,
            -5.2,
            5.2
          );
          if (this.playerAvatar) {
            this.playerAvatar.group.rotation.y = Math.atan2(mx, mz);
          }
        }
        this.playerPos.y = baseY + this.minigameOffset.y;
      }

      if (this.playerAvatar) {
        this.playerAvatar.group.position.copy(this.playerPos);
        if (this.feedbackAnim) {
          this.playerAvatar.animState = this.feedbackAnim;
        } else if (!this.playerGrounded) {
          this.playerAvatar.animState = 'jump';
        } else if (this.activeGameId === 'grand_prix') {
          this.playerAvatar.animState = 'drive';
          this.playerAvatar.group.rotation.y = Math.PI;
        } else if (this.activeGameId === 'astro_scanner') {
          this.playerAvatar.animState = 'fly';
          if (!isMovingInput) this.playerAvatar.group.rotation.y = Math.PI;
        } else if (isMovingInput) {
          this.playerAvatar.animState = 'walk';
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
    window.removeEventListener('blur', this.onWindowBlurBound);
    window.removeEventListener('resize', this.onResizeBound);
    xb.core.renderer?.domElement?.removeEventListener('pointerdown', this.onPointerDownBound);
    this.clearWorld();
    this.playerAvatar?.dispose();
    if (this.walkMarker) {
      this.remove(this.walkMarker);
      this.walkMarker.geometry.dispose();
      (this.walkMarker.material as THREE.Material).dispose();
      this.walkMarker = null;
    }
    for (const entry of this.peerAvatars.values()) {
      entry.avatar.dispose();
    }
    this.peerAvatars.clear();
    this.particleGeo.dispose();
    this.envRenderTarget?.dispose();
    this.pmremGenerator?.dispose();
  }
}
