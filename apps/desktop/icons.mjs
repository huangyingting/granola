import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

export const iconSizes = Object.freeze([16, 24, 32, 48, 64, 128, 256]);
const files = {
  svg: new URL('./src/renderer/public/app-icon.svg', import.meta.url),
  png: new URL('./src/renderer/public/app-icon.png', import.meta.url),
  ico: new URL('./build/app-icon.ico', import.meta.url),
  manifest: new URL('./build/app-icon-manifest.json', import.meta.url),
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const manifestSchema = z.strictObject({
  version: z.literal(1),
  source_sha256: hash,
  png_sha256: hash,
  ico_sha256: hash,
});
function invalid() {
  throw new Error(
    'desktop_icon_invalid: Desktop icon assets are invalid or stale. Regenerate them with pnpm --filter @windows-ai-notes/desktop icons.',
  );
}
function checkPng(png, size) {
  if (
    !Buffer.isBuffer(png) ||
    png.length < 33 ||
    png.length > 1024 * 1024 ||
    png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    png.readUInt32BE(8) !== 13 ||
    png.toString('ascii', 12, 16) !== 'IHDR' ||
    png.readUInt32BE(16) !== size ||
    png.readUInt32BE(20) !== size ||
    png[24] !== 8 ||
    png[25] !== 6 ||
    png.subarray(-12).toString('hex') !== '0000000049454e44ae426082'
  )
    invalid();
}
export function iconImages(ico) {
  const header = 6 + iconSizes.length * 16;
  if (
    !Buffer.isBuffer(ico) ||
    ico.length < header ||
    ico.length > 1024 * 1024 ||
    ico.readUInt16LE(0) !== 0 ||
    ico.readUInt16LE(2) !== 1 ||
    ico.readUInt16LE(4) !== iconSizes.length
  )
    invalid();
  let offset = header;
  const images = iconSizes.map((size, index) => {
    const entry = 6 + index * 16;
    const length = ico.readUInt32LE(entry + 8);
    if (
      ico[entry] !== (size === 256 ? 0 : size) ||
      ico[entry + 1] !== ico[entry] ||
      ico[entry + 2] !== 0 ||
      ico[entry + 3] !== 0 ||
      ico.readUInt16LE(entry + 4) !== 1 ||
      ico.readUInt16LE(entry + 6) !== 32 ||
      ico.readUInt32LE(entry + 12) !== offset ||
      length === 0 ||
      length > ico.length - offset
    )
      invalid();
    const bitmap = ico.subarray(offset, offset + length);
    if (
      length !== 40 + size * size * 4 + Math.ceil(size / 32) * 4 * size ||
      bitmap.readUInt32LE(0) !== 40 ||
      bitmap.readInt32LE(4) !== size ||
      bitmap.readInt32LE(8) !== size * 2 ||
      bitmap.readUInt16LE(12) !== 1 ||
      bitmap.readUInt16LE(14) !== 32 ||
      bitmap.readUInt32LE(16) !== 0
    )
      invalid();
    offset += length;
    return { size, bitmap };
  });
  if (offset !== ico.length) invalid();
  return images;
}
export function validateIconAssets(assets) {
  const manifest = manifestSchema.parse(assets.manifest);
  if (
    !Buffer.isBuffer(assets.svg) ||
    assets.svg.length === 0 ||
    assets.svg.length > 16_384 ||
    digest(assets.svg) !== manifest.source_sha256 ||
    digest(assets.png) !== manifest.png_sha256 ||
    digest(assets.ico) !== manifest.ico_sha256
  )
    invalid();
  checkPng(assets.png, 256);
  iconImages(assets.ico);
}
export async function readIconAssets() {
  const [svg, png, ico, manifest] = await Promise.all(
    [files.svg, files.png, files.ico, files.manifest].map((file) =>
      readFile(file),
    ),
  );
  return { svg, png, ico, manifest: JSON.parse(manifest.toString('utf8')) };
}
export async function verifyDesktopIcons() {
  validateIconAssets(await readIconAssets());
  const config = JSON.parse(
    await readFile(
      new URL('./electron-builder.unsigned.json', import.meta.url),
      'utf8',
    ),
  );
  if (
    config.win?.icon !== 'build/app-icon.ico' ||
    config.nsis?.installerIcon !== 'build/app-icon.ico' ||
    config.nsis?.uninstallerIcon !== 'build/app-icon.ico'
  )
    invalid();
}
async function generateIcons() {
  const command = process.platform === 'win32' ? 'magick' : 'convert';
  const run = promisify(execFile);
  const { stdout: version } = await run(command, ['-version'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 16_384,
  });
  if (!version.startsWith('Version: ImageMagick '))
    throw new Error('ImageMagick is required to regenerate desktop icons.');
  const svg = await readFile(files.svg);
  const limits = [
    '-limit',
    'thread',
    '1',
    '-limit',
    'memory',
    '32MiB',
    '-limit',
    'map',
    '64MiB',
  ];
  const render = (size) => [
    '-background',
    'none',
    '-density',
    '384',
    fileURLToPath(files.svg),
    '-resize',
    `${size}x${size}`,
  ];
  const options = {
    encoding: 'buffer',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  };
  const [{ stdout: png }, { stdout: ico }] = await Promise.all([
    run(command, [...limits, ...render(256), '-strip', 'PNG32:-'], options),
    run(
      command,
      [
        ...limits,
        ...iconSizes.flatMap((size) => ['(', ...render(size), ')']),
        '-strip',
        '-compress',
        'none',
        'ICO:-',
      ],
      options,
    ),
  ]);
  const manifest = {
    version: 1,
    source_sha256: digest(svg),
    png_sha256: digest(png),
    ico_sha256: digest(ico),
  };
  validateIconAssets({ svg, png, ico, manifest });
  await mkdir(new URL('./build/', import.meta.url), { recursive: true });
  await Promise.all([
    writeFile(files.png, png),
    writeFile(files.ico, ico),
    writeFile(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
  console.log('Generated first-party SVG-derived desktop icon assets.');
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await generateIcons();
