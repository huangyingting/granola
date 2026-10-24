import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  richTextFromPlainText,
  richTextToPlainText,
} from '@windows-ai-notes/contracts/content';
import {
  WINDOWS_LIBRARY_DOCUMENTS,
  WINDOWS_LIBRARY_MARKER,
  windowsLibraryFields,
  windowsLibraryObservationSchema,
} from '../../../packages/client/src/library.fixture.js';
import { latencySummary } from '../../../packages/client/src/load.fixture.js';

test.skip(
  process.platform !== 'win32' || process.arch !== 'x64',
  'Actual x64 Windows DPAPI and sandboxed Electron IPC are required.',
);

function launch(directory: string) {
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WINDOWS_NOTES_DATA_DIR: directory,
    },
  });
}

async function close(application: ElectronApplication) {
  const completed = Promise.all([
    application.waitForEvent('close'),
    once(application.process(), 'exit'),
  ]);
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  const [, [code, signal]] = await completed;
  expect(code).toBe(0);
  expect(signal).toBeNull();
}

test('observes 1100 encrypted Windows notes across fresh and warm searches, selected saves and natural restarts', async () => {
  const output = fileURLToPath(
    new URL(
      '../../../artifacts/windows-library-observations.json',
      import.meta.url,
    ),
  );
  await rm(output, { force: true });
  const directory = await mkdtemp(join(tmpdir(), 'windows-notes-library-'));
  const fields = Array.from({ length: WINDOWS_LIBRARY_DOCUMENTS }, (_, index) =>
    windowsLibraryFields(index),
  );
  let expectedText = richTextToPlainText(
    windowsLibraryFields(WINDOWS_LIBRARY_DOCUMENTS - 1).content,
  );
  const cold: number[] = [],
    warm: number[] = [],
    saved: number[] = [];
  let maximumResponseBytes = 0;
  let application: ElectronApplication | null = null;
  try {
    application = await launch(directory);
    let page = await application.firstWindow();
    await expect(
      page.getByRole('button', { name: 'Create your first meeting' }),
    ).toBeVisible();
    expect(
      await application.evaluate(
        ({ app, safeStorage }, { directory, fields }) => {
          if (
            app.isPackaged ||
            process.platform !== 'win32' ||
            process.arch !== 'x64'
          )
            throw new Error(
              'The synthetic setup requires development Windows Main.',
            );
          const { join } = process.getBuiltinModule('node:path');
          const { readFileSync } = process.getBuiltinModule('node:fs');
          const require = process
            .getBuiltinModule('node:module')
            .createRequire(join(app.getAppPath(), 'package.json'));
          const {
            LocalStore,
          }: typeof import('@windows-ai-notes/local') = require('@windows-ai-notes/local');
          const encoded = safeStorage.decryptString(
            readFileSync(join(directory, 'content-key.protected')),
          );
          const key = Buffer.from(encoded, 'base64');
          try {
            if (key.length !== 32 || key.toString('base64') !== encoded)
              throw new Error('The synthetic content key is invalid.');
            const local = new LocalStore(join(directory, 'notes.sqlite'), key);
            try {
              local.atomic(() => {
                let selected: string | undefined;
                for (const value of fields) {
                  const draft = local.create('offline', value);
                  selected = draft.id;
                }
                if (!selected)
                  throw new Error('The synthetic library is empty.');
                local.putValue('offline', 'selected-document', selected);
              });
              return local.list('offline').length;
            } finally {
              local.close();
            }
          } finally {
            key.fill(0);
          }
        },
        { directory, fields },
      ),
    ).toBe(WINDOWS_LIBRARY_DOCUMENTS);
    await close(application);
    application = null;

    for (let sample = 0; sample < 3; sample++) {
      application = await launch(directory);
      page = await application.firstWindow();
      let editor = page.getByRole('textbox', {
        name: 'Meeting notes',
        exact: true,
      });
      await expect(editor).toHaveText(expectedText);
      await expect(
        page.getByRole('navigation', { name: 'Meetings' }).getByRole('button'),
      ).toHaveCount(50);
      if (sample === 0) {
        await page
          .getByRole('button', { name: 'More meetings', exact: true })
          .click();
        const last = await page.evaluate(async () => {
          const initial = await window.notes.invoke({ operation: 'bootstrap' });
          if (!initial.ok || !('state' in initial))
            throw new Error('The synthetic library is unavailable.');
          return window.notes.invoke({
            operation: 'search',
            scope: initial.state.scope,
            query: '',
            offset: 1050,
          });
        });
        if (!last.ok || !('state' in last))
          throw new Error('The final synthetic page is unavailable.');
        expect(last.state.documents).toHaveLength(50);
        expect(last.state.has_more).toBe(false);
        await page.reload();
        await expect(
          page.getByRole('button', { name: 'More meetings', exact: true }),
        ).toBeDisabled();
        await expect(editor).toHaveText(expectedText);
      }

      const searched = await page.evaluate(async () => {
        const initial = await window.notes.invoke({ operation: 'bootstrap' });
        if (!initial.ok || !('state' in initial) || !initial.state.selected)
          throw new Error('The selected synthetic note is unavailable.');
        const scope = initial.state.scope;
        const selected = initial.state.selected;
        const scan = async (query: string) => {
          const started = performance.now();
          const response = await window.notes.invoke({
            operation: 'search',
            scope,
            query,
            offset: 0,
          });
          const elapsed = performance.now() - started;
          if (
            !response.ok ||
            !('state' in response) ||
            response.state.documents.length ||
            response.state.selected_id !== selected.id ||
            JSON.stringify(response.state.selected?.content) !==
              JSON.stringify(selected.content)
          )
            throw new Error(
              'The synthetic full scan changed the selected editor.',
            );
          return {
            elapsed,
            bytes: new TextEncoder().encode(JSON.stringify(response)).length,
          };
        };
        const first = await scan('zz-windows-first-scan-missing');
        const warm = [];
        for (let index = 0; index < 5; index++)
          warm.push(await scan(`zz-windows-warm-missing-${index}`));
        return { first, warm };
      });
      cold.push(searched.first.elapsed);
      warm.push(...searched.warm.map((value) => value.elapsed));
      maximumResponseBytes = Math.max(
        maximumResponseBytes,
        searched.first.bytes,
        ...searched.warm.map((value) => value.bytes),
      );
      await page.reload();
      await expect(
        page.getByRole('navigation', { name: 'Meetings' }).getByRole('button'),
      ).toHaveCount(0);
      await expect(editor).toHaveText(expectedText);
      const savedText = `Synthetic measured selected save ${sample}.`;
      const content = richTextFromPlainText(savedText);
      const saving = await page.evaluate(async (content) => {
        const initial = await window.notes.invoke({ operation: 'bootstrap' });
        if (!initial.ok || !('state' in initial) || !initial.state.selected)
          throw new Error('The synthetic selected save is unavailable.');
        const selected = initial.state.selected;
        const started = performance.now();
        const response = await window.notes.invoke({
          operation: 'save',
          scope: initial.state.scope,
          id: selected.id,
          local_revision: selected.local_revision,
          value: { title: selected.title, tags: selected.tags, content },
        });
        const elapsed = performance.now() - started;
        if (
          !response.ok ||
          !('state' in response) ||
          response.state.documents.length ||
          response.state.selected_id !== selected.id ||
          !response.state.selected ||
          response.state.selected.local_revision <= selected.local_revision ||
          JSON.stringify(response.state.selected.content) !==
            JSON.stringify(content)
        )
          throw new Error(
            'The synthetic selected save lost its edit or query.',
          );
        return {
          elapsed,
          bytes: new TextEncoder().encode(JSON.stringify(response)).length,
        };
      }, content);
      saved.push(saving.elapsed);
      maximumResponseBytes = Math.max(maximumResponseBytes, saving.bytes);
      const found = await page.evaluate(async () => {
        const initial = await window.notes.invoke({ operation: 'bootstrap' });
        if (!initial.ok || !('state' in initial))
          throw new Error('The synthetic body search is unavailable.');
        return window.notes.invoke({
          operation: 'search',
          scope: initial.state.scope,
          query: 'endtoken-0',
          offset: 0,
        });
      });
      if (!found.ok || !('state' in found))
        throw new Error('The synthetic full-body match was rejected.');
      expect(found.state.documents).toHaveLength(1);
      expect(found.state.documents[0]?.title).toBe(
        'Synthetic Windows library meeting 0',
      );
      expect(found.state.documents[0]?.preview).not.toContain('endtoken-0');
      expect(found.state.documents[0]?.id).not.toBe(found.state.selected_id);
      await page.reload();
      editor = page.getByRole('textbox', {
        name: 'Meeting notes',
        exact: true,
      });
      await expect(editor).toHaveText(savedText);
      await expect(
        page.getByRole('navigation', { name: 'Meetings' }).getByRole('button'),
      ).toHaveCount(1);
      expectedText = `Synthetic real editor flush survives large-library restart ${sample}.`;
      await editor.fill(expectedText);
      await close(application);
      application = null;
    }

    application = await launch(directory);
    page = await application.firstWindow();
    await expect(
      page.getByRole('textbox', { name: 'Meeting notes', exact: true }),
    ).toHaveText(expectedText);
    await close(application);
    application = null;
    for (const name of await readdir(directory)) {
      if (name.startsWith('notes.sqlite'))
        expect(
          (await readFile(join(directory, name))).includes(
            Buffer.from(WINDOWS_LIBRARY_MARKER),
          ),
        ).toBe(false);
    }
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }

  const report = windowsLibraryObservationSchema.parse({
    version: 1,
    kind: 'controlled_windows_library',
    scope: 'synthetic_unpacked_windows_dpapi',
    execution:
      process.env.GITHUB_ACTIONS === 'true' ? 'github_actions' : 'local',
    source_commit:
      process.env.GITHUB_ACTIONS === 'true' ? process.env.GITHUB_SHA : null,
    observed_at: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    production_accepted: false,
    slo_accepted: false,
    setup: 'main_local_store_with_actual_dpapi_key',
    latency_scope: 'sandboxed_renderer_validated_ipc_round_trip',
    cohort: {
      documents: WINDOWS_LIBRARY_DOCUMENTS,
      plain_documents: 550,
      structured_documents: 550,
      initial_body_utf8_bytes: fields.reduce(
        (total, value) =>
          total + Buffer.byteLength(richTextToPlainText(value.content)),
        0,
      ),
    },
    process_restarts: 4,
    latency: {
      first_full_scan_after_startup: latencySummary(cold),
      distinct_warm_full_scan: latencySummary(warm),
      selected_save_with_active_no_match_query: latencySummary(saved),
    },
    maximum_measured_response_utf8_bytes: maximumResponseBytes,
    first_page_documents: 50,
    last_page_documents: 50,
    empty_search_responses: 18,
    nonselected_full_body_matches: 3,
    selected_edits_survived_restarts: true,
    plaintext_marker_absent: true,
    natural_exit_verified: true,
    resources_cleaned: true,
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
});
