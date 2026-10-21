import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { richTextToPlainText } from '@windows-ai-notes/contracts/content';
import {
  makeTranscriptPage,
  type TranscriptPage,
  transcriptTimelinePageSchema,
} from '@windows-ai-notes/contracts/server';
import type {
  DesktopState,
  Draft,
  EditableDraft,
} from '@windows-ai-notes/contracts/desktop';

function time(milliseconds: number) {
  return `${Math.floor(milliseconds / 60_000)}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}`;
}
function CaptureTimeline({
  scope,
  id,
  revision,
  total,
}: {
  scope: number;
  id: string;
  revision: number;
  total: number;
}) {
  const [page, setPage] = useState<z.infer<
    typeof transcriptTimelinePageSchema
  > | null>(null);
  const [previous, setPrevious] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(offset: number, back = false) {
    setBusy(true);
    setError('');
    try {
      const response = await window.notes.invoke({
        operation: 'getTranscriptTimeline',
        scope,
        id,
        revision,
        offset,
      });
      if (!response.ok) throw new Error(response.error.message);
      if (
        !('transcript_timeline' in response) ||
        response.transcript_timeline.scope !== scope
      )
        throw new Error('The capture evidence did not match this workspace.');
      setPrevious((positions) =>
        back ? positions.slice(0, -1) : page ? [...positions, page.offset] : [],
      );
      setPage(response.transcript_timeline.page);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Capture evidence could not be loaded.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open && !page && !busy) void load(0);
      }}
    >
      <summary>
        Capture evidence <span>{total} events and gaps</span>
      </summary>
      {page?.entries.map((entry, index) => (
        <p className="quiet-note" key={page.offset + index}>
          {entry.kind === 'gap'
            ? `${time(entry.value.start_ms)}-${time(entry.value.end_ms)}: ${entry.value.reason.replaceAll('_', ' ')}`
            : `${time(entry.value.clock_ms)}: ${entry.value.event_type.replaceAll('.', ' ')}`}
        </p>
      ))}
      {busy && <p role="status">Loading capture evidence...</p>}
      {error && (
        <p role="alert" className="account-alert">
          {error}
        </p>
      )}
      <div className="inline-actions">
        {previous.length > 0 && (
          <button
            className="quiet-button"
            disabled={busy}
            onClick={() => void load(previous[previous.length - 1]!, true)}
          >
            Previous evidence page
          </button>
        )}
        {page?.has_more && (
          <button
            className="quiet-button"
            disabled={busy}
            onClick={() => void load(page.offset + page.entries.length)}
          >
            Next evidence page
          </button>
        )}
        {error && (
          <button
            className="quiet-button"
            disabled={busy}
            onClick={() => void load(page?.offset ?? 0)}
          >
            Retry capture evidence
          </button>
        )}
      </div>
      <p className="quiet-note">
        Only recorded events and known gaps are shown. This is not proof that
        every spoken word was captured.
      </p>
    </details>
  );
}
function Transcript({
  state,
  id,
  revision = state.transcript_revision,
  candidate = false,
}: {
  state: DesktopState;
  id: string;
  revision?: number;
  candidate?: boolean;
}) {
  function initial(): TranscriptPage | null {
    if (revision !== state.transcript_revision) return null;
    const value = state.transcript;
    if (!value) return null;
    if ('offset' in value) return value;
    return makeTranscriptPage(
      {
        document_id: value.document_id,
        revision: value.revision,
        source: value.source,
        total_segments: value.segments.length,
      },
      0,
      value.segments,
    );
  }
  const [page, setPage] = useState(initial);
  const [previous, setPrevious] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyBase, setApplyBase] = useState<number | null>(null);
  useEffect(() => {
    setPage((current) => current ?? initial());
  }, [state.transcript]);
  async function load(
    offset: number,
    direction: 'next' | 'previous' | 'first',
  ) {
    setLoading(true);
    setError(null);
    try {
      const response = await window.notes.invoke({
        operation: 'getTranscriptPage',
        scope: state.scope,
        id,
        revision,
        offset,
      });
      if (!response.ok) throw new Error(response.error.message);
      if (
        !('transcript_page' in response) ||
        response.transcript_page.scope !== state.scope
      )
        throw new Error(
          'The transcript response did not match this workspace.',
        );
      setPrevious((positions) =>
        direction === 'previous'
          ? positions.slice(0, -1)
          : direction === 'next' && page
            ? [...positions, page.offset]
            : [],
      );
      setPage(response.transcript_page.page);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The transcript page could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }
  async function apply() {
    if (applyBase === null) return;
    setLoading(true);
    setError(null);
    try {
      const response = await window.notes.invoke({
        operation: 'applyTranscript',
        scope: state.scope,
        id,
        source_revision: revision,
        base_revision: applyBase,
        confirmed: true,
      });
      if (!response.ok) throw new Error(response.error.message);
      setApplyBase(null);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The transcript could not be applied.',
      );
    } finally {
      setLoading(false);
    }
  }
  const alreadyApplied =
    state.transcript &&
    'based_on_revision' in state.transcript &&
    state.transcript.based_on_revision === revision;
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open && !page && !loading)
          void load(0, 'first');
      }}
    >
      <summary>
        {candidate ? 'Generated transcript' : 'Transcript'}{' '}
        <span>Revision {revision}</span>
      </summary>
      {page ? (
        <>
          {page.recording && (
            <p className="quiet-note">
              {page.recording.tracks
                .map((track) =>
                  track.kind === 'microphone' ? 'Microphone' : 'System audio',
                )
                .join(' + ')}
              . Sources are not speaker identities.
              {page.recording.partial &&
                ' Incomplete recording: missing audio was explicitly accepted.'}
            </p>
          )}
          <p className="quiet-note" role="status">
            {page.total_segments === 0
              ? 'This transcript revision has no segments.'
              : `Segments ${page.offset + 1}-${page.offset + page.segments.length} of ${page.total_segments}`}
          </p>
          {page.segments.map((segment) => (
            <p className="transcript-segment" key={segment.id}>
              <span>
                {time(segment.start_ms)}
                {segment.origin &&
                  ` / ${segment.origin.kind === 'microphone' ? 'Microphone' : 'System audio'}`}
                {segment.origin?.time_basis === 'unmapped_clock' &&
                  ' / unmapped capture clock'}
              </span>
              {segment.text}
            </p>
          ))}
          <div className="inline-actions">
            {previous.length > 0 && (
              <button
                className="quiet-button"
                disabled={loading}
                onClick={() =>
                  void load(previous[previous.length - 1]!, 'previous')
                }
              >
                Previous transcript page
              </button>
            )}
            {page.has_more && (
              <button
                className="quiet-button"
                disabled={loading}
                onClick={() =>
                  void load(page.offset + page.segments.length, 'next')
                }
              >
                Next transcript page
              </button>
            )}
          </div>
          {!!page.recording?.timeline_count && (
            <CaptureTimeline
              scope={state.scope}
              id={id}
              revision={revision}
              total={page.recording.timeline_count}
            />
          )}
          {candidate && page.is_candidate && !alreadyApplied && (
            <div className="audio-configuration">
              {applyBase === null ? (
                <button
                  className="secondary"
                  disabled={loading || !state.connection.user_id}
                  onClick={() => setApplyBase(state.transcript_revision)}
                >
                  Apply generated transcript
                </button>
              ) : (
                <>
                  <p>
                    Replace canonical transcript revision {applyBase} with this
                    generated version? Earlier revisions stay in history.
                    Meeting notes are not replaced.
                  </p>
                  <div className="inline-actions">
                    <button
                      className="quiet-button"
                      disabled={loading}
                      onClick={() => setApplyBase(null)}
                    >
                      Keep current transcript
                    </button>
                    <button
                      className="primary"
                      disabled={loading}
                      onClick={() => void apply()}
                    >
                      Confirm transcript replacement
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {candidate && alreadyApplied && (
            <p className="quiet-note">
              This generated version is already applied.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="quiet-note">
            This transcript has not been cached yet. Reconnect to download it.
          </p>
          <button
            className="quiet-button"
            disabled={loading}
            onClick={() => void load(0, 'first')}
          >
            Download transcript page
          </button>
        </>
      )}
      {loading && (
        <p className="quiet-note" role="status">
          Loading transcript page...
        </p>
      )}
      {error && (
        <p className="account-alert" role="alert">
          {error}
        </p>
      )}
      <p className="quiet-note">
        Opened pages are cached on this device for offline reading. Pages you
        have not opened require a connection.
      </p>
    </details>
  );
}
function RecordingJobActions({
  state,
  id,
  job,
}: {
  state: DesktopState;
  id: string;
  job: DesktopState['jobs'][number];
}) {
  const [choice, setChoice] = useState<'cancel' | 'retry' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = ['queued', 'running', 'retry_wait'].includes(job.state);
  async function act() {
    if (!choice) return;
    setBusy(true);
    setError('');
    try {
      const response = await window.notes.invoke({
        operation: 'controlTranscriptionJob',
        scope: state.scope,
        id,
        job_id: job.id,
        action: choice,
        confirmed: true,
      });
      if (!response.ok) throw new Error(response.error.message);
      setChoice(null);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The transcription job could not be changed.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {job.progress && (
        <>
          <progress
            aria-label="Recording transcription progress"
            value={job.progress.completed_chunks}
            max={job.progress.total_chunks}
          />
          <p className="quiet-note">
            {job.progress.completed_chunks} / {job.progress.total_chunks} chunks
            durably processed.
            {job.progress.uncertain_requests > 0 &&
              ` ${job.progress.uncertain_requests} earlier requests have uncertain provider billing.`}
          </p>
        </>
      )}
      <div className="inline-actions">
        {(active || job.state === 'failed') && (
          <button
            className="secondary"
            disabled={busy || !state.connection.user_id}
            onClick={() => setChoice(active ? 'cancel' : 'retry')}
          >
            {active ? 'Cancel transcription' : 'Resume saved processing'}
          </button>
        )}
      </div>
      {choice && (
        <div className="audio-configuration">
          <p>
            {choice === 'cancel'
              ? 'Stop future requests and erase unpublished processing drafts? Requests already sent may still be billed. Saved audio and published transcripts remain.'
              : 'Resume completed chunks with the original speech configuration? Interrupted requests without saved results may be sent and charged again. Expired drafts require a separately confirmed new transcription.'}
          </p>
          <div className="inline-actions">
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => setChoice(null)}
            >
              Go back
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void act()}
            >
              {choice === 'cancel'
                ? 'Confirm transcription cancellation'
                : 'Confirm processing resume'}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="account-alert">
          {error}
        </p>
      )}
    </>
  );
}

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
            <Transcript
              key={`${state.scope}:${draft.id}:${state.transcript_revision}`}
              state={state}
              id={draft.id}
            />
          )}
          {state.jobs.length > 0 && (
            <details>
              <summary>
                AI activity <span>Latest {state.jobs.length} jobs</span>
              </summary>
              {state.jobs.map((job) => (
                <article className="job-card" key={job.id}>
                  <div className="job-heading">
                    <strong>
                      {job.kind === 'summary'
                        ? 'Meeting summary'
                        : job.kind === 'recording_transcription'
                          ? 'Recording transcription'
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
                  {job.kind === 'recording_transcription' && (
                    <RecordingJobActions
                      state={state}
                      id={draft.id}
                      job={job}
                    />
                  )}
                  {job.result?.kind === 'recording_transcription' && (
                    <>
                      <p className="quiet-note">
                        {job.result.applied
                          ? 'Published transcript'
                          : 'Saved separately: review before replacing your transcript'}
                        .{' '}
                        {job.result.partial &&
                          'The source recording is incomplete.'}
                      </p>
                      {!job.result.applied && (
                        <Transcript
                          state={state}
                          id={draft.id}
                          revision={job.result.transcript_revision}
                          candidate
                        />
                      )}
                    </>
                  )}
                </article>
              ))}
              <p className="quiet-note">
                Showing last synced activity. Connect for server job controls. A
                summary never silently replaces your notes.
              </p>
            </details>
          )}
        </section>
      )}
    </>
  );
}
