import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
export async function docker(args: string[], input?: string, timeout = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Docker operation timed out'));
    }, timeout);
    child.stdout.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Docker unavailable'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Docker ${args[0]} failed (${code}). ${stderr.slice(-1200)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
