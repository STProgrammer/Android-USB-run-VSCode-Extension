import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { applicationAliases, appliesAndroidApplication, discoverModules, discoverProjects, parseSettings } from '../src/projects';
import { discoverAndroidTools, findAapt2, localSdkPath } from '../src/sdk';
import { javaEnvironment, resolveGradleTask } from '../src/gradle';
import { cleanup, defaults, FakeRunner, fixture, silent, write } from './helpers';

test('finds nested wrappers with spaces and ignores build/cache/dependency trees', async () => {
  const root = await fixture();
  try {
    const wrapper = await write(root, 'source/My Android Project/gradlew.bat');
    for (const ignored of ['node_modules', '.git', '.gradle', 'build']) { await write(root, `${ignored}/unrelated/gradlew.bat`); }
    assert.deepEqual(await discoverProjects([root, path.dirname(wrapper)]), [{ wrapper, root: path.dirname(wrapper) }]);
  } finally { await cleanup(root); }
});

test('missing wrapper gives an actionable error', async () => {
  const root = await fixture();
  try { await assert.rejects(discoverProjects([root]), /gradlew.bat was not found/); } finally { await cleanup(root); }
});

test('application plugin detection handles Kotlin, Groovy, aliases and apply false', () => {
  assert.equal(appliesAndroidApplication('plugins { id("com.android.application") }'), true);
  assert.equal(appliesAndroidApplication("apply plugin: 'com.android.application'"), true);
  assert.equal(appliesAndroidApplication('apply(plugin = "com.android.application")'), true);
  assert.equal(appliesAndroidApplication('plugins { id("com.android.application") version "8.9.0" apply false }'), false);
  assert.equal(appliesAndroidApplication('// id("com.android.application")\nplugins { id("com.android.library") }'), false);
  const aliases = applicationAliases('[versions]\nagp = "8.9.0"\n[plugins]\nandroid-application = { id = "com.android.application", version.ref = "agp" }\nandroid-library = { id = "com.android.library" }\n[libraries]\n');
  assert.deepEqual(aliases, ['android.application']);
  assert.equal(appliesAndroidApplication('plugins { alias(libs.plugins.android.application) }', aliases), true);
  assert.equal(appliesAndroidApplication('plugins { alias(libs.plugins.android.application) apply false }', aliases), false);
});

test('module discovery honors Gradle paths, remapped directories, aliases and excludes libraries', async () => {
  const root = await fixture();
  try {
    const wrapper = await write(root, 'gradlew.bat');
    await write(root, 'settings.gradle.kts', 'include(":mobile", ":feature:client", ":library")\nproject(":mobile").projectDir = file("android-phone")\nincludeBuild("build-logic")');
    await write(root, 'build.gradle.kts', 'plugins { id("com.android.application") version "8.9.0" apply false }');
    await write(root, 'gradle/libs.versions.toml', '[plugins]\nandroid-app = { id = "com.android.application", version = "8.9.0" }');
    await write(root, 'android-phone/build.gradle.kts', 'plugins { alias(libs.plugins.android.app) }');
    await write(root, 'feature/client/build.gradle', "plugins { id 'com.android.application' }");
    await write(root, 'library/build.gradle.kts', 'plugins { id("com.android.library") }');
    await write(root, 'build-logic/build.gradle.kts', 'plugins { id("com.android.application") }');
    const modules = await discoverModules({ root, wrapper });
    assert.deepEqual(modules.map(module => module.name), [':feature:client', ':mobile']);
    assert.equal(modules[1]!.directory, path.join(root, 'android-phone'));
    assert.equal(modules.every(module => module.detected), true);
  } finally { await cleanup(root); }
});

test('settings includes do not confuse includeBuild with an app module', () => {
  const modules = parseSettings('include ":app", ":mobile"\nincludeBuild("build-logic")', 'C:\\project');
  assert.deepEqual([...modules.keys()], [':app', ':mobile']);
});

test('ADB discovery preserves configured, SDK_ROOT, HOME, standard, PATH precedence', async () => {
  const root = await fixture();
  try {
    const manual = await write(root, 'manual/adb.exe');
    const sdkRoot = await write(root, 'sdk-root/platform-tools/adb.exe');
    const home = await write(root, 'sdk-home/platform-tools/adb.exe');
    const standard = await write(root, 'local/Android/Sdk/platform-tools/adb.exe');
    const onPath = await write(root, 'bin/adb.exe');
    const env = { ANDROID_SDK_ROOT: path.dirname(path.dirname(sdkRoot)), ANDROID_HOME: path.dirname(path.dirname(home)), LOCALAPPDATA: path.join(root, 'local'), Path: path.dirname(onPath) };
    assert.equal((await discoverAndroidTools({ ...defaults, adbPath: manual }, undefined, env)).adb, manual);
    assert.equal((await discoverAndroidTools(defaults, undefined, env)).adb, sdkRoot);
    delete (env as NodeJS.ProcessEnv).ANDROID_SDK_ROOT;
    assert.equal((await discoverAndroidTools(defaults, undefined, env)).adb, home);
    delete (env as NodeJS.ProcessEnv).ANDROID_HOME;
    assert.equal((await discoverAndroidTools(defaults, undefined, env)).adb, standard);
    delete (env as NodeJS.ProcessEnv).LOCALAPPDATA;
    assert.equal((await discoverAndroidTools(defaults, undefined, env)).adb, onPath);
    assert.equal((await discoverAndroidTools({ ...defaults, androidSdkPath: path.dirname(path.dirname(home)) }, undefined, env)).adb, home);
    await assert.rejects(discoverAndroidTools({ ...defaults, adbPath: path.join(root, 'missing.exe') }, undefined, env), /adbPath/);
  } finally { await cleanup(root); }
});

test('AAPT2 picks the newest real version, including release versus preview ordering', async () => {
  const root = await fixture();
  try {
    for (const version of ['9.0.0', '35.0.0', '36.0.0-rc2', '36.0.0']) { await write(root, `build-tools/${version}/aapt2.exe`); }
    await write(root, 'build-tools/99.0.0/not-aapt.exe');
    assert.equal(await findAapt2([root]), path.join(root, 'build-tools', '36.0.0', 'aapt2.exe'));
  } finally { await cleanup(root); }
});

test('local.properties decodes escaped Windows SDK paths', () => {
  assert.equal(localSdkPath('sdk.dir=C\\:\\\\Users\\\\Me\\\\Android\\\\Sdk\n'), 'C:\\Users\\Me\\Android\\Sdk');
});

test('Java preserves valid JAVA_HOME; explicit override and JBR fallback are process-local', async () => {
  const root = await fixture();
  try {
    await write(root, 'existing/bin/java.exe');
    await write(root, 'chosen/bin/java.exe');
    await write(root, 'Program Files/Android/Android Studio/jbr/bin/java.exe');
    const env = { JAVA_HOME: path.join(root, 'existing'), PATH: '', ProgramFiles: path.join(root, 'Program Files') };
    assert.equal((await javaEnvironment('', new FakeRunner(), silent, undefined, env)).JAVA_HOME, env.JAVA_HOME);
    assert.equal((await javaEnvironment(path.join(root, 'chosen'), new FakeRunner(), silent, undefined, env)).JAVA_HOME, path.join(root, 'chosen'));
    const broken = { ...env, JAVA_HOME: path.join(root, 'missing') };
    assert.equal((await javaEnvironment('', new FakeRunner(), silent, undefined, broken)).JAVA_HOME, path.join(root, 'Program Files', 'Android', 'Android Studio', 'jbr'));
    assert.equal(broken.JAVA_HOME, path.join(root, 'missing'));
    await assert.rejects(javaEnvironment(path.join(root, 'missing'), new FakeRunner(), silent, undefined, env), /javaHome/);
  } finally { await cleanup(root); }
});

test('invalid inherited JAVA_HOME is removed when PATH Java is usable', async () => {
  const root = await fixture();
  try {
    await write(root, 'bin/java.exe');
    const env = { JAVA_HOME: path.join(root, 'bad'), PATH: path.join(root, 'bin') };
    const selected = await javaEnvironment('', new FakeRunner(), silent, undefined, env);
    assert.equal(selected.JAVA_HOME, undefined);
    assert.equal(selected.PATH, env.PATH);
  } finally { await cleanup(root); }
});

test('Gradle tasks are scoped to the selected module and reject shell injection', () => {
  const module = { name: ':feature:mobile', directory: 'C:\\project\\mobile', detected: true };
  assert.deepEqual(resolveGradleTask(module, 'assembleDemoDebug'), { task: ':feature:mobile:assembleDemoDebug', variant: 'demoDebug' });
  assert.equal(resolveGradleTask(module, ':feature:mobile:assembleDebug').task, ':feature:mobile:assembleDebug');
  for (const input of ['assembleDebug & whoami', 'assembleDebug --info', ':other:assembleDebug', '%PATH%', 'clean', 'assembleDebugAndroidTest']) {
    assert.throws(() => resolveGradleTask(module, input));
  }
});
