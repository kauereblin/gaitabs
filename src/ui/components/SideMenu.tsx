import { useMemo } from 'react';
import type { UseStepTapResult } from '../hooks/useStepTap.ts';
import { useSongStore } from '../state/useSongStore.ts';
import { TransportBar } from './TransportBar.tsx';

export interface SideMenuProps {
  stepTap: UseStepTapResult;
  onOpenSmartPaste: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const SNAP_OPTIONS: ReadonlyArray<{ label: string; ticks: number }> = [
  { label: 'Off', ticks: 0 },
  { label: '1/16', ticks: 120 },
  { label: '1/8', ticks: 240 },
  { label: '1/4', ticks: 480 },
];

export function SideMenu({
  stepTap,
  onOpenSmartPaste,
  mobileOpen,
  onCloseMobile,
}: SideMenuProps) {
  const doc = useSongStore((s) => s.doc);
  const undoStack = useSongStore((s) => s.undoStack);
  const redoStack = useSongStore((s) => s.redoStack);
  const snapTicks = useSongStore((s) => s.snapTicks);
  const addBar = useSongStore((s) => s.addBar);
  const setSnapTicks = useSongStore((s) => s.setSnapTicks);
  const undo = useSongStore((s) => s.undo);
  const redo = useSongStore((s) => s.redo);

  const totalNotesCount = useMemo(
    () => doc.bars.reduce((sum, b) => sum + b.notes.length, 0),
    [doc.bars],
  );

  const handleToggleStepTap = (targetSpeed: 0.5 | 1) => {
    if (stepTap.active && stepTap.stepTapSpeed === targetSpeed) {
      stepTap.cancelStepTap();
    } else {
      stepTap.startStepTap(targetSpeed);
      onCloseMobile();
    }
  };

  return (
    <>
      {mobileOpen && (
        <div
          className="side-menu-backdrop"
          aria-hidden="true"
          onClick={onCloseMobile}
        />
      )}

      <aside
        className={`side-menu${mobileOpen ? ' open' : ''}`}
        aria-label="Transport and editor controls"
        data-testid="side-menu"
      >
        <div className="side-menu-mobile-header">
          <strong>Controls</strong>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Close controls menu"
            onClick={onCloseMobile}
          >
            ✕
          </button>
        </div>

        <TransportBar />

        <div className="side-divider" />

        <section className="editor-toolbar" aria-label="Editor tools">
          <div className="side-section-header">
            <span className="side-section-title">Editor Tools</span>
            <span
              className="save-badge"
              data-testid="timing-mode-badge"
              data-status={doc.timingMode === 'measured' ? 'saved' : 'idle'}
              title={
                doc.timingMode === 'measured'
                  ? 'Measured rhythm timings applied'
                  : 'Unmeasured placeholder timings — drag pill tails or use Step-Tap'
              }
            >
              {doc.timingMode === 'measured' ? 'Measured' : 'Unmeasured'}
            </span>
          </div>

          <div className="side-grid-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="open-smart-paste-btn"
              onClick={() => {
                onOpenSmartPaste();
                onCloseMobile();
              }}
            >
              Smart Paste
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={addBar}
            >
              ＋ Bar
            </button>
          </div>

          <div className="side-grid-2">
            <button
              type="button"
              className={`btn btn-sm${stepTap.active && stepTap.stepTapSpeed === 0.5 ? ' btn-active' : ''}`}
              disabled={totalNotesCount === 0}
              onClick={() => handleToggleStepTap(0.5)}
              title="Tap Spacebar in rhythm at half speed (0.5x)"
            >
              Step-Tap 0.5x
            </button>
            <button
              type="button"
              className={`btn btn-sm${stepTap.active && stepTap.stepTapSpeed === 1 ? ' btn-active' : ''}`}
              disabled={totalNotesCount === 0}
              onClick={() => handleToggleStepTap(1)}
              title="Tap Spacebar in rhythm at full speed (1x)"
            >
              Step-Tap 1x
            </button>
          </div>

          <div className="side-row-between">
            <div className="side-btn-pair">
              <button
                type="button"
                className="btn btn-sm"
                disabled={undoStack.length === 0}
                onClick={undo}
                title="Undo"
              >
                ↶
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={redoStack.length === 0}
                onClick={redo}
                title="Redo"
              >
                ↷
              </button>
            </div>

            <label className="field-inline">
              <span>Snap</span>
              <select
                aria-label="Grid Snap"
                value={snapTicks}
                onChange={(e) => setSnapTicks(Number(e.target.value))}
              >
                {SNAP_OPTIONS.map((opt) => (
                  <option key={opt.ticks} value={opt.ticks}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      </aside>
    </>
  );
}
