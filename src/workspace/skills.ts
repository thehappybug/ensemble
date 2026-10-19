import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafePath } from './paths.js';

const destinations = ['.agents/skills/ensemble/SKILL.md', '.claude/skills/ensemble/SKILL.md'];

async function readIfPresent(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function readTemplate(): Promise<string> {
  // Source module: src/workspace/skills.ts. Bundled module: dist/cli.js.
  for (const relative of ['../../templates/ensemble/SKILL.md', '../templates/ensemble/SKILL.md']) {
    const content = await readIfPresent(fileURLToPath(new URL(relative, import.meta.url)));
    if (content !== undefined) return content;
  }
  throw new Error('Ensemble authoring skill template is missing from the installation');
}

/** Install discoverable copies once. Existing custom skills are user-owned. */
export async function installWorkspaceSkill(root: string): Promise<string[]> {
  root = path.resolve(root);
  for (const destination of destinations) assertSafePath(root, destination);
  const existing = await Promise.all(destinations.map(destination => readIfPresent(path.join(root, destination))));
  // If one copy is already customized, seed its missing companion identically.
  const content = existing.find(value => value !== undefined) ?? await readTemplate();
  const written: string[] = [];
  for (const [index, destination] of destinations.entries()) {
    if (existing[index] !== undefined) continue;
    const file = path.join(root, destination);
    await mkdir(path.dirname(file), { recursive: true });
    assertSafePath(root, destination);
    let handle;
    try { handle = await open(file, 'wx', 0o644); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
    try { await handle.writeFile(content, 'utf8'); written.push(destination); }
    finally { await handle.close(); }
  }
  return written;
}
