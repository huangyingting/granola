import type { Transaction } from './index.js';

export async function cleanupBatch<T>(
  after: string | null,
  select: (
    after: string | null,
    before: string | null,
    limit: number,
  ) => Promise<{ rows: T[] }>,
): Promise<T[]> {
  const rows = (await select(after, null, 100)).rows;
  if (rows.length < 100 && after !== null)
    rows.push(...(await select(null, after, 100 - rows.length)).rows);
  return rows;
}

async function retireRuns(
  tx: Transaction,
  table: 'recording_transcription_runs' | 'summary_runs',
  visited: string[],
  expired: string[],
) {
  // Strong parent locks fence new FK children until empty-parent deletion commits.
  const rows = (
    await tx.query<{ id: string }>(
      `SELECT job_id id FROM ${table}
       WHERE job_id=ANY($1::uuid[]) AND (retired_at IS NOT NULL OR job_id=ANY($2::uuid[]))
       ORDER BY job_id FOR UPDATE SKIP LOCKED`,
      [visited, expired],
    )
  ).rows;
  const ids = rows.map((row) => row.id);
  if (ids.length)
    await tx.query(
      `UPDATE ${table} SET retired_at=now() WHERE job_id=ANY($1::uuid[]) AND retired_at IS NULL`,
      [ids],
    );
  return ids;
}

export async function pruneJobHistory(tx: Transaction): Promise<void> {
  const checkpoint = (
    await tx.query<{ job_id: string | null }>(
      'SELECT job_id FROM job_cleanup_cursor WHERE singleton FOR UPDATE',
    )
  ).rows[0];
  if (!checkpoint) throw new Error('The job cleanup cursor is missing.');
  const jobs = await cleanupBatch(checkpoint.job_id, (after, before, limit) =>
    tx.query<{
      id: string;
      recording_expired: boolean;
      summary_expired: boolean;
    }>(
      `WITH batch AS MATERIALIZED (
           SELECT id,document_id,owner_id,state,updated_at FROM jobs
           WHERE ($1::uuid IS NULL OR id>$1) AND ($2::uuid IS NULL OR id<=$2)
           ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED
         )
         SELECT j.id,
           (d.deleted_at IS NOT NULL OR NOT m.active OR NOT u.active
             OR j.state IN ('cancelled','succeeded')
             OR (j.state='failed' AND j.updated_at<now()-interval '24 hours')) recording_expired,
           (d.deleted_at IS NOT NULL OR NOT m.active OR NOT u.active OR j.state='cancelled'
             OR (j.state='failed' AND j.updated_at<now()-interval '24 hours')
             OR (j.state='succeeded' AND j.updated_at<now()-interval '7 days')) summary_expired
         FROM batch j JOIN documents d ON d.id=j.document_id
         JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=j.owner_id
         JOIN users u ON u.id=j.owner_id ORDER BY j.id`,
      [after, before, limit],
    ),
  );
  let eventsRemaining = 1000;
  for (const job of jobs) {
    if (!eventsRemaining) break;
    const head = (
      await tx.query<{ seq: number; retained: boolean }>(
        `SELECT seq,created_at>=now()-interval '7 days' retained FROM job_events
         WHERE job_id=$1 ORDER BY seq LIMIT $2`,
        [job.id, eventsRemaining],
      )
    ).rows;
    const retained = head.findIndex((row) => row.retained);
    const expired = head
      .slice(0, retained === -1 ? head.length : retained)
      .map((row) => row.seq);
    if (expired.length) {
      const locked = new Set(
        (
          await tx.query<{ seq: number }>(
            `SELECT seq FROM job_events WHERE job_id=$1 AND seq=ANY($2::integer[])
             AND created_at<now()-interval '7 days' ORDER BY seq FOR UPDATE SKIP LOCKED`,
            [job.id, expired],
          )
        ).rows.map((row) => row.seq),
      );
      const firstBusy = expired.findIndex((seq) => !locked.has(seq));
      const prefix = expired.slice(
        0,
        firstBusy === -1 ? expired.length : firstBusy,
      );
      if (!prefix.length) continue;
      await tx.query(
        'DELETE FROM job_events WHERE job_id=$1 AND seq=ANY($2::integer[])',
        [job.id, prefix],
      );
      eventsRemaining -= prefix.length;
    }
  }
  if (jobs.length) {
    const ids = jobs.map((row) => row.id);
    const recordings = await retireRuns(
      tx,
      'recording_transcription_runs',
      ids,
      jobs.filter((row) => row.recording_expired).map((row) => row.id),
    );
    if (recordings.length) {
      await tx.query(
        `WITH expired AS (
           SELECT job_id,chunk_id FROM recording_transcription_chunks
           WHERE job_id=ANY($1::uuid[]) ORDER BY job_id,chunk_id LIMIT 1000 FOR UPDATE SKIP LOCKED
         )
         DELETE FROM recording_transcription_chunks c USING expired e
         WHERE c.job_id=e.job_id AND c.chunk_id=e.chunk_id`,
        [recordings],
      );
      await tx.query(
        `DELETE FROM recording_transcription_runs p WHERE job_id=ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM recording_transcription_chunks c WHERE c.job_id=p.job_id)`,
        [recordings],
      );
    }
    const summaries = await retireRuns(
      tx,
      'summary_runs',
      ids,
      jobs.filter((row) => row.summary_expired).map((row) => row.id),
    );
    if (summaries.length) {
      await tx.query(
        `WITH expired AS (
           SELECT job_id,phase,round,ordinal FROM summary_steps WHERE job_id=ANY($1::uuid[])
           ORDER BY job_id,phase,round,ordinal LIMIT 1000 FOR UPDATE SKIP LOCKED
         )
         DELETE FROM summary_steps s USING expired e
         WHERE s.job_id=e.job_id AND s.phase=e.phase AND s.round=e.round AND s.ordinal=e.ordinal`,
        [summaries],
      );
      await tx.query(
        `WITH expired AS (
           SELECT job_id,token FROM summary_resumes WHERE job_id=ANY($1::uuid[])
           ORDER BY job_id,token LIMIT 1000 FOR UPDATE SKIP LOCKED
         )
         DELETE FROM summary_resumes s USING expired e WHERE s.job_id=e.job_id AND s.token=e.token`,
        [summaries],
      );
      await tx.query(
        `DELETE FROM summary_runs p WHERE job_id=ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM summary_steps s WHERE s.job_id=p.job_id)
         AND NOT EXISTS (SELECT 1 FROM summary_resumes r WHERE r.job_id=p.job_id)`,
        [summaries],
      );
    }
  }
  await tx.query('UPDATE job_cleanup_cursor SET job_id=$1 WHERE singleton', [
    jobs.at(-1)?.id ?? null,
  ]);
}
