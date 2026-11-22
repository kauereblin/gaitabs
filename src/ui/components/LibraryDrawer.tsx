import { useEffect, useRef, type ChangeEvent } from 'react';
import {
  HARP_KEYS,
  type HarpKey,
  type TimingMode,
} from '../../schema/song.ts';
import { exportTextTab } from '../../parser/textTab.ts';
import {
  encodeSongToHash,
  parseSongJson,
  serializeSongJson,
} from '../../storage/portability.ts';
import { useSongStore } from '../state/useSongStore.ts';
import { useAudioStore } from '../state/useAudioStore.ts';

export interface LibraryDrawerProps {
  open: boolean;
  onClose: () => void;
}

function toSafeFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'harmonica-tab';
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback
    }
  }
  if (typeof document !== 'undefined') {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try {
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      document.body.removeChild(el);
      return false;
    }
  }
  return false;
}

export function LibraryDrawer({ open, onClose }: LibraryDrawerProps) {
  const doc = useSongStore((s) => s.doc);
  const library = useSongStore((s) => s.library);
  const libraryFilter = useSongStore((s) => s.libraryFilter);
  const setLibraryFilter = useSongStore((s) => s.setLibraryFilter);
  const refreshLibrary = useSongStore((s) => s.refreshLibrary);
  const loadSongById = useSongStore((s) => s.loadSongById);
  const deleteSongById = useSongStore((s) => s.deleteSongById);
  const createNewSong = useSongStore((s) => s.createNewSong);
  const duplicateCurrentSong = useSongStore((s) => s.duplicateCurrentSong);
  const loadSongDocument = useSongStore((s) => s.loadSongDocument);
  const showToast = useSongStore((s) => s.showToast);

  const stop = useAudioStore((s) => s.stop);
  const loadSongIntoEngine = useAudioStore((s) => s.loadSongIntoEngine);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    void refreshLibrary();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, refreshLibrary]);

  if (!open) return null;

  const hasActiveFilter = Boolean(
    libraryFilter.query || libraryFilter.harpKey || libraryFilter.timingMode,
  );

  const handleNewSong = () => {
    stop();
    createNewSong();
    loadSongIntoEngine(useSongStore.getState().doc);
    onClose();
  };

  const handleDuplicate = () => {
    void duplicateCurrentSong();
  };

  const handleLoadSong = async (id: string) => {
    stop();
    await loadSongById(id);
    loadSongIntoEngine(useSongStore.getState().doc);
    onClose();
  };

  const handleExportJson = () => {
    try {
      const json = serializeSongJson(doc);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${toSafeFilename(doc.title)}.gaitab.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`Exported ${toSafeFilename(doc.title)}.gaitab.json`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to export .gaitab.json');
    }
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = parseSongJson(text);
      stop();
      loadSongDocument(parsed, true);
      loadSongIntoEngine(parsed);
      showToast(`Imported "${parsed.title}"`);
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Invalid .gaitab.json file');
    }
  };

  const handleCopyMarkdown = async () => {
    try {
      const md = exportTextTab(doc, true);
      const copied = await copyTextToClipboard(md);
      if (copied) {
        showToast('Copied Markdown tab to clipboard');
      } else {
        showToast('Clipboard blocked — unable to copy Markdown');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to export Markdown');
    }
  };

  const handleCopyShareUrl = async () => {
    try {
      const encoded = encodeSongToHash(doc);
      const shareUrl = `${window.location.origin}${window.location.pathname}${encoded.hash}`;
      try {
        window.history.replaceState(null, '', encoded.hash);
      } catch {
        // Ignore history restrictions in sandboxed environments
      }
      const copied = await copyTextToClipboard(shareUrl);
      if (encoded.exceedsSafeLimit) {
        showToast(
          copied
            ? `Share URL copied (${encoded.encodedLength} chars) — exceeds 8 KB safe limit; consider .gaitab.json export.`
            : `Share URL ready in address bar (${encoded.encodedLength} chars) — exceeds 8 KB safe limit.`,
        );
      } else {
        showToast(
          copied
            ? `Copied share URL (${encoded.encodedLength} chars)`
            : 'Updated address bar with #tab= share URL',
        );
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to generate share URL');
    }
  };

  return (
    <div
      className="drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="library-drawer-heading"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="drawer-panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div>
            <h2 id="library-drawer-heading" style={{ margin: 0, fontSize: 17 }}>
              Local Library &amp; Export
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            aria-label="Close library drawer"
          >
            ✕
          </button>
        </div>

        {/* Quick Actions */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="new-song-btn"
            onClick={handleNewSong}
          >
            ＋ New Song
          </button>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="duplicate-song-btn"
            onClick={handleDuplicate}
          >
            ⧉ Duplicate
          </button>
        </div>

        {/* Portability */}
        <div
          style={{
            padding: 10,
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>
            Portability &amp; Sharing
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              data-testid="export-json-btn"
              onClick={handleExportJson}
            >
              ⤓ Export
            </button>
            <button
              type="button"
              className="btn btn-sm"
              data-testid="import-json-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              ⤒ Import
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.gaitab.json"
              data-testid="import-json-input"
              style={{ display: 'none' }}
              onChange={(e) => void handleImportFile(e)}
            />
            <button
              type="button"
              className="btn btn-sm"
              data-testid="copy-markdown-btn"
              onClick={() => void handleCopyMarkdown()}
            >
              Markdown
            </button>
            <button
              type="button"
              className="btn btn-sm"
              data-testid="copy-share-url-btn"
              onClick={() => void handleCopyShareUrl()}
            >
              Share URL
            </button>
          </div>
        </div>

        {/* Search & Filters */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="search"
            placeholder="Search saved tabs by title or artist..."
            data-testid="library-search-input"
            value={libraryFilter.query ?? ''}
            onChange={(e) => {
              const q = e.target.value;
              void setLibraryFilter({
                ...libraryFilter,
                query: q ? q : undefined,
              });
            }}
            style={{
              width: '100%',
              background: 'var(--bg-root)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-sm)',
              padding: '7px 10px',
              fontSize: 13,
            }}
          />

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <label className="field-inline" style={{ flex: '1 1 120px' }}>
              <span>Key</span>
              <select
                data-testid="library-key-filter"
                value={libraryFilter.harpKey ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  void setLibraryFilter({
                    ...libraryFilter,
                    harpKey: val ? (val as HarpKey) : undefined,
                  });
                }}
                style={{ flex: 1 }}
              >
                <option value="">All Keys</option>
                {HARP_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>

            <label className="field-inline" style={{ flex: '1 1 140px' }}>
              <span>Timing</span>
              <select
                data-testid="library-timing-filter"
                value={libraryFilter.timingMode ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  void setLibraryFilter({
                    ...libraryFilter,
                    timingMode: val ? (val as TimingMode) : undefined,
                  });
                }}
                style={{ flex: 1 }}
              >
                <option value="">All</option>
                <option value="measured">Measured</option>
                <option value="unmeasured">Unmeasured</option>
              </select>
            </label>
          </div>
        </div>

        {/* Song List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
          {library.length === 0 ? (
            <div
              style={{
                padding: 16,
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-elevated)',
                border: '1px dashed var(--border-strong)',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                fontSize: 13,
                color: 'var(--text-secondary)',
              }}
            >
              {hasActiveFilter ? (
                <>
                  <div>No saved tabs match your current search/filter.</div>
                  <div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void setLibraryFilter({})}
                    >
                      ✕ Clear Filters
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <strong>Local-first library is empty.</strong>
                    <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                      Songs autosave directly to IndexedDB in your browser—no login or pre-built
                      catalog required. Start a blank tab or load the Golden Fixture to try
                      playback.
                    </p>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={handleNewSong}
                    >
                      ＋ New Song
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            library.map((item) => {
              const isActive = item.id === doc.id;
              return (
                <div
                  key={item.id}
                  className={isActive ? 'library-item active' : 'library-item'}
                  data-testid="library-item"
                  data-song-id={item.id}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 14,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={item.title}
                    >
                      {item.title}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--text-secondary)',
                        display: 'flex',
                        gap: 8,
                        flexWrap: 'wrap',
                        marginTop: 2,
                      }}
                    >
                      <span>Key {item.harpKey}</span>
                      <span>·</span>
                      <span>{item.timingMode}</span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      className={isActive ? 'btn btn-active btn-sm' : 'btn btn-sm'}
                      onClick={() => void handleLoadSong(item.id)}
                    >
                      Load
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => void deleteSongById(item.id)}
                      aria-label={`Delete ${item.title}`}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}
