import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  documentSchema,
  createDocumentSchema,
  updateNotesSchema,
  updateDocumentSchema,
  resourceId,
} from '@windows-ai-notes/contracts/server';
import {
  richTextFromPlainText,
  canonicalJson,
} from '@windows-ai-notes/contracts/content';
import {
  editableSchema,
  draftSchema,
  type Draft,
  type EditableDraft,
} from '@windows-ai-notes/contracts/desktop';

export class LocalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
type Editable = EditableDraft;
type Remote = z.infer<typeof documentSchema>;
const payloadSchema = editableSchema.extend({
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  server: documentSchema.nullable(),
  conflict: documentSchema.nullable(),
  recovery: z.enum(['deleted_remotely']).nullable(),
});
type Payload = z.infer<typeof payloadSchema>;
const rowSchema = z.strictObject({
  profile: z.string(),
  id: resourceId,
  revision: z.number().int().positive(),
  remote_revision: z.number().int().nonnegative(),
  dirty: z.union([z.literal(0), z.literal(1)]),
  conflict: z.union([z.literal(0), z.literal(1)]),
  deleted: z.union([z.literal(0), z.literal(1)]),
  updated_at: z.string(),
  payload: z.instanceof(Uint8Array),
});
type Row = z.infer<typeof rowSchema>;
const mutationFields = {
  id: resourceId,
  document_id: resourceId,
  captured_revision: z.number().int().positive(),
};
export const mutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...mutationFields,
    kind: z.literal('create'),
    body: createDocumentSchema,
  }),
  z.strictObject({
    ...mutationFields,
    kind: z.literal('notes'),
    body: updateNotesSchema,
  }),
  z.strictObject({
    ...mutationFields,
    kind: z.literal('metadata'),
    body: updateDocumentSchema,
  }),
  z.strictObject({
    ...mutationFields,
    kind: z.literal('delete'),
    body: z.null(),
  }),
]);
export type Mutation = z.infer<typeof mutationSchema>;

function editable(remote: Remote): Editable {
  return {
    title: remote.title,
    content: remote.content ?? richTextFromPlainText(remote.notes),
    tags: remote.tags,
  };
}
function pickEditable(value: Editable): Editable {
  return { title: value.title, content: value.content, tags: value.tags };
}
function equivalent(local: Editable, remote: Remote): boolean {
  return (
    canonicalJson({
      ...pickEditable(local),
      title: local.title.trim() || 'Untitled meeting',
    }) === canonicalJson(editable(remote))
  );
}
function aad(...parts: (string | number)[]) {
  return canonicalJson(['windows-ai-notes-local', 1, ...parts]);
}
function context(row: Omit<Row, 'payload'>) {
  return aad(
    'draft',
    row.profile,
    row.id,
    row.revision,
    row.remote_revision,
    row.dirty,
    row.conflict,
    row.deleted,
    row.updated_at,
  );
}

export class LocalStore {
  private readonly database: DatabaseSync;
  private readonly key: Buffer;
  constructor(path: string, key: Buffer) {
    if (key.length !== 32)
      throw new LocalError(
        'invalid_local_key',
        'The local encryption key is invalid.',
      );
    this.key = Buffer.from(key);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      const inspect = new DatabaseSync(path, { readOnly: true });
      try {
        const tables = inspect
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();
        if (tables.length) {
          if (
            !['vault', 'drafts', 'outbox'].every((name) =>
              tables.some((row) => row.name === name),
            )
          )
            throw new LocalError(
              'local_data_corrupt',
              'The local database structure is incomplete. Existing files were preserved.',
            );
          const verifier = inspect
            .prepare(
              "SELECT payload FROM vault WHERE profile='root' AND id='key-check'",
            )
            .get();
          if (!verifier)
            throw new LocalError(
              'local_key_missing',
              'Existing local data has no key verifier. It was not reset.',
            );
          this.open(
            z.literal('windows-ai-notes-local-v1'),
            z.instanceof(Uint8Array).parse(verifier.payload),
            aad('vault', 'root', 'key-check'),
          );
          const version = inspect.prepare('PRAGMA user_version').get();
          if (version?.user_version !== 1)
            throw new LocalError(
              'local_version_unsupported',
              'This local database needs a compatible application version.',
            );
        }
      } catch (error) {
        this.key.fill(0);
        throw error instanceof LocalError
          ? error
          : new LocalError(
              'local_data_corrupt',
              'Local data could not be verified. Existing files were preserved.',
            );
      } finally {
        inspect.close();
      }
    }
    this.database = new DatabaseSync(path);
    this.database.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
    );
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS vault (profile TEXT NOT NULL,id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(profile,id));
        CREATE TABLE IF NOT EXISTS drafts (
          profile TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,remote_revision INTEGER NOT NULL,
          dirty INTEGER NOT NULL,conflict INTEGER NOT NULL,deleted INTEGER NOT NULL,
          updated_at TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(profile,id)
        );
        CREATE TABLE IF NOT EXISTS outbox (
          profile TEXT NOT NULL,document_id TEXT NOT NULL,id TEXT NOT NULL,payload BLOB NOT NULL,
          PRIMARY KEY(profile,document_id),UNIQUE(profile,id),
          FOREIGN KEY(profile,document_id) REFERENCES drafts(profile,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS drafts_pending ON drafts(profile,dirty,conflict);
        PRAGMA user_version=1;
      `);
      if (
        !this.database
          .prepare(
            "SELECT 1 FROM vault WHERE profile='root' AND id='key-check'",
          )
          .get()
      )
        this.putValue('root', 'key-check', 'windows-ai-notes-local-v1');
    });
  }
  close() {
    this.database.close();
    this.key.fill(0);
  }
  private seal(value: unknown, aad: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(aad));
    const text = Buffer.from(JSON.stringify(value));
    try {
      return Buffer.concat([
        Buffer.from([1]),
        nonce,
        cipher.update(text),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    } finally {
      text.fill(0);
    }
  }
  private open<T>(schema: z.ZodType<T>, encrypted: Uint8Array, aad: string): T {
    try {
      const bytes = Buffer.from(encrypted);
      if (bytes.length < 30 || bytes[0] !== 1)
        throw new Error('Invalid envelope.');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        bytes.subarray(1, 13),
      );
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(bytes.subarray(-16));
      const clear = Buffer.concat([
        decipher.update(bytes.subarray(13, -16)),
        decipher.final(),
      ]);
      try {
        return schema.parse(JSON.parse(clear.toString('utf8')) as unknown);
      } finally {
        clear.fill(0);
      }
    } catch {
      throw new LocalError(
        'local_data_corrupt',
        'Local data could not be unlocked or verified. It was not reset.',
      );
    }
  }
  private transaction<T>(run: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  getValue<T>(profile: string, id: string, schema: z.ZodType<T>): T | null {
    const row = this.database
      .prepare('SELECT payload FROM vault WHERE profile=? AND id=?')
      .get(profile, id);
    return row
      ? this.open(
          schema,
          z.instanceof(Uint8Array).parse(row.payload),
          aad('vault', profile, id),
        )
      : null;
  }
  putValue(profile: string, id: string, value: unknown): void {
    this.database
      .prepare(
        'INSERT INTO vault VALUES (?,?,?) ON CONFLICT(profile,id) DO UPDATE SET payload=excluded.payload',
      )
      .run(profile, id, this.seal(value, aad('vault', profile, id)));
  }
  deleteValue(profile: string, id: string): void {
    this.database
      .prepare('DELETE FROM vault WHERE profile=? AND id=?')
      .run(profile, id);
  }
  private row(profile: string, id: string): Row | null {
    const value = this.database
      .prepare('SELECT * FROM drafts WHERE profile=? AND id=?')
      .get(profile, id);
    return value ? rowSchema.parse(value) : null;
  }
  private payload(row: Row): Payload {
    return this.open(payloadSchema, row.payload, context(row));
  }
  private write(row: Omit<Row, 'payload'>, value: Payload): void {
    this.database
      .prepare(
        `INSERT INTO drafts VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(profile,id) DO UPDATE SET revision=excluded.revision,remote_revision=excluded.remote_revision,
      dirty=excluded.dirty,conflict=excluded.conflict,deleted=excluded.deleted,updated_at=excluded.updated_at,payload=excluded.payload`,
      )
      .run(
        row.profile,
        row.id,
        row.revision,
        row.remote_revision,
        row.dirty,
        row.conflict,
        row.deleted,
        row.updated_at,
        this.seal(value, context(row)),
      );
  }
  private public(row: Row, value = this.payload(row)): Draft {
    return draftSchema.parse({
      ...pickEditable(value),
      id: row.id,
      local_revision: row.revision,
      remote_revision: row.remote_revision,
      status: value.recovery
        ? 'deleted_remote'
        : row.conflict
          ? 'conflict'
          : row.dirty
            ? row.remote_revision
              ? 'pending'
              : 'local'
            : 'synced',
      created_at: value.created_at,
      updated_at: value.updated_at,
    });
  }
  list(profile: string): Draft[] {
    return this.database
      .prepare(
        'SELECT * FROM drafts WHERE profile=? AND deleted=0 ORDER BY updated_at DESC,id',
      )
      .all(profile)
      .map((row) => this.public(rowSchema.parse(row)));
  }
  get(profile: string, id: string): Draft {
    const row = this.row(profile, id);
    if (!row || row.deleted)
      throw new LocalError(
        'local_document_missing',
        'This local document is unavailable.',
      );
    return this.public(row);
  }
  create(
    profile: string,
    value: Editable = {
      title: 'Untitled meeting',
      content: richTextFromPlainText(''),
      tags: [],
    },
  ): Draft {
    const checked = editableSchema.parse(value);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.write(
      {
        profile,
        id,
        revision: 1,
        remote_revision: 0,
        dirty: 1,
        conflict: 0,
        deleted: 0,
        updated_at: now,
      },
      {
        ...checked,
        created_at: now,
        updated_at: now,
        server: null,
        conflict: null,
        recovery: null,
      },
    );
    return this.get(profile, id);
  }
  save(profile: string, id: string, revision: number, input: Editable): Draft {
    const checked = editableSchema.parse(input);
    return this.transaction(() => {
      const row = this.row(profile, id);
      if (!row || row.deleted)
        throw new LocalError(
          'local_document_missing',
          'This local document is unavailable.',
        );
      if (row.revision !== revision)
        throw new LocalError(
          'local_revision_conflict',
          'This draft changed. Keep your edits and reload the saved version.',
        );
      const old = this.payload(row);
      if (canonicalJson(checked) === canonicalJson(pickEditable(old)))
        return this.public(row, old);
      const value = {
        ...old,
        ...checked,
        updated_at: new Date().toISOString(),
      };
      const queued = this.database
        .prepare('SELECT 1 FROM outbox WHERE profile=? AND document_id=?')
        .get(profile, id);
      this.write(
        {
          ...row,
          revision: row.revision + 1,
          dirty: !queued && old.server && equivalent(value, old.server) ? 0 : 1,
          updated_at: value.updated_at,
        },
        value,
      );
      return this.get(profile, id);
    });
  }
  remove(profile: string, id: string): void {
    this.transaction(() => {
      const row = this.row(profile, id);
      if (!row) return;
      const queued = this.database
        .prepare('SELECT 1 FROM outbox WHERE profile=? AND document_id=?')
        .get(profile, id);
      if (!row.remote_revision && !queued)
        this.database
          .prepare('DELETE FROM drafts WHERE profile=? AND id=?')
          .run(profile, id);
      else
        this.write(
          { ...row, revision: row.revision + 1, deleted: 1, dirty: 1 },
          this.payload(row),
        );
    });
  }
  bindOffline(profile: string): void {
    if (profile === 'offline') return;
    this.transaction(() => {
      const rows = this.database
        .prepare("SELECT * FROM drafts WHERE profile='offline'")
        .all()
        .map((row) => rowSchema.parse(row));
      for (const row of rows) {
        if (this.row(profile, row.id))
          throw new LocalError(
            'local_profile_collision',
            'A draft identifier already exists in this account. Both copies were preserved.',
          );
        const value = this.payload(row);
        this.write({ ...row, profile }, value);
      }
      this.database.prepare("DELETE FROM drafts WHERE profile='offline'").run();
    });
  }
  nextMutation(profile: string, workspace: string): Mutation | null {
    if (profile === 'offline')
      throw new LocalError(
        'not_connected',
        'Connect an account before synchronizing drafts.',
      );
    return this.transaction(() => {
      const queued = this.database
        .prepare(
          `SELECT o.* FROM outbox o JOIN drafts d ON d.profile=o.profile AND d.id=o.document_id
          WHERE o.profile=? AND d.conflict=0 ORDER BY o.rowid LIMIT 1`,
        )
        .get(profile);
      if (queued)
        return this.open(
          mutationSchema,
          z.instanceof(Uint8Array).parse(queued.payload),
          aad('outbox', profile, String(queued.document_id), String(queued.id)),
        );
      const rows = this.database
        .prepare(
          'SELECT * FROM drafts WHERE profile=? AND dirty=1 AND conflict=0 ORDER BY updated_at,id',
        )
        .all(profile);
      for (const raw of rows) {
        const row = rowSchema.parse(raw);
        const value = this.payload(row);
        if (value.recovery) continue;
        const common = {
          id: randomUUID(),
          document_id: row.id,
          captured_revision: row.revision,
        };
        let mutation: Mutation;
        const title = value.title.trim() || 'Untitled meeting';
        if (row.deleted)
          mutation = mutationSchema.parse({
            ...common,
            kind: 'delete',
            body: null,
          });
        else if (!value.server)
          mutation = mutationSchema.parse({
            ...common,
            kind: 'create',
            body: {
              id: row.id,
              workspace_id: workspace,
              title,
              content: value.content,
              tags: value.tags,
            },
          });
        else if (
          title !== value.server.title ||
          canonicalJson(value.tags) !== canonicalJson(value.server.tags)
        )
          mutation = mutationSchema.parse({
            ...common,
            kind: 'metadata',
            body: {
              base_revision: row.remote_revision,
              title,
              tags: value.tags,
            },
          });
        else if (!equivalent(value, value.server))
          mutation = mutationSchema.parse({
            ...common,
            kind: 'notes',
            body: {
              base_revision: row.remote_revision,
              content: value.content,
            },
          });
        else {
          this.write({ ...row, dirty: 0 }, value);
          continue;
        }
        this.database
          .prepare('INSERT INTO outbox VALUES (?,?,?,?)')
          .run(
            profile,
            row.id,
            mutation.id,
            this.seal(mutation, aad('outbox', profile, row.id, mutation.id)),
          );
        return mutation;
      }
      return null;
    });
  }
  acknowledge(
    profile: string,
    mutation: Mutation,
    remote: Remote | null,
  ): void {
    this.transaction(() => {
      const frozen = this.database
        .prepare('SELECT id FROM outbox WHERE profile=? AND document_id=?')
        .get(profile, mutation.document_id);
      if (!frozen || frozen.id !== mutation.id)
        throw new LocalError(
          'local_mutation_mismatch',
          'The saved operation does not match its acknowledgement.',
        );
      const row = this.row(profile, mutation.document_id)!;
      const value = this.payload(row);
      if (mutation.kind === 'delete') {
        this.database
          .prepare('DELETE FROM drafts WHERE profile=? AND id=?')
          .run(profile, row.id);
        return;
      }
      if (!remote || remote.id !== row.id)
        throw new LocalError(
          'invalid_server_response',
          'The server returned a different document.',
        );
      const checked = documentSchema.parse(remote);
      const expected =
        mutation.kind === 'create' ? 1 : mutation.body.base_revision + 1;
      const applied = checked.applied_revision ?? expected;
      if (
        applied !== expected ||
        checked.revision < applied ||
        (mutation.kind === 'create' &&
          checked.workspace_id !== mutation.body.workspace_id) ||
        (value.server &&
          (value.server.owner_id !== checked.owner_id ||
            value.server.workspace_id !== checked.workspace_id))
      )
        throw new LocalError(
          'invalid_server_response',
          'The server acknowledgement does not match this operation.',
        );
      this.database
        .prepare('DELETE FROM outbox WHERE profile=? AND document_id=?')
        .run(profile, row.id);
      const conflict = checked.revision !== applied;
      this.write(
        {
          ...row,
          remote_revision: checked.revision,
          dirty: row.deleted || !equivalent(value, checked) ? 1 : 0,
          conflict: conflict ? 1 : 0,
        },
        { ...value, server: checked, conflict: conflict ? checked : null },
      );
    });
  }
  applyRemote(profile: string, input: Remote): void {
    const remote = documentSchema.parse(input);
    this.transaction(() => {
      const row = this.row(profile, remote.id);
      if (row) {
        const value = this.payload(row);
        if (remote.revision < row.remote_revision) return;
        if (remote.revision === row.remote_revision) {
          if (
            value.server &&
            remote.transcript_revision >= value.server.transcript_revision
          )
            this.write(row, { ...value, server: remote });
          return;
        }
        if (row.dirty) {
          this.write({ ...row, conflict: 1 }, { ...value, conflict: remote });
          return;
        }
        this.write(
          {
            ...row,
            remote_revision: remote.revision,
            revision: row.revision + 1,
            dirty: 0,
            updated_at: remote.updated_at,
          },
          {
            ...editable(remote),
            server: remote,
            conflict: null,
            recovery: null,
            created_at: remote.created_at,
            updated_at: remote.updated_at,
          },
        );
      } else
        this.write(
          {
            profile,
            id: remote.id,
            revision: 1,
            remote_revision: remote.revision,
            dirty: 0,
            conflict: 0,
            deleted: 0,
            updated_at: remote.updated_at,
          },
          {
            ...editable(remote),
            server: remote,
            conflict: null,
            recovery: null,
            created_at: remote.created_at,
            updated_at: remote.updated_at,
          },
        );
    });
  }
  remoteDeleted(profile: string, id: string): void {
    this.transaction(() => {
      const row = this.row(profile, id);
      if (!row) return;
      const value = this.payload(row);
      this.database
        .prepare('DELETE FROM outbox WHERE profile=? AND document_id=?')
        .run(profile, id);
      if (!row.dirty || row.deleted)
        this.database
          .prepare('DELETE FROM drafts WHERE profile=? AND id=?')
          .run(profile, id);
      else
        this.write(
          { ...row, remote_revision: 0, conflict: 1 },
          {
            ...value,
            server: null,
            conflict: null,
            recovery: 'deleted_remotely',
          },
        );
    });
  }
  resolve(
    profile: string,
    id: string,
    choice: 'local' | 'remote' | 'copy',
  ): Draft | null {
    return this.transaction(() => {
      const row = this.row(profile, id);
      if (!row || !row.conflict)
        throw new LocalError(
          'local_conflict_missing',
          'There is no conflict to resolve.',
        );
      const value = this.payload(row);
      this.database
        .prepare('DELETE FROM outbox WHERE profile=? AND document_id=?')
        .run(profile, id);
      if (value.recovery) {
        if (choice === 'local')
          throw new LocalError(
            'deleted_document',
            'A deleted document can only be kept as a new copy.',
          );
        const copy =
          choice === 'copy' ? this.create(profile, pickEditable(value)) : null;
        this.database
          .prepare('DELETE FROM drafts WHERE profile=? AND id=?')
          .run(profile, id);
        return copy;
      }
      if (!value.conflict)
        throw new LocalError(
          'invalid_local_conflict',
          'The saved conflict is incomplete.',
        );
      const remote = value.conflict;
      if (choice === 'copy') {
        const copy = this.create(profile, pickEditable(value));
        this.write(
          {
            ...row,
            remote_revision: remote.revision,
            revision: row.revision + 1,
            conflict: 0,
            dirty: 0,
            deleted: 0,
            updated_at: remote.updated_at,
          },
          {
            ...editable(remote),
            server: remote,
            conflict: null,
            recovery: null,
            created_at: remote.created_at,
            updated_at: remote.updated_at,
          },
        );
        return copy;
      }
      const next =
        choice === 'remote' ? { ...value, ...editable(remote) } : value;
      this.write(
        {
          ...row,
          remote_revision: remote.revision,
          revision: row.revision + 1,
          conflict: 0,
          deleted: choice === 'remote' ? 0 : row.deleted,
          dirty:
            (choice === 'local' && row.deleted) || !equivalent(next, remote)
              ? 1
              : 0,
        },
        { ...next, server: remote, conflict: null },
      );
      return this.get(profile, id);
    });
  }
  purgeProfile(profile: string): void {
    this.transaction(() => {
      this.database.prepare('DELETE FROM drafts WHERE profile=?').run(profile);
      this.database.prepare('DELETE FROM vault WHERE profile=?').run(profile);
    });
  }
}
