import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShow, publisherMatches, subjectNames, installMeaning, installArgs, silentArgs, cleanLines, wingetCommand, sourceOf } from '../lib/winget.mjs';
import { checksumFor, isCompanyApp, nodeMajor } from '../lib/apps.mjs';
import { windowsPowerShellEnv } from '../lib/env.mjs';

test('Windows PowerShell runs without the PowerShell 7 module path (its security module would not load)', () => {
  const env = windowsPowerShellEnv({ LM_FILE: 'C:\\x\\node.exe' });
  assert.equal(Object.keys(env).some((k) => k.toLowerCase() === 'psmodulepath'), false);
  assert.equal(env.LM_FILE, 'C:\\x\\node.exe');
});

const SHOW = [
  '   - \r   \\ \r',
  'Found Visual Studio Code [Microsoft.VisualStudioCode]',
  'Version: 1.106.2',
  'Publisher: Microsoft Corporation',
  'Description: Code editing.',
  'Installer:',
  '  Installer Type: inno',
  '  Installer Url: https://update.code.visualstudio.com/1.106.2/win32-x64-user/stable',
  '  Installer SHA256: ABCDEF0123',
  '',
].join('\n');

test('parseShow reads winget show', () => {
  assert.deepEqual(parseShow(SHOW), {
    found: true, name: 'Visual Studio Code', id: 'Microsoft.VisualStudioCode', version: '1.106.2', publisher: 'Microsoft Corporation',
    installerType: 'inno', installerUrl: 'https://update.code.visualstudio.com/1.106.2/win32-x64-user/stable', sha256: 'abcdef0123',
  });
  assert.deepEqual(parseShow('No package found matching input criteria.'), { found: false });
  assert.deepEqual(cleanLines('a\r  \rb\nc'), ['b', 'c']);
});

test('the signer must be the recorded publisher', () => {
  const ms = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
  assert.deepEqual(subjectNames(ms), ['Microsoft Corporation', 'Microsoft Corporation']);
  assert.equal(publisherMatches('Microsoft Corporation', ms), true);
  assert.equal(publisherMatches('Microsoft', ms), true);
  assert.equal(publisherMatches('Google LLC', ms), false);
  assert.equal(publisherMatches('', ms), false);
  assert.equal(publisherMatches('OpenJS Foundation', 'CN="OpenJS Foundation", O="OpenJS Foundation", C=US'), true);
  assert.equal(publisherMatches('Git', 'CN=Johannes Schindelin, O=Johannes Schindelin'), false);
});

test('winget exit codes', () => {
  assert.deepEqual(installMeaning(0), { ok: true, text: 'installed' });
  assert.equal(installMeaning(0x8A15002B | 0).ok, true);
  assert.equal(installMeaning(0x8A150061 | 0).text, 'installed already');
  assert.equal(installMeaning(3010).text, 'installed, restart needed');
  assert.equal(installMeaning(0x8A150014 | 0).ok, false);
  assert.match(installMeaning(1).text, /winget exit 0x1/);
});

test('install arguments and silent switches', () => {
  const a = installArgs('Git.Git', { version: '2.50.0' });
  assert.deepEqual(a.slice(0, 4), ['install', '--id', 'Git.Git', '-e']);
  assert.ok(a.includes('--accept-package-agreements'));
  assert.deepEqual(a.slice(-2), ['--version', '2.50.0']);
  assert.deepEqual(silentArgs('msi', 'C:\\x.msi'), { file: 'msiexec.exe', args: ['/i', 'C:\\x.msi', '/passive', '/norestart'], interactive: false });
  assert.equal(silentArgs('msix', 'x'), null);
  assert.equal(silentArgs('exe', 'x')?.interactive, true);
});

test('each package is asked of its own source only: a blocked Microsoft Store source cannot fail a winget install', () => {
  const a = installArgs('Git.Git');
  const i = a.indexOf('--source');
  assert.ok(i > 0 && a[i + 1] === 'winget', a.join(' '));
  assert.equal(wingetCommand('7zip.7zip'), 'winget install --id 7zip.7zip -e --source winget');
  assert.equal(sourceOf('9NBLGGH4NNS1'), 'msstore');
  assert.equal(sourceOf('XP89DCGQ3K6VLD'), 'msstore');
  assert.equal(sourceOf('Microsoft.VisualStudioCode'), 'winget');
  assert.equal(sourceOf('9wzdncrfj3tj'), 'msstore');
  assert.match(installMeaning(0x8A15005E | 0).text, /package source did not answer/);
});

test('apps: company apps listed only, Node majors, checksum lists', () => {
  assert.equal(isCompanyApp({ source: 'Software Center', name: 'X' }), true);
  assert.equal(isCompanyApp({ source: 'winget', name: 'Teams (Company Portal)' }), true);
  assert.equal(isCompanyApp({ source: 'winget', name: 'Git' }), false);
  assert.equal(nodeMajor('OpenJS.NodeJS.22'), 22);
  assert.equal(nodeMajor('OpenJS.NodeJS.LTS'), null);
  const sums = 'aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000  node-v22.1.0-win-x64.zip\nbbbb0000bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000  other.zip';
  assert.equal(checksumFor(sums, 'other.zip'), 'bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000');
  assert.equal(checksumFor(sums, 'missing.zip'), null);
});
