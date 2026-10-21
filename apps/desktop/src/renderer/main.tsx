import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  richTextSchema,
  richTextToPlainText,
  tagsSchema,
} from '@windows-ai-notes/contracts/content';
import type {
  DesktopBridge,
  DesktopCommand,
  DesktopState,
  Draft,
  EditableDraft,
} from '@windows-ai-notes/contracts/desktop';
import './style.css';
import { Account } from './Account.js';
import { NoteExtras } from './NoteExtras.js';

declare global {
  interface Window {
    notes: DesktopBridge;
  }
}
const labels = {
  local: 'Saved locally',
  pending: 'Sync pending',
  synced: 'Synced',
  conflict: 'Needs a decision',
  deleted_remote: 'Local recovery',
};

function App() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<'notes' | 'storage' | 'account'>('notes');
  const [switching, setSwitching] = useState(false);
  const flush = useRef<() => Promise<boolean>>(async () => true);
  const latest = useRef<DesktopState | null>(null);
  const minimumVersion = useRef(0);
  const scope = useRef(1);
  const authAttempt = useRef(0);
  async function invoke(command: DesktopCommand, discardEditor = false) {
    const attempt =
      command.operation === 'connect' || command.operation === 'cancelConnect'
        ? ++authAttempt.current
        : authAttempt.current;
    try {
      const response = await window.notes.invoke(command);
      if (!response.ok) {
        if (
          (command.operation === 'connect' &&
            attempt !== authAttempt.current) ||
          ('scope' in command &&
            command.scope !== scope.current &&
            ![
              'connect',
              'activateWorkspace',
              'disconnect',
              'workOffline',
            ].includes(command.operation))
        )
          return null;
        setError(response.error.message);
        return null;
      }
      if ('closing' in response) return null;
      if (
        !discardEditor &&
        ['bootstrap', 'search'].includes(command.operation) &&
        latest.current?.scope === response.state.scope &&
        latest.current.selected_id !== response.state.selected_id &&
        !(await flush.current())
      )
        return null;
      if (
        response.state.version >= minimumVersion.current &&
        response.state.version >= (latest.current?.version ?? 0)
      ) {
        latest.current = response.state;
        scope.current = response.state.scope;
        setState(response.state);
      }
      if (response.state.scope !== scope.current) return null;
      if (!['save', 'search', 'bootstrap'].includes(command.operation))
        setError('');
      if (response.notice === 'exported')
        setNotice('Unencrypted export saved.');
      return response.state;
    } catch {
      setError(
        'The desktop connection failed. Your editor text is still here.',
      );
      return null;
    }
  }
  useEffect(() => {
    const offFlush = window.notes.onFlush((nonce) => {
      void flush
        .current()
        .then((saved) => {
          if (saved)
            return window.notes.invoke({ operation: 'closeReady', nonce });
          return undefined;
        })
        .catch(() =>
          setError('Notes could not be saved. The window was kept open.'),
        );
    });
    let refreshing = false;
    let requestedVersion = 0;
    const offChanged = window.notes.onChanged((change) => {
      requestedVersion = Math.max(requestedVersion, change.version);
      if (change.kind === 'revoked' || change.scope !== scope.current) {
        minimumVersion.current = Math.max(
          minimumVersion.current,
          change.version,
        );
        scope.current = change.scope;
        if (change.kind === 'revoked') {
          flush.current = async () => true;
          latest.current = null;
          setState(null);
          setPage('account');
          setError('');
          setNotice(
            'Workspace access changed. The previous workspace is no longer available.',
          );
        }
        void invoke({ operation: 'bootstrap' });
        return;
      }
      if (refreshing) return;
      refreshing = true;
      void (async () => {
        try {
          while (requestedVersion > (latest.current?.version ?? 0)) {
            if (!(await flush.current())) return;
            const result = await invoke({ operation: 'bootstrap' });
            if (!result || result.version < requestedVersion) return;
          }
        } finally {
          refreshing = false;
        }
      })().catch(() =>
        setError(
          'Workspace updates could not be loaded. Your editor text is still here.',
        ),
      );
    });
    void invoke({ operation: 'bootstrap' });
    return () => {
      offFlush();
      offChanged();
    };
  }, []);
  useEffect(() => {
    if (state) setQuery(state.query);
  }, [state?.scope]);
  useEffect(() => {
    if (!state || query === state.query) return;
    const requestedScope = state.scope;
    const timer = setTimeout(() => {
      void flush.current().then((saved) =>
        saved
          ? invoke({
              operation: 'search',
              scope: requestedScope,
              query,
              offset: 0,
            })
          : null,
      );
    }, 150);
    return () => clearTimeout(timer);
  }, [query, state?.query, state?.scope, state?.version]);
  const selected = state?.selected ?? null;
  const documents = state?.documents ?? [];
  async function create() {
    if (!(await flush.current())) return;
    setPage('notes');
    await invoke({ operation: 'create', scope: scope.current });
  }
  async function switchScope(command: DesktopCommand) {
    if (!(await flush.current())) return null;
    setSwitching(true);
    try {
      const result = await invoke(command);
      if (result && command.operation !== 'disconnect') setPage('notes');
      return result;
    } finally {
      setSwitching(false);
    }
  }
  const blocked =
    switching ||
    state?.connection.status === 'disconnecting' ||
    state?.connection.status === 'switching';
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">n</span>
          <div>
            Notes<span className="subtle">A little more clarity</span>
          </div>
        </div>
        <button
          className="primary new-note"
          onClick={() => void create()}
          disabled={!state || blocked}
        >
          + New meeting
        </button>
        <label className="search">
          <span aria-hidden="true">&#x2315;</span>
          <input
            aria-label="Search meetings"
            placeholder="Find a thought..."
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="list-label">
          YOUR MEETINGS{' '}
          <span>
            {documents.length}
            {state?.has_more ? '+' : ''}
          </span>
        </div>
        <nav className="meeting-list" aria-label="Meetings">
          {documents.map((document) => (
            <button
              key={document.id}
              className={`meeting-card ${selected?.id === document.id ? 'selected' : ''}`}
              disabled={blocked}
              onClick={() => {
                void (async () => {
                  if (!(await flush.current())) return;
                  setPage('notes');
                  await invoke({
                    operation: 'select',
                    scope: scope.current,
                    id: document.id,
                  });
                })();
              }}
            >
              <span className="meeting-title">
                {document.title || 'Untitled meeting'}
              </span>
              <span className="meeting-preview">
                {document.preview.slice(0, 64) ||
                  'A clean page for your next conversation'}
              </span>
              <span className="meeting-meta">
                {new Date(document.updated_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
                <span
                  className={`status-dot ${document.status === 'conflict' ? 'attention' : ''}`}
                />
                {labels[document.status]}
              </span>
            </button>
          ))}
        </nav>
        {state && (state.offset > 0 || state.has_more) && (
          <div className="list-pagination">
            <button
              className="quiet-button"
              disabled={blocked || query !== state.query || state.offset === 0}
              onClick={() => {
                void flush.current().then((saved) =>
                  saved
                    ? invoke({
                        operation: 'search',
                        scope: state.scope,
                        query,
                        offset: Math.max(0, state.offset - 50),
                      })
                    : null,
                );
              }}
            >
              Previous meetings
            </button>
            <button
              className="quiet-button"
              disabled={blocked || query !== state.query || !state.has_more}
              onClick={() => {
                void flush.current().then((saved) =>
                  saved
                    ? invoke({
                        operation: 'search',
                        scope: state.scope,
                        query,
                        offset: state.offset + 50,
                      })
                    : null,
                );
              }}
            >
              More meetings
            </button>
          </div>
        )}
        <button
          className="connection-button"
          disabled={!state || blocked}
          onClick={() => {
            void flush.current().then((saved) => {
              if (saved) setPage('account');
            });
          }}
        >
          <span
            className={`status-dot ${state?.connection.error ? 'attention' : ''}`}
          />
          {state?.connection.status === 'syncing'
            ? 'Syncing workspace...'
            : state?.connection.status === 'reauth_required'
              ? 'Sign in again'
              : state?.connection.active_workspace
                ? (state.connection.workspaces.find(
                    (workspace) =>
                      workspace.id === state.connection.active_workspace,
                  )?.name ?? 'Cloud workspace')
                : 'Device only'}
          <span>Account & sync</span>
        </button>
        <button
          className="storage-button"
          disabled={blocked}
          onClick={() => {
            void flush.current().then((saved) => {
              if (saved) setPage('storage');
            });
          }}
        >
          Local data & privacy <span aria-hidden="true">&#x2197;</span>
        </button>
        <div className="preview-label">Developer preview</div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            {page === 'account'
              ? 'ACCOUNT & WORKSPACES'
              : page === 'storage'
                ? 'Your space, your control'
                : 'MEETING WORKSPACE'}
          </span>
          <span className={`privacy-chip ${state ? '' : 'locked'}`}>
            {state ? 'Encrypted on this device' : 'Storage unavailable'}
          </span>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            {state && (
              <button onClick={() => void flush.current()}>Retry save</button>
            )}
            <button
              onClick={() => void invoke({ operation: 'openRecoveryFolder' })}
            >
              Open recovery folder
            </button>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button
              aria-label="Dismiss notification"
              onClick={() => setNotice('')}
            >
              &#xd7;
            </button>
          </div>
        )}
        {state?.connection.error && page !== 'account' && (
          <div className="connection-warning" role="status">
            {state.connection.error.message}
            <button
              className="quiet-button"
              onClick={() => {
                void flush.current().then((saved) => {
                  if (saved) setPage('account');
                });
              }}
            >
              Account details
            </button>
          </div>
        )}
        {page === 'account' && state ? (
          <Account
            state={state}
            invoke={invoke}
            switchScope={switchScope}
            blocked={blocked}
          />
        ) : page === 'storage' ? (
          <section className="privacy-page">
            <span className="eyebrow">LOCAL FIRST</span>
            <h1>
              Room for your thoughts.
              <br />
              Not your worries.
            </h1>
            <div className="privacy-grid">
              <article>
                <span className="tile-icon">01</span>
                <h2>Private by default</h2>
                <p>
                  Notes and saved operations are encrypted before they reach the
                  local database.
                </p>
              </article>
              <article>
                <span className="tile-icon teal">02</span>
                <h2>Yours, even offline</h2>
                <p>
                  Device-only drafts stay here until you explicitly copy them to
                  a connected workspace. Cloud notes remain available offline.
                </p>
              </article>
              <article>
                <span className="tile-icon rose">03</span>
                <h2>Keep your recovery files</h2>
                <p>
                  Your Windows account protects the content key. Moving
                  encrypted files alone is not a backup you can unlock on
                  another PC.
                </p>
                <button
                  className="secondary"
                  onClick={() =>
                    void invoke({ operation: 'openRecoveryFolder' })
                  }
                >
                  Open local data folder
                </button>
              </article>
            </div>
            <p className="quiet-note">
              Exports are unencrypted files. Save them only where you intend to
              share or retain readable notes.
            </p>
          </section>
        ) : selected && state ? (
          <Note
            key={`${state.scope}:${selected.id}`}
            draft={selected}
            state={state}
            flush={flush}
            invoke={invoke}
            setError={setError}
          />
        ) : (
          <section className="empty">
            <div className="empty-orbit">
              <span>n</span>
            </div>
            <span className="eyebrow">LESS TO MANAGE. MORE TO REMEMBER.</span>
            <h1>
              Make room for
              <br />
              your next great thought.
            </h1>
            <p>
              Start with a clean page. Your notes save privately,
              <br />
              even when the rest of the world is offline.
            </p>
            <button
              className="primary"
              onClick={() => void create()}
              disabled={!state || blocked}
            >
              Create your first meeting <span aria-hidden="true">&#x2192;</span>
            </button>
          </section>
        )}
      </main>
    </div>
  );
}

type Invoke = (
  command: DesktopCommand,
  discardEditor?: boolean,
) => Promise<DesktopState | null>;
function Note({
  draft,
  state,
  flush,
  invoke,
  setError,
}: {
  draft: Draft;
  state: DesktopState;
  flush: React.RefObject<() => Promise<boolean>>;
  invoke: Invoke;
  setError: (message: string) => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [tagText, setTagText] = useState(draft.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const current = useRef(draft);
  const value = useRef<EditableDraft>({
    title: draft.title,
    content: draft.content,
    tags: draft.tags,
  });
  const pending = useRef(false);
  const running = useRef<Promise<boolean> | null>(null);
  const invalid = useRef(new Set<'content' | 'tags'>());
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: false })],
    content: draft.content,
    injectCSS: false,
    editorProps: {
      attributes: {
        'aria-label': 'Meeting notes',
        role: 'textbox',
        'aria-multiline': 'true',
      },
    },
    onUpdate: ({ editor }) => {
      const parsed = richTextSchema.safeParse(editor.getJSON());
      if (!parsed.success) {
        invalid.current.add('content');
        pending.current = true;
        setUnsaved(true);
        setError(
          'These notes exceed the supported format or size. Undo or shorten them before closing; this text has not been saved.',
        );
        return;
      }
      invalid.current.delete('content');
      value.current = { ...value.current, content: parsed.data };
      pending.current = true;
      setUnsaved(true);
      void save();
    },
  });
  async function save(): Promise<boolean> {
    if (running.current) return running.current;
    const operation = (async () => {
      setSaving(true);
      try {
        while (pending.current) {
          if (invalid.current.size) return false;
          setError('');
          pending.current = false;
          const snapshot = value.current;
          const result = await invoke({
            operation: 'save',
            scope: state.scope,
            id: draft.id,
            local_revision: current.current.local_revision,
            value: snapshot,
          });
          if (!result) {
            pending.current = true;
            return false;
          }
          const updated =
            result.selected?.id === draft.id ? result.selected : null;
          if (!updated) {
            pending.current = true;
            setError(
              'This draft is no longer available. Keep the editor open to preserve your text.',
            );
            return false;
          }
          current.current = updated;
        }
        return true;
      } finally {
        setUnsaved(pending.current || invalid.current.size > 0);
      }
    })();
    running.current = operation;
    try {
      return await operation;
    } finally {
      running.current = null;
      setSaving(false);
    }
  }
  useEffect(() => {
    flush.current = save;
    return () => {
      flush.current = async () => true;
    };
  }, []);
  useEffect(() => {
    if (
      !editor ||
      pending.current ||
      running.current ||
      draft.local_revision === current.current.local_revision
    )
      return;
    loadDraft(draft);
  }, [draft.local_revision, editor, saving]);
  function loadDraft(updated: Draft) {
    current.current = updated;
    value.current = {
      title: updated.title,
      content: updated.content,
      tags: updated.tags,
    };
    pending.current = false;
    invalid.current.clear();
    setTitle(updated.title);
    setTagText(updated.tags.join(', '));
    editor?.commands.setContent(updated.content, { emitUpdate: false });
    setUnsaved(false);
    setConfirmDiscard(false);
    setError('');
  }
  function changeTitle(text: string) {
    setTitle(text);
    value.current = { ...value.current, title: text };
    pending.current = true;
    setUnsaved(true);
    void save();
  }
  function changeTags(text: string) {
    setTagText(text);
    const tags = text
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    const parsed = tagsSchema.safeParse(tags);
    if (!parsed.success) {
      invalid.current.add('tags');
      pending.current = true;
      setUnsaved(true);
      setError(
        'Use up to 16 unique tags, with at most 40 characters each and no control characters.',
      );
      return;
    }
    invalid.current.delete('tags');
    value.current = { ...value.current, tags: parsed.data };
    pending.current = true;
    setUnsaved(true);
    void save();
  }
  const format = (name: string, active: boolean, action: () => void) => (
    <button
      className={active ? 'active' : ''}
      aria-label={name}
      aria-pressed={active}
      onClick={action}
    >
      {name}
    </button>
  );
  return (
    <section className="note-page">
      <div className="document-actions">
        <span className="eyebrow" role="status">
          {saving ? 'SAVING...' : unsaved ? 'NOT SAVED' : 'SAVED LOCALLY'}
        </span>
        <div>
          <button
            className="secondary"
            onClick={() => {
              void save().then((saved) => {
                if (saved)
                  return invoke({
                    operation: 'export',
                    scope: state.scope,
                    id: draft.id,
                    format: 'markdown',
                  });
                return null;
              });
            }}
          >
            Export Markdown
          </button>
          <button
            className="quiet-button"
            onClick={() => {
              void save().then((saved) => {
                if (saved)
                  return invoke({
                    operation: 'export',
                    scope: state.scope,
                    id: draft.id,
                    format: 'text',
                  });
                return null;
              });
            }}
          >
            Plain text
          </button>
          <button
            className="quiet-button danger"
            onClick={() => setConfirmDelete(!confirmDelete)}
          >
            Delete
          </button>
        </div>
      </div>
      {confirmDelete && (
        <div className="delete-confirm">
          <div>
            <strong>Delete this meeting?</strong>
            <p>
              {state.connection.active_workspace
                ? 'Deletion will sync to the cloud. Other devices will remove their cached copy.'
                : 'This removes the saved notes from this device.'}
            </p>
          </div>
          <button className="secondary" onClick={() => setConfirmDelete(false)}>
            Keep notes
          </button>
          <button
            className="danger-button"
            onClick={() => {
              void save().then((saved) => {
                if (saved)
                  return invoke({
                    operation: 'delete',
                    scope: state.scope,
                    id: draft.id,
                    confirmed: true,
                  });
                return null;
              });
            }}
          >
            Delete meeting
          </button>
        </div>
      )}
      {unsaved && !saving && (
        <div className="recovery-panel" role="status">
          <strong>Your editor has unsaved changes.</strong>
          <p>
            If the saved version changed, keep this text as a new meeting or
            deliberately reload the saved version.
          </p>
          <div className="inline-actions">
            <button
              className="secondary"
              disabled={invalid.current.size > 0}
              onClick={() => {
                void invoke({
                  operation: 'create',
                  scope: state.scope,
                  value: value.current,
                });
              }}
            >
              Save editor as a new copy
            </button>
            <button
              className="quiet-button"
              onClick={() => setConfirmDiscard(true)}
            >
              Reload saved version
            </button>
          </div>
          {confirmDiscard && (
            <div className="inline-actions">
              <span>This discards the unsaved editor text.</span>
              <button
                className="secondary"
                onClick={() => setConfirmDiscard(false)}
              >
                Keep editing
              </button>
              <button
                className="danger-button"
                onClick={() => {
                  void invoke({ operation: 'bootstrap' }, true).then(
                    (result) => {
                      const updated =
                        result?.selected?.id === draft.id
                          ? result.selected
                          : null;
                      if (updated) loadDraft(updated);
                    },
                  );
                }}
              >
                Discard editor changes
              </button>
            </div>
          )}
        </div>
      )}
      <NoteExtras
        state={state}
        draft={draft}
        resolve={async (choice) => {
          if (await save())
            await invoke({
              operation: 'resolve',
              scope: state.scope,
              id: draft.id,
              choice,
            });
        }}
      />
      <input
        className="title-input"
        aria-label="Meeting title"
        placeholder="Untitled meeting"
        maxLength={200}
        value={title}
        onChange={(event) => changeTitle(event.target.value)}
      />
      <div className="note-caption">
        {new Date(draft.created_at).toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        })}
        <span>&#x2022;</span>
        <input
          aria-label="Meeting tags"
          placeholder="Add tags, separated by commas"
          value={tagText}
          onChange={(event) => changeTags(event.target.value)}
        />
      </div>
      <div
        className="editor-toolbar"
        role="toolbar"
        aria-label="Text formatting"
      >
        {format('Bold', editor?.isActive('bold') ?? false, () => {
          editor?.chain().focus().toggleBold().run();
        })}
        {format('Italic', editor?.isActive('italic') ?? false, () => {
          editor?.chain().focus().toggleItalic().run();
        })}
        {format('Heading', editor?.isActive('heading') ?? false, () => {
          editor?.chain().focus().toggleHeading({ level: 2 }).run();
        })}
        {format('Bullet list', editor?.isActive('bulletList') ?? false, () => {
          editor?.chain().focus().toggleBulletList().run();
        })}
        {format('Quote', editor?.isActive('blockquote') ?? false, () => {
          editor?.chain().focus().toggleBlockquote().run();
        })}
      </div>
      <EditorContent editor={editor} className="editor" />
      <footer className="editor-footer">
        <span>
          {
            richTextToPlainText(value.current.content)
              .trim()
              .split(/\s+/u)
              .filter(Boolean).length
          }{' '}
          words
        </span>
        <span>
          Exports are unencrypted.{' '}
          {state.connection.active_workspace
            ? labels[draft.status]
            : 'Device-only draft.'}
        </span>
      </footer>
    </section>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('The application root is missing.');
createRoot(root).render(<App />);
