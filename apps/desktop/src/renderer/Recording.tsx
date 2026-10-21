import { useEffect, useRef, useState } from 'react';
import type { AudioEvent, Track } from '@windows-ai-notes/contracts';
import type {
  DesktopCommand,
  DesktopState,
} from '@windows-ai-notes/contracts/desktop';
import type {
  AudioState,
  LocalRecording,
  RecordingUploadStatus,
} from '@windows-ai-notes/contracts/recording';

const labels = {
  starting: 'Starting audio',
  recording: 'Recording',
  paused: 'Paused',
  sealed: 'Sealed locally',
  failed: 'Capture failed',
  interrupted: 'Needs inspection',
};
function duration(samples: number) {
  const seconds = Math.floor(samples / 16000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function CaptureMeters({
  active,
  levels,
  now,
}: {
  active: LocalRecording;
  levels: AudioState['levels'];
  now: number;
}) {
  return (
    <div
      className="capture-levels"
      role="group"
      aria-label="Capture level previews"
    >
      {active.tracks.map((track) => {
        const name =
          track.spec.kind === 'microphone' ? 'Microphone' : 'System audio';
        const reading = levels?.capture.tracks.find(
          (value) => value.track_id === track.spec.track_id,
        )?.level;
        const age =
          reading && levels
            ? now -
              levels.received_at +
              levels.capture.clock_ms -
              reading.clock_ms
            : null;
        const recent =
          active.state === 'recording' &&
          reading &&
          age !== null &&
          age >= 0 &&
          age <= 1000;
        const peak = recent ? reading.peak : 0;
        const db = peak === 0 ? -60 : Math.max(-60, 20 * Math.log10(peak));
        const text =
          active.state === 'paused'
            ? 'Paused'
            : active.state !== 'recording'
              ? 'Not capturing'
              : !reading
                ? 'Waiting for audio'
                : !recent
                  ? 'No recent audio'
                  : peak === 0
                    ? 'Silence'
                    : `${Math.round(20 * Math.log10(peak))} dBFS peak`;
        const rms = !recent
          ? 'No recent RMS measurement'
          : reading.rms === 0
            ? 'RMS silence'
            : `${Math.round(20 * Math.log10(reading.rms))} dBFS RMS`;
        return (
          <div className="capture-level" key={track.spec.track_id}>
            <strong>{name}</strong>
            <span>{text}</span>
            <meter
              aria-label={`${name} level preview`}
              aria-valuetext={`${text}; ${rms}`}
              min={-60}
              max={0}
              value={db}
              title={
                peak >= 0.99
                  ? 'Near full scale; check the source volume.'
                  : `${text}; ${rms}`
              }
            />
            <small>
              {duration(track.saved_samples)} saved in sealed chunks
            </small>
          </div>
        );
      })}
    </div>
  );
}
function useAudioState(scope: number, document: string | null) {
  const [state, setState] = useState<AudioState | null>(null);
  const [error, setError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const alive = useRef(false);
  const generation = useRef(0);
  async function refresh() {
    const attempt = ++generation.current;
    try {
      const response = await window.notes.invoke({
        operation: 'getRecordingState',
        scope,
        document_id: document,
        offset,
      });
      if (!alive.current || attempt !== generation.current) return;
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      if (
        !('audio_state' in response) ||
        response.audio_state.scope !== scope ||
        response.audio_state.state.document_id !== document
      ) {
        setError('Audio status could not be loaded for this workspace.');
        return;
      }
      setState(response.audio_state.state);
      setError('');
    } catch {
      if (alive.current && attempt === generation.current)
        setError('The desktop connection failed while loading audio status.');
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    const off = window.notes.onChanged((change) => {
      if (
        change.scope === scope &&
        ['audio', 'data', 'revoked', 'status'].includes(change.kind)
      )
        void refresh();
    });
    return () => {
      alive.current = false;
      generation.current++;
      off();
    };
  }, [scope, document, offset]);
  async function act(command: DesktopCommand) {
    setBusy(true);
    setOperationError('');
    try {
      const response = await window.notes.invoke(command);
      if (!alive.current) return false;
      if (!response.ok) {
        setOperationError(response.error.message);
        return false;
      }
      await refresh();
      return true;
    } catch {
      if (alive.current)
        setOperationError(
          'The desktop connection failed. Inspect saved audio before assuming capture completed.',
        );
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return {
    state,
    error: operationError || error,
    busy: busy || !!state?.busy,
    acting: busy,
    act,
    offset,
    setOffset,
  };
}

export function RecordingBar({ scope }: { scope: number }) {
  const { state, error, busy, acting, act } = useAudioState(scope, null);
  const active = state?.active;
  const upload = state?.active_upload;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (active?.state !== 'recording') return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [active?.id, active?.state]);
  if (
    !active &&
    !upload &&
    !error &&
    !state?.error &&
    !state?.cleanup_error &&
    !state?.pending_deletions
  )
    return null;
  return (
    <section className="recording-bar" aria-label="Audio recording status">
      {active && (
        <>
          <span
            className={`recording-dot ${active.state === 'recording' ? 'is-live' : ''}`}
            aria-hidden="true"
          />
          <div>
            <strong>{labels[active.state]}</strong>
            <span>
              Encrypted capture stays on this device unless you explicitly
              upload saved audio.
            </span>
          </div>
          {['recording', 'paused'].includes(active.state) && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act({
                  operation: 'controlRecording',
                  scope,
                  id: active.document_id,
                  recording_id: active.id,
                  action: active.state === 'paused' ? 'resume' : 'pause',
                })
              }
            >
              {active.state === 'paused'
                ? 'Resume recording'
                : 'Pause recording'}
            </button>
          )}
          {upload && (
            <div className="recording-cleanup">
              <strong>
                {upload.state === 'deleting'
                  ? 'Deleting saved audio'
                  : 'Uploading saved audio'}
              </strong>
              <span>
                {upload.verified_chunks} / {upload.total_chunks || '?'} chunks
                verified
              </span>
              {upload.state === 'uploading' && (
                <button
                  className="secondary"
                  disabled={acting}
                  onClick={() =>
                    void act({
                      operation: 'pauseRecordingUpload',
                      scope,
                      id: upload.document_id,
                      recording_id: upload.recording_id,
                    })
                  }
                >
                  Pause upload
                </button>
              )}
            </div>
          )}
          <button
            className="danger-button"
            disabled={busy}
            onClick={() =>
              void act({
                operation: 'controlRecording',
                scope,
                id: active.document_id,
                recording_id: active.id,
                action: 'stop',
              })
            }
          >
            Stop recording
          </button>
          <CaptureMeters
            active={active}
            levels={state?.levels ?? null}
            now={now}
          />
        </>
      )}
      {(error || state?.error) && (
        <p role="alert">{error || state?.error?.message}</p>
      )}
      {!!state?.pending_deletions && (
        <div className="recording-cleanup">
          <span>
            {state.pending_deletions} audio deletion
            {state.pending_deletions === 1 ? '' : 's'} pending.
          </span>
          {state.cleanup_error && (
            <>
              <span role="alert">{state.cleanup_error.message}</span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act({ operation: 'retryRecordingCleanup', scope })
                }
              >
                Retry audio cleanup
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

type Device = Extract<
  AudioEvent,
  { event_type: 'devices' }
>['payload']['devices'][number];
function TranscriptionControls({
  scope,
  document,
  recording,
  status,
  available,
  busy,
  act,
  jobs,
}: {
  scope: number;
  document: string;
  recording: LocalRecording;
  status: RecordingUploadStatus;
  available: boolean;
  busy: boolean;
  act: (command: DesktopCommand) => Promise<boolean>;
  jobs: DesktopState['jobs'];
}) {
  const [consent, setConsent] = useState<string | null>(null);
  const [locale, setLocale] = useState<'en-US' | 'zh-CN'>('en-US');
  const [incomplete, setIncomplete] = useState(false);
  const latest = jobs.find(
    (job) =>
      job.kind === 'recording_transcription' &&
      job.recording_id === recording.id,
  );
  const pending =
    latest && ['queued', 'running', 'retry_wait'].includes(latest.state);
  return (
    <div className="audio-upload">
      {latest && (
        <p className="quiet-note" role="status">
          Transcription: {latest.state.replaceAll('_', ' ')}.
          {latest.progress &&
            ` ${latest.progress.completed_chunks} / ${latest.progress.total_chunks} chunks processed.`}{' '}
          Review results and job controls in AI activity.
        </p>
      )}
      <button
        className="secondary"
        disabled={busy || !available}
        onClick={() => {
          setIncomplete(false);
          setConsent(crypto.randomUUID());
        }}
      >
        {pending
          ? 'Reconcile transcription request'
          : latest
            ? 'Transcribe again'
            : 'Transcribe saved audio'}
      </button>
      {consent && (
        <div className="audio-configuration">
          <p>
            {pending
              ? 'Reconcile the previously confirmed Azure request with its original language and capture acceptance. Its saved request key is reused, not a new transcription run.'
              : 'Send this verified recording to Azure Speech? This is separate from audio upload consent and may incur provider charges. Server processing can continue after this app closes.'}
          </p>
          {!pending && (
            <label>
              Transcription language
              <select
                className="service-input"
                aria-label="Transcription language"
                value={locale}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'en-US' || value === 'zh-CN') setLocale(value);
                }}
              >
                <option value="en-US">English (United States)</option>
                <option value="zh-CN">Chinese (Mandarin, simplified)</option>
              </select>
            </label>
          )}
          {status.partial && !pending && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={incomplete}
                disabled={busy}
                onChange={(event) => setIncomplete(event.target.checked)}
              />
              I accept transcription of an incomplete recording with known gaps
              or lost audio.
            </label>
          )}
          <p className="quiet-note">
            Capture source labels are not speaker identities. Recognition may
            miss speech at chunk boundaries. If a transcript changes while
            processing, the result is saved separately for review.
          </p>
          <div className="inline-actions">
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => setConsent(null)}
            >
              Not now
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !available ||
                (!pending && status.partial && !incomplete)
              }
              onClick={() =>
                void act({
                  operation: 'finalizeRecordingTranscript',
                  scope,
                  id: document,
                  recording_id: recording.id,
                  locale,
                  accept_incomplete: incomplete,
                  confirmed: true,
                  new_attempt: !pending,
                  consent_id: consent,
                }).then((accepted) => {
                  if (accepted) setConsent(null);
                })
              }
            >
              {pending
                ? 'Confirm request reconciliation'
                : 'Confirm Azure transcription'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
const uploadLabels: Record<RecordingUploadStatus['state'], string> = {
  queued: 'Upload queued',
  uploading: 'Uploading',
  waiting: 'Waiting to retry',
  paused: 'Upload paused',
  attention: 'Upload needs attention',
  complete: 'Verified remote copy',
  delete_pending: 'Audio deletion queued',
  deleting: 'Deleting remote audio',
};
function UploadControls({
  scope,
  document,
  recording,
  status,
  available,
  destination,
  busy,
  acting,
  act,
}: {
  scope: number;
  document: string;
  recording: LocalRecording;
  status: RecordingUploadStatus | undefined;
  available: boolean;
  destination: string | null;
  busy: boolean;
  acting: boolean;
  act: (command: DesktopCommand) => Promise<boolean>;
}) {
  const [consent, setConsent] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const deleting =
    status?.state === 'delete_pending' || status?.state === 'deleting';
  return (
    <div className="audio-upload">
      {!available && (
        <p className="quiet-note">
          Uploads require the original signed-in cloud workspace. Device-only
          note copies do not include audio.
        </p>
      )}
      {status && (
        <div role="status">
          <strong>{uploadLabels[status.state]}</strong>
          {!deleting && (
            <>
              <progress
                aria-label="Verified audio upload"
                max={status.total_chunks || 1}
                value={status.verified_chunks}
              />
              <span>
                {status.verified_chunks} / {status.total_chunks || '?'} chunks
                verified. Encrypted local audio is kept.
              </span>
              {status.partial && (
                <span>Incomplete capture was explicitly accepted.</span>
              )}
            </>
          )}
          {deleting && (
            <span>
              Local audio is kept until the service confirms cleanup. Reconnect
              to the original workspace if offline.
            </span>
          )}
          {status.error && (
            <p className="account-alert" role="alert">
              {status.error.message}
            </p>
          )}
        </div>
      )}
      <div className="inline-actions">
        {status &&
          ['queued', 'uploading', 'waiting'].includes(status.state) && (
            <button
              className="secondary"
              disabled={acting}
              onClick={() =>
                void act({
                  operation: 'pauseRecordingUpload',
                  scope,
                  id: document,
                  recording_id: recording.id,
                })
              }
            >
              Pause upload
            </button>
          )}
        {!deleting &&
          status?.state !== 'complete' &&
          (!status ||
            ['paused', 'waiting', 'attention'].includes(status.state)) && (
            <button
              className="secondary"
              disabled={busy || !available}
              onClick={() => {
                setIncomplete(status?.partial ?? false);
                setConsent(true);
              }}
            >
              {status ? 'Resume or retry upload' : 'Upload saved audio'}
            </button>
          )}
        {deleting && status.state === 'delete_pending' && (
          <button
            className="secondary"
            disabled={busy || !available}
            onClick={() =>
              void act({
                operation: 'removeRecording',
                scope,
                id: document,
                recording_id: recording.id,
                confirmed: true,
              })
            }
          >
            Retry audio deletion
          </button>
        )}
      </div>
      {consent && !deleting && (
        <div className="audio-configuration">
          <p>
            Send saved audio to{' '}
            {destination ? new URL(destination).host : 'your workspace service'}
            ? The encrypted local copy stays on this device. This does not start
            Azure transcription.
          </p>
          {!status?.total_chunks ? (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={incomplete}
                onChange={(event) => setIncomplete(event.target.checked)}
              />
              I accept saved audio even if capture was interrupted or has
              missing audio.
            </label>
          ) : (
            status.partial && (
              <p>
                The frozen upload retains its originally accepted incomplete
                capture.
              </p>
            )
          )}
          <div className="inline-actions">
            <button
              className="quiet-button"
              disabled={acting}
              onClick={() => setConsent(false)}
            >
              Keep local only
            </button>
            <button
              className="primary"
              disabled={busy || !available}
              onClick={() =>
                void act({
                  operation: 'uploadRecording',
                  scope,
                  id: document,
                  recording_id: recording.id,
                  confirmed: true,
                  accept_incomplete: incomplete,
                }).then((accepted) => {
                  if (accepted) setConsent(false);
                })
              }
            >
              Confirm audio upload
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
export function RecordingPanel({
  scope,
  document,
  beforeStart,
  jobs,
}: {
  scope: number;
  document: string;
  beforeStart: () => Promise<boolean>;
  jobs: DesktopState['jobs'];
}) {
  const { state, error, busy, acting, act, offset, setOffset } = useAudioState(
    scope,
    document,
  );
  const [configure, setConfigure] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [checking, setChecking] = useState(false);
  const [deviceError, setDeviceError] = useState('');
  const [microphone, setMicrophone] = useState(true);
  const [loopback, setLoopback] = useState(false);
  const [microphoneId, setMicrophoneId] = useState('default');
  const [loopbackId, setLoopbackId] = useState('default');
  const [confirmation, setConfirmation] = useState<{
    id: string;
    action: 'delete' | 'recover';
  } | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function configureDevices() {
    const attempt = ++generation.current;
    setConfigure(true);
    setChecking(true);
    setDeviceError('');
    try {
      const response = await window.notes.invoke({
        operation: 'listAudioDevices',
        scope,
      });
      if (attempt !== generation.current) return;
      if (!response.ok) {
        setDeviceError(response.error.message);
        return;
      }
      if (
        !('audio_devices' in response) ||
        response.audio_devices.scope !== scope
      ) {
        setDeviceError('Audio devices could not be loaded for this workspace.');
        return;
      }
      const values = response.audio_devices.devices;
      setDevices(values);
      setMicrophone(values.some((device) => device.kind === 'microphone'));
      setLoopback(false);
      setMicrophoneId(
        values.some(
          (device) => device.kind === 'microphone' && device.is_default,
        )
          ? 'default'
          : (values.find((device) => device.kind === 'microphone')?.device_id ??
              ''),
      );
      setLoopbackId(
        values.some((device) => device.kind === 'loopback' && device.is_default)
          ? 'default'
          : (values.find((device) => device.kind === 'loopback')?.device_id ??
              ''),
      );
    } catch {
      if (attempt === generation.current)
        setDeviceError(
          'The desktop connection failed while checking audio devices.',
        );
    } finally {
      if (attempt === generation.current) setChecking(false);
    }
  }
  const choices: Track[] = [];
  for (const [kind, enabled, id] of [
    ['microphone', microphone, microphoneId],
    ['loopback', loopback, loopbackId],
  ] as const) {
    if (enabled && id)
      choices.push({
        track_id: crypto.randomUUID(),
        kind,
        capture_scope: 'endpoint',
        device_selection_policy: id === 'default' ? 'default' : 'explicit',
        device_id: id,
      });
  }
  return (
    <section className="meeting-audio" aria-label="Meeting audio">
      <div className="audio-heading">
        <div>
          <strong>Meeting audio</strong>
          <p className="quiet-note">
            Encrypted on this device. Saved audio uploads only with your
            consent. Transcription requires a separate Azure confirmation.
          </p>
        </div>
        <button
          className="secondary"
          disabled={!state || busy || !!state.active}
          onClick={() => void configureDevices()}
        >
          Record audio
        </button>
      </div>
      {(error || deviceError) && (
        <p className="account-alert" role="alert">
          {error || deviceError}
        </p>
      )}
      {configure && (
        <div className="audio-configuration">
          <p className="quiet-note">
            Choose the actual capture sources before starting. This preview
            stops after one hour.
          </p>
          {checking ? (
            <p role="status">Checking audio devices...</p>
          ) : (
            (['microphone', 'loopback'] as const).map((kind) => {
              const available = devices.filter(
                (device) => device.kind === kind,
              );
              const enabled = kind === 'microphone' ? microphone : loopback;
              return (
                <div key={kind} className="audio-source">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={!available.length || busy || !!state?.active}
                      onChange={(event) =>
                        kind === 'microphone'
                          ? setMicrophone(event.target.checked)
                          : setLoopback(event.target.checked)
                      }
                    />
                    {kind === 'microphone' ? 'Microphone' : 'System audio'}
                    {!available.length && ' - no active device'}
                  </label>
                  {available.length > 0 && (
                    <select
                      aria-label={
                        kind === 'microphone'
                          ? 'Recording microphone'
                          : 'Recording system output'
                      }
                      className="service-input"
                      disabled={!enabled || busy || !!state?.active}
                      value={kind === 'microphone' ? microphoneId : loopbackId}
                      onChange={(event) =>
                        kind === 'microphone'
                          ? setMicrophoneId(event.target.value)
                          : setLoopbackId(event.target.value)
                      }
                    >
                      {available.some((device) => device.is_default) && (
                        <option value="default">
                          Windows default -{' '}
                          {available.find((device) => device.is_default)?.name}
                        </option>
                      )}
                      {available.map((device) => (
                        <option key={device.device_id} value={device.device_id}>
                          {device.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })
          )}
          {loopback && (
            <p className="account-alert">
              Device-level system audio may include other apps on this output.
              It is not isolated to a meeting app.
            </p>
          )}
          <div className="inline-actions">
            <button
              className="primary"
              disabled={
                !state ||
                busy ||
                checking ||
                !!deviceError ||
                !choices.length ||
                !!state.active
              }
              onClick={() => {
                void beforeStart().then(async (saved) => {
                  if (
                    saved &&
                    (await act({
                      operation: 'startRecording',
                      scope,
                      id: document,
                      tracks: choices,
                    }))
                  )
                    setConfigure(false);
                });
              }}
            >
              Start recording
            </button>
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => {
                generation.current++;
                setChecking(false);
                setConfigure(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {!!state?.recordings.length && (
        <details className="recording-history">
          <summary>
            Saved audio ({state.recordings.length}
            {state.has_more || offset > 0 ? '+' : ''})
          </summary>
          {state.recordings.map((recording) => {
            const upload = state.uploads.find(
              (value) => value.recording_id === recording.id,
            );
            const deleting =
              upload?.state === 'delete_pending' ||
              upload?.state === 'deleting';
            return (
              <article key={recording.id}>
                <div>
                  <strong>{labels[recording.state]}</strong>
                  <span>{new Date(recording.created_at).toLocaleString()}</span>
                </div>
                <p>
                  Last acknowledged chunks:{' '}
                  {recording.tracks
                    .map(
                      (track) =>
                        `${track.spec.kind === 'microphone' ? 'Microphone' : 'System audio'} ${duration(track.saved_samples)}`,
                    )
                    .join(' / ')}
                  .
                </p>
                {recording.error && (
                  <p className="account-alert">{recording.error.message}</p>
                )}
                {recording.inspection && (
                  <p>
                    Integrity: {recording.inspection.state}.{' '}
                    {recording.inspection.verified_chunks} verified chunks;{' '}
                    {recording.inspection.recovered_chunks} orphan chunks found.
                    Verified audio:{' '}
                    {duration(recording.inspection.total_samples)} across all
                    tracks.
                  </p>
                )}
                <div className="inline-actions">
                  <button
                    className="secondary"
                    disabled={busy || !!state.active || deleting}
                    onClick={() =>
                      void act({
                        operation: 'inspectRecording',
                        scope,
                        id: document,
                        recording_id: recording.id,
                      })
                    }
                  >
                    Inspect saved audio
                  </button>
                  {!!recording.inspection?.recovered_chunks &&
                    recording.inspection.state !== 'key_unavailable' &&
                    recording.inspection.issues.every((issue) =>
                      ['unsealed_tail', 'uncommitted_file'].includes(
                        issue.code,
                      ),
                    ) && (
                      <button
                        className="secondary"
                        disabled={
                          busy ||
                          !!state.active ||
                          !!upload?.total_chunks ||
                          deleting
                        }
                        onClick={() =>
                          setConfirmation({
                            id: recording.id,
                            action: 'recover',
                          })
                        }
                      >
                        Recover saved chunks
                      </button>
                    )}
                  <button
                    className="quiet-button danger"
                    disabled={
                      acting ||
                      !!state.active ||
                      deleting ||
                      (busy &&
                        state.active_upload?.recording_id !== recording.id)
                    }
                    onClick={() =>
                      setConfirmation({ id: recording.id, action: 'delete' })
                    }
                  >
                    Delete audio only
                  </button>
                </div>
                {!['starting', 'recording', 'paused'].includes(
                  recording.state,
                ) && (
                  <UploadControls
                    scope={scope}
                    document={document}
                    recording={recording}
                    status={upload}
                    available={state.upload_available}
                    destination={state.upload_destination}
                    busy={busy}
                    acting={acting}
                    act={act}
                  />
                )}
                {upload?.state === 'complete' && (
                  <TranscriptionControls
                    scope={scope}
                    document={document}
                    recording={recording}
                    status={upload}
                    available={state.upload_available}
                    busy={acting}
                    act={act}
                    jobs={jobs}
                  />
                )}
                {confirmation?.id === recording.id &&
                  confirmation.action === 'recover' && (
                    <div className="delete-confirm">
                      <span>
                        Attach authenticated saved chunks? Capture will not
                        resume. The unsaved audio tail may be lost.
                      </span>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => setConfirmation(null)}
                      >
                        Cancel recovery
                      </button>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          void act({
                            operation: 'recoverRecording',
                            scope,
                            id: document,
                            recording_id: recording.id,
                            confirmed: true,
                          }).then((recovered) => {
                            if (recovered) setConfirmation(null);
                          })
                        }
                      >
                        Confirm recovery
                      </button>
                    </div>
                  )}
                {confirmation?.id === recording.id &&
                  confirmation.action === 'delete' && (
                    <div className="delete-confirm">
                      <span>
                        {upload
                          ? 'Delete local and remote audio and stop its unfinished transcription? Deletion is queued until cleanup is confirmed. Notes and published transcripts stay; processing drafts are erased. This cannot be undone.'
                          : "Delete this device's only audio copy? Notes and published transcripts stay. This cannot be undone."}
                      </span>
                      <button
                        className="secondary"
                        onClick={() => setConfirmation(null)}
                      >
                        Keep audio
                      </button>
                      <button
                        className="danger-button"
                        disabled={
                          acting ||
                          (busy &&
                            state.active_upload?.recording_id !== recording.id)
                        }
                        onClick={() =>
                          void act({
                            operation: 'removeRecording',
                            scope,
                            id: document,
                            recording_id: recording.id,
                            confirmed: true,
                          }).then((removed) => {
                            if (removed) setConfirmation(null);
                          })
                        }
                      >
                        Confirm audio deletion
                      </button>
                    </div>
                  )}
              </article>
            );
          })}
          {(offset > 0 || state.has_more) && (
            <div className="inline-actions">
              <button
                className="secondary"
                disabled={busy || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous recordings
              </button>
              <button
                className="secondary"
                disabled={busy || !state.has_more}
                onClick={() => setOffset(offset + 50)}
              >
                More recordings
              </button>
            </div>
          )}
        </details>
      )}
      <p className="quiet-note">
        Saved duration advances when encrypted chunks commit, up to 30 seconds
        behind capture. Keep recovery files with this Windows account.
      </p>
    </section>
  );
}
