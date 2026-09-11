import { exec } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { SiteAdapter } from '../core/types.js';

const execAsync = promisify(exec);

/**
 * Resolves a watchword targetPath (e.g. "/example/") to a Markdown source
 * file under contentRoot. YAGNI per DESIGN.md section 15: no pathMap/resolver
 * hook in v1, just a fixed Markdown-source convention.
 */
export function resolveContentFile(contentRoot: string, targetPath: string): string {
  const rel = targetPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const name = rel.length === 0 ? 'index' : rel;
  return join(contentRoot, `${name}.md`);
}

/**
 * v1-required fixture adapter: reads/writes Markdown files under an isolated
 * root directory, never touching the real site. `forceValidationFailure` lets
 * tests exercise the "validation fails -> no state progression" transaction path.
 */
export class FixtureSiteAdapter implements SiteAdapter {
  constructor(
    private readonly rootDir: string,
    private readonly options: { forceValidationFailure?: boolean } = {},
  ) {}

  async readPage(targetPath: string): Promise<{ path: string; content: string }> {
    const file = resolveContentFile(this.rootDir, targetPath);
    const content = await readFile(file, 'utf8');
    return { path: targetPath, content };
  }

  async apply(input: Parameters<SiteAdapter['apply']>[0]): ReturnType<SiteAdapter['apply']> {
    const file = resolveContentFile(this.rootDir, input.targetPath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, input.newText, 'utf8');
    return { changedFiles: [file], summary: `updated ${input.targetPath}` };
  }

  async validate(): ReturnType<SiteAdapter['validate']> {
    if (this.options.forceValidationFailure) {
      return { ok: false, output: 'fixture validate: forced failure' };
    }
    return { ok: true, output: 'fixture validate: ok' };
  }
}

export type FilesystemSiteAdapterConfig = {
  repoRoot: string;
  contentRoot: string;
  buildCommand: string;
  testCommand: string;
};

/**
 * Generic real-site adapter for a Markdown-source repository. Runs the
 * configured build/test commands to validate a change (DESIGN.md section 15).
 */
export class FilesystemSiteAdapter implements SiteAdapter {
  constructor(private readonly config: FilesystemSiteAdapterConfig) {}

  private resolve(targetPath: string): string {
    return resolveContentFile(join(this.config.repoRoot, this.config.contentRoot), targetPath);
  }

  async readPage(targetPath: string): Promise<{ path: string; content: string }> {
    const file = this.resolve(targetPath);
    const content = await readFile(file, 'utf8');
    return { path: targetPath, content };
  }

  async apply(input: Parameters<SiteAdapter['apply']>[0]): ReturnType<SiteAdapter['apply']> {
    const file = this.resolve(input.targetPath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, input.newText, 'utf8');
    return { changedFiles: [file], summary: `updated ${input.targetPath}` };
  }

  async validate(): ReturnType<SiteAdapter['validate']> {
    const outputs: string[] = [];
    for (const command of [this.config.buildCommand, this.config.testCommand]) {
      try {
        const { stdout, stderr } = await execAsync(command, { cwd: this.config.repoRoot });
        outputs.push(`$ ${command}\n${stdout}${stderr}`);
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        outputs.push(`$ ${command}\n${e.stdout ?? ''}${e.stderr ?? ''}${e.message}`);
        return { ok: false, output: outputs.join('\n\n') };
      }
    }
    return { ok: true, output: outputs.join('\n\n') };
  }
}
