import { createHash } from 'node:crypto';
import type { AudioEvent } from '@windows-ai-notes/contracts';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import {
  recordingUploadPlanSchema,
  type LocalRecording,
  type RecordingUploadIntent,
  type RecordingUploadPlan,
} from '@windows-ai-notes/contracts/recording';
import {
  remoteRecordingSchema,
  recordingDeletionSchema,
  type RecordingSeal,
  type RemoteRecording,
} from '@windows-ai-notes/contracts/uploads';
import { LocalError, type LocalStore } from '@windows-ai-notes/local';
import { AudioHostError, type AudioHostClient } from './audio.js';
import { ApiClient, ClientError } from './http.js';
import { RecordingUploadTransport } from './uploads.js';

type Native = Pick<AudioHostClient, 'request' | 'readChunk'>;
type Manifest = Extract<
  AudioEvent,
  { event_type: 'recording.manifest' }
>['payload'];
const invalid = (message: string): never => {
  throw new AudioHostError('audio_protocol_error', message, false);
};
export async function prepareRecordingUpload(
  client: Native,
  recording: LocalRecording,
  acceptIncomplete: boolean,
  check: () => void,
): Promise<{
  plan: RecordingUploadPlan;
  inspection: NonNullable<LocalRecording['inspection']>;
}> {
  check();
  const inspected = await client.request({
    command: 'inspect_recording',
    recording_id: recording.id,
  });
  check();
  if (inspected.event_type !== 'recording.inspected')
    return invalid('The helper did not authenticate the saved recording.');
  const inspection = inspected.payload;
  if (
    inspection.state === 'key_unavailable' ||
    inspection.recovered_chunks !== 0 ||
    inspection.issues.some((issue) => issue.code !== 'unsealed_tail')
  )
    throw new LocalError(
      'recording_recovery_required',
      'Inspect and recover authenticated saved chunks before uploading. Damaged or ambiguous audio cannot be uploaded.',
    );
  if (
    (inspection.state !== 'sealed' || inspection.issues.length !== 0) &&
    !acceptIncomplete
  )
    throw new LocalError(
      'incomplete_upload_not_accepted',
      'Explicitly accept the incomplete recording before uploading its saved audio.',
    );
  let manifest: Manifest | null = null;
  const events: RecordingSeal['events'] = [];
  let offset = 0;
  while (true) {
    const event = await client.request({
      command: 'get_recording',
      recording_id: recording.id,
      offset,
    });
    check();
    if (
      event.event_type !== 'recording.manifest' ||
      event.payload.event_offset !== offset ||
      event.payload.recording_id !== recording.id
    )
      return invalid(
        'The helper returned an inconsistent recording timeline page.',
      );
    const page = event.payload;
    if (!manifest) manifest = page;
    const identity = (value: Manifest) =>
      canonicalJson({ ...value, event_offset: 0, events: [], has_more: false });
    if (
      identity(page) !== identity(manifest) ||
      (page.has_more && page.events.length === 0) ||
      offset + page.events.length > page.event_count ||
      page.has_more !== offset + page.events.length < page.event_count
    )
      return invalid(
        'The saved manifest changed while preparing an immutable upload.',
      );
    events.push(...page.events);
    offset += page.events.length;
    if (!page.has_more) break;
  }
  if (
    !manifest ||
    events.length !== manifest.event_count ||
    (manifest.state === 'sealed') !== (inspection.state === 'sealed') ||
    manifest.tracks.length !== recording.tracks.length ||
    manifest.tracks.reduce((sum, t) => sum + t.saved_samples, 0) !==
      inspection.total_samples ||
    manifest.tracks.reduce((sum, t) => sum + t.chunk_count, 0) !==
      inspection.verified_chunks
  )
    return invalid(
      'The authenticated recording report and manifest totals disagree.',
    );
  for (const track of recording.tracks) {
    const saved = manifest.tracks.find(
      (t) => t.spec.track_id === track.spec.track_id,
    );
    if (
      !saved ||
      canonicalJson(saved.spec) !== canonicalJson(track.spec) ||
      (track.actual_device_id !== null &&
        track.actual_device_id !== saved.actual_device_id) ||
      saved.saved_samples < track.saved_samples
    )
      return invalid(
        'The helper changed a saved recording source or lost acknowledged samples.',
      );
  }
  if (manifest.state !== 'sealed' && !acceptIncomplete)
    throw new LocalError(
      'incomplete_upload_not_accepted',
      'Explicitly accept this interrupted recording before uploading.',
    );
  const plan: RecordingUploadPlan = {
    create: {
      id: recording.id,
      created_at: new Date(manifest.created_at).toISOString(),
      tracks: manifest.tracks.map((t) => ({
        spec: t.spec,
        actual_device_id: t.actual_device_id,
      })),
    },
    chunks: [],
    seal: {
      native_state: manifest.state,
      accept_incomplete: acceptIncomplete,
      tracks: [],
      events,
      gaps: [],
    },
  };
  for (const track of manifest.tracks) {
    const ids: string[] = [];
    let position = 0;
    let sequence = 0;
    while (true) {
      const event = await client.request({
        command: 'list_recording_chunks',
        recording_id: recording.id,
        track_id: track.spec.track_id,
        sequence_start: sequence,
      });
      check();
      if (
        event.event_type !== 'recording.chunks' ||
        event.payload.track_id !== track.spec.track_id ||
        event.payload.sequence_start !== sequence ||
        event.payload.has_more !==
          sequence + event.payload.chunks.length < track.chunk_count ||
        sequence + event.payload.chunks.length > track.chunk_count ||
        (event.payload.has_more && event.payload.chunks.length === 0)
      )
        return invalid(
          'The helper returned inconsistent saved-chunk pagination.',
        );
      for (const upload of event.payload.chunks) {
        if (
          upload.chunk.sample_start !== position ||
          upload.chunk.sequence !== sequence ||
          upload.chunk.track_id !== track.spec.track_id ||
          upload.chunk.recording_id !== recording.id
        )
          return invalid(
            'The saved track has changed identity, missing or overlapping samples.',
          );
        ids.push(upload.chunk.chunk_id);
        plan.chunks.push(upload);
        position += upload.chunk.sample_count;
        sequence++;
      }
      if (!event.payload.has_more) break;
    }
    if (sequence !== track.chunk_count || position !== track.saved_samples)
      return invalid(
        'The saved track totals do not match its authenticated chunks.',
      );
    plan.seal.tracks.push({
      track_id: track.spec.track_id,
      end_sample: position,
      chunk_ids: ids,
    });
  }
  if (plan.chunks.length === 0)
    throw new LocalError(
      'recording_empty',
      'There are no authenticated saved audio chunks to upload.',
    );
  let pause: number | null = null;
  let clock = 0;
  for (const event of events) {
    if (event.clock_ms < clock)
      return invalid('The saved event timeline is not monotonic.');
    clock = event.clock_ms;
    if (event.event_type === 'capture.paused') pause = event.clock_ms;
    else if (
      pause !== null &&
      ['capture.started', 'capture.stopped', 'capture.failed'].includes(
        event.event_type,
      )
    ) {
      if (event.clock_ms < pause)
        return invalid('The saved pause timeline is not monotonic.');
      for (const track of manifest.tracks)
        plan.seal.gaps.push({
          track_id: track.spec.track_id,
          start_ms: pause,
          end_ms: event.clock_ms,
          reason: 'paused',
        });
      pause = null;
    }
  }
  return { plan: recordingUploadPlanSchema.parse(plan), inspection };
}

export async function uploadSavedRecording(options: {
  local: LocalStore;
  profile: string;
  intent: RecordingUploadIntent;
  native: () => Native;
  api: ApiClient;
  check: () => void;
  signal: AbortSignal;
  allowLoopback?: boolean | undefined;
  changed: () => void;
}) {
  const { local, profile, api, signal, check } = options;
  let intent = options.intent;
  const registered = intent.plan !== null;
  const save = (patch: Partial<RecordingUploadIntent>) => {
    check();
    intent = local.saveRecordingUpload(profile, { ...intent, ...patch });
    options.changed();
  };
  const digest = (plan: RecordingUploadPlan) =>
    createHash('sha256').update(canonicalJson(plan.seal)).digest('hex');
  const validate = (remote: RemoteRecording, plan: RecordingUploadPlan) => {
    if (
      remote.id !== intent.recording_id ||
      remote.document_id !== intent.document_id ||
      Date.parse(remote.created_at) !== Date.parse(plan.create.created_at) ||
      canonicalJson(remote.tracks) !== canonicalJson(plan.create.tracks) ||
      remote.chunk_count > plan.chunks.length ||
      remote.verified_chunks > remote.chunk_count ||
      remote.verified_chunks < intent.verified_chunks ||
      (remote.seal_sha256 === null
        ? remote.state !== 'uploading' || remote.partial
        : remote.seal_sha256 !== digest(plan) ||
          remote.partial !== plan.seal.accept_incomplete) ||
      (remote.state === 'ready' &&
        (remote.chunk_count !== plan.chunks.length ||
          remote.verified_chunks !== remote.chunk_count))
    )
      throw new ClientError(
        'invalid_upload_response',
        'The service changed the recording identity, sources or immutable seal. Local audio was preserved.',
      );
  };
  const create = async (plan: RecordingUploadPlan) => {
    const remote = await api.request(
      `/v1/documents/${intent.document_id}/recordings`,
      remoteRecordingSchema,
      {
        method: 'POST',
        body: plan.create,
        key: `recording:${intent.recording_id}`,
        signal,
      },
    );
    check();
    validate(remote, plan);
    return remote;
  };
  const finish = (remote: RemoteRecording, plan: RecordingUploadPlan) => {
    validate(remote, plan);
    if (
      remote.state !== 'ready' ||
      remote.seal_sha256 !== digest(plan) ||
      remote.chunk_count !== plan.chunks.length ||
      remote.verified_chunks !== plan.chunks.length
    )
      throw new ClientError(
        'invalid_upload_response',
        'The service did not confirm the complete immutable recording. Local audio was preserved.',
      );
    save({
      state: 'complete',
      verified_chunks: plan.chunks.length,
      verified_bytes: plan.chunks.reduce(
        (sum, chunk) => sum + chunk.size_bytes,
        0,
      ),
      retry_at: 0,
      error: null,
    });
  };
  const seal = async (plan: RecordingUploadPlan) => {
    const remote = await api.request(
      `/v1/recordings/${intent.recording_id}/seal`,
      remoteRecordingSchema,
      {
        method: 'POST',
        body: plan.seal,
        key: `seal:${intent.recording_id}`,
        signal,
      },
    );
    check();
    finish(remote, plan);
  };
  if (intent.plan) {
    const existing = await create(intent.plan);
    check();
    if (
      existing.state === 'ready' &&
      existing.seal_sha256 === digest(intent.plan) &&
      existing.chunk_count === intent.plan.chunks.length &&
      existing.verified_chunks === existing.chunk_count
    ) {
      finish(existing, intent.plan);
      return;
    }
    if (intent.verified_chunks === intent.plan.chunks.length) {
      await seal(intent.plan);
      return;
    }
  }
  const client = options.native();
  const recording = local.getRecording(
    profile,
    intent.document_id,
    intent.recording_id,
  );
  const prepared = await prepareRecordingUpload(
    client,
    recording,
    intent.accept_incomplete,
    check,
  );
  check();
  if (
    intent.plan &&
    canonicalJson(intent.plan) !== canonicalJson(prepared.plan)
  )
    throw new LocalError(
      'upload_plan_changed',
      'Saved recording metadata changed after upload was frozen. Local audio was preserved.',
    );
  const plan = intent.plan ?? prepared.plan;
  local.updateRecording(profile, recording.document_id, recording.id, {
    state: plan.seal.native_state === 'sealed' ? 'sealed' : 'interrupted',
    tracks: recording.tracks.map((track) => ({
      ...track,
      actual_device_id: plan.create.tracks.find(
        (t) => t.spec.track_id === track.spec.track_id,
      )!.actual_device_id,
      saved_samples: plan.seal.tracks.find(
        (t) => t.track_id === track.spec.track_id,
      )!.end_sample,
    })),
    inspection: prepared.inspection,
  });
  save({
    plan,
    total_chunks: plan.chunks.length,
    partial: plan.seal.accept_incomplete,
  });
  if (!registered) await create(plan);
  const transport = new RecordingUploadTransport(api, {
    allowLoopback: options.allowLoopback ?? false,
  });
  let bytes = 0;
  for (const [index, chunk] of plan.chunks.entries()) {
    check();
    bytes += chunk.size_bytes;
    if (index < intent.verified_chunks) continue;
    await transport.chunk(
      chunk,
      (s) => client.readChunk(recording.id, chunk, s),
      { authorize: check, signal },
    );
    save({
      verified_chunks: Math.max(intent.verified_chunks, index + 1),
      verified_bytes: Math.max(intent.verified_bytes, bytes),
    });
  }
  check();
  await seal(plan);
}

export async function deleteSavedRemoteRecording(
  api: ApiClient,
  document: string,
  id: string,
  signal: AbortSignal,
) {
  return api.request(
    `/v1/documents/${document}/recordings/${id}`,
    recordingDeletionSchema,
    { method: 'DELETE', signal },
  );
}
