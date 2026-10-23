import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  cachedUpdateSchema,
  desktopUpdateResponseSchema,
  signedUpdateAcceptanceReceiptSchema,
  updateExpectationSchema,
  type DesktopUpdateState,
} from '@windows-ai-notes/contracts/updates';
import {
  verifyInstallerUpdateArtifact,
  verifyUpdateInstallation,
} from '../src/main/update-trust.js';
import {
  closeInstalled,
  closeObservedMain,
  desktopProbeEnvironment,
  runInstaller,
} from './installer-support.js';
import {
  acceptancePair,
  newWorkerOutcome,
  readAcceptanceMetadata,
  workerDirectories,
} from './signed-activation-support.js';

test.skip(
  process.platform !== 'win32' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.DESKTOP_SIGNED_ACTIVATION_PROBE !== '1',
  'Signed activation requires an explicitly authorized, isolated hosted Windows runner.',
);

test('activates a real signed compatible patch through bundled Main and preserves encrypted edits after authenticated restart', async () => {
  test.setTimeout(600_000);
  const desktop = fileURLToPath(new URL('../', import.meta.url));
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const candidates = join(repository, 'artifacts', 'desktop-signed');
  const metadata = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')));
  const configuration = z
    .object({ productName: z.string().min(1) })
    .parse(
      JSON.parse(
        await readFile(join(desktop, 'electron-builder.unsigned.json'), 'utf8'),
      ),
    );
  const pair = acceptancePair(
    await readAcceptanceMetadata(join(candidates, 'activation-pair.json')),
    process.env,
    configuration.productName,
    metadata.version,
  );
  const local = process.env.LOCALAPPDATA;
  if (!local)
    throw new Error(
      'Signed activation requires the actual Windows profile and PowerShell.',
    );
  const workers = join(local, 'WindowsAINotes.UpdateWorkers');
  const root = await mkdtemp(join(tmpdir(), 'notes-signed-activation-'));
  const installation = join(root, 'Installed signed application with spaces');
  const executable = join(installation, `${pair.policy.product_name}.exe`);
  const uninstaller = join(
    installation,
    `Uninstall ${pair.policy.product_name}.exe`,
  );
  const environment = desktopProbeEnvironment();
  const lifecycle: { application: ElectronApplication | null } = {
    application: null,
  };
  let installed = false;
  let uncertainHandoff = false;

  async function open(version: string) {
    const application = await electron.launch({
      executablePath: executable,
      env: environment,
    });
    lifecycle.application = application;
    application.on('close', () => {
      if (lifecycle.application === application) lifecycle.application = null;
    });
    const identity = await application.evaluate(({ app, safeStorage }) => ({
      version: app.getVersion(),
      directory: app.getPath('userData'),
      packaged: app.isPackaged,
      encrypted: safeStorage.isEncryptionAvailable(),
      resources: process.resourcesPath,
    }));
    expect(identity).toMatchObject({
      version,
      packaged: true,
      encrypted: true,
    });
    expect(identity.resources.toLowerCase()).toBe(
      join(installation, 'resources').toLowerCase(),
    );
    expect(
      JSON.parse(
        await readFile(join(identity.resources, 'update-policy.json'), 'utf8'),
      ),
    ).toEqual(pair.policy);
    expect(
      await verifyUpdateInstallation(
        join(identity.resources, 'audio-host', 'AudioHost.exe'),
        executable,
        version,
        pair.policy.product_name,
      ),
    ).toEqual({
      directory: installation,
      executable,
      application_version: version,
      product_name: pair.policy.product_name,
      architecture: 'x64',
    });
    const page = await application.firstWindow();
    await expect(
      page.getByRole('button', { name: '+ New meeting', exact: true }),
    ).toBeEnabled();
    return { application, page, identity };
  }
  async function stop() {
    const application = lifecycle.application;
    if (!application)
      throw new Error(
        'No controlled installed Main is available for normal close.',
      );
    await closeInstalled(application);
    expect(lifecycle.application).toBeNull();
  }
  async function selectedId(page: Page) {
    return page.evaluate(async () => {
      const response = await window.notes.invoke({ operation: 'bootstrap' });
      if (!response.ok || !('state' in response) || !response.state.selected_id)
        throw new Error('The encrypted meeting is unavailable after startup.');
      return response.state.selected_id;
    });
  }
  async function waitUpdates(
    page: Page,
    ready: (state: DesktopUpdateState) => boolean,
  ) {
    const deadline = Date.now() + 120_000;
    do {
      const response = desktopUpdateResponseSchema.parse(
        await page.evaluate(() =>
          window.notes.invokeUpdate({ operation: 'getState' }),
        ),
      );
      if (!response.ok) throw new Error(response.error.code);
      expect(response.state.installation_enabled).toBe(false);
      if (response.state.phase === 'failed')
        throw new Error(
          response.state.error?.code ?? 'Signed update recovery failed.',
        );
      if (ready(response.state)) return response.state;
      await delay(500);
    } while (Date.now() < deadline);
    throw new Error(
      'Actual Main did not finish the required update operation.',
    );
  }
  const fingerprint = async (file: string) =>
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  const title = 'Synthetic signed activation preservation fixture';
  const originalBody = 'Encrypted notes before genuine signed Main activation.';
  const activationBody =
    'Editor changes immediately before genuine Main update handoff.';
  const editedBody =
    'New encrypted edits after authenticated signed patch restart.';
  const marker = Buffer.from(randomUUID());

  try {
    await runInstaller(
      join(
        candidates,
        pair.current.application_version,
        pair.current.installer,
      ),
      ['/S', '/currentuser', `/D=${installation}`],
    );
    installed = true;
    let current = await open(pair.current.application_version);
    const data = current.identity.directory;
    await current.page
      .getByRole('button', { name: 'Create your first meeting' })
      .click();
    await current.page
      .getByRole('textbox', { name: 'Meeting title' })
      .fill(title);
    await current.page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill(originalBody);
    await current.page
      .getByRole('textbox', { name: 'Meeting tags' })
      .fill('Signed, Offline');
    await expect(
      current.page.getByText('SAVED LOCALLY', { exact: true }),
    ).toBeVisible();
    const documentId = await selectedId(current.page);
    const offeredInstaller = join(
      candidates,
      pair.offered.application_version,
      pair.offered.installer,
    );
    const expected = updateExpectationSchema.parse({
      current_version: pair.current.application_version,
      version: pair.offered.application_version,
      certificate_sha256: pair.policy.certificate_sha256,
      publisher: pair.policy.publisher,
      product_name: pair.policy.product_name,
      bytes: pair.offered.bytes,
      sha512: pair.offered.sha512,
    });
    expect(
      await verifyInstallerUpdateArtifact(
        join(current.identity.resources, 'audio-host', 'AudioHost.exe'),
        offeredInstaller,
        expected,
      ),
    ).toMatchObject({
      bytes: expected.bytes,
      sha512: expected.sha512,
      certificate_sha256: expected.certificate_sha256,
      publisher: expected.publisher,
      product_name: expected.product_name,
    });
    await stop();
    const key = join(data, 'content-key.protected');
    const keyDigest = await fingerprint(key);
    const recording = join(data, 'recordings', randomUUID());
    await mkdir(recording, { recursive: true });
    const partial = join(recording, 'synthetic-unique.partial');
    await writeFile(partial, marker, { flag: 'wx' });

    // This is untrusted cache input: only actual Main recovery may make it ready.
    const ready = join(
      data,
      'updates',
      `ready-${pair.offered.application_version}-${randomUUID()}`,
    );
    await mkdir(ready, { recursive: true });
    await copyFile(offeredInstaller, join(ready, pair.offered.installer));
    await writeFile(
      join(ready, 'verified-update.json'),
      JSON.stringify(
        cachedUpdateSchema.parse({
          version: 1,
          feed: pair.offered,
          expected,
          verified_at: new Date().toISOString(),
        }),
      ),
      { flag: 'wx' },
    );
    current = await open(pair.current.application_version);
    expect(current.identity.directory).toBe(data);
    const before = new Set(await workerDirectories(workers));
    const recovered = await waitUpdates(
      current.page,
      (state) => state.phase === 'ready',
    );
    expect(recovered.available_version).toBe(pair.offered.application_version);
    expect(
      await current.page.evaluate(() => 'activateReadyUpdate' in window.notes),
    ).toBe(false);
    await current.page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill(activationBody);
    const closed = current.application.waitForEvent('close', {
      timeout: 120_000,
    });
    uncertainHandoff = true;
    const invoked = current.application
      .evaluate(async ({ app }) => {
        const { join } = process.getBuiltinModule('node:path');
        const filename = join(app.getAppPath(), 'dist/main/main.js');
        const require = process
          .getBuiltinModule('node:module')
          .createRequire(filename);
        const main: typeof import('../src/main/main.js') = require(filename);
        await main.activateReadyUpdate();
      })
      .then(
        () => ({ acknowledged: true as const }),
        (error: unknown) => ({ acknowledged: false as const, error }),
      );
    await closed;
    const invocation = await invoked;
    if (
      !invocation.acknowledged &&
      !(
        invocation.error instanceof Error &&
        invocation.error.message.includes(
          'Target page, context or browser has been closed',
        )
      )
    )
      throw invocation.error;
    expect(lifecycle.application).toBeNull();

    const deadline = Date.now() + 180_000;
    let outcome = await newWorkerOutcome(workers, before, pair);
    while (outcome?.phase !== 'healthy' && Date.now() < deadline) {
      await delay(1_000);
      outcome = await newWorkerOutcome(workers, before, pair);
    }
    if (outcome?.phase !== 'healthy' || !outcome.restart)
      throw new Error(
        'The real worker did not record an authenticated healthy restart within its acceptance bound.',
      );
    await closeObservedMain(outcome.restart.identity, executable);
    current = await open(pair.offered.application_version);
    expect(current.identity.directory).toBe(data);
    let inspected = await waitUpdates(
      current.page,
      (state) => state.can_inspect,
    );
    const inspectionDeadline = Date.now() + 60_000;
    do {
      const inspection = desktopUpdateResponseSchema.parse(
        await current.page.evaluate(() =>
          window.notes.invokeUpdate({ operation: 'inspect' }),
        ),
      );
      if (!inspection.ok) throw new Error(inspection.error.code);
      inspected = await waitUpdates(current.page, (state) => state.can_inspect);
      if (inspected.inspection) break;
      if (inspected.error?.code !== 'update_worker_busy')
        throw new Error(
          inspected.error?.code ??
            'Native recovery inspection returned no report.',
        );
      console.error(
        'Native update maintenance is busy; retrying read-only inspection within its acceptance bound.',
      );
      await delay(500);
    } while (Date.now() < inspectionDeadline);
    expect(inspected.inspection).toMatchObject({
      status: 'complete',
      unverifiable: 0,
      limited: false,
      omitted: 0,
      sessions: expect.arrayContaining([
        expect.objectContaining({
          session_id: outcome.session_id,
          status: 'healthy',
          current_version: pair.current.application_version,
          offered_version: pair.offered.application_version,
          code: 'update_worker_healthy',
        }),
      ]),
    });
    // Actual Main's locked, DPAPI-validating inspection, not plain JSON, establishes recorded health.
    uncertainHandoff = false;
    async function preserved(body: string) {
      expect(await selectedId(current.page)).toBe(documentId);
      await expect(
        current.page.getByRole('textbox', { name: 'Meeting title' }),
      ).toHaveValue(title);
      await expect(
        current.page.getByRole('textbox', {
          name: 'Meeting notes',
          exact: true,
        }),
      ).toHaveText(body);
      await expect(
        current.page.getByRole('textbox', { name: 'Meeting tags' }),
      ).toHaveValue('Signed, Offline');
      expect(await fingerprint(key)).toBe(keyDigest);
      expect(await readFile(partial)).toEqual(marker);
    }
    await preserved(activationBody);
    await current.page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill(editedBody);
    await expect(
      current.page.getByText('SAVED LOCALLY', { exact: true }),
    ).toBeVisible();
    await stop();
    current = await open(pair.offered.application_version);
    await preserved(editedBody);
    await stop();
    for (const name of await readdir(data)) {
      if (name !== 'content-key.protected' && !name.startsWith('notes.sqlite'))
        continue;
      const bytes = await readFile(join(data, name));
      for (const text of [title, originalBody, activationBody, editedBody])
        expect(bytes.includes(Buffer.from(text))).toBe(false);
    }
    const receipt = signedUpdateAcceptanceReceiptSchema.parse({
      version: 1,
      kind: 'signed_activation_acceptance',
      pair,
      verified_at: new Date().toISOString(),
      session_id: outcome.session_id,
      storage_schema: outcome.restart.storage_schema,
      delivery: 'preseeded_cache',
      production_accepted: false,
    });
    await runInstaller(uninstaller, [
      '/S',
      '/currentuser',
      `_?=${installation}`,
    ]);
    await expect.poll(() => existsSync(executable)).toBe(false);
    installed = false;
    expect(await fingerprint(key)).toBe(keyDigest);
    expect(await readFile(partial)).toEqual(marker);
    await writeFile(
      join(candidates, 'activation-acceptance.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { flag: 'wx' },
    );
  } finally {
    if (lifecycle.application) await closeInstalled(lifecycle.application);
    if (!uncertainHandoff) {
      if (installed)
        await runInstaller(uninstaller, [
          '/S',
          '/currentuser',
          `_?=${installation}`,
        ]);
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } else {
      console.error(
        'Signed activation remains uncertain; installer, fresh Main and recovery files were not forcibly removed.',
      );
    }
  }
});
