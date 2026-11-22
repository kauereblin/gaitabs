import { useEffect, useState, type FormEvent } from 'react';
import { HARP_KEYS, type HarpKey } from '../../schema/song.ts';
import { WONDERFUL_WORLD_TEXT } from '../../schema/golden.ts';
import { useSongStore } from '../state/useSongStore.ts';
import { useAudioStore } from '../state/useAudioStore.ts';

export interface SmartPasteModalProps {
  open: boolean;
  onClose: () => void;
}

export function SmartPasteModal({ open, onClose }: SmartPasteModalProps) {
  const currentKey = useSongStore((s) => s.doc.instrument.harpKey);
  const currentBpm = useSongStore((s) => s.doc.bpm);
  const importFromPlainText = useSongStore((s) => s.importFromPlainText);
  const loadSongIntoEngine = useAudioStore((s) => s.loadSongIntoEngine);
  const stop = useAudioStore((s) => s.stop);

  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [harpKey, setHarpKey] = useState<HarpKey>(currentKey);
  const [bpm, setBpm] = useState<string>(String(currentBpm));
  const [rawText, setRawText] = useState('');

  useEffect(() => {
    if (!open) return;
    setHarpKey(currentKey);
    setBpm(String(currentBpm));
  }, [open, currentKey, currentBpm]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleFillGolden = () => {
    setRawText(WONDERFUL_WORLD_TEXT);
    if (title.trim().length === 0) {
      setTitle('What a Wonderful World');
    }
    if (artist.trim().length === 0) {
      setArtist('Golden Fixture');
    }
    setHarpKey('C');
    setBpm('76');
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (rawText.trim().length === 0) return;

    const parsedBpm = Number(bpm);
    const safeBpm = Number.isFinite(parsedBpm)
      ? Math.max(30, Math.min(260, Math.round(parsedBpm)))
      : 80;

    stop();
    importFromPlainText(rawText, {
      title: title.trim() || undefined,
      artist: artist.trim() || undefined,
      harpKey,
      bpm: safeBpm,
    });
    loadSongIntoEngine(useSongStore.getState().doc);

    setRawText('');
    setTitle('');
    setArtist('');
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="smart-paste-heading"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="modal-card" onSubmit={handleSubmit}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h2 id="smart-paste-heading" style={{ margin: 0, fontSize: 18 }}>
              Smart Paste Plain-Text Tabs
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
              Paste alternating tab and lyric lines (e.g. <code>3 -3 4</code> / <code>I see trees</code>).
              Imported songs start in <strong>unmeasured</strong> mode ready for pill resizing or Step-Tap.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            aria-label="Close Smart Paste modal"
          >
            ✕
          </button>
        </div>

        <div className="transport-group" style={{ justifyContent: 'space-between' }}>
          <label className="field-inline" style={{ flex: '1 1 200px' }}>
            <span>Title</span>
            <input
              type="text"
              data-testid="smart-paste-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. What a Wonderful World"
              style={{ flex: 1, minWidth: 140 }}
            />
          </label>

          <label className="field-inline" style={{ flex: '1 1 160px' }}>
            <span>Artist</span>
            <input
              type="text"
              data-testid="smart-paste-artist"
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              placeholder="Optional"
              style={{ flex: 1, minWidth: 120 }}
            />
          </label>
        </div>

        <div className="transport-group" style={{ justifyContent: 'space-between' }}>
          <div className="transport-group">
            <label className="field-inline">
              <span>Harp Key</span>
              <select
                data-testid="smart-paste-key"
                value={harpKey}
                onChange={(e) => setHarpKey(e.target.value as HarpKey)}
              >
                {HARP_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>

            <label className="field-inline">
              <span>BPM</span>
              <input
                type="number"
                min={30}
                max={260}
                data-testid="smart-paste-bpm"
                value={bpm}
                onChange={(e) => setBpm(e.target.value)}
                style={{ width: 72 }}
              />
            </label>
          </div>

          <button
            type="button"
            className="btn btn-sm"
            data-testid="fill-golden-text-btn"
            onClick={handleFillGolden}
          >
            ★ Fill Golden Example
          </button>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span>Tab &amp; Lyric Text</span>
          <textarea
            data-testid="smart-paste-textarea"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={'3 -3    4   4    6    -6  -6 -6  6\nI see trees of green, red roses too'}
            spellCheck={false}
          />
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            data-testid="smart-paste-submit-btn"
            disabled={rawText.trim().length === 0}
          >
            Import
          </button>
        </div>
      </form>
    </div>
  );
}
