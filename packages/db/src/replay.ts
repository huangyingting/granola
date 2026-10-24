import { ServiceError } from '@windows-ai-notes/contracts/server';
import type { Database } from './index.js';

const resources = {
  job: {
    parent: 'jobs',
    events: 'job_events',
    key: 'job_id',
    unavailable: 'job_not_found',
    label: 'job',
    snapshot: 'job',
  },
  question: {
    parent: 'chat_turns',
    events: 'chat_events',
    key: 'turn_id',
    unavailable: 'chat_not_found',
    label: 'conversation',
    snapshot: 'turn',
  },
} as const;
interface Frame {
  seq: number;
  event_type: string;
  payload: unknown;
  created_at: Date;
}
type Row = {
  document_id: string;
  state: string;
  first: number | null;
  last: number;
  expired: number | null;
} & (Frame | { seq: null; event_type: null; payload: null; created_at: null });

export async function readReplay(
  database: Database,
  kind: keyof typeof resources,
  user: string,
  id: string,
  after: number,
) {
  const resource = resources[kind];
  const invalidCursor = () =>
    new ServiceError(
      'invalid_event_cursor',
      'The event sequence is outside this task.',
      400,
    );
  if (!Number.isInteger(after) || after < 0 || after > 2_147_483_647)
    throw invalidCursor();
  const rows = (
    await database.pool.query<Row>(
      `WITH authorized AS MATERIALIZED (
         SELECT p.id,p.document_id,p.state,p.event_seq FROM ${resource.parent} p
         JOIN documents d ON d.id=p.document_id ${kind === 'question' ? 'AND d.owner_id=p.owner_id' : ''}
         JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=p.owner_id AND m.active
         JOIN users u ON u.id=p.owner_id AND u.active
         WHERE p.id=$1 AND p.owner_id=$2 AND d.deleted_at IS NULL
       ), bounds AS (
         SELECT p.id,p.document_id,p.state,p.event_seq last,min(e.seq) first,
           max(e.seq) FILTER (WHERE e.created_at<now()-interval '7 days') expired
         FROM authorized p LEFT JOIN ${resource.events} e ON e.${resource.key}=p.id
         GROUP BY p.id,p.document_id,p.state,p.event_seq
       )
       SELECT b.document_id,b.state,b.first,b.last,b.expired,e.* FROM bounds b
       LEFT JOIN LATERAL (
         SELECT seq,event_type,payload,created_at FROM ${resource.events}
         WHERE ${resource.key}=b.id AND seq>$3 AND created_at>=now()-interval '7 days'
         ORDER BY seq LIMIT 50
       ) e ON true ORDER BY e.seq`,
      [id, user, after],
    )
  ).rows;
  const bounds = rows[0];
  if (!bounds)
    throw new ServiceError(
      resource.unavailable,
      `The ${resource.label} is unavailable or not accessible.`,
      404,
    );
  if (after > bounds.last) throw invalidCursor();
  const expired = () =>
    new ServiceError(
      'event_cursor_expired',
      `Replay events expired; fetch the authorized ${resource.snapshot} snapshot.`,
      410,
    );
  if (
    after < Math.max((bounds.first ?? bounds.last + 1) - 1, bounds.expired ?? 0)
  )
    throw expired();
  const events: Frame[] = [];
  let next = after + 1;
  for (const row of rows) {
    if (row.seq === null) continue;
    if (row.seq !== next || row.seq > bounds.last) throw expired();
    events.push({
      seq: row.seq,
      event_type: row.event_type,
      payload: row.payload,
      created_at: row.created_at,
    });
    next++;
  }
  if (events.length < 50 && next - 1 < bounds.last) throw expired();
  return {
    document_id: bounds.document_id,
    terminal: ['succeeded', 'failed', 'cancelled'].includes(bounds.state),
    events,
  };
}
