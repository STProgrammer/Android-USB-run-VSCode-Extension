const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const forbidden = /creat/i;
const sources = [
  ['extension description', manifest.description],
  ['display name', manifest.displayName],
  ['configuration title', manifest.contributes?.configuration?.title],
  ['workspace trust note', manifest.capabilities?.untrustedWorkspaces?.description],
  ['virtual workspace note', manifest.capabilities?.virtualWorkspaces?.description],
];

for (const command of manifest.contributes?.commands ?? []) {
  sources.push([`command ${command.command}`, `${command.title ?? ''} ${command.category ?? ''}`]);
}
for (const [name, setting] of Object.entries(manifest.contributes?.configuration?.properties ?? {})) {
  sources.push([`setting ${name}`, setting.description]);
}

function addGuides(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) addGuides(file);
    else if (entry.isFile() && /\.(?:md|mdx|rst|txt)$/i.test(entry.name)) {
      sources.push([path.relative(root, file), fs.readFileSync(file, 'utf8')]);
    }
  }
}

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.(?:md|mdx|rst)$/i.test(entry.name)) {
    const file = path.join(root, entry.name);
    sources.push([entry.name, fs.readFileSync(file, 'utf8')]);
  }
}
addGuides(path.join(root, 'docs'));
addGuides(path.join(root, 'guides'));

const violations = sources.filter(([, value]) => typeof value === 'string' && forbidden.test(value));
if (violations.length) {
  console.error(`Disallowed wording in: ${violations.map(([name]) => name).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`Details wording checked in ${sources.length} user-facing fields and guides.`);
}
