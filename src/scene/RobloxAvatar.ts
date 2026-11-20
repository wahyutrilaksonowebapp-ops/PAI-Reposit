import * as THREE from 'three';
import type { AvatarConfig } from '../types.ts';
import {
  makeContactShadowTexture,
  makeFaceTexture,
  makeNameTagTexture,
} from './ProceduralTextures.ts';

export type AvatarAnimState =
  | 'idle'
  | 'walk'
  | 'jump'
  | 'fall'
  | 'celebrate'
  | 'drive'
  | 'fly';

let sharedShadowTex: THREE.CanvasTexture | null = null;
function getShadowTex(): THREE.CanvasTexture {
  if (!sharedShadowTex) sharedShadowTex = makeContactShadowTexture();
  return sharedShadowTex;
}

export class RobloxAvatar {
  public readonly group = new THREE.Group();
  private bodyRig = new THREE.Group();
  private headGroup = new THREE.Group();
  private leftArmPivot = new THREE.Group();
  private rightArmPivot = new THREE.Group();
  private leftLegPivot = new THREE.Group();
  private rightLegPivot = new THREE.Group();
  private jetpackFlames: THREE.Mesh[] = [];
  private nameSprite: THREE.Sprite | null = null;
  private faceTexture: THREE.CanvasTexture | null = null;
  private nameTexture: THREE.CanvasTexture | null = null;

  public animState: AvatarAnimState = 'idle';
  private animClock = Math.random() * 10;

  constructor(config: AvatarConfig, labelName?: string, labelSub?: string) {
    this.group.add(this.bodyRig);

    // Soft contact shadow disc at ground pivot
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 1.15),
      new THREE.MeshBasicMaterial({
        map: getShadowTex(),
        transparent: true,
        depthWrite: false,
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.015;
    this.group.add(shadow);

    this.applyConfig(config);
    if (labelName) {
      this.setLabel(labelName, labelSub ?? '');
    }
  }

  setLabel(name: string, sub: string): void {
    if (this.nameTexture) this.nameTexture.dispose();
    this.nameTexture = makeNameTagTexture(name, sub);
    if (!this.nameSprite) {
      const mat = new THREE.SpriteMaterial({
        map: this.nameTexture,
        transparent: true,
        depthTest: false,
      });
      this.nameSprite = new THREE.Sprite(mat);
      this.nameSprite.scale.set(1.6, 0.4, 1);
      this.nameSprite.position.set(0, 2.38, 0);
      this.group.add(this.nameSprite);
    } else {
      (this.nameSprite.material as THREE.SpriteMaterial).map = this.nameTexture;
      (this.nameSprite.material as THREE.SpriteMaterial).needsUpdate = true;
    }
  }

  applyConfig(cfg: AvatarConfig): void {
    this.clearRig();
    this.jetpackFlames = [];

    const skinMat = new THREE.MeshStandardMaterial({
      color: cfg.skinColor,
      roughness: 0.65,
      metalness: 0.02,
    });
    const shirtMat = new THREE.MeshStandardMaterial({
      color: cfg.shirtColor,
      roughness: 0.6,
      metalness: 0.05,
    });
    const pantsMat = new THREE.MeshStandardMaterial({
      color: cfg.pantsColor,
      roughness: 0.72,
      metalness: 0.04,
    });
    const shoeMat = new THREE.MeshStandardMaterial({
      color: cfg.shoeColor,
      roughness: 0.45,
      metalness: 0.12,
    });
    const hairMat = new THREE.MeshStandardMaterial({
      color: cfg.hairColor,
      roughness: 0.65,
      metalness: 0.04,
    });
    const bagMat = new THREE.MeshStandardMaterial({
      color: cfg.bagColor,
      roughness: 0.5,
      metalness: 0.12,
    });

    // === LEGS & SHOES (bottom-center pivot y = 0) ===
    const buildLeg = (pivot: THREE.Group, xPos: number) => {
      pivot.position.set(xPos, 0.72, 0);

      if (cfg.pantsStyle === 'celana_pendek') {
        const upper = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.34, 0.28), pantsMat);
        upper.position.y = -0.17;
        upper.castShadow = true;
        pivot.add(upper);

        const shin = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 0.22), skinMat);
        shin.position.y = -0.45;
        shin.castShadow = true;
        pivot.add(shin);
      } else {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.56, 0.28), pantsMat);
        leg.position.y = -0.28;
        leg.castShadow = true;
        pivot.add(leg);
      }

      // Shoe
      const shoeHeight = cfg.shoeStyle === 'boots' ? 0.22 : 0.16;
      const shoe = new THREE.Mesh(
        new THREE.BoxGeometry(0.29, shoeHeight, 0.38),
        shoeMat
      );
      shoe.position.set(0, -0.72 + shoeHeight / 2, 0.04);
      shoe.castShadow = true;
      pivot.add(shoe);

      // White sole trim for sneakers/sport/racing
      if (cfg.shoeStyle === 'sneakers' || cfg.shoeStyle === 'sport' || cfg.shoeStyle === 'racing') {
        const sole = new THREE.Mesh(
          new THREE.BoxGeometry(0.3, 0.05, 0.4),
          new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5 })
        );
        sole.position.set(0, -0.695, 0.04);
        pivot.add(sole);
      }
      this.bodyRig.add(pivot);
    };

    buildLeg(this.leftLegPivot, -0.17);
    buildLeg(this.rightLegPivot, 0.17);

    // Rok panjang overlay for muslimah / rok_panjang
    if (cfg.pantsStyle === 'rok_panjang' || cfg.shirtStyle === 'gamis_zamrud') {
      const skirt = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.42, 0.62, 12),
        cfg.shirtStyle === 'gamis_zamrud' ? shirtMat : pantsMat
      );
      skirt.position.set(0, 0.48, 0);
      skirt.castShadow = true;
      this.bodyRig.add(skirt);
    }

    // === TORSO ===
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.72, 0.38), shirtMat);
    torso.position.set(0, 1.08, 0);
    torso.castShadow = true;
    torso.receiveShadow = true;
    this.bodyRig.add(torso);

    // Shirt details
    if (cfg.shirtStyle === 'seragam_sd') {
      const tie = new THREE.Mesh(
        new THREE.BoxGeometry(0.11, 0.34, 0.05),
        new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.5 })
      );
      tie.position.set(0, 1.15, 0.2);
      this.bodyRig.add(tie);
    } else if (cfg.shirtStyle === 'koko_emas' || cfg.shirtStyle === 'gamis_zamrud') {
      const trim = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.52, 0.04),
        new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.3, metalness: 0.45 })
      );
      trim.position.set(0, 1.14, 0.2);
      this.bodyRig.add(trim);
    } else if (cfg.shirtStyle === 'pramuka') {
      const scarf = new THREE.Mesh(
        new THREE.ConeGeometry(0.18, 0.32, 4),
        new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.6 })
      );
      scarf.rotation.x = Math.PI;
      scarf.position.set(0, 1.24, 0.2);
      this.bodyRig.add(scarf);
    } else if (cfg.shirtStyle === 'batik') {
      const accent = new THREE.Mesh(
        new THREE.BoxGeometry(0.69, 0.16, 0.39),
        new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.55 })
      );
      accent.position.set(0, 0.94, 0);
      this.bodyRig.add(accent);
    } else if (cfg.shirtStyle === 'sport_jacket' || cfg.shirtStyle === 'hoodie') {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.69, 0.12, 0.39),
        new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5 })
      );
      stripe.position.set(0, 1.16, 0);
      this.bodyRig.add(stripe);
    }

    // === ARMS ===
    const buildArm = (pivot: THREE.Group, xPos: number) => {
      pivot.position.set(xPos, 1.38, 0);
      const sleeveLen =
        cfg.shirtStyle === 'koko_emas' ||
        cfg.shirtStyle === 'gamis_zamrud' ||
        cfg.shirtStyle === 'hoodie' ||
        cfg.shirtStyle === 'sport_jacket'
          ? 0.48
          : 0.28;
      const sleeve = new THREE.Mesh(
        new THREE.BoxGeometry(0.24, sleeveLen, 0.26),
        shirtMat
      );
      sleeve.position.y = -sleeveLen / 2;
      sleeve.castShadow = true;
      pivot.add(sleeve);

      const forearmLen = 0.62 - sleeveLen;
      const hand = new THREE.Mesh(
        new THREE.BoxGeometry(0.21, forearmLen + 0.08, 0.22),
        skinMat
      );
      hand.position.y = -sleeveLen - forearmLen / 2;
      hand.castShadow = true;
      pivot.add(hand);

      this.bodyRig.add(pivot);
    };
    buildArm(this.leftArmPivot, -0.47);
    buildArm(this.rightArmPivot, 0.47);

    // === HEAD & FACE ===
    this.headGroup.position.set(0, 1.72, 0);
    if (this.faceTexture) this.faceTexture.dispose();
    this.faceTexture = makeFaceTexture(cfg);
    const faceMat = new THREE.MeshStandardMaterial({
      map: this.faceTexture,
      roughness: 0.55,
      metalness: 0.02,
    });
    // Box faces order: +X, -X, +Y, -Y, +Z (front), -Z (back)
    const headMats = [skinMat, skinMat, skinMat, skinMat, faceMat, skinMat];
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.54, 0.54), headMats);
    head.castShadow = true;
    this.headGroup.add(head);

    // === HAIR / PECI / HIJAB / HAT ===
    if (cfg.hairStyle === 'peci_hitam' || cfg.hairStyle === 'peci_putih') {
      const peciColor = cfg.hairStyle === 'peci_putih' ? 0xf8fafc : 0x111827;
      const peci = new THREE.Mesh(
        new THREE.BoxGeometry(0.56, 0.24, 0.58),
        new THREE.MeshStandardMaterial({ color: peciColor, roughness: 0.7 })
      );
      peci.position.set(0, 0.32, 0);
      peci.castShadow = true;
      this.headGroup.add(peci);

      const goldBand = new THREE.Mesh(
        new THREE.BoxGeometry(0.57, 0.04, 0.59),
        new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.35, metalness: 0.5 })
      );
      goldBand.position.set(0, 0.22, 0);
      this.headGroup.add(goldBand);
    } else if (cfg.hairStyle === 'hijab_syari' || cfg.hairStyle === 'hijab_sporty') {
      const hoodTop = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.6), hairMat);
      hoodTop.position.set(0, 0.26, -0.02);
      this.headGroup.add(hoodTop);

      const hoodBack = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.62, 0.26), hairMat);
      hoodBack.position.set(0, -0.04, -0.2);
      this.headGroup.add(hoodBack);

      const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.56, 0.52), hairMat);
      sideL.position.set(-0.27, 0, -0.02);
      this.headGroup.add(sideL);

      const sideR = sideL.clone();
      sideR.position.x = 0.27;
      this.headGroup.add(sideR);

      if (cfg.hairStyle === 'hijab_syari') {
        const drape = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.44, 0.44), hairMat);
        drape.position.set(0, -0.42, 0.01);
        this.headGroup.add(drape);
      }
    } else if (cfg.hairStyle === 'topi_sekolah') {
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(0.58, 0.2, 0.58),
        new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.6 })
      );
      cap.position.set(0, 0.3, 0);
      this.headGroup.add(cap);
      const brim = new THREE.Mesh(
        new THREE.BoxGeometry(0.54, 0.05, 0.28),
        new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.55 })
      );
      brim.position.set(0, 0.21, 0.36);
      this.headGroup.add(brim);
    } else if (cfg.hairStyle === 'spiky') {
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.16, 0.58), hairMat);
      base.position.set(0, 0.28, -0.02);
      this.headGroup.add(base);
      for (let i = -1; i <= 1; i++) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.24, 5), hairMat);
        spike.position.set(i * 0.16, 0.44, 0.06);
        spike.rotation.x = 0.22;
        this.headGroup.add(spike);
      }
    } else if (cfg.hairStyle === 'curly') {
      for (let x = -0.22; x <= 0.22; x += 0.15) {
        for (let z = -0.22; z <= 0.18; z += 0.15) {
          const puff = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), hairMat);
          puff.position.set(x, 0.32, z);
          this.headGroup.add(puff);
        }
      }
    } else {
      // short_neat
      const hairTop = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.17, 0.58), hairMat);
      hairTop.position.set(0, 0.28, -0.01);
      this.headGroup.add(hairTop);
      const hairBack = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.36, 0.14), hairMat);
      hairBack.position.set(0, 0.08, -0.24);
      this.headGroup.add(hairBack);
    }

    this.bodyRig.add(this.headGroup);

    // === BAG / JETPACK ===
    if (cfg.bagStyle === 'jetpack') {
      const pack = new THREE.Mesh(
        new THREE.BoxGeometry(0.46, 0.5, 0.22),
        new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.3, metalness: 0.65 })
      );
      pack.position.set(0, 1.12, -0.29);
      this.bodyRig.add(pack);

      for (const tx of [-0.14, 0.14]) {
        const thruster = new THREE.Mesh(
          new THREE.CylinderGeometry(0.08, 0.1, 0.46, 10),
          bagMat
        );
        thruster.position.set(tx, 1.08, -0.36);
        this.bodyRig.add(thruster);

        const flame = new THREE.Mesh(
          new THREE.ConeGeometry(0.07, 0.28, 8),
          new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
        );
        flame.rotation.x = Math.PI;
        flame.position.set(tx, 0.72, -0.36);
        flame.visible = false;
        this.jetpackFlames.push(flame);
        this.bodyRig.add(flame);
      }
    } else if (cfg.bagStyle !== 'none') {
      const bagW = cfg.bagStyle === 'selempang' ? 0.32 : 0.48;
      const bagH = cfg.bagStyle === 'ransel_petualang' ? 0.58 : 0.46;
      const bag = new THREE.Mesh(new THREE.BoxGeometry(bagW, bagH, 0.22), bagMat);
      bag.position.set(0, 1.08, -0.28);
      bag.castShadow = true;
      this.bodyRig.add(bag);

      const pocket = new THREE.Mesh(
        new THREE.BoxGeometry(bagW * 0.76, bagH * 0.44, 0.07),
        new THREE.MeshStandardMaterial({
          color: cfg.bagStyle === 'tas_islami' ? 0xfacc15 : 0xf8fafc,
          roughness: 0.5,
        })
      );
      pocket.position.set(0, 0.98, -0.4);
      this.bodyRig.add(pocket);
    }
  }

  private clearRig(): void {
    const clearChildren = (obj: THREE.Object3D) => {
      while (obj.children.length > 0) {
        const c = obj.children[0];
        obj.remove(c);
      }
    };
    clearChildren(this.headGroup);
    clearChildren(this.leftArmPivot);
    clearChildren(this.rightArmPivot);
    clearChildren(this.leftLegPivot);
    clearChildren(this.rightLegPivot);
    clearChildren(this.bodyRig);
  }

  update(dt: number): void {
    this.animClock += dt;
    const t = this.animClock;

    for (const f of this.jetpackFlames) {
      f.visible = this.animState === 'fly' || this.animState === 'jump';
      if (f.visible) {
        f.scale.set(1, 0.75 + Math.sin(t * 28) * 0.35, 1);
      }
    }

    if (this.animState === 'walk') {
      const swing = Math.sin(t * 10) * 0.65;
      this.leftLegPivot.rotation.x = swing;
      this.rightLegPivot.rotation.x = -swing;
      this.leftArmPivot.rotation.x = -swing * 0.85;
      this.rightArmPivot.rotation.x = swing * 0.85;
      this.bodyRig.position.y = Math.abs(Math.sin(t * 10)) * 0.07;
      this.bodyRig.rotation.x = 0.05;
    } else if (this.animState === 'jump') {
      this.leftArmPivot.rotation.x = -2.4;
      this.rightArmPivot.rotation.x = -2.4;
      this.leftLegPivot.rotation.x = 0.45;
      this.rightLegPivot.rotation.x = -0.35;
      this.bodyRig.position.y = 0;
      this.bodyRig.rotation.x = 0;
    } else if (this.animState === 'fall') {
      this.leftArmPivot.rotation.x = -2.8 + Math.sin(t * 18) * 0.35;
      this.rightArmPivot.rotation.x = -2.8 - Math.sin(t * 18) * 0.35;
      this.leftLegPivot.rotation.x = Math.sin(t * 16) * 0.5;
      this.rightLegPivot.rotation.x = -Math.sin(t * 16) * 0.5;
      this.bodyRig.rotation.x = 0.35;
    } else if (this.animState === 'celebrate') {
      this.leftArmPivot.rotation.x = -2.6 + Math.sin(t * 14) * 0.25;
      this.rightArmPivot.rotation.x = -2.6 - Math.sin(t * 14) * 0.25;
      this.leftLegPivot.rotation.x = 0;
      this.rightLegPivot.rotation.x = 0;
      this.bodyRig.position.y = Math.abs(Math.sin(t * 9)) * 0.26;
      this.bodyRig.rotation.x = 0;
    } else if (this.animState === 'drive') {
      this.leftArmPivot.rotation.x = -1.1;
      this.rightArmPivot.rotation.x = -1.1;
      this.leftLegPivot.rotation.x = -1.1;
      this.rightLegPivot.rotation.x = -1.1;
      this.bodyRig.position.y = -0.15;
      this.bodyRig.rotation.x = 0;
    } else if (this.animState === 'fly') {
      this.leftArmPivot.rotation.x = -0.5;
      this.rightArmPivot.rotation.x = -0.5;
      this.leftLegPivot.rotation.x = 0.25;
      this.rightLegPivot.rotation.x = 0.35;
      this.bodyRig.position.y = 0.35 + Math.sin(t * 4) * 0.14;
      this.bodyRig.rotation.x = 0.15;
    } else {
      // idle breathing
      this.leftLegPivot.rotation.x *= 0.85;
      this.rightLegPivot.rotation.x *= 0.85;
      this.leftArmPivot.rotation.x = Math.sin(t * 2.2) * 0.08;
      this.rightArmPivot.rotation.x = -Math.sin(t * 2.2) * 0.08;
      this.bodyRig.position.y = Math.sin(t * 2.5) * 0.025;
      this.bodyRig.rotation.x = 0;
    }
  }

  dispose(): void {
    this.faceTexture?.dispose();
    this.nameTexture?.dispose();
  }
}
