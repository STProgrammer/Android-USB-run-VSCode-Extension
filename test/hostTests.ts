import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('android-usb-runner-local.android-usb-runner');
  assert.ok(extension, 'Development extension must be discovered');
  await extension.activate();
  assert.equal(extension.isActive, true);
  const manifest = JSON.parse(await fs.readFile(path.join(extension.extensionPath, 'package.json'), 'utf8')) as { contributes: { commands: { command: string }[] } };
  const commands = await vscode.commands.getCommands(true);
  for (const command of manifest.contributes.commands) { assert.ok(commands.includes(command.command), `${command.command} must be registered`); }
  assert.equal(manifest.contributes.commands.length, 5);
  await vscode.commands.executeCommand('androidUsbRunner.showOutput');
  const log = process.env.ANDROID_USB_RUNNER_TEST_LOG!;
  const project = process.env.ANDROID_USB_RUNNER_TEST_PROJECT!;

  // Execute the actual VS Code command through the complete native-process pipeline.
  await Promise.all([
    vscode.commands.executeCommand('androidUsbRunner.run'),
    vscode.commands.executeCommand('androidUsbRunner.run')
  ]);
  const success = await fs.readFile(log, 'utf8');
  assert.equal((success.match(/gradle\|/g) ?? []).length, 1, 'A second click must not start another build');
  assert.match(success, /adb\|devices\|-l/);
  assert.match(success, /gradle\|:app:assembleDebug --console=plain/);
  assert.ok(success.toLowerCase().includes(project.toLowerCase()), `Gradle cwd must be the nested wrapper directory. Command log:\n${success}`);
  assert.match(success, /aapt2\|dump\|badging\|.*custom-debug\.apk/);
  assert.match(success, /adb\|-s\|USB_FIXTURE\|install\|-r\|.*custom-debug\.apk/);
  assert.match(success, /adb\|-s\|USB_FIXTURE\|shell\|am\|start\|-n\|'com\.example\.fixture\.debug\/com\.example\.fixture\.MainActivity'/);
  assert.ok(success.indexOf('gradle|') < success.indexOf('aapt2|dump'));
  assert.ok(success.indexOf('|install|-r|') < success.indexOf('|shell|am|start|'));

  // An unsuccessful build must never reach APK inspection, installation or launch.
  await fs.writeFile(log, '');
  await fs.writeFile(`${log}.fail-build`, 'fail');
  await vscode.commands.executeCommand('androidUsbRunner.run');
  const buildFailure = await fs.readFile(log, 'utf8');
  assert.match(buildFailure, /gradle\|/);
  assert.doesNotMatch(buildFailure, /\|install\||\|install-multiple\||\|shell\|am\||aapt2\|dump/);

  // An unsuccessful install must never launch the app.
  await fs.unlink(`${log}.fail-build`);
  await fs.writeFile(`${log}.fail-install`, 'fail');
  await fs.writeFile(log, '');
  await vscode.commands.executeCommand('androidUsbRunner.run');
  const installFailure = await fs.readFile(log, 'utf8');
  assert.match(installFailure, /\|install\|-r\|/);
  assert.doesNotMatch(installFailure, /\|shell\|am\|/);
  console.log('Extension Host smoke checks passed: activation, all five command IDs, complete deployment, duplicate-click protection, and build/install failure stops.');
}
