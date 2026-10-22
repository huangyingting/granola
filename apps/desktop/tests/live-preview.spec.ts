import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  audioStateSchema,
  livePreviewSchema,
  localRecordingSchema,
  type AudioState,
} from '@windows-ai-notes/contracts/recording';

test.skip(
  process.platform !== 'win32',
  'Requires a real sandboxed Windows Electron renderer.',
);
async function launch(presentations = false) {
  const directory = await mkdtemp(join(tmpdir(), 'notes-live-ui-'));
  let application: ElectronApplication | undefined;
  const recording = localRecordingSchema.parse({
    id: randomUUID(),
    document_id: randomUUID(),
    created_at: new Date().toISOString(),
    state: 'recording',
    error: null,
    inspection: null,
    tracks: ['microphone', 'loopback'].map((kind) => ({
      spec: {
        track_id: randomUUID(),
        kind,
        capture_scope: 'endpoint',
        device_selection_policy: 'explicit',
        device_id: `synthetic-${kind}`,
      },
      actual_device_id: `synthetic-${kind}`,
      saved_samples: 16_000,
    })),
  });
  const audio = audioStateSchema.parse({
    document_id: recording.document_id,
    active: recording,
    recordings: [recording],
    busy: false,
    pending_deletions: 0,
    error: null,
    cleanup_error: null,
    has_more: false,
    offset: 0,
    upload_available: true,
    upload_destination: 'https://notes.example.test',
  });
  const source = {
    recording_id: recording.id,
    preview_id: randomUUID(),
    capture_epoch: randomUUID(),
    track_id: recording.tracks[0]!.spec.track_id,
  };
  const live = livePreviewSchema.parse({
    document_id: recording.document_id,
    recording_id: recording.id,
    locale: 'en-US',
    phase: 'live',
    running: true,
    attempt: 1,
    canonical: false,
    continuity: 'unverified',
    usage_status: 'check_account',
    sources: [],
    segments: [],
    boundaries: [{ attempt: 1, reason: 'started' }],
    gaps: [],
    omitted: false,
    error: null,
  });
  try {
    await build({
      entryPoints: [
        fileURLToPath(new URL('./fixtures/live-preview.tsx', import.meta.url)),
      ],
      outfile: join(directory, 'live-preview.js'),
      bundle: true,
      platform: 'browser',
      target: 'chrome140',
      jsx: 'automatic',
    });
    await copyFile(
      new URL('./fixtures/live-preview.html', import.meta.url),
      join(directory, 'index.html'),
    );
    await writeFile(
      join(directory, 'fixture.json'),
      JSON.stringify({ audio, live, presentations }),
    );
    application = await electron.launch({
      timeout: 15_000,
      args: [
        fileURLToPath(
          new URL('./fixtures/live-preview-main.mjs', import.meta.url),
        ),
      ],
      env: { ...process.env, NOTES_LIVE_UI_FIXTURE: directory },
    });
    return {
      directory,
      application,
      page: await application.firstWindow({ timeout: 10_000 }),
      recording,
      audio,
      live,
      source,
    };
  } catch (error) {
    try {
      await application?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
async function publish(application: ElectronApplication, audio: AudioState) {
  await application.evaluate(({ ipcMain }, value) => {
    ipcMain.emit('fixture:audio', {}, value);
  }, audioStateSchema.parse(audio));
}
async function commands(application: ElectronApplication) {
  return application.evaluate(({ ipcMain }) => {
    const result: { commands: unknown[] } = { commands: [] };
    ipcMain.emit('fixture:commands', result);
    return result.commands;
  });
}
test('requires fresh inline consent, validates through the real preload, and sends only scoped start/stop commands', async () => {
  const f = await launch();
  try {
    await f.page
      .getByRole('button', { name: 'Preview speech live', exact: true })
      .click();
    const confirm = f.page.getByRole('button', {
      name: 'Confirm live preview',
      exact: true,
    });
    test('acknowledges actual caption text once, never collapsed, hidden, offscreen or superseded content', async () => {
      const f = await launch(true);
      try {
        const marker = () => ({
          token: randomUUID(),
          kind: 'live_caption' as const,
          operation_id: randomUUID(),
        });
        const first = marker();
        const caption = async (presentation: ReturnType<typeof marker>) => {
          await publish(f.application, {
            ...f.audio,
            live: {
              ...f.live,
              segments: [
                {
                  attempt: 1,
                  presentation,
                  event: {
                    schema_version: 1,
                    event_type: 'transcript.partial',
                    provider_epoch: presentation.operation_id,
                    source: f.source,
                    segment_id: randomUUID(),
                    version: 1,
                    sample_start: 0,
                    sample_end: 800,
                    text: 'Synthetic visible caption.',
                    discard_reason: null,
                    provider_result_id: 'synthetic-presentation-fixture',
                  },
                },
              ],
            },
          });
          await expect(
            f.page.locator(`[data-presentation-token="${presentation.token}"]`),
          ).toHaveCount(1);
        };
        const frames = () =>
          f.page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
        await caption(first);
        await frames();
        expect(await commands(f.application)).toEqual([]);
        await f.page
          .getByText('Caption visibility fixture', { exact: true })
          .click();
        await f.page
          .locator(`[data-presentation-token="${first.token}"]`)
          .scrollIntoViewIfNeeded();
        await expect
          .poll(() => commands(f.application))
          .toEqual([
            {
              operation: 'observePresentation',
              scope: 7,
              id: f.recording.document_id,
              token: first.token,
            },
          ]);
        await frames();
        expect(await commands(f.application)).toHaveLength(1);
        let style = await f.page.addStyleTag({
          content: '[data-presentation-token] { display:none !important; }',
        });
        const replaced = marker(),
          replacement = marker();
        await caption(replaced);
        await frames();
        await caption(replacement);
        await frames();
        expect(await commands(f.application)).toHaveLength(1);
        await style.evaluate((element) =>
          element.parentNode?.removeChild(element),
        );
        await f.page
          .locator(`[data-presentation-token="${replacement.token}"]`)
          .scrollIntoViewIfNeeded();
        await expect
          .poll(async () => (await commands(f.application)).length)
          .toBe(2);
        expect(await commands(f.application)).not.toContainEqual(
          expect.objectContaining({ token: replaced.token }),
        );
        style = await f.page.addStyleTag({
          content:
            '[data-presentation-token] { position:relative;top:2000px; }',
        });
        const offscreen = marker();
        await caption(offscreen);
        await frames();
        expect(await commands(f.application)).toHaveLength(2);
        await style.evaluate((element) =>
          element.parentNode?.removeChild(element),
        );
        await expect
          .poll(async () => (await commands(f.application)).length)
          .toBe(3);
        await f.page.addStyleTag({
          content: '[data-presentation-token] { display:none !important; }',
        });
        const unmounted = marker();
        await caption(unmounted);
        await f.page.evaluate(() => {
          window.location.hash = 'unmount';
        });
        await expect(f.page.locator('[data-presentation-token]')).toHaveCount(
          0,
        );
        await frames();
        expect(await commands(f.application)).toHaveLength(3);
      } finally {
        await f.application.close();
        await rm(f.directory, { recursive: true, force: true });
      }
    });
    await expect(confirm).toBeDisabled();
    await expect(
      f.page.getByText(
        /This does not upload saved audio or authorize final transcription/,
      ),
    ).toBeVisible();
    await f.page.getByRole('button', { name: 'Not now', exact: true }).click();
    expect(await commands(f.application)).toEqual([]);
    const rejected = await f.page.evaluate(
      async ({ document, recording }) => {
        try {
          await window.notes.invoke(
            JSON.parse(
              JSON.stringify({
                operation: 'startLivePreview',
                scope: 7,
                id: document,
                recording_id: recording,
                locale: 'en-US',
                confirmed: false,
              }),
            ),
          );
          return false;
        } catch {
          return true;
        }
      },
      { document: f.recording.document_id, recording: f.recording.id },
    );
    expect(rejected).toBe(true);
    expect(await commands(f.application)).toEqual([]);
    await f.page
      .getByRole('button', { name: 'Preview speech live', exact: true })
      .click();
    await f.page
      .getByLabel('Live preview language', { exact: true })
      .selectOption('zh-CN');
    await f.page
      .getByRole('checkbox', { name: /I consent to sending live/ })
      .check();
    await confirm.click();
    await expect(
      f.page.getByRole('button', { name: 'Stop live preview', exact: true }),
    ).toBeVisible();
    expect(await commands(f.application)).toEqual([
      {
        operation: 'startLivePreview',
        scope: 7,
        id: f.recording.document_id,
        recording_id: f.recording.id,
        locale: 'zh-CN',
        confirmed: true,
      },
    ]);
    await f.page
      .getByRole('button', { name: 'Stop live preview', exact: true })
      .click();
    await f.page
      .getByRole('button', { name: 'Start a new live preview', exact: true })
      .click();
    await expect(confirm).toBeDisabled();
    expect((await commands(f.application)).length).toBe(2);
  } finally {
    await f.application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
test('shows provisional sources, explicit boundaries and uncertain usage while retaining healthy capture controls on cloud failure', async () => {
  const f = await launch();
  try {
    const live = {
      ...f.live,
      attempt: 2,
      omitted: true,
      boundaries: [
        ...f.live.boundaries,
        { attempt: 2, reason: 'normal_rotation' as const },
      ],
      gaps: [
        {
          attempt: 1,
          source: f.source,
          sample_start: 1600,
          sample_end: 3200,
          reason: 'startup' as const,
        },
      ],
      segments: f.recording.tracks.map((track, index) => ({
        attempt: index + 1,
        event: {
          schema_version: 1 as const,
          event_type: 'transcript.partial' as const,
          source: { ...f.source, track_id: track.spec.track_id },
          provider_epoch: randomUUID(),
          segment_id: randomUUID(),
          version: 1,
          sample_start: 3200,
          sample_end: 4000,
          text: `Synthetic provisional source ${index + 1}.`,
          discard_reason: null,
          provider_result_id: `synthetic-${index}`,
        },
      })),
    };
    await publish(f.application, { ...f.audio, live });
    const captions = f.page.getByLabel('Provisional live captions', {
      exact: true,
    });
    await expect(captions).toContainText('Microphone - Preview segment 1');
    await expect(captions).toContainText('System audio - Preview segment 2');
    await expect(captions).toContainText('Synthetic provisional source 2.');
    await expect(f.page.getByText(/Usage may remain reserved/)).toBeVisible();
    await f.page
      .getByText('Preview boundaries and skipped audio', { exact: true })
      .click();
    await expect(
      f.page.getByText(/0.10-0.20s of source audio skipped/),
    ).toBeVisible();
    await expect(
      f.page.getByText(/new bounded provider attempt/),
    ).toBeVisible();
    await expect(
      f.page.getByText(/Earlier preview details were removed/),
    ).toBeVisible();
    await publish(f.application, {
      ...f.audio,
      live: {
        ...live,
        phase: 'attention',
        running: false,
        error: {
          code: 'live_connection_lost',
          message: 'Synthetic cloud failure. Local recording continues.',
        },
      },
    });
    await expect(f.page.getByRole('alert')).toContainText(
      'Synthetic cloud failure',
    );
    await expect(
      f.page.getByRole('button', { name: 'Pause recording', exact: true }),
    ).toBeEnabled();
    await expect(
      f.page.getByRole('button', { name: 'Stop recording', exact: true }),
    ).toBeEnabled();
    await expect(
      f.page.getByText('Cloud live preview enabled', { exact: true }),
    ).toHaveCount(0);
    await f.page.evaluate((id) => {
      window.location.hash = id;
    }, randomUUID());
    await expect(
      f.page.getByLabel('Provisional live captions', { exact: true }),
    ).toHaveCount(0);
    await expect(
      f.page.getByRole('button', { name: 'Pause recording', exact: true }),
    ).toBeEnabled();
  } finally {
    await f.application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
