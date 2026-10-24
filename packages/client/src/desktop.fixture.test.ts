import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LocalStore } from '@windows-ai-notes/local';
import { richTextFromPlainText } from '@windows-ai-notes/contracts/content';
import { desktopStateSchema } from '@windows-ai-notes/contracts/desktop';
import {
  cachedTranscriptSchema,
  jobSchema,
  transcriptPageSchema,
  TRANSCRIPT_PAGE_TEXT_BYTES,
  type TranscriptPage,
} from '@windows-ai-notes/contracts/server';
import { desktopFixture } from './desktop.fixture.js';
import { WorkspaceController } from './workspace.js';
import { ApiClient } from './http.js';

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
    vi.restoreAllMocks();
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
  async function cacheLegacy(segments: TranscriptPage['segments']) {
    const document = fixture.seed('Synthetic legacy notes.', segments);
    await connect();
    const transcript = {
      document_id: document.id,
      revision: 1,
      source: 'manual' as const,
      segments,
    };
    local.putArtifact(
      controller.profile,
      document.id,
      'transcript:1',
      transcript,
    );
    return transcript;
  }
  const legacySegments = (count: number, text = 'Synthetic legacy segment.') =>
    Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      start_ms: index * 1000,
      end_ms: index * 1000 + 999,
      text,
    }));
  async function savedSummaries(count = 20) {
    const document = fixture.seed('Synthetic saved summary evidence.');
    const jobs = Array.from({ length: count }, (_, index) =>
      jobSchema.parse({
        id: randomUUID(),
        document_id: document.id,
        kind: 'summary',
        state: 'succeeded',
        attempt: 1,
        input_stale: false,
        error: null,
        created_at: new Date(Date.now() - index * 1000).toISOString(),
        result: {
          kind: 'summary',
          provider: 'fixture',
          configuration_version: 'saved-summary-fixture-v1',
          prompt_version: 'summary-v1',
          usage: { input_tokens: 20, output_tokens: 30, audio_ms: 0 },
          summary: {
            overview: {
              text: `Completed summary body ${index}. ${'Evidence '.repeat(200)}`,
              citations: [{ source: 'note', id: document.id, revision: 1 }],
            },
            topics: [],
            decisions: [],
            action_items: [],
            open_questions: [],
          },
        },
      }),
    );
    for (const job of [...jobs].reverse()) fixture.state.jobs.set(job.id, job);
    await connect();
    return { document, jobs };
  }
  it('summary history IPC omits completed bodies without modifying encrypted job history', async () => {
    const { document, jobs } = await savedSummaries();
    const state = controller.snapshot();
    expect(state.jobs).toHaveLength(20);
    expect(JSON.stringify(state).includes('Completed summary body')).toBe(
      false,
    );
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(20_000);
    expect(state.jobs[0]?.result).toMatchObject({
      kind: 'summary',
      prompt_version: 'summary-v1',
      usage: { input_tokens: 20, output_tokens: 30, audio_ms: 0 },
    });
    expect(
      local.getArtifact(
        controller.profile,
        document.id,
        'job-history',
        z.strictObject({ jobs: z.array(jobSchema).max(20) }),
      ),
    ).toEqual({ jobs });
    expect(desktopStateSchema.parse(state)).toEqual(state);
  });
  it('summary history IPC rejects a full summary body in routine desktop state', async () => {
    const { jobs } = await savedSummaries(1);
    expect(
      desktopStateSchema.safeParse({ ...controller.snapshot(), jobs }).success,
    ).toBe(false);
  });
  it('conditional history preserves every full encrypted result across bodyless sync and offline restart', async () => {
    const { document, jobs } = await savedSummaries();
    const full = z.strictObject({ jobs: z.array(jobSchema).max(20) });
    const before = local.getArtifact(
      controller.profile,
      document.id,
      'job-history',
      full,
    );
    fixture.change(document.id, 'A later synthetic human edit.');
    await controller.synchronize();
    expect(fixture.state.job_history_responses.not_modified).toBeGreaterThan(0);
    expect(
      local.getArtifact(controller.profile, document.id, 'job-history', full),
    ).toEqual(before);
    controller.dispose();
    local.close();
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    controller = new WorkspaceController(
      local,
      fixture.issuer.browser,
      () => {},
      { allowLoopback: true },
    );
    fixture.state.jobs.clear();
    const request = vi
      .spyOn(ApiClient.prototype, 'request')
      .mockRejectedValue(new Error('Unexpected offline revalidation.'));
    for (const job of jobs)
      await expect(
        controller.summaries.readResult({
          operation: 'getSummaryResult',
          scope: controller.scope,
          id: document.id,
          job_id: job.id,
        }),
      ).resolves.toEqual(job.result);
    expect(request).not.toHaveBeenCalled();
  });
  it('summary history IPC loads selected full results offline after encrypted restart without network work', async () => {
    const { document, jobs } = await savedSummaries(2);
    controller.dispose();
    local.close();
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    controller = new WorkspaceController(
      local,
      fixture.issuer.browser,
      () => {},
      {
        allowLoopback: true,
      },
    );
    fixture.state.jobs.clear();
    const request = vi
      .spyOn(ApiClient.prototype, 'request')
      .mockRejectedValue(
        new Error('Unexpected network request for saved output.'),
      );
    for (const job of jobs)
      await expect(
        controller.summaries.readResult({
          operation: 'getSummaryResult',
          scope: controller.scope,
          id: document.id,
          job_id: job.id,
        }),
      ).resolves.toEqual(job.result);
    expect(request).not.toHaveBeenCalled();
    expect(controller.snapshot().jobs).toHaveLength(2);
  });
  it('summary history IPC rejects stale scopes, foreign cached jobs and unfinished results', async () => {
    const { document, jobs } = await savedSummaries(1);
    const job = jobs[0]!;
    const command = {
      operation: 'getSummaryResult' as const,
      scope: controller.scope,
      id: document.id,
      job_id: job.id,
    };
    await expect(
      controller.summaries.readResult({
        ...command,
        scope: controller.scope + 1,
      }),
    ).rejects.toMatchObject({ code: 'workspace_changed' });
    local.putArtifact(controller.profile, document.id, `job:${job.id}`, {
      ...job,
      document_id: randomUUID(),
    });
    await expect(
      controller.summaries.readResult(command),
    ).rejects.toMatchObject({
      code: 'invalid_server_response',
    });
    local.putArtifact(controller.profile, document.id, `job:${job.id}`, {
      ...job,
      state: 'running',
      result: null,
    });
    await expect(
      controller.summaries.readResult(command),
    ).rejects.toMatchObject({
      code: 'summary_unavailable',
    });
    local.putArtifact(controller.profile, document.id, `job:${job.id}`, job);
    const retired = controller.summaries.readResult(command);
    controller.dispose();
    await expect(retired).rejects.toMatchObject({ code: 'workspace_closed' });
  });
  it('summary history IPC preserves recording results and progress without dropping control metadata', async () => {
    const { document, jobs } = await savedSummaries(1);
    const recording_id = randomUUID();
    const recording = jobSchema.parse({
      ...jobs[0],
      kind: 'recording_transcription',
      recording_id,
      progress: {
        completed_chunks: 2,
        total_chunks: 3,
        audio_ms: 4000,
        uncertain_requests: 1,
      },
      result: {
        kind: 'recording_transcription',
        recording_id,
        transcript_revision: 1,
        segment_count: 3,
        processed_chunks: 2,
        uncertain_requests: 1,
        applied: false,
        partial: true,
        provider: 'fixture',
        configuration_version: 'recording-fixture-v1',
        usage: { input_tokens: 0, output_tokens: 0, audio_ms: 4000 },
      },
    });
    local.putArtifact(controller.profile, document.id, 'job-history', {
      jobs: [recording],
    });
    expect(controller.snapshot().jobs).toEqual([recording]);
    expect(desktopStateSchema.parse(controller.snapshot()).jobs).toEqual([
      recording,
    ]);
  });
  it('warm job history reuses metadata without sharing mutable snapshot objects', async () => {
    const { jobs } = await savedSummaries(2);
    local.putValue('root', 'warm-history-fixture', true);
    const read = vi.spyOn(local, 'getArtifact');
    const first = controller.snapshot();
    const result = first.jobs[0]!.result;
    if (result?.kind !== 'summary')
      throw new Error('Expected saved summary metadata.');
    result.usage.input_tokens = 999;
    first.jobs[0]!.state = 'cancelled';
    first.jobs.length = 0;
    for (let index = 0; index < 5; index++) {
      const state = controller.snapshot();
      expect(state.jobs).toHaveLength(2);
      expect(state.jobs[0]).toMatchObject({
        id: jobs[0]!.id,
        state: 'succeeded',
        result: { usage: { input_tokens: 20 } },
      });
    }
    expect(
      read.mock.calls.filter((args) => args[2] === 'job-history'),
    ).toHaveLength(1);
  });
  it('warm job history invalidates after same-connection replacement and deletion', async () => {
    const { document, jobs } = await savedSummaries(1);
    expect(controller.snapshot().jobs[0]?.state).toBe('succeeded');
    const changed = { ...jobs[0]!, state: 'running' as const, result: null };
    local.putArtifact(controller.profile, document.id, 'job-history', {
      jobs: [changed],
    });
    expect(controller.snapshot().jobs).toEqual([changed]);
    local.deleteArtifact(controller.profile, document.id, 'job-history');
    expect(controller.snapshot().jobs).toEqual([]);
  });
  it('warm job history observes writes from another live encrypted store', async () => {
    const { document, jobs } = await savedSummaries(1);
    const writer = new LocalStore(join(directory, 'notes.sqlite'), key);
    try {
      expect(controller.snapshot().jobs[0]?.state).toBe('succeeded');
      const changed = {
        ...jobs[0]!,
        state: 'cancelled' as const,
        result: null,
      };
      writer.putArtifact(controller.profile, document.id, 'job-history', {
        jobs: [changed],
      });
      expect(controller.snapshot().jobs).toEqual([changed]);
    } finally {
      writer.close();
    }
  });
  it('warm job history never reuses uncommitted snapshots after nested rollback', async () => {
    const { document, jobs } = await savedSummaries(1);
    const profile = controller.profile;
    expect(controller.snapshot().jobs[0]?.state).toBe('succeeded');
    expect(() =>
      local.atomic(() => {
        expect(() =>
          local.atomic(() => {
            local.putArtifact(profile, document.id, 'job-history', {
              jobs: [{ ...jobs[0]!, state: 'cancelled', result: null }],
            });
            expect(controller.snapshot().jobs[0]?.state).toBe('cancelled');
            throw new Error('Synthetic nested history rollback.');
          }),
        ).toThrow('Synthetic nested history rollback.');
        expect(controller.snapshot().jobs[0]?.state).toBe('succeeded');
        local.putArtifact(profile, document.id, 'job-history', {
          jobs: [{ ...jobs[0]!, state: 'running', result: null }],
        });
        expect(controller.snapshot().jobs[0]?.state).toBe('running');
        throw new Error('Synthetic outer history rollback.');
      }),
    ).toThrow('Synthetic outer history rollback.');
    expect(controller.snapshot().jobs[0]?.state).toBe('succeeded');
  });
  it('warm job history fails closed when another connection corrupts a warmed artifact', async () => {
    const { document } = await savedSummaries(1);
    expect(controller.snapshot().jobs).toHaveLength(1);
    const writer = new DatabaseSync(join(directory, 'notes.sqlite'));
    try {
      writer
        .prepare('UPDATE vault SET payload=? WHERE profile=? AND id=?')
        .run(
          Buffer.alloc(30),
          controller.profile,
          `artifact:${document.id}:job-history`,
        );
      for (let index = 0; index < 2; index++)
        expect(() => controller.snapshot()).toThrow(
          'Local data could not be unlocked or verified.',
        );
    } finally {
      writer.close();
    }
  });
  it('warm job history follows selection and removes remotely deleted results', async () => {
    const { document } = await savedSummaries(1);
    const other = fixture.seed('Another synthetic meeting.');
    await controller.synchronize();
    await controller.execute({
      operation: 'select',
      scope: controller.scope,
      id: document.id,
    });
    expect(controller.snapshot().jobs).toHaveLength(1);
    await controller.execute({
      operation: 'select',
      scope: controller.scope,
      id: other.id,
    });
    expect(controller.snapshot().jobs).toEqual([]);
    await controller.execute({
      operation: 'select',
      scope: controller.scope,
      id: document.id,
    });
    expect(controller.snapshot().jobs).toHaveLength(1);
    fixture.remove(document.id);
    await controller.synchronize();
    expect(controller.snapshot().jobs).toEqual([]);
  });
  it('warm job history isolates the same document and job identifiers across profiles', async () => {
    const { document, jobs } = await savedSummaries(1);
    local.applyRemote('offline', document);
    const offline = { ...jobs[0]!, state: 'cancelled' as const, result: null };
    local.putArtifact('offline', document.id, 'job-history', {
      jobs: [offline],
    });
    expect(controller.snapshot().jobs[0]?.state).toBe('succeeded');
    await controller.execute({
      operation: 'workOffline',
      scope: controller.scope,
    });
    expect(controller.profile).toBe('offline');
    expect(controller.snapshot().jobs).toEqual([offline]);
  });
  it('cached transcript IPC projects a full legacy cache to fifty segments without rewriting it', async () => {
    const transcript = await cacheLegacy(legacySegments(1000));
    const state = controller.snapshot();
    expect(state.transcript).toEqual({
      document_id: transcript.document_id,
      revision: 1,
      source: 'manual',
      offset: 0,
      total_segments: 1000,
      segments: transcript.segments.slice(0, 50),
      has_more: true,
    });
    expect(Buffer.byteLength(JSON.stringify(state.transcript))).toBeLessThan(
      20_000,
    );
    expect(
      local.getArtifact(
        controller.profile,
        transcript.document_id,
        'transcript:1',
        cachedTranscriptSchema,
      ),
    ).toEqual(transcript);
    expect(desktopStateSchema.parse(state)).toEqual(state);
  });
  it('cached transcript IPC enforces the UTF-8 page budget rather than counting characters', async () => {
    const transcript = await cacheLegacy(
      legacySegments(80, String.fromCodePoint(0x4e2d).repeat(1000)),
    );
    const first = transcriptPageSchema.parse(controller.snapshot().transcript);
    expect(first.segments).toHaveLength(42);
    expect(
      first.segments.reduce(
        (bytes, segment) => bytes + Buffer.byteLength(segment.text),
        0,
      ),
    ).toBeLessThanOrEqual(TRANSCRIPT_PAGE_TEXT_BYTES);
    const next = await controller.transcriptPage(
      controller.scope,
      transcript.document_id,
      1,
      first.segments.length,
    );
    expect([...first.segments, ...next.segments]).toEqual(transcript.segments);
    expect(next.has_more).toBe(false);
  });
  it('cached transcript IPC preserves existing page provenance and recording evidence', async () => {
    const transcript = await cacheLegacy(legacySegments(74));
    const page = transcriptPageSchema.parse({
      ...transcript,
      segments: transcript.segments.slice(0, 50),
      offset: 0,
      total_segments: 74,
      has_more: true,
      is_candidate: true,
      based_on_revision: 0,
      recording: {
        id: randomUUID(),
        seal_sha256: '3'.repeat(64),
        partial: true,
        tracks: [{ track_id: randomUUID(), kind: 'microphone' }],
        timeline_count: 2,
      },
    });
    local.putArtifact(
      controller.profile,
      transcript.document_id,
      'transcript:1',
      page,
    );
    expect(controller.snapshot().transcript).toEqual(page);
    expect(desktopStateSchema.parse(controller.snapshot()).transcript).toEqual(
      page,
    );
  });
  it('cached transcript IPC preserves every offline page after an encrypted restart', async () => {
    const transcript = await cacheLegacy(legacySegments(127));
    controller.dispose();
    local.close();
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    controller = new WorkspaceController(
      local,
      fixture.issuer.browser,
      () => {},
      {
        allowLoopback: true,
      },
    );
    fixture.state.transcript_online = false;
    const first = transcriptPageSchema.parse(controller.snapshot().transcript);
    const second = await controller.transcriptPage(
      controller.scope,
      transcript.document_id,
      1,
      50,
    );
    const last = await controller.transcriptPage(
      controller.scope,
      transcript.document_id,
      1,
      100,
    );
    expect([...first.segments, ...second.segments, ...last.segments]).toEqual(
      transcript.segments,
    );
    expect(last.has_more).toBe(false);
    expect(
      local.getArtifact(
        controller.profile,
        transcript.document_id,
        'transcript:1',
        cachedTranscriptSchema,
      ),
    ).toEqual(transcript);
  });
  it('cached transcript IPC rejects an unprojected full cache at the desktop contract boundary', async () => {
    const transcript = await cacheLegacy(legacySegments(60));
    expect(
      desktopStateSchema.safeParse({
        ...controller.snapshot(),
        transcript,
      }).success,
    ).toBe(false);
  });
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
    await controller.chat.watch({
      operation: 'watchChat',
      scope: controller.scope,
      id: document.id,
      thread_id: turn.thread_id,
      turn_id: turn.id,
      action: 'start',
    });
    fixture.previewChat(turn.id, 'Unfinished synthetic chat answer.');
    await vi.waitFor(() =>
      expect(controller.snapshot().chat_generation?.preview).toBe(
        'Unfinished synthetic chat answer.',
      ),
    );
    expect(fixture.state.chat_event_cursors).toContain(0);
    await controller.chat.watch({
      operation: 'watchChat',
      scope: controller.scope,
      id: document.id,
      thread_id: turn.thread_id,
      turn_id: turn.id,
      action: 'stop',
    });
    expect(controller.snapshot().chat_generation).toBeNull();
    await controller.chat.watch({
      operation: 'watchChat',
      scope: controller.scope,
      id: document.id,
      thread_id: turn.thread_id,
      turn_id: turn.id,
      action: 'start',
    });
    expect(controller.snapshot().chat_generation?.preview).toBe(
      'Unfinished synthetic chat answer.',
    );
    expect(fixture.state.chatTurns.get(turn.id)?.provider_requests).toBe(1);
    fixture.failChat(turn.id);
    await vi.waitFor(() =>
      expect(controller.snapshot().chat_generation).toBeNull(),
    );
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
