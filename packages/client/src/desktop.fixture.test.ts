import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStore } from '@windows-ai-notes/local';
import { richTextFromPlainText } from '@windows-ai-notes/contracts/content';
import { desktopStateSchema } from '@windows-ai-notes/contracts/desktop';
import { desktopFixture } from './desktop.fixture.js';
import { WorkspaceController } from './workspace.js';

describe('Windows desktop synthetic service contract', () => {
  let fixture: Awaited<ReturnType<typeof desktopFixture>>;
  let directory: string;
  let key: Buffer;
  let local: LocalStore;
  let controller: WorkspaceController;
  const fields = (text: string) => ({
    title: 'Synthetic desktop meeting',
    content: richTextFromPlainText(text),
    tags: [],
  });
  beforeEach(async () => {
    fixture = await desktopFixture();
    directory = mkdtempSync(join(tmpdir(), 'windows-notes-desktop-fixture-'));
    key = randomBytes(32);
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    controller = new WorkspaceController(
      local,
      fixture.issuer.browser,
      () => {},
      { allowLoopback: true },
    );
  });
  afterEach(async () => {
    controller.dispose();
    await fixture.close();
    local.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
    expect(fixture.state.failures).toEqual([]);
    expect(fixture.issuer.state.failures).toEqual([]);
  });
  async function connect() {
    await controller.execute({
      operation: 'connect',
      scope: controller.scope,
      service_url: fixture.url,
    });
    await controller.execute({
      operation: 'activateWorkspace',
      scope: controller.scope,
      workspace_id: fixture.state.workspace,
      copy_offline: false,
    });
    await controller.synchronize();
  }
  it('serves valid signed identity, synchronization, mutation, transcript and logout responses', async () => {
    const document = fixture.seed(
      'Synthetic remote source.',
      'Synthetic immutable transcript.',
    );
    await connect();
    let state = controller.snapshot();
    expect(state.transcript?.segments[0]?.text).toBe(
      'Synthetic immutable transcript.',
    );
    await controller.execute({
      operation: 'save',
      scope: state.scope,
      id: document.id,
      local_revision: state.documents[0]!.local_revision,
      value: fields('Edited through the desktop.'),
    });
    await controller.synchronize();
    expect(fixture.state.documents.get(document.id)?.notes).toBe(
      'Edited through the desktop.',
    );
    state = controller.snapshot();
    expect(state.documents[0]?.status).toBe('synced');
    expect(desktopStateSchema.parse(state)).toEqual(state);
    await controller.execute({
      operation: 'disconnect',
      scope: state.scope,
      preserve_unsent: true,
    });
    expect(controller.snapshot().connection.user_id).toBeNull();
  });
  it('reproduces stale-editor recovery without overwriting the newer server version and then revokes the account', async () => {
    const document = fixture.seed('Original source.');
    await connect();
    const old = controller.snapshot().documents[0]!;
    fixture.change(document.id, 'Newer remote version.');
    await controller.synchronize();
    await expect(
      controller.execute({
        operation: 'save',
        scope: controller.scope,
        id: old.id,
        local_revision: old.local_revision,
        value: fields('Stale editor text.'),
      }),
    ).rejects.toMatchObject({ code: 'local_revision_conflict' });
    const copy = await controller.execute({
      operation: 'create',
      scope: controller.scope,
      value: fields('Stale editor text.'),
    });
    await controller.synchronize();
    expect(fixture.state.documents.get(document.id)?.notes).toBe(
      'Newer remote version.',
    );
    expect(fixture.state.documents.get(copy.selected_id!)?.notes).toBe(
      'Stale editor text.',
    );
    fixture.state.active = false;
    await expect(controller.synchronize()).rejects.toMatchObject({
      code: 'identity_not_provisioned',
    });
    expect(controller.snapshot()).toMatchObject({
      documents: [],
      connection: { status: 'reauth_required' },
    });
  });
});
