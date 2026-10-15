import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isFile, walk } from './files';
import { UserError, Logger } from './types';

export interface ApkFile { file: string; filters: { type: string; value: string }[]; }
export interface ApkGroup { id: string; variant: string; apks: ApkFile[]; applicationId?: string; changed: boolean; newest: number; }
export type OutputSnapshot = Map<string, string>;

async function fingerprint(file: string): Promise<string> {
  const stat = await fs.stat(file);
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

async function outputFiles(moduleDirectory: string, signal?: AbortSignal): Promise<string[]> {
  const root = path.join(moduleDirectory, 'build', 'outputs', 'apk');
  try { await fs.access(root); } catch { return []; }
  const files: string[] = [];
  for await (const file of walk(root, { signal })) {
    if (/\.apk$/i.test(file) || path.basename(file) === 'output-metadata.json') { files.push(file); }
  }
  return files;
}

export async function snapshotApks(moduleDirectory: string, signal?: AbortSignal): Promise<OutputSnapshot> {
  const snapshot: OutputSnapshot = new Map();
  for (const file of await outputFiles(moduleDirectory, signal)) { snapshot.set(file, await fingerprint(file)); }
  return snapshot;
}

export async function findApkGroups(moduleDirectory: string, variant: string, before: OutputSnapshot, log: Logger, signal?: AbortSignal): Promise<ApkGroup[]> {
  const root = path.join(moduleDirectory, 'build', 'outputs', 'apk');
  const files = await outputFiles(moduleDirectory, signal);
  const groups: ApkGroup[] = [];
  const claimed = new Set<string>();
  const matchesVariant = (candidate: string) => candidate.toLowerCase() === variant.toLowerCase()
    || (variant.toLowerCase() === 'debug' && /debug$/i.test(candidate));
  const makeGroup = async (id: string, name: string, apks: ApkFile[], applicationId?: string, metadata?: string) => {
    if (!apks.length || !matchesVariant(name) || /androidtest/i.test(name)) { return; }
    let changed = false;
    let newest = 0;
    for (const file of [...apks.map(apk => apk.file), ...(metadata ? [metadata] : [])]) {
      changed ||= before.get(file) !== await fingerprint(file);
      newest = Math.max(newest, (await fs.stat(file)).mtimeMs);
    }
    groups.push({ id, variant: name, apks, applicationId, changed, newest });
  };
  for (const metadataFile of files.filter(file => path.basename(file) === 'output-metadata.json')) {
    const directory = path.dirname(metadataFile);
    try {
      const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8')) as {
        variantName?: string; applicationId?: string;
        elements?: { outputFile?: string; filters?: { filterType?: string; value?: string; identifier?: string }[] }[];
      };
      if (!Array.isArray(metadata.elements)) { continue; }
      const apks: ApkFile[] = [];
      for (const element of metadata.elements) {
        if (typeof element.outputFile !== 'string') { continue; }
        const file = path.resolve(directory, element.outputFile);
        const relative = path.relative(directory, file);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !/\.apk$/i.test(file) || !await isFile(file)) { continue; }
        claimed.add(file);
        apks.push({ file, filters: (element.filters ?? []).map(filter => ({ type: filter.filterType ?? '', value: filter.value ?? filter.identifier ?? '' })) });
      }
      await makeGroup(metadataFile, metadata.variantName ?? path.relative(root, directory).split(path.sep).join(''), apks, metadata.applicationId, metadataFile);
    } catch (error) { log.line(`Could not read APK metadata ${metadataFile}: ${String(error)}. Inspecting APK files directly.`); }
  }
  const fallback = new Map<string, ApkFile[]>();
  for (const file of files.filter(file => /\.apk$/i.test(file) && !claimed.has(file))) {
    if (/androidtest/i.test(path.relative(root, file))) { continue; }
    const directory = path.dirname(file);
    const group = fallback.get(directory) ?? [];
    group.push({ file, filters: [] });
    fallback.set(directory, group);
  }
  for (const [directory, apks] of fallback) {
    await makeGroup(directory, path.relative(root, directory).split(path.sep).join(''), apks);
  }
  if (!groups.length) { throw new UserError(`No debug APK was found after the build (requested variant: ${variant}). Expected APK output under ${root}. Check the module and androidUsbRunner.gradleTask.`); }
  // Old outputs remain after flavor changes. Prefer outputs touched by this build;
  // retain existing outputs when Gradle legitimately reports UP-TO-DATE or FROM-CACHE.
  const fresh = groups.filter(group => group.changed);
  return (fresh.length ? fresh : groups).sort((a, b) => b.newest - a.newest || a.variant.localeCompare(b.variant));
}
