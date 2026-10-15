import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { CancelledError, checkCancelled, Logger, UserError } from './types';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  windowsVerbatimArguments?: boolean;
}

export interface ProcessResult { code: number; stdout: string; stderr: string; }
export interface CommandRunner {
  run(file: string, args: string[], options?: RunOptions): Promise<ProcessResult>;
}

export class ProcessRunner implements CommandRunner {
  private readonly children = new Set<ChildProcess>();
  private disposed = false;
  constructor(private readonly log: Logger) {}

  run(file: string, args: string[], options: RunOptions = {}): Promise<ProcessResult> {
    checkCancelled(options.signal);
    if (this.disposed) { return Promise.reject(new CancelledError()); }
    this.log.line(`> ${[file, ...args].map(value => JSON.stringify(value)).join(' ')}`);
    if (options.cwd) { this.log.line(`  cwd: ${options.cwd}`); }
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd: options.cwd, env: options.env ?? process.env,
        shell: false, windowsHide: true, windowsVerbatimArguments: options.windowsVerbatimArguments,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.children.add(child);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const captureLimit = 4 * 1024 * 1024;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-captureLimit); this.log.append(chunk); });
      child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-captureLimit); this.log.append(chunk); });
      const cancel = () => this.stop(child);
      const cleanup = () => {
        this.children.delete(child);
        if (timer) { clearTimeout(timer); }
        options.signal?.removeEventListener('abort', cancel);
      };
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) { cancel(); }
      if (options.timeoutMs) {
        timer = setTimeout(() => { timedOut = true; this.stop(child); }, options.timeoutMs);
      }
      child.on('error', error => {
        cleanup();
        reject(new UserError(`Could not execute ${path.basename(file)}: ${error.message}`));
      });
      child.on('close', code => {
        cleanup();
        this.log.line(`\n[exit ${code ?? 'terminated'}]`);
        if (options.signal?.aborted || this.disposed) { reject(new CancelledError()); }
        else if (timedOut) { reject(new UserError(`${path.basename(file)} timed out. See Android USB Runner output.`)); }
        else { resolve({ code: code ?? -1, stdout, stderr }); }
      });
    });
  }

  private stop(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) { return; }
    if (process.platform === 'win32') {
      // Kill only this launched process tree; never kill all Java or ADB processes.
      const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      const killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => child.kill());
      killer.once('exit', code => { if (code !== 0) { child.kill(); } });
    } else { child.kill('SIGTERM'); }
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.children) { this.stop(child); }
  }
}

export function combined(result: ProcessResult): string { return `${result.stdout}\n${result.stderr}`; }
