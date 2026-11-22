import { useCallback, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { BendSteps, BreathAction, TuningId } from '../../schema/song.ts';
import {
  clampBendSteps,
  formatNoteToken,
  maxBendSteps,
  midiToNoteName,
  resolveHoleMidi,
} from '../../schema/tuning.ts';
import { useAudioStore, type ActiveInteractiveNote } from '../state/useAudioStore.ts';
import { useSongStore } from '../state/useSongStore.ts';

export interface HarmonicaCombProps {
  stepTapActive?: boolean;
}

interface PointerVoice {
  pointerId: number;
  voiceId: number;
  hole: number;
  action: BreathAction;
  startY: number;
  midY: number;
  bendFloat: number;
}

interface KeyVoice {
  keyId: string;
  voiceId: number;
  hole: number;
  action: BreathAction;
  bendSteps: BendSteps;
}

const HOLES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

const NUMBER_KEY_TO_HOLE: Readonly<Record<string, number>> = {
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
  Digit4: 4,
  Digit5: 5,
  Digit6: 6,
  Digit7: 7,
  Digit8: 8,
  Digit9: 9,
  Digit0: 10,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '0': 10,
};

const DRAW_KEY_TO_HOLE: Readonly<Record<string, number>> = {
  KeyQ: 1,
  KeyW: 2,
  KeyE: 3,
  KeyR: 4,
  KeyT: 5,
  KeyY: 6,
  KeyU: 7,
  KeyI: 8,
  KeyO: 9,
  KeyP: 10,
  q: 1,
  w: 2,
  e: 3,
  r: 4,
  t: 5,
  y: 6,
  u: 7,
  i: 8,
  o: 9,
  p: 10,
};

const BEND_DEADZONE_PX = 8;
const BEND_PX_PER_SEMITONE = 34;
const BREATH_SWITCH_HYSTERESIS_PX = 10;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

function resolveNumberHole(e: KeyboardEvent): number | null {
  const byCode = NUMBER_KEY_TO_HOLE[e.code];
  if (byCode !== undefined) return byCode;
  const byKey = NUMBER_KEY_TO_HOLE[e.key];
  return byKey !== undefined ? byKey : null;
}

function resolveDrawHole(e: KeyboardEvent): number | null {
  const byCode = DRAW_KEY_TO_HOLE[e.code];
  if (byCode !== undefined) return byCode;
  const byKey = DRAW_KEY_TO_HOLE[e.key.toLowerCase()];
  return byKey !== undefined ? byKey : null;
}

function resolveBendModifier(e: KeyboardEvent): 1 | 2 | 3 | null {
  if (e.code === 'ArrowDown' || e.key === 'ArrowDown') return 1;
  const lower = e.key.toLowerCase();
  if (e.code === 'KeyZ' || lower === 'z') return 2;
  if (e.code === 'KeyX' || lower === 'x') return 3;
  return null;
}

function isSpaceKey(e: KeyboardEvent): boolean {
  return e.code === 'Space' || e.key === ' ';
}

function getHoleElementAtPoint(clientX: number, clientY: number): HTMLElement | null {
  if (typeof document.elementFromPoint !== 'function') return null;
  const el = document.elementFromPoint(clientX, clientY);
  return el?.closest<HTMLElement>('[data-hole]') ?? null;
}

function parseHoleNumber(el: HTMLElement | null): number | null {
  if (!el) return null;
  const raw = el.dataset.hole;
  if (!raw) return null;
  const num = Number(raw);
  return Number.isInteger(num) && num >= 1 && num <= 10 ? num : null;
}

function computeBendFloat(
  tuning: TuningId,
  hole: number,
  action: BreathAction,
  startY: number,
  currentY: number,
): number {
  const maxSteps = maxBendSteps(tuning, hole, action);
  if (maxSteps <= 0) return 0;

  const deltaPx =
    action === 'draw'
      ? Math.max(0, currentY - startY)
      : action === 'blow'
        ? Math.max(0, startY - currentY)
        : 0;

  if (deltaPx <= BEND_DEADZONE_PX) return 0;
  const rawBend = (deltaPx - BEND_DEADZONE_PX) / BEND_PX_PER_SEMITONE;
  return Math.max(0, Math.min(maxSteps, rawBend));
}

export function HarmonicaComb({ stepTapActive = false }: HarmonicaCombProps) {
  const audioState = useAudioStore((s) => s.audioState);
  const recording = useAudioStore((s) => s.recording);
  const activeHoles = useAudioStore((s) => s.activeHoles);
  const wah = useAudioStore((s) => s.wah);
  const keyboardMode = useAudioStore((s) => s.keyboardMode);
  const liveNotes = useAudioStore((s) => s.liveNotes);
  const unlockAudio = useAudioStore((s) => s.unlockAudio);
  const setWah = useAudioStore((s) => s.setWah);
  const setKeyboardMode = useAudioStore((s) => s.setKeyboardMode);
  const startInteractiveHole = useAudioStore((s) => s.startInteractiveHole);
  const updateInteractiveBend = useAudioStore((s) => s.updateInteractiveBend);
  const stopInteractiveVoice = useAudioStore((s) => s.stopInteractiveVoice);

  const harpKey = useSongStore((s) => s.doc.instrument.harpKey);
  const tuning = useSongStore((s) => s.doc.instrument.tuning);

  // Refs kept in sync for zero-stale-closure pointer & keyboard listeners
  const harpKeyRef = useRef(harpKey);
  harpKeyRef.current = harpKey;
  const tuningRef = useRef(tuning);
  tuningRef.current = tuning;
  const keyboardModeRef = useRef(keyboardMode);
  keyboardModeRef.current = keyboardMode;
  const stepTapActiveRef = useRef(stepTapActive);
  stepTapActiveRef.current = stepTapActive;

  // Voice IDs stay strictly in 1000..8999 so they never collide with sequencer IDs (>= 10000)
  const nextPointerVoiceIdRef = useRef(1000);
  const nextKeyVoiceIdRef = useRef(5000);

  const pointerVoicesRef = useRef<Map<number, PointerVoice>>(new Map());
  const keyVoicesRef = useRef<Map<string, KeyVoice>>(new Map());
  const heldBendsRef = useRef<Set<1 | 2 | 3>>(new Set());
  const spaceHeldRef = useRef(false);

  const allocPointerVoiceId = useCallback((): number => {
    const id = nextPointerVoiceIdRef.current;
    nextPointerVoiceIdRef.current = id >= 4999 ? 1000 : id + 1;
    return id;
  }, []);

  const allocKeyVoiceId = useCallback((): number => {
    const id = nextKeyVoiceIdRef.current;
    nextKeyVoiceIdRef.current = id >= 8999 ? 5000 : id + 1;
    return id;
  }, []);

  const getRequestedKeyBend = useCallback((): BendSteps => {
    let max: BendSteps = 0;
    for (const step of heldBendsRef.current) {
      if (step > max) max = step;
    }
    return max;
  }, []);

  const releaseAllPointerVoices = useCallback(() => {
    for (const voice of pointerVoicesRef.current.values()) {
      stopInteractiveVoice(voice.voiceId);
    }
    pointerVoicesRef.current.clear();
  }, [stopInteractiveVoice]);

  const releaseAllKeyboardVoices = useCallback(() => {
    for (const voice of keyVoicesRef.current.values()) {
      stopInteractiveVoice(voice.voiceId);
    }
    keyVoicesRef.current.clear();
    heldBendsRef.current.clear();
    spaceHeldRef.current = false;
  }, [stopInteractiveVoice]);

  // Release keyboard voices whenever mode changes or Step-Tap activates
  useEffect(() => {
    releaseAllKeyboardVoices();
  }, [keyboardMode, stepTapActive, releaseAllKeyboardVoices]);

  // Global keyboard handler + window blur/visibility cleanup
  useEffect(() => {
    const applyBendToActiveKeyVoices = () => {
      const requested = getRequestedKeyBend();
      const curTuning = tuningRef.current;
      const curKey = harpKeyRef.current;

      for (const voice of keyVoicesRef.current.values()) {
        const clamped = clampBendSteps(curTuning, voice.hole, voice.action, requested);
        if (clamped !== voice.bendSteps) {
          voice.bendSteps = clamped;
          updateInteractiveBend(voice.voiceId, voice.hole, voice.action, curKey, clamped);
        }
      }
    };

    const switchBreathModeVoices = (nextAction: BreathAction) => {
      const requested = getRequestedKeyBend();
      const curTuning = tuningRef.current;
      const curKey = harpKeyRef.current;

      for (const [keyId, voice] of keyVoicesRef.current.entries()) {
        if (voice.action === nextAction) continue;
        stopInteractiveVoice(voice.voiceId);
        const newVoiceId = allocKeyVoiceId();
        const clamped = clampBendSteps(curTuning, voice.hole, nextAction, requested);
        keyVoicesRef.current.set(keyId, {
          keyId,
          voiceId: newVoiceId,
          hole: voice.hole,
          action: nextAction,
          bendSteps: clamped,
        });
        startInteractiveHole(newVoiceId, voice.hole, nextAction, curKey, clamped);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (stepTapActiveRef.current) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;

      const mode = keyboardModeRef.current;

      // Space toggles Draw/Blow in breath-switch mode
      if (mode === 'breath-switch' && isSpaceKey(e)) {
        e.preventDefault();
        if (e.repeat) return;
        if (!spaceHeldRef.current) {
          spaceHeldRef.current = true;
          switchBreathModeVoices('draw');
        }
        return;
      }

      // Bend modifiers (ArrowDown = 1, Z = 2, X = 3)
      const bendStep = resolveBendModifier(e);
      if (bendStep !== null) {
        if (bendStep === 1 && keyVoicesRef.current.size > 0) {
          e.preventDefault();
        }
        if (e.repeat) return;
        if (!heldBendsRef.current.has(bendStep)) {
          heldBendsRef.current.add(bendStep);
          applyBendToActiveKeyVoices();
        }
        return;
      }

      if (e.repeat) return;

      const numberHole = resolveNumberHole(e);
      if (numberHole !== null) {
        const keyId = `num-${numberHole}`;
        if (keyVoicesRef.current.has(keyId)) return;

        const action: BreathAction =
          mode === 'breath-switch' && spaceHeldRef.current ? 'draw' : 'blow';
        const voiceId = allocKeyVoiceId();
        const clamped = clampBendSteps(
          tuningRef.current,
          numberHole,
          action,
          getRequestedKeyBend(),
        );
        keyVoicesRef.current.set(keyId, {
          keyId,
          voiceId,
          hole: numberHole,
          action,
          bendSteps: clamped,
        });
        startInteractiveHole(voiceId, numberHole, action, harpKeyRef.current, clamped);
        return;
      }

      if (mode === 'two-row') {
        const drawHole = resolveDrawHole(e);
        if (drawHole !== null) {
          const keyId = `draw-${drawHole}`;
          if (keyVoicesRef.current.has(keyId)) return;

          const voiceId = allocKeyVoiceId();
          const clamped = clampBendSteps(
            tuningRef.current,
            drawHole,
            'draw',
            getRequestedKeyBend(),
          );
          keyVoicesRef.current.set(keyId, {
            keyId,
            voiceId,
            hole: drawHole,
            action: 'draw',
            bendSteps: clamped,
          });
          startInteractiveHole(voiceId, drawHole, 'draw', harpKeyRef.current, clamped);
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Always honor keyup even if focus moved so no note can ever stay stuck
      if (isSpaceKey(e) && spaceHeldRef.current) {
        spaceHeldRef.current = false;
        if (keyboardModeRef.current === 'breath-switch') {
          switchBreathModeVoices('blow');
        }
        return;
      }

      const bendStep = resolveBendModifier(e);
      if (bendStep !== null && heldBendsRef.current.has(bendStep)) {
        heldBendsRef.current.delete(bendStep);
        applyBendToActiveKeyVoices();
        return;
      }

      const numberHole = resolveNumberHole(e);
      if (numberHole !== null) {
        const keyId = `num-${numberHole}`;
        const voice = keyVoicesRef.current.get(keyId);
        if (voice) {
          keyVoicesRef.current.delete(keyId);
          stopInteractiveVoice(voice.voiceId);
        }
        return;
      }

      const drawHole = resolveDrawHole(e);
      if (drawHole !== null) {
        const keyId = `draw-${drawHole}`;
        const voice = keyVoicesRef.current.get(keyId);
        if (voice) {
          keyVoicesRef.current.delete(keyId);
          stopInteractiveVoice(voice.voiceId);
        }
      }
    };

    const handleReleaseAll = () => {
      releaseAllKeyboardVoices();
      releaseAllPointerVoices();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        handleReleaseAll();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleReleaseAll);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleReleaseAll);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      handleReleaseAll();
    };
  }, [
    allocKeyVoiceId,
    getRequestedKeyBend,
    releaseAllKeyboardVoices,
    releaseAllPointerVoices,
    startInteractiveHole,
    stopInteractiveVoice,
    updateInteractiveBend,
  ]);

  // Pointer handlers on `.comb-chassis` for blow/draw, glissando, and continuous bend
  const stopPointerVoice = useCallback(
    (pointerId: number) => {
      const active = pointerVoicesRef.current.get(pointerId);
      if (!active) return;
      pointerVoicesRef.current.delete(pointerId);
      stopInteractiveVoice(active.voiceId);
    },
    [stopInteractiveVoice],
  );

  const handleChassisPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const targetEl =
        e.target instanceof Element ? e.target.closest<HTMLElement>('[data-hole]') : null;
      const holeEl = targetEl ?? getHoleElementAtPoint(e.clientX, e.clientY);
      const hole = parseHoleNumber(holeEl);
      if (hole === null || !holeEl) return;

      e.preventDefault();

      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore for synthetic events without an active OS pointer
      }

      // Clean up any stale voice bound to this pointerId
      stopPointerVoice(e.pointerId);

      const rect = holeEl.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const action: BreathAction = e.clientY <= midY ? 'blow' : 'draw';
      const voiceId = allocPointerVoiceId();

      pointerVoicesRef.current.set(e.pointerId, {
        pointerId: e.pointerId,
        voiceId,
        hole,
        action,
        startY: e.clientY,
        midY,
        bendFloat: 0,
      });

      startInteractiveHole(voiceId, hole, action, harpKeyRef.current, 0);
    },
    [allocPointerVoiceId, startInteractiveHole, stopPointerVoice],
  );

  const handleChassisPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const active = pointerVoicesRef.current.get(e.pointerId);
      if (!active) return;

      const hitEl = getHoleElementAtPoint(e.clientX, e.clientY);
      const hitHole = parseHoleNumber(hitEl);

      // Horizontal glissando to a different hole
      if (hitHole !== null && hitEl && hitHole !== active.hole) {
        stopInteractiveVoice(active.voiceId);

        const rect = hitEl.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const nextAction: BreathAction = e.clientY <= midY ? 'blow' : 'draw';
        const nextVoiceId = allocPointerVoiceId();

        active.voiceId = nextVoiceId;
        active.hole = hitHole;
        active.action = nextAction;
        active.startY = e.clientY;
        active.midY = midY;
        active.bendFloat = 0;

        startInteractiveHole(nextVoiceId, hitHole, nextAction, harpKeyRef.current, 0);
        return;
      }

      // Vertical drag across center switches between Blow (up) and Draw (down)
      if (active.action === 'blow' && e.clientY > active.midY + BREATH_SWITCH_HYSTERESIS_PX) {
        stopInteractiveVoice(active.voiceId);
        const nextVoiceId = allocPointerVoiceId();
        active.voiceId = nextVoiceId;
        active.action = 'draw';
        active.startY = e.clientY;
        active.bendFloat = 0;
        startInteractiveHole(nextVoiceId, active.hole, 'draw', harpKeyRef.current, 0);
        return;
      }

      if (active.action === 'draw' && e.clientY < active.midY - BREATH_SWITCH_HYSTERESIS_PX) {
        stopInteractiveVoice(active.voiceId);
        const nextVoiceId = allocPointerVoiceId();
        active.voiceId = nextVoiceId;
        active.action = 'blow';
        active.startY = e.clientY;
        active.bendFloat = 0;
        startInteractiveHole(nextVoiceId, active.hole, 'blow', harpKeyRef.current, 0);
        return;
      }

      // Continuous vertical bend clamped strictly to [0, maxBendSteps]
      const nextBend = computeBendFloat(
        tuningRef.current,
        active.hole,
        active.action,
        active.startY,
        e.clientY,
      );

      if (Math.abs(nextBend - active.bendFloat) >= 0.005) {
        active.bendFloat = nextBend;
        updateInteractiveBend(
          active.voiceId,
          active.hole,
          active.action,
          harpKeyRef.current,
          nextBend,
        );
      }
    },
    [allocPointerVoiceId, startInteractiveHole, stopInteractiveVoice, updateInteractiveBend],
  );

  const handleChassisPointerUpOrCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore if capture was already released
      }
      stopPointerVoice(e.pointerId);
    },
    [stopPointerVoice],
  );

  // Derived view data
  const liveNoteList = useMemo(() => Object.values(liveNotes), [liveNotes]);

  const meterNote: ActiveInteractiveNote | null = useMemo(() => {
    if (liveNoteList.length === 0) return null;
    let latest = liveNoteList[0]!;
    for (let i = 1; i < liveNoteList.length; i++) {
      const candidate = liveNoteList[i]!;
      if (candidate.voiceId > latest.voiceId) {
        latest = candidate;
      }
    }
    return latest;
  }, [liveNoteList]);

  const scoreHoleSet = useMemo(() => new Set(activeHoles), [activeHoles]);

  const holeDescriptors = useMemo(() => {
    return HOLES.map((hole) => {
      const blowMidi = resolveHoleMidi(tuning, harpKey, hole, 'blow');
      const drawMidi = resolveHoleMidi(tuning, harpKey, hole, 'draw');
      const drawMax = maxBendSteps(tuning, hole, 'draw');
      const blowMax = maxBendSteps(tuning, hole, 'blow');
      const bendAction: BreathAction = drawMax > 0 ? 'draw' : 'blow';
      const maxDots = drawMax > 0 ? drawMax : blowMax;
      return {
        hole,
        blowName: midiToNoteName(blowMidi),
        drawName: midiToNoteName(drawMidi),
        bendAction,
        maxDots,
      };
    });
  }, [tuning, harpKey]);

  const meterToken = meterNote
    ? formatNoteToken({
        holes: [meterNote.hole],
        action: meterNote.action,
        bendSteps: meterNote.bendSteps,
      })
    : '—';
  const meterHz = meterNote ? `${meterNote.freqHz.toFixed(1)} Hz` : '— Hz';
  const meterCents = meterNote
    ? `${meterNote.bendCents === 0 ? 0 : meterNote.bendCents}¢`
    : '0¢';

  return (
    <section className="comb-section" aria-label="Interactive 10-Hole Harmonica Comb">
      {audioState !== 'running' && (
        <div className="audio-unlock-banner" role="status" data-testid="audio-unlock-banner">
          <span>Click any hole or press Play to wake the harp</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="wake-harp-btn"
            onClick={() => {
              void unlockAudio();
            }}
          >
            Wake Harp
          </button>
        </div>
      )}

      <div className="comb-header">
        <div className="transport-group">
          <strong>10-Hole Richter ({harpKey})</strong>
          <div className="bend-meter" data-testid="bend-meter" aria-live="polite">
            <span data-testid="bend-meter-token">{meterToken}</span>
            <span style={{ color: 'var(--text-muted)' }}>|</span>
            <span data-testid="bend-meter-hz">{meterHz}</span>
            <span style={{ color: 'var(--text-muted)' }}>|</span>
            <span data-testid="bend-meter-cents">{meterCents}</span>
          </div>
          {recording && (
            <span
              data-testid="comb-recording-badge"
              role="status"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 999,
                backgroundColor: 'rgba(201, 59, 59, 0.22)',
                border: '1px solid #ef6363',
                color: '#ffd6d6',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              ● Recording to timeline
            </span>
          )}
        </div>

        <div className="transport-group">
          <label className="field-inline">
            <span>Wah</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={wah}
              data-testid="wah-slider"
              aria-label="Hand cupping wah filter"
              onChange={(e) => {
                setWah(Number(e.target.value));
              }}
            />
          </label>

          <div className="segmented comb-desktop-only" role="group" aria-label="Keyboard mode">
            <button
              type="button"
              className={keyboardMode === 'two-row' ? 'active' : ''}
              data-testid="kb-mode-two-row"
              aria-pressed={keyboardMode === 'two-row'}
              onClick={() => setKeyboardMode('two-row')}
            >
              Two-Row
            </button>
            <button
              type="button"
              className={keyboardMode === 'breath-switch' ? 'active' : ''}
              data-testid="kb-mode-breath-switch"
              aria-pressed={keyboardMode === 'breath-switch'}
              onClick={() => setKeyboardMode('breath-switch')}
            >
              Breath-Switch
            </button>
          </div>
        </div>
      </div>

      <div
        className="comb-chassis"
        onPointerDown={handleChassisPointerDown}
        onPointerMove={handleChassisPointerMove}
        onPointerUp={handleChassisPointerUpOrCancel}
        onPointerCancel={handleChassisPointerUpOrCancel}
        onLostPointerCapture={(e) => {
          stopPointerVoice(e.pointerId);
        }}
      >
        <div className="comb-holes">
          {holeDescriptors.map(({ hole, blowName, drawName, bendAction, maxDots }) => {
            let isLiveBlow = false;
            let isLiveDraw = false;
            let litBends = 0;

            for (const note of liveNoteList) {
              if (note.hole !== hole) continue;
              if (note.action === 'blow' || note.action === 'overblow') {
                isLiveBlow = true;
              } else {
                isLiveDraw = true;
              }
              if (note.action === bendAction && note.bendSteps > litBends) {
                litBends = note.bendSteps;
              }
            }

            const isScoreActive = !isLiveBlow && !isLiveDraw && scoreHoleSet.has(hole);

            const classNames = ['comb-hole'];
            if (isLiveBlow) classNames.push('active-blow');
            if (isLiveDraw) classNames.push('active-draw');
            if (isScoreActive) classNames.push('active-score');

            return (
              <div
                key={hole}
                className={classNames.join(' ')}
                data-testid={`comb-hole-${hole}`}
                data-hole={hole}
                role="button"
                aria-label={`Hole ${hole}: Blow ${blowName}, Draw ${drawName}`}
              >
                <span className="hole-pitch-blow">{blowName}</span>
                <span className="hole-number">{hole}</span>
                <div className="hole-bend-dots" aria-hidden="true">
                  {Array.from({ length: maxDots }, (_, idx) => (
                    <span
                      key={idx}
                      className={idx < litBends ? 'hole-bend-dot lit' : 'hole-bend-dot'}
                    />
                  ))}
                </div>
                <span className="hole-pitch-draw">{drawName}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="comb-help-footer">
        <span>
          Pointer: Top half = Blow · Bottom half = Draw · Slide horizontally = Glissando · Drag
          deeper = Bend
        </span>
        <span>
          {stepTapActive
            ? 'Keyboard paused (Step-Tap active)'
            : keyboardMode === 'two-row'
              ? 'Keys: 1–0 Blow · Q–P Draw · ↓ / Z / X Bend'
              : 'Keys: 1–0 Play · Hold Space = Draw · ↓ / Z / X Bend'}
        </span>
      </div>
    </section>
  );
}

export default HarmonicaComb;
