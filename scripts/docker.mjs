import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const candidates =
  process.platform === 'win32'
    ? [
        join(
          homedir(),
          'AppData',
          'Local',
          'Programs',
          'DockerDesktop',
          'resources',
          'bin',
          'docker.exe',
        ),
        'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
      ]
    : [];
const executable = candidates.find(existsSync) ?? 'docker';
const env = { ...process.env };
if (executable !== 'docker') {
  // Remove case variants: Windows treats PATH/Path as one environment variable.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${dirname(executable)};${process.env.PATH ?? process.env.Path ?? ''}`;
}
const result = spawnSync(executable, process.argv.slice(2), {
  env,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error)
  console.error('Docker could not start. Install/start Docker Desktop, then try again.');
process.exitCode = result.status ?? 1;
