import * as THREE from 'three';
import type { GameId, PaiElement, QuestionItem } from '../types.ts';
import {
  makeAnswerPanelTexture,
  makeDiceFaceTexture,
  makeFlagTexture,
  makeGrassTexture,
  makePavingTexture,
  makeRoadTexture,
  makeSignTexture,
  makeStoneTexture,
} from './ProceduralTextures.ts';

export interface InteractiveHitMeta {
  kind:
    | 'material_kiosk'
    | 'answer_option'
    | 'portal'
    | 'dice'
    | 'craft_table'
    | 'artifact_capsule';
  elementId?: string;
  optionIndex?: number;
  difficulty?: 'mudah' | 'sedang' | 'sulit';
  label?: string;
}

export interface BuiltWorld {
  root: THREE.Group;
  skyTop: number;
  skyBottom: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  interactables: THREE.Object3D[];
  playerSpawn: THREE.Vector3;
  cameraOffset: THREE.Vector3;
  cameraLookOffset: THREE.Vector3;
  updateWorld: (dt: number, elapsed: number, progress: number) => void;
  updateQuestionVisuals?: (q: QuestionItem | null, selectedIndices: number[]) => void;
  triggerFeedback?: (isCorrect: boolean, chosenIndex?: number) => void;
  getPlayerTargetPos?: (progress: number, laneIndex: number) => THREE.Vector3;
  rollDiceVisual?: (result: number) => void;
  setActivePortal?: (diff: 'mudah' | 'sedang' | 'sulit') => void;
  dispose: () => void;
}

function makeSkyDome(topHex: number, bottomHex: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(140, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(topHex) },
      bottomColor: { value: new THREE.Color(bottomHex) },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying vec3 vWorldPos;
      void main() {
        float h = normalize(vWorldPos).y;
        float t = clamp(h * 1.15 + 0.15, 0.0, 1.0);
        gl_FragColor = vec4(mix(bottomColor, topColor, pow(t, 0.75)), 1.0);
      }
    `,
  });
  return new THREE.Mesh(geo, mat);
}

function createTree(scale = 1): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18 * scale, 0.28 * scale, 1.8 * scale, 7),
    new THREE.MeshStandardMaterial({ color: 0x7c4a26, roughness: 0.9 })
  );
  trunk.position.y = 0.9 * scale;
  trunk.castShadow = true;
  g.add(trunk);

  const foliageColors = [0x22c55e, 0x16a34a, 0x15803d];
  for (let i = 0; i < 3; i++) {
    const crown = new THREE.Mesh(
      new THREE.DodecahedronGeometry((1.05 - i * 0.2) * scale, 0),
      new THREE.MeshStandardMaterial({ color: foliageColors[i], roughness: 0.85 })
    );
    crown.position.y = (2.1 + i * 0.65) * scale;
    crown.rotation.y = i * 0.8;
    crown.castShadow = true;
    g.add(crown);
  }
  return g;
}

function createCloud(scale = 1): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
  const offsets: [number, number, number, number][] = [
    [0, 0, 0, 1.2],
    [-1.1, -0.15, 0.2, 0.9],
    [1.1, -0.1, -0.1, 0.95],
    [0.3, 0.35, 0.1, 0.85],
  ];
  for (const [x, y, z, r] of offsets) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r * scale, 10, 8), mat);
    puff.position.set(x * scale, y * scale, z * scale);
    g.add(puff);
  }
  return g;
}

function tagInteractable(obj: THREE.Object3D, meta: InteractiveHitMeta): void {
  obj.userData.interact = meta;
  obj.traverse((child) => {
    child.userData.interact = meta;
  });
}

// =====================================================================
// 0. SCHOOLYARD LOBBY (Gedung Sekolah + Tiang Bendera Berkibar + Kios Materi)
// =====================================================================
export function buildSchoolyardWorld(elements: PaiElement[]): BuiltWorld {
  const root = new THREE.Group();
  const disposables: THREE.Texture[] = [];
  const interactables: THREE.Object3D[] = [];

  root.add(makeSkyDome(0x2563eb, 0xbae6fd));

  // Grass field
  const grassTex = makeGrassTexture(18);
  disposables.push(grassTex);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(110, 110),
    new THREE.MeshStandardMaterial({ map: grassTex, roughness: 0.92 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);

  // Central paved school courtyard
  const pavingTex = makePavingTexture(9);
  disposables.push(pavingTex);
  const courtyard = new THREE.Mesh(
    new THREE.BoxGeometry(24, 0.08, 18),
    new THREE.MeshStandardMaterial({ map: pavingTex, roughness: 0.82 })
  );
  courtyard.position.set(0, 0.04, 1.5);
  courtyard.receiveShadow = true;
  root.add(courtyard);

  // === SCHOOL BUILDING (Gedung Sekolah SD Nusantara) ===
  const schoolGroup = new THREE.Group();
  schoolGroup.position.set(0, 0, -11.5);

  // Main body
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xfef3c7, roughness: 0.78 });
  const mainWall = new THREE.Mesh(new THREE.BoxGeometry(22, 6.2, 6.8), wallMat);
  mainWall.position.y = 3.1;
  mainWall.castShadow = true;
  mainWall.receiveShadow = true;
  schoolGroup.add(mainWall);

  // Red-orange Nusantara terracotta pitched roof
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xc2410c, roughness: 0.72 });
  const roof = new THREE.Mesh(new THREE.ConeGeometry(16.6, 3.8, 4), roofMat);
  roof.rotation.y = Math.PI / 4;
  roof.scale.set(1.02, 1, 0.42);
  roof.position.y = 8.05;
  roof.castShadow = true;
  schoolGroup.add(roof);

  // Portico / Entrance porch
  const porchRoof = new THREE.Mesh(
    new THREE.BoxGeometry(6.8, 0.45, 3.2),
    new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.5 })
  );
  porchRoof.position.set(0, 4.1, 4.4);
  porchRoof.castShadow = true;
  schoolGroup.add(porchRoof);

  for (const px of [-2.8, 2.8]) {
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.28, 4.0, 12),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5 })
    );
    pillar.position.set(px, 2.0, 5.5);
    pillar.castShadow = true;
    schoolGroup.add(pillar);
  }

  // School doors
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 3.1, 0.25),
    new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.65 })
  );
  door.position.set(0, 1.55, 3.45);
  schoolGroup.add(door);

  // Classroom windows
  const winFrameMat = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.4 });
  const winGlassMat = new THREE.MeshStandardMaterial({
    color: 0x7dd3fc,
    roughness: 0.15,
    metalness: 0.35,
  });
  for (const wx of [-8.2, -5.2, 5.2, 8.2]) {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.9, 0.2), winFrameMat);
    frame.position.set(wx, 3.2, 3.45);
    schoolGroup.add(frame);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.75, 1.55, 0.24), winGlassMat);
    glass.position.set(wx, 3.2, 3.46);
    schoolGroup.add(glass);
  }

  // School Name Signboard
  const schoolSignTex = makeSignTexture(
    'SDN NUSANTARA · PAI 3D',
    'Halaman Belajar & Misi AKM',
    '#1e3a8a',
    '#fde047'
  );
  disposables.push(schoolSignTex);
  const schoolSign = new THREE.Mesh(
    new THREE.BoxGeometry(8.6, 1.55, 0.28),
    new THREE.MeshStandardMaterial({ map: schoolSignTex, roughness: 0.4 })
  );
  schoolSign.position.set(0, 5.25, 4.65);
  schoolGroup.add(schoolSign);

  root.add(schoolGroup);

  // === TIANG BENDERA MERAH PUTIH BERKIBAR ===
  const flagGroup = new THREE.Group();
  flagGroup.position.set(0, 0.08, -2.2);

  // Stepped white ceremonial pedestal
  const base1 = new THREE.Mesh(
    new THREE.BoxGeometry(2.8, 0.35, 2.8),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.6 })
  );
  base1.position.y = 0.175;
  base1.receiveShadow = true;
  flagGroup.add(base1);

  const base2 = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.45, 1.7),
    new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.55 })
  );
  base2.position.y = 0.55;
  flagGroup.add(base2);

  // Tall chrome flagpole
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.09, 9.4, 14),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.8, roughness: 0.22 })
  );
  pole.position.y = 5.2;
  pole.castShadow = true;
  flagGroup.add(pole);

  const finial = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xfacc15, metalness: 0.75, roughness: 0.25 })
  );
  finial.position.y = 9.95;
  flagGroup.add(finial);

  // Subdivided cloth flag plane for realistic wind-wave animation
  const flagGeo = new THREE.PlaneGeometry(2.7, 1.75, 20, 10);
  // Shift vertices so x=0 attaches directly to pole
  flagGeo.translate(1.35, 0, 0);
  const flagTex = makeFlagTexture();
  disposables.push(flagTex);
  const flagMesh = new THREE.Mesh(
    flagGeo,
    new THREE.MeshStandardMaterial({
      map: flagTex,
      side: THREE.DoubleSide,
      roughness: 0.62,
    })
  );
  flagMesh.position.set(0.06, 8.85, 0);
  flagMesh.castShadow = true;
  flagGroup.add(flagMesh);
  root.add(flagGroup);

  // === INTERACTIVE PAI MATERIAL KIOSKS (Semicircle on Courtyard) ===
  const floatingOrbs: THREE.Object3D[] = [];
  const totalKiosks = elements.length;
  elements.forEach((el, idx) => {
    const angle =
      totalKiosks === 1
        ? 0
        : -Math.PI * 0.42 + (idx / Math.max(1, totalKiosks - 1)) * Math.PI * 0.84;
    const radius = 8.4;
    const kx = Math.sin(angle) * radius;
    const kz = 2.0 + Math.cos(angle) * (radius * 0.55) - 3.6;

    const kiosk = new THREE.Group();
    kiosk.position.set(kx, 0.08, kz);
    kiosk.lookAt(0, 0.08, 3.5);

    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 1.15, 0.65, 8),
      new THREE.MeshStandardMaterial({ color: el.accentHex, roughness: 0.45, metalness: 0.15 })
    );
    plinth.position.y = 0.325;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    kiosk.add(plinth);

    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.12, 1.9, 10),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 })
    );
    post.position.y = 1.45;
    kiosk.add(post);

    const signTex = makeSignTexture(
      el.shortName,
      'Klik Baca Materi',
      el.color,
      '#ffffff'
    );
    disposables.push(signTex);
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(2.5, 1.15, 0.16),
      new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.35 })
    );
    board.position.y = 2.55;
    board.castShadow = true;
    kiosk.add(board);

    // Floating 3D glowing emblem above board
    const emblem = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.36, 0),
      new THREE.MeshStandardMaterial({
        color: 0xfef08a,
        emissive: el.accentHex,
        emissiveIntensity: 0.6,
        roughness: 0.2,
        metalness: 0.45,
      })
    );
    emblem.position.y = 3.55;
    kiosk.add(emblem);
    floatingOrbs.push(emblem);

    tagInteractable(kiosk, {
      kind: 'material_kiosk',
      elementId: el.id,
      label: el.name,
    });
    interactables.push(kiosk);
    root.add(kiosk);
  });

  // Perimeter trees & clouds
  const treeCoords: [number, number][] = [
    [-15, -9],
    [-16, -1],
    [-14, 7],
    [15, -9],
    [16, -1],
    [14, 7],
    [-9, -18],
    [9, -18],
  ];
  for (const [tx, tz] of treeCoords) {
    const tree = createTree(1.1 + Math.random() * 0.35);
    tree.position.set(tx, 0, tz);
    root.add(tree);
  }

  const clouds: THREE.Group[] = [];
  for (let i = 0; i < 6; i++) {
    const c = createCloud(1.6 + (i % 3) * 0.4);
    c.position.set(-28 + i * 11, 16 + (i % 2) * 3, -24 - (i % 3) * 6);
    clouds.push(c);
    root.add(c);
  }

  // Flag vertex animation buffer cache
  const posAttr = flagGeo.attributes.position as THREE.BufferAttribute;
  const origCoords = new Float32Array(posAttr.array.length);
  origCoords.set(posAttr.array);

  return {
    root,
    skyTop: 0x2563eb,
    skyBottom: 0xbae6fd,
    fogColor: 0xdbeafe,
    fogNear: 28,
    fogFar: 95,
    interactables,
    playerSpawn: new THREE.Vector3(0, 0.08, 4.8),
    cameraOffset: new THREE.Vector3(0, 5.2, 9.8),
    cameraLookOffset: new THREE.Vector3(0, 2.2, -2.0),
    updateWorld: (dt, elapsed) => {
      // Wind-waving Merah-Putih flag animation
      for (let i = 0; i < posAttr.count; i++) {
        const ox = origCoords[i * 3];
        const oy = origCoords[i * 3 + 1];
        const factor = Math.min(1, ox / 2.7);
        const waveZ =
          Math.sin(ox * 3.1 - elapsed * 5.8) * 0.24 * factor +
          Math.cos(oy * 2.4 - elapsed * 3.2) * 0.07 * factor;
        const waveY = Math.sin(ox * 2.2 - elapsed * 4.5) * 0.06 * factor;
        posAttr.setXYZ(i, ox, oy + waveY, waveZ);
      }
      posAttr.needsUpdate = true;
      flagGeo.computeVertexNormals();

      // Floating material kiosk emblems
      floatingOrbs.forEach((orb, idx) => {
        orb.rotation.y += dt * 1.4;
        orb.position.y = 3.55 + Math.sin(elapsed * 2.4 + idx) * 0.16;
      });

      // Gentle drifting clouds
      clouds.forEach((c) => {
        c.position.x += dt * 0.7;
        if (c.position.x > 40) c.position.x = -40;
      });
    },
    dispose: () => {
      disposables.forEach((t) => t.dispose());
    },
  };
}

// =====================================================================
// HELPER: Reusable 3D Answer Option Panels (A/B/C/D or Benar/Salah)
// =====================================================================
interface OptionPanelController {
  group: THREE.Group;
  panels: {
    mesh: THREE.Mesh;
    baseY: number;
    targetY: number;
    glowMat: THREE.MeshStandardMaterial;
    tex: THREE.CanvasTexture | null;
  }[];
  applyQuestion: (q: QuestionItem | null, selected: number[]) => void;
  flashOutcome: (isCorrect: boolean, chosenIdx?: number) => void;
  animate: (dt: number, elapsed: number) => void;
  dispose: () => void;
}

const OPTION_COLORS = ['#2563eb', '#10b981', '#f59e0b', '#a855f7'];
const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

function createOptionPanels(
  layout: 'row' | 'lanes' | 'doors',
  spacing: number,
  panelSize: [number, number, number],
  interactables: THREE.Object3D[]
): OptionPanelController {
  const group = new THREE.Group();
  const panels: OptionPanelController['panels'] = [];

  for (let i = 0; i < 4; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.32,
      metalness: 0.15,
    });
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(panelSize[0], panelSize[1], panelSize[2]),
      mat
    );
    const x = (i - 1.5) * spacing;
    const baseY = layout === 'doors' ? panelSize[1] / 2 : 0.35;
    mesh.position.set(x, baseY, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    tagInteractable(mesh, {
      kind: 'answer_option',
      optionIndex: i,
      label: `Pilihan ${OPTION_LETTERS[i]}`,
    });
    interactables.push(mesh);
    group.add(mesh);
    panels.push({ mesh, baseY, targetY: baseY, glowMat: mat, tex: null });
  }

  const applyQuestion = (q: QuestionItem | null, selected: number[]) => {
    const count = q ? q.options.length : 4;
    for (let i = 0; i < 4; i++) {
      const p = panels[i];
      if (!q || i >= count) {
        p.mesh.visible = false;
        continue;
      }
      p.mesh.visible = true;
      const x =
        count === 2
          ? (i === 0 ? -spacing * 0.85 : spacing * 0.85)
          : (i - 1.5) * spacing;
      p.mesh.position.x = x;

      const isSelected = selected.includes(i);
      const badge =
        q.type === 'BS' ? (i === 0 ? 'B' : 'S') : OPTION_LETTERS[i];
      const bg =
        q.type === 'BS'
          ? i === 0
            ? '#16a34a'
            : '#dc2626'
          : isSelected
            ? '#eab308'
            : OPTION_COLORS[i % OPTION_COLORS.length];

      if (p.tex) p.tex.dispose();
      p.tex = makeAnswerPanelTexture(badge, q.options[i], bg);
      p.glowMat.map = p.tex;
      p.glowMat.emissive.setHex(isSelected ? 0xfacc15 : 0x000000);
      p.glowMat.emissiveIntensity = isSelected ? 0.35 : 0;
      p.glowMat.needsUpdate = true;
      p.targetY = p.baseY + (isSelected ? 0.32 : 0);
    }
  };

  const flashOutcome = (isCorrect: boolean, chosenIdx?: number) => {
    panels.forEach((p, i) => {
      if (!p.mesh.visible) return;
      if (chosenIdx === undefined || i === chosenIdx) {
        p.targetY = isCorrect ? p.baseY + 0.9 : p.baseY - 1.6;
        p.glowMat.emissive.setHex(isCorrect ? 0x22c55e : 0xef4444);
        p.glowMat.emissiveIntensity = 0.65;
      }
    });
  };

  const animate = (dt: number, elapsed: number) => {
    panels.forEach((p, i) => {
      if (!p.mesh.visible) return;
      const bob = Math.sin(elapsed * 2.5 + i * 0.8) * 0.05;
      p.mesh.position.y += (p.targetY + bob - p.mesh.position.y) * Math.min(1, dt * 8);
    });
  };

  const dispose = () => {
    panels.forEach((p) => p.tex?.dispose());
  };

  return { group, panels, applyQuestion, flashOutcome, animate, dispose };
}

// =====================================================================
// BUILDER ROUTER FOR ALL 9 PLAYABLE 3D MINIGAMES
// =====================================================================
export function buildMinigameWorld(gameId: GameId): BuiltWorld {
  switch (gameId) {
    case 'puncak_nalar':
      return buildPuncakNalar();
    case 'sky_bridge':
      return buildSkyBridge();
    case 'grand_prix':
      return buildGrandPrix();
    case 'lost_scroll':
      return buildLostScroll();
    case 'edu_craft':
      return buildEduCraft();
    case 'portal_dimension':
      return buildPortalDimension();
    case 'board_adventure':
      return buildBoardAdventure();
    case 'astro_scanner':
      return buildAstroScanner();
    case 'climb_summit':
      return buildClimbSummit();
  }
}

// 1. PUNCAK NALAR (Mountain Parkour Platforms)
function buildPuncakNalar(): BuiltWorld {
  const root = new THREE.Group();
  const interactables: THREE.Object3D[] = [];
  const stoneTex = makeStoneTexture(3);

  root.add(makeSkyDome(0x0284c7, 0xfef3c7));

  // Majestic mountain range backdrop
  const mtnColors = [0x475569, 0x334155, 0x64748b, 0x1e293b];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(
      new THREE.ConeGeometry(9 + (i % 3) * 4, 22 + (i % 4) * 7, 6),
      new THREE.MeshStandardMaterial({ color: mtnColors[i % mtnColors.length], roughness: 0.9 })
    );
    const angle = (i / 8) * Math.PI * 2;
    m.position.set(Math.cos(angle) * 38, 7, Math.sin(angle) * 38 - 10);
    root.add(m);

    // Snow cap
    const cap = new THREE.Mesh(
      new THREE.ConeGeometry(3.2, 6.2, 6),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.7 })
    );
    cap.position.set(m.position.x, m.position.y + 8 + (i % 4) * 2.5, m.position.z);
    root.add(cap);
  }

  // Towering stepped parkour platforms (levels 0..16)
  for (let tier = 0; tier <= 16; tier++) {
    const plat = new THREE.Mesh(
      new THREE.BoxGeometry(7.2, 0.7, 4.4),
      new THREE.MeshStandardMaterial({
        map: stoneTex,
        color: tier % 2 === 0 ? 0xe2e8f0 : 0xcbd5e1,
        roughness: 0.75,
      })
    );
    plat.position.set(0, tier * 1.4 - 0.35, -tier * 3.8);
    plat.receiveShadow = true;
    plat.castShadow = true;
    root.add(plat);
  }

  // Interactive 4 answer panels positioned ahead of current tier
  const panelCtrl = createOptionPanels('row', 2.45, [2.1, 0.6, 1.8], interactables);
  panelCtrl.group.position.set(0, 0.5, -3.5);
  root.add(panelCtrl.group);

  // Floating clouds
  const clouds: THREE.Group[] = [];
  for (let i = 0; i < 8; i++) {
    const c = createCloud(2.0);
    c.position.set(-22 + i * 7, 4 + i * 2.4, -i * 6);
    clouds.push(c);
    root.add(c);
  }

  return {
    root,
    skyTop: 0x0284c7,
    skyBottom: 0xfef3c7,
    fogColor: 0xe0f2fe,
    fogNear: 24,
    fogFar: 95,
    interactables,
    playerSpawn: new THREE.Vector3(0, 0, 0),
    cameraOffset: new THREE.Vector3(0, 4.6, 8.2),
    cameraLookOffset: new THREE.Vector3(0, 1.8, -3.5),
    getPlayerTargetPos: (progress) => {
      const tier = Math.min(16, Math.max(0, progress));
      return new THREE.Vector3(0, tier * 1.4, -tier * 3.8);
    },
    updateWorld: (dt, elapsed, progress) => {
      const tier = Math.min(15, Math.max(0, progress));
      const targetZ = -tier * 3.8 - 2.6;
      const targetY = tier * 1.4 + 0.5;
      panelCtrl.group.position.y += (targetY - panelCtrl.group.position.y) * Math.min(1, dt * 6);
      panelCtrl.group.position.z += (targetZ - panelCtrl.group.position.z) * Math.min(1, dt * 6);
      panelCtrl.animate(dt, elapsed);
      clouds.forEach((c, idx) => {
        c.position.x += Math.sin(elapsed * 0.4 + idx) * dt * 0.4;
      });
    },
    updateQuestionVisuals: (q, sel) => panelCtrl.applyQuestion(q, sel),
    triggerFeedback: (ok, idx) => panelCtrl.flashOutcome(ok, idx),
    dispose: () => {
      stoneTex.dispose();
      panelCtrl.dispose();
    },
  };
}

// 2. SKY BRIDGE BUILDER (Floating Sky Islands + Luminous Light Bridge)
function buildSkyBridge(): BuiltWorld {
  const root = new THREE.Group();
  const interactables: THREE.Object3D[] = [];
  const grassTex = makeGrassTexture(4);

  root.add(makeSkyDome(0x0ea5e9, 0xe0f2fe));

  // Starting sky island
  const makeIsland = (x: number, y: number, z: number, radius: number) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius * 0.9, 0.7, 10),
      new THREE.MeshStandardMaterial({ map: grassTex, roughness: 0.85 })
    );
    top.position.y = -0.35;
    top.receiveShadow = true;
    g.add(top);

    const rock = new THREE.Mesh(
      new THREE.ConeGeometry(radius * 0.88, radius * 1.35, 8),
      new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.9 })
    );
    rock.rotation.x = Math.PI;
    rock.position.y = -0.7 - radius * 0.65;
    g.add(rock);

    const tree = createTree(0.95);
    tree.position.set(-radius * 0.52, 0, -radius * 0.25);
    g.add(tree);
    root.add(g);
  };

  makeIsland(0, 0, 1.5, 4.5);
  makeIsland(0, 0, -48, 6.2);

  // 16 Luminous Bridge Segments that materialize as progress grows
  const bridgeSegs: THREE.Mesh[] = [];
  for (let i = 0; i < 16; i++) {
    const seg = new THREE.Mesh(
      new THREE.BoxGeometry(3.4, 0.34, 2.65),
      new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0284c7,
        emissiveIntensity: 0.55,
        roughness: 0.2,
        metalness: 0.3,
        transparent: true,
        opacity: 0.92,
      })
    );
    seg.position.set(0, -0.18, -3.2 - i * 2.8);
    seg.scale.set(0.01, 0.01, 0.01);
    bridgeSegs.push(seg);
    root.add(seg);
  }

  // Interactive Light Blocks / Crystal Levers / Jump Pads
  const panelCtrl = createOptionPanels('row', 2.4, [2.0, 0.95, 1.4], interactables);
  panelCtrl.group.position.set(0, 0.4, -3.5);
  root.add(panelCtrl.group);

  const clouds: THREE.Group[] = [];
  for (let i = 0; i < 10; i++) {
    const c = createCloud(2.2);
    c.position.set((i % 2 === 0 ? -1 : 1) * (9 + (i % 3) * 4), -3 + (i % 3) * 2, -i * 5);
    clouds.push(c);
    root.add(c);
  }

  return {
    root,
    skyTop: 0x0ea5e9,
    skyBottom: 0xe0f2fe,
    fogColor: 0xe0f2fe,
    fogNear: 24,
    fogFar: 90,
    interactables,
    playerSpawn: new THREE.Vector3(0, 0, 0.5),
    cameraOffset: new THREE.Vector3(0, 4.8, 8.0),
    cameraLookOffset: new THREE.Vector3(0, 1.4, -4.5),
    getPlayerTargetPos: (progress) => {
      const seg = Math.min(16, Math.max(0, progress));
      return new THREE.Vector3(0, 0, seg === 0 ? 0.5 : -3.2 - (seg - 1) * 2.8);
    },
    updateWorld: (dt, elapsed, progress) => {
      bridgeSegs.forEach((seg, idx) => {
        const unlocked = idx < progress;
        const target = unlocked ? 1 : 0.001;
        seg.scale.lerp(new THREE.Vector3(target, target, target), Math.min(1, dt * 7));
        seg.visible = seg.scale.x > 0.02;
      });
      const anchorZ = progress === 0 ? -3.4 : -3.2 - Math.min(15, progress) * 2.8 - 2.6;
      panelCtrl.group.position.z += (anchorZ - panelCtrl.group.position.z) * Math.min(1, dt * 6);
      panelCtrl.animate(dt, elapsed);
      clouds.forEach((c, idx) => {
        c.position.y += Math.sin(elapsed + idx) * dt * 0.2;
      });
    },
    updateQuestionVisuals: (q, sel) => panelCtrl.applyQuestion(q, sel),
    triggerFeedback: (ok, idx) => panelCtrl.flashOutcome(ok, idx),
    dispose: () => {
      grassTex.dispose();
      panelCtrl.dispose();
    },
  };
}

// 3. 3D GRAND PRIX EDU-RACE (4-Lane Futuristic Highway + Hover-Kart + Turbo Gates)
function buildGrandPrix(): BuiltWorld {
  const root = new THREE.Group();
  const interactables: THREE.Object3D[] = [];
  const roadTex = makeRoadTexture();

  root.add(makeSkyDome(0x1d4ed8, 0xfde68a));

  // Long futuristic 4-lane highway
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(13.5, 180),
    new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.65, metalness: 0.1 })
  );
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0, -65);
  road.receiveShadow = true;
  root.add(road);

  // Glowing side guardrails & light arches
  const railMat = new THREE.MeshStandardMaterial({
    color: 0xf59e0b,
    emissive: 0xd97706,
    emissiveIntensity: 0.45,
    roughness: 0.3,
    metalness: 0.5,
  });
  for (const rx of [-7.1, 7.1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.75, 180), railMat);
    rail.position.set(rx, 0.38, -65);
    root.add(rail);
  }

  const arches: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const arch = new THREE.Mesh(
      new THREE.TorusGeometry(7.3, 0.22, 8, 24, Math.PI),
      new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0ea5e9,
        emissiveIntensity: 0.6,
        roughness: 0.25,
      })
    );
    arch.position.set(0, 0, -i * 18);
    arches.push(arch);
    root.add(arch);
  }

  // Hover-Kart chassis (moves with player lane X)
  const kart = new THREE.Group();
  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(1.75, 0.48, 2.7),
    new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.28, metalness: 0.55 })
  );
  chassis.position.y = 0.42;
  chassis.castShadow = true;
  kart.add(chassis);

  const spoiler = new THREE.Mesh(
    new THREE.BoxGeometry(1.85, 0.14, 0.45),
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.4, metalness: 0.6 })
  );
  spoiler.position.set(0, 0.92, 1.15);
  kart.add(spoiler);

  const thruster = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.36, 0.5, 12),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
  );
  thruster.rotation.x = Math.PI / 2;
  thruster.position.set(0, 0.44, 1.48);
  kart.add(thruster);
  root.add(kart);

  // 4 Energy Gate Panels across the 4 lanes
  const panelCtrl = createOptionPanels('lanes', 3.1, [2.7, 2.3, 0.45], interactables);
  panelCtrl.group.position.set(0, 1.35, -13.5);
  root.add(panelCtrl.group);

  let turboTimer = 0;
  let kartLaneX = 0;

  return {
    root,
    skyTop: 0x1d4ed8,
    skyBottom: 0xfde68a,
    fogColor: 0xe0f2fe,
    fogNear: 30,
    fogFar: 115,
    interactables,
    playerSpawn: new THREE.Vector3(0, 0.3, 0),
    cameraOffset: new THREE.Vector3(0, 4.4, 8.2),
    cameraLookOffset: new THREE.Vector3(0, 1.5, -10),
    getPlayerTargetPos: (_progress, laneIndex) => {
      kartLaneX = (laneIndex - 1.5) * 3.1;
      return new THREE.Vector3(kartLaneX, 0.3, 0);
    },
    updateWorld: (dt, elapsed) => {
      const speed = turboTimer > 0 ? 3.8 : 1.55;
      if (turboTimer > 0) turboTimer = Math.max(0, turboTimer - dt);
      roadTex.offset.y -= dt * speed;
      arches.forEach((a) => {
        a.position.z += dt * speed * 14;
        if (a.position.z > 12) a.position.z -= 144;
      });
      kart.position.x += (kartLaneX - kart.position.x) * Math.min(1, dt * 10);
      kart.position.y = Math.sin(elapsed * 8) * 0.06;
      thruster.scale.setScalar(turboTimer > 0 ? 1.5 : 1.0);
      panelCtrl.animate(dt, elapsed);
    },
    updateQuestionVisuals: (q, sel) => panelCtrl.applyQuestion(q, sel),
    triggerFeedback: (ok, idx) => {
      if (ok) turboTimer = 2.0;
      panelCtrl.flashOutcome(ok, idx);
    },
    dispose: () => {
      roadTex.dispose();
      panelCtrl.dispose();
    },
  };
}

// 4. THE LOST SCROLL MAZE (Garden Hedge Maze + Locked Gates + Golden Vault)
function buildLostScroll(): BuiltWorld {
  const root = new THREE.Group();
  const interactables: THREE.Object3D[] = [];
  const pavingTex = makePavingTexture(10);

  root.add(makeSkyDome(0x4c1d95, 0xfde68a));

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(54, 54),
    new THREE.MeshStandardMaterial({ map: pavingTex, roughness: 0.85 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  // Maze hedge walls
  const hedgeMat = new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.88 });
  const wallDefs: [number, number, number, number][] = [
    [-7.5, -6, 1.4, 24],
    [7.5, -6, 1.4, 24],
    [0, -18, 16, 1.4],
    [-4.2, -10, 5.2, 1.2],
    [4.2, -10, 5.2, 1.2],
  ];
  for (const [x, z, w, d] of wallDefs) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 2.8, d), hedgeMat);
    wall.position.set(x, 1.4, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    root.add(wall);
  }

  // Golden Vault Chest with Floating Ancient Scroll
  const vault = new THREE.Group();
  vault.position.set(0, 0, -14.5);
  const chest = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 1.2, 1.4),
    new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.3, metalness: 0.65 })
  );
  chest.position.y = 0.6;
  chest.castShadow = true;
  vault.add(chest);

  const scroll = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.24, 1.5, 12),
    new THREE.MeshStandardMaterial({
      color: 0xfef08a,
      emissive: 0xf59e0b,
      emissiveIntensity: 0.7,
      roughness: 0.25,
    })
  );
  scroll.rotation.z = Math.PI / 2;
  scroll.position.y = 2.4;
  vault.add(scroll);
  root.add(vault);

  // 4 Locked Answer Doors ahead of player
  const panelCtrl = createOptionPanels('doors', 2.8, [2.3, 2.5, 0.45], interactables);
  panelCtrl.group.position.set(0, 0, -5.2);
  root.add(panelCtrl.group);

  return {
    root,
    skyTop: 0x4c1d95,
    skyBottom: 0xfde68a,
    fogColor: 0xe9d5ff,
    fogNear: 20,
    fogFar: 75,
    interactables,
    playerSpawn: new THREE.Vector3(0, 0, 2.5),
    cameraOffset: new THREE.Vector3(0, 7.2, 9.5),
    cameraLookOffset: new THREE.Vector3(0, 1.5, -5.0),
    updateWorld: (dt, elapsed) => {
      scroll.rotation.y += dt * 1.8;
      scroll.position.y = 2.4 + Math.sin(elapsed * 3) * 0.25;
      panelCtrl.animate(dt, elapsed);
    },
    updateQuestionVisuals: (q, sel) => panelCtrl.applyQuestion(q, sel),
    triggerFeedback: (ok, idx) => panelCtrl.flashOutcome(ok, idx),
    dispose: () => {
      pavingTex.dispose();
      panelCtrl.dispose();
    },
  };
}

// 5. EDU-CRAFT ISLAND (Empty Tropical Island -> Builds 5 Composite 3D Structures!)
function buildEduCraft(): BuiltWorld {
  const root = new THREE.Group();
  const interactables: THREE.Object3D[] = [];
  const grassTex = makeGrassTexture(6);

  root.add(makeSkyDome(0x0284c7, 0xa5f3fc));

  // Turquoise sea
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(140, 140),
    new THREE.MeshStandardMaterial({ color: 0x06b6d4, roughness: 0.25, metalness: 0.25 })
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -0.6;
  root.add(sea);

  // Grassy Island
  const island = new THREE.Mesh(
    new THREE.CylinderGeometry(13.5, 15.2, 1.2, 18),
    new THREE.MeshStandardMaterial({ map: grassTex, roughness: 0.85 })
  );
  island.position.y = -0.6;
  island.receiveShadow = true;
  root.add(island);

  // Central Glowing Crafting Table (Clickable!)
  const craftTable = new THREE.Group();
  craftTable.position.set(0, 0, -2.5);
  const tbl = new THREE.Mesh(
    new THREE.BoxGeometry(2.1, 1.15, 2.1),
    new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.65 })
  );
  tbl.position.y = 0.575;
  tbl.castShadow = true;
  craftTable.add(tbl);

  const craftTopTex = makeSignTexture('MEJA KERJA', 'Klik Rakit Bangunan', '#059669', '#fef08a');
  const topSign = new THREE.Mesh(
    new THREE.BoxGeometry(2.3, 0.85, 0.16),
    new THREE.MeshStandardMaterial({ map: craftTopTex, roughness: 0.35 })
  );
  topSign.position.set(0, 2.1, 0);
  craftTable.add(topSign);
  tagInteractable(craftTable, { kind: 'craft_table', label: 'Meja Kerja Edu-Craft' });
  interactables.push(craftTable);
  root.add(craftTable);

  // 5 Progressive Composite 3D Nusantara Landmarks!
  const structures: THREE.Group[] = [];

  // (1) Masjid Kubah Emas
  const masjid = new THREE.Group();
  masjid.position.set(-5.8, 0, -5.8);
  const mBase = new THREE.Mesh(
    new THREE.BoxGeometry(4.2, 2.8, 4.2),
    new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5 })
  );
  mBase.position.y = 1.4;
  mBase.castShadow = true;
  masjid.add(mBase);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1.75, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.6),
    new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.25, metalness: 0.65 })
  );
  dome.position.y = 2.8;
  masjid.add(dome);
  const minaret = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.42, 5.2, 10),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.5 })
  );
  minaret.position.set(2.3, 2.6, 1.5);
  masjid.add(minaret);
  structures.push(masjid);

  // (2) Perpustakaan Hikmah
  const perpus = new THREE.Group();
  perpus.position.set(5.8, 0, -5.8);
  const pBase = new THREE.Mesh(
    new THREE.BoxGeometry(4.0, 2.6, 3.2),
    new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.55 })
  );
  pBase.position.y = 1.3;
  pBase.castShadow = true;
  perpus.add(pBase);
  const pRoof = new THREE.Mesh(
    new THREE.ConeGeometry(3.2, 1.8, 4),
    new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.5 })
  );
  pRoof.rotation.y = Math.PI / 4;
  pRoof.position.y = 3.5;
  perpus.add(pRoof);
  structures.push(perpus);

  // (3) Taman Bunga
  const taman = new THREE.Group();
  taman.position.set(-6.5, 0, 2.4);
  const fountain = new THREE.Mesh(
    new THREE.CylinderGeometry(1.6, 1.8, 0.6, 12),
    new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.2 })
  );
  fountain.position.y = 0.3;
  taman.add(fountain);
  taman.add(createTree(0.95));
  structures.push(taman);

  // (4) Pasar Jujur Madinah
  const pasar = new THREE.Group();
  pasar.position.set(6.5, 0, 2.4);
  const stall = new THREE.Mesh(
    new THREE.BoxGeometry(3.4, 2.0, 2.4),
    new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.65 })
  );
  stall.position.y = 1.0;
  pasar.add(stall);
  const awning = new THREE.Mesh(
    new THREE.BoxGeometry(3.8, 0.25, 2.8),
    new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.6 })
  );
  awning.position.y = 2.2;
  pasar.add(awning);
  structures.push(pasar);

  // (5) Jembatan Lengkung Emas
  const jembatan = new THREE.Group();
  jembatan.position.set(0, 0, -9.5);
  const arch = new THREE.Mesh(
    new THREE.TorusGeometry(3.2, 0.45, 10, 20, Math.PI),
    new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.35, metalness: 0.45 })
  );
  jembatan.add(arch);
  structures.push(jembatan);

  structures.forEach((s) => {
    s.scale.setScalar(0.001);
    root.add(s);
  });

  return {
    root,
    skyTop: 0x0284c7,
    skyBottom: 0xa5f3fc,
    fogColor: 0xcffafe,
    fogNear: 28,
    fogFar: 95,
    interactables,
    playerSpawn: new THREE.Vector3(0, 0, 2.6),
    cameraOffset: new THREE.Vector3(0, 6.2, 11.2),
    cameraLookOffset: new THREE.Vector3(0, 1.4, -3.5),
    updateWorld: (dt, elapsed, progress) => {
      topSign.position.y = 2.1 + Math.sin(elapsed * 2.5) * 0.1;
      structures.forEach((s, idx) => {
        const unlocked = progress >= idx + 1;
        const target = unlocked ? 1 : 0.001;
        s.scale.lerp(new THREE.Vector3(target, target, target), Math.min(1, dt * 6));
        s.visible = s.scale.x > 0.02;
      });
    },
    dispose: () => {
      grassTex.dispose();
      craftTopTex.dispose();
    },
  };
}

// 6. PORTAL DIMENSION EXPLORER (Green Mudah, Blue Sedang, Gold Sulit Portals + Light Stars)
function buildPortalDimension(): BuiltWorld {
  const root = new THREE.Group();
  const interactables: THREE.Object3D[] = [];
  const stoneTex = makeStoneTexture(6);
  const disposables: THREE.Texture[] = [stoneTex];

  root.add(makeSkyDome(0x1e1b4b, 0x4338ca));

  const plaza = new THREE.Mesh(
    new THREE.CylinderGeometry(12, 13, 1, 20),
    new THREE.MeshStandardMaterial({ map: stoneTex, color: 0xc7d2fe, roughness: 0.72 })
  );
  plaza.position.y = -0.5;
  plaza.receiveShadow = true;
  root.add(plaza);

  const portalSpecs: {
    diff: 'mudah' | 'sedang' | 'sulit';
    title: string;
    sub: string;
    hex: number;
    css: string;
    x: number;
    z: number;
  }[] = [
    { diff: 'mudah', title: 'PORTAL HIJAU', sub: 'Level MUDAH', hex: 0x22c55e, css: '#16a34a', x: -5.4, z: -4.8 },
    { diff: 'sedang', title: 'PORTAL BIRU', sub: 'Level SEDANG', hex: 0x3b82f6, css: '#2563eb', x: 0, z: -6.4 },
    { diff: 'sulit', title: 'PORTAL EMAS', sub: 'Level SULIT', hex: 0xf59e0b, css: '#d97706', x: 5.4, z: -4.8 },
  ];

  const rings: { mesh: THREE.Mesh; diff: 'mudah' | 'sedang' | 'sulit' }[] = [];
  let activeDiff: 'mudah' | 'sedang' | 'sulit' = 'mudah';

  for (const spec of portalSpecs) {
    const pg = new THREE.Group();
    pg.position.set(spec.x, 0, spec.z);
    pg.lookAt(0, 0, 4);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.1, 0.28, 12, 32),
      new THREE.MeshStandardMaterial({
        color: spec.hex,
        emissive: spec.hex,
        emissiveIntensity: 0.7,
        roughness: 0.2,
        metalness: 0.45,
      })
    );
    ring.position.y = 2.45;
    pg.add(ring);
    rings.push({ mesh: ring, diff: spec.diff });

    const vortex = new THREE.Mesh(
      new THREE.CircleGeometry(1.88, 24),
      new THREE.MeshBasicMaterial({
        color: spec.hex,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      })
    );
    vortex.position.y = 2.45;
    pg.add(vortex);

    const signTex = makeSignTexture(spec.title, spec.sub, spec.css);
    disposables.push(signTex);
    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.9, 0.16),
      new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.3 })
    );
    sign.position.y = 5.05;
    pg.add(sign);

    tagInteractable(pg, { kind: 'portal', difficulty: spec.diff, label: spec.title });
    interactables.push(pg);
    root.add(pg);
  }

  // Orbiting Light Stars collected
  const stars: THREE.Mesh[] = [];
  for (let i = 0; i < 15; i++) {
    const st = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.32, 0),
      new THREE.MeshStandardMaterial({
        color: 0xfef08a,
        emissive: 0xfacc15,
        emissiveIntensity: 0.85,
        roughness: 0.2,
      })
    );
    st.visible = false;
    stars.push(st);
    root.add(st);
  }

  return {
    root,
    skyTop: 0x1e1b4b,
    skyBottom: 0x4338ca,
    fogColor: 0x312e81,
    fogNear: 24,
    fogFar: 85,
    interactables,
    playerSpawn: new THREE.Vector3(0, 0, 2.2),
    cameraOffset: new THREE.Vector3(0, 4.8, 10.2),
    cameraLookOffset: new THREE.Vector3(0, 2.2, -5.2),
    setActivePortal: (diff) => {
      activeDiff = diff;
    },
    updateWorld: (dt, elapsed, progress) => {
      rings.forEach(({ mesh, diff }) => {
        const isAct = diff === activeDiff;
        mesh.rotation.z += dt * (isAct ? 2.6 : 0.7);
        const s = isAct ? 1.12 + Math.sin(elapsed * 4) * 0.04 : 0.94;
        mesh.scale.setScalar(s);
      });
      stars.forEach((st, idx) => {
        st.visible = idx < progress;
        if (st.visible) {
          const a = elapsed * 1.4 + idx * ((Math.PI * 2) / Math.max(1, progress));
          st.position.set(Math.cos(a) * 3.4, 2.8 + Math.sin(elapsed * 3 + idx) * 0.35, -1.5 + Math.sin(a) * 2.2);
          st.rotation.y += dt * 2.5;
        }
      });
    },
    dispose: () => {
      disposables.forEach((t) => t.dispose());
    },
  };
}

// 7. 3D BOARD ADVENTURE (Winding Giant Colorful Tiles + Tumbling 3D Dice)
function buildBoardAdventure(): BuiltWorld {
  const root = new THREE.Group();
  const interactables: THREE.Object3D[] = [];
  const grassTex = makeGrassTexture(10);
  const diceTexs = [1, 2, 3, 4, 5, 6].map((n) => makeDiceFaceTexture(n));

  root.add(makeSkyDome(0x2563eb, 0xfce7f3));

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 90),
    new THREE.MeshStandardMaterial({ map: grassTex, roughness: 0.9 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.3;
  ground.receiveShadow = true;
  root.add(ground);

  // Winding 24-tile board path
  const tileCoords: THREE.Vector3[] = [];
  const tileColors = [0x3b82f6, 0xa855f7, 0xfacc15]; // Blue PG, Purple PGK, Yellow B/S
  for (let i = 0; i < 24; i++) {
    const row = Math.floor(i / 6);
    const colInRow = i % 6;
    const col = row % 2 === 0 ? colInRow : 5 - colInRow;
    const x = (col - 2.5) * 2.6;
    const z = 4.2 - row * 3.2;
    tileCoords.push(new THREE.Vector3(x, 0.25, z));

    const tileMat = new THREE.MeshStandardMaterial({
      color: i === 23 ? 0xf59e0b : tileColors[i % 3],
      roughness: 0.45,
      metalness: 0.12,
    });
    const tile = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.5, 2.2), tileMat);
    tile.position.set(x, 0, z);
    tile.castShadow = true;
    tile.receiveShadow = true;
    root.add(tile);
  }

  // Giant 3D Tumbling Dice hovering overhead (Clickable!)
  const diceMats = diceTexs.map(
    (tex) => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35 })
  );
  const dice = new THREE.Mesh(new THREE.BoxGeometry(1.85, 1.85, 1.85), diceMats);
  dice.position.set(0, 4.4, -1.2);
  dice.castShadow = true;
  tagInteractable(dice, { kind: 'dice', label: 'Lempar Dadu 3D' });
  interactables.push(dice);
  root.add(dice);

  let spinTimer = 0;

  return {
    root,
    skyTop: 0x2563eb,
    skyBottom: 0xfce7f3,
    fogColor: 0xf5d0fe,
    fogNear: 28,
    fogFar: 95,
    interactables,
    playerSpawn: tileCoords[0].clone(),
    cameraOffset: new THREE.Vector3(0, 8.6, 11.4),
    cameraLookOffset: new THREE.Vector3(0, 1.2, -1.5),
    getPlayerTargetPos: (progress) => {
      const idx = Math.min(tileCoords.length - 1, Math.max(0, progress));
      return tileCoords[idx].clone();
    },
    rollDiceVisual: () => {
      spinTimer = 1.1;
    },
    updateWorld: (dt, elapsed) => {
      if (spinTimer > 0) {
        spinTimer = Math.max(0, spinTimer - dt);
        dice.rotation.x += dt * 15;
        dice.rotation.y += dt * 18;
        dice.position.y = 4.4 + Math.sin(spinTimer * Math.PI * 3) * 0.9;
      } else {
        dice.rotation.y += dt * 0.7;
        dice.position.y = 4.4 + Math.sin(elapsed * 2.2) * 0.2;
      }
    },
    dispose: () => {
      grassTex.dispose();
      diceTexs.forEach((t) => t.dispose());
    },
  };
}

// 8. ASTRO-SCANNER 3D (Futuristic Orbital Museum + Artifact Capsules + Orbiting Badges)
function buildAstroScanner(): BuiltWorld {
  const root = new THREE.Group();
  const interactables: THREE.Object3D[] = [];

  root.add(makeSkyDome(0x0f172a, 0x164e63));

  const deck = new THREE.Mesh(
    new THREE.CylinderGeometry(16, 16, 0.5, 32),
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.65 })
  );
  deck.position.y = -0.25;
  deck.receiveShadow = true;
  root.add(deck);

  const grid = new THREE.GridHelper(28, 28, 0x22d3ee, 0x1e3a5f);
  grid.position.y = 0.02;
  root.add(grid);

  // 4 Floating Futuristic Artifact Capsules
  const capsules: THREE.Group[] = [];
  const capPositions: [number, number][] = [
    [-5.2, -4.5],
    [-1.8, -6.2],
    [1.8, -6.2],
    [5.2, -4.5],
  ];
  const capColors = [0x22d3ee, 0xa855f7, 0xfacc15, 0x34d399];

  capPositions.forEach(([cx, cz], idx) => {
    const cap = new THREE.Group();
    cap.position.set(cx, 2.2, cz);

    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 0.95, 2.2, 16),
      new THREE.MeshStandardMaterial({
        color: 0xe0f2fe,
        transparent: true,
        opacity: 0.28,
        roughness: 0.1,
        metalness: 0.3,
      })
    );
    cap.add(glass);

    const artifact = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.38, 0.12, 48, 8),
      new THREE.MeshStandardMaterial({
        color: capColors[idx],
        emissive: capColors[idx],
        emissiveIntensity: 0.55,
        roughness: 0.2,
        metalness: 0.7,
      })
    );
    cap.add(artifact);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.15, 0.06, 8, 24),
      new THREE.MeshBasicMaterial({ color: capColors[idx] })
    );
    ring.rotation.x = Math.PI / 2;
    cap.add(ring);

    tagInteractable(cap, { kind: 'artifact_capsule', optionIndex: idx, label: `Artefak #${idx + 1}` });
    interactables.push(cap);
    capsules.push(cap);
    root.add(cap);
  });

  // Orbiting Achievement Badges around player
  const badges: THREE.Mesh[] = [];
  for (let i = 0; i < 12; i++) {
    const b = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.26, 0),
      new THREE.MeshStandardMaterial({
        color: 0xfacc15,
        emissive: 0xf59e0b,
        emissiveIntensity: 0.7,
        metalness: 0.6,
        roughness: 0.2,
      })
    );
    b.visible = false;
    badges.push(b);
    root.add(b);
  }

  return {
    root,
    skyTop: 0x0f172a,
    skyBottom: 0x164e63,
    fogColor: 0x0f172a,
    fogNear: 20,
    fogFar: 80,
    interactables,
    playerSpawn: new THREE.Vector3(0, 0.6, 2.2),
    cameraOffset: new THREE.Vector3(0, 4.4, 9.2),
    cameraLookOffset: new THREE.Vector3(0, 2.0, -5.0),
    updateWorld: (dt, elapsed, progress) => {
      capsules.forEach((cap, idx) => {
        cap.position.y = 2.3 + Math.sin(elapsed * 2.2 + idx * 1.1) * 0.24;
        cap.children[1].rotation.y += dt * 1.5;
        cap.children[1].rotation.x += dt * 0.7;
      });
      badges.forEach((b, idx) => {
        b.visible = idx < progress;
        if (b.visible) {
          const a = elapsed * 2.1 + idx * ((Math.PI * 2) / Math.max(1, progress));
          b.position.set(Math.cos(a) * 1.65, 1.9 + Math.sin(elapsed * 3 + idx) * 0.2, 2.2 + Math.sin(a) * 1.65);
          b.rotation.y += dt * 3;
        }
      });
    },
    dispose: () => {},
  };
}

// 9. CLIMB THE SUMMIT 3D (Multi-Biome Mountain + 5 Basecamps + Glowing Summit Beacon)
function buildClimbSummit(): BuiltWorld {
  const root = new THREE.Group();
  const interactables: THREE.Object3D[] = [];

  root.add(makeSkyDome(0x1d4ed8, 0xfed7aa));

  const biomes = [
    { name: 'Basecamp 1 · Padang Rumput', color: 0x22c55e, y: 0, z: 0 },
    { name: 'Basecamp 2 · Hutan Pinus', color: 0x15803d, y: 3.2, z: -6.5 },
    { name: 'Basecamp 3 · Tebing Awan', color: 0x64748b, y: 6.4, z: -13.0 },
    { name: 'Basecamp 4 · Punggung Salju', color: 0xe2e8f0, y: 9.6, z: -19.5 },
    { name: 'PUNCAK HIKMAH', color: 0xfacc15, y: 12.8, z: -26.0 },
  ];

  const disposables: THREE.Texture[] = [];

  biomes.forEach((b, idx) => {
    const plat = new THREE.Mesh(
      new THREE.CylinderGeometry(4.4 - idx * 0.35, 5.2 - idx * 0.35, 3.2, 10),
      new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.82 })
    );
    plat.position.set(0, b.y - 1.6, b.z);
    plat.receiveShadow = true;
    plat.castShadow = true;
    root.add(plat);

    // Basecamp tent / beacon
    if (idx < 4) {
      const tent = new THREE.Mesh(
        new THREE.ConeGeometry(0.95, 1.35, 4),
        new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.65 })
      );
      tent.position.set(-2.3, b.y + 0.675, b.z - 0.5);
      tent.castShadow = true;
      root.add(tent);
    } else {
      const beacon = new THREE.Mesh(
        new THREE.OctahedronGeometry(1.1, 0),
        new THREE.MeshStandardMaterial({
          color: 0xfef08a,
          emissive: 0xf59e0b,
          emissiveIntensity: 0.9,
          roughness: 0.2,
        })
      );
      beacon.position.set(0, b.y + 2.2, b.z);
      root.add(beacon);
    }

    const signTex = makeSignTexture(`POS ${idx + 1}`, b.name, idx === 4 ? '#d97706' : '#0f172a', '#fde047');
    disposables.push(signTex);
    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.85, 0.14),
      new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.35 })
    );
    sign.position.set(2.3, b.y + 1.4, b.z);
    root.add(sign);
  });

  // Stepped stone stairs connecting basecamps
  for (let i = 0; i < 4; i++) {
    for (let s = 1; s <= 4; s++) {
      const t = s / 5;
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(2.2, 0.35, 1.2),
        new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.8 })
      );
      step.position.set(0, i * 3.2 + t * 3.2 - 0.15, -i * 6.5 - t * 6.5);
      root.add(step);
    }
  }

  return {
    root,
    skyTop: 0x1d4ed8,
    skyBottom: 0xfed7aa,
    fogColor: 0xffedd5,
    fogNear: 26,
    fogFar: 95,
    interactables,
    playerSpawn: new THREE.Vector3(0, 0, 0.6),
    cameraOffset: new THREE.Vector3(3.6, 4.6, 8.2),
    cameraLookOffset: new THREE.Vector3(0, 1.8, -3.5),
    getPlayerTargetPos: (progress) => {
      const idx = Math.min(biomes.length - 1, Math.max(0, progress));
      return new THREE.Vector3(0, biomes[idx].y, biomes[idx].z + 0.6);
    },
    updateWorld: (_dt, _elapsed) => {},
    dispose: () => {
      disposables.forEach((t) => t.dispose());
    },
  };
}
