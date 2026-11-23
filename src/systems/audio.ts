/**
 * Audio engine — zero-asset procedural sound.
 * WebAudio oscillators + noise buffers; gentle UI blips, beam whooshes and a
 * soft ambient pad per biome. No audio files ship in the bundle.
 */

type Osc = OscillatorType;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private ambientNodes: { stop: () => void }[] = [];
  enabled = true;
  musicEnabled = true;

  private ensure(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.0;
      this.musicGain.connect(this.master);
      // shared noise buffer
      const len = this.ctx.sampleRate * 1.2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private blip(freq: number, dur: number, type: Osc = 'sine', vol = 0.18, when = 0, slide = 0): void {
    const ctx = this.ensure();
    if (!ctx || !this.enabled) return;
    const t0 = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master!);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, vol = 0.12, hp = 800, when = 0): void {
    const ctx = this.ensure();
    if (!ctx || !this.enabled || !this.noiseBuf) return;
    const t0 = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /* ---- one-shot SFX ---- */

  tap(): void { this.blip(660, 0.07, 'sine', 0.1); }

  slide(): void {
    this.noise(0.16, 0.07, 1200);
    this.blip(330, 0.14, 'triangle', 0.08, 0, 220);
  }

  shiftSnap(): void { this.blip(520, 0.05, 'square', 0.05); }

  litOk(color: number): void {
    // rising arpeggio, base pitch varies by color mask for musical variety
    const base = 440 + color * 40;
    this.blip(base, 0.12, 'sine', 0.14);
    this.blip(base * 1.25, 0.12, 'sine', 0.12, 0.07);
    this.blip(base * 1.5, 0.2, 'sine', 0.12, 0.14);
  }

  litBad(): void { this.blip(200, 0.16, 'sawtooth', 0.06, 0, -60); }

  win(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((n, i) => this.blip(n, 0.35, 'sine', 0.16, i * 0.09));
    this.noise(0.5, 0.04, 3000, 0.1);
  }

  star(i: number): void { this.blip(880 + i * 220, 0.22, 'sine', 0.15, i * 0.18); }

  gem(): void {
    this.blip(1318, 0.09, 'sine', 0.12);
    this.blip(1760, 0.16, 'sine', 0.1, 0.06);
  }

  hint(): void {
    this.blip(880, 0.2, 'triangle', 0.1, 0, 440);
    this.blip(1320, 0.25, 'sine', 0.08, 0.1);
  }

  uiBack(): void { this.blip(392, 0.09, 'sine', 0.09, 0, -80); }

  undo(): void { this.blip(494, 0.1, 'triangle', 0.1, 0, -120); }

  /* ---- ambient music per biome ---- */

  stopAmbient(): void {
    for (const n of this.ambientNodes) n.stop();
    this.ambientNodes = [];
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.4);
    }
  }

  /** Slow evolving pad: 3 detuned oscillators + slow LFO filter sweep. */
  ambient(biomeIdx: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.musicEnabled) return;
    this.stopAmbient();
    // pentatonic-ish root sets per biome
    const roots = [220, 196, 174.61, 164.81, 146.83, 155.56, 130.81, 138.59, 123.47, 116.54];
    const root = roots[biomeIdx % roots.length];
    const t0 = ctx.currentTime;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.05, t0 + 2.5);
    g.connect(this.musicGain!);
    this.musicGain!.gain.setValueAtTime(1, t0);

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 900;
    filt.Q.value = 0.6;
    filt.connect(g);

    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.06;
    lfoGain.gain.value = 320;
    lfo.connect(lfoGain).connect(filt.frequency);
    lfo.start(t0);

    const voices: OscillatorNode[] = [];
    const partials = [1, 1.5, 2.0, 2.997];
    const types: Osc[] = ['sine', 'sine', 'triangle', 'sine'];
    partials.forEach((p, i) => {
      const o = ctx.createOscillator();
      o.type = types[i];
      o.frequency.value = root * p;
      o.detune.value = (i - 1.5) * 6;
      const vg = ctx.createGain();
      vg.gain.value = 0.5 / (i + 1);
      o.connect(vg).connect(filt);
      o.start(t0);
      voices.push(o);
    });

    this.ambientNodes.push({
      stop: () => {
        const t = ctx.currentTime;
        g.gain.linearRampToValueAtTime(0, t + 0.4);
        for (const v of voices) v.stop(t + 0.5);
        lfo.stop(t + 0.5);
      },
    });
  }
}

export const sfx = new Sfx();
