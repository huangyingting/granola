import { useEffect, useRef, useState } from 'react';
import type { AudioEvent, Track } from '@windows-ai-notes/contracts';
import type { DesktopCommand } from '@windows-ai-notes/contracts/desktop';
import type { AudioState } from '@windows-ai-notes/contracts/recording';

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
        ['audio', 'data', 'revoked'].includes(change.kind)
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
    act,
    offset,
    setOffset,
  };
}

export function RecordingBar({ scope }: { scope: number }) {
  const { state, error, busy, act } = useAudioState(scope, null);
  const active = state?.active;
  if (
    !active &&
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
              Encrypted audio stays on this device. Cloud transcription is not
              connected.
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
export function RecordingPanel({
  scope,
  document,
  beforeStart,
}: {
  scope: number;
  document: string;
  beforeStart: () => Promise<boolean>;
}) {
  const { state, error, busy, act, offset, setOffset } = useAudioState(
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
            Optional, encrypted and local. Nothing is sent to Azure or uploaded
            yet.
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
          {state.recordings.map((recording) => (
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
                  Verified audio: {duration(recording.inspection.total_samples)}{' '}
                  across all tracks.
                </p>
              )}
              <div className="inline-actions">
                <button
                  className="secondary"
                  disabled={busy || !!state.active}
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
                    ['unsealed_tail', 'uncommitted_file'].includes(issue.code),
                  ) && (
                    <button
                      className="secondary"
                      disabled={busy || !!state.active}
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
                  disabled={busy || !!state.active}
                  onClick={() =>
                    setConfirmation({ id: recording.id, action: 'delete' })
                  }
                >
                  Delete audio only
                </button>
              </div>
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
                      Delete this device's only audio copy? Notes stay. This
                      cannot be undone.
                    </span>
                    <button
                      className="secondary"
                      onClick={() => setConfirmation(null)}
                    >
                      Keep audio
                    </button>
                    <button
                      className="danger-button"
                      disabled={busy}
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
          ))}
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
