import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { findApkGroups, snapshotApks } from '../src/apks';
import { ApkInfo, chooseInstallPlans, parseBadging } from '../src/aapt';
import { cleanup, fixture, silent, write } from './helpers';

const apk = (file: string, extra: Partial<ApkInfo> = {}): ApkInfo => ({ file, filters: [], packageName: 'com.example.debug', versionCode: '7', nativeAbis: [], testOnly: false, ...extra });

test('APK badging yields variant application ID, activity, ABI and split info', () => {
  const info = parseBadging("package: name='com.example.debug' versionCode='7' versionName='1'\nlaunchable-activity: name='.MainActivity' label=''\nnative-code: 'arm64-v8a' 'armeabi-v7a'\n");
  assert.equal(info.packageName, 'com.example.debug');
  assert.equal(info.activity, '.MainActivity');
  assert.deepEqual(info.nativeAbis, ['arm64-v8a', 'armeabi-v7a']);
  assert.equal(parseBadging("package: name='com.example.debug' versionCode='7' split='config.arm64_v8a'").split, 'config.arm64_v8a');
  assert.equal(parseBadging("package: name='com.example.debug'").activity, undefined);
  assert.throws(() => parseBadging('no package info'), /application ID/);
  assert.throws(() => parseBadging("package: name='bad;command'"), /application ID/);
});

test('APK detection honors metadata filenames, current build and up-to-date output', async () => {
  const root = await fixture();
  try {
    const old = await write(root, 'build/outputs/apk/old/debug/old.apk', 'old');
    const before = await snapshotApks(root);
    const expected = await write(root, 'build/outputs/apk/demo/debug/my custom output.apk', 'new build');
    await write(root, 'build/outputs/apk/demo/debug/output-metadata.json', JSON.stringify({ variantName: 'demoDebug', applicationId: 'com.example.debug', elements: [{ outputFile: path.basename(expected), filters: [] }] }));
    await write(root, 'build/outputs/apk/release/release.apk', 'release');
    await write(root, 'build/outputs/apk/androidTest/debug/test.apk', 'test');
    const groups = await findApkGroups(root, 'debug', before, silent);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.apks[0]!.file, expected);
    assert.equal(groups[0]!.changed, true);
    assert.equal(groups[0]!.apks.some(file => file.file === old), false);
    const unchanged = await findApkGroups(root, 'demoDebug', await snapshotApks(root), silent);
    assert.equal(unchanged.length, 1);
    assert.equal(unchanged[0]!.changed, false);
  } finally { await cleanup(root); }
});

test('APK selection falls back to filenames without metadata and refuses missing requested variants', async () => {
  const root = await fixture();
  try {
    const file = await write(root, 'build/outputs/apk/debug/a totally different filename.apk', 'apk');
    assert.equal((await findApkGroups(root, 'debug', new Map(), silent))[0]!.apks[0]!.file, file);
    await assert.rejects(findApkGroups(root, 'demoDebug', new Map(), silent), /No debug APK/);
  } finally { await cleanup(root); }
});

test('metadata traversal cannot select APKs outside its output directory', async () => {
  const root = await fixture();
  try {
    await write(root, 'outside.apk', 'unrelated');
    await write(root, 'build/outputs/apk/debug/output-metadata.json', JSON.stringify({ variantName: 'debug', elements: [{ outputFile: '../../../../outside.apk' }] }));
    await assert.rejects(findApkGroups(root, 'debug', new Map(), silent), /No debug APK/);
  } finally { await cleanup(root); }
});

test('standalone ABI outputs select one compatible APK instead of install-multiple', () => {
  const arm = apk('arm.apk', { filters: [{ type: 'ABI', value: 'arm64-v8a' }], nativeAbis: ['arm64-v8a'] });
  const x86 = apk('x86.apk', { filters: [{ type: 'ABI', value: 'x86_64' }], nativeAbis: ['x86_64'] });
  assert.deepEqual(chooseInstallPlans([arm, x86], ['arm64-v8a'])[0]!.apks, [arm]);
  const universal = apk('universal.apk', { nativeAbis: ['arm64-v8a', 'x86_64'] });
  assert.equal(chooseInstallPlans([arm, x86, universal], ['arm64-v8a'])[0]!.base.file, 'universal.apk');
  assert.throws(() => chooseInstallPlans([x86], ['arm64-v8a']), /CPU ABI/);
});

test('real splits use one matching base and compatible configuration splits', () => {
  const base = apk('base.apk');
  const arm = apk('split-arm.apk', { split: 'config.arm64_v8a', nativeAbis: ['arm64-v8a'] });
  const x86 = apk('split-x86.apk', { split: 'config.x86_64', nativeAbis: ['x86_64'] });
  const language = apk('split-en.apk', { split: 'config.en' });
  assert.deepEqual(chooseInstallPlans([base, arm, x86, language], ['arm64-v8a'])[0]!.apks, [base, arm, language]);
  assert.throws(() => chooseInstallPlans([arm], ['arm64-v8a']), /base APK is missing/);
  assert.throws(() => chooseInstallPlans([base, { ...arm, versionCode: '8' }], ['arm64-v8a']), /mixed applications or versions/);
});
