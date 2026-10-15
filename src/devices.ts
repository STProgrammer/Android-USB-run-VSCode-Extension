import { CommandRunner, combined, ProcessResult } from './process';
import { UserError } from './types';

export interface AndroidDevice { serial: string; state: string; model: string; description: string; }

export function isUsbSerial(serial: string): boolean {
  return Boolean(serial) && !/^emulator-/i.test(serial) && !/[:\s]/.test(serial)
    && !/(?:_adb.*\._tcp|_adb-tls|\._tcp\.?$)/i.test(serial);
}

export function parseDevices(output: string): AndroidDevice[] {
  const devices: AndroidDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|no permissions)\b(.*)$/);
    if (!match || !isUsbSerial(match[1]!)) { continue; }
    const serial = match[1]!;
    const details = match[3]!;
    // TCP transports may also be advertised in the details instead of the serial.
    if (/(?:^|\s)(?:tcp|local):/i.test(details)) { continue; }
    const model = details.match(/\bmodel:(\S+)/)?.[1]?.replace(/_/g, ' ') ?? serial;
    devices.push({ serial, state: match[2]!, model, description: details.trim() });
  }
  return devices;
}

export class AdbClient {
  constructor(readonly executable: string, private readonly runner: CommandRunner, private readonly signal?: AbortSignal) {}

  private run(args: string[], timeoutMs: number): Promise<ProcessResult> {
    return this.runner.run(this.executable, args, { signal: this.signal, timeoutMs });
  }

  async devices(): Promise<AndroidDevice[]> {
    const result = await this.run(['devices', '-l'], 30000);
    if (result.code !== 0) { throw new UserError(`ADB could not list USB devices. ${adbFailure(combined(result))}`); }
    return parseDevices(result.stdout);
  }

  async device(serial: string, args: string[], timeoutMs = 30000): Promise<ProcessResult> {
    if (!isUsbSerial(serial)) { throw new UserError('The selected device is not a physical USB device. Select a USB-connected Android phone.'); }
    return this.run(['-s', serial, ...args], timeoutMs);
  }

  async assertReady(serial: string): Promise<void> {
    const devices = await this.devices();
    const selected = devices.find(device => device.serial === serial);
    if (selected?.state === 'device') { return; }
    if (selected) { throw new UserError(noDeviceMessage([selected])); }
    throw new UserError(`USB phone ${serial} disconnected. Reconnect and authorize the same phone, then click Android USB again.`);
  }

  async abis(serial: string): Promise<string[]> {
    const result = await this.device(serial, ['shell', 'getprop', 'ro.product.cpu.abilist']);
    const abis = result.code === 0 ? result.stdout.trim().split(',').filter(Boolean) : [];
    if (abis.length) { return abis; }
    const fallback = await this.device(serial, ['shell', 'getprop', 'ro.product.cpu.abi']);
    return fallback.code === 0 ? fallback.stdout.trim().split(',').filter(Boolean) : [];
  }
}

export function noDeviceMessage(devices: AndroidDevice[]): string {
  const messages: string[] = [];
  if (devices.some(device => device.state === 'unauthorized')) {
    messages.push('Phone detected but ADB access is unauthorized. Unlock the phone and accept the USB debugging prompt.');
  }
  if (devices.some(device => device.state === 'offline')) {
    messages.push('USB phone is offline. Unlock it, reconnect the USB cable, and confirm USB debugging is enabled.');
  }
  if (messages.length) { return messages.join(' '); }
  if (devices.length) { return 'USB phone is not ready for deployment. Boot Android normally and enable USB debugging.'; }
  return 'No Android phone detected over USB. Connect the phone, enable USB debugging, and authorize this computer. Windows may require the manufacturer’s OEM ADB USB driver.';
}

export function adbFailure(output: string): string {
  if (/unauthorized/i.test(output)) { return 'Unlock the phone and accept the USB debugging authorization prompt.'; }
  if (/offline/i.test(output)) { return 'The USB phone is offline. Reconnect the cable and unlock the phone.'; }
  if (/device.*not found|no devices|device.*disconnected/i.test(output)) { return 'The USB phone disconnected. Reconnect and authorize it, then try again.'; }
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/i.test(output)) { return 'The installed app has a different signing key. Sign this build with the same key, or manually uninstall the old app (which removes its data).'; }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(output)) { return 'The installed app has a newer versionCode. Increase this build’s versionCode, or manually remove the installed app.'; }
  if (/INSTALL_FAILED_USER_RESTRICTED/i.test(output)) { return 'Installation was blocked on the phone. Unlock it, approve the install prompt, and check the phone’s USB installation settings.'; }
  if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/i.test(output)) { return 'The phone has insufficient storage. Free some space and retry.'; }
  const failure = output.match(/Failure\s*\[([^\]]+)\]/)?.[1];
  return failure ? `${failure}. See Android USB Runner output.` : 'See Android USB Runner output for details.';
}
