import { readFile } from 'node:fs/promises';
import { serpInspectionSchema } from '../core/schemas.js';
import type { SearchAdapter, SerpInspection } from '../core/types.js';

export class SearchAdapterError extends Error {
  constructor(
    message: string,
    readonly code: 'SERP_FIXTURE_MISSING' | 'SERP_FILE_INVALID',
  ) {
    super(message);
    this.name = 'SearchAdapterError';
  }
}

/**
 * v1 does not call any web-search tool directly from Node. In a real run,
 * the coding agent running the Skill performs WebSearch itself and hands
 * the resulting structured JSON to the CLI via --serp-file (see FileSearchAdapter).
 */
export class FixtureSearchAdapter implements SearchAdapter {
  constructor(private readonly fixtures: Record<string, SerpInspection>) {}

  async inspectSerp(input: { keyword: string; targetUrl: string; topN: number }): Promise<SerpInspection> {
    const found = this.fixtures[input.keyword];
    if (!found) {
      throw new SearchAdapterError(`no fixture SERP for keyword: ${input.keyword}`, 'SERP_FIXTURE_MISSING');
    }
    return { ...found, results: found.results.slice(0, input.topN) };
  }
}

export async function loadSerpFromFile(path: string): Promise<SerpInspection> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new SearchAdapterError(`failed to read SERP file ${path}: ${(err as Error).message}`, 'SERP_FILE_INVALID');
  }
  const parsed = serpInspectionSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new SearchAdapterError(`invalid SERP file ${path}: ${parsed.error.message}`, 'SERP_FILE_INVALID');
  }
  return parsed.data;
}

/** Backs the `--serp-file` CLI option. */
export class FileSearchAdapter implements SearchAdapter {
  constructor(private readonly filePath: string) {}

  async inspectSerp(input: { keyword: string; targetUrl: string; topN: number }): Promise<SerpInspection> {
    const serp = await loadSerpFromFile(this.filePath);
    return { ...serp, results: serp.results.slice(0, input.topN) };
  }
}
