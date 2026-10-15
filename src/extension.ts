import * as vscode from 'vscode';
import * as path from 'node:path';
import { AndroidProject, AppModule, CancelledError, Logger, RunnerSettings, UserError, checkCancelled } from './types';
import { discoverModules, discoverProjects } from './projects';
import { discoverAndroidTools, findAapt2 } from './sdk';
import { ProcessRunner } from './process';
import { AdbClient, AndroidDevice, noDeviceMessage } from './devices';
import { buildProject, javaEnvironment, resolveGradleTask } from './gradle';
import { findApkGroups, snapshotApks } from './apks';
import { chooseInstallPlans, inspectApk } from './aapt';
import { installApks, launchApp } from './deployment';
import { expandPath, setEnv } from './files';

export const COMMANDS = {
  run: 'androidUsbRunner.run',
  selectDevice: 'androidUsbRunner.selectDevice',
  selectProject: 'androidUsbRunner.selectProject',
  selectModule: 'androidUsbRunner.selectModule',
  showOutput: 'androidUsbRunner.showOutput'
} as const;

interface Choice<T> extends vscode.QuickPickItem { value: T; key: string; }

class AndroidUsbExtension implements vscode.Disposable {
  private busy = false;
  private disposed = false;
  private controller?: AbortController;
  private readonly output = vscode.window.createOutputChannel('Android USB Runner');
  private readonly log: Logger = { append: value => { if (!this.disposed) { this.output.append(value); } }, line: value => { if (!this.disposed) { this.output.appendLine(value); } } };
  private readonly runner = new ProcessRunner(this.log);
  private readonly status = vscode.window.createStatusBarItem('androidUsbRunner.button', vscode.StatusBarAlignment.Left, 10);
  private readonly registrations: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status.name = 'Android USB';
    this.status.text = '$(play) Android USB';
    this.status.tooltip = 'Build, install, and run on your USB Android phone';
    this.status.command = COMMANDS.run;
    this.status.accessibilityInformation = { label: 'Android USB: Build, Install and Run', role: 'button' };
    if (process.platform === 'win32' && !vscode.env.remoteName) { this.status.show(); }
    this.registrations.push(
      vscode.commands.registerCommand(COMMANDS.run, () => this.exclusive(() => this.deploy())),
      vscode.commands.registerCommand(COMMANDS.selectProject, () => this.exclusive(async () => { await this.project(true); })),
      vscode.commands.registerCommand(COMMANDS.selectModule, () => this.exclusive(async () => { await this.module(await this.project(), true); })),
      vscode.commands.registerCommand(COMMANDS.selectDevice, () => this.exclusive(async () => {
        const rememberedWrapper = this.context.workspaceState.get<string>('selectedProject');
        const folder = rememberedWrapper ? vscode.Uri.file(path.dirname(rememberedWrapper)) : vscode.workspace.workspaceFolders?.[0]?.uri;
        const tools = await discoverAndroidTools(this.settings(folder), folder?.fsPath);
        await this.device(new AdbClient(tools.adb, this.runner), true);
      })),
      vscode.commands.registerCommand(COMMANDS.showOutput, () => this.output.show(true))
    );
  }

  private settings(resource?: vscode.Uri): RunnerSettings {
    const configuration = vscode.workspace.getConfiguration('androidUsbRunner', resource);
    return {
      adbPath: configuration.get<string>('adbPath', ''), androidSdkPath: configuration.get<string>('androidSdkPath', ''),
      javaHome: configuration.get<string>('javaHome', ''), gradleTask: configuration.get<string>('gradleTask', 'assembleDebug')
    };
  }

  private async exclusive(action: () => Promise<void>): Promise<void> {
    if (this.busy) { void vscode.window.showInformationMessage('An Android USB operation is already in progress.'); return; }
    this.busy = true;
    this.status.text = '$(sync~spin) Android USB';
    try {
      if (process.platform !== 'win32' || vscode.env.remoteName) { throw new UserError('Android USB Runner requires a local Windows VS Code window. Open the Android project on the Windows computer connected to your USB phone.'); }
      if (!vscode.workspace.isTrusted) { throw new UserError('Trust this workspace in VS Code before running its Gradle Wrapper.'); }
      await action();
    } catch (error) {
      if (this.disposed) { return; }
      if (error instanceof CancelledError) { this.log.line(error.message); void vscode.window.showInformationMessage('Android USB deployment cancelled.'); }
      else {
        const message = error instanceof Error ? error.message : String(error);
        this.log.line(`ERROR: ${message}`);
        if (!(error instanceof UserError) && error instanceof Error) { this.log.line(error.stack ?? message); }
        void vscode.window.showErrorMessage(message, 'Show Output').then(action => { if (action === 'Show Output' && !this.disposed) { this.output.show(true); } });
      }
    } finally {
      this.busy = false;
      if (!this.disposed) { this.status.text = '$(play) Android USB'; }
    }
  }

  private async choose<T>(items: Choice<T>[], title: string, stateKey: string, force = false, token?: vscode.CancellationToken, automatic = true): Promise<T> {
    if (token?.isCancellationRequested) { throw new CancelledError(); }
    const remembered = this.context.workspaceState.get<string>(stateKey);
    let selected = !force ? items.find(item => item.key === remembered) : undefined;
    if (!selected && items.length === 1 && automatic && !force) { selected = items[0]; }
    if (!selected) {
      selected = await vscode.window.showQuickPick(items.map(item => ({ ...item, picked: item.key === remembered })), {
        title, placeHolder: 'Select once; this workspace remembers your choice', matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true
      }, token);
    }
    if (!selected || token?.isCancellationRequested) { throw new CancelledError(); }
    await this.context.workspaceState.update(stateKey, selected.key);
    return selected.value;
  }

  private async project(force = false, signal?: AbortSignal, token?: vscode.CancellationToken): Promise<AndroidProject> {
    const roots = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
    if (!roots.length) { throw new UserError('Open a local folder containing your Android Gradle project first.'); }
    const projects = await discoverProjects(roots, signal);
    return this.choose(projects.map(project => ({ value: project, key: project.wrapper, label: path.basename(project.root), description: project.root })),
      'Select Android Gradle project', 'selectedProject', force, token);
  }

  private async module(project: AndroidProject, force = false, signal?: AbortSignal, token?: vscode.CancellationToken): Promise<AppModule> {
    const modules = await discoverModules(project, signal);
    return this.choose(modules.map(module => ({ value: module, key: module.name, label: module.name,
      description: module.detected ? 'Android application' : 'Confirm app module (plugin could not be detected)', detail: module.directory })),
      'Select Android application module', `module:${project.root}`, force, token, modules.some(module => module.detected) || modules[0]?.name === ':app');
  }

  private async device(adb: AdbClient, force = false, token?: vscode.CancellationToken): Promise<AndroidDevice> {
    const all = await adb.devices();
    const ready = all.filter(device => device.state === 'device');
    if (!ready.length) { throw new UserError(noDeviceMessage(all)); }
    return this.choose(ready.map(device => ({ value: device, key: device.serial, label: device.model, description: device.serial, detail: 'USB device' })),
      'Select USB Android phone', 'selectedDevice', force, token);
  }

  private async deploy(): Promise<void> {
    this.output.clear();
    this.log.line(`Android USB Runner — ${new Date().toLocaleString()}`);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Android USB', cancellable: true }, async (progress, token) => {
      const controller = new AbortController();
      this.controller = controller;
      const subscription = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) { controller.abort(); }
      const signal = controller.signal;
      try {
        progress.report({ message: 'Finding Android project...' });
        const project = await this.project(false, signal, token);
        const module = await this.module(project, false, signal, token);
        const settings = this.settings(vscode.Uri.file(project.root));
        const { task, variant } = resolveGradleTask(module, settings.gradleTask);
        const tools = await discoverAndroidTools(settings, project.root);
        this.log.line(`Project: ${project.root}\nModule: ${module.name}\nADB: ${tools.adb}`);
        progress.report({ message: 'Detecting device...' });
        const adb = new AdbClient(tools.adb, this.runner, signal);
        const device = await this.device(adb, false, token);
        this.log.line(`USB device: ${device.model} (${device.serial})`);
        const aapt = await findAapt2(tools.sdkRoots);
        this.log.line(`AAPT2: ${aapt}`);
        const env = await javaEnvironment(settings.javaHome, this.runner, this.log, signal);
        // A manually specified SDK should also be available to the Gradle build.
        if (settings.androidSdkPath.trim()) {
          setEnv(env, 'ANDROID_SDK_ROOT', expandPath(settings.androidSdkPath));
          setEnv(env, 'ANDROID_HOME', env.ANDROID_SDK_ROOT);
        }
        const before = await snapshotApks(module.directory, signal);
        progress.report({ message: 'Building debug APK...' });
        await buildProject(project, task, env, this.runner, this.log, signal);
        checkCancelled(signal);
        progress.report({ message: 'Inspecting APK...' });
        const groups = await findApkGroups(module.directory, variant, before, this.log, signal);
        const group = await this.choose(groups.map(group => ({ value: group, key: group.id, label: group.variant, description: `${group.apks.length} APK(s)`, detail: group.id })),
          'Select built Android variant', `variant:${project.root}:${module.name}:${task}`, false, token);
        const infos = [];
        for (const apk of group.apks) { infos.push(await inspectApk(aapt, apk, this.runner, signal)); }
        // Recheck after a long build; never switch silently to a different phone.
        await adb.assertReady(device.serial);
        const plans = chooseInstallPlans(infos, infos.length > 1 ? await adb.abis(device.serial) : []);
        const plan = await this.choose(plans.map(plan => ({ value: plan, key: plan.base.file, label: path.basename(plan.base.file),
          description: plan.base.packageName, detail: plan.apks.map(apk => apk.file).join(', ') })),
          'Select APK to install on this phone', `apk:${project.root}:${module.name}:${group.variant}:${device.serial}`, false, token);
        this.log.line(`Application ID: ${plan.base.packageName}\nAPK(s): ${plan.apks.map(apk => apk.file).join(', ')}`);
        checkCancelled(signal);
        progress.report({ message: 'Installing...' });
        await installApks(adb, device.serial, plan);
        checkCancelled(signal);
        progress.report({ message: 'Launching...' });
        await launchApp(adb, device.serial, plan.base.packageName, plan.base.activity, this.log);
        checkCancelled(signal);
        this.log.line(`Installed and launched on ${device.model}.`);
        void vscode.window.showInformationMessage(`Installed and launched on ${device.model}`);
      } finally {
        subscription.dispose();
        this.controller = undefined;
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    this.runner.dispose();
    this.registrations.forEach(registration => registration.dispose());
    this.status.dispose();
    this.output.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new AndroidUsbExtension(context));
}

export function deactivate(): void { /* VS Code disposes context.subscriptions. */ }
