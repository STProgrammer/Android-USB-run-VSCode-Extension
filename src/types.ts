export interface Logger {
  append(value: string): void;
  line(value: string): void;
}

export interface RunnerSettings {
  adbPath: string;
  androidSdkPath: string;
  javaHome: string;
  gradleTask: string;
}

export interface AndroidProject {
  root: string;
  wrapper: string;
}

export interface AppModule {
  name: string;
  directory: string;
  detected: boolean;
}

export class UserError extends Error {}
export class CancelledError extends Error {
  constructor() { super('Android USB deployment cancelled.'); }
}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) { throw new CancelledError(); }
}
