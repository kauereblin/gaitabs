import type { SongDocument } from '../schema/song.ts';
import { compileSongToScheduledEvents } from './compile.ts';
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
import type {
  AudioEngineState,
  SynthEngine,
  TransportCommand,
  WorkletInMsg,
  WorkletTelemetry,
} from './types.ts';
import workletUrl from './worklet.ts?worker&url';

const WORKLET_PROCESSOR_NAME = 'gaitabs-reed-processor';
const MAX_PENDING_QUEUE = 128;

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

interface FallbackBackend {
  node: ScriptProcessorNode;
  engine: EngineState;
  seq: SequencerState;
  monoBuf: Float32Array;
  activeHoles: number[];
  lastTelemetryMs: number;
}

export class WebAudioSynthEngine implements SynthEngine {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private fallback: FallbackBackend | null = null;
  private initPromise: Promise<void> | null = null;
  private ready = false;
  private disposed = false;

  private readonly telemetryListeners = new Set<(t: WorkletTelemetry) => void>();
  private readonly pendingQueue: WorkletInMsg[] = [];
  private lastScoreMsg: Extract<WorkletInMsg, { type: 'loadScore' }> | null = null;

  getState(): AudioEngineState {
    if (this.disposed) return 'closed';
    if (!this.ctx) return 'suspended';
    const st = this.ctx.state;
    if (st === 'running') return 'running';
    if (st === 'closed') return 'closed';
    return 'suspended';
  }

  unlock(): Promise<void> {
    if (this.disposed) return Promise.resolve();

    const AudioCtx = getAudioContextCtor();
    if (!AudioCtx) return Promise.resolve();

    // Create AudioContext and invoke resume() synchronously inside the user gesture.
    if (!this.ctx) {
      this.ctx = new AudioCtx();
    }
    const ctx = this.ctx;
    const resumePromise: Promise<void> =
      ctx.state === 'suspended'
        ? ctx.resume().catch(() => {
            // Browser may still block outside a gesture; getState() reflects true state.
          })
        : Promise.resolve();

    if (!this.initPromise) {
      this.initPromise = this.initializeGraph(ctx);
    }

    return Promise.all([resumePromise, this.initPromise]).then(() => undefined);
  }

  private async initializeGraph(ctx: AudioContext): Promise<void> {
    if (this.disposed || this.ready) return;

    const canUseWorklet =
      typeof AudioWorkletNode !== 'undefined' &&
      ctx.audioWorklet !== undefined &&
      typeof ctx.audioWorklet.addModule === 'function';

    if (canUseWorklet) {
      try {
        await ctx.audioWorklet.addModule(workletUrl);
        if (this.disposed) return;

        const node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });

        node.port.onmessage = (event: MessageEvent<WorkletTelemetry>) => {
          const data = event.data;
          if (data && data.type === 'telemetry') {
            this.emitTelemetry(data);
          }
        };

        node.connect(ctx.destination);
        this.workletNode = node;
        this.ready = true;
        this.flushPendingMessages();
        return;
      } catch {
        // Fall through to ScriptProcessor fallback when AudioWorklet fails to load.
      }
    }

    this.initializeFallback(ctx);
  }

  private initializeFallback(ctx: AudioContext): void {
    if (this.disposed || this.ready) return;
    if (typeof ctx.createScriptProcessor !== 'function') return;

    const bufferSize = 512;
    const node = ctx.createScriptProcessor(bufferSize, 0, 2);
    const engine = createEngineState();
    const seq = createSequencerState();
    const monoBuf = new Float32Array(bufferSize);
    const activeHoles: number[] = [];

    const backend: FallbackBackend = {
      node,
      engine,
      seq,
      monoBuf,
      activeHoles,
      lastTelemetryMs: 0,
    };

    node.onaudioprocess = (ev: AudioProcessingEvent) => {
      const outL = ev.outputBuffer.getChannelData(0);
      const outR =
        ev.outputBuffer.numberOfChannels > 1
          ? ev.outputBuffer.getChannelData(1)
          : null;

      const buf =
        backend.monoBuf.length === outL.length
          ? backend.monoBuf
          : new Float32Array(outL.length);
      backend.monoBuf = buf;

      const t0 = performance.now();
      const peak = advanceSequencerBlock(backend.seq, backend.engine, buf, ctx.sampleRate);
      const t1 = performance.now();

      outL.set(buf);
      if (outR) outR.set(buf);

      if (t1 - backend.lastTelemetryMs >= 16) {
        backend.lastTelemetryMs = t1;
        collectActiveHoles(backend.engine, backend.activeHoles);
        const quantumMs = (buf.length / ctx.sampleRate) * 1000;
        this.emitTelemetry({
          type: 'telemetry',
          playing: backend.seq.playing,
          currentTick: Math.floor(backend.seq.currentTickFloat),
          activeHoles: [...backend.activeHoles],
          peakLevel: peak,
          cpuLoad: quantumMs > 0 ? Math.min(1, (t1 - t0) / quantumMs) : 0,
          countInBeat: backend.seq.inCountIn ? backend.seq.countInBeat : 0,
        });
      }
    };

    node.connect(ctx.destination);
    this.fallback = backend;
    this.ready = true;
    this.flushPendingMessages();
  }

  private dispatchToFallback(backend: FallbackBackend, msg: WorkletInMsg): void {
    switch (msg.type) {
      case 'noteOn':
        engineNoteOn(
          backend.engine,
          msg.voiceId,
          msg.freqHz,
          msg.velocity,
          msg.wah,
          msg.hole ?? 0,
        );
        break;
      case 'notePitch':
        engineNotePitch(backend.engine, msg.voiceId, msg.freqHz);
        break;
      case 'noteOff':
        engineNoteOff(backend.engine, msg.voiceId);
        break;
      case 'setWah':
        engineSetWah(backend.engine, msg.wah);
        break;
      case 'panic':
        sequencerAllNotesOff(backend.seq, backend.engine);
        engineAllNotesOff(backend.engine);
        break;
      case 'loadScore':
        sequencerLoadScore(
          backend.seq,
          backend.engine,
          msg.events,
          msg.bpm,
          msg.swingPercent,
          msg.totalTicks,
        );
        break;
      case 'transport':
        sequencerTransport(backend.seq, backend.engine, msg);
        break;
    }
  }

  private post(msg: WorkletInMsg): void {
    if (this.disposed) return;

    if (msg.type === 'loadScore') {
      this.lastScoreMsg = msg;
    }

    if (this.workletNode) {
      this.workletNode.port.postMessage(msg);
      return;
    }

    if (this.fallback) {
      this.dispatchToFallback(this.fallback, msg);
      return;
    }

    // Queue messages until worklet/fallback initialization completes
    if (msg.type !== 'loadScore') {
      if (this.pendingQueue.length >= MAX_PENDING_QUEUE) {
        this.pendingQueue.shift();
      }
      this.pendingQueue.push(msg);
    }
  }

  private flushPendingMessages(): void {
    if (this.lastScoreMsg) {
      const scoreMsg = this.lastScoreMsg;
      if (this.workletNode) {
        this.workletNode.port.postMessage(scoreMsg);
      } else if (this.fallback) {
        this.dispatchToFallback(this.fallback, scoreMsg);
      }
    }

    while (this.pendingQueue.length > 0) {
      const msg = this.pendingQueue.shift();
      if (!msg) continue;
      if (this.workletNode) {
        this.workletNode.port.postMessage(msg);
      } else if (this.fallback) {
        this.dispatchToFallback(this.fallback, msg);
      }
    }
  }

  private emitTelemetry(telemetry: WorkletTelemetry): void {
    for (const listener of this.telemetryListeners) {
      listener(telemetry);
    }
  }

  noteOn(
    voiceId: number,
    freqHz: number,
    velocity: number = 0.85,
    wah: number = 0.5,
    hole?: number,
  ): void {
    const msg: WorkletInMsg =
      hole !== undefined
        ? { type: 'noteOn', voiceId, freqHz, velocity, wah, hole }
        : { type: 'noteOn', voiceId, freqHz, velocity, wah };
    this.post(msg);
  }

  notePitch(voiceId: number, freqHz: number): void {
    this.post({ type: 'notePitch', voiceId, freqHz });
  }

  noteOff(voiceId: number): void {
    this.post({ type: 'noteOff', voiceId });
  }

  setWah(wah: number): void {
    this.post({ type: 'setWah', wah });
  }

  panic(): void {
    this.post({ type: 'panic' });
  }

  loadSong(doc: SongDocument): void {
    const { events, totalTicks } = compileSongToScheduledEvents(doc);
    this.post({
      type: 'loadScore',
      events,
      bpm: doc.bpm,
      swingPercent: doc.swingPercent,
      totalTicks,
    });
  }

  transport(cmd: TransportCommand): void {
    this.post({ type: 'transport', ...cmd });
  }

  subscribeTelemetry(cb: (telemetry: WorkletTelemetry) => void): () => void {
    this.telemetryListeners.add(cb);
    return () => {
      this.telemetryListeners.delete(cb);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.pendingQueue.length = 0;
    this.telemetryListeners.clear();

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      try {
        this.workletNode.disconnect();
      } catch {
        // Ignore already-disconnected node
      }
      this.workletNode = null;
    }

    if (this.fallback) {
      this.fallback.node.onaudioprocess = null;
      try {
        this.fallback.node.disconnect();
      } catch {
        // Ignore already-disconnected node
      }
      this.fallback = null;
    }

    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      if (ctx.state !== 'closed') {
        void ctx.close().catch(() => {
          // Ignore close errors
        });
      }
    }
  }
}

export function createWebAudioSynthEngine(): SynthEngine {
  return new WebAudioSynthEngine();
}
