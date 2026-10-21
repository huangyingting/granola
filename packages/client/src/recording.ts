import { canonicalJson } from '@windows-ai-notes/contracts/content';
import type { AudioEvent, Track } from '@windows-ai-notes/contracts';
import type {
  LocalRecording,
  RecordingOwner,
} from '@windows-ai-notes/contracts/recording';
import { LocalError, LocalStore } from '@windows-ai-notes/local';
import { AudioHostError, type AudioHostClient } from './audio.js';
import { ClientError } from './http.js';

type AudioClient = Pick<AudioHostClient, 'request' | 'close' | 'failure'>;
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
  private client: AudioClient | null = null;
  private owner: RecordingOwner | null = null;
  private revoked = false;
  private running = false;
  private closing: Promise<void> | null = null;
  private cleaning: Promise<void> | null = null;
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
      this.error = problem(error);
      throw error;
    } finally {
      this.running = false;
      this.changed();
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
    if (this.closing) return this.closing;
    const operation = (async () => {
      try {
        await client.close();
      } catch (error) {
        this.failRecording(error);
        throw error;
      } finally {
        if (this.client === client) {
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
    const owner = this.owner;
    if (!owner || this.revoked || event.recording_id !== owner.recording_id)
      return;
    switch (event.event_type) {
      case 'recording.started':
      case 'recording.paused':
      case 'recording.resumed':
      case 'recording.stopped':
      case 'recording.status': {
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
  }
  listDevices() {
    if (this.deviceRequest) return this.deviceRequest;
    const request = this.exclusive(async () => {
      const temporary = !this.client;
      const client = this.client ?? this.create(() => {});
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
  async inspect(
    profile: string,
    document: string,
    id: string,
    authorize: () => void,
  ) {
    return this.exclusive(async () => {
      authorize();
      if (this.client)
        throw new LocalError(
          'recording_in_progress',
          'Stop capture before inspecting saved recordings.',
        );
      this.local.getRecording(profile, document, id);
      const client = this.create(() => {});
      try {
        const event = await client.request({
          command: 'inspect_recording',
          recording_id: id,
        });
        authorize();
        if (event.event_type !== 'recording.inspected')
          throw new AudioHostError(
            'audio_protocol_error',
            'The helper did not return an integrity report.',
            false,
          );
        this.local.updateRecording(profile, document, id, {
          state: event.payload.state === 'sealed' ? 'sealed' : 'interrupted',
          inspection: event.payload,
          error:
            event.payload.state === 'sealed'
              ? null
              : {
                  code: 'recording_incomplete',
                  message:
                    'Inspection did not confirm a complete sealed recording. Saved files were preserved.',
                },
        });
      } finally {
        await client.close();
      }
    });
  }
  snapshot(profile: string, document: string | null, offset = 0) {
    const page = document
      ? this.local.recordings(profile, document, offset)
      : { recordings: [], has_more: false };
    let active: LocalRecording | null = null;
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
      ...page,
      offset,
      busy: this.running || this.closing !== null,
      pending_deletions: this.local.pendingRecordingDeletions().length,
      error: this.error,
      cleanup_error: this.cleanupError,
    };
  }
  async reconcile(profile: string): Promise<void> {
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
        void this.release(this.client).catch((error: unknown) =>
          this.report(error),
        );
      }
    }
    await this.cleanup();
  }
  cleanup(): Promise<void> {
    if (this.cleaning) return this.cleaning;
    const operation = (async () => {
      this.cleanupError = null;
      try {
        for (const id of this.local.pendingRecordingDeletions()) {
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
