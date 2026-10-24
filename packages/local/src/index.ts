import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  documentSchema,
  createDocumentSchema,
  updateNotesSchema,
  updateDocumentSchema,
  resourceId,
  syncSnapshotSchema,
} from '@windows-ai-notes/contracts/server';
import {
  richTextFromPlainText,
  richTextToPlainText,
  canonicalJson,
} from '@windows-ai-notes/contracts/content';
import {
  editableSchema,
  draftSchema,
  type Draft,
  type EditableDraft,
  type DraftSummary,
} from '@windows-ai-notes/contracts/desktop';
import {
  localAudioQuotaGiBSchema,
  type Track,
} from '@windows-ai-notes/contracts';
import {
  localRecordingSchema,
  recordingOwnerSchema,
  type LocalRecording,
  type RecordingOwner,
  recordingUploadIntentSchema,
  type RecordingUploadIntent,
  recordingUploadStatusSchema,
  type RecordingUploadStatus,
  localAudioRetentionSchema,
  localAudioRetentionDaysSchema,
  type LocalAudioRetention,
} from '@windows-ai-notes/contracts/recording';
import { recordingRetentionSchema } from '@windows-ai-notes/contracts/uploads';

const retentionProofSchema = localAudioRetentionSchema.extend({
  service_url: z.url().max(2048),
  server_days: localAudioRetentionDaysSchema,
  seal_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
type RetentionProof = z.infer<typeof retentionProofSchema>;
const DAY = 86_400_000;

type VerifiedRecording = RecordingUploadIntent & {
  plan: NonNullable<RecordingUploadIntent['plan']>;
};
function verifiedRecording(
  intent: RecordingUploadIntent | null,
): intent is VerifiedRecording {
  return Boolean(
    intent?.plan &&
    ['complete', 'delete_pending', 'deleting'].includes(intent.state) &&
    intent.total_chunks === intent.plan.chunks.length &&
    intent.verified_chunks === intent.total_chunks &&
    intent.verified_bytes ===
      intent.plan.chunks.reduce((sum, chunk) => sum + chunk.size_bytes, 0),
  );
}
function sealHash(intent: VerifiedRecording) {
  return createHash('sha256')
    .update(canonicalJson(intent.plan.seal))
    .digest('hex');
}

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
const headerSchema = rowSchema.omit({ payload: true });
const bootstrapSchema = z.strictObject({
  cursor: syncSnapshotSchema.shape.cursor.nullable(),
  after: resourceId.nullable(),
});
const checkpointSchema = z.strictObject({
  cursor: syncSnapshotSchema.shape.cursor.nullable(),
  bootstrap: bootstrapSchema.nullable(),
});
const cacheVersionSchema = z.strictObject({
  changes: z.number().int().nonnegative(),
  version: z.number().int().positive(),
});
export type SyncCheckpoint = z.infer<typeof checkpointSchema>;
export interface RemoteUpdate {
  id: string;
  document: Remote | null;
  artifacts: { id: string; value: unknown }[];
}
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
  private transactionDepth = 0;
  private readonly summaries = new Map<
    string,
    { profile: string; fingerprint: string; value: DraftSummary }
  >();
  private search: {
    profile: string;
    query: string;
    matches: Map<string, { fingerprint: string; value: boolean }>;
  } | null = null;
  constructor(path: string, key: Buffer) {
    if (key.length !== 32)
      throw new LocalError(
        'invalid_local_key',
        'The local encryption key is invalid.',
      );
    this.key = Buffer.from(key);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      let inspect: DatabaseSync | undefined;
      try {
        inspect = new DatabaseSync(path, { readOnly: true });
        const tables = inspect
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();
        if (tables.length) {
          const version = inspect
            .prepare('PRAGMA user_version')
            .get()?.user_version;
          if (
            version !== 1 &&
            version !== 2 &&
            version !== 3 &&
            version !== 4 &&
            version !== 5 &&
            version !== 6 &&
            version !== 7 &&
            version !== 8
          )
            throw new LocalError(
              'local_version_unsupported',
              'This local database needs a compatible application version.',
            );
          if (
            ![
              'vault',
              'drafts',
              'outbox',
              ...(version !== 1 ? ['snapshot_candidates'] : []),
              ...(version === 4 ||
              version === 5 ||
              version === 6 ||
              version === 7 ||
              version === 8
                ? ['recording_uploads']
                : []),
              ...(version === 7 || version === 8
                ? ['recording_retention']
                : []),
            ].every((name) => tables.some((row) => row.name === name))
          )
            throw new LocalError(
              'local_data_corrupt',
              'The local database structure is incomplete. Existing files were preserved.',
            );
          const verifier = inspect
            .prepare(
              `SELECT payload FROM vault WHERE profile='root' AND id='key-check'${version !== 1 ? ' AND document_id IS NULL' : ''}`,
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
            version === 1
              ? aad('vault', 'root', 'key-check')
              : aad('vault2', 'root', 'key-check', ''),
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
        inspect?.close();
      }
    }
    let opened: DatabaseSync | undefined;
    try {
      this.database = opened = new DatabaseSync(path);
      this.database.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
      );
      this.transaction(() => {
        const version = this.database
          .prepare('PRAGMA user_version')
          .get()?.user_version;
        this.database.exec(`
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
        CREATE INDEX IF NOT EXISTS drafts_list ON drafts(profile,deleted,updated_at DESC,id);
        CREATE TABLE IF NOT EXISTS snapshot_candidates (
          profile TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(profile,id),
          FOREIGN KEY(profile,id) REFERENCES drafts(profile,id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS recording_uploads (
          profile TEXT NOT NULL,recording_id TEXT NOT NULL,document_id TEXT NOT NULL,
          state TEXT NOT NULL,retry_at INTEGER NOT NULL,payload BLOB NOT NULL,status_payload BLOB NOT NULL,
          local_retired INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(profile,recording_id),
          FOREIGN KEY(profile,document_id) REFERENCES drafts(profile,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS recording_uploads_pending ON recording_uploads(profile,state,retry_at);
        CREATE TABLE IF NOT EXISTS recording_retention (
          profile TEXT NOT NULL,recording_id TEXT NOT NULL,document_id TEXT NOT NULL,
          delete_after INTEGER NOT NULL,payload BLOB NOT NULL,
          PRIMARY KEY(profile,recording_id),
          FOREIGN KEY(profile,document_id) REFERENCES drafts(profile,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS recording_retention_due ON recording_retention(delete_after);
      `);
        if (
          !this.database
            .prepare('PRAGMA table_info(recording_uploads)')
            .all()
            .some((column) => column.name === 'local_retired')
        ) {
          if (version === 8)
            throw new LocalError(
              'local_data_corrupt',
              'The local upload structure is incomplete. Existing files were preserved.',
            );
          this.database.exec(
            'ALTER TABLE recording_uploads ADD COLUMN local_retired INTEGER NOT NULL DEFAULT 0',
          );
        }
        this.database
          .exec(`CREATE INDEX IF NOT EXISTS recording_uploads_retention
          ON recording_uploads(profile,local_retired,recording_id)`);
        if (version === 1) {
          const values = this.database
            .prepare('SELECT profile,id,payload FROM vault')
            .all();
          this.database.exec('ALTER TABLE vault RENAME TO vault_v1');
          this.createVault();
          for (const row of values) {
            const profile = z.string().parse(row.profile);
            const id = z.string().parse(row.id);
            const value = this.open(
              z.unknown(),
              z.instanceof(Uint8Array).parse(row.payload),
              aad('vault', profile, id),
            );
            this.putValue(profile, id, value);
          }
          this.database.exec('DROP TABLE vault_v1');
        } else this.createVault();
        if (
          !this.database
            .prepare(
              "SELECT 1 FROM vault WHERE profile='root' AND id='key-check'",
            )
            .get()
        )
          this.putValue('root', 'key-check', 'windows-ai-notes-local-v1');
        this.database.exec('PRAGMA user_version=8');
      });
    } catch (error) {
      try {
        opened?.close();
      } finally {
        this.key.fill(0);
      }
      throw error instanceof LocalError
        ? error
        : new LocalError(
            'local_storage_unavailable',
            'The local database could not be opened or upgraded. Existing files were preserved.',
          );
    }
  }
  private createVault() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS vault (
        profile TEXT NOT NULL,id TEXT NOT NULL,document_id TEXT,payload BLOB NOT NULL,
        PRIMARY KEY(profile,id),
        FOREIGN KEY(profile,document_id) REFERENCES drafts(profile,id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS vault_document ON vault(profile,document_id);
    `);
  }
  close() {
    try {
      this.database.close();
    } finally {
      this.key.fill(0);
      this.summaries.clear();
      this.search = null;
    }
  }
  storageSchema(): number {
    const version = this.database
      .prepare('PRAGMA user_version')
      .get()?.user_version;
    if (version !== 8)
      throw new LocalError(
        'local_version_unsupported',
        'Local storage did not initialize the supported schema.',
      );
    return version;
  }
  cacheVersion(): string | null {
    // Uncommitted reads must not survive a rollback with the same change count.
    if (this.transactionDepth > 0) return null;
    const { changes, version } = cacheVersionSchema.parse(
      this.database
        .prepare(
          'SELECT total_changes() AS changes, data_version AS version FROM pragma_data_version',
        )
        .get(),
    );
    return `${version}:${changes}`;
  }
  atomic(run: () => undefined): void {
    this.transaction(run);
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
    const nested = this.transactionDepth > 0;
    const savepoint = `local_${this.transactionDepth}`;
    this.database.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = run();
      this.database.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.summaries.clear();
      this.search = null;
      this.database.exec(
        nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK',
      );
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  getValue<T>(profile: string, id: string, schema: z.ZodType<T>): T | null {
    const row = this.database
      .prepare('SELECT payload,document_id FROM vault WHERE profile=? AND id=?')
      .get(profile, id);
    return row
      ? this.open(
          schema,
          z.instanceof(Uint8Array).parse(row.payload),
          aad(
            'vault2',
            profile,
            id,
            z.string().nullable().parse(row.document_id) ?? '',
          ),
        )
      : null;
  }
  putValue(profile: string, id: string, value: unknown): void {
    this.database
      .prepare(
        'INSERT INTO vault (profile,id,document_id,payload) VALUES (?,?,NULL,?) ON CONFLICT(profile,id) DO UPDATE SET document_id=NULL,payload=excluded.payload',
      )
      .run(profile, id, this.seal(value, aad('vault2', profile, id, '')));
  }
  deleteArtifact(profile: string, document: string, id: string): void {
    this.get(profile, document);
    this.deleteValue(profile, `artifact:${document}:${id}`);
  }
  deleteArtifactPrefix(
    profile: string,
    document: string,
    prefix: string,
  ): void {
    this.get(profile, document);
    z.string()
      .min(1)
      .max(200)
      .refine((value) => !value.includes('\0'))
      .parse(prefix);
    const name = `artifact:${document}:${prefix}`;
    this.database
      .prepare(
        'DELETE FROM vault WHERE profile=? AND document_id=? AND substr(id,1,length(?))=?',
      )
      .run(profile, document, name, name);
  }
  putArtifact(
    profile: string,
    document: string,
    id: string,
    value: unknown,
  ): void {
    this.writeArtifact(profile, document, id, value, false);
  }
  private writeArtifact(
    profile: string,
    document: string,
    id: string,
    value: unknown,
    skipUnchanged: boolean,
  ): void {
    const row = this.row(profile, document);
    const payload = row ? this.payload(row) : null;
    if (
      !row ||
      row.deleted ||
      payload?.recovery ||
      (!payload?.server && !payload?.conflict)
    )
      throw new LocalError(
        'local_document_missing',
        'The artifact document is no longer available.',
      );
    const name = `artifact:${document}:${id}`;
    if (skipUnchanged) {
      const saved = this.database
        .prepare(
          'SELECT document_id,payload FROM vault WHERE profile=? AND id=?',
        )
        .get(profile, name);
      if (
        saved?.document_id === document &&
        isDeepStrictEqual(
          this.open(
            z.unknown(),
            z.instanceof(Uint8Array).parse(saved.payload),
            aad('vault2', profile, name, document),
          ),
          value,
        )
      )
        return;
    }
    this.database
      .prepare(
        `
      INSERT INTO vault(profile,id,document_id,payload) VALUES (?,?,?,?)
      ON CONFLICT(profile,id) DO UPDATE SET document_id=excluded.document_id,payload=excluded.payload
    `,
      )
      .run(
        profile,
        name,
        document,
        this.seal(value, aad('vault2', profile, name, document)),
      );
  }
  getArtifact<T>(
    profile: string,
    document: string,
    id: string,
    schema: z.ZodType<T>,
  ): T | null {
    const row = this.row(profile, document);
    const payload = row ? this.payload(row) : null;
    if (
      !row ||
      row.deleted ||
      payload?.recovery ||
      (!payload?.server && !payload?.conflict)
    )
      return null;
    return this.getValue(profile, `artifact:${document}:${id}`, schema);
  }
  deleteValue(profile: string, id: string): void {
    this.database
      .prepare('DELETE FROM vault WHERE profile=? AND id=?')
      .run(profile, id);
  }
  purgeCredentials(except: string | null = null): void {
    this.database
      .prepare(
        "DELETE FROM vault WHERE profile LIKE 'credentials:%' AND (? IS NULL OR profile<>?)",
      )
      .run(except, except);
  }
  activeRecordingOwner(): RecordingOwner | null {
    return this.getValue('root', 'recording:active', recordingOwnerSchema);
  }
  private recordingDocument(profile: string, document: string): void {
    const row = this.row(profile, document);
    if (!row || row.deleted || this.payload(row).recovery)
      throw new LocalError(
        'local_document_missing',
        'This recording document is no longer available.',
      );
  }
  private recordingValue(
    profile: string,
    document: string,
    id: string,
  ): LocalRecording {
    resourceId.parse(id);
    const value = this.getValue(
      profile,
      `recording:${id}`,
      localRecordingSchema,
    );
    if (!value || value.id !== id || value.document_id !== document)
      throw new LocalError(
        'local_recording_missing',
        'This recording is not available in this document and workspace.',
      );
    return value;
  }
  getRecording(profile: string, document: string, id: string): LocalRecording {
    this.recordingDocument(profile, document);
    return this.recordingValue(profile, document, id);
  }
  getRecordingForAudio(
    profile: string,
    document: string,
    id: string,
  ): LocalRecording {
    const recording = this.getRecording(profile, document, id);
    const proof = this.retentionProof(profile, document, id);
    if (
      recording.audio_retired_at ||
      (proof && proof.delete_after <= Date.now())
    )
      throw new LocalError(
        'local_audio_retired',
        'Local audio has reached its retention deadline. Use the remaining cloud recording controls.',
      );
    return recording;
  }
  recordings(
    profile: string,
    document: string,
    offset = 0,
  ): { recordings: LocalRecording[]; has_more: boolean } {
    this.recordingDocument(profile, document);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
      throw new LocalError(
        'invalid_recording_page',
        'Use a supported recording page offset.',
      );
    const rows = this.database
      .prepare(
        "SELECT id FROM vault WHERE profile=? AND document_id=? AND id LIKE 'recording:%' ORDER BY rowid DESC LIMIT 51 OFFSET ?",
      )
      .all(profile, document, offset);
    return {
      recordings: rows
        .slice(0, 50)
        .map((row) =>
          this.recordingValue(
            profile,
            document,
            z.string().parse(row.id).slice('recording:'.length),
          ),
        ),
      has_more: rows.length > 50,
    };
  }
  private writeRecording(profile: string, recording: LocalRecording): void {
    const name = `recording:${recording.id}`;
    this.database
      .prepare(
        'INSERT INTO vault(profile,id,document_id,payload) VALUES (?,?,?,?) ON CONFLICT(profile,id) DO UPDATE SET document_id=excluded.document_id,payload=excluded.payload',
      )
      .run(
        profile,
        name,
        recording.document_id,
        this.seal(
          recording,
          aad('vault2', profile, name, recording.document_id),
        ),
      );
  }
  beginRecording(
    profile: string,
    document: string,
    tracks: Track[],
  ): LocalRecording {
    return this.transaction(() => {
      this.recordingDocument(profile, document);
      if (this.activeRecordingOwner())
        throw new LocalError(
          'recording_in_progress',
          'Stop the current recording before starting another.',
        );
      const recording = localRecordingSchema.parse({
        id: randomUUID(),
        document_id: document,
        created_at: new Date().toISOString(),
        state: 'starting',
        tracks: tracks.map((spec) => ({
          spec,
          actual_device_id: null,
          saved_samples: 0,
        })),
        error: null,
        inspection: null,
      });
      this.writeRecording(profile, recording);
      this.putValue(
        'root',
        'recording:active',
        recordingOwnerSchema.parse({
          profile,
          document_id: document,
          recording_id: recording.id,
        }),
      );
      return recording;
    });
  }
  updateRecording(
    profile: string,
    document: string,
    id: string,
    patch: Partial<
      Pick<LocalRecording, 'state' | 'tracks' | 'error' | 'inspection'>
    >,
  ): LocalRecording {
    return this.transaction(() => {
      const previous = this.getRecording(profile, document, id);
      const next = localRecordingSchema.parse({ ...previous, ...patch });
      const active = this.activeRecordingOwner();
      const ongoing = ['starting', 'recording', 'paused'].includes(next.state);
      if (
        canonicalJson(next.tracks.map((track) => track.spec)) !==
          canonicalJson(previous.tracks.map((track) => track.spec)) ||
        next.tracks.some(
          (track, index) =>
            track.saved_samples < previous.tracks[index]!.saved_samples,
        ) ||
        (ongoing &&
          (active?.profile !== profile ||
            active.document_id !== document ||
            active.recording_id !== id ||
            !['starting', 'recording', 'paused'].includes(previous.state)))
      )
        throw new LocalError(
          'invalid_recording_update',
          'The recording identity, saved samples or active state changed unexpectedly.',
        );
      this.writeRecording(profile, next);
      if (!ongoing && active?.profile === profile && active.recording_id === id)
        this.deleteValue('root', 'recording:active');
      return next;
    });
  }
  pendingRecordingDeletions(): string[] {
    return (
      this.getValue(
        'root',
        'recording:deletions',
        z.array(resourceId).max(10_000),
      ) ?? []
    );
  }
  acknowledgeRecordingDeletion(id: string): void {
    resourceId.parse(id);
    this.transaction(() => {
      const remaining = this.pendingRecordingDeletions().filter(
        (item) => item !== id,
      );
      if (remaining.length)
        this.putValue('root', 'recording:deletions', remaining);
      else this.deleteValue('root', 'recording:deletions');
    });
  }
  private queueRecordingDeletions(profile: string, document?: string): void {
    const rows = this.database
      .prepare(
        "SELECT id,document_id FROM vault WHERE profile=? AND document_id IS NOT NULL AND id LIKE 'recording:%' AND (? IS NULL OR document_id=?)",
      )
      .all(profile, document ?? null, document ?? null);
    if (!rows.length) return;
    const ids = rows.map(
      (row) =>
        this.recordingValue(
          profile,
          resourceId.parse(row.document_id),
          z.string().parse(row.id).slice('recording:'.length),
        ).id,
    );
    this.queueRecordingIds(profile, ids);
    this.database
      .prepare(
        'DELETE FROM recording_uploads WHERE profile=? AND (? IS NULL OR document_id=?)',
      )
      .run(profile, document ?? null, document ?? null);
    this.database
      .prepare(
        'DELETE FROM recording_retention WHERE profile=? AND (? IS NULL OR document_id=?)',
      )
      .run(profile, document ?? null, document ?? null);
  }
  private queueRecordingIds(profile: string, ids: string[]): void {
    const pending = z
      .array(resourceId)
      .max(10_000)
      .parse([...new Set([...this.pendingRecordingDeletions(), ...ids])]);
    this.putValue('root', 'recording:deletions', pending);
    const active = this.activeRecordingOwner();
    if (active?.profile === profile && ids.includes(active.recording_id))
      this.deleteValue('root', 'recording:active');
  }
  removeRecording(profile: string, document: string, id: string): void {
    this.transaction(() => {
      this.getRecording(profile, document, id);
      this.queueRecordingIds(profile, [id]);
      this.deleteValue(profile, `recording:${id}`);
      this.database
        .prepare(
          'DELETE FROM recording_uploads WHERE profile=? AND recording_id=?',
        )
        .run(profile, id);
      this.database
        .prepare(
          'DELETE FROM recording_retention WHERE profile=? AND recording_id=?',
        )
        .run(profile, id);
    });
  }
  recordingQuotaGiB(): number {
    return (
      this.getValue('root', 'audio-quota-gib', localAudioQuotaGiBSchema) ?? 5
    );
  }
  setRecordingQuotaGiB(value: number): void {
    this.putValue(
      'root',
      'audio-quota-gib',
      localAudioQuotaGiBSchema.parse(value),
    );
  }
  recordingRetentionDays(profile: string): number {
    return (
      this.getValue(
        profile,
        'audio-retention-days',
        localAudioRetentionDaysSchema,
      ) ?? 7
    );
  }
  setRecordingRetentionDays(profile: string, value: number): void {
    const days = localAudioRetentionDaysSchema.parse(value);
    this.transaction(() => {
      const rows = this.database
        .prepare(
          'SELECT recording_id,document_id FROM recording_retention WHERE profile=?',
        )
        .all(profile);
      this.putValue(profile, 'audio-retention-days', days);
      for (const row of rows) {
        const proof = this.retentionProof(
          profile,
          resourceId.parse(row.document_id),
          resourceId.parse(row.recording_id),
        )!;
        this.writeRetentionProof(profile, {
          ...proof,
          delete_after: Math.min(
            proof.delete_after,
            Date.parse(proof.canonical_at) + days * DAY,
          ),
        });
      }
    });
  }
  private retentionProof(
    profile: string,
    document: string,
    id: string,
  ): RetentionProof | null {
    this.getRecording(profile, document, id);
    const row = this.database
      .prepare(
        'SELECT document_id,delete_after,payload FROM recording_retention WHERE profile=? AND recording_id=?',
      )
      .get(profile, id);
    if (!row) return null;
    const proof = this.open(
      retentionProofSchema,
      z.instanceof(Uint8Array).parse(row.payload),
      aad('recording-retention', profile, id, document),
    );
    if (
      row.document_id !== document ||
      proof.document_id !== document ||
      proof.recording_id !== id ||
      row.delete_after !== proof.delete_after
    )
      throw new LocalError(
        'local_data_corrupt',
        'The encrypted audio deadline does not match its ownership or queue metadata. Audio was preserved.',
      );
    return proof;
  }
  recordingRetention(
    profile: string,
    document: string,
    id: string,
  ): LocalAudioRetention | null {
    const proof = this.retentionProof(profile, document, id);
    if (!proof) return null;
    const {
      service_url: _service,
      server_days: _days,
      seal_sha256: _seal,
      ...status
    } = proof;
    return status;
  }
  private writeRetentionProof(profile: string, value: RetentionProof): void {
    const proof = retentionProofSchema.parse(value);
    this.database
      .prepare(
        `INSERT INTO recording_retention VALUES (?,?,?,?,?)
        ON CONFLICT(profile,recording_id) DO UPDATE SET delete_after=excluded.delete_after,payload=excluded.payload`,
      )
      .run(
        profile,
        proof.recording_id,
        proof.document_id,
        proof.delete_after,
        this.seal(
          proof,
          aad(
            'recording-retention',
            profile,
            proof.recording_id,
            proof.document_id,
          ),
        ),
      );
  }
  rememberRecordingRetention(
    profile: string,
    service: string,
    value: z.infer<typeof recordingRetentionSchema>,
  ): LocalAudioRetention | null {
    const status = recordingRetentionSchema.parse(value);
    return this.transaction(() => {
      const recording = this.getRecording(
        profile,
        status.document_id,
        status.id,
      );
      if (recording.audio_retired_at) return null;
      const previous = this.retentionProof(
        profile,
        status.document_id,
        status.id,
      );
      const intent = this.recordingUpload(
        profile,
        status.document_id,
        status.id,
      );
      if (
        !verifiedRecording(intent) ||
        ['starting', 'recording', 'paused'].includes(recording.state)
      )
        throw new LocalError(
          'audio_retention_not_eligible',
          'Only stopped, fully uploaded and verified audio can receive a local deletion deadline.',
        );
      if (
        previous &&
        (previous.service_url !== service ||
          previous.canonical_at !== status.canonical_at ||
          previous.seal_sha256 !== sealHash(intent))
      )
        throw new LocalError(
          'audio_retention_proof_changed',
          'The service or immutable canonical recording proof changed. The existing local deadline was not extended.',
        );
      if (!status.canonical_at) return null;
      const proof = retentionProofSchema.parse({
        recording_id: status.id,
        document_id: status.document_id,
        canonical_at: status.canonical_at,
        delete_after: Math.min(
          previous?.delete_after ?? Infinity,
          Date.parse(status.canonical_at) +
            Math.min(
              this.recordingRetentionDays(profile),
              status.retention_days,
            ) *
              DAY,
        ),
        service_url: service,
        server_days: Math.min(
          previous?.server_days ?? 7,
          status.retention_days,
        ),
        seal_sha256: sealHash(intent),
      });
      this.writeRetentionProof(profile, proof);
      return this.recordingRetention(profile, status.document_id, status.id);
    });
  }
  recordingRetentionCandidates(profile: string, after: string | null) {
    const rows = this.database
      .prepare(
        `SELECT document_id,recording_id FROM recording_uploads
        WHERE profile=? AND state IN ('complete','delete_pending','deleting')
          AND local_retired=0
          AND (? IS NULL OR recording_id>?)
        ORDER BY recording_id LIMIT 4`,
      )
      .all(profile, after, after);
    return {
      recordings: rows.flatMap((row) => {
        const intent = this.recordingUpload(
          profile,
          resourceId.parse(row.document_id),
          resourceId.parse(row.recording_id),
        );
        return verifiedRecording(intent) &&
          !this.recordingValue(profile, intent.document_id, intent.recording_id)
            .audio_retired_at
          ? [intent]
          : [];
      }),
      after: rows.length ? resourceId.parse(rows.at(-1)!.recording_id) : null,
    };
  }
  expireRecordingRetention(now = Date.now()): number {
    z.number().int().min(0).max(8_640_000_000_000_000).parse(now);
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          'SELECT profile,document_id,recording_id FROM recording_retention WHERE delete_after<=? ORDER BY delete_after,recording_id LIMIT 50',
        )
        .all(now);
      for (const row of rows) {
        const profile = z.string().parse(row.profile);
        const document = resourceId.parse(row.document_id);
        const id = resourceId.parse(row.recording_id);
        const proof = this.retentionProof(profile, document, id)!;
        const recording = this.getRecording(profile, document, id);
        const intent = this.recordingUpload(profile, document, id);
        if (
          proof.delete_after > now ||
          !verifiedRecording(intent) ||
          sealHash(intent) !== proof.seal_sha256 ||
          ['starting', 'recording', 'paused'].includes(recording.state)
        )
          throw new LocalError(
            'audio_retention_not_eligible',
            'The recording no longer matches its verified deletion proof. Audio was preserved.',
          );
        this.queueRecordingIds(profile, [id]);
        this.writeRecording(profile, {
          ...recording,
          audio_retired_at: new Date(now).toISOString(),
          inspection: null,
        });
        this.database
          .prepare(
            'UPDATE recording_uploads SET local_retired=1 WHERE profile=? AND recording_id=?',
          )
          .run(profile, id);
        this.database
          .prepare(
            'DELETE FROM recording_retention WHERE profile=? AND recording_id=?',
          )
          .run(profile, id);
      }
      return rows.length;
    });
  }
  recordingUpload(
    profile: string,
    document: string,
    id: string,
  ): RecordingUploadIntent | null {
    const recording = this.getRecording(profile, document, id);
    const row = this.database
      .prepare(
        'SELECT document_id,state,retry_at,payload,local_retired FROM recording_uploads WHERE profile=? AND recording_id=?',
      )
      .get(profile, id);
    if (!row) return null;
    const intent = this.open(
      recordingUploadIntentSchema,
      z.instanceof(Uint8Array).parse(row.payload),
      aad('recording-upload', profile, id, document),
    );
    if (
      row.document_id !== document ||
      intent.document_id !== document ||
      intent.recording_id !== id ||
      row.state !== intent.state ||
      row.retry_at !== intent.retry_at ||
      row.local_retired !== Number(!!recording.audio_retired_at)
    )
      throw new LocalError(
        'local_data_corrupt',
        'The encrypted upload journal does not match its ownership or queue metadata.',
      );
    return intent;
  }
  saveRecordingUpload(
    profile: string,
    value: RecordingUploadIntent,
  ): RecordingUploadIntent {
    const intent = recordingUploadIntentSchema.parse(value);
    return this.transaction(() => {
      const recording = this.getRecording(
        profile,
        intent.document_id,
        intent.recording_id,
      );
      if (recording.audio_retired_at && !verifiedRecording(intent))
        throw new LocalError(
          'local_audio_retired',
          'Expired local audio cannot be reuploaded. Its immutable cloud receipt was preserved.',
        );
      if (
        profile === 'offline' ||
        ['starting', 'recording', 'paused'].includes(recording.state)
      )
        throw new LocalError(
          'upload_not_available',
          'Stop recording in a connected workspace before requesting upload.',
        );
      const previous = this.recordingUpload(
        profile,
        intent.document_id,
        intent.recording_id,
      );
      if (
        previous?.plan &&
        canonicalJson(previous.plan) !== canonicalJson(intent.plan)
      )
        throw new LocalError(
          'upload_plan_changed',
          'The frozen recording upload plan cannot change. Local audio was preserved.',
        );
      const { plan: _plan, accept_incomplete: _accept, ...status } = intent;
      this.database
        .prepare(
          `INSERT INTO recording_uploads VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(profile,recording_id) DO UPDATE SET state=excluded.state,retry_at=excluded.retry_at,payload=excluded.payload,status_payload=excluded.status_payload,local_retired=excluded.local_retired`,
        )
        .run(
          profile,
          intent.recording_id,
          intent.document_id,
          intent.state,
          intent.retry_at,
          this.seal(
            intent,
            aad(
              'recording-upload',
              profile,
              intent.recording_id,
              intent.document_id,
            ),
          ),
          this.seal(
            status,
            aad(
              'recording-upload-status',
              profile,
              intent.recording_id,
              intent.document_id,
            ),
          ),
          Number(!!recording.audio_retired_at),
        );
      return intent;
    });
  }
  recordingUploadStatus(
    profile: string,
    document: string,
    id: string,
  ): RecordingUploadStatus | null {
    const recording = this.getRecording(profile, document, id);
    const row = this.database
      .prepare(
        'SELECT document_id,state,retry_at,status_payload,local_retired FROM recording_uploads WHERE profile=? AND recording_id=?',
      )
      .get(profile, id);
    if (!row) return null;
    const status = this.open(
      recordingUploadStatusSchema,
      z.instanceof(Uint8Array).parse(row.status_payload),
      aad('recording-upload-status', profile, id, document),
    );
    if (
      row.document_id !== document ||
      status.document_id !== document ||
      status.recording_id !== id ||
      row.state !== status.state ||
      row.retry_at !== status.retry_at ||
      row.local_retired !== Number(!!recording.audio_retired_at)
    )
      throw new LocalError(
        'local_data_corrupt',
        'The encrypted upload status does not match its ownership or queue metadata.',
      );
    return status;
  }
  nextRecordingUpload(
    profile: string,
    now = Date.now(),
  ): RecordingUploadIntent | null {
    const row = this.database
      .prepare(
        `SELECT recording_id,document_id FROM recording_uploads
      WHERE profile=? AND state IN ('queued','waiting','uploading','delete_pending','deleting') AND retry_at<=?
      ORDER BY retry_at,recording_id LIMIT 1`,
      )
      .get(profile, now);
    return row
      ? this.recordingUpload(
          profile,
          resourceId.parse(row.document_id),
          resourceId.parse(row.recording_id),
        )
      : null;
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
    this.invalidate(row.profile, row.id);
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
  private invalidate(profile: string, id?: string) {
    if (id) {
      this.summaries.delete(canonicalJson([profile, id]));
      if (this.search?.profile === profile) this.search.matches.delete(id);
    } else {
      for (const [key, value] of this.summaries)
        if (value.profile === profile) this.summaries.delete(key);
      if (this.search?.profile === profile) this.search = null;
    }
  }
  private forget(profile: string, id: string) {
    this.queueRecordingDeletions(profile, id);
    this.invalidate(profile, id);
    this.database
      .prepare('DELETE FROM drafts WHERE profile=? AND id=?')
      .run(profile, id);
  }
  page(
    profile: string,
    query = '',
    offset = 0,
  ): { documents: DraftSummary[]; has_more: boolean } {
    if (
      query.length > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1_000_000
    )
      throw new LocalError(
        'invalid_local_search',
        'Use a supported search query and page offset.',
      );
    const normalized = query.trim().toLowerCase();
    if (
      !this.search ||
      this.search.profile !== profile ||
      this.search.query !== normalized
    )
      this.search = { profile, query: normalized, matches: new Map() };
    const sql =
      'SELECT profile,id,revision,remote_revision,dirty,conflict,deleted,updated_at FROM drafts WHERE profile=? AND deleted=0 ORDER BY updated_at DESC,id';
    const statement = this.database.prepare(
      normalized ? sql : `${sql} LIMIT 51 OFFSET ?`,
    );
    const rows = normalized
      ? statement.iterate(profile)
      : statement.iterate(profile, offset);
    let skip = normalized ? offset : 0;
    const documents: DraftSummary[] = [];
    for (const input of rows) {
      const row = headerSchema.parse(input);
      const fingerprint = canonicalJson(row);
      let loaded: Draft | undefined;
      const read = () => (loaded ??= this.get(profile, row.id));
      if (normalized) {
        const previous = this.search.matches.get(row.id);
        let matches =
          previous?.fingerprint === fingerprint ? previous.value : undefined;
        if (matches === undefined) {
          const draft = read();
          matches =
            `${draft.title} ${draft.tags.join(' ')} ${richTextToPlainText(draft.content)}`
              .toLowerCase()
              .includes(normalized);
          this.search.matches.set(row.id, { fingerprint, value: matches });
          if (this.search.matches.size > 10_000) {
            const first = this.search.matches.keys().next();
            if (!first.done) this.search.matches.delete(first.value);
          }
        }
        if (!matches) continue;
      }
      if (skip > 0) {
        skip--;
        continue;
      }
      if (documents.length === 50) return { documents, has_more: true };
      const key = canonicalJson([profile, row.id]);
      const cached = this.summaries.get(key);
      let summary: DraftSummary;
      if (cached?.fingerprint === fingerprint) summary = cached.value;
      else {
        const { content, ...metadata } = read();
        summary = {
          ...metadata,
          preview: richTextToPlainText(content).slice(0, 160),
        };
      }
      this.summaries.delete(key);
      this.summaries.set(key, { profile, fingerprint, value: summary });
      if (this.summaries.size > 500) {
        const first = this.summaries.keys().next();
        if (!first.done) this.summaries.delete(first.value);
      }
      documents.push(summary);
    }
    return { documents, has_more: false };
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
  details(profile: string, id: string) {
    const row = this.row(profile, id);
    if (!row || row.deleted)
      throw new LocalError(
        'local_document_missing',
        'This local document is unavailable.',
      );
    const value = this.payload(row);
    const latest = value.conflict ?? value.server;
    return {
      transcript_revision: latest?.transcript_revision ?? 0,
      conflict: row.conflict
        ? {
            remote: value.conflict ? editable(value.conflict) : null,
            remote_revision: value.conflict?.revision ?? row.remote_revision,
            deleted_remote: value.recovery !== null,
          }
        : null,
    };
  }
  copyDrafts(
    source: string,
    destination: string,
    mode: 'all' | 'unsent',
  ): number {
    if (source === destination)
      throw new LocalError(
        'invalid_copy_scope',
        'Choose a different workspace for the copies.',
      );
    return this.transaction(() => {
      let count = 0;
      const rows = this.database
        .prepare('SELECT * FROM drafts WHERE profile=? AND deleted=0')
        .all(source);
      for (const input of rows) {
        const row = rowSchema.parse(input);
        if (mode === 'unsent' && !row.dirty) continue;
        const marker = `imported:${source}:${row.id}:${row.revision}`;
        if (this.getValue(destination, marker, resourceId)) continue;
        const copy = this.create(destination, pickEditable(this.payload(row)));
        this.putValue(destination, marker, copy.id);
        count++;
      }
      return count;
    });
  }
  unsentCount(profile: string): number {
    const row = this.database
      .prepare(
        'SELECT count(*) count FROM drafts WHERE profile=? AND deleted=0 AND dirty=1',
      )
      .get(profile);
    return z.number().int().nonnegative().parse(row?.count);
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
      this.queueRecordingDeletions(profile, id);
      this.database
        .prepare(
          "DELETE FROM vault WHERE profile=? AND document_id=? AND id LIKE 'recording:%'",
        )
        .run(profile, id);
      const queued = this.database
        .prepare('SELECT 1 FROM outbox WHERE profile=? AND document_id=?')
        .get(profile, id);
      if (!row.remote_revision && !queued) this.forget(profile, id);
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
      if (
        this.database
          .prepare(
            "SELECT 1 FROM vault WHERE profile='offline' AND document_id IS NOT NULL AND id LIKE 'recording:%' LIMIT 1",
          )
          .get()
      )
        throw new LocalError(
          'recording_transfer_requires_consent',
          'Copy notes explicitly instead of moving a profile with local recordings. Its audio was preserved.',
        );
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
      this.invalidate('offline');
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
        this.forget(profile, row.id);
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
        const known = value.server ?? value.conflict;
        if (
          known &&
          (known.owner_id !== remote.owner_id ||
            known.workspace_id !== remote.workspace_id)
        )
          throw new LocalError(
            'invalid_server_response',
            'The document account or workspace changed unexpectedly.',
          );
        if (remote.revision < row.remote_revision) return;
        if (row.deleted) {
          this.write(
            { ...row, remote_revision: remote.revision, conflict: 0 },
            { ...value, server: remote, conflict: null },
          );
          return;
        }
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
      this.queueRecordingDeletions(profile, id);
      this.database
        .prepare('DELETE FROM vault WHERE profile=? AND document_id=?')
        .run(profile, id);
      const row = this.row(profile, id);
      if (!row) return;
      const value = this.payload(row);
      this.database
        .prepare('DELETE FROM outbox WHERE profile=? AND document_id=?')
        .run(profile, id);
      if (!row.dirty || row.deleted) this.forget(profile, id);
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
  syncCheckpoint(profile: string): SyncCheckpoint {
    return (
      this.getValue(profile, 'sync:checkpoint', checkpointSchema) ?? {
        cursor: null,
        bootstrap: null,
      }
    );
  }
  beginSnapshot(profile: string): SyncCheckpoint {
    if (profile === 'offline')
      throw new LocalError(
        'not_connected',
        'Connect an account before synchronizing drafts.',
      );
    return this.transaction(() => {
      this.database
        .prepare('DELETE FROM snapshot_candidates WHERE profile=?')
        .run(profile);
      this.database
        .prepare(
          'INSERT INTO snapshot_candidates SELECT profile,id FROM drafts WHERE profile=? AND remote_revision>0',
        )
        .run(profile);
      const checkpoint: SyncCheckpoint = {
        cursor: null,
        bootstrap: { cursor: null, after: null },
      };
      this.putValue(profile, 'sync:checkpoint', checkpoint);
      return checkpoint;
    });
  }
  acceptSnapshot(
    profile: string,
    expected: NonNullable<SyncCheckpoint['bootstrap']>,
    input: z.infer<typeof syncSnapshotSchema>,
    artifacts: { document_id: string; id: string; value: unknown }[] = [],
  ): void {
    const page = syncSnapshotSchema.parse(input);
    this.transaction(() => {
      const checkpoint = this.syncCheckpoint(profile);
      if (
        !checkpoint.bootstrap ||
        canonicalJson(checkpoint.bootstrap) !== canonicalJson(expected)
      )
        throw new LocalError(
          'local_sync_changed',
          'This snapshot is no longer active.',
        );
      if (
        (expected.cursor !== null && page.cursor !== expected.cursor) ||
        page.has_more !== (page.next_after !== null) ||
        (page.has_more &&
          (!page.documents.length ||
            page.next_after! <= (expected.after ?? '')))
      )
        throw new LocalError(
          'invalid_server_response',
          'The server returned inconsistent snapshot pagination.',
        );
      for (const document of page.documents) {
        this.applyRemote(profile, document);
        this.database
          .prepare('DELETE FROM snapshot_candidates WHERE profile=? AND id=?')
          .run(profile, document.id);
      }
      for (const artifact of artifacts) {
        if (
          !page.documents.some(
            (document) => document.id === artifact.document_id,
          )
        )
          throw new LocalError(
            'invalid_server_response',
            'A snapshot artifact belongs to another page.',
          );
        this.writeArtifact(
          profile,
          artifact.document_id,
          artifact.id,
          artifact.value,
          true,
        );
      }
      if (page.has_more)
        this.putValue(profile, 'sync:checkpoint', {
          cursor: null,
          bootstrap: { cursor: page.cursor, after: page.next_after },
        });
      else {
        const missing = this.database
          .prepare('SELECT id FROM snapshot_candidates WHERE profile=?')
          .all(profile);
        for (const { id } of missing)
          this.remoteDeleted(profile, z.string().parse(id));
        this.database
          .prepare('DELETE FROM snapshot_candidates WHERE profile=?')
          .run(profile);
        this.putValue(profile, 'sync:checkpoint', {
          cursor: page.cursor,
          bootstrap: null,
        });
      }
    });
  }
  acceptChanges(
    profile: string,
    expected: string,
    cursor: string,
    updates: RemoteUpdate[],
  ): void {
    this.transaction(() => {
      const checkpoint = this.syncCheckpoint(profile);
      if (checkpoint.bootstrap || checkpoint.cursor !== expected)
        throw new LocalError(
          'local_sync_changed',
          'This synchronization pass is no longer active.',
        );
      syncSnapshotSchema.shape.cursor.parse(cursor);
      for (const update of updates) {
        if (update.document === null) this.remoteDeleted(profile, update.id);
        else {
          if (update.document.id !== update.id)
            throw new LocalError(
              'invalid_server_response',
              'The changed document does not match its identifier.',
            );
          this.applyRemote(profile, update.document);
          for (const artifact of update.artifacts)
            this.writeArtifact(
              profile,
              update.id,
              artifact.id,
              artifact.value,
              true,
            );
        }
      }
      this.putValue(profile, 'sync:checkpoint', { cursor, bootstrap: null });
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
        this.forget(profile, id);
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
    this.invalidate(profile);
    this.transaction(() => {
      this.queueRecordingDeletions(profile);
      this.database.prepare('DELETE FROM drafts WHERE profile=?').run(profile);
      this.database.prepare('DELETE FROM vault WHERE profile=?').run(profile);
    });
  }
}
