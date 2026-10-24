import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { audioHostEnvironment } from '@windows-ai-notes/client/audio';
import { iconImages, readIconAssets, validateIconAssets } from '../icons.mjs';

const extractIcons = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeFileIcon {
  [StructLayout(LayoutKind.Sequential)]
  struct IconInfo {
    [MarshalAs(UnmanagedType.Bool)] public bool Icon;
    public uint X, Y;
    public IntPtr Mask, Color;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Bitmap {
    public int Type, Width, Height, WidthBytes;
    public ushort Planes, BitsPixel;
    public IntPtr Bits;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Header {
    public uint Size;
    public int Width, Height;
    public ushort Planes, BitCount;
    public uint Compression, SizeImage;
    public int XPels, YPels;
    public uint ColorsUsed, ColorsImportant;
  }
  public sealed class Result {
    public int Width, Height;
    public string Pixels;
  }
  [DllImport("shell32.dll", ExactSpelling=true, CharSet=CharSet.Unicode)]
  static extern int SHDefExtractIconW(string file, int index, uint flags,
    out IntPtr large, out IntPtr small, uint sizes);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  [DllImport("gdi32.dll", ExactSpelling=true)]
  static extern int GetObjectW(IntPtr bitmap, int size, out Bitmap result);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr value);
  [DllImport("gdi32.dll")]
  static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint start, uint count,
    [Out] byte[] pixels, ref Header info, uint usage);
  public static Result Read(string file) {
    IntPtr large = IntPtr.Zero, small = IntPtr.Zero, dc = IntPtr.Zero;
    IconInfo icon = new IconInfo();
    try {
      if (SHDefExtractIconW(file, 0, 0, out large, out small, (16u << 16) | 32u) != 0 ||
          large == IntPtr.Zero || !GetIconInfo(large, out icon) || icon.Color == IntPtr.Zero)
        throw new InvalidOperationException("Could not extract the file's native color icon: " + file);
      Bitmap bitmap;
      if (GetObjectW(icon.Color, Marshal.SizeOf(typeof(Bitmap)), out bitmap) == 0 ||
          bitmap.Width != 32 || bitmap.Height != 32)
        throw new InvalidOperationException("The native file icon is not 32px: " + file);
      dc = CreateCompatibleDC(IntPtr.Zero);
      if (dc == IntPtr.Zero) throw new InvalidOperationException("Could not create an icon read DC.");
      Header header = new Header {
        Size = (uint)Marshal.SizeOf(typeof(Header)), Width = 32, Height = -32,
        Planes = 1, BitCount = 32, SizeImage = 4096
      };
      byte[] pixels = new byte[4096];
      if (GetDIBits(dc, icon.Color, 0, 32, pixels, ref header, 0) != 32)
        throw new InvalidOperationException("Could not read the native icon pixels: " + file);
      return new Result {
        Width = bitmap.Width, Height = bitmap.Height,
        Pixels = Convert.ToBase64String(pixels)
      };
    } finally {
      bool released = true;
      if (dc != IntPtr.Zero) released &= DeleteDC(dc);
      if (icon.Color != IntPtr.Zero) released &= DeleteObject(icon.Color);
      if (icon.Mask != IntPtr.Zero) released &= DeleteObject(icon.Mask);
      if (large != IntPtr.Zero) released &= DestroyIcon(large);
      if (small != IntPtr.Zero && small != large) released &= DestroyIcon(small);
      if (!released) throw new InvalidOperationException("Could not release native icon resources.");
    }
  }
}
'@
$icons = @(foreach ($file in ($env:NOTES_ICON_FILES | ConvertFrom-Json)) {
  $result = [NativeFileIcon]::Read($file)
  [ordered]@{file=$file;width=$result.Width;height=$result.Height;pixels=$result.Pixels}
})
ConvertTo-Json -InputObject $icons -Compress
`;

export async function readNativeFileIcons(files: readonly string[]) {
  const programs = process.env.ProgramFiles;
  if (!programs)
    throw new Error('The Windows Program Files directory is required.');
  const { stdout, stderr } = await promisify(execFile)(
    join(programs, 'PowerShell', '7', 'pwsh.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', extractIcons],
    {
      env: {
        ...audioHostEnvironment(process.env),
        NOTES_ICON_FILES: JSON.stringify(files),
      },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
  if (stderr)
    throw new Error('Native file icon extraction emitted diagnostics.');
  return z
    .array(
      z.strictObject({
        file: z.string().min(1),
        width: z.literal(32),
        height: z.literal(32),
        pixels: z.string().length(5464),
      }),
    )
    .length(files.length)
    .parse(JSON.parse(stdout))
    .map(({ pixels, ...record }) => {
      const bytes = Buffer.from(pixels, 'base64');
      if (bytes.length !== 4096 || bytes.toString('base64') !== pixels)
        throw new Error('Native file icon pixels are invalid.');
      return { ...record, pixels: bytes };
    });
}

export async function assertAppIcon(
  application: ElectronApplication,
  page: Page,
  files: string[] = [],
) {
  const brand = page.locator('img.brand-mark');
  await expect(brand).toBeVisible();
  await expect(brand).toHaveAttribute('alt', '');
  await expect(brand).toHaveAttribute('aria-hidden', 'true');
  await expect
    .poll(() =>
      brand.evaluate((element) => {
        if (!(element instanceof HTMLImageElement)) return false;
        return (
          element.complete &&
          element.naturalWidth === 256 &&
          element.naturalHeight === 256
        );
      }),
    )
    .toBe(true);
  const assets = await readIconAssets();
  validateIconAssets(assets);
  const image = iconImages(assets.ico).find(({ size }) => size === 32);
  if (!image) throw new Error('The committed 32px Windows icon is missing.');
  // DIB rows are bottom-up; NativeImage exposes top-down, premultiplied BGRA.
  const bitmap = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    image.bitmap.copy(
      bitmap,
      y * 128,
      40 + (31 - y) * 128,
      40 + (32 - y) * 128,
    );
  for (let offset = 0; offset < bitmap.length; offset += 4)
    for (let channel = 0; channel < 3; channel++)
      bitmap[offset + channel] = Math.round(
        (bitmap[offset + channel] * bitmap[offset + 3]) / 255,
      );
  const points: [number, number][] = [
    [0, 0],
    [16, 4],
    [4, 16],
    [16, 28],
    [11, 19],
    [20, 19],
  ];
  const expectedSamples = points.map(([x, y]) =>
    bitmap.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4).toString('hex'),
  );
  const executable = await application.evaluate(({ app, nativeImage }, png) => {
    const original = nativeImage.createFromBuffer(Buffer.from(png, 'base64'));
    const { join } = process.getBuiltinModule('node:path');
    const windowIcon = nativeImage.createFromPath(
      join(app.getAppPath(), 'dist/renderer/app-icon.png'),
    );
    if (
      windowIcon.isEmpty() ||
      !windowIcon.toBitmap().equals(original.toBitmap())
    )
      throw new Error('The shipped window icon does not match its source.');
    return process.execPath;
  }, assets.png.toString('base64'));
  const iconFiles = [executable, ...files];
  const icons = async () =>
    (await readNativeFileIcons(iconFiles)).map(
      ({ file, width, height, pixels: bytes }) => ({
        file,
        empty: bytes.length === 0,
        size: { width, height },
        bytes: bytes.length,
        expectedBytes: bitmap.length,
        samples: points.map(([x, y]) =>
          bytes
            .subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)
            .toString('hex'),
        ),
        expectedSamples,
      }),
    );
  // Electron caches nonempty file icons, so polling it cannot refresh bad pixels.
  await expect
    .poll(icons, {
      message: `Native file icons must match the committed artwork: ${iconFiles.join(', ')}`,
    })
    .toEqual(
      iconFiles.map((file) => ({
        file,
        empty: false,
        size: { width: 32, height: 32 },
        bytes: 32 * 32 * 4,
        expectedBytes: 32 * 32 * 4,
        samples: expectedSamples,
        expectedSamples,
      })),
    );
}
