import type { HarpKey, SongDocument, TimingMode } from '../schema/song.ts';

export interface SongSummary {
  id: string;
  title: string;
  artist?: string;
  harpKey: HarpKey;
  timingMode: TimingMode;
  revision: number;
  updatedAt: string;
}

export interface SongFilter {
  query?: string;
  harpKey?: HarpKey;
  timingMode?: TimingMode;
}

export interface RemoveSongOptions {
  /** When true, permanently removes the record instead of writing a soft-delete tombstone. */
  hard?: boolean;
}

/**
 * Storage-agnostic async repository contract.
 * v1 is backed by IndexedDB (`IndexedDbSongRepository`);
 * v2 can drop in a PostgreSQL JSONB REST/sync adapter without changing callers.
 */
export interface SongRepository {
  list(filter?: SongFilter): Promise<SongSummary[]>;
  get(id: string): Promise<SongDocument | null>;
  save(doc: SongDocument): Promise<SongDocument>;
  remove(id: string, options?: RemoveSongOptions): Promise<void>;
}

export function toSongSummary(doc: SongDocument): SongSummary {
  const summary: SongSummary = {
    id: doc.id,
    title: doc.title,
    harpKey: doc.instrument.harpKey,
    timingMode: doc.timingMode,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
  };
  if (doc.artist !== undefined) {
    summary.artist = doc.artist;
  }
  return summary;
}
