import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AdbClient, noDeviceMessage, parseDevices } from '../src/devices';
import { componentName, installApks, launchApp } from '../src/deployment';
import { ApkInfo } from '../src/aapt';
import { FakeRunner, result, silent } from './helpers';

const base: ApkInfo = { file: 'C:\\My App\\app debug.apk', filters: [], packageName: 'com.example.debug', activity: '.MainActivity', nativeAbis: [], testOnly: false };

test('ADB filtering excludes emulators, TCP, IPv6 and wireless mDNS devices', () => {
  const output = `List of devices attached
USB123 device product:phone model:Samsung_SM_S24 device:phone transport_id:1
USB456 unauthorized usb:1-2 transport_id:2
USB789 offline transport_id:3
emulator-5554 device product:sdk model:sdk_gphone64
192.168.1.20:5555 device model:Wireless
[fe80::2]:5555 device model:IPv6
adb-ABC-xyz._adb-tls-connect._tcp device model:Wireless
localhost:5555 device
* daemon started successfully
`;
  const devices = parseDevices(output);
  assert.deepEqual(devices.map(device => device.serial), ['USB123', 'USB456', 'USB789']);
  assert.equal(devices[0]!.model, 'Samsung SM S24');
  assert.match(noDeviceMessage([devices[1]!]), /Unlock the phone.*prompt/);
  assert.match(noDeviceMessage([devices[2]!]), /offline/);
  assert.match(noDeviceMessage([]), /No Android phone detected over USB/);
});

test('ADB device commands always target a serial, and reconnect checks cannot switch devices', async () => {
  const runner = new FakeRunner(() => result('List of devices attached\nOTHER device model:Other\n'));
  const adb = new AdbClient('adb.exe', runner);
  await assert.rejects(adb.assertReady('USB123'), /disconnected/);
  await assert.rejects(adb.device('emulator-5554', ['shell', 'id']), /physical USB/);
  await adb.device('USB123', ['get-state']);
  assert.deepEqual(runner.calls.at(-1)!.args, ['-s', 'USB123', 'get-state']);
});

test('single APK updates with -r and split APKs use install-multiple', async () => {
  const runner = new FakeRunner(() => result('Success\r\n'));
  const adb = new AdbClient('adb.exe', runner);
  await installApks(adb, 'USB123', { base, apks: [base] });
  assert.deepEqual(runner.calls[0]!.args, ['-s', 'USB123', 'install', '-r', base.file]);
  const split = { ...base, file: 'C:\\My App\\config.apk', split: 'config.en' };
  await installApks(adb, 'USB123', { base, apks: [base, split] });
  assert.deepEqual(runner.calls[1]!.args, ['-s', 'USB123', 'install-multiple', '-r', base.file, split.file]);
});

test('install errors fail clearly without uninstalling or erasing app data', async () => {
  const runner = new FakeRunner(() => result('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]', 1));
  await assert.rejects(installApks(new AdbClient('adb.exe', runner), 'USB123', { base, apks: [base] }), /different signing key/);
  assert.equal(runner.calls.length, 1);
});

test('launcher components support fully qualified, simple, relative and nested-class activity names', () => {
  assert.equal(componentName('com.example.debug', '.Main'), 'com.example.debug/com.example.debug.Main');
  assert.equal(componentName('com.example.debug', 'Main'), 'com.example.debug/com.example.debug.Main');
  assert.equal(componentName('com.example.debug', 'com.example.Main$Inner'), 'com.example.debug/com.example.Main$Inner');
  assert.throws(() => componentName('com.example;bad', '.Main'));
});

test('explicit launch succeeds without fallbacks and safely quotes remote shell arguments', async () => {
  const runner = new FakeRunner(() => result('Starting: Intent { cmp=com.example.debug/com.example.Main$Inner }'));
  await launchApp(new AdbClient('adb.exe', runner), 'USB123', 'com.example.debug', 'com.example.Main$Inner', silent);
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0]!.args, ['-s', 'USB123', 'shell', 'am', 'start', '-n', "'com.example.debug/com.example.Main$Inner'"]);
});

test('explicit activity errors with zero exit status fall back to Android resolution', async () => {
  let invocation = 0;
  const runner = new FakeRunner(() => {
    invocation++;
    if (invocation === 1) { return result('Error type 3\nError: Activity class does not exist.'); }
    if (invocation === 2) { return result('com.example.debug/com.example.Launcher\n'); }
    return result('Starting: Intent { cmp=com.example.debug/com.example.Launcher }');
  });
  await launchApp(new AdbClient('adb.exe', runner), 'USB123', 'com.example.debug', '.Wrong', silent);
  assert.equal(runner.calls.length, 3);
  assert.equal(runner.calls[2]!.args.at(-1), "'com.example.debug/com.example.Launcher'");
});

test('missing launchable activity uses package-based fallback and detects monkey failure', async () => {
  const runner = new FakeRunner((_file, args) => args.includes('monkey') ? result('Events injected: 1') : result('No activity found'));
  await launchApp(new AdbClient('adb.exe', runner), 'USB123', 'com.example.debug', undefined, silent);
  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[1]!.args.includes('monkey'), true);
  const failure = new FakeRunner(() => result('No activities found to run, monkey aborted.', 0));
  await assert.rejects(launchApp(new AdbClient('adb.exe', failure), 'USB123', 'com.example.debug', undefined, silent), /App installed, but/);
});
