import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from 'lz-string';
import { SongDocumentSchema, type SongDocument } from '../schema/song.ts';

export const URL_HASH_PREFIX = '#tab=' as const;
export const MAX_SAFE_URL_HASH_CHARS = 8192 as const;

export interface EncodedSongHash {
  hash: string;
  encodedLength: number;
  exceedsSafeLimit: boolean;
}

export function serializeSongJson(doc: SongDocument): string {
  const validated = SongDocumentSchema.parse(doc);
  return JSON.stringify(validated, null, 2);
}

export function parseSongJson(raw: string): SongDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid song JSON: ${detail}`);
  }

  const result = SongDocumentSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid SongDocument schema: ${issues}`);
  }

  return result.data;
}

export function encodeSongToHash(doc: SongDocument): EncodedSongHash {
  const validated = SongDocumentSchema.parse(doc);
  const compactJson = JSON.stringify(validated);
  const compressed = compressToEncodedURIComponent(compactJson);
  const hash = `${URL_HASH_PREFIX}${compressed}`;
  const encodedLength = hash.length;
  return {
    hash,
    encodedLength,
    exceedsSafeLimit: encodedLength > MAX_SAFE_URL_HASH_CHARS,
  };
}

export function decodeSongFromHash(hash: string): SongDocument | null {
  const trimmed = hash.trim();
  if (!trimmed.startsWith(URL_HASH_PREFIX)) {
    return null;
  }

  const payload = trimmed.slice(URL_HASH_PREFIX.length);
  if (!payload) {
    throw new Error('Corrupted #tab= URL hash: payload is empty');
  }

  let decompressed: string | null;
  try {
    decompressed = decompressFromEncodedURIComponent(payload);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Corrupted #tab= URL hash: failed to decompress (${detail})`);
  }

  if (!decompressed || typeof decompressed !== 'string') {
    throw new Error('Corrupted #tab= URL hash: decompression produced empty output');
  }

  try {
    return parseSongJson(decompressed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Corrupted #tab= URL hash: ${detail}`);
  }
}
