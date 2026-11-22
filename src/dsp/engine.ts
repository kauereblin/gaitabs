/**
 * Pure TypeScript free-reed harmonica synthesizer.
 *
 * Design invariants (SPEC.md §2 & §6):
 * - Zero heap allocations inside `renderBlock()` / `renderBlockRange()`.
 * - Zero React, Zustand, Zod, or browser DOM/WebAudio dependencies.
 * - Deterministic and strictly block-size independent (all smoothing and filter
 *   updates occur per-sample).
 * - Every output sample is finite (`Number.isFinite(s)`) and bounded (`|s| <= 1.0`).
 */

export const MAX_VOICES = 12 as const;

const TWO_PI = Math.PI * 2;
const TABLE_SIZE = 2048;
const TABLE_STRIDE = TABLE_SIZE + 1; // +1 wrap sample for branchless linear interpolation
const MIP_HARMONICS = [64, 48, 32, 24, 16, 12, 8, 6, 4, 2, 1] as const;
const NUM_MIPS = MIP_HARMONICS.length;

// Envelope stages
const ENV_IDLE = 0;
const ENV_ATTACK = 1;
const ENV_DECAY = 2;
const ENV_SUSTAIN = 3;
const ENV_RELEASE = 4;

// Free-reed amplitude envelope timings (seconds)
const ATTACK_SEC = 0.022;
const DECAY_SEC = 0.048;
const SUSTAIN_LEVEL = 0.85;
const RELEASE_TAU_SEC = 0.032;
const BREATH_TAU_SEC = 0.038;
const PITCH_GLIDE_TAU_SEC = 0.012;
const WAH_SMOOTH_TAU_SEC = 0.018;
const VIBRATO_RATE_HZ = 5.4;

const MIN_FREQ_HZ = 30;
const MAX_FREQ_HZ = 12000;
const MASTER_DRIVE = 0.58;

/**
 * Pre-computed band-limited free-reed wavetable bank (allocated once at module init).
 * All mipmaps share the same fundamental scale so transitions across pitch ranges
 * never jump in loudness, while keeping every partial strictly below Nyquist.
 */
const WAVETABLES = buildFreeReedMipmaps();

function buildFreeReedMipmaps(): Float32Array {
  const bank = new Float32Array(NUM_MIPS * TABLE_STRIDE);

  // Build raw harmonic sums for every mipmap
  let peakMip0 = 0;
  for (let m = 0; m < NUM_MIPS; m++) {
    const maxH = MIP_HARMONICS[m]!;
    const base = m * TABLE_STRIDE;

    for (let k = 1; k <= maxH; k++) {
      let amp: number;
      if (k === 1) {
        amp = 1.0;
      } else if (k === 2) {
        amp = 0.52;
      } else if (k === 3) {
        amp = 0.45;
      } else if (k === 4) {
        amp = 0.26;
      } else if (k === 5) {
        amp = 0.22;
      } else {
        const oddBoost = k % 2 === 1 ? 0.92 : 0.68;
        amp = oddBoost / Math.pow(k, 1.28);
      }

      // Lanczos sigma factor reduces Gibbs ringing for truncated upper partials
      if (k > 1 && maxH > 2) {
        const x = (Math.PI * k) / (maxH + 1);
        amp *= Math.sin(x) / x;
      }

      const phaseStep = (TWO_PI * k) / TABLE_SIZE;
      for (let i = 0; i < TABLE_SIZE; i++) {
        bank[base + i] = bank[base + i]! + amp * Math.sin(phaseStep * i);
      }
    }

    // Wrap guard sample
    bank[base + TABLE_SIZE] = bank[base]!;

    if (m === 0) {
      for (let i = 0; i < TABLE_SIZE; i++) {
        const absVal = Math.abs(bank[base + i]!);
        if (absVal > peakMip0) peakMip0 = absVal;
      }
    }
  }

  // Normalize all tables by mip0's peak (and guarantee <= 1.0 per table)
  const sharedScale = peakMip0 > 1e-6 ? 1.0 / peakMip0 : 1.0;
  for (let m = 0; m < NUM_MIPS; m++) {
    const base = m * TABLE_STRIDE;
    let tablePeak = 0;
    for (let i = 0; i < TABLE_SIZE; i++) {
      const scaled = bank[base + i]! * sharedScale;
      bank[base + i] = scaled;
      const absVal = Math.abs(scaled);
      if (absVal > tablePeak) tablePeak = absVal;
    }
    if (tablePeak > 1.0) {
      const inv = 1.0 / tablePeak;
      for (let i = 0; i < TABLE_SIZE; i++) {
        bank[base + i] = bank[base + i]! * inv;
      }
    }
    bank[base + TABLE_SIZE] = bank[base]!;
  }

  return bank;
}

function readWavetable(mipIndex: number, phase01: number): number {
  const scaled = phase01 * TABLE_SIZE;
  const idx = scaled | 0;
  const frac = scaled - idx;
  const base = mipIndex * TABLE_STRIDE + idx;
  const s0 = WAVETABLES[base]!;
  const s1 = WAVETABLES[base + 1]!;
  return s0 + (s1 - s0) * frac;
}

function sampleFreeReed(phase01: number, freqHz: number, sampleRate: number): number {
  const safeFreq = freqHz > MIN_FREQ_HZ ? freqHz : MIN_FREQ_HZ;
  const maxAllowedH = (0.45 * sampleRate) / safeFreq;

  // Pick the highest-resolution mipmap whose max harmonic <= maxAllowedH
  if (maxAllowedH >= MIP_HARMONICS[0]!) {
    return readWavetable(0, phase01);
  }
  const lastIdx = NUM_MIPS - 1;
  if (maxAllowedH <= MIP_HARMONICS[lastIdx]!) {
    return readWavetable(lastIdx, phase01);
  }

  let m = 1;
  while (m < lastIdx && MIP_HARMONICS[m]! > maxAllowedH) {
    m++;
  }

  // Smooth crossfade between safe mipmap `m` and lower-harmonic mipmap `m + 1`
  // when approaching the lower threshold (eliminates timbre stepping on bends)
  const highH = MIP_HARMONICS[m - 1]!;
  const curH = MIP_HARMONICS[m]!;
  const sCur = readWavetable(m, phase01);
  if (m < lastIdx) {
    const nextH = MIP_HARMONICS[m + 1]!;
    const span = highH - curH;
    const t = span > 0 ? (maxAllowedH - curH) / span : 1;
    if (t < 0.25 && nextH < curH) {
      const blend = t * 4.0;
      const sLow = readWavetable(m + 1, phase01);
      return sLow + (sCur - sLow) * blend;
    }
  }
  return sCur;
}

function clampFinite(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export interface EngineState {
  // Pre-allocated SoA voice pool (size = MAX_VOICES)
  voiceStage: Uint8Array;
  voiceId: Int32Array;
  voiceHole: Int32Array;
  voiceAge: Int32Array;
  voicePhase: Float64Array;
  voiceFreq: Float64Array;
  voiceTargetFreq: Float64Array;
  voiceVelocity: Float32Array;
  voiceEnv: Float32Array;
  voiceBreathEnv: Float32Array;
  voiceBreathLp: Float32Array;
  voiceBreathHp: Float32Array;
  voiceBreathPrevIn: Float32Array;
  voiceVibratoPhase: Float64Array;
  voiceVibratoDepth: Float32Array;

  // Monotonic voice age counter for deterministic voice stealing
  ageCounter: number;

  // Deterministic PRNG state (xorshift32, never 0)
  rngState: number;

  // Master hand-cupping ("wah") filter target & smoothed value (0..1)
  wahTarget: number;
  wahCurrent: number;
  wahCoeffValue: number;

  // Cached sampleRate & derived per-sample coefficients
  cachedSampleRate: number;
  attackStep: number;
  decayStep: number;
  releaseDecay: number;
  breathDecay: number;
  pitchGlideAlpha: number;
  wahSmoothAlpha: number;
  breathLpAlpha: number;
  breathHpAlpha: number;

  // Mouth formant peaking biquad (Direct Form II Transposed)
  formantB0: number;
  formantB1: number;
  formantB2: number;
  formantA1: number;
  formantA2: number;
  formantZ1: number;
  formantZ2: number;

  // Hand-cupping ("wah") lowpass biquad (Direct Form II Transposed)
  wahB0: number;
  wahB1: number;
  wahB2: number;
  wahA1: number;
  wahA2: number;
  wahZ1: number;
  wahZ2: number;

  // Lightweight zero-alloc metronome / count-in woodblock click
  clickEnv: number;
  clickPhase: number;
  clickFreqHz: number;

  // Diagnostic peak tracker for telemetry
  lastBlockPeak: number;
}

export function createEngineState(): EngineState {
  const voiceId = new Int32Array(MAX_VOICES);
  voiceId.fill(-1);

  return {
    voiceStage: new Uint8Array(MAX_VOICES),
    voiceId,
    voiceHole: new Int32Array(MAX_VOICES),
    voiceAge: new Int32Array(MAX_VOICES),
    voicePhase: new Float64Array(MAX_VOICES),
    voiceFreq: new Float64Array(MAX_VOICES),
    voiceTargetFreq: new Float64Array(MAX_VOICES),
    voiceVelocity: new Float32Array(MAX_VOICES),
    voiceEnv: new Float32Array(MAX_VOICES),
    voiceBreathEnv: new Float32Array(MAX_VOICES),
    voiceBreathLp: new Float32Array(MAX_VOICES),
    voiceBreathHp: new Float32Array(MAX_VOICES),
    voiceBreathPrevIn: new Float32Array(MAX_VOICES),
    voiceVibratoPhase: new Float64Array(MAX_VOICES),
    voiceVibratoDepth: new Float32Array(MAX_VOICES),

    ageCounter: 0,
    rngState: 0x13579bdf,

    wahTarget: 0.5,
    wahCurrent: 0.5,
    wahCoeffValue: -1,

    cachedSampleRate: 0,
    attackStep: 0,
    decayStep: 0,
    releaseDecay: 0,
    breathDecay: 0,
    pitchGlideAlpha: 0,
    wahSmoothAlpha: 0,
    breathLpAlpha: 0,
    breathHpAlpha: 0,

    formantB0: 1,
    formantB1: 0,
    formantB2: 0,
    formantA1: 0,
    formantA2: 0,
    formantZ1: 0,
    formantZ2: 0,

    wahB0: 1,
    wahB1: 0,
    wahB2: 0,
    wahA1: 0,
    wahA2: 0,
    wahZ1: 0,
    wahZ2: 0,

    clickEnv: 0,
    clickPhase: 0,
    clickFreqHz: 880,

    lastBlockPeak: 0,
  };
}

export function resetEngineState(state: EngineState): void {
  state.voiceStage.fill(ENV_IDLE);
  state.voiceId.fill(-1);
  state.voiceHole.fill(0);
  state.voiceAge.fill(0);
  state.voicePhase.fill(0);
  state.voiceFreq.fill(0);
  state.voiceTargetFreq.fill(0);
  state.voiceVelocity.fill(0);
  state.voiceEnv.fill(0);
  state.voiceBreathEnv.fill(0);
  state.voiceBreathLp.fill(0);
  state.voiceBreathHp.fill(0);
  state.voiceBreathPrevIn.fill(0);
  state.voiceVibratoPhase.fill(0);
  state.voiceVibratoDepth.fill(0);

  state.ageCounter = 0;
  state.rngState = 0x13579bdf;
  state.wahTarget = 0.5;
  state.wahCurrent = 0.5;
  state.wahCoeffValue = -1;
  state.cachedSampleRate = 0;

  state.formantZ1 = 0;
  state.formantZ2 = 0;
  state.wahZ1 = 0;
  state.wahZ2 = 0;

  state.clickEnv = 0;
  state.clickPhase = 0;
  state.clickFreqHz = 880;
  state.lastBlockPeak = 0;
}

function updateSampleRateCoeffs(state: EngineState, sampleRate: number): void {
  state.cachedSampleRate = sampleRate;
  state.attackStep = 1.0 / Math.max(1, ATTACK_SEC * sampleRate);
  state.decayStep = (1.0 - SUSTAIN_LEVEL) / Math.max(1, DECAY_SEC * sampleRate);
  state.releaseDecay = Math.exp(-1.0 / Math.max(1, RELEASE_TAU_SEC * sampleRate));
  state.breathDecay = Math.exp(-1.0 / Math.max(1, BREATH_TAU_SEC * sampleRate));
  state.pitchGlideAlpha = 1.0 - Math.exp(-1.0 / Math.max(1, PITCH_GLIDE_TAU_SEC * sampleRate));
  state.wahSmoothAlpha = 1.0 - Math.exp(-1.0 / Math.max(1, WAH_SMOOTH_TAU_SEC * sampleRate));

  // Breath noise bandpass: 1-pole LP (~3800 Hz) + 1-pole HP (~700 Hz)
  state.breathLpAlpha = 1.0 - Math.exp((-TWO_PI * 3800) / sampleRate);
  state.breathHpAlpha = Math.exp((-TWO_PI * 700) / sampleRate);

  // Mouth/comb formant peaking EQ (~1150 Hz, Q = 1.4, +3.0 dB)
  const formantFreq = Math.min(1150, 0.35 * sampleRate);
  const w0 = (TWO_PI * formantFreq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const q = 1.4;
  const aGain = Math.pow(10, 3.0 / 40);
  const alpha = sinW0 / (2 * q);

  const b0 = 1 + alpha * aGain;
  const b1 = -2 * cosW0;
  const b2 = 1 - alpha * aGain;
  const a0 = 1 + alpha / aGain;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha / aGain;
  const invA0 = 1 / a0;

  state.formantB0 = b0 * invA0;
  state.formantB1 = b1 * invA0;
  state.formantB2 = b2 * invA0;
  state.formantA1 = a1 * invA0;
  state.formantA2 = a2 * invA0;

  // Force wah biquad refresh on current sampleRate
  state.wahCoeffValue = -1;
}

function updateWahBiquad(state: EngineState, sampleRate: number): void {
  const wah = clampFinite(state.wahCurrent, 0, 1, 0.5);
  state.wahCoeffValue = wah;

  // Hand-cupped wah cutoff: 1200 Hz (cupped) -> ~3500 Hz (neutral 0.5) -> 10200 Hz (open)
  const rawCutoff = 1200 * Math.pow(8.5, wah);
  const cutoff = Math.min(rawCutoff, 0.42 * sampleRate);
  const q = 1.65 - 0.9 * wah; // Slight bluesy resonance when cupped

  const w0 = (TWO_PI * cutoff) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * q);

  const b0 = (1 - cosW0) * 0.5;
  const b1 = 1 - cosW0;
  const b2 = (1 - cosW0) * 0.5;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;
  const invA0 = 1 / a0;

  state.wahB0 = b0 * invA0;
  state.wahB1 = b1 * invA0;
  state.wahB2 = b2 * invA0;
  state.wahA1 = a1 * invA0;
  state.wahA2 = a2 * invA0;
}

function findVoiceSlotForNoteOn(state: EngineState, voiceId: number): number {
  // 1. Reuse existing voice with matching voiceId (clean retrigger)
  for (let i = 0; i < MAX_VOICES; i++) {
    if (state.voiceStage[i] !== ENV_IDLE && state.voiceId[i] === voiceId) {
      return i;
    }
  }

  // 2. First idle voice
  for (let i = 0; i < MAX_VOICES; i++) {
    if (state.voiceStage[i] === ENV_IDLE) {
      return i;
    }
  }

  // 3. Oldest releasing voice
  let bestSlot = -1;
  let bestAge = 0x7fffffff;
  for (let i = 0; i < MAX_VOICES; i++) {
    if (state.voiceStage[i] === ENV_RELEASE && state.voiceAge[i]! < bestAge) {
      bestAge = state.voiceAge[i]!;
      bestSlot = i;
    }
  }
  if (bestSlot >= 0) return bestSlot;

  // 4. Oldest active voice
  bestSlot = 0;
  bestAge = state.voiceAge[0]!;
  for (let i = 1; i < MAX_VOICES; i++) {
    if (state.voiceAge[i]! < bestAge) {
      bestAge = state.voiceAge[i]!;
      bestSlot = i;
    }
  }
  return bestSlot;
}

export function engineNoteOn(
  state: EngineState,
  voiceId: number,
  freqHz: number,
  velocity: number = 0.85,
  wah: number = 0.5,
  hole: number = 0,
  vibratoDepth: number = 0,
): void {
  const safeFreq = clampFinite(freqHz, MIN_FREQ_HZ, MAX_FREQ_HZ, 440);
  const safeVel = clampFinite(velocity, 0.01, 1.0, 0.85);
  const safeWah = clampFinite(wah, 0.0, 1.0, 0.5);
  const safeVib = clampFinite(vibratoDepth, 0.0, 0.05, 0.0);

  const slot = findVoiceSlotForNoteOn(state, voiceId);
  const isRetrigger =
    state.voiceStage[slot] !== ENV_IDLE && state.voiceId[slot] === voiceId;

  state.ageCounter = (state.ageCounter + 1) & 0x3fffffff;
  state.voiceId[slot] = voiceId | 0;
  state.voiceHole[slot] = hole >= 1 && hole <= 10 ? hole | 0 : 0;
  state.voiceAge[slot] = state.ageCounter;
  state.voiceStage[slot] = ENV_ATTACK;
  state.voiceVelocity[slot] = safeVel;
  state.voiceTargetFreq[slot] = safeFreq;
  state.voiceVibratoDepth[slot] = safeVib;

  if (!isRetrigger) {
    state.voiceFreq[slot] = safeFreq;
    state.voicePhase[slot] = 0;
    state.voiceEnv[slot] = 0;
    state.voiceBreathLp[slot] = 0;
    state.voiceBreathHp[slot] = 0;
    state.voiceBreathPrevIn[slot] = 0;
    state.voiceVibratoPhase[slot] = 0;
  }

  state.voiceBreathEnv[slot] = 1.0;
  state.wahTarget = safeWah;
}

export function engineNotePitch(
  state: EngineState,
  voiceId: number,
  freqHz: number,
): void {
  const safeFreq = clampFinite(freqHz, MIN_FREQ_HZ, MAX_FREQ_HZ, 440);
  for (let i = 0; i < MAX_VOICES; i++) {
    if (state.voiceStage[i] !== ENV_IDLE && state.voiceId[i] === voiceId) {
      state.voiceTargetFreq[i] = safeFreq;
    }
  }
}

export function engineNoteOff(state: EngineState, voiceId: number): void {
  for (let i = 0; i < MAX_VOICES; i++) {
    if (state.voiceStage[i] !== ENV_IDLE && state.voiceId[i] === voiceId) {
      // Ensure a rapid cold-start click (noteOn + noteOff before a render quantum)
      // still emits a brief audible reed burst instead of decaying from 0.
      if (state.voiceStage[i] === ENV_ATTACK && state.voiceEnv[i]! < 0.25) {
        state.voiceEnv[i] = 0.25;
      }
      state.voiceStage[i] = ENV_RELEASE;
    }
  }
}

export function engineAllNotesOff(state: EngineState): void {
  for (let i = 0; i < MAX_VOICES; i++) {
    if (state.voiceStage[i] !== ENV_IDLE) {
      state.voiceStage[i] = ENV_RELEASE;
    }
  }
}

export function engineSetWah(state: EngineState, wah: number): void {
  state.wahTarget = clampFinite(wah, 0.0, 1.0, 0.5);
}

export function engineTriggerClick(state: EngineState, accent: boolean): void {
  state.clickEnv = accent ? 0.65 : 0.42;
  state.clickFreqHz = accent ? 1046.5 : 784.0;
  state.clickPhase = 0;
}

/**
 * Writes currently active hole numbers (1..10) into `outHoles` without allocating
 * a new array (clears and pushes in place).
 */
export function collectActiveHoles(state: EngineState, outHoles: number[]): void {
  outHoles.length = 0;
  let mask = 0;
  for (let i = 0; i < MAX_VOICES; i++) {
    const stage = state.voiceStage[i]!;
    if (stage !== ENV_IDLE && stage !== ENV_RELEASE) {
      const hole = state.voiceHole[i]!;
      if (hole >= 1 && hole <= 10) {
        mask |= 1 << hole;
      }
    }
  }
  for (let h = 1; h <= 10; h++) {
    if ((mask & (1 << h)) !== 0) {
      outHoles.push(h);
    }
  }
}

function nextNoiseSample(state: EngineState): number {
  let x = state.rngState | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  if (x === 0) x = 0x13579bdf;
  state.rngState = x;
  return (x | 0) * 4.656612873077393e-10; // [-1, 1)
}

/**
 * Pure, zero-allocation block renderer over a slice `[offset, offset + length)`
 * of `out`. Used directly by both `renderBlock()` and the sample-accurate
 * in-worklet sequencer (avoiding `Float32Array.subarray()` allocations).
 *
 * Returns the peak absolute amplitude rendered in `[offset, offset + length)`.
 */
export function renderBlockRange(
  out: Float32Array,
  offset: number,
  length: number,
  sampleRate: number,
  state: EngineState,
): number {
  const safeOffset = offset < 0 ? 0 : offset;
  const maxLen = out.length - safeOffset;
  const count = length < maxLen ? length : maxLen;
  if (count <= 0) return 0;

  const sr =
    Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 192000
      ? sampleRate
      : 48000;

  if (state.cachedSampleRate !== sr) {
    updateSampleRateCoeffs(state, sr);
  }

  const invSr = 1.0 / sr;
  const attackStep = state.attackStep;
  const decayStep = state.decayStep;
  const releaseDecay = state.releaseDecay;
  const breathDecay = state.breathDecay;
  const pitchGlideAlpha = state.pitchGlideAlpha;
  const wahSmoothAlpha = state.wahSmoothAlpha;
  const breathLpAlpha = state.breathLpAlpha;
  const breathHpAlpha = state.breathHpAlpha;
  const clickDecay = Math.exp(-1.0 / Math.max(1, 0.016 * sr));

  let peak = 0;

  for (let s = 0; s < count; s++) {
    // Smooth wah per-sample (strictly block-size independent)
    const wahDiff = state.wahTarget - state.wahCurrent;
    if (Math.abs(wahDiff) > 1e-9) {
      state.wahCurrent += wahDiff * wahSmoothAlpha;
    } else {
      state.wahCurrent = state.wahTarget;
    }

    if (Math.abs(state.wahCurrent - state.wahCoeffValue) > 1e-9) {
      updateWahBiquad(state, sr);
    }

    let mix = 0;
    let activeCount = 0;

    for (let v = 0; v < MAX_VOICES; v++) {
      const stage = state.voiceStage[v]!;
      if (stage === ENV_IDLE) continue;

      activeCount++;

      // 1. Amplitude ADSR envelope
      let env = state.voiceEnv[v]!;
      if (stage === ENV_ATTACK) {
        env += attackStep;
        if (env >= 1.0) {
          env = 1.0;
          state.voiceStage[v] = ENV_DECAY;
        }
      } else if (stage === ENV_DECAY) {
        env -= decayStep;
        if (env <= SUSTAIN_LEVEL) {
          env = SUSTAIN_LEVEL;
          state.voiceStage[v] = ENV_SUSTAIN;
        }
      } else if (stage === ENV_RELEASE) {
        env *= releaseDecay;
        if (env < 1e-5) {
          env = 0;
          state.voiceEnv[v] = 0;
          state.voiceStage[v] = ENV_IDLE;
          state.voiceId[v] = -1;
          state.voiceHole[v] = 0;
          continue;
        }
      }
      state.voiceEnv[v] = env;

      // 2. Smooth per-sample pitch glide for bends & glissandos
      let freq = state.voiceFreq[v]!;
      const targetFreq = state.voiceTargetFreq[v]!;
      const freqDiff = targetFreq - freq;
      if (Math.abs(freqDiff) > 1e-6) {
        freq += freqDiff * pitchGlideAlpha;
      } else {
        freq = targetFreq;
      }
      state.voiceFreq[v] = freq;

      // Optional vibrato articulation
      const vibDepth = state.voiceVibratoDepth[v]!;
      let instFreq = freq;
      if (vibDepth > 0) {
        let vibPhase = state.voiceVibratoPhase[v]! + VIBRATO_RATE_HZ * invSr;
        if (vibPhase >= 1.0) vibPhase -= 1.0;
        state.voiceVibratoPhase[v] = vibPhase;
        instFreq = freq * (1.0 + vibDepth * Math.sin(TWO_PI * vibPhase));
      }

      // 3. Band-limited free-reed wavetable oscillator
      let phase = state.voicePhase[v]!;
      const reedSample = sampleFreeReed(phase, instFreq, sr);
      phase += instFreq * invSr;
      phase -= Math.floor(phase);
      state.voicePhase[v] = phase;

      // 4. Filtered breath-noise attack transient + subtle air floor
      let breath = 0;
      let breathEnv = state.voiceBreathEnv[v]!;
      if (breathEnv > 1e-5 || env > 1e-4) {
        const white = nextNoiseSample(state);
        const prevIn = state.voiceBreathPrevIn[v]!;
        const hp = breathHpAlpha * (state.voiceBreathHp[v]! + white - prevIn);
        const lp = state.voiceBreathLp[v]! + breathLpAlpha * (hp - state.voiceBreathLp[v]!);
        state.voiceBreathPrevIn[v] = white;
        state.voiceBreathHp[v] = hp;
        state.voiceBreathLp[v] = lp;

        breath = lp * (breathEnv * 0.14 + env * 0.008);
        breathEnv *= breathDecay;
        if (breathEnv < 1e-5) breathEnv = 0;
        state.voiceBreathEnv[v] = breathEnv;
      }

      const vel = state.voiceVelocity[v]!;
      mix += (reedSample * env + breath) * vel;
    }

    // Fast exact-silence path when idle and filter states have settled
    const filterEnergy =
      Math.abs(state.formantZ1) +
      Math.abs(state.formantZ2) +
      Math.abs(state.wahZ1) +
      Math.abs(state.wahZ2);

    if (activeCount === 0 && state.clickEnv <= 1e-6 && filterEnergy < 1e-12) {
      state.formantZ1 = 0;
      state.formantZ2 = 0;
      state.wahZ1 = 0;
      state.wahZ2 = 0;
      out[safeOffset + s] = 0;
      continue;
    }

    // 5. Dynamic mouth formant peaking biquad (Direct Form II Transposed)
    const fOut = state.formantB0 * mix + state.formantZ1;
    let fZ1 = state.formantB1 * mix - state.formantA1 * fOut + state.formantZ2;
    let fZ2 = state.formantB2 * mix - state.formantA2 * fOut;
    if (Math.abs(fZ1) < 1e-24 || !Number.isFinite(fZ1)) fZ1 = 0;
    if (Math.abs(fZ2) < 1e-24 || !Number.isFinite(fZ2)) fZ2 = 0;
    state.formantZ1 = fZ1;
    state.formantZ2 = fZ2;

    // 6. Hand-cupping ("wah") resonant lowpass biquad (Direct Form II Transposed)
    const wOut = state.wahB0 * fOut + state.wahZ1;
    let wZ1 = state.wahB1 * fOut - state.wahA1 * wOut + state.wahZ2;
    let wZ2 = state.wahB2 * fOut - state.wahA2 * wOut;
    if (Math.abs(wZ1) < 1e-24 || !Number.isFinite(wZ1)) wZ1 = 0;
    if (Math.abs(wZ2) < 1e-24 || !Number.isFinite(wZ2)) wZ2 = 0;
    state.wahZ1 = wZ1;
    state.wahZ2 = wZ2;

    // 7. Optional count-in woodblock metronome click (bypasses wah filter)
    let clickSample = 0;
    if (state.clickEnv > 1e-6) {
      clickSample = Math.sin(TWO_PI * state.clickPhase) * state.clickEnv;
      let cp = state.clickPhase + state.clickFreqHz * invSr;
      if (cp >= 1.0) cp -= Math.floor(cp);
      state.clickPhase = cp;
      state.clickEnv *= clickDecay;
      if (state.clickEnv < 1e-6) state.clickEnv = 0;
    }

    // 8. Soft-clip output limiter with strict finite & [-1, 1] guarantee
    let finalSample = Math.tanh(wOut * MASTER_DRIVE + clickSample);
    if (!Number.isFinite(finalSample)) {
      finalSample = 0;
      state.formantZ1 = 0;
      state.formantZ2 = 0;
      state.wahZ1 = 0;
      state.wahZ2 = 0;
    } else if (finalSample > 1.0) {
      finalSample = 1.0;
    } else if (finalSample < -1.0) {
      finalSample = -1.0;
    }

    out[safeOffset + s] = finalSample;
    const absSample = finalSample < 0 ? -finalSample : finalSample;
    if (absSample > peak) peak = absSample;
  }

  state.lastBlockPeak = peak;
  return peak;
}

/**
 * Pure, zero-allocation top-level block render entrypoint (`SPEC.md` §6).
 */
export function renderBlock(
  out: Float32Array,
  sampleRate: number,
  state: EngineState,
): number {
  return renderBlockRange(out, 0, out.length, sampleRate, state);
}
