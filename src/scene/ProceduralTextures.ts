import * as THREE from 'three';
import type { AvatarConfig } from '../types.ts';

function configureColorTexture(
  canvas: HTMLCanvasElement,
  repeatX = 1,
  repeatY = 1
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeatX > 1 || repeatY > 1) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
  }
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export function makeGrassTexture(repeat = 12): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#48a84c';
  ctx.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 650; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 1.5 + Math.random() * 4;
    ctx.fillStyle = i % 3 === 0 ? '#5ec258' : i % 3 === 1 ? '#3b8d40' : '#73cf66';
    ctx.fillRect(x, y, r, r * 1.6);
  }
  return configureColorTexture(canvas, repeat, repeat);
}

export function makePavingTexture(repeat = 8): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#d8d5cc';
  ctx.fillRect(0, 0, 256, 256);

  const tile = 64;
  for (let y = 0; y < 256; y += tile) {
    for (let x = 0; x < 256; x += tile) {
      const shade = 212 + Math.floor(Math.random() * 18);
      ctx.fillStyle = `rgb(${shade}, ${shade - 4}, ${shade - 12})`;
      ctx.fillRect(x + 2, y + 2, tile - 4, tile - 4);
    }
  }
  ctx.strokeStyle = '#aba69a';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 256; i += tile) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(256, i);
    ctx.stroke();
  }
  return configureColorTexture(canvas, repeat, repeat);
}

export function makeRoadTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, 512, 512);

  // Subtle asphalt grain
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.08)';
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 3, 6);
  }

  // Outer glowing edge stripes
  ctx.fillStyle = '#38bdf8';
  ctx.fillRect(10, 0, 12, 512);
  ctx.fillRect(490, 0, 12, 512);

  // 4 lanes dividers (3 dashed lines)
  ctx.fillStyle = '#f8fafc';
  for (const lx of [128, 256, 384]) {
    for (let y = 0; y < 512; y += 64) {
      ctx.fillRect(lx - 4, y + 10, 8, 34);
    }
  }

  return configureColorTexture(canvas, 1, 14);
}

export function makeStoneTexture(repeat = 4): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#8b95a5';
  ctx.fillRect(0, 0, 256, 256);

  for (let y = 0; y < 256; y += 32) {
    const offset = (y / 32) % 2 === 0 ? 0 : 32;
    for (let x = -32; x < 256; x += 64) {
      const c = 128 + Math.floor(Math.random() * 26);
      ctx.fillStyle = `rgb(${c}, ${c + 4}, ${c + 12})`;
      ctx.fillRect(x + offset + 2, y + 2, 60, 28);
    }
  }
  return configureColorTexture(canvas, repeat, repeat);
}

export function makeFlagTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 170;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#dc2626';
  ctx.fillRect(0, 0, 256, 85);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 85, 256, 85);

  // Subtle fabric weave
  ctx.fillStyle = 'rgba(0,0,0,0.04)';
  for (let y = 0; y < 170; y += 4) {
    ctx.fillRect(0, y, 256, 1);
  }
  return configureColorTexture(canvas, 1, 1);
}

export function makeContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 60);
  grad.addColorStop(0, 'rgba(15, 23, 42, 0.52)');
  grad.addColorStop(0.6, 'rgba(15, 23, 42, 0.18)');
  grad.addColorStop(1, 'rgba(15, 23, 42, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export function makeFaceTexture(avatar: AvatarConfig): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // Skin base
  ctx.fillStyle = avatar.skinColor;
  ctx.fillRect(0, 0, 256, 256);

  // Soft cheeks
  ctx.fillStyle = 'rgba(244, 114, 182, 0.22)';
  ctx.beginPath();
  ctx.arc(62, 152, 20, 0, Math.PI * 2);
  ctx.arc(194, 152, 20, 0, Math.PI * 2);
  ctx.fill();

  // Eyebrows
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(64, 78);
  ctx.quadraticCurveTo(86, 68, 108, 78);
  ctx.moveTo(148, 78);
  ctx.quadraticCurveTo(170, 68, 192, 78);
  ctx.stroke();

  // Eyes
  const drawRoundEye = (cx: number, cy: number) => {
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx - 5, cy - 5, 5, 0, Math.PI * 2);
    ctx.fill();
  };

  if (avatar.eyeStyle === 'smiling') {
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(86, 118, 16, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(170, 118, 16, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  } else if (avatar.eyeStyle === 'star') {
    const drawStar = (cx: number, cy: number) => {
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(cx, cy, 17, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#facc15';
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = (i * 4 * Math.PI) / 5 - Math.PI / 2;
        const r = 10;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    };
    drawStar(86, 112);
    drawStar(170, 112);
  } else if (avatar.eyeStyle === 'focused') {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(68, 102, 34, 18);
    ctx.fillRect(154, 102, 34, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(74, 106, 8, 8);
    ctx.fillRect(160, 106, 8, 8);
  } else {
    drawRoundEye(86, 112);
    drawRoundEye(170, 112);
  }

  // Glasses overlay
  if (avatar.eyeStyle === 'round_glasses') {
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 6;
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(86, 112, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(170, 112, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(114, 112);
    ctx.lineTo(142, 112);
    ctx.stroke();
  } else if (avatar.eyeStyle === 'square_glasses') {
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 6;
    ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
    ctx.fillRect(54, 88, 62, 46);
    ctx.strokeRect(54, 88, 62, 46);
    ctx.fillRect(140, 88, 62, 46);
    ctx.strokeRect(140, 88, 62, 46);
    ctx.beginPath();
    ctx.moveTo(116, 110);
    ctx.lineTo(140, 110);
    ctx.stroke();
  }

  // Nose
  ctx.fillStyle = 'rgba(120, 62, 30, 0.45)';
  ctx.strokeStyle = 'rgba(120, 62, 30, 0.6)';
  ctx.lineWidth = 5;
  if (avatar.noseStyle === 'button' || avatar.noseStyle === 'round') {
    ctx.beginPath();
    ctx.arc(128, 144, avatar.noseStyle === 'round' ? 9 : 6, 0, Math.PI * 2);
    ctx.fill();
  } else if (avatar.noseStyle === 'classic') {
    ctx.beginPath();
    ctx.moveTo(128, 126);
    ctx.lineTo(124, 148);
    ctx.lineTo(135, 148);
    ctx.stroke();
  } else if (avatar.noseStyle === 'cute') {
    ctx.beginPath();
    ctx.arc(128, 144, 6, 0, Math.PI);
    ctx.stroke();
  } else {
    ctx.fillRect(126, 140, 4, 8);
  }

  // Mouth
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  if (avatar.mouthStyle === 'wide_smile') {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(128, 174, 32, 0.12 * Math.PI, 0.88 * Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (avatar.mouthStyle === 'laugh') {
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(128, 172, 30, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(102, 172, 52, 10);
  } else if (avatar.mouthStyle === 'gentle') {
    ctx.beginPath();
    ctx.arc(128, 172, 22, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();
  } else if (avatar.mouthStyle === 'proud') {
    ctx.beginPath();
    ctx.moveTo(104, 184);
    ctx.quadraticCurveTo(132, 198, 156, 176);
    ctx.stroke();
  } else if (avatar.mouthStyle === 'surprised') {
    ctx.fillStyle = '#991b1b';
    ctx.beginPath();
    ctx.arc(128, 184, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(106, 184);
    ctx.lineTo(150, 184);
    ctx.stroke();
  }

  return configureColorTexture(canvas, 1, 1);
}

export function makeSignTexture(
  title: string,
  subtitle: string,
  bgColor: string,
  textColor = '#ffffff'
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, 512, 192);

  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 8;
  ctx.strokeRect(8, 8, 496, 176);

  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 42px "Fredoka", "Plus Jakarta Sans", sans-serif';
  ctx.fillText(title, 256, 76, 464);

  ctx.font = '600 24px "Plus Jakarta Sans", sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(subtitle, 256, 134, 464);

  return configureColorTexture(canvas, 1, 1);
}

export function makeAnswerPanelTexture(
  badge: string,
  label: string,
  bgHex: string
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = bgHex;
  ctx.fillRect(0, 0, 512, 256);

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 10;
  ctx.strokeRect(10, 10, 492, 236);

  // Badge circle
  ctx.fillStyle = 'rgba(15, 23, 42, 0.35)';
  ctx.beginPath();
  ctx.arc(82, 128, 46, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 54px "Fredoka", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(badge, 82, 132);

  // Wrapped text on right
  ctx.textAlign = 'left';
  ctx.font = 'bold 28px "Plus Jakarta Sans", sans-serif';
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > 330 && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
    if (lines.length >= 3) break;
  }
  if (line && lines.length < 4) lines.push(line);

  const lineH = 38;
  const startY = 128 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((l, i) => {
    ctx.fillText(l, 146, startY + i * lineH, 340);
  });

  return configureColorTexture(canvas, 1, 1);
}

export function makeDiceFaceTexture(pips: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 12;
  ctx.strokeRect(8, 8, 240, 240);

  const coords: Record<number, [number, number][]> = {
    1: [[128, 128]],
    2: [
      [72, 72],
      [184, 184],
    ],
    3: [
      [70, 70],
      [128, 128],
      [186, 186],
    ],
    4: [
      [72, 72],
      [184, 72],
      [72, 184],
      [184, 184],
    ],
    5: [
      [72, 72],
      [184, 72],
      [128, 128],
      [72, 184],
      [184, 184],
    ],
    6: [
      [72, 66],
      [184, 66],
      [72, 128],
      [184, 128],
      [72, 190],
      [184, 190],
    ],
  };

  ctx.fillStyle = pips === 1 ? '#dc2626' : '#0f172a';
  for (const [x, y] of coords[pips] ?? coords[1]) {
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.fill();
  }
  return configureColorTexture(canvas, 1, 1);
}

export function makeNameTagTexture(name: string, sub: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.beginPath();
  ctx.roundRect(8, 8, 368, 80, 20);
  ctx.fill();

  ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 30px "Fredoka", sans-serif';
  ctx.fillText(name, 192, 42, 340);

  ctx.fillStyle = '#fde047';
  ctx.font = '600 20px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(sub, 192, 72, 340);

  return configureColorTexture(canvas, 1, 1);
}
