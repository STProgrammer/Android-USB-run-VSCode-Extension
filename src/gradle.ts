import * as path from 'node:path';
import { AppModule, AndroidProject, Logger, UserError, checkCancelled } from './types';
import { envValue, expandPath, findOnPath, isFile, setEnv } from './files';
import { CommandRunner, combined } from './process';

export function resolveGradleTask(module: AppModule, configured: string): { task: string; variant: string } {
  const input = configured.trim() || 'assembleDebug';
  if (!/^:?[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(input)) {
    throw new UserError('androidUsbRunner.gradleTask must be one assemble task, without spaces, flags, or shell characters.');
  }
  const prefix = module.name === ':' ? ':' : `${module.name}:`;
  const task = input.includes(':') ? (input.startsWith(':') ? input : `:${input}`) : `${prefix}${input}`;
  if (!task.startsWith(prefix) || task.slice(prefix.length).includes(':')) {
    throw new UserError(`The configured Gradle task must belong to the selected module ${module.name}. Use Select App Module or change androidUsbRunner.gradleTask.`);
  }
  const suffix = task.slice(prefix.length).match(/^assemble([A-Z][A-Za-z0-9_]*)$/)?.[1];
  if (!suffix || /AndroidTest|UnitTest/.test(suffix)) { throw new UserError('androidUsbRunner.gradleTask must assemble an application APK, for example assembleDebug or assembleDemoDebug.'); }
  return { task, variant: suffix[0]!.toLowerCase() + suffix.slice(1) };
}

export async function javaEnvironment(configured: string, runner: CommandRunner, log: Logger, signal?: AbortSignal, inherited = process.env): Promise<NodeJS.ProcessEnv> {
  const env = { ...inherited };
  const usable = async (home: string) => {
    const java = path.join(home, 'bin', 'java.exe');
    if (!await isFile(java)) { return false; }
    try { return (await runner.run(java, ['-version'], { env, signal, timeoutMs: 15000 })).code === 0; }
    catch { checkCancelled(signal); return false; }
  };
  if (configured.trim()) {
    const home = expandPath(configured, inherited);
    if (!path.isAbsolute(home) || !await usable(home)) { throw new UserError('androidUsbRunner.javaHome must point to a usable JDK/JBR directory containing bin\\java.exe.'); }
    setEnv(env, 'JAVA_HOME', home);
    return env;
  }
  const current = envValue(inherited, 'JAVA_HOME');
  if (current && await usable(expandPath(current, inherited))) {
    // Normalize optional quotes without replacing a working Java installation.
    setEnv(env, 'JAVA_HOME', expandPath(current, inherited));
    return env;
  }
  if (current) { log.line(`JAVA_HOME is unusable: ${current}. Looking for Java on PATH or Android Studio JBR.`); setEnv(env, 'JAVA_HOME'); }
  const fromPath = await findOnPath('java.exe', inherited);
  if (fromPath) {
    try { if ((await runner.run(fromPath, ['-version'], { env, signal, timeoutMs: 15000 })).code === 0) { return env; } }
    catch { checkCancelled(signal); }
  }
  const jbr = path.join(envValue(inherited, 'ProgramFiles') ?? 'C:\\Program Files', 'Android', 'Android Studio', 'jbr');
  if (await usable(jbr)) { setEnv(env, 'JAVA_HOME', jbr); log.line(`Using Android Studio Java: ${jbr}`); return env; }
  throw new UserError('No usable Java installation was found. Set androidUsbRunner.javaHome to a JDK/JBR directory, or install Android Studio with its bundled JBR.');
}

export function wrapperInvocation(project: AndroidProject, task: string, inherited: NodeJS.ProcessEnv): { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string } {
  if (!path.isAbsolute(project.wrapper) || /["\r\n]/.test(project.wrapper)) { throw new UserError('Gradle Wrapper must have a valid absolute Windows path.'); }
  if (!/^:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/.test(task)) { throw new UserError('Invalid Gradle task.'); }
  const env = { ...inherited };
  // A single expansion avoids reinterpreting literal percent signs in the path.
  // /s strips only the outer quotes; the inner quotes protect spaces, &, and parentheses.
  setEnv(env, 'ANDROID_USB_RUNNER_GRADLEW', project.wrapper);
  return {
    file: path.join(envValue(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/v:off', '/c', `""%ANDROID_USB_RUNNER_GRADLEW%" ${task} --console=plain"`],
    env, cwd: path.dirname(project.wrapper)
  };
}

export async function buildProject(project: AndroidProject, task: string, env: NodeJS.ProcessEnv, runner: CommandRunner, log: Logger, signal?: AbortSignal): Promise<void> {
  const invocation = wrapperInvocation(project, task, env);
  log.line(`Gradle Wrapper: ${project.wrapper}`);
  const result = await runner.run(invocation.file, invocation.args, { cwd: invocation.cwd, env: invocation.env, signal, windowsVerbatimArguments: true });
  if (result.code !== 0) {
    const output = combined(result);
    const javaHint = /JAVA_HOME|java.*(?:not found|not recognized)|requires Java|Unsupported class file major version/i.test(output)
      ? ' Check androidUsbRunner.javaHome and the Java version required by your Gradle/Android Gradle Plugin.' : '';
    throw new UserError(`Android build failed. See Android USB Runner output.${javaHint}`);
  }
}
