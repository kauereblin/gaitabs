import { describe, expect, test } from 'bun:test';
import { WONDERFUL_WORLD_GOLDEN_DOC } from '../schema/golden.ts';
import { compileSongToScheduledEvents } from './compile.ts';
import { createEngineState } from './engine.ts';
import {
  advanceSequencerBlock,
  applySwingTick,
  createSequencerState,
  sequencerLoadScore,
  sequencerTransport,
} from './sequencer.ts';
import { DSP_PPQ, type ScheduledReedEvent } from './types.ts';

interface LoggedEvent {
  kind: 'noteOn' | 'noteOff' | 'click' | 'loop';
  tick: number;
  sampleFrame: number;
  detail: number;
}

function makeTestEvent(
  id: string,
  startTick: number,
  durationTicks: number,
  hole: number,
  freqHz: number,
): ScheduledReedEvent {
  return {
    id,
    startTick,
    durationTicks,
    holes: [hole],
    frequenciesHz: [freqHz],
    action: 'blow',
    bendSteps: 0,
    velocity: 0.85,
  };
}

function runQuanta(
  seq: ReturnType<typeof createSequencerState>,
  engine: ReturnType<typeof createEngineState>,
  totalSamples: number,
  sampleRate: number,
  blockSize: number = 128,
): Float32Array {
  const out = new Float32Array(totalSamples);
  const chunk = new Float32Array(blockSize);
  let offset = 0;
  while (offset < totalSamples) {
    const len = Math.min(blockSize, totalSamples - offset);
    const buf = len === blockSize ? chunk : new Float32Array(len);
    advanceSequencerBlock(seq, engine, buf, sampleRate);
    out.set(buf, offset);
    offset += len;
  }
  return out;
}

describe('Score Compiler & Sample-Accurate Sequencer (src/dsp/sequencer.ts)', () => {
  test('compileSongToScheduledEvents compiles Golden Fixture accurately and transposes purely', () => {
    const compiledC = compileSongToScheduledEvents(WONDERFUL_WORLD_GOLDEN_DOC);
    expect(compiledC.events.length).toBe(17); // Bar 0 (9) + Bar 1 (8)
    expect(compiledC.totalTicks).toBe(17 * DSP_PPQ);
    expect(compiledC.events[0]!.startTick).toBe(0);
    expect(compiledC.events[0]!.holes).toEqual([3]);
    expect(compiledC.events[9]!.startTick).toBe(9 * DSP_PPQ); // First note of Bar 1

    const transposedG = {
      ...WONDERFUL_WORLD_GOLDEN_DOC,
      instrument: { ...WONDERFUL_WORLD_GOLDEN_DOC.instrument, harpKey: 'G' as const },
    };
    const compiledG = compileSongToScheduledEvents(transposedG);
    expect(compiledG.events.length).toBe(17);

    // G harp is 5 semitones below C harp
    const ratio = compiledG.events[0]!.frequenciesHz[0]! / compiledC.events[0]!.frequenciesHz[0]!;
    expect(ratio).toBeCloseTo(Math.pow(2, -5 / 12), 6);
  });

  test('0.5x speed doubles exact sample duration between notes', () => {
    const sampleRate = 48000;
    const bpm = 120; // 1 beat = 0.5 s = 24000 samples at 1.0x, 48000 samples at 0.5x
    const events: ScheduledReedEvent[] = [
      makeTestEvent('n0', 0, 240, 4, 523.25),
      makeTestEvent('n1', DSP_PPQ, 240, 5, 659.25),
    ];

    const runAtSpeed = (speed: number): LoggedEvent[] => {
      const seq = createSequencerState();
      const engine = createEngineState();
      const log: LoggedEvent[] = [];
      seq.onEvent = (kind, tick, sampleFrame, detail) => {
        log.push({ kind, tick, sampleFrame, detail });
      };

      sequencerLoadScore(seq, engine, events, bpm, 50, 2 * DSP_PPQ);
      sequencerTransport(seq, engine, { action: 'play', speed, startTick: 0 });

      // Render 2.5 seconds (enough for both speeds)
      runQuanta(seq, engine, Math.round(sampleRate * 2.5), sampleRate, 128);
      return log;
    };

    const log1x = runAtSpeed(1.0);
    const logHalf = runAtSpeed(0.5);

    const on1x = log1x.filter((e) => e.kind === 'noteOn');
    const onHalf = logHalf.filter((e) => e.kind === 'noteOn');

    expect(on1x.length).toBe(2);
    expect(onHalf.length).toBe(2);

    expect(on1x[0]!.sampleFrame).toBe(0);
    expect(on1x[1]!.sampleFrame).toBe(24000);

    expect(onHalf[0]!.sampleFrame).toBe(0);
    expect(onHalf[1]!.sampleFrame).toBe(48000);
  });

  test('4-beat count-in emits 4 metronome clicks before releasing beat-1 score notes', () => {
    const sampleRate = 48000;
    const bpm = 120; // 1 beat = 24000 samples; 4 beats = 96000 samples
    const events: ScheduledReedEvent[] = [
      makeTestEvent('n0', 0, 480, 4, 523.25),
      makeTestEvent('n1', 480, 480, 5, 659.25),
    ];

    const seq = createSequencerState();
    const engine = createEngineState();
    const log: LoggedEvent[] = [];
    seq.onEvent = (kind, tick, sampleFrame, detail) => {
      log.push({ kind, tick, sampleFrame, detail });
    };

    sequencerLoadScore(seq, engine, events, bpm, 50, 960);
    sequencerTransport(seq, engine, {
      action: 'play',
      startTick: 0,
      speed: 1.0,
      countIn: true,
    });

    // Advance 1.5 beats into count-in -> still in count-in on beat 2, currentTick remains 0
    runQuanta(seq, engine, 36000, sampleRate, 128);
    expect(seq.inCountIn).toBe(true);
    expect(seq.countInBeat).toBe(2);
    expect(Math.floor(seq.currentTickFloat)).toBe(0);
    expect(seq.totalTriggers).toBe(0);

    // Finish remaining 2.5 beats of count-in + 2.5 beats of score
    runQuanta(seq, engine, 120000, sampleRate, 128);
    expect(seq.inCountIn).toBe(false);
    expect(seq.countInBeat).toBe(0);

    const clicks = log.filter((e) => e.kind === 'click');
    const noteOns = log.filter((e) => e.kind === 'noteOn');

    expect(clicks.map((c) => c.sampleFrame)).toEqual([0, 24000, 48000, 72000]);
    expect(clicks.map((c) => c.detail)).toEqual([1, 2, 3, 4]);
    expect(noteOns.length).toBe(2);
    expect(noteOns[0]!.sampleFrame).toBe(96000); // exact start after 4-beat count-in
    expect(noteOns[1]!.sampleFrame).toBe(120000);
  });

  test('swingPercent delays off-beat 8th notes while keeping on-beats anchored', () => {
    // Pure tick warp checks
    expect(applySwingTick(0, 50)).toBe(0);
    expect(applySwingTick(240, 50)).toBe(240);
    expect(applySwingTick(0, 75)).toBe(0);
    expect(applySwingTick(240, 75)).toBe(360); // +120 ticks
    expect(applySwingTick(480, 75)).toBe(480); // beat 2 unchanged
    expect(applySwingTick(720, 75)).toBe(840); // +120 ticks

    const sampleRate = 48000;
    const bpm = 120; // 1 beat (480 ticks) = 24000 samples -> 1 tick = 50 samples
    const events: ScheduledReedEvent[] = [
      makeTestEvent('b1', 0, 240, 4, 523.25),
      makeTestEvent('b1-and', 240, 240, 4, 587.33),
      makeTestEvent('b2', 480, 240, 5, 659.25),
      makeTestEvent('b2-and', 720, 240, 6, 783.99),
    ];

    const captureOnsets = (swingPercent: number): number[] => {
      const seq = createSequencerState();
      const engine = createEngineState();
      const onsets: number[] = [];
      seq.onEvent = (kind, _tick, sampleFrame) => {
        if (kind === 'noteOn') onsets.push(sampleFrame);
      };
      sequencerLoadScore(seq, engine, events, bpm, swingPercent, 960);
      sequencerTransport(seq, engine, { action: 'play', startTick: 0, speed: 1.0 });
      runQuanta(seq, engine, 60000, sampleRate, 128);
      return onsets;
    };

    const straight = captureOnsets(50);
    const heavySwing = captureOnsets(75);

    expect(straight).toEqual([0, 12000, 24000, 36000]);
    expect(heavySwing).toEqual([0, 18000, 24000, 42000]);
  });

  test('A-B loop wraps cleanly and repeats only in-range events with zero drift', () => {
    const sampleRate = 48000;
    const bpm = 120; // 480 ticks = 24000 samples; loop [480, 1440] = 960 ticks = 48000 samples
    const events: ScheduledReedEvent[] = [
      makeTestEvent('before', 0, 480, 3, 392.0),
      makeTestEvent('in-a', 480, 400, 4, 523.25),
      makeTestEvent('in-b', 960, 400, 5, 659.25),
      makeTestEvent('after', 1440, 480, 6, 783.99),
    ];

    const seq = createSequencerState();
    const engine = createEngineState();
    const log: LoggedEvent[] = [];
    seq.onEvent = (kind, tick, sampleFrame, detail) => {
      log.push({ kind, tick, sampleFrame, detail });
    };

    sequencerLoadScore(seq, engine, events, bpm, 50, 1920);
    sequencerTransport(seq, engine, {
      action: 'play',
      speed: 1.0,
      loop: { startTick: 480, endTick: 1440 },
    });

    // Run 2.5 loop cycles (2.5 * 48000 = 120000 samples)
    runQuanta(seq, engine, 120000, sampleRate, 128);

    expect(seq.playing).toBe(true);
    expect(seq.loopWrapCount).toBe(2);
    expect(seq.currentTickFloat).toBeGreaterThanOrEqual(480);
    expect(seq.currentTickFloat).toBeLessThan(1440);

    const noteOns = log.filter((e) => e.kind === 'noteOn');
    // Only events 1 ('in-a') and 2 ('in-b') should ever trigger
    expect(noteOns.every((e) => e.detail === 1 || e.detail === 2)).toBe(true);
    // Cycle 0: 0, 24000; Cycle 1: 48000, 72000; Cycle 2: 96000, 120000 (120000 is at end boundary)
    expect(noteOns.slice(0, 5).map((e) => e.sampleFrame)).toEqual([
      0, 24000, 48000, 72000, 96000,
    ]);

    const wraps = log.filter((e) => e.kind === 'loop');
    expect(wraps.map((w) => w.sampleFrame)).toEqual([48000, 96000]);

    // Pause preserves tick; Stop resets to loopStartTick
    const pausedTick = seq.currentTickFloat;
    sequencerTransport(seq, engine, { action: 'pause' });
    expect(seq.playing).toBe(false);
    expect(seq.currentTickFloat).toBeCloseTo(pausedTick, 5);

    sequencerTransport(seq, engine, { action: 'stop' });
    expect(seq.currentTickFloat).toBe(480);
  });

  test('combined sequencer + synth output is strictly block-size independent (64 vs 128 vs 512)', () => {
    const sampleRate = 48000;
    const totalSamples = 8192;
    const events: ScheduledReedEvent[] = [
      makeTestEvent('e0', 0, 240, 4, 523.25),
      makeTestEvent('e1', 240, 240, 5, 659.25),
    ];

    const render = (blockSize: number): Float32Array => {
      const seq = createSequencerState();
      const engine = createEngineState();
      sequencerLoadScore(seq, engine, events, 140, 62, 960);
      sequencerTransport(seq, engine, { action: 'play', startTick: 0, speed: 1.0 });
      return runQuanta(seq, engine, totalSamples, sampleRate, blockSize);
    };

    const out64 = render(64);
    const out128 = render(128);
    const out512 = render(512);

    let maxDiff64 = 0;
    let maxDiff512 = 0;
    for (let i = 0; i < totalSamples; i++) {
      const d64 = Math.abs(out128[i]! - out64[i]!);
      const d512 = Math.abs(out128[i]! - out512[i]!);
      if (d64 > maxDiff64) maxDiff64 = d64;
      if (d512 > maxDiff512) maxDiff512 = d512;
      expect(Number.isFinite(out128[i]!)).toBe(true);
      expect(Math.abs(out128[i]!)).toBeLessThanOrEqual(1.0);
    }

    expect(maxDiff64).toBeLessThan(1e-6);
    expect(maxDiff512).toBeLessThan(1e-6);
  });

  test('resets caret to 0 automatically when non-looped song finishes, allowing immediate replay', () => {
    const sampleRate = 48000;
    const seq = createSequencerState();
    const engine = createEngineState();
    const events: ScheduledReedEvent[] = [makeTestEvent('e0', 0, 240, 4, 523.25)];

    sequencerLoadScore(seq, engine, events, 120, 50, 480); // 0.5s total
    sequencerTransport(seq, engine, { action: 'play', startTick: 0, speed: 1.0 });

    // Render 0.7s so playback reaches the end
    runQuanta(seq, engine, Math.round(0.7 * sampleRate), sampleRate, 128);
    expect(seq.playing).toBe(false);
    expect(seq.currentTickFloat).toBe(0);
    expect(seq.totalTriggers).toBe(1);

    // Pressing Play immediately without Stop replays cleanly from 0
    sequencerTransport(seq, engine, { action: 'play', speed: 1.0 });
    runQuanta(seq, engine, Math.round(0.25 * sampleRate), sampleRate, 128);
    expect(seq.totalTriggers).toBe(2);
  });

  test('supports paused seek without starting playback and unbounded DAW record mode', () => {
    const sampleRate = 48000;
    const seq = createSequencerState();
    const engine = createEngineState();
    const events: ScheduledReedEvent[] = [makeTestEvent('e0', 0, 240, 4, 523.25)];

    sequencerLoadScore(seq, engine, events, 120, 50, 960);
    sequencerTransport(seq, engine, { action: 'seek', startTick: 480 });
    expect(seq.playing).toBe(false);
    expect(seq.currentTickFloat).toBe(480);

    // Rendering while paused keeps sought caret intact
    runQuanta(seq, engine, 2048, sampleRate, 128);
    expect(seq.currentTickFloat).toBe(480);

    // DAW record mode advances past totalTicks with metronome clicks
    sequencerTransport(seq, engine, { action: 'record', startTick: 0, speed: 1.0, metronome: true });
    runQuanta(seq, engine, Math.round(1.6 * sampleRate), sampleRate, 128); // > 3 beats at 120 BPM (> 960 totalTicks)
    expect(seq.playing).toBe(true);
    expect(seq.currentTickFloat).toBeGreaterThan(1200);
    expect(seq.clickCount).toBeGreaterThanOrEqual(3);
  });

  test('applies natural breath-reversal and repeated-hole articulation gaps while keeping slurs legato', () => {
    const seq = createSequencerState();
    const engine = createEngineState();
    const events: ScheduledReedEvent[] = [
      // 0: blow 4 -> followed by draw 4 (breath reversal: widest gap)
      { ...makeTestEvent('rev', 0, 480, 4, 523.25), action: 'blow' },
      // 1: draw 4 -> followed by draw 4 (same-hole repeat: tongue gap)
      { ...makeTestEvent('rep', 480, 480, 4, 587.33), action: 'draw' },
      // 2: draw 4 -> followed by draw 5 (same breath, different hole: gentle gap)
      { ...makeTestEvent('slide', 960, 480, 4, 587.33), action: 'draw' },
      // 3: draw 5 with explicit slur -> full legato (zero early cutoff)
      { ...makeTestEvent('slur', 1440, 480, 5, 698.46), action: 'draw', articulation: 'slur' },
      // 4: blow 6 phrase end
      { ...makeTestEvent('end', 1920, 480, 6, 783.99), action: 'blow' },
    ];

    sequencerLoadScore(seq, engine, events, 100, 50, 2400);

    const revGap = 480 - seq.eventEndTicks[0]!;
    const repGap = 960 - seq.eventEndTicks[1]!;
    const slideGap = 1440 - seq.eventEndTicks[2]!;
    const slurGap = 1920 - seq.eventEndTicks[3]!;

    expect(revGap).toBeGreaterThan(repGap);
    expect(repGap).toBeGreaterThan(slideGap);
    expect(slideGap).toBeGreaterThan(0);
    expect(slurGap).toBe(0);
  });
});
