import { exec } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { NaturalWriterAdapter } from '../core/types.js';

const execAsync = promisify(exec);

type TransformInput = Parameters<NaturalWriterAdapter['transform']>[0];
type TransformOutput = Awaited<ReturnType<NaturalWriterAdapter['transform']>>;

/**
 * Deterministic placeholder for B while it does not exist yet. Concatenates
 * the required facts/changes without natural-language rewriting, so the
 * fixture E2E can complete end to end. See DESIGN.md section 14.
 */
export class StubNaturalWriterAdapter implements NaturalWriterAdapter {
  async transform(input: TransformInput): Promise<TransformOutput> {
    const sections = [
      input.existingText?.trim(),
      input.requiredFacts.length > 0 ? input.requiredFacts.join('\n') : undefined,
      input.requiredChanges.length > 0 ? input.requiredChanges.join('\n') : undefined,
    ].filter((s): s is string => Boolean(s && s.length > 0));

    const warnings: string[] = [];
    if (input.forbiddenChanges.length > 0) {
      warnings.push(
        `stub writer does not verify avoidance of forbidden changes: ${input.forbiddenChanges.join(', ')}`,
      );
    }

    return {
      text: sections.join('\n\n'),
      preservedFacts: [...input.requiredFacts],
      warnings,
    };
  }
}

export class NaturalWriterAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NaturalWriterAdapterError';
  }
}

/**
 * Skeleton adapter for a real B CLI, per the contract in DESIGN.md section 14:
 *   writer-command --input tmp/request.json --output tmp/response.json
 */
export class CliNaturalWriterAdapter implements NaturalWriterAdapter {
  constructor(
    private readonly command: string,
    private readonly tmpDir: string,
  ) {}

  async transform(input: TransformInput): Promise<TransformOutput> {
    await mkdir(this.tmpDir, { recursive: true });
    const stamp = Date.now();
    const requestPath = `${this.tmpDir}/writer-request-${stamp}.json`;
    const responsePath = `${this.tmpDir}/writer-response-${stamp}.json`;

    await writeFile(requestPath, JSON.stringify(input, null, 2), 'utf8');
    await execAsync(`${this.command} --input ${requestPath} --output ${responsePath}`);

    let raw: string;
    try {
      raw = await readFile(responsePath, 'utf8');
    } catch (err) {
      throw new NaturalWriterAdapterError(`writer CLI did not produce ${responsePath}: ${(err as Error).message}`);
    }
    const parsed = JSON.parse(raw) as Partial<TransformOutput>;
    if (typeof parsed.text !== 'string') {
      throw new NaturalWriterAdapterError('writer CLI response missing "text"');
    }
    return {
      text: parsed.text,
      preservedFacts: Array.isArray(parsed.preservedFacts) ? parsed.preservedFacts : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    };
  }
}
