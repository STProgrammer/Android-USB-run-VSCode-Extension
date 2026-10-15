import * as path from 'node:path';
import { ApkFile } from './apks';
import { CommandRunner, combined } from './process';
import { UserError } from './types';

export interface ApkInfo extends ApkFile {
  packageName: string;
  activity?: string;
  split?: string;
  versionCode?: string;
  nativeAbis: string[];
  testOnly: boolean;
}

export function validPackage(value: string): boolean { return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(value); }
export function validActivity(value: string): boolean { return /^\.?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value); }

export function parseBadging(output: string): Omit<ApkInfo, keyof ApkFile> {
  const packageLine = output.match(/^package:\s*(.+)$/m)?.[1] ?? '';
  const packageName = packageLine.match(/\bname='([^']+)'/)?.[1];
  if (!packageName || !validPackage(packageName)) { throw new UserError('aapt2 could not determine a valid application ID from the built APK. See Android USB Runner output.'); }
  const activity = output.match(/^launchable-activity:\s*name='([^']+)'/m)?.[1];
  return {
    packageName, activity: activity && validActivity(activity) ? activity : undefined,
    split: packageLine.match(/\bsplit='([^']+)'/)?.[1],
    versionCode: packageLine.match(/\bversionCode='([^']+)'/)?.[1],
    nativeAbis: [...(output.match(/^native-code:\s*(.+)$/m)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(match => match[1]!),
    testOnly: /^application:\s.*\btestOnly='true'/m.test(output) || /^testOnly(?:=|:|\s|$)/m.test(output)
  };
}

export async function inspectApk(aapt: string, apk: ApkFile, runner: CommandRunner, signal?: AbortSignal): Promise<ApkInfo> {
  const result = await runner.run(aapt, ['dump', 'badging', apk.file], { signal, timeoutMs: 30000 });
  if (result.code !== 0) { throw new UserError(`aapt2 could not inspect ${path.basename(apk.file)}. ${combined(result).trim().slice(-500)}`); }
  return { ...apk, ...parseBadging(result.stdout) };
}

export interface InstallPlan { apks: ApkInfo[]; base: ApkInfo; }

export function chooseInstallPlans(infos: ApkInfo[], deviceAbis: string[]): InstallPlan[] {
  const bases = infos.filter(info => !info.split);
  const splits = infos.filter(info => info.split);
  if (!bases.length) { throw new UserError('Only split APKs were found; the base APK is missing. Build a complete debug APK set.'); }
  if (splits.length) {
    if (bases.length !== 1 || infos.some(info => info.packageName !== bases[0]!.packageName || info.versionCode !== bases[0]!.versionCode)) {
      throw new UserError('APK outputs contain mixed applications or versions. Clean the selected module and rebuild before installing splits.');
    }
    // True splits share a base. Select one compatible ABI, retaining resource/feature splits.
    const abiFor = (info: ApkInfo) => info.filters.find(filter => filter.type.toUpperCase() === 'ABI')?.value ?? (info.nativeAbis.length === 1 ? info.nativeAbis[0] : undefined);
    const abiSplits = splits.filter(info => abiFor(info));
    const preferredAbi = deviceAbis.find(abi => abiSplits.some(info => abiFor(info) === abi));
    if (abiSplits.length && !preferredAbi) { throw new UserError('No split APK matches the connected phone’s CPU ABI. Build a compatible or universal APK.'); }
    return [{ base: bases[0]!, apks: [bases[0]!, ...splits.filter(info => !abiFor(info) || abiFor(info) === preferredAbi)] }];
  }
  // Gradle ABI/density outputs are often standalone APKs, NOT install-multiple sets.
  const compatible = bases.filter(info => {
    const filter = info.filters.find(value => value.type.toUpperCase() === 'ABI');
    const abis = filter ? [filter.value] : info.nativeAbis;
    return !abis.length || !deviceAbis.length || abis.some(abi => deviceAbis.includes(abi));
  });
  if (!compatible.length) { throw new UserError('No APK matches the connected phone’s CPU ABI. Build a compatible or universal APK.'); }
  if (compatible.length === 1) { return [{ base: compatible[0]!, apks: [compatible[0]!] }]; }
  const universal = compatible.filter(info => !info.filters.length && (!info.nativeAbis.length || info.nativeAbis.length > 1 || /universal/i.test(path.basename(info.file))));
  if (universal.length === 1) { return [{ base: universal[0]!, apks: [universal[0]!] }]; }
  for (const abi of deviceAbis) {
    const matching = compatible.filter(info => info.filters.some(filter => filter.type.toUpperCase() === 'ABI' && filter.value === abi) || (info.nativeAbis.length === 1 && info.nativeAbis[0] === abi));
    if (matching.length === 1) { return [{ base: matching[0]!, apks: [matching[0]!] }]; }
    if (matching.length > 1) { return matching.map(base => ({ base, apks: [base] })); }
  }
  return compatible.map(base => ({ base, apks: [base] }));
}
