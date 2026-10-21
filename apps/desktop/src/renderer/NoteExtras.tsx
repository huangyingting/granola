import { useState } from 'react';
import { richTextToPlainText } from '@windows-ai-notes/contracts/content';
import type {
  DesktopState,
  Draft,
  EditableDraft,
} from '@windows-ai-notes/contracts/desktop';

function Version({ label, value }: { label: string; value: EditableDraft }) {
  const [expanded, setExpanded] = useState(false);
  const text = richTextToPlainText(value.content);
  return (
    <article className="version-card">
      <span className="eyebrow">{label}</span>
      <h3>{value.title || 'Untitled meeting'}</h3>
      <p className="version-text">{expanded ? text : text.slice(0, 800)}</p>
      {value.tags.length > 0 && (
        <p className="quiet-note">{value.tags.join(' / ')}</p>
      )}
      {text.length > 800 && (
        <button className="quiet-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Read full version'}
        </button>
      )}
    </article>
  );
}
export function NoteExtras({
  state,
  draft,
  resolve,
}: {
  state: DesktopState;
  draft: Draft;
  resolve: (choice: 'local' | 'remote' | 'copy') => Promise<void>;
}) {
  const [choice, setChoice] = useState<'local' | 'remote' | null>(null);
  const [resolving, setResolving] = useState(false);
  async function decide(value: 'local' | 'remote' | 'copy') {
    setResolving(true);
    try {
      await resolve(value);
      setChoice(null);
    } finally {
      setResolving(false);
    }
  }
  const conflict = state.conflict;
  return (
    <>
      {conflict && (
        <section className="conflict-panel" aria-label="Version conflict">
          <span className="eyebrow">YOUR CHANGES ARE SAFE</span>
          <h2>
            {conflict.deleted_remote
              ? 'This meeting was deleted in the cloud.'
              : 'Two versions. Your decision.'}
          </h2>
          <p>
            {conflict.deleted_remote
              ? 'Keep the unsent text as a new meeting, or discard this local recovery. The deleted ID will not be recreated.'
              : 'Another device changed this meeting. Nothing will overwrite the cloud until you choose.'}
          </p>
          <div className="version-grid">
            <Version label="YOUR DEVICE" value={draft} />
            {conflict.remote && (
              <Version
                label={`CLOUD / REVISION ${conflict.remote_revision}`}
                value={conflict.remote}
              />
            )}
          </div>
          <div className="inline-actions">
            <button
              className="primary"
              disabled={resolving}
              onClick={() => void decide('copy')}
            >
              {conflict.deleted_remote
                ? 'Keep as new meeting'
                : 'Keep both as separate meetings'}
            </button>
            {!conflict.deleted_remote && (
              <button
                className="secondary"
                disabled={resolving}
                onClick={() => setChoice('local')}
              >
                Keep my version
              </button>
            )}
            <button
              className="quiet-button"
              disabled={resolving}
              onClick={() => setChoice('remote')}
            >
              {conflict.deleted_remote
                ? 'Discard local recovery'
                : 'Use cloud version'}
            </button>
          </div>
          {choice && (
            <div className="inline-actions conflict-confirm">
              <span>
                {choice === 'local'
                  ? 'Replace the cloud version with your saved edits?'
                  : 'Discard your local version?'}
              </span>
              <button
                className="secondary"
                disabled={resolving}
                onClick={() => setChoice(null)}
              >
                Go back
              </button>
              <button
                className="danger-button"
                disabled={resolving}
                onClick={() => void decide(choice)}
              >
                {choice === 'local'
                  ? 'Replace cloud version'
                  : 'Discard my version'}
              </button>
            </div>
          )}
        </section>
      )}
      {(state.transcript_revision > 0 || state.jobs.length > 0) && (
        <section className="meeting-artifacts">
          {state.transcript_revision > 0 && (
            <details>
              <summary>
                Transcript <span>Revision {state.transcript_revision}</span>
              </summary>
              {state.transcript ? (
                state.transcript.segments.map((segment) => (
                  <p className="transcript-segment" key={segment.id}>
                    <span>
                      {Math.floor(segment.start_ms / 60_000)}:
                      {String(
                        Math.floor(segment.start_ms / 1000) % 60,
                      ).padStart(2, '0')}
                    </span>
                    {segment.text}
                  </p>
                ))
              ) : (
                <p className="quiet-note">
                  This transcript has not been cached yet. Reconnect to download
                  it.
                </p>
              )}
            </details>
          )}
          {state.jobs.length > 0 && (
            <details>
              <summary>
                AI activity <span>Latest {state.jobs.length} jobs</span>
              </summary>
              {state.jobs.map((job) => (
                <article className="job-card" key={job.id}>
                  <div>
                    <strong>
                      {job.kind === 'summary'
                        ? 'Meeting summary'
                        : 'Transcription'}
                    </strong>
                    <span>{job.state.replaceAll('_', ' ')}</span>
                  </div>
                  {job.input_stale && (
                    <p className="quiet-note">
                      The meeting changed after this job started. Its result has
                      not replaced your notes.
                    </p>
                  )}
                  {job.error && (
                    <p className="account-alert">{job.error.message}</p>
                  )}
                  {job.result?.kind === 'summary' && (
                    <p>{job.result.summary.overview.text}</p>
                  )}
                </article>
              ))}
              <p className="quiet-note">
                Cached activity is read-only. A summary never silently replaces
                your notes.
              </p>
            </details>
          )}
        </section>
      )}
    </>
  );
}
