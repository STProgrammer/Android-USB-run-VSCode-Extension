import * as path from 'node:path';
import { AppModule, AndroidProject, UserError } from './types';
import { ignoredDirectories, isFile, readOptional, uniquePaths, walk } from './files';

export async function discoverProjects(roots: string[], signal?: AbortSignal): Promise<AndroidProject[]> {
  const wrappers: string[] = [];
  for (const root of roots) {
    for await (const file of walk(root, { ignore: ignoredDirectories, signal })) {
      if (path.basename(file).toLowerCase() === 'gradlew.bat') { wrappers.push(file); }
    }
  }
  const projects = uniquePaths(wrappers).sort().map(wrapper => ({ root: path.dirname(wrapper), wrapper }));
  if (!projects.length) { throw new UserError('gradlew.bat was not found in this workspace. Open the folder containing your Android project.'); }
  return projects;
}

// Remove comments without damaging strings such as URLs or quoted plugin IDs.
export function stripComments(source: string): string {
  return source.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (match, quoted: string | undefined) => quoted ?? match.replace(/[^\r\n]/g, ' '));
}

export function applicationAliases(toml: string): string[] {
  const plugins = toml.match(/^\[plugins\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? '';
  const aliases: string[] = [];
  const regex = /^\s*([\w.-]+)\s*=\s*\{([^}]+)\}/gm;
  for (const match of plugins.matchAll(regex)) {
    if (/\bid\s*=\s*["']com\.android\.application["']/.test(match[2]!)) {
      aliases.push(match[1]!.replace(/[-_.]+/g, '.'));
    }
  }
  for (const match of toml.matchAll(/^\[plugins\.([\w.-]+)\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)) {
    if (/\bid\s*=\s*["']com\.android\.application["']/.test(match[2]!)) { aliases.push(match[1]!.replace(/[-_.]+/g, '.')); }
  }
  return aliases;
}

export function appliesAndroidApplication(source: string, aliases: string[] = []): boolean {
  const clean = stripComments(source);
  if (/apply\s*(?:\(\s*)?plugin\s*(?::|=)\s*["']com\.android\.application["']/.test(clean)) { return true; }
  const declarations = /\bid\s*(?:\(\s*)?["']com\.android\.application["']\s*\)?([^\r\n{}]*)/g;
  for (const match of clean.matchAll(declarations)) {
    if (!/\bapply\s*(?:\(\s*)?false\b/.test(match[1]!)) { return true; }
  }
  for (const match of clean.matchAll(/alias\s*\(\s*libs\.plugins\.([\w.]+)\s*\)([^\r\n{}]*)/g)) {
    if (aliases.includes(match[1]!) && !/\bapply\s*(?:\(\s*)?false\b/.test(match[2]!)) { return true; }
  }
  return false;
}

export function parseSettings(source: string, root: string): Map<string, string> {
  const clean = stripComments(source);
  const modules = new Map<string, string>();
  for (const include of clean.matchAll(/\binclude\b\s*(?:\(([^)]*)\)|([^\r\n]+))/g)) {
    for (const item of (include[1] ?? include[2] ?? '').matchAll(/["'](:?[\w.:-]+)["']/g)) {
      const name = item[1]!.startsWith(':') ? item[1]! : `:${item[1]}`;
      if (name.split(':').some(segment => segment === '..')) { continue; }
      modules.set(name, path.join(root, ...name.slice(1).split(':')));
    }
  }
  const mapping = /project\s*\(\s*["'](:[^"']+)["']\s*\)\s*\.projectDir\s*=\s*(?:file\s*\(\s*|(?:new\s+)?File\s*\(\s*(?:rootDir|settingsDir)\s*,\s*)["']([^"']+)["']/g;
  for (const match of clean.matchAll(mapping)) { modules.set(match[1]!, path.resolve(root, match[2]!)); }
  return modules;
}

export async function discoverModules(project: AndroidProject, signal?: AbortSignal): Promise<AppModule[]> {
  const settings = await readOptional(path.join(project.root, 'settings.gradle.kts')) || await readOptional(path.join(project.root, 'settings.gradle'));
  const included = parseSettings(settings, project.root);
  const aliases = applicationAliases(await readOptional(path.join(project.root, 'gradle', 'libs.versions.toml')));
  const gradleFiles: string[] = [];
  for await (const file of walk(project.root, { ignore: ignoredDirectories, signal, stopAtNestedWrapper: true })) {
    if (/^build\.gradle(?:\.kts)?$/i.test(path.basename(file))) { gradleFiles.push(file); }
  }
  for (const directory of included.values()) {
    for (const name of ['build.gradle.kts', 'build.gradle']) {
      const file = path.join(directory, name);
      if (await isFile(file)) { gradleFiles.push(file); }
    }
  }
  const candidates = new Map<string, AppModule>();
  for (const file of uniquePaths(gradleFiles)) {
    const directory = path.dirname(file);
    const mapping = [...included.entries()].find(([, value]) => value.toLowerCase() === directory.toLowerCase());
    const relative = path.relative(project.root, directory);
    const name = mapping?.[0] ?? (relative ? `:${relative.split(path.sep).join(':')}` : ':');
    // Exclude unrelated build scripts when settings has explicit module declarations.
    if (included.size && !mapping && relative) { continue; }
    if (relative.split(path.sep).some(segment => ['buildSrc', 'build-logic', 'gradle'].includes(segment))) { continue; }
    const detected = appliesAndroidApplication(await readOptional(file), aliases);
    const previous = candidates.get(name);
    candidates.set(name, { name, directory, detected: detected || previous?.detected === true });
  }
  const modules = [...candidates.values()];
  const detected = modules.filter(module => module.detected);
  // Convention plugins are executable Gradle code; offer an explicit choice if static detection cannot resolve them.
  const result = detected.length ? detected : modules.filter(module => module.name !== ':' || modules.length === 1);
  if (!result.length) { throw new UserError('No Android application module was found. Check settings.gradle(.kts) and the com.android.application plugin.'); }
  return result.sort((a, b) => Number(b.name === ':app') - Number(a.name === ':app') || a.name.localeCompare(b.name));
}
