import { setTimeout as delay } from 'node:timers/promises';
import {
  liveAudioBatchSchema,
  type LiveAudioBatch,
} from '@windows-ai-notes/contracts';
import type {
  LocalRecording,
  LivePreviewState,
} from '@windows-ai-notes/contracts/recording';
import type {
  LiveSource,
  LiveServerMessage,
} from '@windows-ai-notes/contracts/realtime';
import { LocalError } from '@windows-ai-notes/local';
import { AudioHostError, type AudioHostClient } from './audio.js';
import { ClientError, type ApiClient } from './http.js';
import type { LiveConnection } from './live.js';

type Native = Pick<AudioHostClient, 'request'>;
export interface LivePreviewContext {
  api: Pick<ApiClient, 'document' | 'openLiveSource'>;
  authorize: () => void;
  prepare: () => Promise<void>;
}
interface Source {
  identity: LiveSource;
  connection?: LiveConnection;
  state: LivePreviewState['sources'][number];
  revisions: Map<string, { version: number; final: boolean }>;
}
const fault = (code: string, message: string) => new ClientError(code, message);

export class RecordingLivePreview {
  private readonly abort = new AbortController();
  private task: Promise<void> | undefined;
  private preview: LiveAudioBatch | undefined;
  private sources = new Map<string, Source>();
  private state: LivePreviewState;
  constructor(
    private readonly native: Native,
    private readonly recording: LocalRecording,
    private readonly context: LivePreviewContext,
    private readonly changed: () => void,
    locale: LivePreviewState['locale'],
    previous?: LivePreviewState,
  ) {
    if (previous && previous.attempt >= 100_000)
      throw fault(
        'live_attempt_limit',
        'This preview reached its attempt limit.',
      );
    this.state = {
      document_id: recording.document_id,
      recording_id: recording.id,
      locale,
      phase: 'starting',
      running: true,
      attempt: previous ? previous.attempt + 1 : 1,
      canonical: false,
      continuity: 'unverified',
      usage_status: 'check_account',
      sources: [],
      segments: previous?.segments ?? [],
      boundaries: previous?.boundaries ?? [],
      gaps: previous?.gaps ?? [],
      omitted: previous?.omitted ?? false,
      error: null,
    };
    this.boundary(previous ? 'uncertain_previous_tail' : 'started');
  }
  get running() {
    return this.state.running;
  }
  snapshot(): LivePreviewState {
    return structuredClone(this.state);
  }
  start() {
    if (this.task)
      throw fault('live_preview_active', 'A live preview is already running.');
    this.task = this.run()
      .catch((error: unknown) => {
        if (!this.abort.signal.aborted) this.fail(error);
      })
      .finally(() => {
        this.state.running = false;
        this.changed();
      });
    this.changed();
  }
  cancel(clear = false) {
    const cleared =
      clear &&
      (this.state.segments.length > 0 ||
        this.state.sources.length > 0 ||
        this.state.boundaries.length > 0 ||
        this.state.gaps.length > 0 ||
        this.state.error !== null);
    if (clear) {
      this.state.segments = [];
      this.state.sources = [];
      this.state.boundaries = [];
      this.state.gaps = [];
      this.state.error = null;
    }
    if (!this.abort.signal.aborted) {
      this.abort.abort();
      if (!this.state.error) this.state.phase = 'stopped';
      this.changed();
    } else if (cleared) {
      this.changed();
    }
  }
  async closed() {
    await this.task;
  }
  private authorize() {
    this.abort.signal.throwIfAborted();
    this.context.authorize();
  }
  private fail(error: unknown) {
    if (this.abort.signal.aborted) return;
    if (
      error instanceof ClientError ||
      error instanceof AudioHostError ||
      error instanceof LocalError
    )
      this.state.error = {
        code: error.code.slice(0, 80),
        message: error.message.slice(0, 512),
      };
    else {
      console.error(
        JSON.stringify({
          code: 'live_preview_failed',
          kind: error instanceof Error ? error.name : 'unknown',
        }),
      );
      this.state.error = {
        code: 'live_preview_failed',
        message:
          'Live preview stopped. Saved audio and manual notes were not changed; check account usage before starting another attempt.',
      };
    }
    this.state.phase = 'attention';
    if (
      error instanceof LocalError ||
      (error instanceof ClientError &&
        ([401, 403, 404].includes(error.status) ||
          [
            'document_not_found',
            'workspace_not_found',
            'reauthentication_required',
            'live_lease_lost',
            'live_auth_expired',
            'live_session_expired',
            'live_authentication_required',
            'live_owner_changed',
            'workspace_changed',
            'live_access_denied',
            'live_authorization_lost',
          ].includes(error.code)))
    ) {
      this.state.segments = [];
      this.state.gaps = [];
      this.state.sources = [];
    }
    this.abort.abort();
    this.changed();
  }
  private boundary(reason: LivePreviewState['boundaries'][number]['reason']) {
    this.state.boundaries.push({ attempt: this.state.attempt, reason });
    if (this.state.boundaries.length > 8) {
      this.state.boundaries.shift();
      this.state.omitted = true;
    }
  }
  private gap(
    source: Source,
    start: number,
    end: number,
    reason: LivePreviewState['gaps'][number]['reason'],
  ) {
    source.state.skipped_samples += end - start;
    const previous = this.state.gaps.findLast(
      (gap) =>
        gap.source.preview_id === source.identity.preview_id &&
        gap.source.track_id === source.identity.track_id &&
        gap.reason === reason &&
        gap.sample_end === start,
    );
    if (previous) previous.sample_end = end;
    else
      this.state.gaps.push({
        attempt: this.state.attempt,
        source: source.identity,
        sample_start: start,
        sample_end: end,
        reason,
      });
    if (this.state.gaps.length > 8) {
      this.state.gaps.shift();
      this.state.omitted = true;
    }
  }
  private event(source: Source, message: LiveServerMessage): undefined {
    if (
      this.abort.signal.aborted ||
      this.sources.get(source.identity.track_id) !== source
    )
      return undefined;
    this.authorize();
    if (message.event_type === 'live.ready')
      source.state.provider_epoch = message.provider_epoch;
    else if (message.event_type === 'live.accepted') {
      source.state.accepted_samples = message.accepted_samples;
      if (message.gap)
        this.gap(
          source,
          message.gap.sample_start,
          message.gap.sample_end,
          'authorization',
        );
    } else if (message.event_type.startsWith('transcript.')) {
      if (!('segment_id' in message))
        throw fault(
          'live_invalid_result',
          'The live result changed its format.',
        );
      const prior = source.revisions.get(message.segment_id);
      if (
        prior &&
        (message.version <= prior.version ||
          (prior.final && message.event_type === 'transcript.partial'))
      )
        throw fault(
          'live_revision_conflict',
          'Live preview returned an inconsistent segment revision.',
        );
      if (!prior && source.revisions.size >= 256)
        throw fault(
          'live_revision_limit',
          'This preview exceeded its bounded revision history.',
        );
      source.revisions.set(message.segment_id, {
        version: message.version,
        final: message.event_type !== 'transcript.partial',
      });
      const existing = this.state.segments.findIndex(
        (entry) =>
          entry.event.provider_epoch === message.provider_epoch &&
          entry.event.segment_id === message.segment_id,
      );
      if (existing >= 0) this.state.segments.splice(existing, 1);
      if (message.event_type !== 'transcript.discarded')
        this.state.segments.push({
          attempt: this.state.attempt,
          event: message,
        });
      while (
        this.state.segments.length > 12 ||
        Buffer.byteLength(JSON.stringify(this.state.segments)) > 16_384
      ) {
        this.state.segments.shift();
        this.state.omitted = true;
      }
    }
    this.changed();
    return undefined;
  }
  private async startAttempt() {
    this.authorize();
    const event = await this.native.request({
      command: 'start_live_preview',
      recording_id: this.recording.id,
      max_buffered_ms: 2500,
    });
    if (
      event.event_type !== 'recording.live_started' ||
      event.recording_id !== this.recording.id
    )
      throw fault(
        'live_native_state',
        'The helper did not start the requested preview.',
      );
    this.preview = liveAudioBatchSchema.parse(event.payload);
    this.authorize();
    if (
      this.preview.tracks.length !== this.recording.tracks.length ||
      this.preview.tracks.some(
        (track) =>
          !this.recording.tracks.some(
            (known) => known.spec.track_id === track.track_id,
          ),
      )
    )
      throw fault(
        'live_native_source',
        'The preview changed its native capture sources.',
      );
    this.sources = new Map(
      this.recording.tracks.map((track) => {
        const source: Source = {
          identity: {
            recording_id: this.recording.id,
            preview_id: this.preview!.preview_id,
            capture_epoch: this.preview!.capture_epoch,
            track_id: track.spec.track_id,
          },
          state: {
            track_id: track.spec.track_id,
            kind: track.spec.kind,
            provider_epoch: null,
            accepted_samples: 0,
            skipped_samples: 0,
          },
          revisions: new Map(),
        };
        return [track.spec.track_id, source];
      }),
    );
    this.state.sources = [...this.sources.values()].map(
      (source) => source.state,
    );
    this.state.phase = 'starting';
    this.state.usage_status = 'check_account';
    const openings = [...this.sources.values()].map(async (source) => {
      const connection = await this.context.api.openLiveSource(
        this.recording.document_id,
        {
          source: source.identity,
          locale: this.state.locale,
          consent: true,
          signal: this.abort.signal,
          authorize: () => this.authorize(),
          onEvent: (message) => this.event(source, message),
        },
      );
      source.connection = connection;
      void connection.completion.catch((error: unknown) => this.fail(error));
      try {
        this.authorize();
      } catch (error) {
        await connection.cancel();
        throw error;
      }
      this.changed();
    });
    const ready = Promise.all(openings);
    void ready.catch((error: unknown) => this.fail(error));
    return { ready, deadline: performance.now() + 60_000 };
  }
  private async read() {
    this.authorize();
    const preview = this.preview!;
    const event = await this.native.request({
      command: 'read_live_audio',
      recording_id: this.recording.id,
      preview_id: preview.preview_id,
    });
    this.authorize();
    if (
      event.event_type !== 'recording.live_audio' ||
      event.recording_id !== this.recording.id
    )
      throw fault(
        'live_native_state',
        'The helper did not return a bounded live read.',
      );
    const batch = liveAudioBatchSchema.parse(event.payload);
    if (
      batch.preview_id !== preview.preview_id ||
      batch.capture_epoch !== preview.capture_epoch ||
      batch.tracks.length !== this.sources.size ||
      batch.tracks.some((track) => !this.sources.has(track.track_id))
    )
      throw fault(
        'live_native_source',
        'Live capture changed preview, epoch or tracks.',
      );
    if (batch.state !== 'active')
      throw fault(
        batch.code ?? 'live_native_stopped',
        'Live preview stopped or exceeded its native buffer. Encrypted capture continues independently.',
      );
    const writes: Promise<unknown>[] = [];
    const groups = [...this.sources.values()].map((source) => ({
      source,
      frames: batch.frames.filter(
        (frame) => frame.track_id === source.identity.track_id,
      ),
    }));
    if (
      groups.some(
        ({ source, frames }) =>
          source.connection &&
          source.state.accepted_samples + frames.length * 800 > 960_000,
      )
    ) {
      for (const { source, frames } of groups)
        if (frames.length)
          this.gap(
            source,
            frames[0]!.sample_start,
            frames.at(-1)!.sample_start + 800,
            'rotation',
          );
      return false;
    }
    for (const { source, frames } of groups) {
      if (!frames.length) continue;
      if (!source.connection) {
        this.gap(
          source,
          frames[0]!.sample_start,
          frames.at(-1)!.sample_start + 800,
          'startup',
        );
        this.changed();
      } else {
        writes.push(source.connection.write(frames));
      }
    }
    await Promise.all(writes);
    return true;
  }
  private async stopNative() {
    const preview = this.preview;
    this.preview = undefined;
    if (!preview) return;
    try {
      const result = await this.native.request({
        command: 'stop_live_preview',
        recording_id: this.recording.id,
        preview_id: preview.preview_id,
      });
      if (
        result.event_type !== 'recording.live_stopped' ||
        result.recording_id !== this.recording.id ||
        result.payload.preview_id !== preview.preview_id ||
        result.payload.capture_epoch !== preview.capture_epoch
      )
        throw fault(
          'live_native_state',
          'The helper did not confirm preview cleanup.',
        );
    } catch (error) {
      if (!this.abort.signal.aborted) throw error;
      console.error(
        JSON.stringify({
          code: 'live_preview_cleanup_interrupted',
          kind: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  }
  private async run() {
    try {
      this.authorize();
      let aborted!: () => void;
      try {
        await Promise.race([
          this.context.prepare(),
          new Promise<never>((_resolve, reject) => {
            aborted = () =>
              reject(fault('live_cancelled', 'Live preview was cancelled.'));
            this.abort.signal.addEventListener('abort', aborted, {
              once: true,
            });
            if (this.abort.signal.aborted) aborted();
          }),
        ]);
      } finally {
        if (aborted) this.abort.signal.removeEventListener('abort', aborted);
      }
      this.authorize();
      await this.context.api.document(
        this.recording.document_id,
        this.abort.signal,
      );
      while (!this.abort.signal.aborted) {
        const attempt = await this.startAttempt();
        while (
          !this.abort.signal.aborted &&
          performance.now() < attempt.deadline
        ) {
          if (!(await this.read())) break;
          if ([...this.sources.values()].every((source) => source.connection)) {
            if (this.state.phase !== 'live') {
              this.state.phase = 'live';
              this.changed();
            }
          }
          await delay(50, undefined, { signal: this.abort.signal });
        }
        this.authorize();
        await attempt.ready;
        this.state.phase = 'finishing';
        this.changed();
        await this.stopNative();
        const sockets = [...this.sources.values()].map(
          (source) => source.connection!,
        );
        const results = await Promise.all(
          sockets.map((socket) => socket.finish()),
        );
        await Promise.all(sockets.map((socket) => socket.closed));
        if (results.some((value) => value.usage_status !== 'settled'))
          throw fault(
            'live_usage_unconfirmed',
            'Preview usage was not confirmed. Check the account allowance before starting another attempt.',
          );
        this.state.usage_status = 'settled';
        this.state.phase = 'rotating';
        this.changed();
        await delay(1000, undefined, { signal: this.abort.signal });
        this.authorize();
        if (this.state.attempt >= 100_000)
          throw fault(
            'live_attempt_limit',
            'This preview reached its attempt limit.',
          );
        this.state.attempt++;
        this.boundary('normal_rotation');
      }
    } catch (error) {
      if (!this.abort.signal.aborted) this.fail(error);
    } finally {
      this.abort.abort();
      try {
        await this.stopNative();
      } finally {
        await Promise.all(
          [...this.sources.values()].map((source) =>
            source.connection?.cancel(),
          ),
        );
      }
    }
  }
}
