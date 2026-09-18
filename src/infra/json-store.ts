import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';
import {
  experimentsFileSchema,
  opportunitiesFileSchema,
  rankHistoryEntrySchema,
  rankHistorySchema,
  siteUnderstandingSchema,
} from '../core/schemas.js';
import type {
  Experiment,
  Opportunity,
  RankHistory,
  RankHistoryEntry,
  SiteUnderstanding,
} from '../core/types.js';

export class JsonStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'JsonStoreError';
  }
}

export async function readJsonFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new JsonStoreError(`failed to read ${path}: ${(err as Error).message}`, 'READ_FAILED');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new JsonStoreError(`invalid JSON in ${path}: ${(err as Error).message}`, 'INVALID_JSON');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new JsonStoreError(
      `schema validation failed for ${path}: ${result.error.message}`,
      'SCHEMA_INVALID',
    );
  }
  return result.data;
}

export async function readJsonFileOrDefault<T>(path: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  try {
    return await readJsonFile(path, schema);
  } catch (err) {
    if (err instanceof JsonStoreError && err.code === 'READ_FAILED') return fallback;
    throw err;
  }
}

/** Writes JSON atomically: write to a temp file in the same directory, then rename. */
export async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tmpPath, content, 'utf8');
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// --- site-understanding.json (rewritten each `understand`, not append-only) ---

export function loadSiteUnderstanding(path: string): Promise<SiteUnderstanding> {
  return readJsonFile(path, siteUnderstandingSchema) as Promise<SiteUnderstanding>;
}

export function saveSiteUnderstanding(path: string, doc: SiteUnderstanding): Promise<void> {
  return writeJsonFileAtomic(path, doc);
}

// --- rank-history.json (append-only, DESIGN.md 7.4) ---

const EMPTY_RANK_HISTORY: RankHistory = { schemaVersion: 2, entries: [] };

export function loadRankHistory(path: string): Promise<RankHistory> {
  return readJsonFileOrDefault(path, rankHistorySchema, EMPTY_RANK_HISTORY) as Promise<RankHistory>;
}

/**
 * The only write API for rank-history.json. Enforces append-only semantics:
 * rejects a duplicate (date, source) pair and never mutates existing entries.
 */
export async function appendRankHistory(path: string, entry: RankHistoryEntry): Promise<RankHistory> {
  const parsedEntry = rankHistoryEntrySchema.parse(entry);
  const history = await loadRankHistory(path);
  const duplicate = history.entries.some(
    (e) => e.date === parsedEntry.date && e.source === parsedEntry.source,
  );
  if (duplicate) {
    throw new JsonStoreError(
      `duplicate rank-history entry for date=${parsedEntry.date} source=${parsedEntry.source}`,
      'DUPLICATE_ENTRY',
    );
  }
  const next: RankHistory = {
    schemaVersion: 2,
    entries: [...history.entries, parsedEntry],
  };
  await writeJsonFileAtomic(path, next);
  return next;
}

// --- opportunities.json ---

const EMPTY_OPPORTUNITIES: { schemaVersion: 2; opportunities: Opportunity[] } = {
  schemaVersion: 2,
  opportunities: [],
};

export async function loadOpportunities(path: string): Promise<Opportunity[]> {
  const doc = await readJsonFileOrDefault(path, opportunitiesFileSchema, EMPTY_OPPORTUNITIES);
  return doc.opportunities as Opportunity[];
}

export async function saveOpportunities(path: string, opportunities: Opportunity[]): Promise<void> {
  await writeJsonFileAtomic(path, { schemaVersion: 2, opportunities });
}

// --- experiments.json ---

const EMPTY_EXPERIMENTS: { schemaVersion: 2; experiments: Experiment[] } = {
  schemaVersion: 2,
  experiments: [],
};

export async function loadExperiments(path: string): Promise<Experiment[]> {
  const doc = await readJsonFileOrDefault(path, experimentsFileSchema, EMPTY_EXPERIMENTS);
  return doc.experiments as Experiment[];
}

export async function saveExperiments(path: string, experiments: Experiment[]): Promise<void> {
  await writeJsonFileAtomic(path, { schemaVersion: 2, experiments });
}
