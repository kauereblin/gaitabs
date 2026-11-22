import {
  PPQ,
  type Bar,
  type BendSteps,
  type BreathAction,
  type HarmonicaNote,
  type HarpKey,
  type LyricSpan,
  type SongDocument,
  type TuningId,
} from '../schema/song.ts';
import { clampBendSteps, formatNoteToken } from '../schema/tuning.ts';

export interface ParsedToken {
  raw: string;
  colStart: number;
  colEnd: number;
  holes: number[];
  action: BreathAction;
  bendSteps: BendSteps;
}

export interface ParseTextTabOptions {
  title?: string;
  artist?: string;
  harpKey?: HarpKey;
  tuning?: TuningId;
  bpm?: number;
  id?: string;
}

interface WordSpan {
  text: string;
  colStart: number;
  colEnd: number;
}

/**
 * Parses a single harmonica tab token:
 * - Blow: `4`, `+4`, `10`
 * - Draw: `-4`, `-10`
 * - Bends: `-3'`, `-3''`, `-3'''`, `10''`
 * - Overblow / Overdraw: `6ob`, `-7od`, `7od`
 * - Chords: `34`, `(34)`, `-3-4`, `(-3-4)`, `456`, `(45)`
 */
export function parseTabToken(raw: string, tuning: TuningId = 'richter'): Omit<ParsedToken, 'raw' | 'colStart' | 'colEnd'> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Overblow: e.g. 6ob, +6ob
  const obMatch = /^\+?([1-9]|10)ob$/i.exec(trimmed);
  if (obMatch) {
    const hole = Number(obMatch[1]);
    return { holes: [hole], action: 'overblow', bendSteps: 0 };
  }

  // Overdraw: e.g. -7od, 7od
  const odMatch = /^-?([1-9]|10)od$/i.exec(trimmed);
  if (odMatch) {
    const hole = Number(odMatch[1]);
    return { holes: [hole], action: 'overdraw', bendSteps: 0 };
  }

  // Extract trailing bend marks (`'`, `’`, or `b` only not part of ob)
  let body = trimmed;
  let bendCount = 0;
  while (body.endsWith("'") || body.endsWith('’')) {
    bendCount++;
    body = body.slice(0, -1);
  }
  if (bendCount > 3) bendCount = 3;

  // Parenthesized chord e.g. (34), (-3-4), (4 5)
  const hadParens = body.startsWith('(') && body.endsWith(')');
  if (hadParens) {
    body = body.slice(1, -1).trim();
  }

  // Single hole: +4, 4, -4, 10, -10
  const singleMatch = /^([+-])?(10|[1-9])$/.exec(body);
  if (singleMatch) {
    const sign = singleMatch[1];
    const hole = Number(singleMatch[2]);
    const action: BreathAction = sign === '-' ? 'draw' : 'blow';
    const bendSteps = clampBendSteps(tuning, hole, action, bendCount);
    return { holes: [hole], action, bendSteps };
  }

  // Multi-hole chord: e.g. -3-4, +3+4, 34, 456, (4 5), -45 (all draw if starts with '-')
  const chordBody = hadParens ? body.replace(/\s+/g, '') : body;
  const chordParts = [...chordBody.matchAll(/([+-])?(10|[1-9])/g)];
  const reconstructed = chordParts.map((m) => m[0]).join('');
  if (chordParts.length >= 2 && reconstructed === chordBody) {
    const firstSign = chordParts[0]![1];
    const action: BreathAction = firstSign === '-' ? 'draw' : 'blow';
    const holes: number[] = [];
    for (const part of chordParts) {
      const h = Number(part[2]);
      if (!holes.includes(h)) holes.push(h);
    }
    const bendSteps = holes.length === 1 ? clampBendSteps(tuning, holes[0]!, action, bendCount) : 0;
    return { holes, action, bendSteps };
  }

  return null;
}

export function parseTabLine(line: string, tuning: TuningId = 'richter'): ParsedToken[] | null {
  const matches = [...line.matchAll(/\([^)]+\)['’]*|\S+/g)];
  if (matches.length === 0) return null;

  const tokens: ParsedToken[] = [];
  for (const m of matches) {
    const raw = m[0];
    // Ignore barline pipes inside a tab line
    if (raw === '|') continue;
    const parsed = parseTabToken(raw, tuning);
    if (!parsed) return null;
    const colStart = m.index ?? 0;
    tokens.push({
      raw,
      colStart,
      colEnd: colStart + raw.length,
      ...parsed,
    });
  }

  return tokens.length > 0 ? tokens : null;
}

function tokenizeWords(line: string): WordSpan[] {
  const words: WordSpan[] = [];
  for (const m of line.matchAll(/\S+/g)) {
    const start = m.index ?? 0;
    words.push({
      text: m[0],
      colStart: start,
      colEnd: start + m[0].length,
    });
  }
  return words;
}

function splitWordIntoSyllables(word: string, parts: number): Array<{ text: string; joinNext?: boolean }> {
  if (parts <= 1) return [{ text: word }];

  // Preserve leading/trailing punctuation
  const punctMatch = /^([^A-Za-zÀ-ÿ]*)([A-Za-zÀ-ÿ'-]+)([^A-Za-zÀ-ÿ]*)$/.exec(word);
  if (!punctMatch) {
    const out: Array<{ text: string; joinNext?: boolean }> = [{ text: word }];
    for (let i = 1; i < parts; i++) out.push({ text: '' });
    return out;
  }

  const [, lead = '', core = word, trail = ''] = punctMatch;
  // If explicitly hyphenated, honor existing hyphen points first
  if (core.includes('-')) {
    const segs = core.split('-').filter(Boolean);
    if (segs.length === parts) {
      return segs.map((s, idx) => ({
        text: `${idx === 0 ? lead : ''}${s}${idx < parts - 1 ? '-' : trail}`,
        ...(idx < parts - 1 ? { joinNext: true } : {}),
      }));
    }
  }

  // Find vowel-cluster transitions for natural English syllable splits (e.g., "roses" -> "ro-", "ses")
  const splitPoints: number[] = [];
  const vowels = /[aeiouyAEIOUYàáâãäåèéêëìíîïòóôõöùúûü]/;
  for (let i = 1; i < core.length - 1; i++) {
    if (vowels.test(core[i - 1]!) && !vowels.test(core[i]!) && vowels.test(core[i + 1]!)) {
      splitPoints.push(i);
    } else if (
      i < core.length - 2 &&
      vowels.test(core[i - 1]!) &&
      !vowels.test(core[i]!) &&
      !vowels.test(core[i + 1]!) &&
      vowels.test(core[i + 2]!)
    ) {
      splitPoints.push(i + 1);
    }
  }

  const chosen: number[] = [];
  if (splitPoints.length >= parts - 1) {
    // Pick split points closest to equal fractions
    for (let p = 1; p < parts; p++) {
      const target = (core.length * p) / parts;
      let best = splitPoints[0]!;
      let bestDist = Infinity;
      for (const sp of splitPoints) {
        if (chosen.includes(sp)) continue;
        const dist = Math.abs(sp - target);
        if (dist < bestDist) {
          bestDist = dist;
          best = sp;
        }
      }
      chosen.push(best);
    }
    chosen.sort((a, b) => a - b);
  } else {
    for (let p = 1; p < parts; p++) {
      chosen.push(Math.max(1, Math.min(core.length - 1, Math.round((core.length * p) / parts))));
    }
  }

  const slices: string[] = [];
  let prev = 0;
  for (const idx of chosen) {
    slices.push(core.slice(prev, idx));
    prev = idx;
  }
  slices.push(core.slice(prev));

  return slices.map((s, idx) => ({
    text: `${idx === 0 ? lead : ''}${s}${idx < slices.length - 1 ? '-' : trail}`,
    ...(idx < slices.length - 1 ? { joinNext: true } : {}),
  }));
}

function alignLyricsToTokens(
  barIndex: number,
  tokens: readonly ParsedToken[],
  lyricLine: string,
): LyricSpan[] {
  const words = tokenizeWords(lyricLine);
  if (words.length === 0 || tokens.length === 0) return [];

  // Fast path: equal count pairs 1:1 cleanly
  if (words.length === tokens.length) {
    return words.map((w, i) => ({
      id: `l-${barIndex}-${i}`,
      offsetTick: i * PPQ,
      durationTicks: PPQ,
      text: w.text,
    }));
  }

  // Column-nearest assignment from each token to a word, enforcing monotonic left-to-right order
  const wordBuckets: number[][] = words.map(() => []);
  let minWordIdx = 0;

  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti]!;
    const tokCenter = (tok.colStart + tok.colEnd) / 2;

    // Leave enough remaining tokens if needed, else pick nearest word center >= minWordIdx
    let bestWordIdx = minWordIdx;
    let bestDist = Infinity;

    for (let wi = minWordIdx; wi < words.length; wi++) {
      const w = words[wi]!;
      const inside = tok.colStart >= w.colStart && tok.colStart < w.colEnd;
      const wCenter = (w.colStart + w.colEnd) / 2;
      const dist = inside ? 0 : Math.abs(tokCenter - wCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestWordIdx = wi;
      }
    }

    wordBuckets[bestWordIdx]!.push(ti);
    minWordIdx = bestWordIdx;
  }

  // Merge any unassigned words into the nearest occupied bucket or distribute evenly
  const spans: LyricSpan[] = [];
  for (let wi = 0; wi < words.length; wi++) {
    const bucket = wordBuckets[wi]!;
    if (bucket.length === 0) continue;
    const parts = splitWordIntoSyllables(words[wi]!.text, bucket.length);
    for (let bi = 0; bi < bucket.length; bi++) {
      const ti = bucket[bi]!;
      const part = parts[bi]!;
      spans.push({
        id: `l-${barIndex}-${ti}`,
        offsetTick: ti * PPQ,
        durationTicks: PPQ,
        text: part.text,
        ...(part.joinNext ? { joinNext: true } : {}),
      });
    }
  }

  spans.sort((a, b) => a.offsetTick - b.offsetTick);
  return spans;
}

/**
 * Parses legacy plain-text / Markdown harmonica tabs into a SongDocument (`timingMode: 'unmeasured'`).
 */
export function parseTextTab(input: string, options?: ParseTextTabOptions): SongDocument {
  const tuning: TuningId = options?.tuning ?? 'richter';
  const harpKey: HarpKey = options?.harpKey ?? 'C';
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const bars: Bar[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    const tokens = parseTabLine(line, tuning);
    if (!tokens) {
      i++;
      continue;
    }

    // Check if the immediately following non-empty line is a lyric line (i.e., NOT a tab line)
    let lyricLine: string | null = null;
    if (i + 1 < lines.length) {
      const nextLine = lines[i + 1]!;
      if (nextLine.trim() && !parseTabLine(nextLine, tuning)) {
        lyricLine = nextLine;
        i += 2;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }

    const barIndex = bars.length;
    const notes: HarmonicaNote[] = tokens.map((tok, ni) => ({
      id: `n-${barIndex}-${ni}`,
      offsetTick: ni * PPQ,
      durationTicks: PPQ,
      holes: tok.holes,
      action: tok.action,
      bendSteps: tok.bendSteps,
    }));

    const lyrics = lyricLine ? alignLyricsToTokens(barIndex, tokens, lyricLine) : [];

    bars.push({
      id: `bar-${barIndex}`,
      index: barIndex,
      durationTicks: Math.max(PPQ, notes.length * PPQ),
      notes,
      lyrics,
    });
  }

  const now = new Date().toISOString();
  return {
    id: options?.id ?? crypto.randomUUID(),
    schemaVersion: 1,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    title: options?.title?.trim() || 'Imported Harmonica Tab',
    artist: options?.artist?.trim() || undefined,
    instrument: {
      tuning,
      harpKey,
    },
    timingMode: 'unmeasured',
    bpm: options?.bpm ?? 80,
    swingPercent: 50,
    timeSignature: {
      numerator: 4,
      denominator: 4,
    },
    bars:
      bars.length > 0
        ? bars
        : [
            {
              id: 'bar-0',
              index: 0,
              durationTicks: 4 * PPQ,
              notes: [],
              lyrics: [],
            },
          ],
  };
}

/**
 * Lossy projection: exports a SongDocument to clean human-readable plain-text / Markdown tabs.
 */
export function exportTextTab(doc: SongDocument, includeHeader: boolean = true): string {
  const out: string[] = [];
  if (includeHeader) {
    out.push(`# ${doc.title}`);
    const meta = [
      doc.artist ? `Artist: ${doc.artist}` : null,
      `Harp: ${doc.instrument.harpKey} (${doc.instrument.tuning})`,
      `BPM: ${doc.bpm}`,
      `Time: ${doc.timeSignature.numerator}/${doc.timeSignature.denominator}`,
    ].filter(Boolean);
    out.push(meta.join(' | '));
    out.push('');
  }

  for (const bar of doc.bars) {
    const sortedNotes = [...bar.notes].sort((a, b) => a.offsetTick - b.offsetTick);
    const sortedLyrics = [...bar.lyrics].sort((a, b) => a.offsetTick - b.offsetTick);

    if (sortedNotes.length === 0 && sortedLyrics.length === 0) continue;

    // Align tokens and lyrics column-by-column cleanly
    const lyricByOffset = new Map<number, LyricSpan>();
    for (const l of sortedLyrics) {
      lyricByOffset.set(l.offsetTick, l);
    }

    let tabLine = '';
    let lyricLine = '';
    let hasLyrics = false;

    for (const note of sortedNotes) {
      const tok = formatNoteToken(note);
      const lyr = lyricByOffset.get(note.offsetTick);
      const lyrText = lyr ? lyr.text : '';
      if (lyrText) hasLyrics = true;

      const colWidth = Math.max(tok.length, lyrText.length) + 1;
      tabLine += tok.padEnd(colWidth, ' ');
      lyricLine += lyrText.padEnd(colWidth, ' ');
    }

    // Append any lyrics whose offsets didn't match a note directly
    for (const l of sortedLyrics) {
      const matched = sortedNotes.some((n) => n.offsetTick === l.offsetTick);
      if (!matched && l.text.trim()) {
        hasLyrics = true;
        lyricLine += `${l.text} `;
      }
    }

    out.push(tabLine.trimEnd());
    if (hasLyrics) {
      out.push(lyricLine.trimEnd());
    }
  }

  return out.join('\n').trimEnd() + '\n';
}
