import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const executable = process.env.DESKTOP_EXECUTABLE;
test.skip(
  !executable,
  'Run after packaging with DESKTOP_EXECUTABLE set to the unpacked Windows executable.',
);
test('opens the actual packaged sandboxed editor without workspace runtime dependencies', async () => {
  if (!executable) throw new Error('The packaged executable is required.');
  const application = await electron.launch({ executablePath: executable });
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByText('Encrypted on this device', { exact: true }),
    ).toBeVisible();
    expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await expect(
      page.getByRole('button', { name: '+ New meeting', exact: true }),
    ).toBeEnabled();
    const resources = await application.evaluate(() => process.resourcesPath);
    expect(
      [
        'AudioHost.exe',
        'coreclr.dll',
        'hostfxr.dll',
        'System.Private.CoreLib.dll',
        'licenses/NAudio.txt',
        'licenses/ProtectedData.txt',
        'licenses/ProtectedData-THIRD-PARTY-NOTICES.txt',
        'licenses/dotnet/LICENSE.TXT',
        'licenses/dotnet/THIRD-PARTY-NOTICES.TXT',
      ].every((name) => existsSync(join(resources, 'audio-host', name))),
    ).toBe(true);
    const notices = readFileSync(
      join(resources, 'THIRD_PARTY_NOTICES.txt'),
      'utf8',
    );
    expect(notices).toContain('jose@');
    expect(notices).toContain('react@');
    expect(notices).toContain('Permission is hereby granted');
    const devices = await page.evaluate(async () => {
      const initial = await window.notes.invoke({ operation: 'bootstrap' });
      if (!initial.ok || !('state' in initial))
        throw new Error('No packaged desktop state.');
      return window.notes.invoke({
        operation: 'listAudioDevices',
        scope: initial.state.scope,
      });
    });
    expect(devices).toMatchObject({
      ok: true,
      audio_devices: { devices: expect.any(Array) },
    });
    const capacity = await page.evaluate(async () => {
      const current = await window.notes.invoke({ operation: 'bootstrap' });
      if (!current.ok || !('state' in current))
        throw new Error('No packaged state.');
      return window.notes.invoke({
        operation: 'checkAudioStorage',
        scope: current.state.scope,
      });
    });
    expect(capacity).toMatchObject({
      ok: true,
      audio_state: {
        state: {
          storage_quota_gib: 5,
          storage: {
            capacity: {
              quota_bytes: 5 * 1024 ** 3,
              state: 'ready',
              code: null,
            },
          },
        },
      },
    });
    await page
      .getByRole('button', { name: 'Audio devices', exact: true })
      .click();
    await expect(
      page.getByRole('heading', {
        name: 'Know what is listening.',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Refresh audio devices', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('heading', { name: 'Microphones', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'System audio', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'About & updates', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'About & updates.' }),
    ).toBeVisible();
    await expect(
      page.getByText('Updates are not enabled for this application package.'),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.notes.invokeUpdate({ operation: 'getState' }),
      ),
    ).toMatchObject({
      ok: true,
      state: { phase: 'disabled', installation_enabled: false },
    });
    await expect(
      page.getByRole('button', {
        name: /check for updates|download update|restart to update/i,
      }),
    ).toHaveCount(0);
    const closed = application.waitForEvent('close');
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await closed;
  } finally {
    await application.close();
  }
});
