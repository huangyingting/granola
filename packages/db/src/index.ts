import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  ServiceError,
  jobInputSchema,
  jobSchema,
  jobEventSchema,
  segmentsSchema,
  createDocumentSchema,
  resultSchema,
  type finalizeTranscriptSchema,
  type Job,
  type JobInput,
  type JobResult,
  type Failure,
  type Segment,
} from '@windows-ai-notes/contracts/server';
import type { z } from 'zod';
import type { summaryRequestSchema } from '@windows-ai-notes/contracts/server';
import {
  canonicalJson,
  richTextToPlainText,
  type RichTextDocument,
} from '@windows-ai-notes/contracts/content';
import { recordChange, SyncStore } from './sync.js';
import { RecordingStore } from './recordings.js';
import { TranscriptStore } from './transcripts.js';
import { RecordingTranscriptions } from './recording-transcriptions.js';
import { UsageStore } from './usage.js';
import { LiveSourceStore } from './live.js';
import { SummaryStages } from './summaries.js';
import { MeetingQuestions } from './questions.js';
import { ChatStore } from './chat.js';
import { operationsSnapshot } from './operations.js';
import { AuditStore } from './audit.js';
import { auditTransactionContext } from './audit-context.js';
import {
  summaryCitations,
  summarySourceSchema,
} from '@windows-ai-notes/contracts/generation';
export type { UsageReservation } from './usage.js';
export type { ClaimedChat } from './chat.js';
export type { LiveClaim, LiveStart, LiveCursor } from './live.js';
export { LIVE_MEDIA_MS, LIVE_LEASE_MS } from './live.js';
export { recordChange } from './sync.js';
export {
  withAuditContext,
  setAuditActor,
  setAuditTask,
  bindAuditContext,
} from './audit-context.js';

const migrationFiles = [
  '001_initial.sql',
  '002_editing_sync.sql',
  '003_recordings.sql',
  '004_transcript_pages.sql',
  '005_recording_transcription.sql',
  '006_ai_usage.sql',
  '007_live_sources.sql',
  '008_summary_stages.sql',
  '009_chat.sql',
  '010_audio_retention.sql',
  '011_audit.sql',
  '012_provider_origin.sql',
];

export type Transaction = pg.PoolClient;
export interface Document {
  id: string;
  workspace_id: string;
  owner_id: string;
  title: string;
  revision: number;
  transcript_revision: number;
  notes: string;
  content: RichTextDocument | null;
  tags: string[];
  applied_revision?: number;
  created_at: Date;
  updated_at: Date;
}
interface JobRow {
  id: string;
  document_id: string;
  owner_id: string;
  kind: Job['kind'];
  state: Job['state'];
  attempt: number;
  lease_token: number;
  lease_until: Date | null;
  input: unknown;
  result: unknown;
  error: unknown;
  audio: Buffer | null;
  created_at: Date;
  event_seq: number;
  current_note_revision: number;
  current_transcript_revision: number;
  progress: unknown;
}
type JobStatusRow = Pick<
  JobRow,
  | 'id'
  | 'document_id'
  | 'kind'
  | 'state'
  | 'attempt'
  | 'input'
  | 'result'
  | 'error'
  | 'created_at'
  | 'current_note_revision'
  | 'current_transcript_revision'
  | 'progress'
  | 'event_seq'
>;
const jobStatusQuery = `
 SELECT j.id,j.document_id,j.kind,j.state,j.attempt,j.input,j.result,j.error,j.created_at,j.progress,j.event_seq,
 d.revision current_note_revision,d.transcript_revision current_transcript_revision FROM jobs j
 JOIN documents d ON d.id=j.document_id
 JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=j.owner_id AND m.active
 JOIN users u ON u.id=j.owner_id AND u.active`;
export interface ClaimedJob {
  id: string;
  documentId: string;
  ownerId: string;
  input: JobInput;
  audio: Buffer | null;
  leaseToken: number;
  attempt: number;
}
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const documentAccess = `
 JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.owner_id AND m.active
 JOIN users u ON u.id=d.owner_id AND u.active
 WHERE d.id=$1 AND d.owner_id=$2 AND d.deleted_at IS NULL`;
const documentQuery = `
 SELECT d.id,d.workspace_id,d.owner_id,d.title,d.tags,d.revision,d.transcript_revision,d.created_at,d.updated_at,n.notes,n.content FROM documents d
 JOIN note_versions n ON n.document_id=d.id AND n.revision=d.revision ${documentAccess}`;

export function requireDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is required.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL is invalid.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('DATABASE_URL must use PostgreSQL.');
  return value;
}
export const digest = (value: unknown, canonical = false): string =>
  createHash('sha256')
    .update(canonical ? canonicalJson(value) : JSON.stringify(value))
    .digest('hex');

export class Database {
  readonly pool: pg.Pool;
  readonly sync: SyncStore;
  readonly recordings: RecordingStore;
  readonly transcripts: TranscriptStore;
  readonly recordingTranscriptions: RecordingTranscriptions;
  readonly usage: UsageStore;
  readonly live: LiveSourceStore;
  readonly summaries: SummaryStages;
  readonly questions: MeetingQuestions;
  readonly chat: ChatStore;
  readonly audit: AuditStore;
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10_000,
    });
    this.sync = new SyncStore(this);
    this.recordings = new RecordingStore(this);
    this.transcripts = new TranscriptStore(this);
    this.recordingTranscriptions = new RecordingTranscriptions(this);
    this.usage = new UsageStore(this);
    this.live = new LiveSourceStore(this);
    this.summaries = new SummaryStages(this);
    this.questions = new MeetingQuestions(this);
    this.chat = new ChatStore(this);
    this.audit = new AuditStore(this);
    this.pool.on('error', () =>
      console.error(
        'database_connection_failed: idle PostgreSQL connection closed.',
      ),
    );
  }
  async close() {
    await this.pool.end();
  }
  async operations() {
    return operationsSnapshot(this);
  }
  async assertReady(): Promise<void> {
    const applied = await this.pool.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    if (
      applied.rows.length !== migrationFiles.length ||
      applied.rows.some((row, index) => row.version !== index + 1)
    )
      throw new Error('Apply database migrations before starting the service.');
  }
  async transaction<T>(
    operation: (client: Transaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `BEGIN; SET LOCAL notes.audit_context TO ${pg.escapeLiteral(JSON.stringify(auditTransactionContext()))}`,
      );
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async pendingWork(user: string, tx: Transaction): Promise<number> {
    return (
      await tx.query<{ count: number }>(
        `SELECT ((SELECT count(*) FROM jobs WHERE owner_id=$1 AND state IN ('queued','running','retry_wait'))+
       (SELECT count(*) FROM chat_turns WHERE owner_id=$1 AND state IN ('queued','running')))::int count`,
        [user],
      )
    ).rows[0]!.count;
  }
  async migrate(): Promise<void> {
    const migrations = await Promise.all(
      migrationFiles.map(async (file, index) => ({
        version: index + 1,
        sql: await readFile(
          new URL(`../migrations/${file}`, import.meta.url),
          'utf8',
        ),
      })),
    );
    await this.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('windows-ai-notes-migrations',0))",
      );
      await tx.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL)',
      );
      const existing = await tx.query<{ version: number; checksum: string }>(
        'SELECT version,checksum FROM schema_migrations ORDER BY version',
      );
      if (
        existing.rows.length > migrations.length ||
        existing.rows.some((row, index) => row.version !== index + 1)
      )
        throw new Error('Database migration history is newer or inconsistent.');
      for (const migration of migrations) {
        const checksum = createHash('sha256')
          .update(migration.sql)
          .digest('hex');
        const applied = existing.rows.find(
          (row) => row.version === migration.version,
        );
        if (applied) {
          if (applied.checksum !== checksum)
            throw new Error('Applied migration checksum mismatch.');
          continue;
        }
        await tx.query(migration.sql);
        await tx.query('INSERT INTO schema_migrations VALUES ($1,$2)', [
          migration.version,
          checksum,
        ]);
      }
    });
  }
  async provision(
    issuer: string,
    subject: string,
    workspaceId?: string,
    name = 'My workspace',
  ) {
    return this.transaction(async (tx) => {
      const user = await tx.query<{ id: string }>(
        'INSERT INTO users (id,issuer,subject) VALUES ($1,$2,$3) ON CONFLICT (issuer,subject) DO UPDATE SET active=true RETURNING id',
        [randomUUID(), issuer, subject],
      );
      const userId = user.rows[0]!.id;
      const id = workspaceId ?? randomUUID();
      if (workspaceId) {
        if (
          !(await tx.query('SELECT 1 FROM workspaces WHERE id=$1', [id]))
            .rowCount
        ) {
          throw new ServiceError(
            'workspace_not_found',
            'The requested workspace does not exist.',
            404,
          );
        }
      } else
        await tx.query('INSERT INTO workspaces (id,name) VALUES ($1,$2)', [
          id,
          name,
        ]);
      await tx.query(
        'INSERT INTO memberships (workspace_id,user_id) VALUES ($1,$2) ON CONFLICT (workspace_id,user_id) DO UPDATE SET active=true',
        [id, userId],
      );
      return { user_id: userId, workspace_id: id };
    });
  }
  async identify(issuer: string, subject: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      'SELECT id FROM users WHERE issuer=$1 AND subject=$2 AND active',
      [issuer, subject],
    );
    if (!result.rows[0])
      throw new ServiceError(
        'identity_not_provisioned',
        'This identity has not been provisioned by the deployment administrator.',
        403,
      );
    return result.rows[0].id;
  }
  async workspaces(userId: string) {
    return (
      await this.pool.query<{ id: string; name: string }>(
        'SELECT w.id,w.name FROM workspaces w JOIN memberships m ON m.workspace_id=w.id JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.active AND u.active ORDER BY w.created_at,w.id',
        [userId],
      )
    ).rows;
  }
  async document(
    userId: string,
    id: string,
    tx?: Transaction,
  ): Promise<Document> {
    // A locking revision join can recheck a new document against an old note row after waiting.
    if (tx) await this.lockDocument(userId, id, tx);
    const result = await (tx ?? this.pool).query<Document>(documentQuery, [
      id,
      userId,
    ]);
    if (!result.rows[0])
      throw new ServiceError(
        'document_not_found',
        'The document is unavailable or not accessible.',
        404,
      );
    return result.rows[0];
  }
  async lockDocument(userId: string, id: string, tx: Transaction) {
    const row = (
      await tx.query<Pick<Document, 'id' | 'workspace_id' | 'owner_id'>>(
        `SELECT d.id,d.workspace_id,d.owner_id FROM documents d ${documentAccess} FOR UPDATE OF d`,
        [id, userId],
      )
    ).rows[0];
    if (!row)
      throw new ServiceError(
        'document_not_found',
        'The document is unavailable or not accessible.',
        404,
      );
    return row;
  }
  async listDocuments(
    userId: string,
    workspaceId: string,
    limit: number,
    offset: number,
  ) {
    const allowed = await this.pool.query(
      'SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE workspace_id=$1 AND user_id=$2 AND m.active AND u.active',
      [workspaceId, userId],
    );
    if (!allowed.rowCount)
      throw new ServiceError(
        'workspace_not_found',
        'The workspace is unavailable.',
        404,
      );
    return (
      await this.pool.query<Document>(
        `
      SELECT d.id,d.workspace_id,d.owner_id,d.title,d.tags,d.revision,d.transcript_revision,d.created_at,d.updated_at,n.notes,n.content
      FROM documents d JOIN note_versions n ON n.document_id=d.id AND n.revision=d.revision
      JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.owner_id AND m.active
      JOIN users u ON u.id=d.owner_id AND u.active
      WHERE d.workspace_id=$1 AND d.owner_id=$2 AND d.deleted_at IS NULL ORDER BY d.created_at DESC,d.id LIMIT $3 OFFSET $4`,
        [workspaceId, userId, limit, offset],
      )
    ).rows;
  }
  async createDocument(
    userId: string,
    request: z.input<typeof createDocumentSchema>,
    key: string,
  ): Promise<Document> {
    const input = createDocumentSchema.parse(request);
    const id = await this.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `document:${userId}:${input.workspace_id}:${key}`,
      ]);
      const allowed = await tx.query(
        'SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE workspace_id=$1 AND user_id=$2 AND m.active AND u.active',
        [input.workspace_id, userId],
      );
      if (!allowed.rowCount)
        throw new ServiceError(
          'workspace_not_found',
          'The workspace is unavailable.',
          404,
        );
      const legacy =
        input.id === undefined &&
        input.content === null &&
        input.tags.length === 0;
      const hash = digest(
        legacy
          ? {
              workspace_id: input.workspace_id,
              title: input.title,
              notes: input.notes,
            }
          : input,
        !legacy,
      );
      const existing = await tx.query<{ id: string; create_hash: string }>(
        'SELECT id,create_hash FROM documents WHERE owner_id=$1 AND workspace_id=$2 AND create_key=$3',
        [userId, input.workspace_id, key],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].create_hash !== hash)
          throw new ServiceError(
            'idempotency_conflict',
            'This idempotency key is bound to different input.',
            409,
          );
        await this.document(userId, existing.rows[0].id, tx);
        return existing.rows[0].id;
      }
      const id = input.id ?? randomUUID();
      const inserted = await tx.query(
        'INSERT INTO documents (id,workspace_id,owner_id,title,tags,create_key,create_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING id',
        [id, input.workspace_id, userId, input.title, input.tags, key, hash],
      );
      if (!inserted.rowCount)
        throw new ServiceError(
          'document_id_conflict',
          'The document identifier is unavailable. It was not overwritten.',
          409,
        );
      await tx.query(
        'INSERT INTO note_versions (document_id,revision,notes,content) VALUES ($1,1,$2,$3)',
        [id, input.notes, input.content ? JSON.stringify(input.content) : null],
      );
      await recordChange(tx, id, 'document');
      return id;
    });
    return this.document(userId, id);
  }
  async edit(
    userId: string,
    id: string,
    baseRevision: number,
    update: {
      notes?: string | undefined;
      title?: string | undefined;
      content?: RichTextDocument | null | undefined;
      tags?: string[] | undefined;
    },
    mutationId?: string,
  ): Promise<Document> {
    const appliedRevision = await this.transaction(async (tx) => {
      const doc = await this.document(userId, id, tx);
      const operation =
        update.notes !== undefined || update.content !== undefined
          ? 'notes'
          : 'metadata';
      const hash = digest({ base_revision: baseRevision, update }, true);
      if (mutationId) {
        const previous = (
          await tx.query<{ request_hash: string; applied_revision: number }>(
            'SELECT request_hash,applied_revision FROM note_mutations WHERE document_id=$1 AND operation=$2 AND mutation_id=$3',
            [id, operation, mutationId],
          )
        ).rows[0];
        if (previous) {
          if (previous.request_hash !== hash)
            throw new ServiceError(
              'idempotency_conflict',
              'This mutation key is bound to different input.',
              409,
            );
          return previous.applied_revision;
        }
      }
      if (doc.revision !== baseRevision) throw conflict(doc.revision);
      const next = doc.revision + 1;
      const notes = update.content
        ? richTextToPlainText(update.content)
        : (update.notes ?? doc.notes);
      if (
        update.content &&
        update.notes !== undefined &&
        update.notes !== notes
      )
        throw new ServiceError(
          'invalid_request',
          'Plain text must agree with the structured notes.',
          400,
        );
      await tx.query(
        'UPDATE documents SET revision=$2,title=$3,tags=$4,updated_at=now() WHERE id=$1',
        [id, next, update.title ?? doc.title, update.tags ?? doc.tags],
      );
      const content =
        update.content !== undefined
          ? update.content
          : update.notes !== undefined
            ? null
            : doc.content;
      await tx.query(
        'INSERT INTO note_versions (document_id,revision,notes,content) VALUES ($1,$2,$3,$4)',
        [id, next, notes, content ? JSON.stringify(content) : null],
      );
      if (mutationId)
        await tx.query(
          'INSERT INTO note_mutations (document_id,operation,mutation_id,request_hash,applied_revision) VALUES ($1,$2,$3,$4,$5)',
          [id, operation, mutationId, hash, next],
        );
      await recordChange(tx, id, 'document');
      return next;
    });
    const doc = await this.document(userId, id);
    return mutationId ? { ...doc, applied_revision: appliedRevision } : doc;
  }
  async notes(userId: string, id: string, version: number) {
    await this.document(userId, id);
    const result = await this.pool.query<{
      notes: string;
      content: RichTextDocument | null;
    }>(
      `
      SELECT n.notes,n.content FROM note_versions n JOIN documents d ON d.id=n.document_id
      JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.owner_id AND m.active
      JOIN users u ON u.id=d.owner_id AND u.active
      WHERE n.document_id=$1 AND n.revision=$2 AND d.owner_id=$3 AND d.deleted_at IS NULL`,
      [id, version, userId],
    );
    if (!result.rows[0])
      throw new ServiceError(
        'revision_not_found',
        'The requested note revision is unavailable.',
        404,
      );
    return { document_id: id, revision: version, ...result.rows[0] };
  }
  async transcript(userId: string, id: string, version?: number) {
    return this.transcripts.legacy(userId, id, version);
  }
  async editTranscript(
    userId: string,
    id: string,
    base: number,
    segments: Segment[],
  ) {
    const version = await this.transaction(async (tx) => {
      const doc = await this.document(userId, id, tx);
      if (doc.transcript_revision !== base)
        throw conflict(doc.transcript_revision);
      const version = await this.transcripts.write(
        tx,
        userId,
        id,
        base,
        'manual',
        segmentsSchema.parse(segments),
      );
      if (base > 0) {
        await tx.query(
          `UPDATE transcript_revisions t SET recording_metadata=s.recording_metadata,
           timeline_count=s.timeline_count,based_on_revision=$2
           FROM transcript_revisions s WHERE t.document_id=$1 AND t.revision=$3
             AND s.document_id=$1 AND s.revision=$2`,
          [id, base, version],
        );
        await tx.query(
          `INSERT INTO transcript_timeline SELECT document_id,$3,position,entry
           FROM transcript_timeline WHERE document_id=$1 AND revision=$2`,
          [id, base, version],
        );
      }
      return version;
    });
    return this.transcript(userId, id, version);
  }
  async enqueueSummary(
    userId: string,
    id: string,
    input: z.infer<typeof summaryRequestSchema>,
    key: string,
  ): Promise<Job> {
    return this.enqueue(
      userId,
      id,
      'summary',
      key,
      digest(input),
      async (doc, tx) => {
        if (doc.revision !== input.note_revision) throw conflict(doc.revision);
        if (doc.transcript_revision !== input.transcript_revision)
          throw conflict(doc.transcript_revision);
        const header = await this.transcripts.header(
          userId,
          id,
          input.transcript_revision,
          tx,
        );
        const frozen = {
          document_id: id,
          notes: doc.notes,
          segments: [],
          note_revision: input.note_revision,
          transcript_revision: input.transcript_revision,
          language: input.language,
          ...(input.template_id === undefined
            ? {}
            : { template_id: input.template_id }),
        };
        const indexed = () => {
          if (!input.allow_long_context)
            throw new ServiceError(
              'context_too_large',
              'This meeting requires explicitly consented long-meeting processing.',
              413,
            );
          const { text_bytes, ...transcript } = header;
          return {
            kind: 'summary' as const,
            snapshot: frozen,
            source: {
              version: 'staged-evidence-v1' as const,
              transcript,
              text_bytes,
            },
          };
        };
        if (!doc.notes.trim() && header.total_segments === 0)
          throw new ServiceError(
            'empty_context',
            'Add notes or a transcript before summarizing.',
            400,
          );
        if (header.total_segments > 1000 || header.text_bytes > 48_000)
          return indexed();
        const transcript = await this.transcripts.legacy(
          userId,
          id,
          input.transcript_revision,
          tx,
        );
        const snapshot = {
          ...frozen,
          segments: transcript.segments,
        };
        if (!snapshot.notes.trim() && snapshot.segments.length === 0)
          throw new ServiceError(
            'empty_context',
            'Add notes or a transcript before summarizing.',
            400,
          );
        if (Buffer.byteLength(JSON.stringify(snapshot)) > 48_000)
          return indexed();
        return { kind: 'summary', snapshot };
      },
    );
  }
  async enqueueTranscription(
    userId: string,
    id: string,
    base: number,
    selectedLocale: 'en-US' | 'zh-CN',
    duration: number,
    wav: Buffer,
    key: string,
  ): Promise<Job> {
    const hash = digest({
      base,
      locale: selectedLocale,
      wav_sha256: createHash('sha256').update(wav).digest('hex'),
    });
    return this.enqueue(
      userId,
      id,
      'transcription',
      key,
      hash,
      async (doc) => {
        if (doc.transcript_revision !== base)
          throw conflict(doc.transcript_revision);
        return {
          kind: 'transcription',
          base_transcript_revision: base,
          locale: selectedLocale,
          duration_ms: duration,
        };
      },
      wav,
    );
  }
  async enqueueRecordingTranscription(
    user: string,
    recording: string,
    request: z.infer<typeof finalizeTranscriptSchema>,
    key: string,
  ) {
    const source = await this.recordings.get(user, recording);
    return this.enqueue(
      user,
      source.document_id,
      'recording_transcription',
      key,
      digest({ recording: source.id, ...request }),
      async (doc, tx) => {
        if (doc.transcript_revision !== request.base_revision)
          throw conflict(doc.transcript_revision);
        const frozen = await this.recordings.transcriptionSource(
          user,
          recording,
          request.seal_sha256,
          tx,
        );
        if (frozen.partial && !request.accept_incomplete)
          throw new ServiceError(
            'incomplete_consent_required',
            'Separately accept the incomplete capture before transcribing.',
            409,
          );
        return {
          kind: 'recording_transcription',
          recording_id: source.id,
          seal_sha256: request.seal_sha256,
          base_transcript_revision: request.base_revision,
          locale: request.locale,
          accept_incomplete: request.accept_incomplete,
          chunk_count: frozen.chunk_count,
        };
      },
    );
  }
  async retryRecordingTranscription(user: string, id: string) {
    const visible = await this.job(user, id);
    await this.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `job-budget:${user}`,
      ]);
      await this.document(user, visible.document_id, tx);
      const row = (
        await tx.query<{
          state: Job['state'];
          input: unknown;
          progress: unknown;
        }>('SELECT state,input,progress FROM jobs WHERE id=$1 FOR UPDATE', [id])
      ).rows[0]!;
      const selected = jobInputSchema.parse(row.input);
      if (selected.kind !== 'recording_transcription')
        throw new ServiceError(
          'unsupported_retry',
          'This retry operation is only for saved-recording transcription.',
          409,
        );
      if (['queued', 'running', 'retry_wait'].includes(row.state)) return;
      if (row.state !== 'failed')
        throw new ServiceError(
          'job_not_retryable',
          'This job is complete or was explicitly cancelled. It cannot be resumed.',
          409,
        );
      await this.recordings.transcriptionSource(
        user,
        selected.recording_id,
        selected.seal_sha256,
        tx,
      );
      const progress = (
        await tx.query(
          'SELECT job_id FROM recording_transcription_runs WHERE job_id=$1',
          [id],
        )
      ).rowCount;
      if (row.progress !== null && !progress)
        throw new ServiceError(
          'transcription_progress_expired',
          'Processing progress expired. Explicitly start a new transcription to send audio again.',
          410,
        );
      const pending = await this.pendingWork(user, tx);
      if (pending >= 8)
        throw new ServiceError(
          'quota_exceeded',
          'At most eight pending jobs are allowed per user.',
          429,
          true,
        );
      await tx.query(
        "UPDATE jobs SET state='queued',attempt=0,error=NULL,lease_token=lease_token+1,lease_until=NULL,available_at=now(),updated_at=now() WHERE id=$1",
        [id],
      );
      await this.event(tx, id, 'job.accepted', {
        state: 'queued',
        resumed: true,
      });
    });
    return this.job(user, id);
  }
  private async enqueue(
    userId: string,
    id: string,
    kind: JobInput['kind'],
    key: string,
    hash: string,
    build: (doc: Document, tx: Transaction) => Promise<JobInput>,
    audio: Buffer | null = null,
  ): Promise<Job> {
    const jobId = await this.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `job-budget:${userId}`,
      ]);
      const doc = await this.document(userId, id, tx);
      const existing = await tx.query<{ id: string; request_hash: string }>(
        'SELECT id,request_hash FROM jobs WHERE document_id=$1 AND owner_id=$2 AND kind=$3 AND idempotency_key=$4',
        [id, userId, kind, key],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== hash)
          throw new ServiceError(
            'idempotency_conflict',
            'This idempotency key is bound to different input.',
            409,
          );
        return existing.rows[0].id;
      }
      if ((await this.pendingWork(userId, tx)) >= 8)
        throw new ServiceError(
          'quota_exceeded',
          'At most eight pending jobs are allowed per user.',
          429,
          true,
        );
      const input = jobInputSchema.parse(await build(doc, tx));
      const jobId = randomUUID();
      await tx.query(
        'INSERT INTO jobs (id,document_id,workspace_id,owner_id,kind,idempotency_key,request_hash,input,audio) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          jobId,
          id,
          doc.workspace_id,
          userId,
          kind,
          key,
          hash,
          JSON.stringify(input),
          audio,
        ],
      );
      await this.event(tx, jobId, 'job.accepted', { state: 'queued' });
      return jobId;
    });
    return this.job(userId, jobId);
  }
  async event(
    tx: Transaction,
    id: string,
    type: string,
    payload: unknown,
    notify = true,
  ) {
    const result = await tx.query<{ event_seq: number }>(
      'UPDATE jobs SET event_seq=event_seq+1 WHERE id=$1 RETURNING event_seq',
      [id],
    );
    await tx.query(
      'INSERT INTO job_events (job_id,seq,event_type,payload) VALUES ($1,$2,$3,$4)',
      [id, result.rows[0]!.event_seq, type, JSON.stringify(payload)],
    );
    if (!notify) return;
    const source = (
      await tx.query<{ document_id: string }>(
        'SELECT document_id FROM jobs WHERE id=$1',
        [id],
      )
    ).rows[0]!;
    await recordChange(tx, source.document_id, 'job', id);
  }
  async job(userId: string, id: string): Promise<Job> {
    const result = await this.pool.query<JobStatusRow>(
      jobStatusQuery +
        ' WHERE j.id=$1 AND j.owner_id=$2 AND d.deleted_at IS NULL',
      [id, userId],
    );
    const row = result.rows[0];
    if (!row)
      throw new ServiceError(
        'job_not_found',
        'The job is unavailable or not accessible.',
        404,
      );
    return jobView(row);
  }
  async jobs(
    userId: string,
    documentId: string,
    limit = 10,
    offset = 0,
  ): Promise<Job[]> {
    await this.document(userId, documentId);
    const result = await this.pool.query<JobStatusRow>(
      jobStatusQuery +
        ` WHERE j.document_id=$1 AND j.owner_id=$2 AND d.deleted_at IS NULL
      ORDER BY j.created_at DESC,j.id LIMIT $3 OFFSET $4`,
      [documentId, userId, limit, offset],
    );
    return result.rows.map(jobView);
  }
  async summarySource(
    userId: string,
    id: string,
    selected: z.infer<typeof summarySourceSchema>['citation'],
  ) {
    const row = (
      await this.pool.query<JobStatusRow>(
        jobStatusQuery +
          ' WHERE j.id=$1 AND j.owner_id=$2 AND d.deleted_at IS NULL',
        [id, userId],
      )
    ).rows[0];
    if (!row)
      throw new ServiceError(
        'job_not_found',
        'The job is unavailable or not accessible.',
        404,
      );
    const input = jobInputSchema.parse(row.input);
    const result = row.result === null ? null : resultSchema.parse(row.result);
    if (
      row.state !== 'succeeded' ||
      input.kind !== 'summary' ||
      result?.kind !== 'summary'
    )
      throw new ServiceError(
        'summary_unavailable',
        'This job has no completed summary evidence.',
        409,
      );
    if (
      !summaryCitations(result.summary).some(
        (citation) =>
          citation.source === selected.source &&
          citation.id === selected.id &&
          citation.revision === selected.revision,
      )
    )
      throw new ServiceError(
        'citation_not_found',
        'This source is not cited by the completed summary.',
        404,
      );
    const snapshot = input.snapshot;
    const segment =
      selected.source === 'transcript' &&
      selected.revision === snapshot.transcript_revision
        ? input.source
          ? (
              await this.transcripts.citations(
                userId,
                row.document_id,
                selected.revision,
                [selected.id],
              )
            )[0]
          : snapshot.segments.find((item) => item.id === selected.id)
        : undefined;
    if (
      selected.source === 'note'
        ? selected.id !== snapshot.document_id ||
          selected.revision !== snapshot.note_revision
        : !segment
    )
      throw new ServiceError(
        'citation_not_found',
        'The frozen source is unavailable.',
        404,
      );
    await this.document(userId, row.document_id);
    return summarySourceSchema.parse({
      document_id: row.document_id,
      job_id: row.id,
      citation: selected,
      text: selected.source === 'note' ? snapshot.notes : segment!.text,
      start_ms: segment?.start_ms ?? null,
      end_ms: segment?.end_ms ?? null,
    });
  }
  async events(userId: string, id: string, after: number) {
    const job = await this.job(userId, id);
    const bounds = await this.pool.query<{
      first: number | null;
      last: number;
    }>(
      'SELECT min(e.seq) first,j.event_seq last FROM jobs j LEFT JOIN job_events e ON e.job_id=j.id WHERE j.id=$1 GROUP BY j.event_seq',
      [id],
    );
    const bound = bounds.rows[0]!;
    if (after > bound.last)
      throw new ServiceError(
        'invalid_event_cursor',
        'The event cursor is ahead of this job.',
        400,
      );
    if (after < (bound.first ?? bound.last + 1) - 1)
      throw new ServiceError(
        'event_cursor_expired',
        'Replay events expired; fetch the authorized job snapshot.',
        410,
      );
    const rows = await this.pool.query<{
      seq: number;
      event_type: string;
      payload: unknown;
      created_at: Date;
    }>(
      `SELECT e.seq,e.event_type,e.payload,e.created_at FROM job_events e JOIN jobs j ON j.id=e.job_id
      JOIN documents d ON d.id=j.document_id
      JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=j.owner_id AND m.active
      JOIN users u ON u.id=j.owner_id AND u.active
      WHERE e.job_id=$1 AND e.seq>$2 AND j.owner_id=$3 AND d.deleted_at IS NULL ORDER BY e.seq LIMIT 50`,
      [id, after, userId],
    );
    return {
      terminal: terminal.has(job.state),
      events: rows.rows.map((row) =>
        jobEventSchema.parse({
          job_id: id,
          seq: row.seq,
          event_type: row.event_type,
          schema_version: 1,
          created_at: row.created_at.toISOString(),
          payload: row.payload,
        }),
      ),
    };
  }
  async eventState(userId: string, id: string) {
    const row = (
      await this.pool.query<JobStatusRow & { completed_stages: number }>(
        `SELECT v.*,(SELECT count(*)::integer FROM summary_steps s WHERE s.job_id=v.id AND s.state='completed') completed_stages
       FROM (${jobStatusQuery} WHERE j.id=$1 AND j.owner_id=$2 AND d.deleted_at IS NULL) v`,
        [id, userId],
      )
    ).rows[0];
    if (!row)
      throw new ServiceError(
        'job_not_found',
        'The job is unavailable or not accessible.',
        404,
      );
    return {
      job: jobView(row),
      last_event_id: row.event_seq,
      completed_stages: row.completed_stages,
    };
  }
  async cancel(userId: string, id: string) {
    const job = await this.job(userId, id);
    const alreadyTerminal = await this.transaction(async (tx) => {
      await this.document(userId, job.document_id, tx);
      const row = (
        await tx.query<{ state: string }>(
          'SELECT state FROM jobs WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0]!;
      if (terminal.has(row.state)) return true;
      await tx.query(
        "UPDATE jobs SET state='cancelled',audio=NULL,lease_token=lease_token+1,lease_until=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      await tx.query(
        'DELETE FROM recording_transcription_runs WHERE job_id=$1',
        [id],
      );
      await tx.query('DELETE FROM summary_runs WHERE job_id=$1', [id]);
      await this.event(tx, id, 'job.cancelled', { state: 'cancelled' });
      return false;
    });
    return {
      already_terminal: alreadyTerminal,
      job: await this.job(userId, id),
    };
  }
  async deleteDocument(userId: string, id: string) {
    await this.transaction(async (tx) => {
      await tx.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [id]);
      await this.document(userId, id, tx);
      await this.recordings.removeDocument(tx, id);
      await tx.query('DELETE FROM live_sources WHERE document_id=$1', [id]);
      await tx.query('DELETE FROM chat_threads WHERE document_id=$1', [id]);
      await tx.query('DELETE FROM chat_requests WHERE document_id=$1', [id]);
      await tx.query(
        'DELETE FROM recording_transcription_runs WHERE job_id IN (SELECT id FROM jobs WHERE document_id=$1)',
        [id],
      );
      await tx.query(
        "UPDATE documents SET deleted_at=now(),title='[deleted]',updated_at=now() WHERE id=$1",
        [id],
      );
      await tx.query(
        `UPDATE jobs SET state=CASE WHEN state IN ('queued','running','retry_wait') THEN 'cancelled' ELSE state END,
        input='{}'::jsonb,result=NULL,error=NULL,audio=NULL,lease_token=lease_token+1,lease_until=NULL WHERE document_id=$1`,
        [id],
      );
      await tx.query(
        'DELETE FROM summary_runs WHERE job_id IN (SELECT id FROM jobs WHERE document_id=$1)',
        [id],
      );
      await tx.query(
        'DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE document_id=$1)',
        [id],
      );
      await tx.query('DELETE FROM note_versions WHERE document_id=$1', [id]);
      await tx.query('DELETE FROM note_mutations WHERE document_id=$1', [id]);
      await tx.query('DELETE FROM transcript_revisions WHERE document_id=$1', [
        id,
      ]);
      await recordChange(tx, id, 'deleted');
    });
  }
  async claim(leaseMs = 120_000): Promise<ClaimedJob | null> {
    return this.transaction(async (tx) => {
      const row = (
        await tx.query<JobRow>(`
        SELECT j.* FROM jobs j JOIN documents d ON d.id=j.document_id
        JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=j.owner_id AND m.active
        JOIN users u ON u.id=j.owner_id AND u.active
        WHERE d.deleted_at IS NULL AND ((j.state IN ('queued','retry_wait') AND j.available_at<=now())
          OR (j.state='running' AND j.lease_until<now()))
        ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`)
      ).rows[0];
      if (!row) return null;
      if (row.attempt >= 3) {
        const error = {
          code: 'attempts_exhausted',
          message: 'The job exhausted its bounded recovery attempts.',
          retryable: false,
        };
        await tx.query(
          "UPDATE jobs SET state='failed',audio=NULL,error=$2,lease_token=lease_token+1,lease_until=NULL WHERE id=$1",
          [row.id, JSON.stringify(error)],
        );
        await this.event(tx, row.id, 'job.failed', error);
        return null;
      }
      const updated = (
        await tx.query<{ lease_token: number; attempt: number }>(
          `
        UPDATE jobs SET state='running',attempt=attempt+1,lease_token=lease_token+1,
        lease_until=now()+($2*interval '1 millisecond'),updated_at=now() WHERE id=$1 RETURNING lease_token,attempt`,
          [row.id, leaseMs],
        )
      ).rows[0]!;
      await this.event(tx, row.id, 'job.progress', {
        stage: 'provider_request',
        attempt: updated.attempt,
      });
      return {
        id: row.id,
        documentId: row.document_id,
        ownerId: row.owner_id,
        input: jobInputSchema.parse(row.input),
        audio: row.audio,
        leaseToken: updated.lease_token,
        attempt: updated.attempt,
      };
    });
  }
  async renew(job: ClaimedJob): Promise<boolean> {
    return (
      (
        await this.pool.query(
          `UPDATE jobs j SET lease_until=now()+interval '120 seconds' FROM documents d,memberships m,users u
      WHERE j.id=$1 AND j.lease_token=$2 AND j.state='running' AND j.lease_until>now()
      AND d.id=j.document_id AND d.deleted_at IS NULL AND m.workspace_id=d.workspace_id AND m.user_id=j.owner_id AND m.active
      AND u.id=j.owner_id AND u.active
      AND (j.kind<>'recording_transcription' OR EXISTS
        (SELECT 1 FROM recordings r WHERE r.id::text=j.input->>'recording_id' AND r.document_id=j.document_id
         AND r.deleted_at IS NULL AND r.retention_expires_at>now() AND r.seal_hash=j.input->>'seal_sha256'))`,
          [job.id, job.leaseToken],
        )
      ).rowCount === 1
    );
  }
  async finishRecording(job: ClaimedJob) {
    if (job.input.kind !== 'recording_transcription')
      throw new Error('Expected a recording transcription job.');
    return this.finish(job, null, null, undefined, true);
  }
  async finish(
    job: ClaimedJob,
    result: JobResult | null,
    failure: Failure | null,
    transcript?: Segment[],
    recordingComplete = false,
  ): Promise<boolean> {
    if (job.input.kind === 'recording_transcription' && (result || transcript))
      throw new Error(
        'Complete recording jobs through their durable source coordinator.',
      );
    if (
      recordingComplete &&
      (job.input.kind !== 'recording_transcription' || failure)
    )
      throw new Error(
        'Durable recording completion cannot publish a failure or another job kind.',
      );
    return this.transaction(async (tx) => {
      await tx.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [
        job.documentId,
      ]);
      const doc = (
        await tx.query<{ transcript_revision: number; allowed: boolean }>(
          `
        SELECT d.transcript_revision,(d.deleted_at IS NULL AND m.active AND u.active) allowed FROM documents d
        JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.owner_id JOIN users u ON u.id=d.owner_id
        WHERE d.id=$1`,
          [job.documentId],
        )
      ).rows[0];
      const row = (
        await tx.query<{ valid: boolean }>(
          `SELECT (state='running' AND lease_token=$2 AND lease_until>now()) valid FROM jobs WHERE id=$1 FOR UPDATE`,
          [job.id, job.leaseToken],
        )
      ).rows[0];
      if (!row?.valid) return false;
      if (!doc?.allowed) {
        await tx.query(
          'DELETE FROM recording_transcription_runs WHERE job_id=$1',
          [job.id],
        );
        await tx.query('DELETE FROM summary_runs WHERE job_id=$1', [job.id]);
        await tx.query(
          "UPDATE jobs SET state='cancelled',audio=NULL,result=NULL,error=NULL,lease_token=lease_token+1,lease_until=NULL WHERE id=$1",
          [job.id],
        );
        await this.event(tx, job.id, 'job.cancelled', {
          code: 'permission_revoked',
        });
        return false;
      }
      if (result && job.input.kind === 'transcription') {
        if (doc.transcript_revision !== job.input.base_transcript_revision) {
          result = null;
          failure = {
            code: 'revision_conflict',
            message: 'A newer transcript exists; it was not overwritten.',
            retryable: false,
          };
        } else {
          if (!transcript)
            throw new Error('Transcription completion requires segments.');
          if (result.kind !== 'transcription')
            throw new Error('Expected a clip transcription result.');
          const version = await this.transcripts.write(
            tx,
            job.ownerId,
            job.documentId,
            doc.transcript_revision,
            'azure_speech_fast',
            segmentsSchema.parse(transcript),
          );
          result = { ...result, transcript_revision: version };
        }
      }
      if (recordingComplete && job.input.kind === 'recording_transcription') {
        const generated = await this.recordingTranscriptions.output(tx, job);
        const applied =
          doc.transcript_revision === job.input.base_transcript_revision;
        const version = await this.transcripts.write(
          tx,
          job.ownerId,
          job.documentId,
          doc.transcript_revision,
          'azure_speech_fast',
          generated.segments,
          {
            candidate: !applied,
            basedOn: job.input.base_transcript_revision,
            recording: generated.recording,
            timeline: generated.timeline,
          },
        );
        result = resultSchema.parse({
          kind: 'recording_transcription',
          recording_id: job.input.recording_id,
          transcript_revision: version,
          segment_count: generated.segments.length,
          processed_chunks: generated.run.completed_chunks,
          uncertain_requests: generated.run.uncertain_requests,
          applied,
          partial: generated.recording.partial,
          provider: generated.run.provider,
          configuration_version: generated.run.configuration_version,
          usage: generated.run.usage,
        });
        await tx.query(
          'DELETE FROM recording_transcription_runs WHERE job_id=$1',
          [job.id],
        );
      }
      if (result) {
        await tx.query(
          "UPDATE jobs SET state='succeeded',audio=NULL,result=$2,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
          [job.id, JSON.stringify(result)],
        );
        await this.event(tx, job.id, 'output.completed', result);
      } else {
        if (!failure)
          throw new Error('Failed completion requires a structured failure.');
        const retry = failure.retryable && job.attempt < 3;
        const delayMs = Math.round(
          1000 * 2 ** (job.attempt - 1) + Math.random() * 500,
        );
        await tx.query(
          `UPDATE jobs SET state=$2,audio=CASE WHEN $3 THEN audio ELSE NULL END,error=$4,
          available_at=now()+($5*interval '1 millisecond'),lease_until=NULL,updated_at=now() WHERE id=$1`,
          [
            job.id,
            retry ? 'retry_wait' : 'failed',
            retry,
            JSON.stringify(failure),
            delayMs,
          ],
        );
        await this.event(tx, job.id, retry ? 'job.progress' : 'job.failed', {
          ...failure,
          retry_scheduled: retry,
        });
      }
      return true;
    });
  }
  async cleanup(): Promise<void> {
    await this.transaction(async (tx) => {
      const leader = await tx.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('windows-ai-notes-cleanup',0)) acquired",
      );
      if (!leader.rows[0]!.acquired) return;
      const expired = await tx.query<{ id: string }>(
        `SELECT id FROM jobs WHERE audio IS NOT NULL AND created_at<now()-interval '24 hours' AND state IN ('queued','retry_wait','running') FOR UPDATE SKIP LOCKED LIMIT 100`,
      );
      for (const { id } of expired.rows) {
        const failure = {
          code: 'audio_expired',
          message: 'Staged audio exceeded its 24-hour processing window.',
          retryable: false,
        };
        await tx.query(
          "UPDATE jobs SET state='failed',audio=NULL,error=$2,lease_token=lease_token+1,lease_until=NULL WHERE id=$1",
          [id, JSON.stringify(failure)],
        );
        await this.event(tx, id, 'job.failed', failure);
      }
      await tx.query(
        "DELETE FROM job_events WHERE created_at<now()-interval '7 days'",
      );
      await tx.query(
        `DELETE FROM recording_transcription_runs p USING jobs j,documents d,memberships m,users u
         WHERE p.job_id=j.id AND d.id=j.document_id AND m.workspace_id=d.workspace_id
         AND m.user_id=j.owner_id AND u.id=j.owner_id
         AND (d.deleted_at IS NOT NULL OR NOT m.active OR NOT u.active OR j.state IN ('cancelled','succeeded')
           OR (j.state='failed' AND j.updated_at<now()-interval '24 hours'))`,
      );
      await tx.query(
        `DELETE FROM summary_runs p USING jobs j,documents d,memberships m,users u
         WHERE p.job_id=j.id AND d.id=j.document_id AND m.workspace_id=d.workspace_id
         AND m.user_id=j.owner_id AND u.id=j.owner_id
         AND (d.deleted_at IS NOT NULL OR NOT m.active OR NOT u.active OR j.state='cancelled'
           OR (j.state='failed' AND j.updated_at<now()-interval '24 hours')
           OR (j.state='succeeded' AND j.updated_at<now()-interval '7 days'))`,
      );
      await this.sync.prune(tx);
      await this.live.prune(tx);
      await this.chat.prune(tx);
      await this.audit.prune(tx);
    });
  }
}

function jobView(row: JobStatusRow): Job {
  const input = jobInputSchema.parse(row.input);
  const result = row.result === null ? null : resultSchema.parse(row.result);
  const outputRevision =
    result?.kind === 'transcription' ||
    result?.kind === 'recording_transcription'
      ? result.transcript_revision
      : input.kind === 'summary'
        ? 0
        : input.base_transcript_revision;
  const stale =
    input.kind === 'summary'
      ? input.snapshot.note_revision !== row.current_note_revision ||
        input.snapshot.transcript_revision !== row.current_transcript_revision
      : (result?.kind === 'recording_transcription' && !result.applied) ||
        (row.state === 'succeeded'
          ? outputRevision
          : input.base_transcript_revision) !== row.current_transcript_revision;
  return jobSchema.parse({
    id: row.id,
    document_id: row.document_id,
    kind: row.kind,
    state: row.state,
    attempt: row.attempt,
    input_stale: stale,
    result: row.result,
    error: row.error,
    created_at: row.created_at.toISOString(),
    recording_id:
      input.kind === 'recording_transcription' ? input.recording_id : null,
    progress: row.progress,
  });
}
function conflict(current: number): ServiceError {
  return new ServiceError(
    'revision_conflict',
    'The resource changed; preserve both versions and retry explicitly.',
    409,
    false,
    { current_revision: current },
  );
}
