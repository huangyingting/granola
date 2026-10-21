import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopFixture } from '../../../packages/client/src/desktop.fixture.js';

test.skip(
  process.platform !== 'win32',
  'Real Windows DPAPI and the sandboxed Electron renderer are required.',
);
async function launch(directory: string) {
  const application = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WINDOWS_NOTES_DATA_DIR: directory,
      WINDOWS_NOTES_ALLOW_LOOPBACK: '1',
    },
  });
  await application.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      const response = await fetch(url, { redirect: 'manual' });
      const redirect = response.headers.get('location');
      if (!redirect) throw new Error('The synthetic issuer did not redirect.');
      const callback = await fetch(redirect);
      if (!callback.ok)
        throw new Error('The native loopback callback rejected sign-in.');
      await callback.arrayBuffer();
    };
  });
  return application;
}
async function close(application: ElectronApplication) {
  const closed = application.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.close(),
  );
  await closed;
}
async function synchronize(application: ElectronApplication) {
  const page = await application.firstWindow();
  return page.evaluate(async () => {
    const current = await window.notes.invoke({ operation: 'bootstrap' });
    if (!current.ok || !('state' in current))
      throw new Error('No desktop state.');
    return window.notes.invoke({
      operation: 'sync',
      scope: current.state.scope,
    });
  });
}
test('recovers one consented summary, inspects frozen evidence, persists review edits and explicitly appends and exports without replacing notes', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-summary-ui-'));
  const fixture = await desktopFixture();
  const remote = fixture.seed(
    'Original frozen UI note evidence.',
    'Frozen UI transcript evidence.',
  );
  let application: ElectronApplication | null = null;
  const reviewed = 'A deliberately reviewed UI summary [1].';
  try {
    application = await launch(directory);
    let page = await application.firstWindow();
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await page.getByRole('textbox', { name: 'Service URL' }).fill(fixture.url);
    await page
      .getByRole('button', { name: 'Sign in with browser', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: /^Synthetic cloud workspace (Open workspace|Current workspace)$/,
      })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText(remote.notes);
    await page
      .getByRole('button', { name: 'Generate summary', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Generate cited draft', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('button', { name: 'Keep writing', exact: true })
      .click();
    expect(fixture.state.jobs.size).toBe(0);
    await page
      .getByRole('button', { name: 'Generate summary', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Summary language' })
      .selectOption('zh');
    await page
      .getByRole('checkbox', {
        name: 'I agree to Azure processing for this summary.',
      })
      .check();
    fixture.state.lose_summary_response = true;
    await page
      .getByRole('button', { name: 'Generate cited draft', exact: true })
      .click();
    await expect.poll(() => fixture.state.jobs.size).toBe(1);
    await expect(
      page.getByRole('button', { name: 'Recover saved summary request' }),
    ).toBeVisible();
    await close(application);
    application = null;
    application = await launch(directory);
    page = await application.firstWindow();
    await page
      .getByRole('button', { name: 'Recover saved summary request' })
      .click();
    await expect(
      page.getByRole('combobox', { name: 'Summary language' }),
    ).toHaveValue('zh');
    await page
      .getByRole('checkbox', {
        name: 'Recover the original authorized request, submitting it if its receipt was lost.',
      })
      .check();
    await page
      .getByRole('button', { name: 'Recover request', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Recover request', exact: true }),
    ).toHaveCount(0);
    expect(fixture.state.jobs.size).toBe(1);
    const job = [...fixture.state.jobs.values()][0]!;
    fixture.change(remote.id, 'Newer human cloud notes remain authoritative.');
    fixture.publishSummary(job.id);
    await synchronize(application);
    await expect(
      page.getByText('Synthetic generated summary for review.', {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Inspect source 1', exact: true })
      .first()
      .click();
    let source = page.getByRole('complementary', {
      name: 'Frozen summary source',
    });
    await expect(source).toContainText(remote.notes);
    await expect(source).not.toContainText('Newer human cloud notes');
    await page
      .getByRole('button', { name: 'Close source', exact: true })
      .click();
    await page
      .locator('.summary-panel summary')
      .filter({ hasText: 'Action items' })
      .click();
    await expect(
      page.getByText('Owner: Not specified - Due: Not specified', {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .locator('.summary-panel summary')
      .filter({ hasText: 'Decisions' })
      .click();
    await page
      .getByRole('button', { name: 'Inspect source 2', exact: true })
      .click();
    await expect(source).toContainText('Frozen UI transcript evidence.');
    await page
      .getByRole('button', { name: 'Close source', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Review and edit draft', exact: true })
      .click();
    let editor = page.getByRole('region', {
      name: 'Editable summary review',
      exact: true,
    });
    await expect(
      editor.getByRole('textbox', { name: 'Summary review text' }),
    ).toBeEnabled();
    await editor.getByRole('textbox', { name: 'Summary review text' }).fill('');
    await expect(editor.getByRole('alert')).toContainText(
      'have not been saved',
    );
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await expect(editor).toBeVisible();
    await editor
      .getByRole('textbox', { name: 'Summary review text' })
      .fill(reviewed);
    await expect(editor.getByRole('status')).toHaveText(
      'Encrypted local draft',
    );
    await close(application);
    application = null;
    application = await launch(directory);
    page = await application.firstWindow();
    await page
      .getByRole('button', { name: 'Review and edit draft', exact: true })
      .click();
    editor = page.getByRole('region', {
      name: 'Editable summary review',
      exact: true,
    });
    await expect(
      editor.getByRole('textbox', { name: 'Summary review text' }),
    ).toHaveValue(reviewed);
    fixture.state.summary_online = false;
    await page
      .getByRole('button', { name: 'Inspect source 1', exact: true })
      .first()
      .click();
    source = page.getByRole('complementary', { name: 'Frozen summary source' });
    await expect(source).toContainText(remote.notes);
    const human =
      'Another human edit must survive applying the generated review.';
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill(human);
    await expect(
      editor.getByRole('button', {
        name: 'Use latest notes as append baseline',
      }),
    ).toBeVisible();
    await expect(
      editor.getByRole('button', { name: 'Append reviewed summary' }),
    ).toBeDisabled();
    await editor
      .getByRole('button', { name: 'Use latest notes as append baseline' })
      .click();
    await expect(
      editor.getByRole('button', {
        name: 'Use latest notes as append baseline',
      }),
    ).toHaveCount(0);
    await editor
      .getByRole('checkbox', {
        name: 'Append this reviewed draft without replacing my existing notes.',
      })
      .check();
    await editor
      .getByRole('button', { name: 'Append reviewed summary' })
      .click();
    await expect(editor.getByText(/Appended once/)).toBeVisible();
    const notes = page.getByRole('textbox', {
      name: 'Meeting notes',
      exact: true,
    });
    await expect(notes).toContainText(human);
    await expect(notes).toContainText(reviewed);
    expect((await notes.innerText()).split(reviewed)).toHaveLength(2);
    await expect(
      editor.getByRole('textbox', { name: 'Summary review text' }),
    ).toBeDisabled();
    const destination = join(directory, 'reviewed-summary.txt');
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, destination);
    await editor
      .getByRole('combobox', { name: 'Summary export format' })
      .selectOption('text');
    await editor.getByRole('button', { name: 'Export reviewed draft' }).click();
    await expect(
      page.getByText('Unencrypted export saved.', { exact: true }),
    ).toBeVisible();
    const exported = await readFile(destination, 'utf8');
    expect(exported).toContain(reviewed);
    expect(exported).toContain(`Note ${remote.id}, revision 1`);
    expect(exported).not.toContain(human);
    expect(fixture.state.jobs.size).toBe(1);
    fixture.state.summary_online = true;
    await page
      .getByRole('button', { name: 'New summary', exact: true })
      .click();
    await page
      .getByRole('checkbox', {
        name: 'I agree to Azure processing for this summary.',
      })
      .check();
    await page
      .getByRole('button', { name: 'Generate cited draft', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Generate cited draft', exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => fixture.state.jobs.size).toBe(2);
    const next = [...fixture.state.jobs.values()].find(
      (item) => item.id !== job.id,
    )!;
    fixture.publishSummary(next.id);
    await synchronize(application);
    await page
      .getByRole('button', { name: 'Inspect source 1', exact: true })
      .first()
      .click();
    await expect(
      page.getByRole('complementary', { name: 'Frozen summary source' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Review and edit draft', exact: true })
      .click();
    await page.getByRole('textbox', { name: 'Summary review text' }).fill('');
    await expect(
      page
        .getByRole('region', { name: 'Editable summary review' })
        .getByRole('alert'),
    ).toContainText('have not been saved');
    fixture.remove(remote.id);
    await synchronize(application);
    await expect(
      page.getByRole('complementary', { name: 'Frozen summary source' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('textbox', { name: 'Summary review text' }),
    ).toHaveCount(0);
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await fixture.close();
    expect(fixture.state.failures).toEqual([]);
    expect(fixture.issuer.state.failures).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  }
});

async function savedRecording(
  application: ElectronApplication,
  directory: string,
  id: string,
  uploaded = false,
) {
  return application.evaluate(
    ({ safeStorage }, { directory, id, uploaded }) => {
      const { readFileSync } = process.getBuiltinModule('node:fs');
      const { join } = process.getBuiltinModule('node:path');
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
      const { createHash } = process.getBuiltinModule('node:crypto');
      const require = process
        .getBuiltinModule('node:module')
        .createRequire(join(process.cwd(), 'synthetic-upload-fixture.cjs'));
      const {
        LocalStore,
      }: typeof import('@windows-ai-notes/local') = require('@windows-ai-notes/local');
      const {
        canonicalJson,
      }: typeof import('@windows-ai-notes/contracts/content') = require('@windows-ai-notes/contracts/content');
      const path = join(directory, 'notes.sqlite');
      const inspect = new DatabaseSync(path, { readOnly: true });
      let profile: unknown;
      try {
        profile = inspect
          .prepare('SELECT profile FROM drafts WHERE id=?')
          .get(id)?.profile;
      } finally {
        inspect.close();
      }
      if (typeof profile !== 'string')
        throw new Error('The synthetic cloud meeting has no cached profile.');
      const key = Buffer.from(
        safeStorage.decryptString(
          readFileSync(join(directory, 'content-key.protected')),
        ),
        'base64',
      );
      try {
        const local = new LocalStore(path, key);
        try {
          const spec = {
            track_id: crypto.randomUUID(),
            kind: 'microphone' as const,
            capture_scope: 'endpoint' as const,
            device_selection_policy: 'explicit' as const,
            device_id: 'synthetic-unavailable-source',
          };
          const value = local.beginRecording(profile, id, [spec]);
          local.updateRecording(profile, id, value.id, {
            state: uploaded ? 'failed' : 'interrupted',
          });
          const chunk = {
            chunk: {
              format_version: 1 as const,
              recording_id: value.id,
              track_id: spec.track_id,
              chunk_id: crypto.randomUUID(),
              capture_epoch: crypto.randomUUID(),
              sequence: 0,
              sample_start: 0,
              sample_count: 16000,
              sample_rate: 16000 as const,
              channels: 1 as const,
              bits_per_sample: 16 as const,
              clock_start_ms: 0,
              clock_end_ms: 1000,
              pcm_sha256: 'a'.repeat(64),
            },
            size_bytes: 32044,
            sha256: 'b'.repeat(64),
          };
          const seal = {
            native_state: 'failed' as const,
            accept_incomplete: true,
            tracks: [
              {
                track_id: spec.track_id,
                end_sample: 16000,
                chunk_ids: [chunk.chunk.chunk_id],
              },
            ],
            events: [
              {
                event_type: 'capture.started' as const,
                clock_ms: 0,
                capture_epoch: chunk.chunk.capture_epoch,
                code: null,
              },
            ],
            gaps: [
              {
                track_id: spec.track_id,
                start_ms: 500,
                end_ms: 900,
                reason: 'paused' as const,
              },
            ],
          };
          if (uploaded)
            local.saveRecordingUpload(profile, {
              recording_id: value.id,
              document_id: id,
              state: 'complete',
              verified_chunks: 1,
              total_chunks: 1,
              verified_bytes: 32044,
              partial: true,
              attempts: 1,
              retry_at: 0,
              error: null,
              accept_incomplete: true,
              plan: {
                create: {
                  id: value.id,
                  created_at: value.created_at,
                  tracks: [{ spec, actual_device_id: spec.device_id }],
                },
                chunks: [chunk],
                seal,
              },
            });
          return {
            id: value.id,
            track_id: spec.track_id,
            seal_sha256: createHash('sha256')
              .update(canonicalJson(seal))
              .digest('hex'),
            partial: true,
          };
        } finally {
          local.close();
        }
      } finally {
        key.fill(0);
      }
    },
    { directory, id, uploaded },
  );
}

test('requires inline upload consent and preserves the encrypted journal after native preflight fails and the app restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-upload-ui-'));
  const fixture = await desktopFixture();
  const remote = fixture.seed('Synthetic meeting with explicitly saved audio.');
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    let page = await application.firstWindow();
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await page.getByRole('textbox', { name: 'Service URL' }).fill(fixture.url);
    await page
      .getByRole('button', { name: 'Sign in with browser', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: /^Synthetic cloud workspace (Open workspace|Current workspace)$/,
      })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText(remote.notes);
    const { id: recording } = await savedRecording(
      application,
      directory,
      remote.id,
    );
    await page.reload();
    await page.getByText(/^Saved audio \(/).click();
    const upload = page.getByRole('button', {
      name: 'Upload saved audio',
      exact: true,
    });
    await expect(upload).toBeEnabled();
    const audioState = () =>
      page.evaluate(async () => {
        const state = await window.notes.invoke({ operation: 'bootstrap' });
        if (!state.ok || !('state' in state))
          throw new Error('The desktop workspace is unavailable.');
        return window.notes.invoke({
          operation: 'getRecordingState',
          scope: state.state.scope,
          document_id: state.state.selected_id,
          offset: 0,
        });
      });
    expect(await audioState()).toMatchObject({
      ok: true,
      audio_state: { state: { uploads: [] } },
    });
    await upload.click();
    await expect(
      page.getByText(/This does not start Azure transcription/),
    ).toBeVisible();
    await expect(
      page.getByRole('checkbox', {
        name: /I accept saved audio even if capture/,
      }),
    ).not.toBeChecked();
    await page
      .getByRole('button', { name: 'Keep local only', exact: true })
      .click();
    expect(await audioState()).toMatchObject({
      ok: true,
      audio_state: { state: { uploads: [] } },
    });
    await upload.click();
    await page
      .getByRole('button', { name: 'Confirm audio upload', exact: true })
      .click();
    await expect(
      page.getByText('Upload needs attention', { exact: true }),
    ).toBeVisible();
    expect(await audioState()).toMatchObject({
      ok: true,
      audio_state: {
        state: {
          recordings: [{ id: recording }],
          uploads: [
            { recording_id: recording, state: 'attention', verified_chunks: 0 },
          ],
        },
      },
    });
    await close(application);
    application = null;
    application = await launch(directory);
    page = await application.firstWindow();
    await page.getByText(/^Saved audio \(/).click();
    await expect(
      page.getByText('Upload needs attention', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Resume or retry upload', exact: true }),
    ).toBeVisible();
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await fixture.close();
    expect(fixture.state.failures).toEqual([]);
    expect(fixture.issuer.state.failures).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('separately confirms Azure processing, reconciles a lost reply after restart, reviews candidates and reads capture evidence offline', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(
    join(tmpdir(), 'windows-notes-recording-asr-'),
  );
  const fixture = await desktopFixture();
  const remote = fixture.seed(
    'Synthetic notes remain editable during recognition.',
    'Original manual transcript.',
  );
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    let page = await application.firstWindow();
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await page.getByRole('textbox', { name: 'Service URL' }).fill(fixture.url);
    await page
      .getByRole('button', { name: 'Sign in with browser', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: /^Synthetic cloud workspace (Open workspace|Current workspace)$/,
      })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText(remote.notes);
    fixture.registerRecording(
      remote.id,
      await savedRecording(application, directory, remote.id, true),
    );
    await page.reload();
    await page.getByText(/^Saved audio \(/).click();
    expect(fixture.state.jobs.size).toBe(0);
    await page
      .getByRole('button', { name: 'Transcribe saved audio', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Confirm Azure transcription',
        exact: true,
      }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    expect(fixture.state.jobs.size).toBe(0);
    await page
      .getByRole('button', { name: 'Transcribe saved audio', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Transcription language', exact: true })
      .selectOption('zh-CN');
    await page
      .getByRole('checkbox', {
        name: /I accept transcription of an incomplete recording/,
      })
      .check();
    fixture.state.lose_finalization_response = true;
    await page
      .getByRole('button', { name: 'Confirm Azure transcription', exact: true })
      .click();
    await expect.poll(() => fixture.state.jobs.size).toBe(1);
    await expect(
      page.locator('.meeting-audio [role="alert"]').first(),
    ).toBeVisible();
    await close(application);
    application = null;
    application = await launch(directory);
    page = await application.firstWindow();
    await page.getByText(/^Saved audio \(/).click();
    await page
      .getByRole('button', {
        name: 'Reconcile transcription request',
        exact: true,
      })
      .click();
    await page
      .getByRole('button', {
        name: 'Confirm request reconciliation',
        exact: true,
      })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Confirm request reconciliation',
        exact: true,
      }),
    ).toHaveCount(0);
    expect(fixture.state.jobs.size).toBe(1);
    const job = [...fixture.state.jobs.values()][0]!;
    fixture.transcript(
      remote.id,
      'Newer manual evidence must not be overwritten.',
    );
    fixture.publishCandidate(job.id);
    await synchronize(application);
    await page.locator('summary').filter({ hasText: 'AI activity' }).click();
    await page
      .locator('summary')
      .filter({ hasText: 'Generated transcript' })
      .click();
    await expect(
      page
        .locator('.job-card .transcript-segment')
        .filter({ hasText: 'Synthetic generated recording evidence.' }),
    ).toBeVisible();
    await expect(
      page
        .locator('.job-card')
        .getByText(
          /Incomplete recording: missing audio was explicitly accepted/,
        ),
    ).toBeVisible();
    await page
      .locator('.job-card summary')
      .filter({ hasText: 'Capture evidence' })
      .click();
    await expect(
      page.getByText('0:00-0:00: paused', { exact: true }),
    ).toBeVisible();
    const editor = page.getByRole('textbox', {
      name: 'Meeting notes',
      exact: true,
    });
    const text =
      'Synthetic edited notes survive transcript review and application.';
    await editor.fill(text);
    await page
      .getByRole('button', { name: 'Apply generated transcript', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: 'Confirm transcript replacement',
        exact: true,
      })
      .click();
    await expect
      .poll(() => fixture.state.documents.get(remote.id)?.transcript_revision)
      .toBe(4);
    await expect(editor).toHaveText(text);
    await expect(
      page.getByText('This generated version is already applied.', {
        exact: true,
      }),
    ).toBeVisible();
    await close(application);
    application = null;
    fixture.state.transcript_online = false;
    application = await launch(directory);
    page = await application.firstWindow();
    await page.locator('summary').filter({ hasText: 'AI activity' }).click();
    await page
      .locator('summary')
      .filter({ hasText: 'Generated transcript' })
      .click();
    await expect(
      page
        .locator('.job-card .transcript-segment')
        .filter({ hasText: 'Synthetic generated recording evidence.' }),
    ).toBeVisible();
    await page
      .locator('.job-card summary')
      .filter({ hasText: 'Capture evidence' })
      .click();
    await expect(
      page.getByText('0:00-0:00: paused', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText(text);
    fixture.state.transcript_online = true;
    await synchronize(application);
    await page.getByText(/^Saved audio \(/).click();
    await page
      .getByRole('button', { name: 'Transcribe again', exact: true })
      .click();
    await page
      .getByRole('checkbox', {
        name: /I accept transcription of an incomplete recording/,
      })
      .check();
    await page
      .getByRole('button', { name: 'Confirm Azure transcription', exact: true })
      .click();
    await expect.poll(() => fixture.state.jobs.size).toBe(2);
    await page
      .getByRole('button', { name: 'Cancel transcription', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: 'Confirm transcription cancellation',
        exact: true,
      })
      .click();
    await expect
      .poll(
        () =>
          [...fixture.state.jobs.values()].filter(
            (value) => value.state === 'cancelled',
          ).length,
      )
      .toBe(1);
    expect(fixture.state.documents.get(remote.id)?.transcript_revision).toBe(4);
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await fixture.close();
    expect(fixture.state.failures).toEqual([]);
    expect(fixture.issuer.state.failures).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  }
});
test('pages long transcripts without losing editor text and reads opened pages offline after restart', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'windows-notes-transcript-pages-'),
  );
  const fixture = await desktopFixture();
  fixture.seed(
    'Synthetic notes remain editable.',
    Array.from({ length: 137 }, (_, index) => ({
      id: randomUUID(),
      start_ms: index * 1000,
      end_ms: index * 1000 + 999,
      text: `Synthetic transcript segment ${index}.`,
    })),
  );
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    let page = await application.firstWindow();
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await page.getByRole('textbox', { name: 'Service URL' }).fill(fixture.url);
    await page
      .getByRole('button', { name: 'Sign in with browser', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: /^Synthetic cloud workspace (Open workspace|Current workspace)$/,
      })
      .click();
    const editor = page.getByRole('textbox', {
      name: 'Meeting notes',
      exact: true,
    });
    await expect(editor).toHaveText('Synthetic notes remain editable.');
    await page
      .getByText('Transcript', { exact: false })
      .filter({ hasText: 'Revision 1' })
      .first()
      .click();
    await expect(
      page.getByText('Segments 1-50 of 137', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.transcript-segment')).toHaveCount(50);
    await editor.fill('Synthetic edited notes survive transcript navigation.');
    await page
      .getByRole('button', { name: 'Next transcript page', exact: true })
      .click();
    await expect(
      page.getByText('Segments 51-100 of 137', { exact: true }),
    ).toBeVisible();
    await expect(editor).toHaveText(
      'Synthetic edited notes survive transcript navigation.',
    );
    await expect(page.locator('.transcript-segment')).toHaveCount(50);
    await close(application);
    application = await launch(directory);
    page = await application.firstWindow();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText('Synthetic edited notes survive transcript navigation.');
    await page
      .getByText('Transcript', { exact: false })
      .filter({ hasText: 'Revision 1' })
      .first()
      .click();
    fixture.state.transcript_online = false;
    await page
      .getByRole('button', { name: 'Next transcript page', exact: true })
      .click();
    await expect(
      page.getByText('Segments 51-100 of 137', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Next transcript page', exact: true })
      .click();
    await expect(
      page.getByText('Synthetic service unavailable.', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Segments 51-100 of 137', { exact: true }),
    ).toBeVisible();
    fixture.state.transcript_online = true;
    await page
      .getByRole('button', { name: 'Next transcript page', exact: true })
      .click();
    await expect(
      page.getByText('Segments 101-137 of 137', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.transcript-segment')).toHaveCount(37);
    await expect(
      page.getByRole('button', { name: 'Next transcript page', exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Previous transcript page', exact: true })
      .click();
    await expect(
      page.getByText('Segments 51-100 of 137', { exact: true }),
    ).toBeVisible();
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await fixture.close();
    expect(fixture.state.failures).toEqual([]);
    expect(fixture.issuer.state.failures).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('connects through real OIDC, requires offline-copy consent, syncs edits and restores the account across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-account-ui-'));
  const fixture = await desktopFixture();
  const remote = fixture.seed(
    'Synthetic remote meeting text.',
    'Synthetic immutable transcript evidence.',
  );
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    let page = await application.firstWindow();
    await page
      .getByRole('button', { name: 'Create your first meeting' })
      .click();
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill('Synthetic device-only private text.');
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await page.getByRole('textbox', { name: 'Service URL' }).fill(fixture.url);
    await page
      .getByRole('button', { name: 'Sign in with browser', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: /^Synthetic cloud workspace (Open workspace|Current workspace)$/,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: /^Synthetic cloud workspace (Open workspace|Current workspace)$/,
      })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText('Synthetic remote meeting text.');
    expect([...fixture.state.documents.values()]).toHaveLength(1);
    await page.getByRole('button', { name: /Account & sync/ }).click();
    const allowance = page.getByRole('article', { name: 'AI allowance' });
    await expect(allowance).toContainText('across all workspaces');
    fixture.state.usage.uncertain.input_tokens = '64000';
    fixture.state.usage.uncertain_requests = '1';
    await allowance
      .getByRole('button', { name: 'Refresh AI usage', exact: true })
      .click();
    await expect(allowance).toContainText('64,000 held');
    await expect(allowance).toContainText('not an Azure invoice');
    await page
      .getByRole('checkbox', { name: /Copy my device-only drafts/ })
      .check();
    await page
      .getByRole('button', {
        name: /^Synthetic cloud workspace (Open workspace|Current workspace)$/,
      })
      .click();
    await expect
      .poll(() =>
        [...fixture.state.documents.values()].map((document) => document.notes),
      )
      .toContain('Synthetic device-only private text.');
    await page
      .getByRole('button', { name: 'Synthetic cloud meeting', exact: false })
      .first()
      .click();
    await page
      .getByRole('textbox', { name: 'Meeting notes', exact: true })
      .fill('Synthetic cloud edit from the desktop.');
    await expect
      .poll(() => fixture.state.documents.get(remote.id)?.notes)
      .toBe('Synthetic cloud edit from the desktop.');
    await page
      .getByText('Transcript', { exact: false })
      .filter({ hasText: 'Revision 1' })
      .first()
      .click();
    await expect(
      page
        .getByRole('paragraph')
        .filter({ hasText: 'Synthetic immutable transcript evidence.' }),
    ).toBeVisible();
    await close(application);
    application = null;
    application = await launch(directory);
    page = await application.firstWindow();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText('Synthetic cloud edit from the desktop.');
    expect(fixture.issuer.state.tokenCalls).toBe(1);
    await expect
      .poll(async () => {
        const response = await page.evaluate(() =>
          window.notes.invoke({ operation: 'bootstrap' }),
        );
        return response.ok && 'state' in response
          ? response.state.connection.unsent_count
          : -1;
      })
      .toBe(0);
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await page
      .getByRole('button', { name: 'Disconnect account', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm disconnect', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Sign in with browser', exact: true }),
    ).toBeVisible();
    expect(fixture.issuer.state.revoked).toHaveLength(1);
    const state = await page.evaluate(() =>
      window.notes.invoke({ operation: 'bootstrap' }),
    );
    expect(state).toMatchObject({
      ok: true,
      state: {
        documents: [{ status: 'local' }],
        connection: { user_id: null },
      },
    });
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await fixture.close();
    expect(fixture.state.failures).toEqual([]);
    expect(fixture.issuer.state.failures).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves stale-editor text as a new copy and clears even invalid editor content on confirmed revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-recovery-ui-'));
  const fixture = await desktopFixture();
  const remote = fixture.seed('Synthetic original cloud text.');
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /Account & sync/ }).click();
    await page.getByRole('textbox', { name: 'Service URL' }).fill(fixture.url);
    await page
      .getByRole('button', { name: 'Sign in with browser', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: /^Synthetic cloud workspace (Open workspace|Current workspace)$/,
      })
      .click();
    const editor = page.getByRole('textbox', {
      name: 'Meeting notes',
      exact: true,
    });
    await expect(editor).toHaveText('Synthetic original cloud text.');
    await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const send = contents.send.bind(contents);
      contents.send = (channel, ...arguments_) => {
        if (channel !== 'notes:changed') send(channel, ...arguments_);
      };
    });
    fixture.change(remote.id, 'Synthetic newer cloud version.');
    await synchronize(application);
    await editor.fill('Synthetic stale editor text that must not be lost.');
    await expect(page.getByText('NOT SAVED', { exact: true })).toBeVisible();
    await expect(editor).toHaveText(
      'Synthetic stale editor text that must not be lost.',
    );
    await page
      .getByRole('button', { name: 'Save editor as a new copy', exact: true })
      .click();
    await expect(
      page.getByText('SAVED LOCALLY', { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        [...fixture.state.documents.values()].map((document) => document.notes),
      )
      .toContain('Synthetic stale editor text that must not be lost.');
    expect(fixture.state.documents.get(remote.id)?.notes).toBe(
      'Synthetic newer cloud version.',
    );
    await close(application);
    application = null;
    application = await launch(directory);
    const restarted = await application.firstWindow();
    await expect(
      restarted.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText('Synthetic stale editor text that must not be lost.');
    await restarted
      .getByRole('textbox', { name: 'Meeting tags' })
      .fill('Duplicate, duplicate');
    await expect(
      restarted.getByText('NOT SAVED', { exact: true }),
    ).toBeVisible();
    fixture.state.active = false;
    const running = application;
    await expect
      .poll(async () => {
        await synchronize(running);
        const response = await restarted.evaluate(() =>
          window.notes.invoke({ operation: 'bootstrap' }),
        );
        return response.ok && 'state' in response
          ? response.state.connection.status
          : 'unavailable';
      })
      .toBe('reauth_required');
    await expect(
      restarted.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveCount(0);
    await expect(
      restarted.getByRole('heading', { name: 'Your notes, in sync.' }),
    ).toBeVisible();
    expect(await restarted.locator('body').innerText()).not.toContain(
      'Synthetic stale editor text that must not be lost.',
    );
    const state = await restarted.evaluate(() =>
      window.notes.invoke({ operation: 'bootstrap' }),
    );
    expect(state).toMatchObject({
      ok: true,
      state: {
        documents: [],
        connection: { status: 'reauth_required', active_workspace: null },
      },
    });
    await close(application);
    application = null;
  } finally {
    if (application) await application.close();
    await fixture.close();
    expect(fixture.state.failures).toEqual([]);
    expect(fixture.issuer.state.failures).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  }
});
