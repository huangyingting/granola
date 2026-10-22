import { randomBytes, randomUUID } from 'node:crypto';
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
  it('serves separate chat receipts, frozen sources, lost recovery replies and deletion acknowledgements through Main', async () => {
    const document = fixture.seed(
      'Mira owns the launch checklist. It is due Friday.',
      'Frozen chat transcript.',
    );
    await connect();
    const command = {
      operation: 'askMeeting' as const,
      scope: controller.scope,
      id: document.id,
      question: 'Who owns the launch checklist?',
      language: 'en' as const,
      confirmed: true as const,
      new_attempt: true,
      consent_id: randomUUID(),
    };
    const read = () =>
      controller.chat.read({
        operation: 'getChat',
        scope: controller.scope,
        id: document.id,
        offset: 0,
        refresh: true,
      });
    await read();
    fixture.state.change_chat_before_submit = true;
    await expect(controller.chat.start(command)).rejects.toMatchObject({
      code: 'revision_conflict',
    });
    expect((await read()).submission?.rejected).toBe(true);
    const request = { ...command, consent_id: randomUUID() };
    fixture.state.lose_chat_response = true;
    await expect(controller.chat.start(request)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(fixture.state.chatTurns.size).toBe(1);
    const turn = await controller.chat.start({
      ...request,
      new_attempt: false,
    });
    fixture.failChat(turn.id);
    await read();
    const failed = fixture.state.chatTurns.get(turn.id)!;
    const resume = {
      operation: 'controlChatTurn' as const,
      scope: controller.scope,
      id: document.id,
      thread_id: turn.thread_id,
      turn_id: turn.id,
      action: 'resume' as const,
      resume_token: failed.resume_token!,
      confirmed: true as const,
    };
    fixture.state.lose_chat_resume_response = true;
    await expect(controller.chat.control(resume)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    fixture.failChat(turn.id);
    const second = fixture.state.chatTurns.get(turn.id)!;
    expect((await controller.chat.control(resume)).state).toBe('failed');
    expect(fixture.state.chat_resume_tokens).toEqual([
      failed.resume_token,
      failed.resume_token,
    ]);
    await controller.chat.control({
      ...resume,
      resume_token: second.resume_token!,
    });
    fixture.publishChat(turn.id);
    const view = await read(),
      completed = view.turns[0]!;
    expect(completed.result?.answer.status).toBe('answered');
    const source = await controller.chat.source({
      operation: 'getChatSource',
      scope: controller.scope,
      id: document.id,
      thread_id: turn.thread_id,
      turn_id: turn.id,
      citation: completed.result!.answer.answer.citations[0]!,
    });
    expect(source.excerpts[0]?.text).toBe(
      fixture.state.documents.get(document.id)!.notes,
    );
    expect(source.citation.revision).toBe(2);
    const remove = {
      operation: 'deleteChatThread' as const,
      scope: controller.scope,
      id: document.id,
      thread_id: turn.thread_id,
      confirmed: true as const,
    };
    fixture.state.lose_chat_delete_response = true;
    await expect(controller.chat.remove(remove)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    await controller.chat.remove(remove);
    expect((await read()).threads).toEqual([]);
    expect(fixture.state.jobs.size).toBe(0);
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
