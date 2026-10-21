import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type {
  DesktopCommand,
  DesktopState,
  Draft,
} from '@windows-ai-notes/contracts/desktop';
import type { Summary } from '@windows-ai-notes/contracts/server';
import type { SummaryProgress } from '@windows-ai-notes/contracts/evidence';
import {
  DEFAULT_SUMMARY_TEMPLATE,
  SUMMARY_TEMPLATES,
  summaryTemplateIdSchema,
  type SummaryTemplateCatalog,
  type SummaryTemplateId,
} from '@windows-ai-notes/contracts/templates';
import {
  summaryCitations,
  summaryReviewSchema,
  type SummaryReview,
  type SummarySource,
} from '@windows-ai-notes/contracts/generation';

type Flush = MutableRefObject<() => Promise<boolean>>;
type Props = {
  state: DesktopState;
  draft: Draft;
  beforeStart: () => Promise<boolean>;
  reviewFlush: Flush;
  invoke: (command: DesktopCommand) => Promise<DesktopState | null>;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The summary operation failed.';
const pending = (state: string) =>
  ['queued', 'running', 'retry_wait'].includes(state);

export function SummaryPanel(props: Props) {
  const { state, draft, beforeStart, reviewFlush, invoke } = props;
  const jobs = state.jobs.filter((job) => job.kind === 'summary');
  const [selected, setSelected] = useState<string | null>(jobs[0]?.id ?? null);
  const viewedJob = useRef<DesktopState['jobs'][number] | undefined>(jobs[0]);
  const job =
    jobs.find((item) => item.id === selected) ??
    (viewedJob.current?.id === selected ? viewedJob.current : jobs[0]);
  viewedJob.current = job;
  const choices =
    job && !jobs.some((item) => item.id === job.id) ? [job, ...jobs] : jobs;
  useEffect(() => {
    if (!selected && job) setSelected(job.id);
  }, [job?.id, selected]);
  const [confirmation, setConfirmation] = useState<'new' | 'recover' | null>(
    null,
  );
  const [language, setLanguage] = useState<'en' | 'zh'>('en');
  const [template, setTemplate] = useState<SummaryTemplateId>(
    DEFAULT_SUMMARY_TEMPLATE,
  );
  const [templates, setTemplates] = useState<
    SummaryTemplateCatalog['templates'] | null
  >(null);
  const [consent, setConsent] = useState(false);
  const [resume, setResume] = useState<SummaryProgress | null>(null);
  const [resumeConsent, setResumeConsent] = useState(false);
  const consentId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState<SummarySource | null>(null);
  const [editing, setEditing] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const view = useRef(0);
  useEffect(
    () => () => {
      view.current++;
    },
    [],
  );
  useEffect(() => {
    let alive = true,
      checking = false,
      requested = false;
    function clear() {
      view.current++;
      viewedJob.current = undefined;
      reviewFlush.current = async () => true;
      setSource(null);
      setEditing(false);
      setConfirmation(null);
      setResume(null);
      setResumeConsent(false);
      setUnavailable(true);
    }
    const stop = window.notes.onChanged((change) => {
      if (change.scope !== state.scope || change.kind === 'revoked') {
        clear();
        return;
      }
      if (change.kind !== 'data') return;
      requested = true;
      if (checking) return;
      checking = true;
      void (async () => {
        while (alive && requested) {
          requested = false;
          const response = await window.notes.invoke({
            operation: 'bootstrap',
          });
          if (!alive) return;
          if (!response.ok) throw new Error(response.error.message);
          if (!('state' in response))
            throw new Error('The workspace state could not be checked.');
          if (
            response.state.scope !== state.scope ||
            response.state.selected_id !== draft.id ||
            response.state.selected?.status === 'deleted_remote'
          ) {
            clear();
            return;
          }
        }
      })()
        .catch((error) => {
          if (alive) setError(message(error));
        })
        .finally(() => {
          checking = false;
        });
    });
    return () => {
      alive = false;
      stop();
    };
  }, [state.scope, draft.id]);
  const connected =
    state.connection.active_workspace !== null &&
    !['offline', 'connecting', 'disconnecting', 'reauth_required'].includes(
      state.connection.status,
    );
  const submission = state.summary_submission;
  useEffect(() => {
    if (submission?.rejected) {
      setConfirmation(null);
      setConsent(false);
    }
  }, [submission?.rejected, submission?.consent_id]);
  const unresolved =
    submission &&
    !submission.rejected &&
    (!submission.job_id || !jobs.some((item) => item.id === submission.job_id));
  const running = jobs.some((item) => pending(item.state));
  const summary = job?.result?.kind === 'summary' ? job.result.summary : null;
  const templateVersion =
    job?.result?.kind === 'summary' ? job.result.prompt_version : null;
  const citations = summary ? summaryCitations(summary) : [];

  async function action(run: () => Promise<void>) {
    if (busy) return;
    const version = view.current;
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (error) {
      if (version === view.current) setError(message(error));
    } finally {
      if (version === view.current) setBusy(false);
    }
  }
  async function choose(id: string) {
    if (!(await reviewFlush.current())) return;
    view.current++;
    setSelected(id);
    setSource(null);
    setEditing(false);
    setResume(null);
    setResumeConsent(false);
    setError('');
    setBusy(false);
  }
  function prepare(kind: 'new' | 'recover') {
    setResume(null);
    setResumeConsent(false);
    setConfirmation(kind);
    setConsent(false);
    consentId.current = crypto.randomUUID();
    setLanguage(kind === 'recover' ? submission!.language : language);
    setTemplates(null);
    if (kind === 'recover') {
      setTemplate(submission!.template_id ?? DEFAULT_SUMMARY_TEMPLATE);
      return;
    }
    const version = view.current;
    void action(async () => {
      const response = await window.notes.invoke({
        operation: 'getSummaryTemplates',
        scope: state.scope,
        id: draft.id,
      });
      if (version !== view.current) return;
      if (!response.ok) throw new Error(response.error.message);
      if (
        !('summary_templates' in response) ||
        response.summary_templates.scope !== state.scope ||
        response.summary_templates.document_id !== draft.id
      )
        throw new Error(
          'The template catalog belongs to another meeting view.',
        );
      const supported = response.summary_templates.catalog.templates.filter(
        (item) => summaryTemplateIdSchema.safeParse(item.id).success,
      );
      if (!supported.length)
        throw new Error(
          "This app does not support the service's summary template versions. Update the app before generating.",
        );
      const selected =
        supported.find((item) => item.id === template) ?? supported[0]!;
      setTemplate(summaryTemplateIdSchema.parse(selected.id));
      setTemplates(supported);
    });
  }
  async function prepareResume() {
    if (!job) return;
    const version = view.current;
    const response = await window.notes.invoke({
      operation: 'getSummaryProgress',
      scope: state.scope,
      id: draft.id,
      job_id: job.id,
    });
    if (version !== view.current) return;
    if (!response.ok) throw new Error(response.error.message);
    if (
      !('summary_progress' in response) ||
      response.summary_progress.scope !== state.scope ||
      response.summary_progress.progress.document_id !== draft.id ||
      response.summary_progress.progress.job_id !== job.id
    )
      throw new Error('The service returned progress for another summary.');
    const progress = response.summary_progress.progress;
    if (!progress.resume_available)
      throw new Error(
        'Saved work cannot be resumed for this job. Refresh its status or confirm a new summary request.',
      );
    setConfirmation(null);
    setResume(progress);
    setResumeConsent(false);
  }
  async function start() {
    if (!consent || !(await beforeStart()) || !(await reviewFlush.current()))
      return;
    const result = await invoke({
      operation: 'startSummary',
      scope: state.scope,
      id: draft.id,
      language,
      ...(template === DEFAULT_SUMMARY_TEMPLATE
        ? {}
        : { template_id: template }),
      confirmed: true,
      new_attempt: confirmation === 'new',
      consent_id:
        confirmation === 'recover' ? submission!.consent_id : consentId.current,
    });
    if (!result)
      throw new Error(
        'The request receipt was not confirmed. Recover the saved request before starting another.',
      );
    if (result.scope !== state.scope || result.selected_id !== draft.id) return;
    setConfirmation(null);
    setConsent(false);
    setEditing(false);
    setSource(null);
    setSelected(result.summary_submission?.job_id ?? null);
  }
  async function inspect(citation: (typeof citations)[number]) {
    const version = view.current;
    const jobId = job!.id;
    const response = await window.notes.invoke({
      operation: 'getSummarySource',
      scope: state.scope,
      id: draft.id,
      job_id: job!.id,
      citation,
    });
    if (version !== view.current || viewedJob.current?.id !== jobId) return;
    if (!response.ok) throw new Error(response.error.message);
    if (
      !('summary_source' in response) ||
      response.summary_source.scope !== state.scope ||
      response.summary_source.source.document_id !== draft.id ||
      response.summary_source.source.job_id !== jobId
    )
      throw new Error('The summary source belongs to another view.');
    setSource(response.summary_source.source);
  }
  function fact(item: Summary['overview'], index: number) {
    return (
      <div className="summary-fact" key={index}>
        <p>{item.text}</p>
        <div className="summary-citations">
          {item.citations.map((citation) => {
            const number =
              citations.findIndex(
                (value) =>
                  value.source === citation.source &&
                  value.id === citation.id &&
                  value.revision === citation.revision,
              ) + 1;
            return (
              <button
                key={`${citation.source}:${citation.id}:${citation.revision}`}
                disabled={busy}
                onClick={() => void action(() => inspect(citation))}
                aria-label={`Inspect source ${number}`}
              >
                {citation.source === 'note' ? 'Notes' : 'Transcript'} [{number}]
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  if (unavailable)
    return (
      <section className="summary-panel" aria-label="Meeting summary">
        <p className="quiet-note">
          This meeting is no longer available. Its summary view was cleared.
        </p>
      </section>
    );
  return (
    <section className="summary-panel" aria-label="Meeting summary">
      <div className="summary-heading">
        <div>
          <strong>Meeting summary</strong>
          <p className="quiet-note">Cited draft. Your notes stay yours.</p>
        </div>
        {!confirmation && (
          <button
            className="primary"
            disabled={busy || !connected || running || Boolean(unresolved)}
            onClick={() => prepare('new')}
          >
            {jobs.length ? 'New summary' : 'Generate summary'}
          </button>
        )}
      </div>
      {!connected && (
        <p className="quiet-note">
          Connect the original workspace to generate or refresh. Saved reviews
          and inspected sources remain available offline.
        </p>
      )}
      {submission?.rejected && (
        <p className="summary-warning">
          The service rejected the saved input before creating a job. Update the
          meeting and confirm a new summary request.
        </p>
      )}
      {unresolved && (
        <div className="summary-warning">
          <p>
            A saved summary request needs reconciliation. Recovery reuses its
            original input and request key; it does not create a second attempt.
          </p>
          <button
            disabled={busy || !connected}
            onClick={() => prepare('recover')}
          >
            Recover saved summary request
          </button>
        </div>
      )}
      {confirmation && (
        <div className="summary-consent">
          <label>
            Summary template{' '}
            <select
              aria-label="Summary template"
              disabled={busy || confirmation === 'recover' || !templates}
              value={template}
              onChange={(event) => {
                const selected = summaryTemplateIdSchema.safeParse(
                  event.target.value,
                );
                if (selected.success) setTemplate(selected.data);
                else setError('Choose a supported summary template.');
              }}
            >
              {(confirmation === 'recover'
                ? SUMMARY_TEMPLATES
                : (templates ?? [])
              ).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {confirmation === 'new' && !templates && !error && (
            <p className="quiet-note">Loading service templates...</p>
          )}
          {templates?.find((item) => item.id === template)?.description && (
            <p className="quiet-note">
              {templates.find((item) => item.id === template)!.description}
            </p>
          )}
          <label>
            Summary language{' '}
            <select
              aria-label="Summary language"
              disabled={busy || confirmation === 'recover'}
              value={language}
              onChange={(event) =>
                setLanguage(event.target.value === 'zh' ? 'zh' : 'en')
              }
            >
              <option value="en">English</option>
              <option value="zh">Chinese</option>
            </select>
          </label>
          <p className="quiet-note">
            The configured Azure OpenAI service processes a frozen copy of saved
            notes and the canonical transcript. Local audio and live captions
            are not included. Usage counts against your account allowance.
          </p>
          <label className="summary-check">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(event) => setConsent(event.target.checked)}
            />
            {confirmation === 'recover'
              ? 'Recover the original authorized request, submitting it if its receipt was lost.'
              : 'I agree to Azure processing for this summary.'}
          </label>
          <div className="summary-actions">
            <button
              className="primary"
              disabled={
                busy ||
                !consent ||
                !connected ||
                (confirmation === 'new' && !templates)
              }
              onClick={() => void action(start)}
            >
              {busy
                ? 'Preparing...'
                : confirmation === 'recover'
                  ? 'Recover request'
                  : 'Generate cited draft'}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setConfirmation(null);
                setConsent(false);
              }}
            >
              Keep writing
            </button>
          </div>
        </div>
      )}
      {choices.length > 1 && (
        <label className="summary-history">
          Summary history{' '}
          <select
            aria-label="Summary history"
            value={job?.id}
            disabled={busy}
            onChange={(event) => void action(() => choose(event.target.value))}
          >
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {new Date(item.created_at).toLocaleString()} -{' '}
                {item.state.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
      )}
      {job && (
        <div className="summary-result">
          {templateVersion && (
            <p className="quiet-note">
              Template:{' '}
              {SUMMARY_TEMPLATES.find((item) => item.id === templateVersion)
                ?.name ?? 'Summary'}{' '}
              ({templateVersion})
            </p>
          )}
          <div className="summary-heading">
            <span className="summary-status" role="status">
              {job.state.replaceAll('_', ' ')}
            </span>
            <div className="summary-actions">
              <button
                disabled={busy || !connected}
                onClick={() =>
                  void action(async () => {
                    if (
                      !(await invoke({
                        operation: 'controlSummary',
                        scope: state.scope,
                        id: draft.id,
                        job_id: job.id,
                        action: 'refresh',
                        confirmed: true,
                      }))
                    )
                      throw new Error(
                        'The latest summary status could not be confirmed.',
                      );
                  })
                }
              >
                Refresh summary
              </button>
              {pending(job.state) && (
                <button
                  disabled={busy || !connected}
                  onClick={() =>
                    void action(async () => {
                      if (
                        !(await invoke({
                          operation: 'controlSummary',
                          scope: state.scope,
                          id: draft.id,
                          job_id: job.id,
                          action: 'cancel',
                          confirmed: true,
                        }))
                      )
                        throw new Error(
                          'Cancellation was not confirmed. Refresh to reconcile.',
                        );
                    })
                  }
                >
                  Cancel summary
                </button>
              )}
            </div>
          </div>
          {pending(job.state) && (
            <p className="quiet-note">
              Processing continues on the server if this window closes. Refresh
              to recover its durable status. Cancellation cannot undo provider
              usage already dispatched.
            </p>
          )}
          {job.input_stale && (
            <p className="summary-warning">
              The meeting changed after this input was frozen. Inspect the
              original sources before using this draft.
            </p>
          )}
          {job.error && <p className="account-alert">{job.error.message}</p>}
          {job.state === 'failed' && !resume && (
            <button
              disabled={busy || !connected}
              onClick={() => void action(prepareResume)}
            >
              Resume summary
            </button>
          )}
          {resume?.job_id === job.id && (
            <div className="summary-consent">
              <strong>Resume frozen summary</strong>
              <p className="quiet-note">
                {resume.completed_stages} of {resume.total_stages} stages saved.{' '}
                {resume.provider_requests} provider requests,{' '}
                {resume.uncertain_requests} with uncertain usage. Completed work
                is kept. Requests without saved output may be sent again;
                previous charges and reservations are not undone.
              </p>
              <label className="summary-check">
                <input
                  type="checkbox"
                  checked={resumeConsent}
                  disabled={busy}
                  onChange={(event) => setResumeConsent(event.target.checked)}
                />
                I authorize additional Azure requests for the original frozen
                input.
              </label>
              <div className="summary-actions">
                <button
                  className="primary"
                  disabled={busy || !connected || !resumeConsent}
                  onClick={() =>
                    void action(async () => {
                      if (!resume.resume_token)
                        throw new Error(
                          'Refresh summary progress before resuming.',
                        );
                      if (
                        !(await invoke({
                          operation: 'controlSummary',
                          scope: state.scope,
                          id: draft.id,
                          job_id: resume.job_id,
                          action: 'resume',
                          confirmed: true,
                          resume_token: resume.resume_token,
                        }))
                      )
                        throw new Error(
                          'Resume was not confirmed. Retry this same confirmation to reconcile without authorizing a second attempt.',
                        );
                      setResume(null);
                      setResumeConsent(false);
                    })
                  }
                >
                  Confirm resume
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setResume(null);
                    setResumeConsent(false);
                  }}
                >
                  Keep paused
                </button>
              </div>
            </div>
          )}
          {summary && (
            <>
              {fact(summary.overview, 0)}
              {(
                [
                  ['Topics', summary.topics],
                  ['Decisions', summary.decisions],
                  ['Action items', summary.action_items],
                  ['Open questions', summary.open_questions],
                ] as const
              )
                .filter(([, items]) => items.length)
                .map(([title, items]) => (
                  <details key={title}>
                    <summary>
                      {title}
                      <span>{items.length}</span>
                    </summary>
                    {items.map((item, index) => (
                      <div key={index}>
                        {fact(item, index)}
                        {'owner' in item && (
                          <p className="quiet-note">
                            Owner: {item.owner ?? 'Not specified'} - Due:{' '}
                            {item.due_date ?? 'Not specified'}
                          </p>
                        )}
                      </div>
                    ))}
                  </details>
                ))}
              <p className="quiet-note">
                A citation locates the original source; it does not prove the
                claim is accurate. Verify decisions, owners and dates.
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    if (editing && !(await reviewFlush.current())) return;
                    setEditing(!editing);
                  })
                }
              >
                {editing ? 'Close review' : 'Review and edit draft'}
              </button>
            </>
          )}
          {source && (
            <aside
              className="summary-source"
              aria-label="Frozen summary source"
            >
              <div className="summary-heading">
                <strong>
                  {source.citation.source === 'note'
                    ? 'Frozen notes'
                    : 'Frozen transcript segment'}{' '}
                  - revision {source.citation.revision}
                </strong>
                <button onClick={() => setSource(null)}>Close source</button>
              </div>
              <p>{source.text || 'This source revision contained no text.'}</p>
              <p className="quiet-note">
                This is the job's original source, not the current edited
                meeting.
              </p>
            </aside>
          )}
          {editing && summary && (
            <SummaryEditor key={job.id} {...props} jobId={job.id} />
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="account-alert">
          {error}
        </p>
      )}
    </section>
  );
}

function SummaryEditor({
  state,
  draft,
  beforeStart,
  reviewFlush,
  invoke,
  jobId,
}: Props & { jobId: string }) {
  const [review, setReview] = useState<SummaryReview | null>(null);
  const saved = useRef<SummaryReview | null>(null);
  const [text, setText] = useState('');
  const latestText = useRef('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [format, setFormat] = useState<'markdown' | 'text'>('markdown');
  const running = useRef<Promise<boolean> | null>(null);
  const alive = useRef(true);
  async function load(rebase: boolean) {
    const response = await window.notes.invoke({
      operation: 'openSummaryReview',
      scope: state.scope,
      id: draft.id,
      job_id: jobId,
      rebase,
      confirmed: true,
    });
    if (!alive.current) return;
    if (!response.ok) throw new Error(response.error.message);
    if (
      !('summary_review' in response) ||
      response.summary_review.scope !== state.scope ||
      response.summary_review.review.document_id !== draft.id ||
      response.summary_review.review.job_id !== jobId
    )
      throw new Error('The saved summary review belongs to another view.');
    saved.current = response.summary_review.review;
    latestText.current = saved.current.text;
    setReview(saved.current);
    setText(saved.current.text);
    setConfirmed(false);
  }
  async function save(): Promise<boolean> {
    if (running.current) return running.current;
    if (!saved.current || latestText.current === saved.current.text)
      return true;
    const operation = (async () => {
      setSaving(true);
      try {
        while (saved.current && latestText.current !== saved.current.text) {
          if (
            !summaryReviewSchema.shape.text.safeParse(latestText.current)
              .success
          )
            throw new Error(
              'Keep 1-40,000 characters without null characters. These review edits have not been saved.',
            );
          const response = await window.notes.invoke({
            operation: 'saveSummaryReview',
            scope: state.scope,
            id: draft.id,
            job_id: jobId,
            review_revision: saved.current.revision,
            text: latestText.current,
          });
          if (!alive.current) return false;
          if (!response.ok) throw new Error(response.error.message);
          if (
            !('summary_review' in response) ||
            response.summary_review.scope !== state.scope ||
            response.summary_review.review.document_id !== draft.id ||
            response.summary_review.review.job_id !== jobId
          )
            throw new Error(
              'The saved summary review belongs to another view.',
            );
          saved.current = response.summary_review.review;
          setReview(saved.current);
        }
        setError('');
        return true;
      } catch (error) {
        if (alive.current) setError(message(error));
        return false;
      }
    })();
    running.current = operation;
    try {
      return await operation;
    } finally {
      running.current = null;
      if (alive.current) setSaving(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    reviewFlush.current = save;
    void load(false).catch((error) => {
      if (alive.current) setError(message(error));
    });
    return () => {
      alive.current = false;
      if (reviewFlush.current === save) reviewFlush.current = async () => true;
    };
  }, []);
  async function action(operation: () => Promise<void>) {
    if (busy || !(await save())) return;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (error) {
      if (alive.current) setError(message(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const applied = review !== null && review.applied_local_revision !== null;
  const changed =
    review !== null && review.base_local_revision !== draft.local_revision;
  return (
    <section className="summary-review" aria-label="Editable summary review">
      <div className="summary-heading">
        <strong>Your review</strong>
        <span role="status">
          {saving
            ? 'Saving review...'
            : review && text !== review.text
              ? 'Unsaved review edits'
              : 'Encrypted local draft'}
        </span>
      </div>
      <p className="quiet-note">
        Edits save separately from your notes. Original source locators are
        retained, but edited claims need verification.
      </p>
      <textarea
        aria-label="Summary review text"
        value={text}
        disabled={!review || busy || applied}
        onChange={(event) => {
          latestText.current = event.target.value;
          setText(event.target.value);
          setConfirmed(false);
          void save();
        }}
      />
      {error && (
        <div role="alert" className="account-alert">
          <p>{error}</p>
          {saved.current && latestText.current !== saved.current.text && (
            <div className="summary-actions">
              <button onClick={() => void save()}>Retry saving review</button>
              <button
                onClick={() => {
                  latestText.current = saved.current!.text;
                  setText(latestText.current);
                  setError('');
                }}
              >
                Discard unsaved review edits
              </button>
            </div>
          )}
          {!review && (
            <button onClick={() => void action(() => load(false))}>
              Reload saved review
            </button>
          )}
        </div>
      )}
      {applied ? (
        <p className="summary-warning">
          Appended once. Make further changes in the notes; this review cannot
          be applied twice.
        </p>
      ) : (
        <>
          {changed && (
            <div className="summary-warning">
              <p>
                Your notes changed after this review began. Read the latest
                notes before updating the append baseline. Review text will be
                preserved.
              </p>
              <button
                disabled={busy || saving}
                onClick={() =>
                  void action(async () => {
                    if (await beforeStart()) await load(true);
                  })
                }
              >
                Use latest notes as append baseline
              </button>
            </div>
          )}
          <label className="summary-check">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!review || busy || saving || changed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Append this reviewed draft without replacing my existing notes.
          </label>
          <button
            className="primary"
            disabled={!review || !confirmed || busy || saving || changed}
            onClick={() =>
              void action(async () => {
                if (!(await beforeStart())) return;
                const result = await invoke({
                  operation: 'applySummaryReview',
                  scope: state.scope,
                  id: draft.id,
                  job_id: jobId,
                  review_revision: saved.current!.revision,
                  local_revision: draft.local_revision,
                  confirmed: true,
                });
                if (!result)
                  throw new Error(
                    'The append was not confirmed. Reopen this review to reconcile; retrying will not append it twice.',
                  );
                await load(false);
              })
            }
          >
            Append reviewed summary
          </button>
        </>
      )}
      <div className="summary-actions summary-export">
        <select
          aria-label="Summary export format"
          value={format}
          onChange={(event) =>
            setFormat(event.target.value === 'text' ? 'text' : 'markdown')
          }
        >
          <option value="markdown">Markdown</option>
          <option value="text">Plain text</option>
        </select>
        <button
          disabled={!review || busy || saving}
          onClick={() =>
            void action(async () => {
              if (
                !(await invoke({
                  operation: 'exportSummaryReview',
                  scope: state.scope,
                  id: draft.id,
                  job_id: jobId,
                  review_revision: saved.current!.revision,
                  format,
                }))
              )
                throw new Error('The export was not confirmed.');
            })
          }
        >
          Export reviewed draft
        </button>
        <span className="quiet-note">Exports are unencrypted.</span>
      </div>
    </section>
  );
}
