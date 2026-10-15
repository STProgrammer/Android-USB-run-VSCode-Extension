import { AdbClient, adbFailure } from './devices';
import { InstallPlan, validActivity, validPackage } from './aapt';
import { combined, ProcessResult } from './process';
import { Logger, UserError } from './types';

export async function installApks(adb: AdbClient, serial: string, plan: InstallPlan): Promise<void> {
  const args = [plan.apks.length > 1 ? 'install-multiple' : 'install', '-r'];
  if (plan.apks.some(apk => apk.testOnly)) { args.push('-t'); }
  args.push(...plan.apks.map(apk => apk.file));
  const result = await adb.device(serial, args, 180000);
  if (result.code !== 0 || !/^Success\s*$/m.test(result.stdout) || /Failure\s*\[/i.test(combined(result))) {
    throw new UserError(`APK installation failed. ${adbFailure(combined(result))}`);
  }
}

// adb shell reassembles its arguments on the remote side. Quote even validated
// component names because Java nested-class activity names can contain '$'.
function remoteQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

export function componentName(packageName: string, activity: string): string {
  if (!validPackage(packageName) || !validActivity(activity)) { throw new UserError('The APK contains an invalid Android package or launcher activity name.'); }
  const qualified = activity.startsWith('.') ? `${packageName}${activity}` : activity.includes('.') ? activity : `${packageName}.${activity}`;
  return `${packageName}/${qualified}`;
}

function launchSucceeded(result: ProcessResult): boolean {
  return result.code === 0 && !/(?:^|\n)\s*(?:Error(?:\s+type\s+\d+)?[:\s]|Exception|SecurityException)|unable to resolve|does not exist|permission denial/i.test(combined(result));
}

export async function launchApp(adb: AdbClient, serial: string, packageName: string, activity: string | undefined, log: Logger): Promise<void> {
  if (!validPackage(packageName)) { throw new UserError('Could not determine a safe, valid application ID for launch.'); }
  const start = (component: string) => adb.device(serial, ['shell', 'am', 'start', '-n', remoteQuote(component)]);
  if (activity) {
    if (launchSucceeded(await start(componentName(packageName, activity)))) { return; }
    log.line('Explicit launch failed; asking Android to resolve the installed launcher activity.');
  }
  const resolved = await adb.device(serial, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', remoteQuote(packageName)]);
  if (resolved.code === 0) {
    for (const line of resolved.stdout.split(/\r?\n/).reverse()) {
      const match = line.trim().match(/^([\w.]+)\/(\.?[\w.$]+)$/);
      if (match && match[1] === packageName && validActivity(match[2]!)) {
        if (launchSucceeded(await start(componentName(packageName, match[2]!)))) { return; }
        break;
      }
    }
  }
  log.line('Using the package-based Android launcher fallback.');
  const monkey = await adb.device(serial, ['shell', 'monkey', '-p', remoteQuote(packageName), '-c', 'android.intent.category.LAUNCHER', '1']);
  if (monkey.code !== 0 || !/Events injected:\s*1\b/.test(combined(monkey)) || /monkey aborted|no activities found|\*\*\s*(?:error|crash)/i.test(combined(monkey))) {
    throw new UserError(`App installed, but Android could not launch ${packageName}. Check that this variant declares a MAIN/LAUNCHER activity. ${adbFailure(combined(monkey))}`);
  }
}
