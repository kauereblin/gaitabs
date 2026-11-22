import {
  collectActiveHoles,
  createEngineState,
  engineAllNotesOff,
  engineNoteOff,
  engineNoteOn,
  engineNotePitch,
  engineSetWah,
  type EngineState,
} from './engine.ts';
import {
  advanceSequencerBlock,
  createSequencerState,
  sequencerAllNotesOff,
  sequencerLoadScore,
  sequencerTransport,
  type SequencerState,
} from './sequencer.ts';
import type { WorkletInMsg, WorkletTelemetry } from './types.ts';

// Minimal AudioWorkletGlobalScope declarations (absent from TS DOM lib).
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

declare const sampleRate: number;

function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return perf && typeof perf.now === 'function' ? perf.now() : 0;
}

class GaitabsReedProcessor extends AudioWorkletProcessor {
  private readonly engine: EngineState;
  private readonly seq: SequencerState;
  private readonly telemetryMsg: WorkletTelemetry;
  private readonly telemetryIntervalQuanta: number;
  private quantaCounter: number;
  private peakSinceTelemetry: number;
  private maxCpuSinceTelemetry: number;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.engine = createEngineState();
    this.seq = createSequencerState();

    const sr =
      typeof sampleRate === 'number' && Number.isFinite(sampleRate) && sampleRate > 0
        ? sampleRate
        : 48000;
    this.telemetryIntervalQuanta = Math.max(1, Math.round(sr / 128 / 60));
    this.quantaCounter = 0;
    this.peakSinceTelemetry = 0;
    this.maxCpuSinceTelemetry = 0;

    // Pre-allocated telemetry payload mutated in place to avoid allocations in `process()`
    this.telemetryMsg = {
      type: 'telemetry',
      playing: false,
      currentTick: 0,
      activeHoles: [],
      peakLevel: 0,
      cpuLoad: 0,
      countInBeat: 0,
    };

    this.port.onmessage = (event: MessageEvent<WorkletInMsg>) => {
      this.handleMessage(event.data);
    };
  }

  private handleMessage(msg: WorkletInMsg): void {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'noteOn':
        engineNoteOn(
          this.engine,
          msg.voiceId,
          msg.freqHz,
          msg.velocity,
          msg.wah,
          msg.hole ?? 0,
        );
        break;
      case 'notePitch':
        engineNotePitch(this.engine, msg.voiceId, msg.freqHz);
        break;
      case 'noteOff':
        engineNoteOff(this.engine, msg.voiceId);
        break;
      case 'setWah':
        engineSetWah(this.engine, msg.wah);
        break;
      case 'panic':
        sequencerAllNotesOff(this.seq, this.engine);
        engineAllNotesOff(this.engine);
        break;
      case 'loadScore':
        sequencerLoadScore(
          this.seq,
          this.engine,
          msg.events,
          msg.bpm,
          msg.swingPercent,
          msg.totalTicks,
        );
        break;
      case 'transport':
        sequencerTransport(this.seq, this.engine, msg);
        break;
    }
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const output = outputs[0];
    const ch0 = output?.[0];
    if (!ch0) return true;

    const sr =
      typeof sampleRate === 'number' && Number.isFinite(sampleRate) && sampleRate > 0
        ? sampleRate
        : 48000;

    const t0 = nowMs();
    const blockPeak = advanceSequencerBlock(this.seq, this.engine, ch0, sr);
    const t1 = nowMs();

    // Mirror mono reed output across additional channels (zero heap allocation)
    if (output) {
      for (let c = 1; c < output.length; c++) {
        const ch = output[c];
        if (ch) {
          ch.set(ch0);
        }
      }
    }

    if (blockPeak > this.peakSinceTelemetry) {
      this.peakSinceTelemetry = blockPeak;
    }

    if (t1 > t0) {
      const quantumMs = (ch0.length / sr) * 1000;
      const load = quantumMs > 0 ? Math.min(1, (t1 - t0) / quantumMs) : 0;
      if (load > this.maxCpuSinceTelemetry) {
        this.maxCpuSinceTelemetry = load;
      }
    }

    this.quantaCounter++;
    if (this.quantaCounter >= this.telemetryIntervalQuanta) {
      this.quantaCounter = 0;

      const msg = this.telemetryMsg;
      msg.playing = this.seq.playing;
      msg.currentTick = Math.floor(this.seq.currentTickFloat);
      msg.peakLevel = this.peakSinceTelemetry;
      msg.cpuLoad = this.maxCpuSinceTelemetry;
      msg.countInBeat = this.seq.inCountIn ? this.seq.countInBeat : 0;
      collectActiveHoles(this.engine, msg.activeHoles);

      this.port.postMessage(msg);
      this.peakSinceTelemetry = 0;
      this.maxCpuSinceTelemetry = 0;
    }

    return true;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('gaitabs-reed-processor', GaitabsReedProcessor);
}
