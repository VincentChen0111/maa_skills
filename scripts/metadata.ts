import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { repositoryFiles } from './files.ts';
import { directoryReader, inspectManifestVersions } from './release-check.ts';

export async function inspectMetadata(root: string): Promise<string[]> {
  const errors: string[] = [];
  for (const file of (await repositoryFiles(root)).filter((name) => name.endsWith('.md'))) {
    const text = await readFile(join(root, file), 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = match[1]!.split('#')[0]!;
      if (!target || /^https?:\/\//.test(target)) continue;
      const path = resolve(root, dirname(file), decodeURIComponent(target));
      const inside = relative(root, path);
      try {
        if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('outside');
        await access(path);
      } catch { errors.push(`${file}: broken-link`); }
    }
  }
  // Version consistency has one owner (scripts/release-check.ts); this runs its manifest part. The same gate also checks the
  // changelog and release-notes version and status (tests/release-check.test.ts, without --release); only the notes' two MAA
  // lines wait for --release and the tag check, so a version-record PR from ticket 25's Action never fails on an old release.
  errors.push(...(await inspectManifestVersions(directoryReader(root))).errors);
  try {
    const json = async (path: string) => JSON.parse(await readFile(join(root, path), 'utf8'));
    const plugin = await json('.claude-plugin/plugin.json');
    const market = await json('.claude-plugin/marketplace.json');
    if (typeof plugin.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(plugin.name)) errors.push('plugin: invalid-name');
    if (!market.name || !market.owner?.name || !Array.isArray(market.plugins)
      || market.plugins.length !== 1 || market.plugins[0].name !== plugin.name || market.plugins[0].source !== './') errors.push('marketplace: invalid-entry');
  } catch { errors.push('manifest: invalid-or-missing'); }
  return errors;
}
