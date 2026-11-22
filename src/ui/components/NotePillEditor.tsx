import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  PPQ,
  getTotalTicks,
  type Articulation,
  type Bar,
  type BendSteps,
  type BreathAction,
  type HarmonicaNote,
  type LyricSpan,
} from '../../schema/song.ts';
import {
  clampBendSteps,
  formatNoteCaption,
  formatNoteToken,
  maxBendSteps,
} from '../../schema/tuning.ts';
import type { UseStepTapResult } from '../hooks/useStepTap.ts';
import { useAudioStore } from '../state/useAudioStore.ts';
import { useSongStore } from '../state/useSongStore.ts';

export interface NotePillEditorProps {
  stepTap: UseStepTapResult;
}

interface EditingLyricState {
  barId: string;
  lyricId: string;
  text: string;
  joinNext: boolean;
  isNewEmpty: boolean;
}

interface DraggingNoteState {
  fromBarId: string;
  noteId: string;
  targetBarId: string;
  previewOffsetTick: number;
  note: HarmonicaNote;
}

interface DraggingLyricState {
  barId: string;
  lyricId: string;
  previewOffsetTick: number;
}

const ARTICULATION_SHORT: Readonly<Record<Articulation, string>> = {
  slur: 'slur',
  vibrato: 'vib',
  trill: 'tr',
  wah: 'wah',
};

const ALL_HOLES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const PREVIEW_VOICE_BASE = 9000;
const PREVIEW_DURATION_MS = 220;
const NOTE_DRAG_THRESHOLD_PX = 5;

export function NotePillEditor({ stepTap }: NotePillEditorProps) {
  const doc = useSongStore((s) => s.doc);
  const selectedNote = useSongStore((s) => s.selectedNote);
  const snapTicks = useSongStore((s) => s.snapTicks);

  const duplicateBar = useSongStore((s) => s.duplicateBar);
  const reorderBars = useSongStore((s) => s.reorderBars);
  const setBarDuration = useSongStore((s) => s.setBarDuration);
  const fitBarToNotes = useSongStore((s) => s.fitBarToNotes);
  const deleteBar = useSongStore((s) => s.deleteBar);
  const insertNote = useSongStore((s) => s.insertNote);
  const updateNote = useSongStore((s) => s.updateNote);
  const deleteNote = useSongStore((s) => s.deleteNote);
  const upsertLyric = useSongStore((s) => s.upsertLyric);
  const deleteLyric = useSongStore((s) => s.deleteLyric);
  const selectNote = useSongStore((s) => s.selectNote);

  const playing = useAudioStore((s) => s.playing);
  const recording = useAudioStore((s) => s.recording);
  const stopRecording = useAudioStore((s) => s.stopRecording);
  const currentTick = useAudioStore((s) => s.currentTick);
  const speed = useAudioStore((s) => s.speed);
  const countInBeat = useAudioStore((s) => s.countInBeat);
  const loop = useAudioStore((s) => s.loop);
  const seek = useAudioStore((s) => s.seek);
  const startInteractiveHole = useAudioStore((s) => s.startInteractiveHole);
  const stopInteractiveVoice = useAudioStore((s) => s.stopInteractiveVoice);

  const [editingLyric, setEditingLyric] = useState<EditingLyricState | null>(null);
  const [displayTick, setDisplayTick] = useState<number>(currentTick);
  const [draggingNote, setDraggingNote] = useState<DraggingNoteState | null>(null);
  const [draggingLyric, setDraggingLyric] = useState<DraggingLyricState | null>(null);
  const [draggingBarIndex, setDraggingBarIndex] = useState<number | null>(null);
  const [dragOverBarIndex, setDragOverBarIndex] = useState<number | null>(null);

  const draggingBarIndexRef = useRef<number | null>(null);

  // Smooth rAF interpolation between WorkletTelemetry frames while playing
  const telemetryAnchorRef = useRef<{ tick: number; timeMs: number }>({
    tick: currentTick,
    timeMs: typeof performance !== 'undefined' ? performance.now() : 0,
  });

  const totalTicks = useMemo(() => getTotalTicks(doc.bars), [doc.bars]);

  const barStarts = useMemo(() => {
    const starts: number[] = [];
    let acc = 0;
    for (const bar of doc.bars) {
      starts.push(acc);
      acc += bar.durationTicks;
    }
    return starts;
  }, [doc.bars]);

  useEffect(() => {
    telemetryAnchorRef.current = {
      tick: currentTick,
      timeMs: performance.now(),
    };
    setDisplayTick(currentTick);
  }, [currentTick]);

  useEffect(() => {
    if (!playing || countInBeat !== undefined) {
      setDisplayTick(currentTick);
      return;
    }

    let rafId = 0;
    const ticksPerMs = (doc.bpm / 60_000) * PPQ * speed;
    const maxLeadTicks = Math.max(60, ticksPerMs * 120);

    const tickFrame = (nowMs: number) => {
      const anchor = telemetryAnchorRef.current;
      const elapsedMs = Math.max(0, nowMs - anchor.timeMs);
      const predicted = anchor.tick + Math.min(maxLeadTicks, elapsedMs * ticksPerMs);
      const upperBound = recording
        ? Number.POSITIVE_INFINITY
        : loop && anchor.tick < loop.endTick
          ? Math.min(totalTicks, loop.endTick)
          : totalTicks;
      const clamped =
        upperBound === Number.POSITIVE_INFINITY
          ? Math.max(0, predicted)
          : upperBound > 0
            ? Math.min(upperBound - 0.001, Math.max(0, predicted))
            : 0;
      setDisplayTick(clamped);
      rafId = requestAnimationFrame(tickFrame);
    };

    rafId = requestAnimationFrame(tickFrame);
    return () => cancelAnimationFrame(rafId);
  }, [playing, recording, countInBeat, doc.bpm, speed, loop, totalTicks, currentTick]);

  // Immediate caret feedback when paused/seeking; smooth rAF interpolation while playing
  const activeDisplayTick = playing && countInBeat === undefined ? displayTick : currentTick;

  // Determine which bar owns the moving caret so page scrolling smoothly follows playback/recording
  const activeBarIndex = useMemo(() => {
    if (doc.bars.length === 0) return -1;
    for (let i = 0; i < doc.bars.length; i++) {
      const start = barStarts[i] ?? 0;
      const end = start + (doc.bars[i]?.durationTicks ?? 0);
      if (activeDisplayTick >= start && (activeDisplayTick < end || i === doc.bars.length - 1)) {
        return i;
      }
    }
    return 0;
  }, [activeDisplayTick, barStarts, doc.bars]);

  const lastAutoScrolledBarRef = useRef<number>(-1);

  useEffect(() => {
    if (!playing && !recording) {
      lastAutoScrolledBarRef.current = -1;
      return;
    }
    if (activeBarIndex < 0 || activeBarIndex === lastAutoScrolledBarRef.current) return;
    lastAutoScrolledBarRef.current = activeBarIndex;

    const barEl = document.querySelector<HTMLElement>(
      `[data-testid="bar-row-${activeBarIndex}"]`,
    );
    if (!barEl) return;

    const rect = barEl.getBoundingClientRect();
    const vh = window.innerHeight;
    const combEl = document.querySelector<HTMLElement>('.comb-section');
    const combHeight = combEl ? combEl.getBoundingClientRect().height : 0;
    const safeTop = 76;
    const safeBottom = Math.max(safeTop + 140, vh - combHeight - 28);

    if (rect.top < safeTop || rect.bottom > safeBottom) {
      const targetScrollTop = Math.max(0, window.scrollY + rect.top - Math.max(88, vh * 0.22));
      window.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
    }
  }, [activeBarIndex, playing, recording]);

  // Brief note preview voice management
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewVoicesRef = useRef<number[]>([]);

  const stopPreview = useCallback(() => {
    if (previewTimerRef.current !== null) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    if (previewVoicesRef.current.length > 0) {
      for (const vid of previewVoicesRef.current) {
        stopInteractiveVoice(vid);
      }
      previewVoicesRef.current = [];
    }
  }, [stopInteractiveVoice]);

  const previewNote = useCallback(
    (note: HarmonicaNote) => {
      if (playing || stepTap.active) return;
      stopPreview();
      const voices: number[] = [];
      for (let i = 0; i < note.holes.length; i++) {
        const hole = note.holes[i];
        if (hole === undefined) continue;
        const vid = PREVIEW_VOICE_BASE + i;
        voices.push(vid);
        startInteractiveHole(
          vid,
          hole,
          note.action,
          doc.instrument.harpKey,
          note.bendSteps,
          0.72,
        );
      }
      previewVoicesRef.current = voices;
      previewTimerRef.current = setTimeout(() => {
        stopPreview();
      }, PREVIEW_DURATION_MS);
    },
    [doc.instrument.harpKey, playing, startInteractiveHole, stepTap.active, stopPreview],
  );

  // Cleanup active pointer drag/resize listeners and preview timers on unmount
  const activePointerCleanupRef = useRef<(() => void) | null>(null);
  const suppressTrackClickRef = useRef(false);
  const suppressNoteClickRef = useRef(false);
  const suppressLyricClickRef = useRef(false);

  useEffect(() => {
    return () => {
      stopPreview();
      activePointerCleanupRef.current?.();
    };
  }, [stopPreview]);

  const handleAddNoteInBar = (bar: Bar) => {
    let nextOffset = 0;
    for (const n of bar.notes) {
      nextOffset = Math.max(nextOffset, n.offsetTick + n.durationTicks);
    }
    if (snapTicks > 0 && nextOffset > 0) {
      nextOffset = Math.round(nextOffset / snapTicks) * snapTicks;
    }
    const defaultDuration = snapTicks > 0 ? Math.max(snapTicks, 240) : PPQ;
    insertNote(bar.id, {
      offsetTick: nextOffset,
      durationTicks: defaultDuration,
      holes: [4],
      action: 'blow',
      bendSteps: 0,
    });
  };

  const handleAddLyricInBar = (bar: Bar) => {
    // Prefer placing under currently selected note in this bar if no lyric exists at its offset
    let offsetTick = 0;
    let durationTicks: number = PPQ;

    const selInBar =
      selectedNote?.barId === bar.id
        ? bar.notes.find((n) => n.id === selectedNote.noteId)
        : undefined;

    if (selInBar && !bar.lyrics.some((l) => l.offsetTick === selInBar.offsetTick)) {
      offsetTick = selInBar.offsetTick;
      durationTicks = selInBar.durationTicks;
    } else if (bar.lyrics.length > 0) {
      for (const l of bar.lyrics) {
        offsetTick = Math.max(offsetTick, l.offsetTick + l.durationTicks);
      }
      durationTicks = snapTicks > 0 ? Math.max(snapTicks, 240) : PPQ;
    } else if (bar.notes.length > 0) {
      const firstNote = bar.notes[0]!;
      offsetTick = firstNote.offsetTick;
      durationTicks = firstNote.durationTicks;
    }

    const id = `l-${Math.random().toString(36).slice(2, 9)}`;
    upsertLyric(bar.id, {
      id,
      offsetTick,
      durationTicks,
      text: '',
    });
    setEditingLyric({
      barId: bar.id,
      lyricId: id,
      text: '',
      joinNext: false,
      isNewEmpty: true,
    });
  };

  const handleStartResize = (
    e: ReactPointerEvent<HTMLDivElement>,
    bar: Bar,
    note: HarmonicaNote,
  ) => {
    e.stopPropagation();
    e.preventDefault();

    activePointerCleanupRef.current?.();

    const trackEl = e.currentTarget.closest('.bar-track') as HTMLElement | null;
    const trackWidth = trackEl ? trackEl.getBoundingClientRect().width : 600;
    const startX = e.clientX;
    const startDuration = note.durationTicks;
    const ticksPerPx = bar.durationTicks / Math.max(1, trackWidth);
    let lastAppliedTicks = startDuration;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaPx = moveEvent.clientX - startX;
      const rawTicks = Math.max(60, Math.round(startDuration + deltaPx * ticksPerPx));
      const store = useSongStore.getState();
      const snap = store.snapTicks;
      const snapped =
        snap > 0
          ? Math.max(snap, Math.round(rawTicks / snap) * snap)
          : Math.max(60, rawTicks);

      if (snapped !== lastAppliedTicks) {
        lastAppliedTicks = snapped;
        store.resizeNoteDuration(bar.id, note.id, rawTicks);
      }
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      activePointerCleanupRef.current = null;
    };

    const onPointerUp = () => {
      suppressTrackClickRef.current = true;
      setTimeout(() => {
        suppressTrackClickRef.current = false;
      }, 0);
      cleanup();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    activePointerCleanupRef.current = cleanup;
  };

  const handleStartNoteDrag = (
    e: ReactPointerEvent<HTMLDivElement>,
    bar: Bar,
    note: HarmonicaNote,
  ) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement | null)?.closest('.note-pill-resize')) return;
    e.stopPropagation();

    activePointerCleanupRef.current?.();

    const startX = e.clientX;
    const startY = e.clientY;
    const pillRect = e.currentTarget.getBoundingClientRect();
    const grabOffsetPx = e.clientX - pillRect.left;

    let hasDragged = false;
    let latestTargetBarId = bar.id;
    let latestOffsetTick = note.offsetTick;

    const resolveTargetAtPoint = (clientX: number, clientY: number) => {
      const tracks = Array.from(
        document.querySelectorAll<HTMLElement>('[data-bar-track-id]'),
      );
      let matchedTrack: HTMLElement | null = null;
      let bestDist = Number.POSITIVE_INFINITY;

      for (const el of tracks) {
        const row = el.closest('.bar-row');
        const hitRect = row ? row.getBoundingClientRect() : el.getBoundingClientRect();
        if (clientY >= hitRect.top && clientY <= hitRect.bottom) {
          matchedTrack = el;
          break;
        }
        const centerY = hitRect.top + hitRect.height / 2;
        const dist = Math.abs(clientY - centerY);
        if (dist < bestDist) {
          bestDist = dist;
          matchedTrack = el;
        }
      }

      if (!matchedTrack) {
        return { targetBarId: latestTargetBarId, previewOffsetTick: latestOffsetTick };
      }

      const targetBarId = matchedTrack.dataset.barTrackId ?? bar.id;
      const store = useSongStore.getState();
      const targetBar = store.doc.bars.find((b) => b.id === targetBarId);
      const targetDuration = targetBar?.durationTicks ?? bar.durationTicks;
      const trackRect = matchedTrack.getBoundingClientRect();
      const rawLeftPx = Math.max(
        0,
        Math.min(trackRect.width, clientX - grabOffsetPx - trackRect.left),
      );
      const rawTicks = Math.round(
        (rawLeftPx / Math.max(1, trackRect.width)) * targetDuration,
      );
      const snap = store.snapTicks;
      const snappedTicks =
        snap > 0
          ? Math.max(0, Math.round(rawTicks / snap) * snap)
          : Math.max(0, rawTicks);

      return { targetBarId, previewOffsetTick: snappedTicks };
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!hasDragged && Math.hypot(dx, dy) <= NOTE_DRAG_THRESHOLD_PX) {
        return;
      }
      hasDragged = true;

      const resolved = resolveTargetAtPoint(moveEvent.clientX, moveEvent.clientY);
      latestTargetBarId = resolved.targetBarId;
      latestOffsetTick = resolved.previewOffsetTick;

      setDraggingNote({
        fromBarId: bar.id,
        noteId: note.id,
        targetBarId: latestTargetBarId,
        previewOffsetTick: latestOffsetTick,
        note,
      });
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      activePointerCleanupRef.current = null;
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      cleanup();
      setDraggingNote(null);

      if (hasDragged) {
        const resolved = resolveTargetAtPoint(upEvent.clientX, upEvent.clientY);
        suppressTrackClickRef.current = true;
        suppressNoteClickRef.current = true;
        setTimeout(() => {
          suppressTrackClickRef.current = false;
          suppressNoteClickRef.current = false;
        }, 0);
        useSongStore
          .getState()
          .moveNote(bar.id, note.id, resolved.targetBarId, resolved.previewOffsetTick);
      }
    };

    const onPointerCancel = () => {
      cleanup();
      setDraggingNote(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    activePointerCleanupRef.current = cleanup;
  };

  const handleStartLyricDrag = (
    e: ReactPointerEvent<HTMLDivElement>,
    bar: Bar,
    lyric: LyricSpan,
  ) => {
    if (e.button !== 0) return;
    if (editingLyric?.barId === bar.id && editingLyric.lyricId === lyric.id) return;
    e.stopPropagation();

    activePointerCleanupRef.current?.();

    const trackEl = e.currentTarget.closest('.bar-track') as HTMLElement | null;
    if (!trackEl) return;

    const startX = e.clientX;
    const chipRect = e.currentTarget.getBoundingClientRect();
    const grabOffsetPx = e.clientX - chipRect.left;
    const maxOffset = Math.max(0, bar.durationTicks - lyric.durationTicks);

    let hasDragged = false;
    let latestOffsetTick = lyric.offsetTick;

    const resolveIntraBarTick = (clientX: number): number => {
      const trackRect = trackEl.getBoundingClientRect();
      const rawLeftPx = Math.max(
        0,
        Math.min(trackRect.width, clientX - grabOffsetPx - trackRect.left),
      );
      const rawTicks = Math.round(
        (rawLeftPx / Math.max(1, trackRect.width)) * bar.durationTicks,
      );
      const snap = useSongStore.getState().snapTicks;
      const snapped = snap > 0 ? Math.round(rawTicks / snap) * snap : rawTicks;
      return Math.max(0, Math.min(maxOffset, snapped));
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const dx = Math.abs(moveEvent.clientX - startX);
      if (!hasDragged && dx <= NOTE_DRAG_THRESHOLD_PX) return;
      hasDragged = true;

      latestOffsetTick = resolveIntraBarTick(moveEvent.clientX);
      setDraggingLyric({
        barId: bar.id,
        lyricId: lyric.id,
        previewOffsetTick: latestOffsetTick,
      });
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      activePointerCleanupRef.current = null;
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      cleanup();
      setDraggingLyric(null);

      if (hasDragged) {
        const finalTick = resolveIntraBarTick(upEvent.clientX);
        suppressTrackClickRef.current = true;
        suppressLyricClickRef.current = true;
        setTimeout(() => {
          suppressTrackClickRef.current = false;
          suppressLyricClickRef.current = false;
        }, 0);
        useSongStore.getState().moveLyric(bar.id, lyric.id, finalTick);
      }
    };

    const onPointerCancel = () => {
      cleanup();
      setDraggingLyric(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    activePointerCleanupRef.current = cleanup;
  };

  const handleStartBarResize = (e: ReactPointerEvent<HTMLDivElement>, bar: Bar) => {
    e.stopPropagation();
    e.preventDefault();

    activePointerCleanupRef.current?.();

    const rowEl = e.currentTarget.closest('.bar-row');
    const trackEl = rowEl?.querySelector('.bar-track') as HTMLElement | null;
    const trackWidth = trackEl ? trackEl.getBoundingClientRect().width : 600;
    const startX = e.clientX;
    const startDuration = bar.durationTicks;
    const ticksPerPx = startDuration / Math.max(1, trackWidth);
    let lastAppliedTicks = startDuration;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaPx = moveEvent.clientX - startX;
      const rawTicks = Math.max(PPQ / 2, Math.round(startDuration + deltaPx * ticksPerPx));
      const store = useSongStore.getState();
      const snap = store.snapTicks;
      const snapped =
        snap > 0
          ? Math.max(PPQ / 2, Math.round(rawTicks / snap) * snap)
          : Math.max(PPQ / 2, rawTicks);

      if (snapped !== lastAppliedTicks) {
        lastAppliedTicks = snapped;
        store.setBarDuration(bar.id, snapped);
      }
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      activePointerCleanupRef.current = null;
    };

    const onPointerUp = () => {
      suppressTrackClickRef.current = true;
      setTimeout(() => {
        suppressTrackClickRef.current = false;
      }, 0);
      cleanup();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    activePointerCleanupRef.current = cleanup;
  };

  const handleTrackClick = (
    e: MouseEvent<HTMLDivElement>,
    bar: Bar,
    barStart: number,
  ) => {
    if (suppressTrackClickRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const rawTick = Math.round(ratio * bar.durationTicks);
    const snappedTick =
      snapTicks > 0 ? Math.round(rawTick / snapTicks) * snapTicks : rawTick;
    const clickedTick = Math.min(
      Math.max(0, bar.durationTicks - 1),
      Math.max(0, snappedTick),
    );
    seek(barStart + clickedTick);
  };

  const commitLyricEdit = (bar: Bar, lyric: LyricSpan) => {
    if (!editingLyric || editingLyric.barId !== bar.id || editingLyric.lyricId !== lyric.id) {
      return;
    }
    const trimmed = editingLyric.text.trim();
    if (trimmed.length === 0) {
      deleteLyric(bar.id, lyric.id);
    } else {
      upsertLyric(bar.id, {
        id: lyric.id,
        offsetTick: lyric.offsetTick,
        durationTicks: lyric.durationTicks,
        text: trimmed,
        joinNext: editingLyric.joinNext || undefined,
      });
    }
    setEditingLyric(null);
  };

  const cancelLyricEdit = (bar: Bar, lyric: LyricSpan) => {
    if (editingLyric?.isNewEmpty && lyric.text.trim().length === 0) {
      deleteLyric(bar.id, lyric.id);
    }
    setEditingLyric(null);
  };

  const handleLyricInputKeyDown = (
    e: KeyboardEvent<HTMLInputElement>,
    bar: Bar,
    lyric: LyricSpan,
  ) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitLyricEdit(bar, lyric);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelLyricEdit(bar, lyric);
    }
  };

  // Resolve selected bar & note for the floating mini-menu inspector
  const selectedContext = useMemo(() => {
    if (!selectedNote) return null;
    const bar = doc.bars.find((b) => b.id === selectedNote.barId);
    if (!bar) return null;
    const note = bar.notes.find((n) => n.id === selectedNote.noteId);
    if (!note) return null;
    return { bar, note };
  }, [doc.bars, selectedNote]);

  const inspectorPrimaryHole = selectedContext?.note.holes[0] ?? 4;
  const inspectorMaxBend: BendSteps = selectedContext
    ? maxBendSteps(doc.instrument.tuning, inspectorPrimaryHole, selectedContext.note.action)
    : 0;

  const inspectorRef = useRef<HTMLDivElement | null>(null);
  const [inspectorPos, setInspectorPos] = useState<{ top: number; left: number } | null>(null);

  const computeInspectorPosition = useCallback(() => {
    if (!selectedContext) {
      setInspectorPos(null);
      return;
    }
    const pillEl = document.querySelector<HTMLElement>(
      `[data-note-id="${selectedContext.note.id}"]`,
    );
    if (!pillEl) {
      setInspectorPos(null);
      return;
    }

    const rect = pillEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const combEl = document.querySelector<HTMLElement>('.comb-section');
    const combHeight = combEl ? combEl.getBoundingClientRect().height : 0;

    const cardWidth = Math.min(368, vw - 24);
    const cardHeight = inspectorRef.current?.offsetHeight || 292;
    const margin = 12;
    const maxBottom = Math.max(margin + cardHeight, vh - combHeight - margin);

    // Prefer placing the floating card aside the selected note (right, then left, then below)
    let left: number;
    let top: number;

    if (rect.right + margin + cardWidth <= vw - margin) {
      left = rect.right + margin;
      top = rect.top - 8;
    } else if (rect.left - margin - cardWidth >= margin) {
      left = rect.left - margin - cardWidth;
      top = rect.top - 8;
    } else {
      left = Math.max(margin, Math.min(vw - cardWidth - margin, rect.left));
      top =
        rect.bottom + 10 + cardHeight <= maxBottom
          ? rect.bottom + 10
          : Math.max(margin, rect.top - cardHeight - 10);
    }

    top = Math.max(margin, Math.min(maxBottom - cardHeight, top));
    left = Math.max(margin, Math.min(vw - cardWidth - margin, left));

    setInspectorPos({ top: Math.round(top), left: Math.round(left) });
  }, [selectedContext]);

  useEffect(() => {
    if (!selectedContext) {
      setInspectorPos(null);
      return;
    }
    const raf = requestAnimationFrame(computeInspectorPosition);
    const onScrollOrResize = () => computeInspectorPosition();
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        selectNote(null);
      }
    };
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [computeInspectorPosition, selectedContext, selectNote]);

  const handleInspectorToggleChordHole = (hole: number) => {
    if (!selectedContext) return;
    const { bar, note } = selectedContext;
    const exists = note.holes.includes(hole);
    if (exists && note.holes.length <= 1) return;
    const nextHoles = exists
      ? note.holes.filter((h) => h !== hole)
      : [...note.holes, hole].sort((a, b) => a - b);
    const safeBend = clampBendSteps(
      doc.instrument.tuning,
      nextHoles[0] ?? 4,
      note.action,
      note.bendSteps,
    );
    updateNote(bar.id, note.id, { holes: nextHoles, bendSteps: safeBend });
  };

  const handleInspectorActionChange = (nextAction: BreathAction) => {
    if (!selectedContext) return;
    const { bar, note } = selectedContext;
    const safeBend = clampBendSteps(
      doc.instrument.tuning,
      note.holes[0] ?? 4,
      nextAction,
      note.bendSteps,
    );
    updateNote(bar.id, note.id, { action: nextAction, bendSteps: safeBend });
  };

  const handleInspectorBendChange = (requested: number) => {
    if (!selectedContext) return;
    const { bar, note } = selectedContext;
    const safeBend = clampBendSteps(
      doc.instrument.tuning,
      note.holes[0] ?? 4,
      note.action,
      requested,
    );
    updateNote(bar.id, note.id, { bendSteps: safeBend });
  };

  const handleInspectorArticulationChange = (raw: string) => {
    if (!selectedContext) return;
    const { bar, note } = selectedContext;
    const articulation: Articulation | undefined =
      raw === 'slur' || raw === 'vibrato' || raw === 'trill' || raw === 'wah'
        ? raw
        : undefined;
    updateNote(bar.id, note.id, { articulation });
  };

  const bendOptions = useMemo(() => {
    const opts: BendSteps[] = [];
    for (let b = 0; b <= inspectorMaxBend; b++) {
      opts.push(b as BendSteps);
    }
    return opts;
  }, [inspectorMaxBend]);

  return (
    <section className="editor-card" aria-label="Karaoke Note-Pill Tab Editor">
      {/* 1. Step-Tap Active Banner */}
      {stepTap.active && (
        <div className="step-tap-banner" role="status" aria-live="polite">
          <span>
            Note {Math.min(stepTap.cursorIndex + 1, stepTap.totalNotes)} / {stepTap.totalNotes} —
            Press SPACE in rhythm at {stepTap.stepTapSpeed}x speed, ENTER to apply, ESC to cancel
          </span>
          <div className="transport-group">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={stepTap.finishStepTap}
            >
              ✓ Apply
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={stepTap.cancelStepTap}
            >
              ✕ Cancel
            </button>
          </div>
        </div>
      )}

      {/* 3b. DAW Live-Record Banner */}
      {recording && (
        <div
          className="recording-banner no-print"
          role="status"
          aria-live="polite"
          data-testid="recording-banner"
        >
          <span>
            ● Recording live — tap holes on the harmonica comb or keyboard to create timed notes &amp;
            bars
          </span>
          <button
            type="button"
            className="btn btn-record recording btn-sm"
            data-testid="stop-recording-banner-btn"
            onClick={stopRecording}
          >
            ■ Stop Rec
          </button>
        </div>
      )}

      {/* 4. Bars & Karaoke Note-Pill Timeline */}
      <div className="bars-scroll">
        {doc.bars.map((bar, barIndex) => {
          const barStart = barStarts[barIndex] ?? 0;
          const barEnd = barStart + bar.durationTicks;
          const isLastBar = barIndex === doc.bars.length - 1;
          const showPlayhead =
            activeDisplayTick >= barStart &&
            (activeDisplayTick < barEnd || (isLastBar && activeDisplayTick >= barEnd));
          const playheadPct = showPlayhead
            ? Math.max(
                0,
                Math.min(100, ((activeDisplayTick - barStart) / Math.max(1, bar.durationTicks)) * 100),
              )
            : 0;

          const gridStep = snapTicks > 0 && snapTicks < PPQ ? snapTicks : PPQ / 2;
          const gridTicks: number[] = [];
          for (let t = gridStep; t < bar.durationTicks; t += gridStep) {
            gridTicks.push(t);
          }

          const isNoteDragTarget = draggingNote !== null && draggingNote.targetBarId === bar.id;
          const isBarReorderTarget =
            dragOverBarIndex === barIndex &&
            draggingBarIndex !== null &&
            draggingBarIndex !== barIndex;
          const isBarDragging = draggingBarIndex === barIndex;

          const barRowClasses = [
            'bar-row',
            isNoteDragTarget || isBarReorderTarget ? 'drag-over' : '',
            isBarDragging ? 'bar-dragging' : '',
          ]
            .filter(Boolean)
            .join(' ');

          const showCrossBarNotePreview =
            draggingNote !== null &&
            draggingNote.targetBarId === bar.id &&
            draggingNote.fromBarId !== bar.id;

          return (
            <div key={bar.id} className="bar-block">
              <div
                className={barRowClasses}
                data-testid={`bar-row-${barIndex}`}
                onDragOver={(e) => {
                  if (draggingBarIndexRef.current === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dragOverBarIndex !== barIndex) {
                    setDragOverBarIndex(barIndex);
                  }
                }}
                onDragEnter={(e) => {
                  if (draggingBarIndexRef.current === null) return;
                  e.preventDefault();
                  if (dragOverBarIndex !== barIndex) {
                    setDragOverBarIndex(barIndex);
                  }
                }}
                onDragLeave={(e) => {
                  if (draggingBarIndexRef.current === null) return;
                  const related = e.relatedTarget as Node | null;
                  if (!related || !e.currentTarget.contains(related)) {
                    setDragOverBarIndex((prev) => (prev === barIndex ? null : prev));
                  }
                }}
                onDrop={(e) => {
                  if (draggingBarIndexRef.current === null) return;
                  e.preventDefault();
                  const fromIdx = draggingBarIndexRef.current;
                  draggingBarIndexRef.current = null;
                  setDraggingBarIndex(null);
                  setDragOverBarIndex(null);
                  if (fromIdx !== barIndex) {
                    reorderBars(fromIdx, barIndex);
                  }
                }}
              >
                <div
                  className="bar-header"
                  draggable
                  onDragStart={(e) => {
                    if ((e.target as HTMLElement | null)?.closest('button')) {
                      e.preventDefault();
                      return;
                    }
                    draggingBarIndexRef.current = barIndex;
                    setDraggingBarIndex(barIndex);
                    setDragOverBarIndex(barIndex);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(barIndex));
                    const rowEl = e.currentTarget.closest('.bar-row');
                    if (rowEl) {
                      e.dataTransfer.setDragImage(rowEl, 24, 18);
                    }
                  }}
                  onDragEnd={() => {
                    draggingBarIndexRef.current = null;
                    setDraggingBarIndex(null);
                    setDragOverBarIndex(null);
                  }}
                >
                  <div className="transport-group" style={{ gap: '6px' }}>
                    <span
                      className="bar-drag-handle no-print"
                      title="Drag to reorder bar"
                      data-testid={`bar-drag-${barIndex}`}
                    >
                      ⠿
                    </span>
                    <span>
                      Bar {barIndex + 1} ·{' '}
                      {(bar.durationTicks / PPQ).toFixed(bar.durationTicks % PPQ === 0 ? 0 : 1)}{' '}
                      beats
                    </span>
                  </div>

                  <div className="transport-group no-print">
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-testid={`shrink-bar-${barIndex}`}
                      title="Shrink bar by 1 beat"
                      onClick={() => setBarDuration(bar.id, bar.durationTicks - PPQ)}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-testid={`stretch-bar-${barIndex}`}
                      title="Stretch bar by 1 beat"
                      onClick={() => setBarDuration(bar.id, bar.durationTicks + PPQ)}
                    >
                      ＋
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-testid={`fit-bar-${barIndex}`}
                      title="Fit bar length to notes"
                      onClick={() => fitBarToNotes(bar.id)}
                    >
                      ↔ Fit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleAddNoteInBar(bar)}
                    >
                      ＋ Note
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleAddLyricInBar(bar)}
                    >
                      ＋ Lyric
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-testid={`duplicate-bar-${barIndex}`}
                      title="Duplicate bar"
                      onClick={() => duplicateBar(bar.id)}
                    >
                      ⧉
                    </button>
                    {doc.bars.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => deleteBar(bar.id)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                <div
                  className="bar-track"
                  data-bar-track-id={bar.id}
                  onClick={(e) => handleTrackClick(e, bar, barStart)}
                >
                  {/* Vertical beat grid lines */}
                  {gridTicks.map((tick) => {
                    const isMajor = tick % PPQ === 0;
                    return (
                      <div
                        key={tick}
                        className={`beat-grid-line${isMajor ? ' major' : ''}`}
                        style={{ left: `${(tick / bar.durationTicks) * 100}%` }}
                      />
                    );
                  })}

                  {/* Smooth moving playhead */}
                  {showPlayhead && (
                    <div
                      className="playhead-line"
                      data-testid="playhead-line"
                      style={{ left: `${playheadPct}%` }}
                    />
                  )}

                  {/* Notes Lane */}
                  <div className="notes-lane">
                    {bar.notes.length === 0 && !showCrossBarNotePreview && (
                      <span
                        style={{
                          position: 'absolute',
                          left: 8,
                          top: 11,
                          fontSize: 12,
                          color: 'var(--text-muted)',
                          pointerEvents: 'none',
                        }}
                      >
                        Empty bar — click ＋ Note or Smart Paste
                      </span>
                    )}

                    {bar.notes.map((note) => {
                      const noteAbsStart = barStart + note.offsetTick;
                      const noteAbsEnd = noteAbsStart + note.durationTicks;
                      const isSelected =
                        selectedNote?.barId === bar.id && selectedNote.noteId === note.id;
                      const isActiveNow =
                        playing &&
                        activeDisplayTick >= noteAbsStart &&
                        activeDisplayTick < noteAbsEnd;
                      const isStepTarget =
                        stepTap.active &&
                        stepTap.currentTarget?.barIndex === barIndex &&
                        stepTap.currentTarget.noteId === note.id;

                      const isBeingDragged =
                        draggingNote !== null &&
                        draggingNote.fromBarId === bar.id &&
                        draggingNote.noteId === note.id;
                      const isDraggedInSameBar =
                        isBeingDragged && draggingNote.targetBarId === bar.id;
                      const isDraggedOutOfBar =
                        isBeingDragged && draggingNote.targetBarId !== bar.id;

                      const effectiveOffset = isDraggedInSameBar
                        ? draggingNote.previewOffsetTick
                        : note.offsetTick;
                      const leftPct = (effectiveOffset / bar.durationTicks) * 100;
                      const widthPct = (note.durationTicks / bar.durationTicks) * 100;

                      const pillClasses = [
                        'note-pill',
                        isSelected ? 'selected' : '',
                        isActiveNow ? 'active-now' : '',
                        isStepTarget ? 'step-target' : '',
                        isBeingDragged ? 'dragging' : '',
                      ]
                        .filter(Boolean)
                        .join(' ');

                      return (
                        <div
                          key={note.id}
                          role="button"
                          tabIndex={0}
                          className={pillClasses}
                          data-testid="note-pill"
                          data-note-id={note.id}
                          data-action={note.action}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            minWidth: '28px',
                            touchAction: 'none',
                            ...(isDraggedOutOfBar ? { opacity: 0.28 } : {}),
                          }}
                          title={`${formatNoteToken(note)} (${note.durationTicks} ticks) — drag to move`}
                          onPointerDown={(e) => handleStartNoteDrag(e, bar, note)}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (suppressNoteClickRef.current) return;
                            selectNote({ barId: bar.id, noteId: note.id });
                            previewNote(note);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              e.stopPropagation();
                              selectNote({ barId: bar.id, noteId: note.id });
                              previewNote(note);
                            }
                          }}
                        >
                          <span className="note-pill-main">
                            <span className="note-pill-token">{formatNoteToken(note)}</span>
                            <span
                              className="note-pill-caption"
                              data-testid="note-pill-caption"
                            >
                              {formatNoteCaption(
                                note,
                                doc.instrument.tuning,
                                doc.instrument.harpKey,
                              )}
                            </span>
                          </span>
                          {note.articulation && (
                            <span
                              style={{
                                fontSize: '10px',
                                fontWeight: 600,
                                opacity: 0.78,
                                marginLeft: '4px',
                                marginRight: '4px',
                                flexShrink: 0,
                              }}
                            >
                              {ARTICULATION_SHORT[note.articulation]}
                            </span>
                          )}
                          <div
                            className="note-pill-resize"
                            title="Drag to resize note duration"
                            onClick={(e) => e.stopPropagation()}
                            onPointerDown={(e) => handleStartResize(e, bar, note)}
                          />
                        </div>
                      );
                    })}

                    {/* Live cross-bar drag preview pill */}
                    {showCrossBarNotePreview && draggingNote && (
                      <div
                        className="note-pill dragging"
                        data-testid="note-pill-drag-preview"
                        data-action={draggingNote.note.action}
                        style={{
                          left: `${(draggingNote.previewOffsetTick / bar.durationTicks) * 100}%`,
                          width: `${(draggingNote.note.durationTicks / bar.durationTicks) * 100}%`,
                          minWidth: '28px',
                          pointerEvents: 'none',
                        }}
                      >
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {formatNoteToken(draggingNote.note)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Decoupled Lyrics Lane */}
                  <div className="lyrics-lane">
                    {bar.lyrics.map((lyric) => {
                      const isEditing =
                        editingLyric?.barId === bar.id && editingLyric.lyricId === lyric.id;
                      const isDraggingThisLyric =
                        draggingLyric !== null &&
                        draggingLyric.barId === bar.id &&
                        draggingLyric.lyricId === lyric.id;
                      const effectiveOffset = isDraggingThisLyric
                        ? draggingLyric.previewOffsetTick
                        : lyric.offsetTick;
                      const leftPct = (effectiveOffset / bar.durationTicks) * 100;
                      const widthPct = (lyric.durationTicks / bar.durationTicks) * 100;
                      const displayLabel =
                        lyric.joinNext && !lyric.text.endsWith('-')
                          ? `${lyric.text}-`
                          : lyric.text;

                      return (
                        <div
                          key={lyric.id}
                          className={isDraggingThisLyric ? 'lyric-chip dragging' : 'lyric-chip'}
                          data-testid="lyric-chip"
                          data-lyric-id={lyric.id}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            minWidth: isEditing ? '132px' : '32px',
                            touchAction: isEditing ? undefined : 'none',
                            ...(isEditing
                              ? { overflow: 'visible', zIndex: 6, gap: '4px' }
                              : {}),
                          }}
                          title={isEditing ? undefined : 'Click to edit · drag horizontally between beats'}
                          onPointerDown={(e) => handleStartLyricDrag(e, bar, lyric)}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (suppressLyricClickRef.current) return;
                            if (!isEditing) {
                              setEditingLyric({
                                barId: bar.id,
                                lyricId: lyric.id,
                                text: lyric.text,
                                joinNext: Boolean(lyric.joinNext),
                                isNewEmpty: false,
                              });
                            }
                          }}
                        >
                          {isEditing ? (
                            <>
                              <input
                                type="text"
                                autoFocus
                                aria-label="Edit lyric syllable"
                                value={editingLyric.text}
                                placeholder="lyric..."
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) =>
                                  setEditingLyric((prev) =>
                                    prev ? { ...prev, text: e.target.value } : null,
                                  )
                                }
                                onKeyDown={(e) => handleLyricInputKeyDown(e, bar, lyric)}
                                onBlur={() => commitLyricEdit(bar, lyric)}
                              />
                              <button
                                type="button"
                                className={`btn btn-sm${editingLyric.joinNext ? ' btn-active' : ''}`}
                                style={{ padding: '1px 5px', fontSize: '11px', flexShrink: 0 }}
                                title="Toggle hyphenation (joinNext)"
                                onMouseDown={(e) => {
                                  // Keep input focused while toggling hyphenation
                                  e.preventDefault();
                                  e.stopPropagation();
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingLyric((prev) =>
                                    prev ? { ...prev, joinNext: !prev.joinNext } : null,
                                  );
                                }}
                              >
                                -
                              </button>
                            </>
                          ) : (
                            <span>{displayLabel}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Right-edge bar length resize handle */}
                <div
                  className="bar-resize-handle no-print"
                  data-testid={`bar-resize-${barIndex}`}
                  title="Drag horizontally to stretch or shrink bar length"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => handleStartBarResize(e, bar)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* 5. Floating Selected Note Inspector Card (mini-menu aside the selected note) */}
      {selectedContext && (
        <div
          ref={inspectorRef}
          className="note-inspector"
          data-testid="note-inspector"
          role="dialog"
          aria-label="Note Inspector"
          style={
            inspectorPos
              ? { top: `${inspectorPos.top}px`, left: `${inspectorPos.left}px` }
              : { visibility: 'hidden', top: '0px', left: '0px' }
          }
          onClick={(e) => e.stopPropagation()}
        >
          <div className="note-inspector-header">
            <div className="note-inspector-title">
              <strong className="note-inspector-token">
                {formatNoteToken(selectedContext.note)}
              </strong>
              <span className="note-inspector-meta">
                Bar {selectedContext.bar.index + 1} ·{' '}
                {selectedContext.note.holes.length > 1
                  ? `Chord (${selectedContext.note.holes.join(', ')})`
                  : `Hole ${selectedContext.note.holes[0] ?? 4}`}
              </span>
            </div>
          </div>

          <div className="note-inspector-section">
            <span className="note-inspector-label">Holes / Chord</span>
            <div className="segmented inspector-holes-grid" aria-label="Chord Holes">
              {ALL_HOLES.map((h) => {
                const active = selectedContext.note.holes.includes(h);
                return (
                  <button
                    key={h}
                    type="button"
                    className={active ? 'active' : ''}
                    aria-pressed={active}
                    onClick={() => handleInspectorToggleChordHole(h)}
                  >
                    {h}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="note-inspector-grid">
            <label className="note-inspector-field">
              <span className="note-inspector-label">Action</span>
              <select
                aria-label="Breath Action"
                value={selectedContext.note.action}
                onChange={(e) => handleInspectorActionChange(e.target.value as BreathAction)}
              >
                <option value="blow">Blow (+)</option>
                <option value="draw">Draw (-)</option>
                <option value="overblow">Overblow (ob)</option>
                <option value="overdraw">Overdraw (od)</option>
              </select>
            </label>

            <label className="note-inspector-field">
              <span className="note-inspector-label">Bend</span>
              <select
                aria-label="Bend Steps"
                disabled={inspectorMaxBend === 0}
                value={Math.min(selectedContext.note.bendSteps, inspectorMaxBend)}
                onChange={(e) => handleInspectorBendChange(Number(e.target.value))}
              >
                {bendOptions.map((b) => (
                  <option key={b} value={b}>
                    {b === 0 ? '0 (None)' : `${b} (${"'".repeat(b)})`}
                  </option>
                ))}
              </select>
            </label>

            <label className="note-inspector-field">
              <span className="note-inspector-label">Articulation</span>
              <select
                aria-label="Articulation"
                value={selectedContext.note.articulation ?? ''}
                onChange={(e) => handleInspectorArticulationChange(e.target.value)}
              >
                <option value="">None</option>
                <option value="slur">Slur</option>
                <option value="vibrato">Vibrato</option>
                <option value="trill">Trill</option>
                <option value="wah">Wah</option>
              </select>
            </label>

            <div className="note-inspector-ticks">
              <label className="note-inspector-field">
                <span className="note-inspector-label">Offset</span>
                <input
                  type="number"
                  className="inspector-tick-input"
                  aria-label="Offset Ticks"
                  min={0}
                  step={snapTicks > 0 ? snapTicks : 60}
                  value={selectedContext.note.offsetTick}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    if (Number.isFinite(parsed) && parsed >= 0) {
                      updateNote(selectedContext.bar.id, selectedContext.note.id, {
                        offsetTick: Math.round(parsed),
                      });
                    }
                  }}
                />
              </label>

              <label className="note-inspector-field">
                <span className="note-inspector-label">Duration</span>
                <input
                  type="number"
                  className="inspector-tick-input"
                  aria-label="Duration Ticks"
                  min={60}
                  step={snapTicks > 0 ? snapTicks : 60}
                  value={selectedContext.note.durationTicks}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    if (Number.isFinite(parsed) && parsed >= 60) {
                      updateNote(selectedContext.bar.id, selectedContext.note.id, {
                        durationTicks: Math.round(parsed),
                      });
                    }
                  }}
                />
              </label>
            </div>
          </div>

          <div className="note-inspector-actions">
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => deleteNote(selectedContext.bar.id, selectedContext.note.id)}
            >
              Delete
            </button>

            <button
              type="button"
              className="btn btn-sm"
              onClick={() => selectNote(null)}
              title="Close note inspector"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
