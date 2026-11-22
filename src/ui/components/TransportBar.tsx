import { useEffect, useState, type ChangeEvent } from 'react';
import {
  HARP_KEYS,
  barAbsoluteStartTick,
  getTotalTicks,
  type HarpKey,
} from '../../schema/song.ts';
import { useSongStore } from '../state/useSongStore.ts';
import { useAudioStore } from '../state/useAudioStore.ts';

const SPEEDS: readonly (0.5 | 0.75 | 1)[] = [0.5, 0.75, 1];

function resolveLoopBarBounds(
  bars: readonly { durationTicks: number }[],
  startTick: number,
  endTick: number,
): { startBar: number; endBar: number } {
  if (bars.length === 0) {
    return { startBar: 1, endBar: 1 };
  }
  let startBar = 1;
  let endBar = 1;
  let cursor = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const barStart = cursor;
    const barEnd = cursor + bar.durationTicks;
    if (startTick >= barStart && startTick < barEnd) {
      startBar = i + 1;
    }
    if (endTick > barStart && endTick <= barEnd) {
      endBar = i + 1;
    }
    cursor = barEnd;
  }

  if (endTick > cursor) {
    endBar = bars.length;
  }
  if (endBar < startBar) {
    endBar = startBar;
  }
  return { startBar, endBar };
}

export function TransportBar() {
  const doc = useSongStore((s) => s.doc);
  const setMetadata = useSongStore((s) => s.setMetadata);
  const transposeHarpKey = useSongStore((s) => s.transposeHarpKey);

  const playing = useAudioStore((s) => s.playing);
  const recording = useAudioStore((s) => s.recording);
  const currentTick = useAudioStore((s) => s.currentTick);
  const speed = useAudioStore((s) => s.speed);
  const countIn = useAudioStore((s) => s.countIn);
  const countInBeat = useAudioStore((s) => s.countInBeat);
  const loop = useAudioStore((s) => s.loop);
  const play = useAudioStore((s) => s.play);
  const pause = useAudioStore((s) => s.pause);
  const stop = useAudioStore((s) => s.stop);
  const startRecording = useAudioStore((s) => s.startRecording);
  const stopRecording = useAudioStore((s) => s.stopRecording);
  const setSpeed = useAudioStore((s) => s.setSpeed);
  const setCountIn = useAudioStore((s) => s.setCountIn);
  const setLoop = useAudioStore((s) => s.setLoop);
  const loadSongIntoEngine = useAudioStore((s) => s.loadSongIntoEngine);

  const [titleDraft, setTitleDraft] = useState(doc.title);
  const [bpmDraft, setBpmDraft] = useState(String(doc.bpm));
  const [swingDraft, setSwingDraft] = useState(String(doc.swingPercent));

  useEffect(() => {
    setTitleDraft(doc.title);
  }, [doc.id, doc.title]);

  useEffect(() => {
    setBpmDraft(String(doc.bpm));
  }, [doc.id, doc.bpm]);

  useEffect(() => {
    setSwingDraft(String(doc.swingPercent));
  }, [doc.id, doc.swingPercent]);

  const totalTicks = getTotalTicks(doc.bars);
  const barCount = Math.max(1, doc.bars.length);

  const handleTitleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.slice(0, 200);
    setTitleDraft(raw);
    if (raw.trim().length > 0) {
      setMetadata({ title: raw });
    }
  };

  const handleTitleBlur = () => {
    const trimmed = titleDraft.trim();
    if (trimmed.length === 0) {
      setTitleDraft(doc.title);
    } else if (trimmed !== doc.title) {
      setMetadata({ title: trimmed });
      setTitleDraft(trimmed);
    }
  };

  const handlePlayPause = () => {
    if (playing && !recording) {
      pause();
    } else {
      if (recording) {
        stopRecording();
      }
      void play(useSongStore.getState().doc);
    }
  };

  const handleToggleRecord = () => {
    if (recording) {
      stopRecording();
    } else {
      void startRecording(doc);
    }
  };

  const handleKeyChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const nextKey = e.target.value as HarpKey;
    transposeHarpKey(nextKey);
    const updatedDoc = useSongStore.getState().doc;
    loadSongIntoEngine(updatedDoc);
  };

  const handleBpmChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setBpmDraft(raw);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 30 && parsed <= 260) {
      const rounded = Math.round(parsed);
      setMetadata({ bpm: rounded });
      loadSongIntoEngine(useSongStore.getState().doc);
    }
  };

  const handleBpmBlur = () => {
    const parsed = Number(bpmDraft);
    const clamped = Number.isFinite(parsed)
      ? Math.max(30, Math.min(260, Math.round(parsed)))
      : doc.bpm;
    setBpmDraft(String(clamped));
    if (clamped !== doc.bpm) {
      setMetadata({ bpm: clamped });
      loadSongIntoEngine(useSongStore.getState().doc);
    }
  };

  const handleSwingChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setSwingDraft(raw);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 50 && parsed <= 75) {
      const rounded = Math.round(parsed);
      setMetadata({ swingPercent: rounded });
      loadSongIntoEngine(useSongStore.getState().doc);
    }
  };

  const handleSwingBlur = () => {
    const parsed = Number(swingDraft);
    const clamped = Number.isFinite(parsed)
      ? Math.max(50, Math.min(75, Math.round(parsed)))
      : doc.swingPercent;
    setSwingDraft(String(clamped));
    if (clamped !== doc.swingPercent) {
      setMetadata({ swingPercent: clamped });
      loadSongIntoEngine(useSongStore.getState().doc);
    }
  };

  const handleToggleLoop = () => {
    if (loop !== null) {
      setLoop(null);
      return;
    }
    const firstBarDuration = doc.bars[0]?.durationTicks ?? 1920;
    setLoop({ startTick: 0, endTick: firstBarDuration });
  };

  const loopBounds =
    loop !== null
      ? resolveLoopBarBounds(doc.bars, loop.startTick, loop.endTick)
      : null;

  const updateLoopBars = (nextStartBar: number, nextEndBar: number) => {
    if (doc.bars.length === 0) return;
    const clampedStartIdx = Math.max(0, Math.min(doc.bars.length - 1, nextStartBar - 1));
    const clampedEndIdx = Math.max(
      clampedStartIdx,
      Math.min(doc.bars.length - 1, nextEndBar - 1),
    );
    const startTick = barAbsoluteStartTick(doc.bars, clampedStartIdx);
    const endBar = doc.bars[clampedEndIdx];
    const endTick =
      barAbsoluteStartTick(doc.bars, clampedEndIdx) + (endBar?.durationTicks ?? 1920);
    setLoop({ startTick, endTick });
  };

  return (
    <section className="transport-bar" aria-label="Playback transport">
      <div className="side-section-header">
        <span className="side-section-title">Controls</span>
        <div
          className="bend-meter side-tick-meter"
          title="Sample-accurate playhead position in PPQ ticks"
        >
          <strong data-testid="playhead-tick">{Math.round(currentTick)}</strong>
          <span className="side-tick-sep">/</span>
          <span className="side-tick-total">{totalTicks}</span>
        </div>
      </div>

      <input
        type="text"
        className="song-title-input"
        data-testid="song-title-input"
        aria-label="Song title"
        value={titleDraft}
        onChange={handleTitleChange}
        onBlur={handleTitleBlur}
        placeholder="Untitled Harmonica Tab"
      />

      <div className="side-grid-2">
        <button
          type="button"
          className={playing && !recording ? 'btn btn-active btn-sm' : 'btn btn-primary btn-sm'}
          data-testid="play-btn"
          onClick={handlePlayPause}
          aria-pressed={playing && !recording}
        >
          {playing && !recording ? '❚❚ Pause' : '▶ Play'}
        </button>

        <button
          type="button"
          className="btn btn-sm"
          data-testid="stop-btn"
          onClick={stop}
        >
          ■ Stop
        </button>
      </div>

      <button
        type="button"
        className={recording ? 'btn btn-record recording btn-sm side-full-btn' : 'btn btn-record btn-sm side-full-btn'}
        data-testid="record-btn"
        onClick={handleToggleRecord}
        aria-pressed={recording}
        title="Record live notes from the comb or keyboard onto the timeline"
      >
        {recording ? '■ Stop Rec' : '● Record'}
      </button>

      <div className="side-row-between">
        <span className="side-label">Speed</span>
        <div className="segmented" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={speed === s ? 'active' : undefined}
              data-testid={`speed-${s}`}
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>

      <div className="side-grid-2">
        <button
          type="button"
          className={countIn || countInBeat !== undefined ? 'btn btn-active btn-sm' : 'btn btn-sm'}
          data-testid="count-in-btn"
          onClick={() => setCountIn(!countIn)}
          aria-pressed={countIn}
          title="4-beat metronome count-in before playback"
        >
          {countInBeat !== undefined ? `⏱ ${countInBeat}/4` : '⏱ Count-In (4)'}
        </button>

        <button
          type="button"
          className={loop !== null ? 'btn btn-active btn-sm' : 'btn btn-sm'}
          data-testid="loop-toggle-btn"
          onClick={handleToggleLoop}
          aria-pressed={loop !== null}
          title="Toggle A-B bar loop"
        >
          ↻ Loop
        </button>
      </div>

      {loopBounds !== null && (
        <div className="side-grid-2" aria-label="Loop bar range">
          <label className="field-inline side-field-stack">
            <span>Loop A</span>
            <input
              type="number"
              className="side-input"
              min={1}
              max={barCount}
              value={loopBounds.startBar}
              data-testid="loop-start-bar"
              onChange={(e) => {
                const val = Number(e.target.value);
                if (Number.isFinite(val)) {
                  updateLoopBars(Math.round(val), loopBounds.endBar);
                }
              }}
            />
          </label>
          <label className="field-inline side-field-stack">
            <span>Loop B</span>
            <input
              type="number"
              className="side-input"
              min={loopBounds.startBar}
              max={barCount}
              value={loopBounds.endBar}
              data-testid="loop-end-bar"
              onChange={(e) => {
                const val = Number(e.target.value);
                if (Number.isFinite(val)) {
                  updateLoopBars(loopBounds.startBar, Math.round(val));
                }
              }}
            />
          </label>
        </div>
      )}

      <div className="side-grid-3">
        <label className="field-inline side-field-stack">
          <span>Key</span>
          <select
            className="side-input"
            data-testid="harp-key-select"
            aria-label="Harp key"
            value={doc.instrument.harpKey}
            onChange={handleKeyChange}
          >
            {HARP_KEYS.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>

        <label className="field-inline side-field-stack">
          <span>BPM</span>
          <input
            type="number"
            className="side-input"
            min={30}
            max={260}
            value={bpmDraft}
            data-testid="bpm-input"
            aria-label="Tempo in BPM"
            onChange={handleBpmChange}
            onBlur={handleBpmBlur}
          />
        </label>

        <label className="field-inline side-field-stack">
          <span>Swing%</span>
          <input
            type="number"
            className="side-input"
            min={50}
            max={75}
            value={swingDraft}
            data-testid="swing-input"
            aria-label="Swing percentage"
            onChange={handleSwingChange}
            onBlur={handleSwingBlur}
          />
        </label>
      </div>
    </section>
  );
}
