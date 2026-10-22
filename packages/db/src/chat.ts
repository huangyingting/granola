import { randomUUID } from 'node:crypto';
import {
  ServiceError,
  citationKey,
  type Citation,
  type Failure,
} from '@windows-ai-notes/contracts/server';
import {
  chatEventSchema,
  chatPreviewSchema,
  chatResultSchema,
  chatSourceSchema,
  chatSubmissionSchema,
  chatThreadSchema,
  chatTurnSchema,
  questionContextSchema,
  questionEvidenceSchema,
  questionPromptVersion,
  validateQuestionAnswer,
  type ChatEvent,
  type ChatResult,
  type ChatSubmission,
  type ChatTurn,
  type QuestionContext,
  type QuestionEvidence,
} from '@windows-ai-notes/contracts/questions';
import { digest, type Database, type Transaction } from './index.js';
import { usageTotals, type UsageReservation } from './usage.js';

export interface ClaimedChat {
  id: string;
  ownerId: string;
  documentId: string;
  leaseToken: number;
  evidence: QuestionEvidence;
}
interface Row {
  id: string;
  thread_id: string;
  document_id: string;
  owner_id: string;
  position: number;
  request: unknown;
  request_hash: string;
  evidence: unknown | null;
  evidence_hash: string;
  mode: 'full' | 'retrieved';
  state: ChatTurn['state'];
  dispatch: 'pending' | 'sending';
  attempt: number;
  lease_token: number;
  lease_until: Date | null;
  provider: ChatResult['provider'] | null;
  configuration_version: string | null;
  prompt_version: string | null;
  call_id: string | null;
  preview_text: string | null;
  preview_updates: number;
  result: unknown | null;
  error: unknown | null;
  resume_token: string | null;
  event_seq: number;
  expires_at: Date;
  created_at: Date;
  current_note_revision: number;
  current_transcript_revision: number;
  last_position: number;
  provider_requests: number;
  uncertain_requests: number;
  fresh: boolean;
  leased: boolean;
  first_event: number;
}
const access = `
 JOIN documents d ON d.id=t.document_id AND d.owner_id=t.owner_id
 JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=t.owner_id AND m.active
 JOIN users u ON u.id=t.owner_id AND u.active`;
const query = `SELECT t.*,h.last_position,
 d.revision current_note_revision,d.transcript_revision current_transcript_revision,
 t.expires_at>now() fresh,t.lease_until>now() leased,
 (SELECT count(*)::int FROM ai_usage_calls c WHERE c.chat_turn_id=t.id) provider_requests,
 (SELECT count(*)::int FROM ai_usage_calls c WHERE c.chat_turn_id=t.id AND c.actual IS NULL) uncertain_requests,
 coalesce((SELECT min(seq) FROM chat_events e WHERE e.turn_id=t.id),t.event_seq+1) first_event
 FROM chat_turns t JOIN chat_threads h ON h.id=t.thread_id ${access}`;
const unavailable = () =>
  new ServiceError(
    'chat_not_found',
    'This conversation is unavailable or not accessible.',
    404,
  );
const changed = () =>
  new ServiceError(
    'question_input_changed',
    'The frozen question input is inconsistent. Confirm a new request instead.',
    410,
  );
const needsNew = new Set([
  'question_input_changed',
  'question_progress_expired',
  'question_identity_changed',
]);
const terminal = (state: string) =>
  ['succeeded', 'failed', 'cancelled'].includes(state);
function resumable(row: Row) {
  return (
    row.state === 'failed' &&
    row.fresh &&
    row.evidence !== null &&
    row.attempt < 3 &&
    row.position === row.last_position &&
    !(
      row.error &&
      typeof row.error === 'object' &&
      'code' in row.error &&
      needsNew.has(String(row.error.code))
    )
  );
}
function view(row: Row): ChatTurn {
  const request = chatSubmissionSchema.parse(row.request);
  const resume = resumable(row) && row.resume_token !== null;
  return chatTurnSchema.parse({
    id: row.id,
    thread_id: row.thread_id,
    document_id: row.document_id,
    position: row.position,
    request,
    mode: row.mode,
    state: row.state,
    attempt: row.attempt,
    input_stale:
      request.note_revision !== row.current_note_revision ||
      request.transcript_revision !== row.current_transcript_revision,
    result: row.result,
    error: row.error,
    resume_available: resume,
    resume_token: resume ? row.resume_token : null,
    provider_requests: row.provider_requests,
    uncertain_requests: row.uncertain_requests,
    last_event_id: row.event_seq,
    created_at: row.created_at.toISOString(),
  });
}
function frozen(row: Row) {
  const parsed = questionEvidenceSchema.safeParse(row.evidence);
  const request = chatSubmissionSchema.safeParse(row.request);
  const fields = [
    'question',
    'language',
    'note_revision',
    'transcript_revision',
  ] as const;
  if (
    !parsed.success ||
    !request.success ||
    digest(request.data) !== row.request_hash ||
    digest(parsed.data, true) !== row.evidence_hash ||
    parsed.data.document_id !== row.document_id ||
    fields.some((field) => parsed.data[field] !== request.data[field])
  )
    throw changed();
  return parsed.data;
}

export class ChatStore {
  constructor(private readonly database: Database) {}

  private async authorize(tx: Transaction, user: string, document: string) {
    if (
      !(
        await tx.query(
          'SELECT id FROM users WHERE id=$1 AND active FOR SHARE',
          [user],
        )
      ).rowCount
    )
      throw unavailable();
    const doc = await this.database.document(user, document, tx);
    if (
      !(
        await tx.query(
          'SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND active FOR SHARE',
          [doc.workspace_id, user],
        )
      ).rowCount
    )
      throw unavailable();
    return doc;
  }
  private async row(user: string, id: string, tx?: Transaction, lock = false) {
    const row = (
      await (tx ?? this.database.pool).query<Row>(
        `${query} WHERE t.id=$1 AND t.owner_id=$2 AND d.deleted_at IS NULL${lock ? ' FOR UPDATE OF t' : ''}`,
        [id, user],
      )
    ).rows[0];
    if (!row) throw unavailable();
    return row;
  }
  async get(user: string, id: string) {
    return view(await this.row(user, id));
  }
  async authorizeClaim(tx: Transaction, claim: ClaimedChat) {
    await this.authorize(tx, claim.ownerId, claim.documentId);
    const row = await this.row(claim.ownerId, claim.id, tx, true);
    if (
      row.document_id !== claim.documentId ||
      row.state !== 'running' ||
      !row.leased ||
      row.lease_token !== claim.leaseToken
    )
      throw new ServiceError(
        'chat_lease_lost',
        'This worker no longer owns the question.',
        409,
      );
    if (!row.fresh || !row.evidence)
      throw new ServiceError(
        'question_progress_expired',
        'The frozen question expired. Confirm a new request.',
        410,
      );
    if (digest(frozen(row), true) !== digest(claim.evidence, true))
      throw changed();
    return row;
  }
  private async event(
    tx: Transaction,
    id: string,
    type: ChatEvent['event_type'],
    payload: unknown,
  ) {
    await tx.query(
      `WITH next AS (UPDATE chat_turns SET event_seq=event_seq+1 WHERE id=$1 RETURNING event_seq)
       INSERT INTO chat_events(turn_id,seq,event_type,payload) SELECT $1,event_seq,$2,$3 FROM next`,
      [id, type, JSON.stringify(payload)],
    );
  }
  private async budget(tx: Transaction, user: string) {
    if ((await this.database.pendingWork(user, tx)) >= 8)
      throw new ServiceError(
        'quota_exceeded',
        'At most eight pending AI jobs and questions are allowed per user.',
        429,
        true,
      );
  }
  private async context(
    tx: Transaction,
    thread: string,
  ): Promise<QuestionContext | undefined> {
    const rows = await tx.query<{ request: unknown; result: unknown }>(
      `SELECT request,result FROM chat_turns WHERE thread_id=$1 AND state='succeeded' ORDER BY position DESC LIMIT 2`,
      [thread],
    );
    const turns: QuestionContext['turns'] = [];
    for (const row of rows.rows) {
      const turn = {
        question: chatSubmissionSchema.parse(row.request).question,
        answer: chatResultSchema.parse(row.result).answer.answer.text,
      };
      if (
        questionContextSchema.safeParse({
          version: 'meeting-question-context-v1',
          turns: [turn, ...turns],
        }).success
      )
        turns.unshift(turn);
    }
    return turns.length
      ? { version: 'meeting-question-context-v1', turns }
      : undefined;
  }
  async enqueue(
    user: string,
    document: string,
    value: ChatSubmission,
    key: string,
  ) {
    const request = chatSubmissionSchema.parse(value);
    const id = await this.database.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `job-budget:${user}`,
      ]);
      await this.authorize(tx, user, document);
      const existing = (
        await tx.query<{ id: string | null; request_hash: string }>(
          'SELECT turn_id id,request_hash FROM chat_requests WHERE document_id=$1 AND owner_id=$2 AND idempotency_key=$3',
          [document, user, key],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== digest(request))
          throw new ServiceError(
            'idempotency_conflict',
            'This question key is bound to different input.',
            409,
          );
        if (!existing.id)
          throw new ServiceError(
            'chat_request_deleted',
            'This question was deleted. Its original request key cannot create it again.',
            410,
          );
        return existing.id;
      }
      await this.budget(tx, user);
      let thread = request.thread_id;
      let position = 1;
      let context: QuestionContext | undefined;
      if (thread) {
        const row = (
          await tx.query<{ last_position: number }>(
            'SELECT last_position FROM chat_threads WHERE id=$1 AND document_id=$2 AND owner_id=$3 FOR UPDATE',
            [thread, document, user],
          )
        ).rows[0];
        if (!row) throw unavailable();
        if (
          (
            await tx.query(
              "SELECT id FROM chat_turns WHERE thread_id=$1 AND state IN ('queued','running')",
              [thread],
            )
          ).rowCount
        )
          throw new ServiceError(
            'chat_turn_pending',
            'Wait for or cancel the current question before submitting another.',
            409,
          );
        if (row.last_position >= 100_000)
          throw new ServiceError(
            'chat_thread_full',
            'This conversation is full. Start a new conversation.',
            409,
          );
        position = row.last_position + 1;
        context = await this.context(tx, thread);
      }
      const {
        thread_id: _thread,
        confirmed: _confirmed,
        ...question
      } = request;
      const evidence = await this.database.questions.evidence(
        user,
        document,
        question,
        tx,
        context,
      );
      if (!thread) {
        thread = randomUUID();
        const title = request.question
          .trim()
          .slice(0, 200)
          .replace(/[\uD800-\uDBFF]$/u, '');
        await tx.query(
          'INSERT INTO chat_threads(id,document_id,owner_id,title,last_position) VALUES ($1,$2,$3,$4,1)',
          [thread, document, user, title],
        );
      } else
        await tx.query('UPDATE chat_threads SET last_position=$2 WHERE id=$1', [
          thread,
          position,
        ]);
      const id = randomUUID();
      await tx.query(
        `INSERT INTO chat_turns(id,thread_id,document_id,owner_id,position,idempotency_key,request_hash,request,evidence,evidence_hash,mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          thread,
          document,
          user,
          position,
          key,
          digest(request),
          JSON.stringify(request),
          JSON.stringify(evidence),
          digest(evidence, true),
          evidence.mode,
        ],
      );
      await tx.query(
        'INSERT INTO chat_requests(document_id,owner_id,idempotency_key,request_hash,turn_id) VALUES ($1,$2,$3,$4,$5)',
        [document, user, key, digest(request), id],
      );
      await this.event(tx, id, 'turn.accepted', { state: 'queued' });
      return id;
    });
    return this.get(user, id);
  }
  async threads(user: string, document: string, offset: number) {
    await this.database.document(user, document);
    const rows = await this.database.pool.query<{
      id: string;
      document_id: string;
      title: string;
      last_position: number;
      created_at: Date;
    }>(
      `SELECT t.id,t.document_id,t.title,t.last_position,t.created_at FROM chat_threads t ${access}
        WHERE t.document_id=$1 AND t.owner_id=$2 AND d.deleted_at IS NULL ORDER BY t.created_at DESC,t.id DESC LIMIT 51 OFFSET $3`,
      [document, user, offset],
    );
    return {
      threads: rows.rows.slice(0, 50).map((row) =>
        chatThreadSchema.parse({
          ...row,
          created_at: row.created_at.toISOString(),
        }),
      ),
      has_more: rows.rows.length > 50,
    };
  }
  async history(user: string, thread: string, after: number) {
    const visible = await this.database.pool.query<{ document_id: string }>(
      `SELECT t.document_id FROM chat_threads t ${access} WHERE t.id=$1 AND t.owner_id=$2 AND d.deleted_at IS NULL`,
      [thread, user],
    );
    if (!visible.rowCount) throw unavailable();
    const rows = await this.database.pool.query<Row>(
      `${query} WHERE t.thread_id=$1 AND t.owner_id=$2 AND t.position>$3 AND d.deleted_at IS NULL ORDER BY t.position LIMIT 51`,
      [thread, user, after],
    );
    await this.database.document(user, visible.rows[0]!.document_id);
    return {
      turns: rows.rows.slice(0, 50).map(view),
      has_more: rows.rows.length > 50,
    };
  }
  async remove(user: string, thread: string) {
    const visible = await this.history(user, thread, 0);
    if (!visible.turns[0]) throw unavailable();
    await this.database.transaction(async (tx) => {
      await this.authorize(tx, user, visible.turns[0]!.document_id);
      await tx.query('DELETE FROM chat_threads WHERE id=$1 AND owner_id=$2', [
        thread,
        user,
      ]);
    });
    return { deleted: true };
  }
  async claim(): Promise<ClaimedChat | null> {
    return this.database.transaction(async (tx) => {
      const row = (
        await tx.query<Row>(
          `${query} WHERE d.deleted_at IS NULL AND t.expires_at>now()
         AND (t.state='queued' OR (t.state='running' AND t.lease_until<now()))
         AND t.created_at<=coalesce((
           SELECT min(j.created_at) FROM jobs j JOIN documents jd ON jd.id=j.document_id
           JOIN memberships jm ON jm.workspace_id=jd.workspace_id AND jm.user_id=j.owner_id AND jm.active
           JOIN users ju ON ju.id=j.owner_id AND ju.active
           WHERE jd.deleted_at IS NULL AND ((j.state IN ('queued','retry_wait') AND j.available_at<=now())
             OR (j.state='running' AND j.lease_until<now()))
         ),'infinity'::timestamptz)
         ORDER BY t.created_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1`,
        )
      ).rows[0];
      if (!row) return null;
      let input: QuestionEvidence;
      try {
        input = frozen(row);
      } catch (error) {
        if (!(
          error instanceof ServiceError &&
          error.code === 'question_input_changed'
        ))
          throw error;
        const failure: Failure = {
          code: error.code,
          message: error.message,
          retryable: false,
        };
        await tx.query(
          "UPDATE chat_turns SET state='failed',error=$2,lease_until=NULL,resume_token=NULL,preview_text=NULL WHERE id=$1",
          [row.id, JSON.stringify(failure)],
        );
        await this.event(tx, row.id, 'turn.failed', failure);
        return null;
      }
      if (row.dispatch === 'sending' || row.attempt >= 3) {
        const exhausted = row.dispatch !== 'sending';
        const error: Failure = {
          code: exhausted
            ? 'question_attempts_exhausted'
            : 'question_dispatch_unconfirmed',
          message: exhausted
            ? 'This question exhausted its bounded worker attempts. Confirm a new request if still needed.'
            : 'The previous question attempt has no saved answer. Usage is retained; explicitly confirm recovery before another paid request.',
          retryable: false,
        };
        await tx.query(
          `UPDATE chat_turns SET state='failed',error=$2,resume_token=$3,lease_until=NULL,lease_token=lease_token+1,preview_text=NULL WHERE id=$1`,
          [row.id, JSON.stringify(error), randomUUID()],
        );
        await this.event(tx, row.id, 'turn.failed', error);
        return null;
      }
      const updated = (
        await tx.query<{ lease_token: number }>(
          `UPDATE chat_turns SET state='running',attempt=attempt+1,lease_token=lease_token+1,
         lease_until=now()+interval '120 seconds',resume_token=NULL WHERE id=$1 RETURNING lease_token`,
          [row.id],
        )
      ).rows[0]!;
      await this.event(tx, row.id, 'turn.progress', {
        stage: 'preparing',
        attempt: updated.lease_token,
      });
      return {
        id: row.id,
        ownerId: row.owner_id,
        documentId: row.document_id,
        leaseToken: updated.lease_token,
        evidence: input,
      };
    });
  }
  async renew(claim: ClaimedChat) {
    return (
      (
        await this.database.pool.query(
          `UPDATE chat_turns t SET lease_until=now()+interval '120 seconds' FROM documents d,memberships m,users u
       WHERE t.id=$1 AND t.lease_token=$2 AND t.owner_id=$3 AND t.document_id=$4 AND t.state='running'
       AND t.lease_until>now() AND t.expires_at>now() AND d.id=t.document_id AND d.deleted_at IS NULL
       AND d.owner_id=t.owner_id AND m.workspace_id=d.workspace_id AND m.user_id=t.owner_id AND m.active AND u.id=t.owner_id AND u.active`,
          [claim.id, claim.leaseToken, claim.ownerId, claim.documentId],
        )
      ).rowCount === 1
    );
  }
  async sending(claim: ClaimedChat, reservation: UsageReservation) {
    if (reservation.operation !== 'question-answer')
      throw new Error(
        'Question dispatch must use its single versioned usage operation.',
      );
    return this.database.transaction(async (tx) => {
      const row = await this.authorizeClaim(tx, claim);
      const prompt = questionPromptVersion(claim.evidence);
      if (row.dispatch !== 'pending')
        throw new ServiceError(
          'question_dispatch_unconfirmed',
          'Confirm recovery before sending another question request.',
          409,
        );
      if (
        row.provider !== null &&
        (row.provider !== reservation.provider ||
          row.configuration_version !== reservation.configurationVersion ||
          row.prompt_version !== prompt)
      )
        throw new ServiceError(
          'question_identity_changed',
          'The saved question uses a different provider or prompt configuration. Confirm a new request.',
          409,
        );
      const call = await this.database.usage.startChat(claim, reservation, tx);
      await tx.query(
        `UPDATE chat_turns SET dispatch='sending',call_id=$2,provider=$3,configuration_version=$4,prompt_version=$5,
         preview_text='',preview_updates=0 WHERE id=$1`,
        [
          claim.id,
          call,
          reservation.provider,
          reservation.configurationVersion,
          prompt,
        ],
      );
      await this.event(
        tx,
        claim.id,
        'turn.progress',
        chatPreviewSchema.parse({
          version: 1,
          attempt: claim.leaseToken,
          text: '',
        }),
      );
      return call;
    });
  }
  async preview(claim: ClaimedChat, text: string) {
    const payload = chatPreviewSchema.parse({
      version: 1,
      attempt: claim.leaseToken,
      text,
    });
    await this.database.transaction(async (tx) => {
      const row = await this.authorizeClaim(tx, claim);
      if (row.dispatch !== 'sending')
        throw new ServiceError(
          'chat_lease_lost',
          'No active question request owns this preview.',
          409,
        );
      if (!text.startsWith(row.preview_text ?? ''))
        throw new ServiceError(
          'invalid_preview',
          'The unfinished answer must retain its previously published prefix.',
          502,
        );
      if (text === row.preview_text || row.preview_updates >= 80) return;
      await tx.query(
        'UPDATE chat_turns SET preview_text=$2,preview_updates=preview_updates+1 WHERE id=$1',
        [claim.id, text],
      );
      await this.event(tx, claim.id, 'turn.progress', payload);
    });
  }
  async complete(claim: ClaimedChat, value: ChatResult) {
    const result = chatResultSchema.parse(value);
    validateQuestionAnswer(result.answer, claim.evidence);
    await this.database.transaction(async (tx) => {
      const row = await this.authorizeClaim(tx, claim);
      if (result.prompt_version !== questionPromptVersion(claim.evidence))
        throw changed();
      if (claim.evidence.units.length) {
        const call = row.call_id
          ? (
              await tx.query<{ actual: unknown }>(
                `SELECT actual FROM ai_usage_calls WHERE id=$1 AND chat_turn_id=$2 AND owner_id=$3
                 AND lease_token=$4 AND operation='question-answer' AND provider=$5 AND configuration_version=$6`,
                [
                  row.call_id,
                  claim.id,
                  claim.ownerId,
                  claim.leaseToken,
                  result.provider,
                  result.configuration_version,
                ],
              )
            ).rows[0]
          : null;
        if (
          row.dispatch !== 'sending' ||
          !call ||
          digest(call.actual, true) !==
            digest(usageTotals(result.usage), true) ||
          row.provider !== result.provider ||
          row.configuration_version !== result.configuration_version ||
          row.prompt_version !== result.prompt_version
        )
          throw new ServiceError(
            'question_receipt_mismatch',
            'The question answer has no matching settled provider receipt.',
            409,
          );
      } else if (
        row.dispatch !== 'pending' ||
        row.call_id ||
        Object.values(result.usage).some((value) => value !== 0) ||
        result.answer.status !== 'insufficient_evidence'
      )
        throw changed();
      await tx.query(
        `UPDATE chat_turns SET state='succeeded',result=$2,error=NULL,lease_until=NULL,resume_token=NULL,
         provider=$3,configuration_version=$4,prompt_version=$5,preview_text=NULL WHERE id=$1`,
        [
          claim.id,
          JSON.stringify(result),
          result.provider,
          result.configuration_version,
          result.prompt_version,
        ],
      );
      await this.event(tx, claim.id, 'answer.completed', {
        state: 'succeeded',
      });
    });
  }
  async fail(claim: ClaimedChat, error: Failure) {
    await this.database.transaction(async (tx) => {
      const row = (
        await tx.query<{ allowed: boolean; valid: boolean }>(
          `SELECT (d.deleted_at IS NULL AND m.active AND u.active) allowed,
         (t.state='running' AND t.lease_token=$2 AND t.lease_until>now() AND t.owner_id=$3 AND t.document_id=$4) valid
         FROM chat_turns t JOIN documents d ON d.id=t.document_id
         JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=t.owner_id JOIN users u ON u.id=t.owner_id
         WHERE t.id=$1 FOR UPDATE OF t`,
          [claim.id, claim.leaseToken, claim.ownerId, claim.documentId],
        )
      ).rows[0];
      if (!row?.valid) return;
      if (!row.allowed) {
        await tx.query(
          "UPDATE chat_turns SET state='cancelled',evidence=NULL,lease_until=NULL,preview_text=NULL,resume_token=NULL WHERE id=$1",
          [claim.id],
        );
        await tx.query('DELETE FROM chat_events WHERE turn_id=$1', [claim.id]);
        await this.event(tx, claim.id, 'turn.cancelled', {
          code: 'permission_revoked',
        });
      } else {
        await tx.query(
          "UPDATE chat_turns SET state='failed',error=$2,lease_until=NULL,preview_text=NULL,resume_token=$3 WHERE id=$1",
          [
            claim.id,
            JSON.stringify({ ...error, retryable: false }),
            randomUUID(),
          ],
        );
        await this.event(tx, claim.id, 'turn.failed', {
          ...error,
          retryable: false,
        });
      }
    });
  }
  async cancel(user: string, id: string) {
    const visible = await this.get(user, id);
    await this.database.transaction(async (tx) => {
      await this.authorize(tx, user, visible.document_id);
      const row = await this.row(user, id, tx, true);
      if (terminal(row.state)) return;
      await tx.query(
        "UPDATE chat_turns SET state='cancelled',evidence=NULL,lease_until=NULL,lease_token=lease_token+1,preview_text=NULL,resume_token=NULL WHERE id=$1",
        [id],
      );
      await this.event(tx, id, 'turn.cancelled', { state: 'cancelled' });
    });
    return this.get(user, id);
  }
  async resume(user: string, id: string, token: string) {
    const visible = await this.get(user, id);
    await this.database.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `job-budget:${user}`,
      ]);
      await this.authorize(tx, user, visible.document_id);
      const row = await this.row(user, id, tx, true);
      if (
        (
          await tx.query(
            'SELECT token FROM chat_resumes WHERE turn_id=$1 AND token=$2',
            [id, token],
          )
        ).rowCount
      )
        return;
      if (!resumable(row))
        throw new ServiceError(
          'question_not_resumable',
          'This question cannot be resumed. Confirm a new request if still needed.',
          409,
        );
      if (row.resume_token !== token)
        throw new ServiceError(
          'question_resume_changed',
          'Refresh and confirm the latest failed question before another provider attempt.',
          409,
        );
      frozen(row);
      await this.budget(tx, user);
      await tx.query('INSERT INTO chat_resumes(turn_id,token) VALUES ($1,$2)', [
        id,
        token,
      ]);
      await tx.query(
        `UPDATE chat_turns SET state='queued',dispatch='pending',call_id=NULL,error=NULL,resume_token=NULL,
         lease_token=lease_token+1,preview_text=NULL WHERE id=$1`,
        [id],
      );
      await this.event(tx, id, 'turn.accepted', {
        state: 'queued',
        resumed: true,
      });
    });
    return this.get(user, id);
  }
  async events(user: string, id: string, after: number) {
    const row = await this.row(user, id);
    if (!Number.isInteger(after) || after < 0 || after > row.event_seq)
      throw new ServiceError(
        'invalid_event_cursor',
        'The event sequence is outside this question.',
        400,
      );
    if (after < row.first_event - 1)
      throw new ServiceError(
        'event_cursor_expired',
        'Question replay expired; fetch the authorized turn snapshot.',
        410,
      );
    const rows = await this.database.pool.query<{
      seq: number;
      event_type: string;
      payload: unknown;
      created_at: Date;
    }>(
      `SELECT e.seq,e.event_type,e.payload,e.created_at FROM chat_events e JOIN chat_turns t ON t.id=e.turn_id ${access}
       WHERE t.id=$1 AND t.owner_id=$2 AND e.seq>$3 AND d.deleted_at IS NULL ORDER BY e.seq LIMIT 50`,
      [id, user, after],
    );
    await this.database.document(user, row.document_id);
    return {
      terminal: terminal(row.state),
      events: rows.rows.map((event) =>
        chatEventSchema.parse({
          turn_id: id,
          ...event,
          schema_version: 1,
          created_at: event.created_at.toISOString(),
        }),
      ),
    };
  }
  async source(user: string, id: string, citation: Citation) {
    const row = await this.row(user, id);
    const result = row.result ? chatResultSchema.parse(row.result) : null;
    if (
      !result ||
      !result.answer.answer.citations.some(
        (item) => citationKey(item) === citationKey(citation),
      )
    )
      throw new ServiceError(
        'citation_not_found',
        'This completed answer does not cite that source.',
        404,
      );
    const evidence = frozen(row);
    return chatSourceSchema.parse({
      document_id: row.document_id,
      turn_id: id,
      citation,
      excerpts: evidence.units.filter(
        (unit) => citationKey(unit.citation) === citationKey(citation),
      ),
    });
  }
  async prune(tx: Transaction) {
    await tx.query(
      `WITH expired AS (
         SELECT t.id,(d.deleted_at IS NOT NULL OR NOT coalesce(m.active,false) OR NOT coalesce(u.active,false)) revoked FROM chat_turns t
         JOIN documents d ON d.id=t.document_id LEFT JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=t.owner_id
         LEFT JOIN users u ON u.id=t.owner_id
         WHERE t.evidence IS NOT NULL AND t.state<>'succeeded'
           AND (t.expires_at<=now() OR d.deleted_at IS NOT NULL OR NOT coalesce(m.active,false) OR NOT coalesce(u.active,false))
         LIMIT 100 FOR UPDATE OF t SKIP LOCKED
       ) UPDATE chat_turns t SET evidence=NULL,preview_text=NULL,resume_token=NULL,lease_until=NULL,lease_token=lease_token+1,
         state=CASE WHEN e.revoked THEN 'cancelled' WHEN t.state='cancelled' THEN 'cancelled' ELSE 'failed' END,
         error=CASE WHEN e.revoked OR t.state='cancelled' THEN NULL ELSE
           '{"code":"question_progress_expired","message":"The frozen question expired. Confirm a new request.","retryable":false}'::jsonb END
       FROM expired e WHERE t.id=e.id`,
    );
    await tx.query(
      `DELETE FROM chat_events WHERE (turn_id,seq) IN (
         SELECT e.turn_id,e.seq FROM chat_events e JOIN chat_turns t ON t.id=e.turn_id
         WHERE t.evidence IS NULL LIMIT 1000)`,
    );
    await tx.query(
      `DELETE FROM chat_events WHERE (turn_id,seq) IN (
         SELECT turn_id,seq FROM chat_events WHERE created_at<now()-interval '7 days' LIMIT 1000)`,
    );
  }
}
