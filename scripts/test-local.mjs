import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Windows shells do not expand globs; enumerate the same test files on both systems.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(new URL('../tests/', import.meta.url)).filter(file => file.endsWith('.test.ts')).sort().map(file => `tests/${file}`);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
