import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CommandRunner, ProcessResult, RunOptions } from '../src/process';
import { Logger, RunnerSettings } from '../src/types';

export const silent: Logger = { append: () => {}, line: () => {} };
export const defaults: RunnerSettings = { adbPath: '', androidSdkPath: '', javaHome: '', gradleTask: 'assembleDebug' };

export async function fixture(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), 'android-usb-runner-test-')); }

export async function cleanup(root: string): Promise<void> {
  const resolved = path.resolve(root);
  if (path.dirname(resolved).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(resolved).startsWith('android-usb-runner-test-')) {
    throw new Error(`Refusing to remove a non-fixture directory: ${resolved}`);
  }
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export async function write(root: string, relative: string, content = ''): Promise<string> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

export function result(stdout = '', code = 0, stderr = ''): ProcessResult { return { stdout, code, stderr }; }

export class FakeRunner implements CommandRunner {
  readonly calls: { file: string; args: string[]; options?: RunOptions }[] = [];
  constructor(private readonly reply: (file: string, args: string[], options?: RunOptions) => ProcessResult = () => result()) {}
  async run(file: string, args: string[], options?: RunOptions): Promise<ProcessResult> {
    this.calls.push({ file, args, options });
    return this.reply(file, args, options);
  }
}
