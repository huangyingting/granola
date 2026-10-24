import { z } from 'zod';
import { resourceId, ServiceError } from '@windows-ai-notes/contracts/server';
import type { Database, Document, Transaction } from './index.js';

const cursorSchema = z.strictObject({
  version: z.literal(1),
  workspace: resourceId,
  user: resourceId,
  epoch: z.number().int().positive(),
  seq: z.string().regex(/^(0|[1-9]\d{0,18})$/),
});
interface Access {
  sync_seq: string;
  sync_floor: string;
  sync_epoch: number;
}
function cursor(
  workspace: string,
  user: string,
  access: Access,
  seq = access.sync_seq,
) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      workspace,
      user,
      epoch: access.sync_epoch,
      seq,
    }),
  ).toString('base64url');
}
function readCursor(
  token: string,
  workspace: string,
  user: string,
  access: Access,
): string {
  let parsed: z.infer<typeof cursorSchema>;
  try {
    if (token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new Error('Invalid encoding.');
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token)
      throw new Error('Invalid encoding.');
    parsed = cursorSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch {
    throw new ServiceError(
      'invalid_sync_cursor',
      'The workspace cursor is invalid.',
      400,
    );
  }
  if (
    parsed.workspace !== workspace ||
    parsed.user !== user ||
    BigInt(parsed.seq) > BigInt(access.sync_seq)
  )
    throw new ServiceError(
      'invalid_sync_cursor',
      'The workspace cursor does not belong to this request.',
      400,
    );
  if (
    parsed.epoch !== access.sync_epoch ||
    BigInt(parsed.seq) < BigInt(access.sync_floor)
  )
    throw new ServiceError(
      'sync_cursor_expired',
      'Fetch a new workspace snapshot while preserving pending local edits.',
      410,
      false,
      { reset_required: true },
    );
  return parsed.seq;
}
async function access(
  tx: Transaction,
  workspace: string,
  user: string,
): Promise<Access> {
  const result = await tx.query<Access>(
    `SELECT w.sync_seq,w.sync_floor,m.sync_epoch FROM workspaces w
    JOIN memberships m ON m.workspace_id=w.id JOIN users u ON u.id=m.user_id
    WHERE w.id=$1 AND m.user_id=$2 AND m.active AND u.active`,
    [workspace, user],
  );
  if (!result.rows[0])
    throw new ServiceError(
      'workspace_access_revoked',
      'Workspace access is unavailable. Remove its cached content.',
      403,
      false,
      { purge_workspace_id: workspace },
    );
  return result.rows[0];
}
export async function recordChange(
  tx: Transaction,
  documentId: string,
  kind: 'document' | 'transcript' | 'job' | 'deleted',
  jobId: string | null = null,
): Promise<void> {
  const source = (
    await tx.query<{
      workspace_id: string;
      owner_id: string;
      revision: number;
      transcript_revision: number;
    }>(
      'SELECT workspace_id,owner_id,revision,transcript_revision FROM documents WHERE id=$1',
      [documentId],
    )
  ).rows[0];
  if (!source)
    throw new Error('A synchronization change requires its source document.');
  const sequence = (
    await tx.query<{ sync_seq: string }>(
      'UPDATE workspaces SET sync_seq=sync_seq+1 WHERE id=$1 RETURNING sync_seq',
      [source.workspace_id],
    )
  ).rows[0]!;
  await tx.query(
    `INSERT INTO sync_changes (workspace_id,seq,owner_id,document_id,kind,revision,transcript_revision,job_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      source.workspace_id,
      sequence.sync_seq,
      source.owner_id,
      documentId,
      kind,
      source.revision,
      source.transcript_revision,
      jobId,
    ],
  );
}

export class SyncStore {
  constructor(private readonly database: Database) {}
  async snapshot(
    user: string,
    workspace: string,
    token?: string,
    after?: string,
    limit = 10,
  ) {
    return this.database.transaction(async (tx) => {
      const allowed = await access(tx, workspace, user);
      const watermark = token
        ? readCursor(token, workspace, user, allowed)
        : allowed.sync_seq;
      const result = await tx.query<Document>(
        `SELECT d.id,d.workspace_id,d.owner_id,d.title,d.tags,d.revision,d.transcript_revision,
        d.created_at,d.updated_at,n.notes,n.content FROM documents d
        JOIN note_versions n ON n.document_id=d.id AND n.revision=d.revision
        JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.owner_id
        JOIN users u ON u.id=d.owner_id
        WHERE d.workspace_id=$1 AND d.owner_id=$2 AND d.deleted_at IS NULL AND m.active AND u.active
        AND ($3::uuid IS NULL OR d.id>$3) ORDER BY d.id LIMIT $4`,
        [workspace, user, after ?? null, limit + 1],
      );
      const documents = result.rows.slice(0, limit);
      const hasMore = result.rows.length > limit;
      return {
        documents,
        cursor: cursor(workspace, user, allowed, watermark),
        next_after: hasMore ? documents.at(-1)!.id : null,
        has_more: hasMore,
      };
    });
  }
  async changes(user: string, workspace: string, token: string, limit = 50) {
    return this.database.transaction(async (tx) => {
      const allowed = await access(tx, workspace, user);
      const after = readCursor(token, workspace, user, allowed);
      const result = await tx.query<{
        seq: string;
        document_id: string;
        kind: 'document' | 'transcript' | 'job' | 'deleted';
        revision: number;
        transcript_revision: number;
        job_id: string | null;
        created_at: Date;
      }>(
        `SELECT c.seq,c.document_id,c.kind,c.revision,c.transcript_revision,c.job_id,c.created_at FROM sync_changes c
        JOIN memberships m ON m.workspace_id=c.workspace_id AND m.user_id=c.owner_id
        JOIN users u ON u.id=c.owner_id
        WHERE c.workspace_id=$1 AND c.owner_id=$2 AND c.seq>$3 AND c.seq<=$4 AND m.active AND u.active
        ORDER BY c.seq LIMIT $5`,
        [workspace, user, after, allowed.sync_seq, limit + 1],
      );
      const changes = result.rows.slice(0, limit);
      const hasMore = result.rows.length > limit;
      return {
        changes: changes.map((change) => ({
          ...change,
          created_at: change.created_at.toISOString(),
        })),
        cursor: cursor(
          workspace,
          user,
          allowed,
          hasMore ? changes.at(-1)!.seq : allowed.sync_seq,
        ),
        has_more: hasMore,
      };
    });
  }
  async prune(tx: Transaction): Promise<void> {
    const checkpoint = (
      await tx.query<{ workspace_id: string | null }>(
        'SELECT workspace_id FROM sync_cleanup_cursor WHERE singleton FOR UPDATE',
      )
    ).rows[0];
    if (!checkpoint)
      throw new Error('The synchronization cleanup cursor is missing.');
    const select = (
      after: string | null,
      before: string | null,
      limit: number,
    ) =>
      tx.query<Pick<Access, 'sync_seq' | 'sync_floor'> & { id: string }>(
        `SELECT id,sync_seq,sync_floor FROM workspaces
         WHERE ($1::uuid IS NULL OR id>$1) AND ($2::uuid IS NULL OR id<=$2) ORDER BY id
         LIMIT $3 FOR NO KEY UPDATE SKIP LOCKED`,
        [after, before, limit],
      );
    const workspaces = (await select(checkpoint.workspace_id, null, 100)).rows;
    if (workspaces.length < 100 && checkpoint.workspace_id !== null)
      workspaces.push(
        ...(
          await select(null, checkpoint.workspace_id, 100 - workspaces.length)
        ).rows,
      );
    for (const workspace of workspaces) {
      const head = (
        await tx.query<{ seq: string; retained: boolean }>(
          `SELECT seq,created_at>=now()-interval '7 days' retained FROM sync_changes
           WHERE workspace_id=$1 ORDER BY seq LIMIT 1000`,
          [workspace.id],
        )
      ).rows;
      const previous = BigInt(workspace.sync_floor);
      const retained = head.find(
        (row) => BigInt(row.seq) > previous && row.retained,
      );
      const last = head.at(-1);
      let floor = retained
        ? BigInt(retained.seq) - 1n
        : head.length < 1000
          ? BigInt(workspace.sync_seq)
          : BigInt(last!.seq);
      if (floor < previous) floor = previous;
      if (floor !== previous)
        await tx.query('UPDATE workspaces SET sync_floor=$2 WHERE id=$1', [
          workspace.id,
          floor.toString(),
        ]);
      const expired = head
        .filter((row) => BigInt(row.seq) <= floor)
        .map((row) => row.seq);
      if (expired.length) {
        await tx.query(
          'DELETE FROM sync_changes WHERE workspace_id=$1 AND seq=ANY($2::bigint[])',
          [workspace.id, expired],
        );
      }
    }
    await tx.query(
      'UPDATE sync_cleanup_cursor SET workspace_id=$1 WHERE singleton',
      [workspaces.at(-1)?.id ?? null],
    );
  }
}
