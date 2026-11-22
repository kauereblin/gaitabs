import {
  engineNoteOff,
  engineNoteOn,
  engineTriggerClick,
  renderBlockRange,
  type EngineState,
} from './engine.ts';
import {
  DSP_PPQ,
  type ScheduledReedEvent,
  type TransportCommand,
} from './types.ts';

const MAX_SEQ_SLOTS = 12;
const SEQ_VOICE_ID_BASE = 10000;
const COUNT_IN_BEATS = 4;
const COUNT_IN_TICKS = COUNT_IN_BEATS * DSP_PPQ;
const EPS_TICK = 1e-7;

export type SequencerEventKind = 'noteOn' | 'noteOff' | 'click' | 'loop';

export type SequencerEventHook = (
  kind: SequencerEventKind,
  tick: number,
  sampleFrame: number,
  detail: number,
) => void;

/**
 * Warps a straight PPQ tick into a swung tick according to `swingPercent` (50..75).
 *
 * - On-beats (`0, 480, 960, ...`) are never shifted.
 * - Off-beat 8th notes (`240, 720, ...`) shift to `(swingPercent / 100) * 480`
 *   within each beat (e.g. `50%` = straight 240, `66.67%` = triplet 320, `75%` = 360).
 * - Sub-divisions within each half-beat interpolate piecewise-linearly so event
 *   ordering is strictly preserved.
 */
export function applySwingTick(tick: number, swingPercent: number): number {
  if (!Number.isFinite(tick)) return 0;
  const clampedSwing = Math.max(50, Math.min(75, swingPercent));
  if (clampedSwing <= 50) return tick;

  const beatLen = DSP_PPQ;
  const halfBeat = beatLen * 0.5;
  const beatIndex = Math.floor(tick / beatLen);
  const posInBeat = tick - beatIndex * beatLen;
  const swingMid = (clampedSwing / 100) * beatLen;

  let warpedPos: number;
  if (posInBeat <= halfBeat) {
    warpedPos = (posInBeat / halfBeat) * swingMid;
  } else {
    warpedPos = swingMid + ((posInBeat - halfBeat) / halfBeat) * (beatLen - swingMid);
  }

  return beatIndex * beatLen + warpedPos;
}

export interface SequencerState {
  // Loaded score (updated on `loadScore`, read-only during audio render)
  events: ScheduledReedEvent[];
  eventStartTicks: Float64Array;
  eventEndTicks: Float64Array;
  bpm: number;
  swingPercent: number;
  totalTicks: number;

  // Transport state
  playing: boolean;
  recordMode: boolean;
  metronomeEnabled: boolean;
  nextMetronomeClickTick: number;
  speed: number;
  loopActive: boolean;
  loopStartTick: number;
  loopEndTick: number;

  // Drift-free sample-accurate clock
  currentTickFloat: number;
  segmentStartTick: number;
  segmentSamples: number;
  lastTicksPerSample: number;
  sampleFrame: number;
  nextEventIndex: number;

  // 4-beat count-in state
  inCountIn: boolean;
  countInElapsedTicks: number;
  countInSamples: number;
  countInBeat: number;
  nextCountInClickTick: number;

  // Pre-allocated active sequencer voice slots (zero heap alloc in render loop)
  slotActive: Uint8Array;
  slotEndTick: Float64Array;
  slotVoiceId: Int32Array;
  slotEventIndex: Int32Array;
  slotHole: Int32Array;

  // Diagnostic counters (zero heap alloc)
  totalTriggers: number;
  loopWrapCount: number;
  clickCount: number;
  onEvent: SequencerEventHook | null;
}

export function createSequencerState(): SequencerState {
  const slotVoiceId = new Int32Array(MAX_SEQ_SLOTS);
  for (let i = 0; i < MAX_SEQ_SLOTS; i++) {
    slotVoiceId[i] = SEQ_VOICE_ID_BASE + i;
  }

  return {
    events: [],
    eventStartTicks: new Float64Array(0),
    eventEndTicks: new Float64Array(0),
    bpm: 90,
    swingPercent: 50,
    totalTicks: 0,

    playing: false,
    recordMode: false,
    metronomeEnabled: false,
    nextMetronomeClickTick: 0,
    speed: 1.0,
    loopActive: false,
    loopStartTick: 0,
    loopEndTick: 0,

    currentTickFloat: 0,
    segmentStartTick: 0,
    segmentSamples: 0,
    lastTicksPerSample: 0,
    sampleFrame: 0,
    nextEventIndex: 0,

    inCountIn: false,
    countInElapsedTicks: 0,
    countInSamples: 0,
    countInBeat: 0,
    nextCountInClickTick: 0,

    slotActive: new Uint8Array(MAX_SEQ_SLOTS),
    slotEndTick: new Float64Array(MAX_SEQ_SLOTS),
    slotVoiceId,
    slotEventIndex: new Int32Array(MAX_SEQ_SLOTS),
    slotHole: new Int32Array(MAX_SEQ_SLOTS),

    totalTriggers: 0,
    loopWrapCount: 0,
    clickCount: 0,
    onEvent: null,
  };
}

function anchorTickClock(seq: SequencerState, tick: number): void {
  const safeTick = Number.isFinite(tick) && tick >= 0 ? tick : 0;
  seq.currentTickFloat = safeTick;
  seq.segmentStartTick = safeTick;
  seq.segmentSamples = 0;
}

function findFirstEventIndexAtOrAfter(seq: SequencerState, tick: number): number {
  const n = seq.events.length;
  let lo = 0;
  let hi = n;
  const threshold = tick - EPS_TICK;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (seq.eventStartTicks[mid]! < threshold) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export function sequencerAllNotesOff(
  seq: SequencerState,
  engine: EngineState,
): void {
  for (let s = 0; s < MAX_SEQ_SLOTS; s++) {
    if (seq.slotActive[s] !== 0) {
      engineNoteOff(engine, seq.slotVoiceId[s]!);
      seq.slotActive[s] = 0;
      seq.slotHole[s] = 0;
    }
  }
}

export function sequencerLoadScore(
  seq: SequencerState,
  engine: EngineState,
  events: ScheduledReedEvent[],
  bpm: number,
  swingPercent: number,
  totalTicks: number,
): void {
  sequencerAllNotesOff(seq, engine);

  const safeBpm = Number.isFinite(bpm) ? Math.max(30, Math.min(260, bpm)) : 90;
  const safeSwing = Number.isFinite(swingPercent)
    ? Math.max(50, Math.min(75, swingPercent))
    : 50;

  // Ensure deterministic ordering by startTick
  const sorted = [...events].sort((a, b) => a.startTick - b.startTick);
  const startTicks = new Float64Array(sorted.length);
  const endTicks = new Float64Array(sorted.length);

  let maxSwungEnd = 0;
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i]!;
    const swStart = applySwingTick(ev.startTick, safeSwing);
    const rawEnd = ev.startTick + Math.max(1, ev.durationTicks);
    const swNominalEnd = Math.max(swStart + 1, applySwingTick(rawEnd, safeSwing));
    const swDur = swNominalEnd - swStart;

    // Natural harmonica breath & articulation phrasing (keeps visual SongDocument notes juxtaposed):
    // Shorten non-slurred note release slightly before the next note to simulate breath reversal
    // (blow <-> draw) or tongue re-articulation on repeated holes.
    let releaseGapTicks = 0;
    if (ev.articulation !== 'slur' && swDur >= 96) {
      const next = i + 1 < sorted.length ? sorted[i + 1] : undefined;
      const nextSwStart = next ? applySwingTick(next.startTick, safeSwing) : Infinity;
      const existingGap = nextSwStart - swNominalEnd;

      if (next && existingGap < 60) {
        const curIsBlow = ev.action === 'blow' || ev.action === 'overblow';
        const nextIsBlow = next.action === 'blow' || next.action === 'overblow';
        const isBreathReversal = curIsBlow !== nextIsBlow;
        const sharesHole = ev.holes.some((h) => next.holes.includes(h));

        if (isBreathReversal) {
          // Lung-reversal dead-zone between blow and draw
          releaseGapTicks = Math.max(44, Math.min(104, Math.round(swDur * 0.22)));
        } else if (sharesHole) {
          // Repeated same-hole tongue articulation ("ta-ta")
          releaseGapTicks = Math.max(34, Math.min(76, Math.round(swDur * 0.16)));
        } else {
          // Smooth same-breath hole slide
          releaseGapTicks = Math.max(20, Math.min(48, Math.round(swDur * 0.1)));
        }
      } else {
        // Gentle phrase-ending breath taper
        releaseGapTicks = Math.min(24, Math.round(swDur * 0.06));
      }

      // Never shorten a note below 52% of its swung duration (or 48 ticks minimum)
      const maxCut = Math.max(0, swDur - Math.max(48, Math.round(swDur * 0.52)));
      if (releaseGapTicks > maxCut) releaseGapTicks = maxCut;
    }

    const swEnd = Math.max(swStart + 1, swNominalEnd - releaseGapTicks);
    startTicks[i] = swStart;
    endTicks[i] = swEnd;
    if (swNominalEnd > maxSwungEnd) maxSwungEnd = swNominalEnd;
  }

  seq.events = sorted;
  seq.eventStartTicks = startTicks;
  seq.eventEndTicks = endTicks;
  seq.bpm = safeBpm;
  seq.swingPercent = safeSwing;
  seq.totalTicks = Math.max(
    Number.isFinite(totalTicks) && totalTicks > 0 ? totalTicks : 0,
    Math.ceil(maxSwungEnd),
  );

  // Clamp current tick if new score is shorter
  if (seq.currentTickFloat > seq.totalTicks) {
    anchorTickClock(seq, 0);
  } else {
    anchorTickClock(seq, seq.currentTickFloat);
  }

  seq.nextEventIndex = findFirstEventIndexAtOrAfter(seq, seq.currentTickFloat);
}

export function sequencerTransport(
  seq: SequencerState,
  engine: EngineState,
  cmd: TransportCommand,
): void {
  // Apply speed update if provided
  if (cmd.speed !== undefined && Number.isFinite(cmd.speed)) {
    const nextSpeed = Math.max(0.25, Math.min(2.0, cmd.speed));
    if (nextSpeed !== seq.speed) {
      anchorTickClock(seq, seq.currentTickFloat);
      seq.speed = nextSpeed;
    }
  }

  // Apply loop update if provided
  if (cmd.loop !== undefined) {
    if (
      cmd.loop !== null &&
      Number.isFinite(cmd.loop.startTick) &&
      Number.isFinite(cmd.loop.endTick) &&
      cmd.loop.endTick > cmd.loop.startTick
    ) {
      seq.loopActive = true;
      seq.loopStartTick = Math.max(0, cmd.loop.startTick);
      seq.loopEndTick = cmd.loop.endTick;
    } else {
      seq.loopActive = false;
      seq.loopStartTick = 0;
      seq.loopEndTick = 0;
    }
  }

  if (cmd.action === 'stop') {
    sequencerAllNotesOff(seq, engine);
    seq.playing = false;
    seq.recordMode = false;
    seq.metronomeEnabled = false;
    seq.inCountIn = false;
    seq.countInBeat = 0;
    seq.countInElapsedTicks = 0;
    seq.countInSamples = 0;
    seq.nextCountInClickTick = 0;

    const resetTick =
      cmd.startTick !== undefined
        ? Math.max(0, cmd.startTick)
        : seq.loopActive
          ? seq.loopStartTick
          : 0;
    anchorTickClock(seq, resetTick);
    seq.nextEventIndex = findFirstEventIndexAtOrAfter(seq, seq.currentTickFloat);
    seq.nextMetronomeClickTick = Math.ceil(seq.currentTickFloat / DSP_PPQ) * DSP_PPQ;
    return;
  }

  if (cmd.action === 'pause') {
    sequencerAllNotesOff(seq, engine);
    seq.playing = false;
    seq.recordMode = false;
    seq.metronomeEnabled = false;
    seq.inCountIn = false;
    seq.countInBeat = 0;
    anchorTickClock(seq, seq.currentTickFloat);
    return;
  }

  if (cmd.action === 'seek') {
    sequencerAllNotesOff(seq, engine);
    const targetTick =
      cmd.startTick !== undefined && Number.isFinite(cmd.startTick)
        ? Math.max(0, cmd.startTick)
        : 0;
    anchorTickClock(seq, targetTick);
    seq.nextEventIndex = findFirstEventIndexAtOrAfter(seq, seq.currentTickFloat);
    seq.nextMetronomeClickTick = Math.ceil((seq.currentTickFloat - EPS_TICK) / DSP_PPQ) * DSP_PPQ;
    return;
  }

  // cmd.action === 'play' | 'record'
  const isRecord = cmd.action === 'record';
  seq.recordMode = isRecord;
  seq.metronomeEnabled = isRecord ? (cmd.metronome ?? true) : (cmd.metronome ?? false);

  const wasPlaying = seq.playing;
  let sought = false;

  if (cmd.startTick !== undefined && Number.isFinite(cmd.startTick)) {
    sequencerAllNotesOff(seq, engine);
    anchorTickClock(seq, Math.max(0, cmd.startTick));
    seq.nextEventIndex = findFirstEventIndexAtOrAfter(seq, seq.currentTickFloat);
    sought = true;
  } else if (!wasPlaying) {
    if (
      !isRecord &&
      seq.loopActive &&
      (seq.currentTickFloat < seq.loopStartTick - EPS_TICK ||
        seq.currentTickFloat >= seq.loopEndTick - EPS_TICK)
    ) {
      anchorTickClock(seq, seq.loopStartTick);
      seq.nextEventIndex = findFirstEventIndexAtOrAfter(seq, seq.currentTickFloat);
      sought = true;
    } else if (
      !isRecord &&
      !seq.loopActive &&
      seq.totalTicks > 0 &&
      seq.currentTickFloat >= seq.totalTicks - EPS_TICK
    ) {
      anchorTickClock(seq, 0);
      seq.nextEventIndex = findFirstEventIndexAtOrAfter(seq, 0);
      sought = true;
    }
  }

  seq.nextMetronomeClickTick = Math.ceil((seq.currentTickFloat - EPS_TICK) / DSP_PPQ) * DSP_PPQ;

  if (cmd.countIn === true && (!wasPlaying || sought)) {
    sequencerAllNotesOff(seq, engine);
    seq.inCountIn = true;
    seq.countInElapsedTicks = 0;
    seq.countInSamples = 0;
    seq.countInBeat = 1;
    seq.nextCountInClickTick = 0;
  } else if (!wasPlaying && !cmd.countIn) {
    seq.inCountIn = false;
    seq.countInBeat = 0;
  }

  if (!wasPlaying) {
    anchorTickClock(seq, seq.currentTickFloat);
    seq.nextEventIndex = findFirstEventIndexAtOrAfter(seq, seq.currentTickFloat);
  }

  seq.playing = true;
}

function allocateSeqSlot(seq: SequencerState): number {
  for (let s = 0; s < MAX_SEQ_SLOTS; s++) {
    if (seq.slotActive[s] === 0) return s;
  }
  // Steal slot ending soonest
  let best = 0;
  let earliestEnd = seq.slotEndTick[0]!;
  for (let s = 1; s < MAX_SEQ_SLOTS; s++) {
    if (seq.slotEndTick[s]! < earliestEnd) {
      earliestEnd = seq.slotEndTick[s]!;
      best = s;
    }
  }
  return best;
}

function triggerScoreEvent(
  seq: SequencerState,
  engine: EngineState,
  eventIndex: number,
): void {
  const ev = seq.events[eventIndex];
  if (!ev) return;

  const endTick = seq.eventEndTicks[eventIndex]!;
  const freqCount = ev.frequenciesHz.length;
  const wah = ev.articulation === 'wah' ? 0.22 : 0.52;
  const vibDepth = ev.articulation === 'vibrato' ? 0.008 : 0.0;

  for (let i = 0; i < freqCount; i++) {
    const freqHz = ev.frequenciesHz[i]!;
    const hole = ev.holes[i] ?? ev.holes[0] ?? 0;
    const slot = allocateSeqSlot(seq);
    const voiceId = seq.slotVoiceId[slot]!;

    seq.slotActive[slot] = 1;
    seq.slotEndTick[slot] = endTick;
    seq.slotEventIndex[slot] = eventIndex;
    seq.slotHole[slot] = hole;

    engineNoteOn(engine, voiceId, freqHz, ev.velocity, wah, hole, vibDepth);
  }

  seq.totalTriggers++;
  if (seq.onEvent) {
    seq.onEvent('noteOn', seq.eventStartTicks[eventIndex]!, seq.sampleFrame, eventIndex);
  }
}

/**
 * Advances the sample-accurate sequencer AND renders synthesized audio into `out`
 * with zero heap allocations. Sub-block splitting guarantees 1-sample timing
 * accuracy and complete block-size independence across 64/128/512/1024-sample runs.
 */
export function advanceSequencerBlock(
  seq: SequencerState,
  engine: EngineState,
  out: Float32Array,
  sampleRate: number,
): number {
  const totalSamples = out.length;
  if (totalSamples <= 0) return 0;

  const sr =
    Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 192000
      ? sampleRate
      : 48000;

  const ticksPerSample = ((seq.bpm / 60) * DSP_PPQ * seq.speed) / sr;
  if (ticksPerSample !== seq.lastTicksPerSample) {
    anchorTickClock(seq, seq.currentTickFloat);
    seq.lastTicksPerSample = ticksPerSample;
  }

  let samplesDone = 0;
  let maxPeak = 0;
  let guard = 0;
  const maxIterations = totalSamples + 64;

  while (samplesDone < totalSamples && guard < maxIterations) {
    guard++;

    if (!seq.playing || ticksPerSample <= 0) {
      const p = renderBlockRange(
        out,
        samplesDone,
        totalSamples - samplesDone,
        sr,
        engine,
      );
      if (p > maxPeak) maxPeak = p;
      seq.sampleFrame += totalSamples - samplesDone;
      samplesDone = totalSamples;
      break;
    }

    // -----------------------------------------------------------------------
    // Phase 1: 4-Beat Count-In
    // -----------------------------------------------------------------------
    if (seq.inCountIn) {
      while (
        seq.nextCountInClickTick < COUNT_IN_TICKS - EPS_TICK &&
        seq.countInElapsedTicks + EPS_TICK >= seq.nextCountInClickTick
      ) {
        const beatNum = Math.round(seq.nextCountInClickTick / DSP_PPQ) + 1;
        seq.countInBeat = beatNum;
        engineTriggerClick(engine, beatNum === 1);
        seq.clickCount++;
        if (seq.onEvent) {
          seq.onEvent('click', seq.nextCountInClickTick, seq.sampleFrame, beatNum);
        }
        seq.nextCountInClickTick += DSP_PPQ;
      }

      if (seq.countInElapsedTicks + EPS_TICK >= COUNT_IN_TICKS) {
        seq.inCountIn = false;
        seq.countInBeat = 0;
        seq.countInElapsedTicks = 0;
        seq.countInSamples = 0;
        anchorTickClock(seq, seq.currentTickFloat);
        continue;
      }

      const nextBoundary =
        seq.nextCountInClickTick < COUNT_IN_TICKS
          ? seq.nextCountInClickTick
          : COUNT_IN_TICKS;
      const ticksUntil = nextBoundary - seq.countInElapsedTicks;
      const samplesToBoundary = Math.max(
        1,
        Math.ceil((ticksUntil - EPS_TICK) / ticksPerSample),
      );
      const remaining = totalSamples - samplesDone;
      const step = samplesToBoundary < remaining ? samplesToBoundary : remaining;

      const p = renderBlockRange(out, samplesDone, step, sr, engine);
      if (p > maxPeak) maxPeak = p;

      seq.sampleFrame += step;
      seq.countInSamples += step;
      seq.countInElapsedTicks = seq.countInSamples * ticksPerSample;
      samplesDone += step;
      continue;
    }

    // -----------------------------------------------------------------------
    // Phase 2: Score Playback
    // -----------------------------------------------------------------------

    // 2a. Release active sequencer voices whose endTick has arrived
    for (let s = 0; s < MAX_SEQ_SLOTS; s++) {
      if (
        seq.slotActive[s] !== 0 &&
        seq.currentTickFloat + EPS_TICK >= seq.slotEndTick[s]!
      ) {
        engineNoteOff(engine, seq.slotVoiceId[s]!);
        seq.slotActive[s] = 0;
        seq.slotHole[s] = 0;
        if (seq.onEvent) {
          seq.onEvent(
            'noteOff',
            seq.slotEndTick[s]!,
            seq.sampleFrame,
            seq.slotEventIndex[s]!,
          );
        }
      }
    }

    // 2b. A-B Loop wraparound (disabled during unbounded DAW live recording)
    if (!seq.recordMode && seq.loopActive && seq.currentTickFloat + EPS_TICK >= seq.loopEndTick) {
      sequencerAllNotesOff(seq, engine);
      const loopLen = seq.loopEndTick - seq.loopStartTick;
      const overshoot = seq.currentTickFloat - seq.loopEndTick;
      const wrapped =
        loopLen > 0 && overshoot > EPS_TICK
          ? seq.loopStartTick + (overshoot % loopLen)
          : seq.loopStartTick;
      anchorTickClock(seq, wrapped);
      seq.nextEventIndex = findFirstEventIndexAtOrAfter(seq, seq.currentTickFloat);
      seq.loopWrapCount++;
      if (seq.onEvent) {
        seq.onEvent('loop', seq.currentTickFloat, seq.sampleFrame, seq.loopWrapCount);
      }
    }

    // 2c. End of song (when not looping and not in unbounded DAW live record mode)
    // Automatically reset caret to 0 so pressing Play again starts from the beginning immediately.
    if (
      !seq.recordMode &&
      !seq.loopActive &&
      (seq.totalTicks <= 0 || seq.currentTickFloat + EPS_TICK >= seq.totalTicks)
    ) {
      sequencerAllNotesOff(seq, engine);
      anchorTickClock(seq, 0);
      seq.nextEventIndex = findFirstEventIndexAtOrAfter(seq, 0);
      seq.playing = false;
      continue;
    }

    // 2c-bis. Live metronome clicks during DAW record mode
    if (seq.metronomeEnabled && seq.currentTickFloat + EPS_TICK >= seq.nextMetronomeClickTick) {
      const beatNumber = Math.round(seq.nextMetronomeClickTick / DSP_PPQ);
      engineTriggerClick(engine, beatNumber % 4 === 0);
      seq.clickCount++;
      if (seq.onEvent) {
        seq.onEvent('click', seq.nextMetronomeClickTick, seq.sampleFrame, (beatNumber % 4) + 1);
      }
      seq.nextMetronomeClickTick += DSP_PPQ;
    }

    // 2d. Trigger all score events due at currentTickFloat
    const eventCount = seq.events.length;
    while (
      seq.nextEventIndex < eventCount &&
      seq.eventStartTicks[seq.nextEventIndex]! <= seq.currentTickFloat + EPS_TICK
    ) {
      const idx = seq.nextEventIndex;
      seq.nextEventIndex++;
      if (seq.recordMode || !seq.loopActive || seq.eventStartTicks[idx]! < seq.loopEndTick - EPS_TICK) {
        triggerScoreEvent(seq, engine, idx);
      }
    }

    // 2e. Compute exact sample count until next event / noteOff / loop / end / metronome
    const remaining = totalSamples - samplesDone;
    let nextTargetTick = seq.currentTickFloat + remaining * ticksPerSample;

    if (!seq.recordMode && seq.loopActive && seq.loopEndTick < nextTargetTick) {
      nextTargetTick = seq.loopEndTick;
    } else if (!seq.recordMode && !seq.loopActive && seq.totalTicks < nextTargetTick) {
      nextTargetTick = seq.totalTicks;
    }

    if (seq.metronomeEnabled && seq.nextMetronomeClickTick < nextTargetTick) {
      nextTargetTick = seq.nextMetronomeClickTick;
    }

    if (seq.nextEventIndex < eventCount) {
      const nextEvStart = seq.eventStartTicks[seq.nextEventIndex]!;
      if (nextEvStart < nextTargetTick) {
        nextTargetTick = nextEvStart;
      }
    }

    for (let s = 0; s < MAX_SEQ_SLOTS; s++) {
      if (seq.slotActive[s] !== 0) {
        const slotEnd = seq.slotEndTick[s]!;
        if (slotEnd < nextTargetTick) {
          nextTargetTick = slotEnd;
        }
      }
    }

    const ticksUntil = nextTargetTick - seq.currentTickFloat;
    const samplesToBoundary =
      ticksUntil <= EPS_TICK
        ? 1
        : Math.max(1, Math.ceil((ticksUntil - EPS_TICK) / ticksPerSample));
    const step = samplesToBoundary < remaining ? samplesToBoundary : remaining;

    const p = renderBlockRange(out, samplesDone, step, sr, engine);
    if (p > maxPeak) maxPeak = p;

    seq.sampleFrame += step;
    seq.segmentSamples += step;
    seq.currentTickFloat = seq.segmentStartTick + seq.segmentSamples * ticksPerSample;
    samplesDone += step;
  }

  return maxPeak;
}
