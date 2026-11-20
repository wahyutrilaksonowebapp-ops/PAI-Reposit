/**
 * Procedural Web Audio API sound effects synthesizer (zero external audio files).
 */
export class SoundFX {
  private ctx: AudioContext | null = null;
  public muted = false;

  private ensureContext(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private tone(
    freq: number,
    duration: number,
    type: OscillatorType = 'triangle',
    gainVal = 0.14,
    delay = 0,
    endFreq?: number
  ) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (endFreq !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, endFreq), now + duration);
    }
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(gainVal, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  public click() {
    this.tone(540, 0.06, 'sine', 0.09, 0, 720);
  }

  public jump() {
    this.tone(240, 0.16, 'triangle', 0.14, 0, 560);
  }

  public correct() {
    this.tone(523.25, 0.12, 'triangle', 0.16, 0);
    this.tone(659.25, 0.12, 'triangle', 0.16, 0.09);
    this.tone(783.99, 0.22, 'triangle', 0.18, 0.18);
  }

  public wrong() {
    this.tone(260, 0.18, 'sawtooth', 0.11, 0, 170);
    this.tone(180, 0.28, 'sawtooth', 0.11, 0.14, 110);
  }

  public levelUp() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((n, i) => this.tone(n, 0.18, 'triangle', 0.16, i * 0.08));
  }

  public buffFanfare() {
    const notes = [440, 554.37, 659.25, 880, 1108.73];
    notes.forEach((n, i) => this.tone(n, 0.22, 'sine', 0.17, i * 0.075));
  }

  public turbo() {
    this.tone(220, 0.35, 'sawtooth', 0.1, 0, 880);
    this.tone(440, 0.3, 'triangle', 0.12, 0.05, 1100);
  }

  public diceRoll() {
    for (let i = 0; i < 6; i++) {
      this.tone(300 + Math.random() * 450, 0.05, 'square', 0.06, i * 0.07);
    }
  }

  public scan() {
    this.tone(700, 0.12, 'sine', 0.12, 0, 1200);
    this.tone(1200, 0.18, 'sine', 0.12, 0.12, 900);
  }

  public build() {
    this.tone(330, 0.1, 'square', 0.08, 0);
    this.tone(440, 0.1, 'square', 0.08, 0.08);
    this.tone(660, 0.2, 'triangle', 0.14, 0.16);
  }

  public sabotage() {
    this.tone(620, 0.16, 'sawtooth', 0.13, 0, 190);
    this.tone(190, 0.25, 'square', 0.11, 0.15, 120);
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    return this.muted;
  }

  public playClick() { this.click(); }
  public playJump() { this.jump(); }
  public playCorrect() { this.correct(); }
  public playWrong() { this.wrong(); }
  public playLevelUp() { this.levelUp(); }
  public playBuffFanfare() { this.buffFanfare(); }
  public playTurbo() { this.turbo(); }
  public playDiceRoll() { this.diceRoll(); }
  public playScan() { this.scan(); }
  public playBuild() { this.build(); }
  public playSabotage() { this.sabotage(); }
}

export const soundFX = new SoundFX();
