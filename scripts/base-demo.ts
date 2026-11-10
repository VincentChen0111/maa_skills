import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture } from './eval-fixture.ts';
import { baseInputs } from '../eval/maa-account/base-scenarios.ts';

// Development-only demonstration. All settings, snapshots and game tables are synthetic.
const fixture = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)),
  companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: baseInputs });
try {
  const result = spawnSync(process.execPath, [join(fixture.workspace, '.agents/skills/maa-core/scripts/base-query.ts'), 'query'], {
    cwd: fixture.workspace, env: fixture.env, input: JSON.stringify({ operators: ['合成干员'], tablesFile: 'tables.json', format: 'markdown' }), encoding: 'utf8',
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status ?? 1;
} finally { await fixture.dispose(); }
