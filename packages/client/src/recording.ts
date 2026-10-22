import { canonicalJson } from '@windows-ai-notes/contracts/content';
import {
  AUDIO_GIB,
  localAudioQuotaGiBSchema,
  type AudioEvent,
  type Track,
} from '@windows-ai-notes/contracts';
import type {
  AudioState,
  LocalRecording,
  RecordingOwner,
  RecordingUploadIntent,
} from '@windows-ai-notes/contracts/recording';
import { LocalError, LocalStore } from '@windows-ai-notes/local';
import { AudioHostError, type AudioHostClient } from './audio.js';
import { ClientError, type ApiClient } from './http.js';
import {
  uploadSavedRecording,
  deleteSavedRemoteRecording,
} from './recording-upload.js';
import { RecordingLivePreview } from './recording-live.js';
import { recordingRetentionSchema } from '@windows-ai-notes/contracts/uploads';

type AudioClient = Pick<
  AudioHostClient,
  'request' | 'readChunk' | 'close' | 'failure'
>;
export interface RecordingUploadContext {
  profile: string;
  scope: number;
  api: ApiClient;
  authorize: () => void;
  allowLoopback?: boolean;
  reads?: Set<AbortController>;
}
type Problem = { code: string; message: string };
function problem(error: unknown): Problem {
  if (
    error instanceof LocalError ||
    error instanceof AudioHostError ||
    error instanceof ClientError
  )
    return { code: error.code, message: error.message };
  console.error(
    JSON.stringify({
      code: 'audio_operation_failed',
      kind: error instanceof Error ? error.name : 'unknown',
    }),
  );
  return {
    code: 'audio_operation_failed',
    message:
      'The audio operation failed. Inspect preserved recordings before treating their audio as complete.',
  };
}
function missing(error: unknown) {
  return (
    error instanceof LocalError &&
    ['local_recording_missing', 'local_document_missing'].includes(error.code)
  );
}

export class RecordingController {
  private storage: AudioState['storage'] = null;
  private storageError: Problem | null = null;
  private levels: AudioState['levels'] = null;
  private live: { profile: string; preview: RecordingLivePreview } | null =
    null;
  private client: AudioClient | null = null;
  private owner: RecordingOwner | null = null;
  private revoked = false;
  private running = false;
  private closing: Promise<void> | null = null;
  private cleaning: Promise<void> | null = null;
  private reviewing: {
    client: AudioClient;
    profile: string;
    document: string;
    id: string;
    revoked: boolean;
    abort?: AbortController;
  } | null = null;
  private uploadContext: RecordingUploadContext | null = null;
  private uploadTask: Promise<void> | null = null;
  private uploadAbort: AbortController | null = null;
  private uploading: { profile: string; document: string; id: string } | null =
    null;
  private uploadTimer: NodeJS.Timeout | null = null;
  private retentionRead: AbortController | null = null;
  private retentionAfter: string | null = null;
  private retentionReadAt = 0;
  private retentionError: Problem | null = null;
  private retentionRoundFailed = false;
  private deviceRequest: Promise<
    Extract<AudioEvent, { event_type: 'devices' }>['payload']['devices']
  > | null = null;
  private error: Problem | null = null;
  private cleanupError: Problem | null = null;
  constructor(
    private readonly local: LocalStore,
    private readonly create: (
      observe: (event: AudioEvent) => void,
    ) => AudioClient,
    private readonly changed: () => void,
    private readonly remove: (id: string) => Promise<void>,
  ) {
    const interrupted = local.activeRecordingOwner();
    if (interrupted)
      local.updateRecording(
        interrupted.profile,
        interrupted.document_id,
        interrupted.recording_id,
        {
          state: 'interrupted',
          error: {
            code: 'capture_interrupted',
            message:
              'Capture was interrupted. Inspect the preserved audio; it was not resumed or assumed complete.',
          },
        },
      );
  }
  get capturing() {
    return this.client !== null && this.owner !== null;
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.running || this.closing)
      throw new LocalError(
        'audio_busy',
        'Wait for the current audio operation to finish.',
      );
    this.running = true;
    this.error = null;
    this.changed();
    try {
      return await operation();
    } catch (error) {
      const failure = problem(error);
      // Cancellation must not hide the ownership failure that stopped a review.
      if (failure.code !== 'recording_review_cancelled' || this.error === null)
        this.error = failure;
      throw error;
    } finally {
      this.running = false;
      this.changed();
      this.resumeUploads(this.uploadContext);
    }
  }
  private report(error: unknown) {
    this.error = problem(error);
    this.changed();
  }
  private failRecording(error: unknown) {
    const owner = this.owner;
    if (!owner || this.revoked) return;
    try {
      this.local.updateRecording(
        owner.profile,
        owner.document_id,
        owner.recording_id,
        { state: 'failed', error: problem(error) },
      );
    } catch (failure) {
      if (!missing(failure)) throw failure;
    }
  }
  private release(client: AudioClient): Promise<void> {
    this.live?.preview.cancel(this.revoked);
    if (this.closing) return this.closing;
    const operation = (async () => {
      try {
        await client.close();
      } catch (error) {
        this.failRecording(error);
        throw error;
      } finally {
        if (this.client === client) {
          this.levels = null;
          this.client = null;
          this.owner = null;
          this.revoked = false;
        }
      }
    })().finally(() => {
      this.closing = null;
      this.changed();
    });
    this.closing = operation;
    return operation;
  }
  private observe(event: AudioEvent) {
    if (event.event_type === 'storage.status') {
      this.acceptStorage(event);
      return;
    }
    const owner = this.owner;
    if (!owner || this.revoked || event.recording_id !== owner.recording_id)
      return;
    switch (event.event_type) {
      case 'recording.levels': {
        const recording = this.local.getRecording(
          owner.profile,
          owner.document_id,
          owner.recording_id,
        );
        if (recording.state !== 'recording') return;
        const previous = this.levels?.capture;
        if (
          event.payload.tracks.length !== recording.tracks.length ||
          event.payload.tracks.some(
            (track) =>
              !recording.tracks.some(
                (known) => known.spec.track_id === track.track_id,
              ),
          ) ||
          (previous &&
            (event.payload.capture_epoch !== previous.capture_epoch ||
              event.payload.clock_ms <= previous.clock_ms))
        )
          throw new AudioHostError(
            'audio_protocol_error',
            'The helper returned inconsistent capture level identities or clocks.',
            false,
          );
        if (
          event.payload.tracks.some((track) => {
            const prior = previous?.tracks.find(
              (known) => known.track_id === track.track_id,
            )?.level;
            return (
              track.level && prior && track.level.clock_ms <= prior.clock_ms
            );
          })
        )
          throw new AudioHostError(
            'audio_protocol_error',
            'The helper repeated or regressed measured audio level clocks.',
            false,
          );
        this.levels = { received_at: Date.now(), capture: event.payload };
        this.changed();
        break;
      }
      case 'recording.started':
      case 'recording.paused':
      case 'recording.resumed':
      case 'recording.stopped':
      case 'recording.status': {
        if (event.payload.state !== 'recording') this.live?.preview.cancel();
        if (
          event.event_type !== 'recording.status' ||
          event.payload.state !== 'recording'
        )
          this.levels = null;
        const previous = this.local.getRecording(
          owner.profile,
          owner.document_id,
          owner.recording_id,
        );
        const expected = {
          'recording.started': 'recording',
          'recording.paused': 'paused',
          'recording.resumed': 'recording',
          'recording.stopped': 'sealed',
        };
        if (
          (event.event_type !== 'recording.status' &&
            event.payload.state !== expected[event.event_type]) ||
          event.payload.tracks.length !== previous.tracks.length
        )
          throw new AudioHostError(
            'audio_protocol_error',
            'The helper returned inconsistent capture state or track identities.',
            false,
          );
        const tracks = previous.tracks.map((track) => {
          const saved = event.payload.tracks.find(
            (value) => value.track_id === track.spec.track_id,
          );
          if (
            !saved ||
            saved.kind !== track.spec.kind ||
            saved.capture_scope !== track.spec.capture_scope ||
            saved.device_selection_policy !==
              track.spec.device_selection_policy ||
            (track.actual_device_id &&
              track.actual_device_id !== saved.device_id)
          )
            throw new AudioHostError(
              'audio_protocol_error',
              'The helper changed the declared capture source or scope.',
              false,
            );
          return {
            ...track,
            actual_device_id: saved.device_id,
            saved_samples: saved.saved_samples,
          };
        });
        if (
          previous.state !== event.payload.state ||
          canonicalJson(previous.tracks) !== canonicalJson(tracks)
        ) {
          this.local.updateRecording(
            owner.profile,
            owner.document_id,
            owner.recording_id,
            { state: event.payload.state, tracks, error: null },
          );
          this.changed();
        }
        if (
          event.request_id === null &&
          ['sealed', 'failed'].includes(event.payload.state) &&
          this.client
        )
          void this.release(this.client).catch((error: unknown) =>
            this.report(error),
          );
        break;
      }
    }
  }
  async start(
    profile: string,
    document: string,
    tracks: Track[],
    authorize: () => void,
  ) {
    return this.exclusive(async () => {
      authorize();
      if (this.client)
        throw new LocalError(
          'recording_in_progress',
          'Stop the current recording before starting another.',
        );
      this.live?.preview.cancel(true);
      this.live = null;
      const recording = this.local.beginRecording(profile, document, tracks);
      this.owner = {
        profile,
        document_id: document,
        recording_id: recording.id,
      };
      this.revoked = false;
      this.error = null;
      try {
        const client = this.create((event) => this.observe(event));
        this.client = client;
        void client.failure
          .catch(async (error: unknown) => {
            if (this.client !== client) return;
            try {
              this.failRecording(error);
            } catch (failure) {
              this.report(failure);
            }
            this.report(error);
            await this.release(client);
          })
          .catch((error: unknown) => this.report(error));
        await client.request({
          command: 'start_recording',
          recording_id: recording.id,
          tracks,
          storage_quota_bytes: this.local.recordingQuotaGiB() * AUDIO_GIB,
        });
        authorize();
      } catch (error) {
        try {
          this.failRecording(error);
        } finally {
          if (this.client) await this.release(this.client);
          else this.owner = null;
        }
        throw error;
      }
    });
  }
  async control(
    profile: string,
    document: string,
    id: string,
    action: 'pause' | 'resume' | 'stop',
    authorize: () => void,
  ) {
    return this.exclusive(async () => {
      authorize();
      const client = this.client;
      const owner = this.owner;
      const recording = this.local.getRecording(profile, document, id);
      if (
        !client ||
        !owner ||
        owner.profile !== profile ||
        owner.document_id !== document ||
        owner.recording_id !== id ||
        (action === 'pause' && recording.state !== 'recording') ||
        (action === 'resume' && recording.state !== 'paused')
      )
        throw new LocalError(
          'invalid_recording_state',
          'This recording cannot perform that action.',
        );
      try {
        if (action !== 'resume') this.live?.preview.cancel();
        await client.request({
          command:
            action === 'pause'
              ? 'pause_recording'
              : action === 'resume'
                ? 'resume_recording'
                : 'stop_recording',
          recording_id: id,
        });
        authorize();
        if (action === 'stop') await this.release(client);
      } catch (error) {
        try {
          this.failRecording(error);
        } finally {
          await this.release(client);
        }
        throw error;
      }
    });
  }
  async stop(authorize: () => void) {
    this.live?.preview.cancel();
    this.uploadContext = null;
    this.retentionRead?.abort();
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    this.uploadTimer = null;
    this.uploadAbort?.abort();
    if (this.reviewing) {
      authorize();
      await this.closeReview();
    }
    const owner = this.owner;
    if (owner)
      await this.control(
        owner.profile,
        owner.document_id,
        owner.recording_id,
        'stop',
        authorize,
      );
    else if (this.closing) await this.closing;
    await this.live?.preview.closed();
    if (this.uploadTask) await this.uploadTask;
    if (this.cleaning) await this.cleaning;
  }
  startLive(
    profile: string,
    document: string,
    id: string,
    options: {
      locale: 'en-US' | 'zh-CN';
      confirmed: true;
      context: RecordingUploadContext | null;
      authorize: () => void;
      prepare: () => Promise<void>;
    },
  ) {
    options.authorize();
    if (options.confirmed !== true)
      throw new ClientError(
        'live_consent_required',
        'Live preview requires separate cloud consent.',
      );
    const context = options.context;
    if (!context || context.profile !== profile)
      throw new ClientError(
        'live_account_required',
        'Connect the original cloud workspace before starting live preview.',
      );
    context.authorize();
    if (this.live?.preview.running)
      throw new ClientError(
        'live_preview_active',
        'Stop the current live preview and wait for cleanup.',
      );
    const client = this.client;
    const owner = this.owner;
    const recording = this.local.getRecording(profile, document, id);
    if (
      !client ||
      !owner ||
      this.revoked ||
      this.closing ||
      this.running ||
      owner.profile !== profile ||
      owner.document_id !== document ||
      owner.recording_id !== id ||
      recording.state !== 'recording'
    )
      throw new ClientError(
        'invalid_live_state',
        'Live preview requires this meeting to be actively recording.',
      );
    const previous =
      this.live?.profile === profile ? this.live.preview.snapshot() : undefined;
    const preview = new RecordingLivePreview(
      client,
      recording,
      {
        api: context.api,
        prepare: options.prepare,
        authorize: () => {
          options.authorize();
          context.authorize();
          if (
            this.client !== client ||
            this.owner !== owner ||
            this.revoked ||
            this.uploadContext?.profile !== profile ||
            this.uploadContext.scope !== context.scope ||
            this.uploadContext.api !== context.api ||
            this.local.getRecording(profile, document, id).state !== 'recording'
          )
            throw new ClientError(
              'live_owner_changed',
              'The recording or authenticated workspace changed.',
            );
        },
      },
      this.changed,
      options.locale,
      previous?.recording_id === id && previous.document_id === document
        ? previous
        : undefined,
    );
    this.live = { profile, preview };
    preview.start();
  }
  stopLive(
    profile: string,
    document: string,
    id: string,
    authorize: () => void,
  ) {
    authorize();
    const live = this.live;
    const snapshot = live?.preview.snapshot();
    if (
      live?.profile !== profile ||
      snapshot?.document_id !== document ||
      snapshot.recording_id !== id
    )
      throw new ClientError(
        'live_preview_missing',
        'This meeting has no matching live preview.',
      );
    live.preview.cancel();
  }
  listDevices() {
    if (this.deviceRequest) return this.deviceRequest;
    const request = this.exclusive(async () => {
      const shared = this.client ?? this.reviewing?.client;
      const temporary = !shared;
      const client = shared ?? this.create(() => {});
      try {
        const event = await client.request({ command: 'list_devices' });
        if (event.event_type !== 'devices')
          throw new AudioHostError(
            'audio_protocol_error',
            'The helper did not return audio devices.',
            false,
          );
        return event.payload.devices;
      } finally {
        if (temporary) await client.close();
      }
    }).finally(() => {
      this.deviceRequest = null;
    });
    this.deviceRequest = request;
    return request;
  }
  private acceptStorage(
    event: Extract<AudioEvent, { event_type: 'storage.status' }>,
  ) {
    if (
      event.payload.quota_bytes !==
      this.local.recordingQuotaGiB() * AUDIO_GIB
    )
      throw new AudioHostError(
        'audio_protocol_error',
        'The helper checked a different local audio limit.',
        false,
      );
    this.storage = { received_at: Date.now(), capacity: event.payload };
    this.storageError = null;
    this.changed();
  }
  async checkStorage(authorize: () => void, quotaGiB?: number) {
    return this.exclusive(async () => {
      authorize();
      if (quotaGiB !== undefined && this.client)
        throw new LocalError(
          'recording_in_progress',
          'Stop capture before changing the device audio limit.',
        );
      const quota = localAudioQuotaGiBSchema.parse(
        quotaGiB ?? this.local.recordingQuotaGiB(),
      );
      const shared = this.client ?? this.reviewing?.client;
      let client: AudioClient | undefined;
      try {
        client = shared ?? this.create(() => {});
        const event = await client.request({
          command: 'check_storage',
          storage_quota_bytes: quota * AUDIO_GIB,
        });
        if (!shared) {
          const temporary = client;
          client = undefined;
          await temporary.close();
        }
        authorize();
        if (
          event.event_type !== 'storage.status' ||
          event.payload.quota_bytes !== quota * AUDIO_GIB
        )
          throw new AudioHostError(
            'audio_protocol_error',
            'The helper did not confirm the requested device audio limit.',
            false,
          );
        if (quotaGiB !== undefined) this.local.setRecordingQuotaGiB(quota);
        this.acceptStorage(event);
      } catch (error) {
        this.storage = null;
        this.storageError = problem(error);
        throw error;
      } finally {
        if (!shared && client) await client.close();
      }
    });
  }
  inspect(
    profile: string,
    document: string,
    id: string,
    authorize: () => void,
  ) {
    return this.review(profile, document, id, authorize, false);
  }
  recover(
    profile: string,
    document: string,
    id: string,
    authorize: () => void,
  ) {
    return this.review(profile, document, id, authorize, true);
  }
  private async closeReview() {
    const review = this.reviewing;
    if (review) {
      review.revoked = true;
      review.abort?.abort();
      await review.client.close();
    }
    if (this.uploadTask) await this.uploadTask;
  }
  requestUpload(
    profile: string,
    document: string,
    id: string,
    acceptIncomplete: boolean,
  ) {
    const context = this.uploadContext;
    if (!context || context.profile !== profile)
      throw new ClientError(
        'not_connected',
        'Select a signed-in cloud workspace before uploading audio.',
      );
    context.authorize();
    const recording = this.local.getRecording(profile, document, id);
    if (recording.audio_retired_at)
      throw new LocalError(
        'local_audio_retired',
        'Local audio has reached its retention deadline. Use the remaining cloud recording controls.',
      );
    if (
      this.client ||
      this.running ||
      ['starting', 'recording', 'paused'].includes(recording.state)
    )
      throw new LocalError(
        'audio_busy',
        'Stop capture and wait for the current audio operation before uploading.',
      );
    if (this.local.get(profile, document).remote_revision === 0)
      throw new LocalError(
        'document_not_synced',
        'Synchronize this meeting before uploading its audio.',
      );
    const previous = this.local.recordingUpload(profile, document, id);
    if (previous?.state === 'complete') return;
    if (previous && ['delete_pending', 'deleting'].includes(previous.state))
      throw new LocalError(
        'audio_deletion_pending',
        'Audio deletion is already queued.',
      );
    this.local.saveRecordingUpload(
      profile,
      previous
        ? {
            ...previous,
            state: 'queued',
            retry_at: 0,
            error: null,
            partial: previous.plan ? previous.partial : acceptIncomplete,
            accept_incomplete: previous.plan
              ? previous.accept_incomplete
              : acceptIncomplete,
          }
        : {
            recording_id: id,
            document_id: document,
            state: 'queued',
            verified_chunks: 0,
            total_chunks: 0,
            verified_bytes: 0,
            partial: acceptIncomplete,
            attempts: 0,
            retry_at: 0,
            error: null,
            accept_incomplete: acceptIncomplete,
            plan: null,
          },
    );
    this.changed();
    this.resumeUploads(context);
  }
  async pauseUpload(profile: string, document: string, id: string) {
    const intent = this.local.recordingUpload(profile, document, id);
    if (
      !intent ||
      ['complete', 'delete_pending', 'deleting'].includes(intent.state)
    )
      throw new LocalError(
        'upload_not_active',
        'This recording has no pausable upload.',
      );
    this.local.saveRecordingUpload(profile, {
      ...intent,
      state: 'paused',
      retry_at: 0,
      error: null,
    });
    if (this.uploading?.id === id && this.uploading.profile === profile) {
      this.uploadAbort?.abort();
      await this.closeReview();
    }
    this.changed();
  }
  async removeSavedAudio(profile: string, document: string, id: string) {
    const intent = this.local.recordingUpload(profile, document, id);
    if (!intent) {
      this.local.removeRecording(profile, document, id);
      await this.reconcile(profile);
      return;
    }
    if (this.uploading?.id === id && this.uploading.profile === profile) {
      this.local.saveRecordingUpload(profile, { ...intent, state: 'paused' });
      this.uploadAbort?.abort();
      await this.closeReview();
    }
    const current = this.local.recordingUpload(profile, document, id)!;
    this.local.saveRecordingUpload(profile, {
      ...current,
      state: 'delete_pending',
      retry_at: 0,
      error: null,
    });
    this.changed();
    this.resumeUploads(this.uploadContext);
  }
  resumeUploads(context: RecordingUploadContext | null): void {
    const previous = this.uploadContext;
    if (
      !context ||
      previous?.profile !== context.profile ||
      previous.scope !== context.scope ||
      previous.api !== context.api
    ) {
      this.live?.preview.cancel(true);
      this.retentionRead?.abort();
      this.retentionAfter = null;
      this.retentionReadAt = 0;
      this.retentionError = null;
      this.retentionRoundFailed = false;
    }
    this.uploadContext = context;
    if (context) this.refreshRetention(context);
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    this.uploadTimer = null;
    if (this.uploadTask) {
      if (
        !context ||
        previous?.profile !== context.profile ||
        previous?.scope !== context.scope
      )
        this.uploadAbort?.abort();
      return;
    }
    if (!context || this.running || this.closing || this.client) return;
    let intent: RecordingUploadIntent | null;
    try {
      context.authorize();
      intent = this.local.nextRecordingUpload(
        context.profile,
        Number.MAX_SAFE_INTEGER,
      );
    } catch (error) {
      this.uploadContext = null;
      if (!(
        error instanceof ClientError &&
        [
          'workspace_changed',
          'workspace_closed',
          'workspace_transition',
        ].includes(error.code)
      ))
        this.report(error);
      return;
    }
    if (!intent) return;
    const delay = intent.retry_at - Date.now();
    if (delay > 0) {
      this.uploadTimer = setTimeout(
        () => {
          this.uploadTimer = null;
          this.resumeUploads(this.uploadContext);
        },
        Math.min(delay, 60_000),
      );
      this.uploadTimer.unref();
      return;
    }
    this.running = true;
    const work = this.runUpload(context, intent)
      .catch((error) => {
        try {
          const current = this.local.recordingUpload(
            context.profile,
            intent.document_id,
            intent.recording_id,
          );
          if (!current || current.state === 'paused') return;
          if (current.state === 'complete') {
            this.report(error);
            return;
          }
          const failure = problem(error);
          const cancelled =
            this.uploadContext?.profile !== context.profile ||
            this.uploadContext.scope !== context.scope ||
            this.uploadAbort?.signal.aborted ||
            (error instanceof ClientError &&
              ['request_cancelled', 'workspace_changed'].includes(error.code));
          const retryable =
            cancelled ||
            ((error instanceof ClientError ||
              error instanceof AudioHostError) &&
              error.retryable);
          const deleting = ['delete_pending', 'deleting'].includes(
            current.state,
          );
          this.local.saveRecordingUpload(context.profile, {
            ...current,
            state: deleting
              ? 'delete_pending'
              : cancelled
                ? 'queued'
                : retryable
                  ? 'waiting'
                  : 'attention',
            retry_at: cancelled
              ? 0
              : retryable
                ? Date.now() +
                  Math.max(
                    error instanceof ClientError
                      ? error.retryAfterSeconds * 1000
                      : 0,
                    Math.min(60_000, 1000 * 2 ** Math.min(current.attempts, 6)),
                  )
                : deleting
                  ? Number.MAX_SAFE_INTEGER
                  : 0,
            error: cancelled
              ? null
              : {
                  code: failure.code.slice(0, 80),
                  message: failure.message.slice(0, 512),
                },
          });
        } catch (failure) {
          if (!missing(failure)) {
            this.uploadContext = null;
            this.report(failure);
          }
        }
      })
      .finally(() => {
        this.uploadTask = null;
        this.uploadAbort = null;
        this.uploading = null;
        this.running = false;
        this.changed();
        this.resumeUploads(this.uploadContext);
      });
    this.uploadTask = work;
    this.changed();
  }
  private refreshRetention(context: RecordingUploadContext): void {
    if (
      this.retentionRead ||
      this.closing ||
      Date.now() < this.retentionReadAt ||
      (context.reads?.size ?? 0) >= 4
    )
      return;
    const read = new AbortController();
    const current = () =>
      !read.signal.aborted &&
      this.uploadContext?.profile === context.profile &&
      this.uploadContext.scope === context.scope &&
      this.uploadContext.api === context.api;
    this.retentionRead = read;
    context.reads?.add(read);
    const operation = async () => {
      context.authorize();
      const page = this.local.recordingRetentionCandidates(
        context.profile,
        this.retentionAfter,
      );
      this.retentionReadAt = Date.now() + (page.after ? 2_000 : 60_000);
      for (const intent of page.recordings) {
        if (!current()) return;
        context.authorize();
        try {
          const status = await context.api.request(
            `/v1/recordings/${intent.recording_id}/retention`,
            recordingRetentionSchema,
            {
              signal: AbortSignal.any([
                read.signal,
                AbortSignal.timeout(10_000),
              ]),
            },
          );
          if (!current()) return;
          context.authorize();
          if (
            status.id !== intent.recording_id ||
            status.document_id !== intent.document_id
          )
            throw new ClientError(
              'invalid_retention_response',
              'The service returned audio retention for a different recording or document.',
            );
          this.local.rememberRecordingRetention(
            context.profile,
            context.api.base,
            status,
          );
        } catch (error) {
          if (!current()) return;
          if (!missing(error) && !this.retentionFailed(error)) return;
        }
      }
      if (current()) {
        this.retentionAfter = page.after;
        if (!page.after) {
          if (!this.retentionRoundFailed) this.retentionError = null;
          this.retentionRoundFailed = false;
        }
      }
    };
    void operation()
      .catch((error: unknown) => {
        if (!current()) return;
        this.retentionFailed(error);
      })
      .finally(() => {
        context.reads?.delete(read);
        if (this.retentionRead === read) this.retentionRead = null;
        if (current()) this.changed();
      });
  }
  private retentionFailed(error: unknown): boolean {
    const failure = problem(error);
    if (
      [
        'workspace_changed',
        'workspace_closed',
        'workspace_transition',
      ].includes(failure.code)
    )
      return false;
    this.retentionError = {
      code: 'audio_retention_confirmation_failed',
      message:
        'Cloud audio retention could not be confirmed. Unconfirmed local audio was preserved; reconnect to the original workspace or check the service.',
    };
    this.retentionRoundFailed = true;
    this.retentionReadAt = Date.now() + 60_000;
    console.error(
      JSON.stringify({
        code: failure.code,
        operation: 'audio_retention_confirmation',
      }),
    );
    return true;
  }
  async setRetentionDays(
    profile: string,
    days: number,
    authorize: () => void,
  ): Promise<void> {
    authorize();
    this.local.setRecordingRetentionDays(profile, days);
    this.changed();
    await this.reconcile(profile);
    authorize();
  }
  private async runUpload(
    context: RecordingUploadContext,
    initial: RecordingUploadIntent,
  ) {
    const { profile } = context;
    this.uploading = {
      profile,
      document: initial.document_id,
      id: initial.recording_id,
    };
    const abort = new AbortController();
    this.uploadAbort = abort;
    this.error = null;
    const check = () => {
      context.authorize();
      if (
        abort.signal.aborted ||
        this.uploadContext?.profile !== profile ||
        this.uploadContext.scope !== context.scope
      )
        throw new ClientError(
          'request_cancelled',
          'Audio transfer stopped. Local audio was preserved.',
          0,
          true,
        );
      this.local.getRecording(
        profile,
        initial.document_id,
        initial.recording_id,
      );
    };
    check();
    const deleting = ['delete_pending', 'deleting'].includes(initial.state);
    const intent = this.local.saveRecordingUpload(profile, {
      ...initial,
      state: deleting ? 'deleting' : 'uploading',
      attempts: Math.min(initial.attempts + 1, Number.MAX_SAFE_INTEGER),
      retry_at: 0,
      error: null,
    });
    this.changed();
    if (deleting) {
      const result = await deleteSavedRemoteRecording(
        context.api,
        intent.document_id,
        intent.recording_id,
        abort.signal,
      );
      check();
      if (result.state !== 'cleanup_confirmed') {
        this.local.saveRecordingUpload(profile, {
          ...intent,
          state: 'delete_pending',
          retry_at: Date.now() + 30_000,
          error: result.cleanup_errors
            ? {
                code: 'remote_cleanup_pending',
                message:
                  'The service is retrying audio deletion. The encrypted local copy is kept until remote cleanup is confirmed.',
              }
            : null,
        });
        this.changed();
        return;
      }
      this.local.removeRecording(
        profile,
        intent.document_id,
        intent.recording_id,
      );
      await this.cleanup();
      return;
    }
    const native = () => {
      check();
      if (this.reviewing?.abort === abort) return this.reviewing.client;
      const client = this.create(() => {});
      this.reviewing = {
        client,
        profile,
        document: intent.document_id,
        id: intent.recording_id,
        revoked: false,
        abort,
      };
      return client;
    };
    try {
      await uploadSavedRecording({
        local: this.local,
        profile,
        intent,
        native,
        api: context.api,
        check,
        signal: abort.signal,
        allowLoopback: context.allowLoopback,
        changed: this.changed,
      });
    } finally {
      const review = this.reviewing;
      if (review?.abort === abort) {
        try {
          await review.client.close();
        } finally {
          if (this.reviewing === review) this.reviewing = null;
        }
      }
    }
  }
  private async review(
    profile: string,
    document: string,
    id: string,
    authorize: () => void,
    recover: boolean,
  ) {
    return this.exclusive(async () => {
      authorize();
      if (this.client)
        throw new LocalError(
          'recording_in_progress',
          'Stop capture before inspecting or recovering saved recordings.',
        );
      if (this.local.getRecording(profile, document, id).audio_retired_at)
        throw new LocalError(
          'local_audio_retired',
          'Local audio has reached its retention deadline and cannot be inspected or recovered.',
        );
      if (recover && this.local.recordingUpload(profile, document, id)?.plan)
        throw new LocalError(
          'upload_plan_frozen',
          'The uploaded recording structure is frozen. Preserved audio cannot be changed by recovery.',
        );
      const client = this.create(() => {});
      const review = { client, profile, document, id, revoked: false };
      this.reviewing = review;
      const check = () => {
        authorize();
        if (review.revoked)
          throw new LocalError(
            'recording_review_cancelled',
            'Audio inspection or recovery was cancelled. Inspect preserved files before retrying.',
          );
        return this.local.getRecording(profile, document, id);
      };
      try {
        const event = await client.request(
          recover
            ? {
                command: 'recover_recording',
                recording_id: id,
                accept_incomplete: true,
              }
            : { command: 'inspect_recording', recording_id: id },
        );
        const previous = check();
        if (
          (event.event_type !== 'recording.inspected' &&
            event.event_type !== 'recording.recovered') ||
          (event.event_type === 'recording.recovered') !== recover
        )
          throw new AudioHostError(
            'audio_protocol_error',
            'The helper did not return an integrity report.',
            false,
          );
        let tracks = previous.tracks;
        if (
          recover &&
          (event.event_type !== 'recording.recovered' ||
            event.payload.state === 'sealed' ||
            event.payload.state === 'key_unavailable' ||
            event.payload.recovered_chunks !== 0)
        )
          throw new AudioHostError(
            'audio_protocol_error',
            'Recovery did not confirm adoption of saved chunks into an interrupted recording.',
            false,
          );
        if (recover || event.payload.state === 'sealed') {
          const described = await client.request({
            command: 'get_recording',
            recording_id: id,
            offset: 0,
          });
          check();
          if (
            described.event_type !== 'recording.manifest' ||
            described.payload.state !== (recover ? 'failed' : 'sealed') ||
            described.payload.tracks.length !== tracks.length ||
            described.payload.tracks.reduce(
              (total, track) => total + track.saved_samples,
              0,
            ) !== event.payload.total_samples ||
            described.payload.tracks.reduce(
              (total, track) => total + track.chunk_count,
              0,
            ) !== event.payload.verified_chunks
          )
            throw new AudioHostError(
              'audio_protocol_error',
              'Verified chunk counts or manifest state are inconsistent.',
              false,
            );
          const savedTracks = described.payload.tracks;
          tracks = tracks.map((track) => {
            const saved = savedTracks.find(
              (value) => value.spec.track_id === track.spec.track_id,
            );
            if (
              !saved ||
              canonicalJson(saved.spec) !== canonicalJson(track.spec) ||
              (track.actual_device_id &&
                track.actual_device_id !== saved.actual_device_id) ||
              saved.saved_samples < track.saved_samples
            )
              throw new AudioHostError(
                'audio_protocol_error',
                'Inspection or recovery changed the recording source identity or lost acknowledged samples.',
                false,
              );
            return {
              ...track,
              actual_device_id: saved.actual_device_id,
              saved_samples: saved.saved_samples,
            };
          });
        }
        this.local.updateRecording(profile, document, id, {
          state: event.payload.state === 'sealed' ? 'sealed' : 'interrupted',
          tracks,
          inspection: event.payload,
          error:
            event.payload.state === 'sealed'
              ? null
              : {
                  code: 'recording_incomplete',
                  message: recover
                    ? 'Authenticated saved chunks were recovered. Capture was not resumed; the uncommitted audio tail may still be missing.'
                    : 'Inspection did not confirm a complete sealed recording. Saved files were preserved.',
                },
        });
      } finally {
        try {
          await client.close();
        } finally {
          if (this.reviewing === review) this.reviewing = null;
        }
      }
    });
  }
  snapshot(profile: string, document: string | null, offset = 0) {
    const page = document
      ? this.local.recordings(profile, document, offset)
      : { recordings: [], has_more: false };
    let active: LocalRecording | null = null;
    let activeUpload = null;
    if (this.uploading?.profile === profile) {
      try {
        activeUpload = this.local.recordingUploadStatus(
          profile,
          this.uploading.document,
          this.uploading.id,
        );
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    if (this.owner?.profile === profile && !this.revoked) {
      try {
        active = this.local.getRecording(
          profile,
          this.owner.document_id,
          this.owner.recording_id,
        );
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return {
      document_id: document,
      active,
      levels: active?.state === 'recording' ? this.levels : null,
      live:
        this.live?.profile === profile &&
        (document === null ||
          this.live.preview.snapshot().document_id === document)
          ? this.live.preview.snapshot()
          : null,
      ...page,
      offset,
      busy: this.running || this.closing !== null,
      pending_deletions: this.local.pendingRecordingDeletions().length,
      error: this.error,
      cleanup_error: this.cleanupError,
      storage_quota_gib: this.local.recordingQuotaGiB(),
      storage: this.storage,
      storage_error: this.storageError,
      retention_days: this.local.recordingRetentionDays(profile),
      retention: page.recordings.flatMap((recording) => {
        const status = this.local.recordingRetention(
          profile,
          recording.document_id,
          recording.id,
        );
        return status ? [status] : [];
      }),
      retention_error:
        this.uploadContext?.profile === profile ? this.retentionError : null,
      upload_available: this.uploadContext?.profile === profile,
      uploads: page.recordings.flatMap((recording) => {
        const status = this.local.recordingUploadStatus(
          profile,
          recording.document_id,
          recording.id,
        );
        return status ? [status] : [];
      }),
      active_upload: activeUpload,
      upload_destination:
        this.uploadContext?.profile === profile
          ? this.uploadContext.api.base
          : null,
    };
  }
  async reconcile(profile: string): Promise<void> {
    if (this.uploadContext && this.uploadContext.profile !== profile)
      this.resumeUploads(null);
    const review = this.reviewing;
    if (review) {
      let forbidden = review.profile !== profile;
      if (!forbidden) {
        try {
          this.local.getRecording(review.profile, review.document, review.id);
        } catch (error) {
          if (!missing(error)) {
            await this.closeReview();
            this.report(error);
            throw error;
          }
          forbidden = true;
        }
      }
      if (forbidden) await this.closeReview();
    }
    if (this.owner && this.client) {
      let forbidden = this.owner.profile !== profile;
      if (!forbidden) {
        try {
          this.local.getRecording(
            this.owner.profile,
            this.owner.document_id,
            this.owner.recording_id,
          );
        } catch (error) {
          if (!missing(error)) {
            this.revoked = true;
            this.report(error);
            await this.release(this.client);
            throw error;
          }
          forbidden = true;
        }
      }
      if (forbidden) {
        this.revoked = true;
        this.live?.preview.cancel(true);
        void this.release(this.client).catch((error: unknown) =>
          this.report(error),
        );
      }
    }
    try {
      if (this.local.expireRecordingRetention()) this.changed();
    } catch (error) {
      this.report(error);
      throw error;
    }
    await this.cleanup();
  }
  cleanup(): Promise<void> {
    if (this.cleaning) return this.cleaning;
    const operation = (async () => {
      this.cleanupError = null;
      try {
        for (const id of this.local.pendingRecordingDeletions()) {
          if (this.reviewing?.id === id) await this.closeReview();
          if (this.owner?.recording_id === id && this.client) {
            this.revoked = true;
            await this.release(this.client);
          }
          await this.remove(id);
          this.local.acknowledgeRecordingDeletion(id);
        }
      } catch (error) {
        this.cleanupError = {
          code: 'recording_cleanup_failed',
          message:
            'Deleted audio files could not be removed. Cleanup remains queued for retry; keep the local data directory protected.',
        };
        console.error(
          JSON.stringify({
            code: this.cleanupError.code,
            kind: error instanceof Error ? error.name : 'unknown',
          }),
        );
        throw error;
      }
    })().finally(() => {
      this.cleaning = null;
      this.changed();
    });
    this.cleaning = operation;
    return operation;
  }
}
