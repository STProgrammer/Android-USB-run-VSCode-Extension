import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { envValue, expandPath, findOnPath, isFile, readOptional, uniquePaths } from './files';
import { RunnerSettings, UserError } from './types';

export interface AndroidTools { adb: string; sdkRoots: string[]; }

export function localSdkPath(properties: string): string | undefined {
  const value = properties.match(/^\s*sdk\.dir\s*[=:]\s*(.+)$/m)?.[1]?.trim();
  return value?.replace(/\\u([\da-fA-F]{4})|\\(.)/g, (_match, hex: string | undefined, char: string) => hex ? String.fromCharCode(parseInt(hex, 16)) : char);
}

export async function discoverAndroidTools(settings: RunnerSettings, projectRoot?: string, env = process.env): Promise<AndroidTools> {
  const configuredSdk = expandPath(settings.androidSdkPath, env);
  if (configuredSdk && !path.isAbsolute(configuredSdk)) { throw new UserError('androidUsbRunner.androidSdkPath must be an absolute Android SDK directory path.'); }
  const automaticRoots = [envValue(env, 'ANDROID_SDK_ROOT'), envValue(env, 'ANDROID_HOME'),
    envValue(env, 'LOCALAPPDATA') ? path.join(envValue(env, 'LOCALAPPDATA')!, 'Android', 'Sdk') : undefined]
    .filter((value): value is string => Boolean(value)).map(value => expandPath(value, env));
  const localSdk = projectRoot ? localSdkPath(await readOptional(path.join(projectRoot, 'local.properties'))) : undefined;
  const roots = uniquePaths([configuredSdk, ...automaticRoots, localSdk].filter((value): value is string => Boolean(value)));
  let adb: string | undefined;
  if (settings.adbPath.trim()) {
    adb = expandPath(settings.adbPath, env);
    if (!path.isAbsolute(adb) || !await isFile(adb) || path.basename(adb).toLowerCase() !== 'adb.exe') {
      throw new UserError('androidUsbRunner.adbPath must point to an existing adb.exe using an absolute path.');
    }
  } else {
    // Explicit SDK is a manual override; otherwise preserve SDK_ROOT, HOME, standard location, PATH order.
    if (configuredSdk) {
      adb = path.join(configuredSdk, 'platform-tools', 'adb.exe');
      if (!path.isAbsolute(configuredSdk) || !await isFile(adb)) { throw new UserError('androidUsbRunner.androidSdkPath does not contain platform-tools\\adb.exe. Install Android SDK Platform-Tools or correct the setting.'); }
    } else {
      for (const root of automaticRoots) {
        const candidate = path.join(root, 'platform-tools', 'adb.exe');
        if (await isFile(candidate)) { adb = candidate; break; }
      }
      adb ??= await findOnPath('adb.exe', env);
      if (!adb && localSdk && await isFile(path.join(localSdk, 'platform-tools', 'adb.exe'))) { adb = path.join(localSdk, 'platform-tools', 'adb.exe'); }
    }
  }
  if (!adb) { throw new UserError('Android SDK / adb.exe was not found. Install Android SDK Platform-Tools, or set androidUsbRunner.androidSdkPath or androidUsbRunner.adbPath.'); }
  if (path.basename(path.dirname(adb)).toLowerCase() === 'platform-tools') { roots.unshift(path.dirname(path.dirname(adb))); }
  if (configuredSdk) { roots.unshift(configuredSdk); }
  return { adb: path.resolve(adb), sdkRoots: uniquePaths(roots) };
}

export function compareVersions(a: string, b: string): number {
  const aa = a.match(/\d+/g)?.map(Number) ?? [];
  const bb = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < 3; i++) { const difference = (aa[i] ?? 0) - (bb[i] ?? 0); if (difference) { return difference; } }
  const aPreview = /[a-z]/i.test(a);
  const bPreview = /[a-z]/i.test(b);
  if (aPreview !== bPreview) { return aPreview ? -1 : 1; }
  return (aa[3] ?? 0) - (bb[3] ?? 0) || a.localeCompare(b);
}

export async function findAapt2(roots: string[]): Promise<string> {
  // Respect SDK precedence, then select the newest installed version within that SDK.
  for (const root of roots) {
    const buildTools = path.join(root, 'build-tools');
    let versions: string[];
    try { versions = (await fs.readdir(buildTools, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
    catch { continue; }
    for (const version of versions.sort((a, b) => compareVersions(b, a))) {
      const file = path.join(buildTools, version, 'aapt2.exe');
      if (await isFile(file)) { return file; }
    }
  }
  throw new UserError('aapt2.exe was not found in Android SDK Build Tools. Install Build Tools with Android Studio SDK Manager, or set androidUsbRunner.androidSdkPath.');
}
