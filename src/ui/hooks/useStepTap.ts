import { useCallback, useEffect, useRef, useState } from 'react';
import { PPQ, type SongDocument } from '../../schema/song.ts';

export interface StepTapTarget {
  barIndex: number;
  noteId: string;
}

export interface StampedTiming {
  barIndex: number;
  noteId: string;
  offsetTick: number;
  durationTicks: number;
}

export interface UseStepTapResult {
  active: boolean;
  cursorIndex: number;
  totalNotes: number;
  currentTarget: StepTapTarget | null;
  startStepTap: (speed?: 0.5 | 1) => void;
  cancelStepTap: () => void;
  finishStepTap: () => void;
  stepTapSpeed: 0.5 | 1;
}

/**
 * Half-speed or full-speed sequential Spacebar Step-Tap rhythm stamper.
 * Stamps exact tick offsets & durations onto sequential notes with optional snap.
 */
export function useStepTap(
  doc: SongDocument,
  snapTicks: number,
  onCommit: (timings: StampedTiming[]) => void,
): UseStepTapResult {
  const [active, setActive] = useState(false);
  const [stepTapSpeed, setStepTapSpeed] = useState<0.5 | 1>(0.5);
  const [cursorIndex, setCursorIndex] = useState(0);

  const targetsRef = useRef<StepTapTarget[]>([]);
  const tapTimesMsRef = useRef<number[]>([]);
  const startTimeMsRef = useRef<number | null>(null);

  const flattenTargets = useCallback((song: SongDocument): StepTapTarget[] => {
    const out: StepTapTarget[] = [];
    for (let bi = 0; bi < song.bars.length; bi++) {
      const bar = song.bars[bi]!;
      for (const note of bar.notes) {
        out.push({ barIndex: bi, noteId: note.id });
      }
    }
    return out;
  }, []);

  const commitCollected = useCallback(
    (targets: StepTapTarget[], tapTimesMs: number[], speed: 0.5 | 1) => {
      if (tapTimesMs.length === 0) return;
      const t0 = tapTimesMs[0]!;
      // Convert elapsed ms into song ticks, scaling by stepTapSpeed (0.5x means player tapped at half tempo)
      const msPerTick = (60_000 / doc.bpm / PPQ) / speed;

      const snap = (rawTicks: number): number => {
        if (snapTicks <= 0) return Math.max(0, Math.round(rawTicks));
        return Math.max(0, Math.round(rawTicks / snapTicks) * snapTicks);
      };

      // Group stamped timestamps per bar so each bar begins cleanly at offset 0
      const byBar = new Map<number, Array<{ noteId: string; absTick: number }>>();
      for (let i = 0; i < tapTimesMs.length && i < targets.length; i++) {
        const target = targets[i]!;
        const rawTicks = (tapTimesMs[i]! - t0) / msPerTick;
        const absTick = snap(rawTicks);
        const list = byBar.get(target.barIndex) ?? [];
        list.push({ noteId: target.noteId, absTick });
        byBar.set(target.barIndex, list);
      }

      const result: StampedTiming[] = [];
      for (const [barIndex, items] of byBar.entries()) {
        const barBase = items[0]?.absTick ?? 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i]!;
          const next = items[i + 1];
          const offsetTick = Math.max(0, item.absTick - barBase);
          const rawDur = next ? next.absTick - item.absTick : PPQ;
          const durationTicks = Math.max(snapTicks > 0 ? snapTicks : 120, rawDur);
          result.push({
            barIndex,
            noteId: item.noteId,
            offsetTick,
            durationTicks,
          });
        }
      }

      onCommit(result);
    },
    [doc.bpm, onCommit, snapTicks],
  );

  const startStepTap = useCallback(
    (speed: 0.5 | 1 = 0.5) => {
      const targets = flattenTargets(doc);
      if (targets.length === 0) return;
      targetsRef.current = targets;
      tapTimesMsRef.current = [];
      startTimeMsRef.current = null;
      setStepTapSpeed(speed);
      setCursorIndex(0);
      setActive(true);
    },
    [doc, flattenTargets],
  );

  const cancelStepTap = useCallback(() => {
    setActive(false);
    setCursorIndex(0);
    tapTimesMsRef.current = [];
    startTimeMsRef.current = null;
  }, []);

  const finishStepTap = useCallback(() => {
    commitCollected(targetsRef.current, tapTimesMsRef.current, stepTapSpeed);
    setActive(false);
    setCursorIndex(0);
    tapTimesMsRef.current = [];
  }, [commitCollected, stepTapSpeed]);

  useEffect(() => {
    if (!active) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        cancelStepTap();
        return;
      }
      if (e.code === 'Enter') {
        e.preventDefault();
        finishStepTap();
        return;
      }
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        const now = performance.now();
        if (startTimeMsRef.current === null) {
          startTimeMsRef.current = now;
        }
        tapTimesMsRef.current.push(now);
        const nextIdx = tapTimesMsRef.current.length;
        if (nextIdx >= targetsRef.current.length) {
          commitCollected(targetsRef.current, tapTimesMsRef.current, stepTapSpeed);
          setActive(false);
          setCursorIndex(0);
          tapTimesMsRef.current = [];
        } else {
          setCursorIndex(nextIdx);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, cancelStepTap, commitCollected, finishStepTap, stepTapSpeed]);

  const currentTarget = active ? (targetsRef.current[cursorIndex] ?? null) : null;

  return {
    active,
    cursorIndex,
    totalNotes: targetsRef.current.length,
    currentTarget,
    startStepTap,
    cancelStepTap,
    finishStepTap,
    stepTapSpeed,
  };
}
