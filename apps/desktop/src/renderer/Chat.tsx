import { useEffect, useRef, useState } from 'react';
import type {
  DesktopCommand,
  DesktopState,
  Draft,
} from '@windows-ai-notes/contracts/desktop';
import {
  questionRequestSchema,
  type ChatSource,
  type ChatTurn,
  type ChatView,
} from '@windows-ai-notes/contracts/questions';

type Props = {
  state: DesktopState;
  draft: Draft;
  beforeStart: () => Promise<boolean>;
};
const pending = (turn: ChatTurn) => ['queued', 'running'].includes(turn.state);
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The chat operation failed.';
export function ChatPanel({ state, draft, beforeStart }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ChatView | null>(null);
  const current = useRef<ChatView | null>(null);
  const [question, setQuestion] = useState('');
  const [language, setLanguage] = useState<'en' | 'zh'>('en');
  const [consent, setConsent] = useState(false);
  const consentId = useRef(crypto.randomUUID());
  const [resumeFor, setResumeFor] = useState<string | null>(null);
  const [resumeConsent, setResumeConsent] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConsent, setDeleteConsent] = useState(false);
  const [source, setSource] = useState<ChatSource | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const epoch = useRef(0);
  const reading = useRef(0);
  const refreshedVersion = useRef(0);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState('');
  const connected =
    state.connection.active_workspace !== null &&
    ![
      'offline',
      'connecting',
      'disconnecting',
      'reauth_required',
      'switching',
    ].includes(state.connection.status);
  useEffect(() => {
    const stop = window.notes.onChanged((change) => {
      if (change.scope !== state.scope || change.kind === 'revoked') {
        epoch.current++;
        current.current = null;
        setView(null);
        setSource(null);
        setQuestion('');
        setError('');
        setUnavailable(true);
      }
    });
    return () => {
      epoch.current++;
      stop();
    };
  }, [state.scope, draft.id]);
  function accept(value: ChatView) {
    current.current = value;
    setView(value);
  }
  async function read(
    refresh: boolean,
    options: {
      thread?: string | null;
      offset?: number;
      after?: number;
      preserveSource?: boolean;
    } = {},
  ) {
    const version = epoch.current,
      request = ++reading.current,
      previous = current.current;
    const response = await window.notes.invoke({
      operation: 'getChat',
      scope: state.scope,
      id: draft.id,
      refresh,
      offset: options.offset ?? previous?.offset ?? 0,
      ...(options.thread !== undefined
        ? { thread_id: options.thread }
        : previous
          ? { thread_id: previous.thread_id }
          : {}),
      ...(options.after !== undefined ? { after: options.after } : {}),
    });
    if (version !== epoch.current || request !== reading.current) return;
    if (!response.ok) throw new Error(response.error.message);
    if (
      !('chat_view' in response) ||
      response.chat_view.scope !== state.scope ||
      response.chat_view.view.document_id !== draft.id
    )
      throw new Error(
        'The desktop returned another chat workspace or meeting.',
      );
    accept(response.chat_view.view);
    if (
      !options.preserveSource ||
      previous?.thread_id !== response.chat_view.view.thread_id
    )
      setSource(null);
  }
  async function action(run: () => Promise<void>) {
    if (working.current || unavailable) return;
    working.current = true;
    const version = epoch.current;
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (error) {
      if (version === epoch.current) {
        setError(message(error));
        try {
          await read(false);
        } catch (cacheError) {
          if (version === epoch.current) {
            setError(message(cacheError));
            current.current = null;
            setView(null);
            setSource(null);
          }
        }
      }
    } finally {
      working.current = false;
      if (version === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!open) return;
    void action(async () => {
      await read(false);
      if (connected) await read(true);
    });
  }, [open]);
  const saved = view?.submission;
  const unresolved = saved && !saved.rejected && !saved.turn_id;
  useEffect(() => {
    if (unresolved) {
      setQuestion(saved.question);
      setLanguage(saved.language);
      setConsent(false);
    }
  }, [unresolved ? saved.consent_id : null]);
  useEffect(() => {
    if (
      saved?.rejected ||
      (saved?.turn_id && saved.consent_id === consentId.current)
    ) {
      consentId.current = crypto.randomUUID();
      setConsent(false);
    }
  }, [saved?.rejected, saved?.turn_id, saved?.consent_id]);
  const activeTurn = view?.turns.findLast(pending);
  const generation =
    state.chat_generation?.turn_id === activeTurn?.id &&
    state.chat_generation?.thread_id === view?.thread_id
      ? state.chat_generation
      : null;
  async function watch(turn: ChatTurn, mode: 'start' | 'stop') {
    const version = epoch.current;
    const response = await window.notes.invoke({
      operation: 'watchChat',
      scope: state.scope,
      id: draft.id,
      thread_id: turn.thread_id,
      turn_id: turn.id,
      action: mode,
    });
    if (version !== epoch.current) return;
    if (!response.ok) throw new Error(response.error.message);
    if (!('state' in response) || response.state.scope !== state.scope)
      throw new Error(
        'The desktop returned another question-update workspace.',
      );
  }
  useEffect(() => {
    if (!open || !connected || !activeTurn || unavailable) return;
    let alive = true;
    const turn = activeTurn;
    void watch(turn, 'start').catch((error) => {
      if (alive) setError(message(error));
    });
    return () => {
      alive = false;
      void window.notes
        .invoke({
          operation: 'watchChat',
          scope: state.scope,
          id: draft.id,
          thread_id: turn.thread_id,
          turn_id: turn.id,
          action: 'stop',
        })
        .then((response) => {
          if (
            !response.ok &&
            ![
              'workspace_changed',
              'workspace_closed',
              'workspace_transition',
            ].includes(response.error.code)
          )
            console.error(JSON.stringify({ code: 'chat_updates_stop_failed' }));
        })
        .catch(() => {
          console.error(JSON.stringify({ code: 'chat_updates_stop_failed' }));
        });
    };
  }, [open, connected, unavailable, state.scope, draft.id, activeTurn?.id]);
  useEffect(() => {
    if (
      open &&
      activeTurn &&
      !working.current &&
      !unavailable &&
      refreshedVersion.current !== state.version &&
      state.chat_generation?.turn_id !== activeTurn.id
    ) {
      refreshedVersion.current = state.version;
      void action(() =>
        read(false, {
          after: current.current?.after ?? 0,
          preserveSource: true,
        }),
      );
    }
  }, [state.version, open, busy]);
  async function mutate(command: DesktopCommand) {
    const version = epoch.current;
    reading.current++;
    const response = await window.notes.invoke(command);
    if (version !== epoch.current) return false;
    if (!response.ok) throw new Error(response.error.message);
    if (
      !('chat_view' in response) ||
      response.chat_view.scope !== state.scope ||
      response.chat_view.view.document_id !== draft.id
    )
      throw new Error('The desktop returned an unsupported chat response.');
    reading.current++;
    accept(response.chat_view.view);
    setSource(null);
    setConsent(false);
    setResumeConsent(false);
    setResumeFor(null);
    return true;
  }
  async function ask() {
    if (!consent) return;
    if (!unresolved && !(await beforeStart()))
      throw new Error('Save the meeting notes before asking a question.');
    const selected = unresolved ? saved.thread_id : view?.thread_id;
    if (
      await mutate({
        operation: 'askMeeting',
        scope: state.scope,
        id: draft.id,
        ...(selected ? { thread_id: selected } : {}),
        question: unresolved ? saved.question : question,
        language: unresolved ? saved.language : language,
        confirmed: true,
        new_attempt: !unresolved,
        consent_id: unresolved ? saved.consent_id : consentId.current,
      })
    ) {
      setQuestion('');
      consentId.current = crypto.randomUUID();
    }
  }
  async function control(
    turn: Pick<ChatTurn, 'id' | 'thread_id'>,
    mode: 'cancel' | 'resume',
    token?: string,
  ) {
    await mutate({
      operation: 'controlChatTurn',
      scope: state.scope,
      id: draft.id,
      thread_id: turn.thread_id,
      turn_id: turn.id,
      action: mode,
      confirmed: true,
      ...(token ? { resume_token: token } : {}),
    });
  }
  async function inspect(turn: ChatTurn, citation: ChatSource['citation']) {
    const version = epoch.current;
    const response = await window.notes.invoke({
      operation: 'getChatSource',
      scope: state.scope,
      id: draft.id,
      thread_id: turn.thread_id,
      turn_id: turn.id,
      citation,
    });
    if (version !== epoch.current) return;
    if (!response.ok) throw new Error(response.error.message);
    if (
      !('chat_source' in response) ||
      response.chat_source.scope !== state.scope ||
      response.chat_source.source.document_id !== draft.id ||
      response.chat_source.source.turn_id !== turn.id
    )
      throw new Error('The desktop returned another cited source.');
    setSource(response.chat_source.source);
  }
  async function remove(thread: string) {
    setSource(null);
    const previous = current.current;
    if (previous?.thread_id === thread)
      accept({
        ...previous,
        thread_id: null,
        turns: [],
        after: 0,
        turns_has_more: false,
        threads: previous.threads.filter((item) => item.id !== thread),
        submission:
          previous.submission?.thread_id === thread
            ? null
            : previous.submission,
        recovery:
          previous.recovery?.thread_id === thread ? null : previous.recovery,
        deleting_thread_id: thread,
        cached: true,
      });
    if (
      await mutate({
        operation: 'deleteChatThread',
        scope: state.scope,
        id: draft.id,
        thread_id: thread,
        confirmed: true,
      })
    ) {
      setDeleting(false);
      setDeleteConsent(false);
    }
  }
  const blocked = busy || unavailable;
  const recovery = view?.recovery;
  return (
    <details
      className="summary-panel chat-panel"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Ask this meeting</summary>
      {open && (
        <div className="chat-content">
          <div className="summary-heading">
            <p className="quiet-note">
              Only this meeting is evidence. Verify cited claims; retrieval can
              miss relevant material.
            </p>
            <button
              className="quiet-button"
              disabled={blocked || !connected}
              onClick={() => void action(() => read(true))}
            >
              Refresh answers
            </button>
          </div>
          {error && (
            <p role="alert" className="account-alert">
              {error}
            </p>
          )}
          {unavailable ? (
            <p className="quiet-note">This workspace is no longer available.</p>
          ) : (
            <>
              {view?.cached && (
                <p className="quiet-note">
                  History is saved on this device. Live previews are authorized
                  separately. Refresh to verify other saved answers.
                </p>
              )}
              {view && !view.history_complete && (
                <p className="quiet-note">
                  This history page is not fully cached. Reconnect and refresh
                  to load it.
                </p>
              )}
              {view?.deleting_thread_id && (
                <section
                  className="account-alert"
                  aria-label="Pending conversation deletion"
                >
                  <p>
                    Deletion is not yet confirmed. Saved conversation content
                    was removed from this device.
                  </p>
                  <button
                    className="danger-button"
                    disabled={blocked || !connected}
                    onClick={() =>
                      void action(() => remove(view.deleting_thread_id!))
                    }
                  >
                    Finish conversation deletion
                  </button>
                </section>
              )}
              <div className="chat-navigation">
                <label>
                  Conversation
                  <select
                    aria-label="Chat conversation"
                    disabled={
                      blocked || !!unresolved || !!view?.deleting_thread_id
                    }
                    value={view?.thread_id ?? ''}
                    onChange={(event) => {
                      const thread = event.target.value || null;
                      setSource(null);
                      setDeleting(false);
                      setDeleteConsent(false);
                      setResumeFor(null);
                      void action(() => read(connected, { thread }));
                    }}
                  >
                    <option value="">New conversation</option>
                    {view?.thread_id &&
                      !view.threads.some(
                        (thread) => thread.id === view.thread_id,
                      ) && (
                        <option value={view.thread_id}>
                          Current conversation
                        </option>
                      )}
                    {view?.threads.map((thread) => (
                      <option key={thread.id} value={thread.id}>
                        {thread.title}
                      </option>
                    ))}
                  </select>
                </label>
                {view && view.offset > 0 && (
                  <button
                    disabled={blocked || !connected}
                    onClick={() =>
                      void action(() =>
                        read(true, { offset: view.offset - 50, thread: null }),
                      )
                    }
                  >
                    Previous conversations
                  </button>
                )}
                {view?.threads_has_more && (
                  <button
                    disabled={blocked || !connected}
                    onClick={() =>
                      void action(() =>
                        read(true, { offset: view.offset + 50, thread: null }),
                      )
                    }
                  >
                    More conversations
                  </button>
                )}
                {view?.thread_id && (
                  <button
                    className="quiet-button"
                    disabled={blocked || !connected || !!unresolved}
                    onClick={() => {
                      setDeleting(!deleting);
                      setDeleteConsent(false);
                    }}
                  >
                    Delete conversation
                  </button>
                )}
              </div>
              {deleting && view?.thread_id && (
                <section className="account-alert">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={deleteConsent}
                      onChange={(event) =>
                        setDeleteConsent(event.target.checked)
                      }
                    />
                    Delete this conversation and its saved sources. Earlier
                    provider usage is retained.
                  </label>
                  <button
                    className="danger-button"
                    disabled={blocked || !connected || !deleteConsent}
                    onClick={() => void action(() => remove(view.thread_id!))}
                  >
                    Delete conversation permanently
                  </button>
                  <button
                    className="quiet-button"
                    onClick={() => setDeleting(false)}
                    disabled={blocked}
                  >
                    Keep conversation
                  </button>
                </section>
              )}
              {recovery && (
                <section
                  className="account-alert"
                  aria-label="Saved chat recovery"
                >
                  <p>
                    A confirmed recovery receipt was lost. Reconcile its
                    original token; do not authorize another paid attempt.
                  </p>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={resumeConsent}
                      onChange={(event) =>
                        setResumeConsent(event.target.checked)
                      }
                    />
                    Reconcile the original confirmed recovery.
                  </label>
                  <button
                    disabled={blocked || !connected || !resumeConsent}
                    onClick={() =>
                      void action(() =>
                        control(
                          {
                            id: recovery.turn_id,
                            thread_id: recovery.thread_id,
                          },
                          'resume',
                          recovery.resume_token,
                        ),
                      )
                    }
                  >
                    Recover confirmed attempt
                  </button>
                  <button
                    disabled={blocked || !connected}
                    onClick={() =>
                      void action(() =>
                        control(
                          {
                            id: recovery.turn_id,
                            thread_id: recovery.thread_id,
                          },
                          'cancel',
                        ),
                      )
                    }
                  >
                    Cancel saved recovery
                  </button>
                </section>
              )}
              <div
                className="chat-history"
                aria-label="Meeting conversation history"
              >
                {view?.turns.map((turn) => (
                  <article className="chat-turn" key={turn.id}>
                    <p className="chat-question">{turn.request.question}</p>
                    <div className="summary-heading">
                      <span className="summary-status" role="status">
                        {pending(turn) && generation?.status === 'streaming'
                          ? 'processing'
                          : turn.state}
                      </span>
                      {(pending(turn) ||
                        (turn.state === 'failed' && turn.resume_available)) && (
                        <button
                          disabled={blocked || !connected}
                          onClick={() =>
                            void action(() => control(turn, 'cancel'))
                          }
                        >
                          Cancel question
                        </button>
                      )}
                    </div>
                    {turn.input_stale ||
                    turn.request.note_revision !== draft.remote_revision ||
                    turn.request.transcript_revision !==
                      state.transcript_revision ||
                    draft.status !== 'synced' ? (
                      <p className="summary-warning">
                        The meeting changed after this question was frozen.
                        Inspect the original cited sources.
                      </p>
                    ) : null}
                    {turn.result && (
                      <div
                        className="chat-answer"
                        aria-label="Completed meeting answer"
                      >
                        {turn.result.answer.status ===
                          'insufficient_evidence' && (
                          <span className="eyebrow">
                            INSUFFICIENT MEETING EVIDENCE
                          </span>
                        )}
                        <p>{turn.result.answer.answer.text}</p>
                        <div className="summary-actions">
                          {turn.result.answer.answer.citations.map(
                            (citation, index) => (
                              <button
                                key={`${citation.source}:${citation.id}:${citation.revision}`}
                                disabled={blocked}
                                onClick={() =>
                                  void action(() => inspect(turn, citation))
                                }
                                aria-label={`Chat source ${index + 1}`}
                              >
                                [{index + 1}]{' '}
                                {citation.source === 'note'
                                  ? 'Note'
                                  : 'Transcript'}{' '}
                                v{citation.revision}
                              </button>
                            ),
                          )}
                        </div>
                      </div>
                    )}
                    {pending(turn) && (
                      <section
                        className="summary-stream"
                        aria-label="Live meeting answer"
                      >
                        <div className="summary-heading">
                          <span className="summary-status" role="status">
                            {generation?.status === 'paused'
                              ? 'Answer updates paused'
                              : generation?.status === 'reconnecting'
                                ? 'Reconnecting answer updates'
                                : generation?.status === 'streaming'
                                  ? 'Receiving answer updates'
                                  : 'Waiting for answer updates'}
                          </span>
                          <button
                            disabled={blocked || !connected}
                            onClick={() =>
                              void action(() =>
                                watch(
                                  turn,
                                  generation && generation.status !== 'paused'
                                    ? 'stop'
                                    : 'start',
                                ),
                              )
                            }
                          >
                            {generation && generation.status !== 'paused'
                              ? 'Pause answer updates'
                              : 'Connect answer updates'}
                          </button>
                        </div>
                        {generation?.preview && (
                          <div
                            className="summary-preview"
                            aria-label="Unfinished answer preview"
                          >
                            <span className="eyebrow">UNFINISHED PREVIEW</span>
                            <p>{generation.preview}</p>
                            <small>
                              Not a validated answer. Verify the completed
                              citations before relying on it.
                            </small>
                          </div>
                        )}
                        {generation?.error && (
                          <p className="account-alert">{generation.error}</p>
                        )}
                        <p className="quiet-note">
                          Closing or pausing updates does not stop server work.
                          Cancellation cannot undo dispatched usage.
                        </p>
                      </section>
                    )}
                    {turn.error && (
                      <p className="account-alert">{turn.error.message}</p>
                    )}
                    {turn.provider_requests > 0 && (
                      <p className="quiet-note">
                        {turn.provider_requests} provider request(s);{' '}
                        {turn.uncertain_requests} uncertain. Earlier usage is
                        retained.
                      </p>
                    )}
                    {turn.resume_available && !recovery && (
                      <div className="chat-recovery">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={resumeFor === turn.id}
                            disabled={blocked || !connected}
                            onChange={(event) =>
                              setResumeFor(
                                event.target.checked ? turn.id : null,
                              )
                            }
                          />
                          Authorize another Azure answer attempt; previous usage
                          may still be charged.
                        </label>
                        <button
                          disabled={
                            blocked || !connected || resumeFor !== turn.id
                          }
                          onClick={() =>
                            void action(() =>
                              control(turn, 'resume', turn.resume_token!),
                            )
                          }
                        >
                          Resume answer
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
              {view?.thread_id && (
                <div className="summary-actions">
                  {view.after > 0 && (
                    <button
                      disabled={blocked}
                      onClick={() =>
                        void action(() =>
                          read(connected, { after: view.after - 50 }),
                        )
                      }
                    >
                      Earlier questions
                    </button>
                  )}
                  {view.turns_has_more && (
                    <button
                      disabled={blocked}
                      onClick={() =>
                        void action(() =>
                          read(connected, { after: view.after + 50 }),
                        )
                      }
                    >
                      Later questions
                    </button>
                  )}
                </div>
              )}
              {source && (
                <section
                  className="summary-source chat-source"
                  aria-label="Frozen chat source"
                >
                  <div className="summary-heading">
                    <h3>
                      {source.citation.source === 'note'
                        ? 'Frozen note'
                        : 'Frozen transcript'}{' '}
                      · revision {source.citation.revision}
                    </h3>
                    <button onClick={() => setSource(null)}>
                      Close source
                    </button>
                  </div>
                  {source.excerpts.map((excerpt) => (
                    <div key={`${excerpt.text_start}:${excerpt.text_end}`}>
                      <small>
                        Original text offsets {excerpt.text_start}–
                        {excerpt.text_end}
                        {excerpt.start_ms === null
                          ? ''
                          : ` · ${Math.floor(excerpt.start_ms / 1000)}–${Math.ceil((excerpt.end_ms ?? excerpt.start_ms) / 1000)}s`}
                      </small>
                      <p>{excerpt.text}</p>
                    </div>
                  ))}
                </section>
              )}
              <form
                className="chat-compose"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!blocked && connected && consent) void action(ask);
                }}
              >
                <label className="field-label" htmlFor="meeting-question">
                  Question about this meeting
                </label>
                <textarea
                  id="meeting-question"
                  aria-label="Meeting question"
                  maxLength={2000}
                  rows={3}
                  value={question}
                  disabled={blocked || !!unresolved}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="Who owns the next step?"
                />
                <label className="field-label">
                  Answer language
                  <select
                    aria-label="Chat answer language"
                    value={language}
                    disabled={blocked || !!unresolved}
                    onChange={(event) =>
                      setLanguage(event.target.value === 'zh' ? 'zh' : 'en')
                    }
                  >
                    <option value="en">English</option>
                    <option value="zh">中文</option>
                  </select>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={consent}
                    disabled={
                      blocked ||
                      !connected ||
                      !!recovery ||
                      !!view?.deleting_thread_id
                    }
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  {unresolved
                    ? 'Recover the original authorized question, submitting it only if its receipt was lost.'
                    : 'Send this question and frozen meeting evidence to Azure for an answer.'}
                </label>
                <button
                  className="primary"
                  disabled={
                    blocked ||
                    !connected ||
                    !consent ||
                    !!recovery ||
                    !!view?.deleting_thread_id ||
                    (!unresolved && !!view?.turns.some(pending)) ||
                    !questionRequestSchema.shape.question.safeParse(question)
                      .success
                  }
                >
                  {unresolved ? 'Recover question request' : 'Ask question'}
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </details>
  );
}
