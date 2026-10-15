import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ProcessRunner } from '../src/process';
import { buildProject, wrapperInvocation } from '../src/gradle';
import { CancelledError } from '../src/types';
import { cleanup, FakeRunner, fixture, result, silent, write } from './helpers';

test('Windows executes the absolute wrapper with spaces, ampersands, percent and exclamation marks', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture();
  const runner = new ProcessRunner(silent);
  try {
    const wrapper = await write(root, 'nested/Android App & (Phone) %PATH% !/gradlew.bat', '@echo off\r\ncd > "%ANDROID_USB_RUNNER_TEST_CWD%"\r\necho %*\r\nexit /b 0\r\n');
    const cwdFile = path.join(root, 'cwd.txt');
    const invocation = wrapperInvocation({ root: path.dirname(wrapper), wrapper }, ':mobile:assembleDebug', { ...process.env, ANDROID_USB_RUNNER_TEST_CWD: cwdFile });
    const output = await runner.run(invocation.file, invocation.args, { env: invocation.env, cwd: invocation.cwd, windowsVerbatimArguments: true });
    assert.equal(output.code, 0, output.stderr);
    assert.equal((await fs.readFile(cwdFile, 'utf8')).trim(), path.dirname(wrapper));
    assert.match(output.stdout, /:mobile:assembleDebug --console=plain/);
  } finally { runner.dispose(); await cleanup(root); }
});

test('build rejects a nonzero exit code so deployment cannot proceed', async () => {
  const runner = new FakeRunner(() => result('BUILD FAILED', 1));
  await assert.rejects(buildProject({ root: 'C:\\My App', wrapper: 'C:\\My App\\gradlew.bat' }, ':app:assembleDebug', process.env, runner, silent), /Android build failed/);
});

test('process runner streams stdout and stderr and reports errors', async () => {
  let log = '';
  const runner = new ProcessRunner({ append: value => { log += value; }, line: value => { log += value; } });
  try {
    const output = await runner.run(process.execPath, ['-e', 'process.stdout.write("hello");process.stderr.write("warning");process.exitCode=4']);
    assert.equal(output.code, 4);
    assert.equal(output.stdout, 'hello');
    assert.equal(output.stderr, 'warning');
    assert.match(log, /hello/);
    await assert.rejects(runner.run('C:\\nonexistent-android-usb-runner.exe', []), /Could not execute/);
  } finally { runner.dispose(); }
});

test('cancellation and timeout stop the spawned process', async () => {
  const runner = new ProcessRunner(silent);
  try {
    const controller = new AbortController();
    const pending = runner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(pending, CancelledError);
    await assert.rejects(runner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 150 }), /timed out/);
  } finally { runner.dispose(); }
});
