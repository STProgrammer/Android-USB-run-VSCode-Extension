import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { checkCancelled } from './types';

export const ignoredDirectories = new Set(['.git', '.gradle', 'build', 'node_modules', '.idea', '.vscode', '.cxx', '.dart_tool', 'dist', 'out-test', '.vscode-test']);

export async function isFile(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

export async function readOptional(file: string): Promise<string> {
  try { return await fs.readFile(file, 'utf8'); } catch { return ''; }
}

// Do not follow junctions/symlinks: workspaces can contain cycles and external trees.
export async function* walk(root: string, options: {
  ignore?: Set<string>; signal?: AbortSignal; stopAtNestedWrapper?: boolean;
} = {}): AsyncGenerator<string> {
  const pending = [root];
  while (pending.length) {
    checkCancelled(options.signal);
    const directory = pending.pop()!;
    if (options.stopAtNestedWrapper && directory !== root && await isFile(path.join(directory, 'gradlew.bat'))) { continue; }
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (directory === root) { throw error; }
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) { continue; }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && !options.ignore?.has(entry.name.toLowerCase())) { pending.push(full); }
      else if (entry.isFile()) { yield full; }
    }
  }
}

export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter(value => {
    const key = path.resolve(value).toLowerCase();
    if (seen.has(key)) { return false; }
    seen.add(key);
    return true;
  });
}

export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(value => value.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

export function setEnv(env: NodeJS.ProcessEnv, name: string, value?: string): void {
  for (const key of Object.keys(env)) { if (key.toLowerCase() === name.toLowerCase()) { delete env[key]; } }
  if (value !== undefined) { env[name] = value; }
}

export function expandPath(value: string, env = process.env): string {
  return value.trim().replace(/^"(.*)"$/, '$1').replace(/%([^%]+)%/g, (match, name: string) => envValue(env, name) ?? match);
}

export async function findOnPath(executable: string, env = process.env): Promise<string | undefined> {
  for (const entry of (envValue(env, 'PATH') ?? '').split(path.delimiter)) {
    if (!entry.trim()) { continue; }
    const candidate = path.join(expandPath(entry, env), executable);
    if (await isFile(candidate)) { return path.resolve(candidate); }
  }
  return undefined;
}
