import { _electron as electron, expect, test } from '@playwright/test';

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
    const closed = application.waitForEvent('close');
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await closed;
  } finally {
    await application.close();
  }
});
