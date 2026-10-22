import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const version = '12.3.4';
const releases = {
  'linux-x64': {
    archive: 'pnpm-linux-x64.tar.gz',
    sha256: '9705e5704b4679fb503c963a18d1ac4f105e39aafafca8a2ed346facdf820cd0',
  },
  'linux-arm64': {
    archive: 'pnpm-linux-arm64.tar.gz',
    sha256: '95e71a2a30bbc0b77511f95cf096779068dcad6ffcbbfdf0cd4dde9de2b2b97c',
  },
  'win32-x64': {
    archive: 'pnpm-win32-x64.zip',
    sha256: 'ada0d8b62adff9884686d473e27d0f57ef2ca4a044d23a7c6782af86b9a8a6cf',
  },
};
const release = releases[`${process.platform}-${process.arch}`];
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
if (manifest.packageManager !== `pnpm@${version}`)
  throw new Error('Update the native pnpm release pins with packageManager.');
if (!release) throw new Error('This runner has no pinned native pnpm release.');
if (!process.env.RUNNER_TEMP || !process.env.GITHUB_PATH)
  throw new Error('Native pnpm setup requires RUNNER_TEMP and GITHUB_PATH.');

const directory = mkdtempSync(join(process.env.RUNNER_TEMP, 'notes-pnpm-'));
const archive = join(directory, release.archive);
execFileSync(
  'curl',
  [
    '--fail',
    '--silent',
    '--show-error',
    '--location',
    '--connect-timeout',
    '10',
    '--max-time',
    '60',
    '--retry',
    '2',
    '--retry-all-errors',
    '--retry-delay',
    '1',
    '--retry-max-time',
    '150',
    '--max-filesize',
    '67108864',
    '--output',
    archive,
    `https://github.com/pnpm/pnpm/releases/download/v${version}/${release.archive}`,
  ],
  { stdio: 'inherit', timeout: 200_000 },
);
if (
  createHash('sha256').update(readFileSync(archive)).digest('hex') !==
  release.sha256
)
  throw new Error('The upstream pnpm archive failed its pinned SHA-256 check.');
execFileSync('tar', ['-xf', archive, '-C', directory], {
  stdio: 'inherit',
  timeout: 30_000,
});
rmSync(archive);
const binary = join(
  directory,
  process.platform === 'win32' ? 'pnpm.exe' : 'pnpm',
);
if (
  execFileSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
  }).trim() !== version
)
  throw new Error('The downloaded pnpm executable has the wrong version.');
appendFileSync(process.env.GITHUB_PATH, `${directory}\n`);
console.log(`Installed checksum-verified native pnpm ${version}.`);
