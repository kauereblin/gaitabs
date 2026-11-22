import { useEffect, useState } from 'react';
import { useAudioStore } from './state/useAudioStore.ts';
import { useSongStore } from './state/useSongStore.ts';
import { useStepTap } from './hooks/useStepTap.ts';
import { SideMenu } from './components/SideMenu.tsx';
import { NotePillEditor } from './components/NotePillEditor.tsx';
import { HarmonicaComb } from './components/HarmonicaComb.tsx';
import { SmartPasteModal } from './components/SmartPasteModal.tsx';
import { LibraryDrawer } from './components/LibraryDrawer.tsx';

export function App() {
  const doc = useSongStore((s) => s.doc);
  const snapTicks = useSongStore((s) => s.snapTicks);
  const saveStatus = useSongStore((s) => s.saveStatus);
  const saveError = useSongStore((s) => s.saveError);
  const toast = useSongStore((s) => s.toast);
  const hydrateFromStorage = useSongStore((s) => s.hydrateFromStorage);
  const applyStepTapTimings = useSongStore((s) => s.applyStepTapTimings);
  const recordLiveNote = useSongStore((s) => s.recordLiveNote);

  const recording = useAudioStore((s) => s.recording);
  const loadSongIntoEngine = useAudioStore((s) => s.loadSongIntoEngine);
  const setRecordNoteHandler = useAudioStore((s) => s.setRecordNoteHandler);

  const [smartPasteOpen, setSmartPasteOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [sideMenuMobileOpen, setSideMenuMobileOpen] = useState(false);

  const stepTap = useStepTap(doc, snapTicks, applyStepTapTimings);

  useEffect(() => {
    void hydrateFromStorage();
  }, [hydrateFromStorage]);

  useEffect(() => {
    setRecordNoteHandler(recordLiveNote);
    return () => setRecordNoteHandler(null);
  }, [recordLiveNote, setRecordNoteHandler]);

  // Keep AudioWorklet score synchronized strictly when musical score fields change
  // (ignore revision/updatedAt/title bumps from debounced autosave so playback never cuts off,
  // and skip while DAW live-recording so newly recorded notes never reset the recording clock).
  useEffect(() => {
    if (recording) return;
    loadSongIntoEngine(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.bars, doc.bpm, doc.swingPercent, doc.instrument, recording, loadSongIntoEngine]);

  const saveLabel =
    saveStatus === 'saved'
      ? `Saved locally`
      : saveStatus === 'saving'
        ? 'Saving...'
        : saveStatus === 'error'
          ? `Save error: ${saveError ?? 'unknown'}`
          : 'Local draft';

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-group">
          <div>
            <h1 className="brand-title font-['Marck_Script',_cursive]">gaitabs</h1>
          </div>
          <button
            type="button"
            className="btn btn-sm mobile-only-btn"
            data-testid="toggle-side-menu-btn"
            aria-label="Open transport and editor controls"
            onClick={() => setSideMenuMobileOpen((v) => !v)}
          >
            ⚙
          </button>
        </div>

        <div className="header-actions">
          <span
            className="save-badge"
            data-status={saveStatus}
            data-testid="save-status-badge"
          >
            {saveLabel}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="open-library-btn"
            onClick={() => setLibraryOpen(true)}
          >
            ☰
          </button>
        </div>
      </header>

      <div className="app-body">
        <SideMenu
          stepTap={stepTap}
          onOpenSmartPaste={() => setSmartPasteOpen(true)}
          mobileOpen={sideMenuMobileOpen}
          onCloseMobile={() => setSideMenuMobileOpen(false)}
        />

        <main className="main-column">
          <NotePillEditor stepTap={stepTap} />
          <HarmonicaComb stepTapActive={stepTap.active || smartPasteOpen} />
        </main>
      </div>

      <SmartPasteModal
        open={smartPasteOpen}
        onClose={() => setSmartPasteOpen(false)}
      />

      <LibraryDrawer
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
      />

      {toast && (
        <div className="toast" role="status" data-testid="app-toast">
          {toast}
        </div>
      )}
    </div>
  );
}
