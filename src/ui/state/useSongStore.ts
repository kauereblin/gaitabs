import { create } from 'zustand';
import {
  PPQ,
  createEmptySong,
  defaultBarDurationTicks,
  type Articulation,
  type Bar,
  type BendSteps,
  type BreathAction,
  type HarmonicaNote,
  type HarpKey,
  type LyricSpan,
  type SongDocument,
  type TimeSignature,
  type TimingMode,
} from '../../schema/song.ts';
import { WONDERFUL_WORLD_GOLDEN_DOC } from '../../schema/golden.ts';
import { clampBendSteps } from '../../schema/tuning.ts';
import { parseTextTab } from '../../parser/textTab.ts';
import { IndexedDbSongRepository } from '../../storage/indexedDbRepo.ts';
import { decodeSongFromHash } from '../../storage/portability.ts';
import type { SongFilter, SongRepository, SongSummary } from '../../storage/repository.ts';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface SelectedNoteRef {
  barId: string;
  noteId: string;
}

const MAX_UNDO = 40;
const LAST_OPENED_SONG_KEY = 'gaitabs:lastOpenedSongId';

export const songRepository: SongRepository = new IndexedDbSongRepository();

interface SongStoreState {
  doc: SongDocument;
  undoStack: SongDocument[];
  redoStack: SongDocument[];
  selectedNote: SelectedNoteRef | null;
  snapTicks: number; // 0 = off, 120 = 16th, 240 = 8th, 480 = quarter
  saveStatus: SaveStatus;
  saveError: string | null;
  library: SongSummary[];
  libraryFilter: SongFilter;
  hydrated: boolean;
  toast: string | null;

  hydrateFromStorage: () => Promise<void>;
  refreshLibrary: (filter?: SongFilter) => Promise<void>;
  setLibraryFilter: (filter: SongFilter) => Promise<void>;
  persistNow: (docOverride?: SongDocument) => Promise<void>;

  loadSongById: (id: string) => Promise<void>;
  loadSongDocument: (doc: SongDocument, persist?: boolean) => void;
  loadGoldenFixture: () => void;
  createNewSong: () => void;
  duplicateCurrentSong: () => Promise<void>;
  deleteSongById: (id: string) => Promise<void>;

  importFromPlainText: (raw: string, meta?: { title?: string; artist?: string; harpKey?: HarpKey; bpm?: number }) => void;

  setMetadata: (patch: Partial<Pick<SongDocument, 'title' | 'artist' | 'bpm' | 'swingPercent' | 'timingMode'>>) => void;
  transposeHarpKey: (harpKey: HarpKey) => void;
  setSnapTicks: (ticks: number) => void;
  selectNote: (ref: SelectedNoteRef | null) => void;

  addBar: () => void;
  duplicateBar: (barId: string) => void;
  reorderBars: (fromIndex: number, toIndex: number) => void;
  setBarDuration: (barId: string, newDurationTicks: number) => void;
  fitBarToNotes: (barId: string) => void;
  deleteBar: (barId: string) => void;

  insertNote: (barId: string, note: Omit<HarmonicaNote, 'id'>) => void;
  updateNote: (
    barId: string,
    noteId: string,
    patch: Partial<Pick<HarmonicaNote, 'holes' | 'action' | 'bendSteps' | 'bendCents' | 'articulation' | 'offsetTick' | 'durationTicks'>>,
  ) => void;
  resizeNoteDuration: (barId: string, noteId: string, newDurationTicks: number) => void;
  moveNote: (fromBarId: string, noteId: string, toBarId: string, newOffsetTick: number) => void;
  deleteNote: (barId: string, noteId: string) => void;

  recordLiveNote: (payload: {
    absStartTick: number;
    durationTicks: number;
    holes: number[];
    action: BreathAction;
    bendSteps: BendSteps;
  }) => void;

  upsertLyric: (barId: string, lyric: Omit<LyricSpan, 'id'> & { id?: string }) => void;
  moveLyric: (barId: string, lyricId: string, newOffsetTick: number) => void;
  deleteLyric: (barId: string, lyricId: string) => void;

  applyStepTapTimings: (timings: Array<{ barIndex: number; noteId: string; offsetTick: number; durationTicks: number }>) => void;

  undo: () => void;
  redo: () => void;
  showToast: (msg: string) => void;
  clearToast: () => void;
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let hydrationPromise: Promise<void> | null = null;

function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function rememberLastSongId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) {
      window.localStorage.setItem(LAST_OPENED_SONG_KEY, id);
    } else {
      window.localStorage.removeItem(LAST_OPENED_SONG_KEY);
    }
  } catch {
    // Ignore storage quota or private-mode restrictions
  }
}

function readLastSongId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LAST_OPENED_SONG_KEY);
  } catch {
    return null;
  }
}

function scheduleAutosave(persistFn: () => Promise<void>): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void persistFn();
  }, 400);
}

function maxContentEndTick(bar: Bar): number {
  let maxEnd = 0;
  for (const n of bar.notes) {
    maxEnd = Math.max(maxEnd, n.offsetTick + n.durationTicks);
  }
  for (const l of bar.lyrics) {
    maxEnd = Math.max(maxEnd, l.offsetTick + l.durationTicks);
  }
  return maxEnd;
}

/**
 * Ensures the bar covers all notes/lyrics, AND if a bar was previously stretched
 * beyond its default bar length (or if `prevContentEnd` shrank), collapses excess
 * trailing dead space cleanly so the playhead doesn't slide across empty silence.
 */
function reconcileBarDuration(bar: Bar, ts: TimeSignature, prevMaxEnd?: number): Bar {
  const contentEnd = maxContentEndTick(bar);
  const stdTicks = defaultBarDurationTicks(ts);

  // Grow if content overflows current bar length
  if (contentEnd > bar.durationTicks) {
    return { ...bar, durationTicks: contentEnd };
  }

  // If the bar was stretched beyond standard length (e.g. a long note was inserted)
  // and content shrank below the old bar length, pull the bar end back with it.
  if (
    prevMaxEnd !== undefined &&
    contentEnd < prevMaxEnd &&
    bar.durationTicks > stdTicks &&
    bar.durationTicks <= prevMaxEnd + PPQ
  ) {
    const nextDuration = Math.max(stdTicks, contentEnd);
    return nextDuration === bar.durationTicks ? bar : { ...bar, durationTicks: nextDuration };
  }

  return bar;
}

export const useSongStore = create<SongStoreState>((set, get) => {
  const commitDoc = (nextDoc: SongDocument, recordUndo = true) => {
    const prev = get().doc;
    set((s) => ({
      doc: nextDoc,
      undoStack: recordUndo ? [...s.undoStack.slice(-(MAX_UNDO - 1)), prev] : s.undoStack,
      redoStack: recordUndo ? [] : s.redoStack,
      saveStatus: 'saving',
      saveError: null,
    }));
    scheduleAutosave(() => get().persistNow());
  };

  return {
    doc: createEmptySong(),
    undoStack: [],
    redoStack: [],
    selectedNote: null,
    snapTicks: 240, // 1/8 note default snap
    saveStatus: 'idle',
    saveError: null,
    library: [],
    libraryFilter: {},
    hydrated: false,
    toast: null,

    hydrateFromStorage: () => {
      // Strictly idempotent across React StrictMode double-mount so reload never creates duplicates
      if (hydrationPromise) return hydrationPromise;

      hydrationPromise = (async () => {
        try {
          // 1. Check URL #tab= share hash first; clear hash immediately after import so reload never duplicates
          if (typeof window !== 'undefined' && window.location.hash.startsWith('#tab=')) {
            const rawHash = window.location.hash;
            try {
              const shared = decodeSongFromHash(rawHash);
              if (shared) {
                try {
                  window.history.replaceState(
                    null,
                    '',
                    window.location.pathname + window.location.search,
                  );
                } catch {
                  // Ignore history restrictions
                }
                const saved = await songRepository.save({
                  ...shared,
                  id: crypto.randomUUID(),
                  revision: 1,
                });
                rememberLastSongId(saved.id);
                const library = await songRepository.list(get().libraryFilter);
                set({
                  doc: saved,
                  library,
                  hydrated: true,
                  saveStatus: 'saved',
                });
                get().showToast(`Loaded shared tab: ${saved.title}`);
                return;
              }
            } catch {
              get().showToast('Could not decode shared URL tab.');
            }
          }

          // 2. Load the previously opened song (or fallback to most recent in library); NEVER create a new song
          const library = await songRepository.list(get().libraryFilter);
          const lastOpenedId = readLastSongId();
          if (lastOpenedId) {
            const lastOpened = await songRepository.get(lastOpenedId);
            if (lastOpened) {
              set({ doc: lastOpened, library, hydrated: true, saveStatus: 'saved' });
              return;
            }
          }

          if (library.length > 0) {
            const latest = await songRepository.get(library[0]!.id);
            if (latest) {
              rememberLastSongId(latest.id);
              set({ doc: latest, library, hydrated: true, saveStatus: 'saved' });
              return;
            }
          }

          // 3. Truly empty IndexedDB: start with one clean unsaved draft (never duplicates on reload)
          set({ library, hydrated: true, saveStatus: 'idle' });
        } catch (err) {
          set({
            hydrated: true,
            saveStatus: 'error',
            saveError: err instanceof Error ? err.message : 'Storage init error',
          });
        }
      })();

      return hydrationPromise;
    },

    refreshLibrary: async (filter) => {
      const effectiveFilter = filter ?? get().libraryFilter;
      const library = await songRepository.list(effectiveFilter);
      set({ library, libraryFilter: effectiveFilter });
    },

    setLibraryFilter: async (filter) => {
      set({ libraryFilter: filter });
      const library = await songRepository.list(filter);
      set({ library });
    },

    persistNow: async (docOverride) => {
      const target = docOverride ?? get().doc;
      set({ saveStatus: 'saving', saveError: null });
      try {
        const saved = await songRepository.save(target);
        rememberLastSongId(saved.id);
        const library = await songRepository.list(get().libraryFilter);
        set((s) => ({
          doc:
            s.doc.id === saved.id
              ? { ...s.doc, revision: saved.revision, updatedAt: saved.updatedAt }
              : s.doc,
          library,
          saveStatus: 'saved',
          saveError: null,
        }));
      } catch (err) {
        set({
          saveStatus: 'error',
          saveError: err instanceof Error ? err.message : 'Failed to save locally',
        });
      }
    },

    loadSongById: async (id) => {
      const found = await songRepository.get(id);
      if (!found) {
        get().showToast('Song not found in local library.');
        return;
      }
      rememberLastSongId(found.id);
      set({
        doc: found,
        undoStack: [],
        redoStack: [],
        selectedNote: null,
        saveStatus: 'saved',
      });
    },

    loadSongDocument: (doc, persist = true) => {
      rememberLastSongId(doc.id);
      set({
        doc,
        undoStack: [],
        redoStack: [],
        selectedNote: null,
        saveStatus: persist ? 'saving' : 'idle',
      });
      if (persist) {
        void get().persistNow(doc);
      }
    },

    loadGoldenFixture: () => {
      const cloned: SongDocument = {
        ...structuredClone(WONDERFUL_WORLD_GOLDEN_DOC),
        id: crypto.randomUUID(),
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      get().loadSongDocument(cloned, true);
      get().showToast('Loaded Golden Fixture: What a Wonderful World');
    },

    createNewSong: () => {
      const fresh = createEmptySong({ title: 'New Harmonica Tab' });
      get().loadSongDocument(fresh, true);
    },

    duplicateCurrentSong: async () => {
      const cur = get().doc;
      const now = new Date().toISOString();
      const copy: SongDocument = {
        ...structuredClone(cur),
        id: crypto.randomUUID(),
        revision: 1,
        title: `${cur.title} (Copy)`,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      get().loadSongDocument(copy, true);
      get().showToast('Duplicated song locally');
    },

    deleteSongById: async (id) => {
      await songRepository.remove(id);
      const library = await songRepository.list(get().libraryFilter);
      const currentId = get().doc.id;
      if (currentId === id) {
        if (library.length > 0) {
          const next = await songRepository.get(library[0]!.id);
          rememberLastSongId(next?.id ?? null);
          set({
            doc: next ?? createEmptySong(),
            library,
            selectedNote: null,
            undoStack: [],
            redoStack: [],
          });
        } else {
          rememberLastSongId(null);
          set({
            doc: createEmptySong(),
            library,
            selectedNote: null,
            undoStack: [],
            redoStack: [],
            saveStatus: 'idle',
          });
        }
      } else {
        set({ library });
      }
      get().showToast('Removed song from library');
    },

    importFromPlainText: (raw, meta) => {
      const parsed = parseTextTab(raw, {
        title: meta?.title,
        artist: meta?.artist,
        harpKey: meta?.harpKey ?? get().doc.instrument.harpKey,
        bpm: meta?.bpm ?? get().doc.bpm,
      });
      get().loadSongDocument(parsed, true);
      get().showToast(`Imported ${parsed.bars.length} bar(s) via Smart Paste`);
    },

    setMetadata: (patch) => {
      const cur = get().doc;
      commitDoc({
        ...cur,
        ...patch,
      });
    },

    transposeHarpKey: (harpKey) => {
      const cur = get().doc;
      commitDoc({
        ...cur,
        instrument: {
          ...cur.instrument,
          harpKey,
        },
      });
    },

    setSnapTicks: (snapTicks) => set({ snapTicks }),

    selectNote: (selectedNote) => set({ selectedNote }),

    addBar: () => {
      const cur = get().doc;
      const nextIdx = cur.bars.length;
      const newBar: Bar = {
        id: makeId('bar'),
        index: nextIdx,
        durationTicks: defaultBarDurationTicks(cur.timeSignature),
        notes: [],
        lyrics: [],
      };
      commitDoc({
        ...cur,
        bars: [...cur.bars, newBar],
      });
    },

    duplicateBar: (barId) => {
      const cur = get().doc;
      const srcIdx = cur.bars.findIndex((b) => b.id === barId);
      if (srcIdx < 0) return;
      const src = cur.bars[srcIdx]!;
      const clonedBar: Bar = {
        id: makeId('bar'),
        index: srcIdx + 1,
        durationTicks: src.durationTicks,
        notes: src.notes.map((n) => ({ ...structuredClone(n), id: makeId('n') })),
        lyrics: src.lyrics.map((l) => ({ ...structuredClone(l), id: makeId('l') })),
      };
      const nextBars = [
        ...cur.bars.slice(0, srcIdx + 1),
        clonedBar,
        ...cur.bars.slice(srcIdx + 1),
      ].map((b, idx) => ({ ...b, index: idx }));
      commitDoc({ ...cur, bars: nextBars });
      get().showToast(`Duplicated Bar ${srcIdx + 1}`);
    },

    reorderBars: (fromIndex, toIndex) => {
      const cur = get().doc;
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= cur.bars.length ||
        toIndex >= cur.bars.length
      ) {
        return;
      }
      const nextBars = [...cur.bars];
      const [moved] = nextBars.splice(fromIndex, 1);
      if (!moved) return;
      nextBars.splice(toIndex, 0, moved);
      const reindexed = nextBars.map((b, idx) => ({ ...b, index: idx }));
      commitDoc({ ...cur, bars: reindexed });
    },

    setBarDuration: (barId, newDurationTicks) => {
      const cur = get().doc;
      const snap = get().snapTicks;
      const bars = cur.bars.map((b) => {
        if (b.id !== barId) return b;
        const minByContent = maxContentEndTick(b);
        const minAllowed = Math.max(PPQ / 2, minByContent);
        const snapped =
          snap > 0
            ? Math.round(newDurationTicks / snap) * snap
            : Math.round(newDurationTicks);
        const clamped = Math.max(minAllowed, Math.min(PPQ * 32, snapped));
        return clamped === b.durationTicks ? b : { ...b, durationTicks: clamped };
      });
      commitDoc({ ...cur, bars });
    },

    fitBarToNotes: (barId) => {
      const cur = get().doc;
      const snap = get().snapTicks;
      const bars = cur.bars.map((b) => {
        if (b.id !== barId) return b;
        const contentEnd = maxContentEndTick(b);
        if (contentEnd <= 0) {
          return { ...b, durationTicks: PPQ };
        }
        const unit = snap > 0 ? snap : PPQ / 2;
        const fitted = Math.max(PPQ / 2, Math.ceil(contentEnd / unit) * unit);
        return { ...b, durationTicks: fitted };
      });
      commitDoc({ ...cur, bars });
    },

    deleteBar: (barId) => {
      const cur = get().doc;
      if (cur.bars.length <= 1) return;
      const bars = cur.bars
        .filter((b) => b.id !== barId)
        .map((b, idx) => ({ ...b, index: idx }));
      const sel = get().selectedNote;
      if (sel?.barId === barId) {
        set({ selectedNote: null });
      }
      commitDoc({ ...cur, bars });
    },

    insertNote: (barId, noteInput) => {
      const cur = get().doc;
      const firstHole = noteInput.holes[0] ?? 4;
      const clampedBend = clampBendSteps(
        cur.instrument.tuning,
        firstHole,
        noteInput.action,
        noteInput.bendSteps,
      );
      const newNote: HarmonicaNote = {
        ...noteInput,
        id: makeId('n'),
        offsetTick: Math.max(0, Math.round(noteInput.offsetTick)),
        durationTicks: Math.max(60, Math.round(noteInput.durationTicks)),
        bendSteps: clampedBend,
      };
      const bars = cur.bars.map((b) => {
        if (b.id !== barId) return b;
        const prevMax = maxContentEndTick(b);
        const notes = [...b.notes, newNote].sort((a, z) => a.offsetTick - z.offsetTick);
        return reconcileBarDuration({ ...b, notes }, cur.timeSignature, prevMax);
      });
      commitDoc({ ...cur, bars });
      set({ selectedNote: { barId, noteId: newNote.id } });
    },

    updateNote: (barId, noteId, patch) => {
      const cur = get().doc;
      const bars = cur.bars.map((b) => {
        if (b.id !== barId) return b;
        const prevMax = maxContentEndTick(b);
        const notes = b.notes
          .map((n) => {
            if (n.id !== noteId) return n;
            const nextHoles = patch.holes ?? n.holes;
            const nextAction: BreathAction = patch.action ?? n.action;
            const rawBend: BendSteps = patch.bendSteps ?? n.bendSteps;
            const safeBend = clampBendSteps(
              cur.instrument.tuning,
              nextHoles[0] ?? 4,
              nextAction,
              rawBend,
            );
            const nextArticulation: Articulation | undefined =
              'articulation' in patch ? patch.articulation : n.articulation;
            return {
              ...n,
              ...patch,
              holes: nextHoles,
              action: nextAction,
              bendSteps: safeBend,
              articulation: nextArticulation,
              offsetTick:
                patch.offsetTick !== undefined
                  ? Math.max(0, Math.round(patch.offsetTick))
                  : n.offsetTick,
              durationTicks:
                patch.durationTicks !== undefined
                  ? Math.max(60, Math.round(patch.durationTicks))
                  : n.durationTicks,
            };
          })
          .sort((a, z) => a.offsetTick - z.offsetTick);
        return reconcileBarDuration({ ...b, notes }, cur.timeSignature, prevMax);
      });
      commitDoc({ ...cur, bars });
    },

    resizeNoteDuration: (barId, noteId, newDurationTicks) => {
      const snap = get().snapTicks;
      const snapped =
        snap > 0
          ? Math.max(snap, Math.round(newDurationTicks / snap) * snap)
          : Math.max(60, Math.round(newDurationTicks));
      get().updateNote(barId, noteId, { durationTicks: snapped });
    },

    moveNote: (fromBarId, noteId, toBarId, newOffsetTick) => {
      const cur = get().doc;
      const srcBar = cur.bars.find((b) => b.id === fromBarId);
      const note = srcBar?.notes.find((n) => n.id === noteId);
      if (!srcBar || !note) return;

      const snap = get().snapTicks;
      const snappedOffset =
        snap > 0
          ? Math.max(0, Math.round(newOffsetTick / snap) * snap)
          : Math.max(0, Math.round(newOffsetTick));

      const movedNote: HarmonicaNote = {
        ...note,
        offsetTick: snappedOffset,
      };

      const bars = cur.bars.map((b) => {
        if (fromBarId === toBarId && b.id === fromBarId) {
          const prevMax = maxContentEndTick(b);
          const notes = b.notes
            .map((n) => (n.id === noteId ? movedNote : n))
            .sort((a, z) => a.offsetTick - z.offsetTick);
          return reconcileBarDuration({ ...b, notes }, cur.timeSignature, prevMax);
        }
        if (b.id === fromBarId) {
          const prevMax = maxContentEndTick(b);
          const notes = b.notes.filter((n) => n.id !== noteId);
          return reconcileBarDuration({ ...b, notes }, cur.timeSignature, prevMax);
        }
        if (b.id === toBarId) {
          const prevMax = maxContentEndTick(b);
          const notes = [...b.notes, movedNote].sort((a, z) => a.offsetTick - z.offsetTick);
          return reconcileBarDuration({ ...b, notes }, cur.timeSignature, prevMax);
        }
        return b;
      });

      commitDoc({ ...cur, bars });
      const sel = get().selectedNote;
      if (sel?.noteId === noteId) {
        set({ selectedNote: { barId: toBarId, noteId } });
      }
    },

    deleteNote: (barId, noteId) => {
      const cur = get().doc;
      const bars = cur.bars.map((b) => {
        if (b.id !== barId) return b;
        const prevMax = maxContentEndTick(b);
        const notes = b.notes.filter((n) => n.id !== noteId);
        return reconcileBarDuration({ ...b, notes }, cur.timeSignature, prevMax);
      });
      commitDoc({ ...cur, bars });
      const sel = get().selectedNote;
      if (sel?.noteId === noteId) set({ selectedNote: null });
    },

    recordLiveNote: ({ absStartTick, durationTicks, holes, action, bendSteps }) => {
      const cur = get().doc;
      const snap = get().snapTicks;
      const stdBarTicks = defaultBarDurationTicks(cur.timeSignature);

      const quantizedStart =
        snap > 0
          ? Math.max(0, Math.round(absStartTick / snap) * snap)
          : Math.max(0, Math.round(absStartTick));
      const quantizedDur =
        snap > 0
          ? Math.max(snap, Math.round(durationTicks / snap) * snap)
          : Math.max(120, Math.round(durationTicks));

      const nextBars = cur.bars.map((b) => ({
        ...b,
        notes: [...b.notes],
        lyrics: [...b.lyrics],
      }));

      // Locate which bar owns quantizedStart, auto-creating bars if playback advanced past existing bars
      let cursor = 0;
      let targetIdx = -1;
      for (let i = 0; i < nextBars.length; i++) {
        const bar = nextBars[i]!;
        if (quantizedStart >= cursor && quantizedStart < cursor + bar.durationTicks) {
          targetIdx = i;
          break;
        }
        cursor += bar.durationTicks;
      }

      while (targetIdx === -1) {
        const newIdx = nextBars.length;
        const newBar: Bar = {
          id: makeId('bar'),
          index: newIdx,
          durationTicks: stdBarTicks,
          notes: [],
          lyrics: [],
        };
        nextBars.push(newBar);
        if (quantizedStart >= cursor && quantizedStart < cursor + newBar.durationTicks) {
          targetIdx = newIdx;
          break;
        }
        cursor += newBar.durationTicks;
      }

      const targetBar = nextBars[targetIdx]!;
      const offsetTick = Math.max(0, quantizedStart - cursor);
      const firstHole = holes[0] ?? 4;
      const safeBend = clampBendSteps(cur.instrument.tuning, firstHole, action, bendSteps);

      const recordedNote: HarmonicaNote = {
        id: makeId('n'),
        offsetTick,
        durationTicks: quantizedDur,
        holes,
        action,
        bendSteps: safeBend,
      };

      targetBar.notes.push(recordedNote);
      targetBar.notes.sort((a, z) => a.offsetTick - z.offsetTick);
      nextBars[targetIdx] = reconcileBarDuration(targetBar, cur.timeSignature);

      commitDoc({
        ...cur,
        timingMode: 'measured',
        bars: nextBars,
      });
    },

    upsertLyric: (barId, lyric) => {
      const cur = get().doc;
      const bars = cur.bars.map((b) => {
        if (b.id !== barId) return b;
        const prevMax = maxContentEndTick(b);
        const id = lyric.id ?? makeId('l');
        const exists = b.lyrics.some((l) => l.id === id);
        const item: LyricSpan = {
          id,
          offsetTick: Math.max(0, Math.round(lyric.offsetTick)),
          durationTicks: Math.max(60, Math.round(lyric.durationTicks)),
          text: lyric.text,
          ...(lyric.joinNext ? { joinNext: true } : {}),
        };
        const lyrics = exists
          ? b.lyrics.map((l) => (l.id === id ? item : l))
          : [...b.lyrics, item];
        lyrics.sort((a, z) => a.offsetTick - z.offsetTick);
        return reconcileBarDuration({ ...b, lyrics }, cur.timeSignature, prevMax);
      });
      commitDoc({ ...cur, bars });
    },

    moveLyric: (barId, lyricId, newOffsetTick) => {
      const cur = get().doc;
      const snap = get().snapTicks;
      let changed = false;

      const bars = cur.bars.map((b) => {
        if (b.id !== barId) return b;
        const target = b.lyrics.find((l) => l.id === lyricId);
        if (!target) return b;

        const maxOffset = Math.max(0, b.durationTicks - target.durationTicks);
        const snapped =
          snap > 0
            ? Math.round(newOffsetTick / snap) * snap
            : Math.round(newOffsetTick);
        const clamped = Math.max(0, Math.min(maxOffset, snapped));
        if (clamped === target.offsetTick) return b;

        changed = true;
        const lyrics = b.lyrics
          .map((l) => (l.id === lyricId ? { ...l, offsetTick: clamped } : l))
          .sort((a, z) => a.offsetTick - z.offsetTick);
        return { ...b, lyrics };
      });

      if (changed) {
        commitDoc({ ...cur, bars });
      }
    },

    deleteLyric: (barId, lyricId) => {
      const cur = get().doc;
      const bars = cur.bars.map((b) => {
        if (b.id !== barId) return b;
        const prevMax = maxContentEndTick(b);
        const lyrics = b.lyrics.filter((l) => l.id !== lyricId);
        return reconcileBarDuration({ ...b, lyrics }, cur.timeSignature, prevMax);
      });
      commitDoc({ ...cur, bars });
    },

    applyStepTapTimings: (timings) => {
      const cur = get().doc;
      const timingByKey = new Map<string, { offsetTick: number; durationTicks: number }>();
      for (const t of timings) {
        timingByKey.set(`${t.barIndex}:${t.noteId}`, {
          offsetTick: Math.max(0, Math.round(t.offsetTick)),
          durationTicks: Math.max(120, Math.round(t.durationTicks)),
        });
      }

      const bars = cur.bars.map((bar, bi) => {
        const newOffsetByOldOffset = new Map<number, { offsetTick: number; durationTicks: number }>();

        const nextNotes = bar.notes.map((n) => {
          const stamped = timingByKey.get(`${bi}:${n.id}`);
          if (!stamped) return n;
          newOffsetByOldOffset.set(n.offsetTick, stamped);
          return {
            ...n,
            offsetTick: stamped.offsetTick,
            durationTicks: stamped.durationTicks,
          };
        });

        const nextLyrics = bar.lyrics.map((l) => {
          const moved = newOffsetByOldOffset.get(l.offsetTick);
          if (!moved) return l;
          return {
            ...l,
            offsetTick: moved.offsetTick,
            durationTicks: moved.durationTicks,
          };
        });

        let maxEnd = defaultBarDurationTicks(cur.timeSignature);
        for (const n of nextNotes) {
          maxEnd = Math.max(maxEnd, n.offsetTick + n.durationTicks);
        }
        const roundedDuration = Math.max(PPQ, Math.ceil(maxEnd / PPQ) * PPQ);

        return {
          ...bar,
          durationTicks: roundedDuration,
          notes: nextNotes,
          lyrics: nextLyrics,
        };
      });

      const nextMode: TimingMode = 'measured';
      commitDoc({
        ...cur,
        timingMode: nextMode,
        bars,
      });
      get().showToast('Stamped rhythm via Step-Tap (Measured mode)');
    },

    undo: () => {
      const { undoStack, doc, redoStack } = get();
      if (undoStack.length === 0) return;
      const previous = undoStack[undoStack.length - 1]!;
      set({
        doc: previous,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, doc],
        saveStatus: 'saving',
      });
      scheduleAutosave(() => get().persistNow());
    },

    redo: () => {
      const { redoStack, doc, undoStack } = get();
      if (redoStack.length === 0) return;
      const next = redoStack[redoStack.length - 1]!;
      set({
        doc: next,
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack, doc],
        saveStatus: 'saving',
      });
      scheduleAutosave(() => get().persistNow());
    },

    showToast: (msg) => {
      if (toastTimer) clearTimeout(toastTimer);
      set({ toast: msg });
      toastTimer = setTimeout(() => {
        toastTimer = null;
        set({ toast: null });
      }, 3200);
    },

    clearToast: () => set({ toast: null }),
  };
});
