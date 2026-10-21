import { useEffect, useState } from 'react';
import type { DesktopCommand } from '@windows-ai-notes/contracts/desktop';
import type {
  LivePreviewState,
  LocalRecording,
} from '@windows-ai-notes/contracts/recording';

const labels = {
  starting: 'Connecting live preview',
  live: 'Live cloud preview',
  finishing: 'Finishing preview segment',
  rotating: 'Starting a new preview segment',
  stopped: 'Live preview stopped',
  attention: 'Live preview needs attention',
};
export function LivePreview({
  scope,
  recording,
  live,
  available,
  destination,
  busy,
  act,
}: {
  scope: number;
  recording: LocalRecording;
  live: LivePreviewState | null;
  available: boolean;
  destination: string | null;
  busy: boolean;
  act: (command: DesktopCommand) => Promise<boolean>;
}) {
  const [configure, setConfigure] = useState(false);
  const [consent, setConsent] = useState(false);
  const [locale, setLocale] = useState<'en-US' | 'zh-CN'>('en-US');
  useEffect(() => {
    setConsent(false);
    setConfigure(false);
  }, [recording.id, recording.state, scope, available, destination]);
  const active = !!live?.running;
  const entries = live?.segments.slice(-6) ?? [];
  return (
    <section className="live-preview" aria-label="Live speech preview">
      <div className="audio-heading">
        <div>
          <strong>{live ? labels[live.phase] : 'Live preview'}</strong>
          <p className="quiet-note">
            Temporary captions, never your final transcript. Local recording is
            independent.
          </p>
        </div>
        {active ? (
          <button
            className="secondary"
            disabled={
              busy || live?.phase === 'stopped' || live?.phase === 'attention'
            }
            onClick={() =>
              void act({
                operation: 'stopLivePreview',
                scope,
                id: recording.document_id,
                recording_id: recording.id,
              })
            }
          >
            {live?.phase === 'stopped' || live?.phase === 'attention'
              ? 'Finishing cleanup...'
              : 'Stop live preview'}
          </button>
        ) : (
          <button
            className="secondary"
            disabled={busy || !available || recording.state !== 'recording'}
            onClick={() => {
              setConsent(false);
              setConfigure(true);
            }}
          >
            {live ? 'Start a new live preview' : 'Preview speech live'}
          </button>
        )}
      </div>
      {!available && (
        <p className="quiet-note">
          Live preview requires the original signed-in cloud workspace.
        </p>
      )}
      {configure && !active && (
        <div className="audio-configuration">
          <p>
            Send the selected recording sources to Azure Speech through{' '}
            {destination ?? 'your service'}? This does not upload saved audio or
            authorize final transcription.
          </p>
          <label>
            Live preview language
            <select
              className="service-input"
              aria-label="Live preview language"
              value={locale}
              disabled={busy}
              onChange={(event) => {
                if (
                  event.target.value === 'en-US' ||
                  event.target.value === 'zh-CN'
                )
                  setLocale(event.target.value);
              }}
            >
              <option value="en-US">English (United States)</option>
              <option value="zh-CN">Chinese (Mandarin, simplified)</option>
            </select>
          </label>
          <p className="quiet-note">
            Provider charges and account allowances apply, including uncertain
            failed attempts. Bounded preview can stop during long phrases or
            silence. Pausing capture stops preview; resuming needs confirmation
            again.
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(event) => setConsent(event.target.checked)}
            />
            I consent to sending live microphone and/or system audio to Azure
            Speech.
          </label>
          <div className="inline-actions">
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => setConfigure(false)}
            >
              Not now
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !consent ||
                !available ||
                recording.state !== 'recording'
              }
              onClick={() =>
                void act({
                  operation: 'startLivePreview',
                  scope,
                  id: recording.document_id,
                  recording_id: recording.id,
                  locale,
                  confirmed: true,
                }).then((accepted) => {
                  if (accepted) {
                    setConfigure(false);
                    setConsent(false);
                  }
                })
              }
            >
              Confirm live preview
            </button>
          </div>
        </div>
      )}
      {live && (
        <>
          <p className="quiet-note" role="status">
            Preview segment {live.attempt} - Continuity unverified.
            {live.usage_status === 'check_account' &&
              ' Usage may remain reserved; check AI allowance before retrying.'}
          </p>
          <div
            className="live-captions"
            aria-label="Provisional live captions"
            aria-live="off"
          >
            {entries.map(({ attempt, event }) => {
              const kind = recording.tracks.find(
                (track) => track.spec.track_id === event.source.track_id,
              )?.spec.kind;
              return (
                <div
                  className={`live-caption ${event.event_type === 'transcript.partial' ? 'is-provisional' : ''}`}
                  key={`${event.provider_epoch}:${event.segment_id}`}
                >
                  <small>
                    {kind === 'microphone' ? 'Microphone' : 'System audio'} -
                    Preview segment {attempt}
                  </small>
                  <p>{event.text}</p>
                </div>
              );
            })}
            {!entries.length && active && (
              <p className="quiet-note">Waiting for provisional speech...</p>
            )}
          </div>
          {!!live.gaps.length && (
            <p className="quiet-note">
              {Math.round(
                live.gaps.reduce(
                  (total, gap) => total + gap.sample_end - gap.sample_start,
                  0,
                ) / 16,
              ) / 1000}
              s of known preview gaps. Saved recording is not deleted or
              trimmed.
            </p>
          )}
          <details className="live-boundaries">
            <summary>Preview boundaries and skipped audio</summary>
            {live.boundaries.map((boundary) => (
              <p className="quiet-note" key={boundary.attempt}>
                Segment {boundary.attempt}:{' '}
                {boundary.reason === 'uncertain_previous_tail'
                  ? 'new attempt after a stopped or uncertain tail'
                  : boundary.reason === 'normal_rotation'
                    ? 'new bounded provider attempt'
                    : 'preview began'}
                . Continuity and recognition completeness are unverified.
              </p>
            ))}
            {live.gaps.map((gap, index) => (
              <p className="quiet-note" key={index}>
                Segment {gap.attempt}: {(gap.sample_start / 16000).toFixed(2)}-
                {(gap.sample_end / 16000).toFixed(2)}s of source audio skipped (
                {gap.reason}).
              </p>
            ))}
          </details>
          {live.omitted && (
            <p className="quiet-note">
              Earlier preview details were removed to keep this view bounded.
            </p>
          )}
          {live.error && (
            <p className="account-alert" role="alert">
              {live.error.message}
            </p>
          )}
          <p className="quiet-note">
            Preview text is not saved. Process the preserved recording for a
            final transcript.
          </p>
        </>
      )}
    </section>
  );
}
