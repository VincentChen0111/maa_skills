import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Dependency and Git internals are never publication inputs.
export async function repositoryFiles(root: string): Promise<string[]> {
  const top = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status === 0 && await realpath(top.stdout.trim()) === await realpath(root)) {
    const result = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('file-inventory');
    const files: string[] = [];
    for (const file of new Set(result.stdout.split('\0').filter(Boolean))) {
      try {
        const stat = await lstat(join(root, file));
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('non-regular-file');
        files.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return files.sort();
  }
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('symbolic-link');
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  await visit('');
  return files.sort();
}
