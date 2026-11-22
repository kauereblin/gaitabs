import type {
  Articulation,
  BendSteps,
  BreathAction,
  SongDocument,
} from '../schema/song.ts';

/**
 * Canonical Pulses Per Quarter Note mirrored as a pure DSP constant
 * so the AudioWorklet bundle never imports runtime code from `src/schema/song.ts` (Zod).
 */
export const DSP_PPQ = 480 as const;

export interface ScheduledReedEvent {
  id: string;
  startTick: number;
  durationTicks: number;
  holes: number[];
  frequenciesHz: number[];
  action: BreathAction;
  bendSteps: BendSteps;
  velocity: number;
  articulation?: Articulation;
}

export interface LoopRange {
  startTick: number;
  endTick: number;
}

export interface TransportCommand {
  action: 'play' | 'pause' | 'stop' | 'seek' | 'record';
  startTick?: number;
  speed?: number;
  loop?: LoopRange | null;
  countIn?: boolean;
  metronome?: boolean;
}

export type WorkletInMsg =
  | {
      type: 'noteOn';
      voiceId: number;
      freqHz: number;
      velocity: number;
      wah: number;
      hole?: number;
    }
  | {
      type: 'notePitch';
      voiceId: number;
      freqHz: number;
    }
  | {
      type: 'noteOff';
      voiceId: number;
    }
  | {
      type: 'setWah';
      wah: number;
    }
  | {
      type: 'panic';
    }
  | {
      type: 'loadScore';
      events: ScheduledReedEvent[];
      bpm: number;
      swingPercent: number;
      totalTicks: number;
    }
  | ({
      type: 'transport';
    } & TransportCommand);

export interface WorkletTelemetry {
  type: 'telemetry';
  playing: boolean;
  currentTick: number;
  activeHoles: number[];
  peakLevel: number;
  cpuLoad: number;
  countInBeat?: number;
}

export type AudioEngineState = 'suspended' | 'running' | 'closed';

export interface SynthEngine {
  unlock(): Promise<void>;
  getState(): AudioEngineState;
  noteOn(
    voiceId: number,
    freqHz: number,
    velocity?: number,
    wah?: number,
    hole?: number,
  ): void;
  notePitch(voiceId: number, freqHz: number): void;
  noteOff(voiceId: number): void;
  setWah(wah: number): void;
  panic(): void;
  loadSong(doc: SongDocument): void;
  transport(cmd: TransportCommand): void;
  subscribeTelemetry(cb: (telemetry: WorkletTelemetry) => void): () => void;
  dispose(): void;
}
