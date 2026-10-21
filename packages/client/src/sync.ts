import { createHash } from 'node:crypto';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import { documentSchema, resourceId } from '@windows-ai-notes/contracts/server';
import { LocalStore, type RemoteUpdate } from '@windows-ai-notes/local';
import { z } from 'zod';
import { ApiClient, ClientError, serverUrl } from './http.js';

export function workspaceProfile(
  service: string,
  user: string,
  workspace: string,
  allowLoopback = false,
): string {
  return `workspace:${createHash('sha256')
    .update(
      canonicalJson([
        serverUrl(service, allowLoopback),
        resourceId.parse(user),
        resourceId.parse(workspace),
      ]),
    )
    .digest('hex')}`;
}
export class SyncEngine {
  private running: Promise<{ more: boolean }> | null = null;
  private readonly controller = new AbortController();
  readonly profile: string;
  constructor(
    private readonly local: LocalStore,
    private readonly api: ApiClient,
    private readonly user: string,
    private readonly workspace: string,
  ) {
    this.profile = workspaceProfile(
      api.base,
      user,
      workspace,
      api.base.startsWith('http:'),
    );
  }
  stop() {
    this.controller.abort();
  }
  synchronize(): Promise<{ more: boolean }> {
    if (this.running) return this.running;
    const operation = this.run().finally(() => {
      this.running = null;
    });
    this.running = operation;
    return operation;
  }
  private active() {
    if (this.controller.signal.aborted)
      throw new ClientError(
        'sync_cancelled',
        'Synchronization stopped. Local changes were preserved.',
      );
  }
  private checkDocument(input: z.infer<typeof documentSchema>, id?: string) {
    if (
      input.owner_id !== this.user ||
      input.workspace_id !== this.workspace ||
      (id !== undefined && input.id !== id)
    )
      throw new ClientError(
        'invalid_server_response',
        'The service returned a document from a different account or workspace.',
      );
  }
  private async access() {
    const signal = this.controller.signal;
    const identity = await this.api.identity(signal);
    this.active();
    if (identity.id !== this.user)
      throw new ClientError(
        'account_mismatch',
        'The signed-in account no longer matches this workspace.',
      );
    const memberships = await this.api.workspaces(signal);
    this.active();
    if (
      !memberships.workspaces.some(
        (workspace) => workspace.id === this.workspace,
      )
    )
      throw new ClientError(
        'workspace_access_revoked',
        'Workspace access was revoked. Its cached content has been removed.',
        403,
        false,
        0,
        this.workspace,
      );
  }
  private async artifacts(
    document: z.infer<typeof documentSchema>,
  ): Promise<RemoteUpdate['artifacts']> {
    const artifacts: RemoteUpdate['artifacts'] = [];
    if (document.transcript_revision > 0) {
      const transcript = await this.api.transcriptPage(
        document.id,
        document.transcript_revision,
        0,
        this.controller.signal,
      );
      if (
        transcript.document_id !== document.id ||
        transcript.revision !== document.transcript_revision
      )
        throw new ClientError(
          'invalid_server_response',
          'The service returned an inconsistent transcript.',
        );
      artifacts.push({
        id: `transcript:${transcript.revision}`,
        value: transcript,
      });
    }
    const history = await this.api.jobs(document.id, this.controller.signal);
    for (const job of history.jobs) {
      if (job.document_id !== document.id)
        throw new ClientError(
          'invalid_server_response',
          'The service returned another document job.',
        );
      artifacts.push({ id: `job:${job.id}`, value: job });
    }
    artifacts.push({ id: 'job-history', value: history });
    return artifacts;
  }
  private async run(): Promise<{ more: boolean }> {
    const signal = this.controller.signal;
    try {
      this.active();
      await this.access();
      for (let count = 0; count < 20; count++) {
        this.active();
        const mutation = this.local.nextMutation(this.profile, this.workspace);
        if (!mutation) break;
        try {
          const remote = await this.api.mutation(mutation, signal);
          this.active();
          if (remote) this.checkDocument(remote, mutation.document_id);
          this.local.acknowledge(this.profile, mutation, remote);
        } catch (error) {
          this.active();
          if (!(error instanceof ClientError)) throw error;
          if (error.code === 'document_not_found') {
            if (mutation.kind === 'delete')
              this.local.acknowledge(this.profile, mutation, null);
            else this.local.remoteDeleted(this.profile, mutation.document_id);
          } else if (
            error.code === 'revision_conflict' ||
            error.code === 'document_id_conflict'
          ) {
            try {
              const remote = await this.api.document(
                mutation.document_id,
                signal,
              );
              this.active();
              this.checkDocument(remote, mutation.document_id);
              this.local.applyRemote(this.profile, remote);
            } catch (readError) {
              this.active();
              if (
                !(readError instanceof ClientError) ||
                readError.code !== 'document_not_found'
              )
                throw readError;
              this.local.remoteDeleted(this.profile, mutation.document_id);
            }
          } else if (error.code === 'workspace_not_found') {
            await this.access();
            throw error;
          } else throw error;
        }
      }
      for (let count = 0; count < 5; count++) {
        this.active();
        let checkpoint = this.local.syncCheckpoint(this.profile);
        if (!checkpoint.cursor && !checkpoint.bootstrap)
          checkpoint = this.local.beginSnapshot(this.profile);
        try {
          if (checkpoint.bootstrap) {
            const page = await this.api.snapshot(
              this.workspace,
              checkpoint.bootstrap,
              signal,
            );
            const artifacts: {
              document_id: string;
              id: string;
              value: unknown;
            }[] = [];
            for (const document of page.documents) {
              this.checkDocument(document);
              const values = await this.artifacts(document);
              for (const value of values)
                artifacts.push({ document_id: document.id, ...value });
            }
            this.active();
            this.local.acceptSnapshot(
              this.profile,
              checkpoint.bootstrap,
              page,
              artifacts,
            );
            continue;
          }
          const cursor = checkpoint.cursor!;
          const page = await this.api.changes(this.workspace, cursor, signal);
          if (page.has_more && page.cursor === cursor)
            throw new ClientError(
              'invalid_server_response',
              'The service did not advance its synchronization cursor.',
            );
          const ids = [
            ...new Set(page.changes.map((change) => change.document_id)),
          ];
          const updates: RemoteUpdate[] = [];
          for (const id of ids) {
            if (
              page.changes.some(
                (change) =>
                  change.document_id === id && change.kind === 'deleted',
              )
            ) {
              updates.push({ id, document: null, artifacts: [] });
              continue;
            }
            try {
              const document = await this.api.document(id, signal);
              this.checkDocument(document, id);
              updates.push({
                id,
                document,
                artifacts: await this.artifacts(document),
              });
            } catch (error) {
              if (
                !(error instanceof ClientError) ||
                error.code !== 'document_not_found'
              )
                throw error;
              updates.push({ id, document: null, artifacts: [] });
            }
          }
          this.active();
          this.local.acceptChanges(this.profile, cursor, page.cursor, updates);
          if (!page.has_more)
            return {
              more:
                this.local.nextMutation(this.profile, this.workspace) !== null,
            };
        } catch (error) {
          this.active();
          if (
            !(error instanceof ClientError) ||
            error.code !== 'sync_cursor_expired'
          )
            throw error;
          this.local.beginSnapshot(this.profile);
        }
      }
      return { more: true };
    } catch (error) {
      this.active();
      if (
        error instanceof ClientError &&
        ((error.code === 'workspace_access_revoked' &&
          error.purgeWorkspaceId === this.workspace) ||
          (error.code === 'identity_not_provisioned' && error.status === 403))
      ) {
        try {
          this.local.purgeProfile(this.profile);
        } catch (purgeError) {
          console.error(
            JSON.stringify({
              code: 'revoked_cache_removal_failed',
              kind: purgeError instanceof Error ? purgeError.name : 'unknown',
            }),
          );
          throw new ClientError(
            error.code,
            'Access was revoked. Its encrypted cache could not be removed.',
            403,
            false,
            0,
            error.purgeWorkspaceId,
          );
        }
      }
      throw error;
    }
  }
}
