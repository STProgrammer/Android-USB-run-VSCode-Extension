import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { ProcessRunner } from '../src/process';
import { cleanup, fixture, write } from './helpers';

async function main(): Promise<void> {
  if (process.platform !== 'win32') { throw new Error('The Extension Development Host smoke test requires Windows.'); }
  const root = await fixture();
  const runner = new ProcessRunner({ append: value => process.stdout.write(value), line: value => process.stdout.write(`${value}\n`) });
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
    const project = path.join(root, 'workspace', 'nested', 'My Android App & Phone');
    const sdk = path.join(root, 'Android SDK');
    const javaHome = path.join(root, 'Java Home');
    const log = path.join(root, 'commands.log');
    const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const fakeExe = path.join(root, 'fake-tool.exe');
    const compiled = await runner.run(compiler, ['/nologo', '/target:exe', `/out:${fakeExe}`, path.join(extensionDevelopmentPath, 'test', 'fake-android-tools.cs')]);
    if (compiled.code !== 0) { throw new Error('Could not compile native Android tool fixtures.'); }
    for (const destination of [path.join(sdk, 'platform-tools', 'adb.exe'), path.join(sdk, 'build-tools', '36.0.0', 'aapt2.exe'), path.join(javaHome, 'bin', 'java.exe')]) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(fakeExe, destination);
    }
    await write(project, 'gradlew.bat', [
      '@echo off',
      'echo gradle^|%*>> "%ANDROID_USB_RUNNER_TEST_LOG%"',
      'cd >> "%ANDROID_USB_RUNNER_TEST_LOG%"',
      'if exist "%ANDROID_USB_RUNNER_TEST_LOG%.fail-build" exit /b 1',
      'echo built> "%~dp0app\\build\\outputs\\apk\\debug\\custom-debug.apk"',
      'echo BUILD SUCCESSFUL',
      'exit /b 0', ''
    ].join('\r\n'));
    await write(project, 'settings.gradle.kts', 'include(":app")');
    await write(project, 'app/build.gradle.kts', 'plugins { id("com.android.application") }');
    await write(project, 'app/build/outputs/apk/debug/output-metadata.json', JSON.stringify({ variantName: 'debug', elements: [{ outputFile: 'custom-debug.apk', filters: [] }] }));
    await write(root, 'workspace/.vscode/settings.json', JSON.stringify({
      'androidUsbRunner.androidSdkPath': sdk, 'androidUsbRunner.javaHome': javaHome,
      'extensions.ignoreRecommendations': true, 'security.workspace.trust.enabled': false,
      'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none'
    }));
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: path.join(__dirname, 'hostTests.js'),
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
      extensionTestsEnv: {
        ...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('VSCODE_')).map(key => [key, undefined])),
        ELECTRON_RUN_AS_NODE: undefined,
        ANDROID_USB_RUNNER_TEST_LOG: log, ANDROID_USB_RUNNER_TEST_PROJECT: project
      },
      launchArgs: [path.join(root, 'workspace'), '--user-data-dir', path.join(root, 'profile'), '--extensions-dir', path.join(root, 'extensions'),
        '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates']
    });
  } finally { runner.dispose(); await cleanup(root); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
