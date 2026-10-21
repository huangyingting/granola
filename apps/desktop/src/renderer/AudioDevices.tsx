import { useEffect, useRef, useState } from 'react';
import type { AudioEvent } from '@windows-ai-notes/contracts';

type Device = Extract<
  AudioEvent,
  { event_type: 'devices' }
>['payload']['devices'][number];

export function AudioDevices({ scope }: { scope: number }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  async function refresh() {
    const attempt = ++generation.current;
    setBusy(true);
    setError('');
    setDevices(null);
    try {
      const response = await window.notes.invoke({
        operation: 'listAudioDevices',
        scope,
      });
      if (attempt !== generation.current) return;
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      if (
        !('audio_devices' in response) ||
        response.audio_devices.scope !== scope
      ) {
        setError(
          'Audio devices could not be loaded for the current workspace.',
        );
        return;
      }
      setDevices(response.audio_devices.devices);
    } catch {
      if (attempt === generation.current)
        setError('The desktop connection failed while checking audio devices.');
    } finally {
      if (attempt === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [scope]);
  return (
    <section className="privacy-page">
      <span className="eyebrow">WINDOWS AUDIO</span>
      <h1>Know what is listening.</h1>
      <p className="quiet-note">
        Checking devices does not start recording. Capture controls are still in
        development.
      </p>
      <button
        className="secondary"
        onClick={() => void refresh()}
        disabled={busy}
      >
        {busy ? 'Checking audio devices...' : 'Refresh audio devices'}
      </button>
      {busy && (
        <p className="quiet-note" role="status">
          Checking the bundled Windows audio helper...
        </p>
      )}
      {error && (
        <p className="account-alert" role="alert">
          {error}
        </p>
      )}
      {devices && (
        <div className="privacy-grid audio-device-grid">
          {(['microphone', 'loopback'] as const).map((kind) => {
            const available = devices.filter((device) => device.kind === kind);
            return (
              <article key={kind}>
                <span
                  className={`tile-icon ${kind === 'loopback' ? 'teal' : ''}`}
                >
                  {kind === 'microphone' ? '01' : '02'}
                </span>
                <h2>
                  {kind === 'microphone' ? 'Microphones' : 'System audio'}
                </h2>
                {available.length === 0 ? (
                  <p>
                    No active{' '}
                    {kind === 'microphone' ? 'microphone' : 'output device'}{' '}
                    found. Check Windows sound settings and refresh.
                  </p>
                ) : (
                  <ul className="audio-device-list">
                    {available.map((device) => (
                      <li key={device.device_id}>
                        <span>{device.name}</span>
                        {device.is_default && <small>Windows default</small>}
                      </li>
                    ))}
                  </ul>
                )}
                {kind === 'loopback' && (
                  <p className="quiet-note">
                    Device-level capture can include other apps on that output.
                    It is not isolated to a meeting app.
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
