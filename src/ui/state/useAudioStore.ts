import { create } from 'zustand';
import { WebAudioSynthEngine } from '../../dsp/bridge.ts';
import type { AudioEngineState, LoopRange, SynthEngine, WorkletTelemetry } from '../../dsp/types.ts';
import {
  getTotalTicks,
  type BendSteps,
  type BreathAction,
  type HarpKey,
  type SongDocument,
} from '../../schema/song.ts';
import { clampBendSteps, midiToHz, resolveHoleMidi } from '../../schema/tuning.ts';

export type KeyboardMode = 'two-row' | 'breath-switch';

export interface ActiveInteractiveNote {
  voiceId: number;
  hole: number;
  action: BreathAction;
  bendSteps: BendSteps;
  bendCents: number;
  freqHz: number;
}

export interface RecordedNotePayload {
  absStartTick: number;
  durationTicks: number;
  holes: number[];
  action: BreathAction;
  bendSteps: BendSteps;
}

type RecordNoteHandler = (payload: RecordedNotePayload) => void;

interface AudioStoreState {
  engine: SynthEngine;
  audioState: AudioEngineState;
  playing: boolean;
  recording: boolean;
  recordingMetronome: boolean;
  currentTick: number;
  activeHoles: number[];
  peakLevel: number;
  cpuLoad: number;
  countInBeat: number | undefined;
  speed: 0.5 | 0.75 | 1;
  countIn: boolean;
  loop: LoopRange | null;
  wah: number;
  keyboardMode: KeyboardMode;
  liveNotes: Record<number, ActiveInteractiveNote>;

  unlockAudio: () => Promise<void>;
  loadSongIntoEngine: (doc: SongDocument) => void;
  setRecordNoteHandler: (handler: RecordNoteHandler | null) => void;
  play: (doc: SongDocument, startTick?: number) => Promise<void>;
  pause: () => void;
  stop: () => void;
  seek: (tick: number) => void;
  startRecording: (doc: SongDocument, startTick?: number) => Promise<void>;
  stopRecording: () => void;
  setRecordingMetronome: (enabled: boolean) => void;
  setSpeed: (speed: 0.5 | 0.75 | 1) => void;
  setCountIn: (enabled: boolean) => void;
  setLoop: (loop: LoopRange | null) => void;
  setWah: (wah: number) => void;
  setKeyboardMode: (mode: KeyboardMode) => void;

  startInteractiveHole: (
    voiceId: number,
    hole: number,
    action: BreathAction,
    harpKey: HarpKey,
    bendFloat?: number,
    velocity?: number,
  ) => void;
  updateInteractiveBend: (
    voiceId: number,
    hole: number,
    action: BreathAction,
    harpKey: HarpKey,
    bendFloat: number,
  ) => void;
  stopInteractiveVoice: (voiceId: number) => void;
  panicAll: () => void;
}

const singletonEngine: SynthEngine = new WebAudioSynthEngine();
let telemetryBound = false;
let recordNoteHandler: RecordNoteHandler | null = null;

interface InFlightRecordedVoice {
  startTick: number;
  hole: number;
  action: BreathAction;
  bendSteps: BendSteps;
}

const inFlightRecordings = new Map<number, InFlightRecordedVoice>();

function flushRecordedVoice(voiceId: number, currentTick: number): void {
  const rec = inFlightRecordings.get(voiceId);
  if (!rec) return;
  inFlightRecordings.delete(voiceId);
  if (!recordNoteHandler) return;
  const durationTicks = Math.max(120, Math.round(currentTick - rec.startTick));
  recordNoteHandler({
    absStartTick: Math.max(0, Math.round(rec.startTick)),
    durationTicks,
    holes: [rec.hole],
    action: rec.action,
    bendSteps: rec.bendSteps,
  });
}

function flushAllRecordedVoices(currentTick: number): void {
  for (const voiceId of [...inFlightRecordings.keys()]) {
    flushRecordedVoice(voiceId, currentTick);
  }
}

export const useAudioStore = create<AudioStoreState>((set, get) => {
  if (!telemetryBound) {
    telemetryBound = true;
    singletonEngine.subscribeTelemetry((t: WorkletTelemetry) => {
      const normalizedCountIn =
        t.countInBeat && t.countInBeat > 0 ? t.countInBeat : undefined;
      set((prev) => ({
        audioState: singletonEngine.getState(),
        playing: t.playing,
        recording: t.playing ? prev.recording : false,
        currentTick: t.currentTick,
        activeHoles: t.activeHoles,
        peakLevel: t.peakLevel,
        cpuLoad: t.cpuLoad,
        countInBeat: normalizedCountIn,
      }));
    });
  }

  return {
    engine: singletonEngine,
    audioState: singletonEngine.getState(),
    playing: false,
    recording: false,
    recordingMetronome: true,
    currentTick: 0,
    activeHoles: [],
    peakLevel: 0,
    cpuLoad: 0,
    countInBeat: undefined,
    speed: 1,
    countIn: false,
    loop: null,
    wah: 0.75,
    keyboardMode: 'two-row',
    liveNotes: {},

    unlockAudio: async () => {
      await singletonEngine.unlock();
      set({ audioState: singletonEngine.getState() });
    },

    loadSongIntoEngine: (doc: SongDocument) => {
      singletonEngine.loadSong(doc);
    },

    setRecordNoteHandler: (handler) => {
      recordNoteHandler = handler;
    },

    play: async (doc: SongDocument, startTick?: number) => {
      const { speed, countIn, loop, currentTick, recording } = get();
      if (recording) {
        flushAllRecordedVoices(currentTick);
      }
      singletonEngine.loadSong(doc);
      const totalTicks = getTotalTicks(doc.bars);
      const effectiveStart =
        startTick !== undefined
          ? Math.max(0, Math.round(startTick))
          : totalTicks > 0 && currentTick >= totalTicks - 1
            ? 0
            : Math.max(0, Math.round(currentTick));

      // Invoke unlock synchronously inside click gesture before awaiting
      const unlockPromise = singletonEngine.unlock();
      singletonEngine.transport({
        action: 'play',
        startTick: effectiveStart,
        speed,
        countIn,
        loop,
      });
      await unlockPromise;
      set({
        audioState: singletonEngine.getState(),
        playing: true,
        recording: false,
        currentTick: effectiveStart,
      });
    },

    pause: () => {
      const { recording, currentTick } = get();
      if (recording) {
        flushAllRecordedVoices(currentTick);
      }
      singletonEngine.transport({ action: 'pause' });
      set({ playing: false, recording: false });
    },

    stop: () => {
      const { recording, currentTick, loop } = get();
      if (recording) {
        flushAllRecordedVoices(currentTick);
      }
      singletonEngine.transport({ action: 'stop' });
      set({
        playing: false,
        recording: false,
        currentTick: loop ? loop.startTick : 0,
        activeHoles: [],
        countInBeat: undefined,
      });
    },

    seek: (tick: number) => {
      const safeTick = Math.max(0, Math.round(tick));
      const { playing, recording, speed, loop, recordingMetronome } = get();
      set({ currentTick: safeTick });
      if (recording) {
        flushAllRecordedVoices(safeTick);
        singletonEngine.transport({
          action: 'record',
          startTick: safeTick,
          speed,
          countIn: false,
          metronome: recordingMetronome,
        });
      } else if (playing) {
        singletonEngine.transport({
          action: 'play',
          startTick: safeTick,
          speed,
          countIn: false,
          loop,
        });
      } else {
        // Persist sought caret inside the AudioWorklet so 60Hz telemetry never snaps back to 0
        singletonEngine.transport({
          action: 'seek',
          startTick: safeTick,
        });
      }
    },

    startRecording: async (doc: SongDocument, startTick?: number) => {
      const { speed, countIn, currentTick, recordingMetronome } = get();
      inFlightRecordings.clear();
      singletonEngine.loadSong(doc);
      const effectiveStart =
        startTick !== undefined ? Math.max(0, Math.round(startTick)) : Math.max(0, Math.round(currentTick));

      const unlockPromise = singletonEngine.unlock();
      singletonEngine.transport({
        action: 'record',
        startTick: effectiveStart,
        speed,
        countIn,
        loop: null,
        metronome: recordingMetronome,
      });
      await unlockPromise;
      set({
        audioState: singletonEngine.getState(),
        playing: true,
        recording: true,
        currentTick: effectiveStart,
      });
    },

    stopRecording: () => {
      const { currentTick } = get();
      flushAllRecordedVoices(currentTick);
      singletonEngine.transport({ action: 'pause' });
      set({ playing: false, recording: false, countInBeat: undefined });
    },

    setRecordingMetronome: (recordingMetronome) => set({ recordingMetronome }),

    setSpeed: (speed) => {
      const { playing, recording, loop, recordingMetronome } = get();
      set({ speed });
      if (recording) {
        singletonEngine.transport({
          action: 'record',
          speed,
          countIn: false,
          metronome: recordingMetronome,
        });
      } else if (playing) {
        singletonEngine.transport({
          action: 'play',
          speed,
          countIn: false,
          loop,
        });
      }
    },

    setCountIn: (countIn) => set({ countIn }),

    setLoop: (loop) => {
      const { playing, recording, speed } = get();
      set({ loop });
      if (playing && !recording) {
        singletonEngine.transport({
          action: 'play',
          speed,
          countIn: false,
          loop,
        });
      }
    },

    setWah: (wah) => {
      const clamped = Math.max(0, Math.min(1, wah));
      singletonEngine.setWah(clamped);
      set({ wah: clamped });
    },

    setKeyboardMode: (keyboardMode) => set({ keyboardMode }),

    startInteractiveHole: (voiceId, hole, action, harpKey, bendFloat = 0, velocity = 0.85) => {
      const { wah, recording, countInBeat, currentTick } = get();
      // Unlock synchronously on first interaction so the very first click sounds immediately
      void singletonEngine.unlock().then(() => {
        set({ audioState: singletonEngine.getState() });
      });

      const clampedMax = clampBendSteps('richter', hole, action, 3);
      const safeBendFloat = Math.max(0, Math.min(clampedMax, bendFloat));
      const wholeSteps = Math.floor(safeBendFloat) as BendSteps;
      const extraCents = -Math.round((safeBendFloat - wholeSteps) * 100);
      const midi = resolveHoleMidi('richter', harpKey, hole, action, wholeSteps, extraCents);
      const freqHz = midiToHz(midi);

      singletonEngine.noteOn(voiceId, freqHz, velocity, wah, hole);

      const displaySteps = Math.round(safeBendFloat) as BendSteps;

      // Capture live DAW note onset when recording (ignoring count-in beats & preview voices >= 9000)
      if (recording && countInBeat === undefined && voiceId < 9000) {
        inFlightRecordings.set(voiceId, {
          startTick: Math.max(0, currentTick),
          hole,
          action,
          bendSteps: displaySteps,
        });
      }

      set((s) => ({
        audioState: singletonEngine.getState(),
        liveNotes: {
          ...s.liveNotes,
          [voiceId]: {
            voiceId,
            hole,
            action,
            bendSteps: displaySteps,
            bendCents: Math.round(-safeBendFloat * 100),
            freqHz,
          },
        },
      }));
    },

    updateInteractiveBend: (voiceId, hole, action, harpKey, bendFloat) => {
      const clampedMax = clampBendSteps('richter', hole, action, 3);
      const safeBendFloat = Math.max(0, Math.min(clampedMax, bendFloat));
      const wholeSteps = Math.floor(safeBendFloat) as BendSteps;
      const extraCents = -Math.round((safeBendFloat - wholeSteps) * 100);
      const midi = resolveHoleMidi('richter', harpKey, hole, action, wholeSteps, extraCents);
      const freqHz = midiToHz(midi);

      singletonEngine.notePitch(voiceId, freqHz);

      const displaySteps = Math.round(safeBendFloat) as BendSteps;
      const rec = inFlightRecordings.get(voiceId);
      if (rec && displaySteps > rec.bendSteps) {
        rec.bendSteps = displaySteps;
      }

      set((s) => ({
        liveNotes: {
          ...s.liveNotes,
          [voiceId]: {
            voiceId,
            hole,
            action,
            bendSteps: displaySteps,
            bendCents: Math.round(-safeBendFloat * 100),
            freqHz,
          },
        },
      }));
    },

    stopInteractiveVoice: (voiceId) => {
      singletonEngine.noteOff(voiceId);
      if (inFlightRecordings.has(voiceId)) {
        flushRecordedVoice(voiceId, get().currentTick);
      }
      set((s) => {
        const next = { ...s.liveNotes };
        delete next[voiceId];
        return { liveNotes: next };
      });
    },

    panicAll: () => {
      inFlightRecordings.clear();
      singletonEngine.panic();
      set({ playing: false, recording: false, liveNotes: {}, activeHoles: [] });
    },
  };
});
