import { describe, expect, test } from 'bun:test';
import { resolveNoteFrequencies } from '../schema/tuning.ts';
import {
  createEngineState,
  engineAllNotesOff,
  engineNoteOff,
  engineNoteOn,
  engineNotePitch,
  engineSetWah,
  MAX_VOICES,
  renderBlock,
} from './engine.ts';

/**
 * Computes fundamental frequency (Hz) of a steady-state buffer using a Hann-windowed
 * radix-2 FFT over the full harmonica range [100 Hz, 8000 Hz] followed by exact
 * DTFT golden-section peak refinement (< 0.1 cent precision across 200..3000 Hz).
 */
function estimateFundamentalHz(samples: Float32Array, sampleRate: number): number {
  const n = samples.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  // Apply Hann window
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[i] = samples[i]! * w;
  }

  // In-place radix-2 Cooley-Tukey FFT
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wLenRe = Math.cos(ang);
    const wLenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j]!;
        const uIm = im[i + j]!;
        const vRe = re[i + j + half]! * wRe - im[i + j + half]! * wIm;
        const vIm = re[i + j + half]! * wIm + im[i + j + half]! * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextRe;
      }
    }
  }

  const minBin = Math.max(1, Math.floor((100 * n) / sampleRate));
  const maxBin = Math.min((n >> 1) - 1, Math.ceil((8000 * n) / sampleRate));
  let peakBin = minBin;
  let peakMagSq = -1;
  for (let k = minBin; k <= maxBin; k++) {
    const magSq = re[k]! * re[k]! + im[k]! * im[k]!;
    if (magSq > peakMagSq) {
      peakMagSq = magSq;
      peakBin = k;
    }
  }

  // Refine around peakBin with exact Hann-windowed DTFT magnitude via golden-section search
  const binHz = sampleRate / n;
  let lo = Math.max(80, (peakBin - 1.5) * binHz);
  let hi = (peakBin + 1.5) * binHz;

  const dtftMagSq = (freqHz: number): number => {
    const step = (2 * Math.PI * freqHz) / sampleRate;
    let sumRe = 0;
    let sumIm = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
      const x = samples[i]! * w;
      const a = step * i;
      sumRe += x * Math.cos(a);
      sumIm -= x * Math.sin(a);
    }
    return sumRe * sumRe + sumIm * sumIm;
  };

  const phi = (Math.sqrt(5) - 1) / 2;
  let c = hi - phi * (hi - lo);
  let d = lo + phi * (hi - lo);
  let fc = dtftMagSq(c);
  let fd = dtftMagSq(d);

  for (let iter = 0; iter < 22; iter++) {
    if (fc > fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - phi * (hi - lo);
      fc = dtftMagSq(c);
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + phi * (hi - lo);
      fd = dtftMagSq(d);
    }
  }

  return (lo + hi) * 0.5;
}

function centsError(detectedHz: number, expectedHz: number): number {
  return 1200 * Math.log2(detectedHz / expectedHz);
}

describe('Free-Reed DSP Engine (src/dsp/engine.ts)', () => {
  test('renders exact silence when idle', () => {
    const state = createEngineState();
    const out = new Float32Array(512);
    out.fill(0.5); // verify buffer is overwritten cleanly
    const peak = renderBlock(out, 48000, state);

    expect(peak).toBe(0);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(0);
    }
  });

  test('all samples remain finite and strictly bounded (|s| <= 1.0) under heavy polyphony and high pitch', () => {
    const state = createEngineState();
    const sampleRate = 44100;

    // Trigger full 12-voice dense chord including Hole 10 blow & high F# harp
    for (let v = 0; v < MAX_VOICES; v++) {
      const freq = 261.63 * Math.pow(1.22, v);
      engineNoteOn(state, v, freq, 1.0, 0.85, (v % 10) + 1);
    }

    const out = new Float32Array(128);
    let globalPeak = 0;
    for (let block = 0; block < 40; block++) {
      if (block === 10) engineSetWah(state, 0.0);
      if (block === 20) engineSetWah(state, 1.0);
      if (block === 30) engineAllNotesOff(state);

      const peak = renderBlock(out, sampleRate, state);
      expect(Number.isFinite(peak)).toBe(true);
      expect(peak).toBeLessThanOrEqual(1.0);

      for (let i = 0; i < out.length; i++) {
        const s = out[i]!;
        expect(Number.isFinite(s)).toBe(true);
        expect(Math.abs(s)).toBeLessThanOrEqual(1.0);
        if (Math.abs(s) > globalPeak) globalPeak = Math.abs(s);
      }
    }

    expect(globalPeak).toBeGreaterThan(0.2);
    expect(globalPeak).toBeLessThanOrEqual(1.0);
  });

  test('is strictly deterministic and block-size independent (64 vs 128 vs 1024 samples)', () => {
    const sampleRate = 48000;
    const totalSamples = 1024;

    const renderWithBlockSize = (blockSize: number): Float32Array => {
      const state = createEngineState();
      engineNoteOn(state, 1, 523.251, 0.9, 0.4, 4);
      engineNoteOn(state, 2, 659.255, 0.75, 0.4, 5);
      // Initiate a pitch bend & wah movement so per-sample smoothing is exercised
      engineNotePitch(state, 1, 493.883);
      engineSetWah(state, 0.85);

      const full = new Float32Array(totalSamples);
      const chunk = new Float32Array(blockSize);
      for (let offset = 0; offset < totalSamples; offset += blockSize) {
        renderBlock(chunk, sampleRate, state);
        full.set(chunk, offset);
      }
      return full;
    };

    const out1024 = renderWithBlockSize(1024);
    const out128 = renderWithBlockSize(128);
    const out64 = renderWithBlockSize(64);

    let maxDiff128 = 0;
    let maxDiff64 = 0;
    for (let i = 0; i < totalSamples; i++) {
      const d128 = Math.abs(out1024[i]! - out128[i]!);
      const d64 = Math.abs(out1024[i]! - out64[i]!);
      if (d128 > maxDiff128) maxDiff128 = d128;
      if (d64 > maxDiff64) maxDiff64 = d64;
    }

    expect(maxDiff128).toBeLessThan(1e-6);
    expect(maxDiff64).toBeLessThan(1e-6);
  });

  test('produces accurate fundamental pitch within ±5 cents across blow, draw, bends, high keys, and hole 10 blow', () => {
    const sampleRate = 48000;
    const warmupSamples = 3072; // skip attack + breath onset transient
    const analysisSamples = 8192;

    const cases: Array<{
      label: string;
      harpKey: 'C' | 'G' | 'F#';
      holes: number[];
      action: 'blow' | 'draw';
      bendSteps: 0 | 1 | 2 | 3;
    }> = [
      { label: 'C harp Hole 1 blow (C4)', harpKey: 'C', holes: [1], action: 'blow', bendSteps: 0 },
      { label: 'C harp Hole 2 draw -2\'\' (F4)', harpKey: 'C', holes: [2], action: 'draw', bendSteps: 2 },
      { label: 'C harp Hole 3 draw (B4)', harpKey: 'C', holes: [3], action: 'draw', bendSteps: 0 },
      { label: 'C harp Hole 3 draw -3\' (Bb4)', harpKey: 'C', holes: [3], action: 'draw', bendSteps: 1 },
      { label: 'C harp Hole 3 draw -3\'\' (A4)', harpKey: 'C', holes: [3], action: 'draw', bendSteps: 2 },
      { label: 'C harp Hole 3 draw -3\'\'\' (Ab4)', harpKey: 'C', holes: [3], action: 'draw', bendSteps: 3 },
      { label: 'C harp Hole 4 blow (C5)', harpKey: 'C', holes: [4], action: 'blow', bendSteps: 0 },
      { label: 'C harp Hole 4 draw (D5)', harpKey: 'C', holes: [4], action: 'draw', bendSteps: 0 },
      { label: 'C harp Hole 10 blow (C7 ~2093 Hz)', harpKey: 'C', holes: [10], action: 'blow', bendSteps: 0 },
      { label: 'C harp Hole 10 blow bend 10\'\' (Bb6)', harpKey: 'C', holes: [10], action: 'blow', bendSteps: 2 },
      { label: 'G harp Hole 4 blow (G4)', harpKey: 'G', holes: [4], action: 'blow', bendSteps: 0 },
      { label: 'F# harp Hole 10 blow (~2960 Hz)', harpKey: 'F#', holes: [10], action: 'blow', bendSteps: 0 },
    ];

    for (const tc of cases) {
      const [expectedHz] = resolveNoteFrequencies(
        { holes: tc.holes, action: tc.action, bendSteps: tc.bendSteps },
        'richter',
        tc.harpKey,
      );
      expect(expectedHz).toBeDefined();

      const state = createEngineState();
      engineNoteOn(state, 1, expectedHz!, 0.85, 0.55, tc.holes[0]!);

      const warmup = new Float32Array(warmupSamples);
      renderBlock(warmup, sampleRate, state);

      const steady = new Float32Array(analysisSamples);
      renderBlock(steady, sampleRate, state);

      const detectedHz = estimateFundamentalHz(steady, sampleRate);
      const errCents = Math.abs(centsError(detectedHz, expectedHz!));

      expect(errCents).toBeLessThanOrEqual(5.0);
    }
  });

  test('smoothly glides pitch on engineNotePitch and decays cleanly to silence on engineNoteOff', () => {
    const sampleRate = 48000;
    const state = createEngineState();

    // Start at Hole 3 draw (B4 = 493.883 Hz), bend down to -3'' (A4 = 440.0 Hz)
    engineNoteOn(state, 7, 493.883, 0.85, 0.5, 3);
    renderBlock(new Float32Array(2048), sampleRate, state);

    engineNotePitch(state, 7, 440.0);
    renderBlock(new Float32Array(4096), sampleRate, state); // allow glide to settle

    const steady = new Float32Array(8192);
    renderBlock(steady, sampleRate, state);
    const detectedHz = estimateFundamentalHz(steady, sampleRate);
    expect(Math.abs(centsError(detectedHz, 440.0))).toBeLessThanOrEqual(5.0);

    // Release and verify convergence back to silence
    engineNoteOff(state, 7);
    const releaseBuf = new Float32Array(24000); // 0.5 s > 15x release tau
    renderBlock(releaseBuf, sampleRate, state);

    const tail = new Float32Array(512);
    const tailPeak = renderBlock(tail, sampleRate, state);
    expect(tailPeak).toBe(0);
  });

  test('wah filter noticeably darkens high frequencies when cupped (wah = 0 vs wah = 1)', () => {
    const sampleRate = 48000;
    const measureHighPitchRms = (wah: number): number => {
      const state = createEngineState();
      engineNoteOn(state, 1, 2093.0, 0.85, wah, 10);
      renderBlock(new Float32Array(2048), sampleRate, state);
      const buf = new Float32Array(4096);
      renderBlock(buf, sampleRate, state);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        sumSq += buf[i]! * buf[i]!;
      }
      return Math.sqrt(sumSq / buf.length);
    };

    const cuppedRms = measureHighPitchRms(0.0);
    const openRms = measureHighPitchRms(1.0);
    expect(openRms).toBeGreaterThan(cuppedRms * 1.4);
  });
});
