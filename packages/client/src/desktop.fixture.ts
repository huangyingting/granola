import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import {
  createDocumentSchema,
  documentSchema,
  updateDocumentSchema,
  updateNotesSchema,
  type Segment,
} from '@windows-ai-notes/contracts/server';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import { oidcFixture } from './oidc.fixture.js';

type Document = z.infer<typeof documentSchema>;
type Change = {
  seq: string;
  document_id: string;
  kind: 'document' | 'transcript' | 'deleted';
  revision: number;
  transcript_revision: number;
  job_id: null;
  created_at: string;
};

// Windows UI tests use real HTTP/OIDC without requiring PostgreSQL on the runner.
// The coordinator's integration tests separately exercise the actual API/database.
export async function desktopFixture() {
  const issuer = await oidcFixture();
  const user = randomUUID();
  const workspace = randomUUID();
  const documents = new Map<string, Document>();
  const changes: { workspace: string; value: Change }[] = [];
  const transcripts = new Map<
    string,
    {
      document_id: string;
      revision: number;
      source: 'manual';
      segments: Segment[];
    }
  >();
  const replays = new Map<string, { hash: string; value: Document | null }>();
  const tombstones = new Set<string>();
  const state = {
    active: true,
    user,
    workspace,
    documents,
    workspaces: [{ id: workspace, name: 'Synthetic cloud workspace' }],
    failures: [] as unknown[],
  };
  const keys = createRemoteJWKSet(new URL('keys', issuer.state.issuer));
  function record(document: Document, kind: Change['kind'] = 'document') {
    changes.push({
      workspace: document.workspace_id,
      value: {
        seq: String(changes.length + 1),
        document_id: document.id,
        kind,
        revision: document.revision,
        transcript_revision: document.transcript_revision,
        job_id: null,
        created_at: new Date().toISOString(),
      },
    });
  }
  function seed(text: string, transcript?: string) {
    const document = documentSchema.parse({
      id: randomUUID(),
      workspace_id: workspace,
      owner_id: user,
      title: 'Synthetic cloud meeting',
      notes: text,
      content: null,
      tags: [],
      revision: 1,
      transcript_revision: transcript ? 1 : 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    documents.set(document.id, document);
    if (transcript)
      transcripts.set(`${document.id}:1`, {
        document_id: document.id,
        revision: 1,
        source: 'manual',
        segments: [
          { id: randomUUID(), start_ms: 0, end_ms: 1000, text: transcript },
        ],
      });
    record(document);
    return document;
  }
  function change(id: string, text: string) {
    const old = documents.get(id);
    if (!old) throw new Error('Missing synthetic document.');
    const next = {
      ...old,
      notes: text,
      content: null,
      revision: old.revision + 1,
      updated_at: new Date().toISOString(),
    };
    documents.set(id, next);
    record(next);
  }
  function remove(id: string) {
    const document = documents.get(id);
    if (!document) throw new Error('Missing synthetic document.');
    record(document, 'deleted');
    documents.delete(id);
    tombstones.add(id);
  }
  function send(response: ServerResponse, value: unknown, status = 200) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(status === 204 ? undefined : JSON.stringify(value));
  }
  function error(response: ServerResponse, code: string, status: number) {
    send(
      response,
      {
        code,
        message: `Synthetic ${code.replaceAll('_', ' ')}.`,
        retryable: false,
        request_id: randomUUID(),
      },
      status,
    );
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      const path = url.pathname;
      if (path === '/v1/client-config')
        return send(response, issuer.configuration);
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer '))
        return error(response, 'unauthorized', 401);
      try {
        const token = await jwtVerify(authorization.slice(7), keys, {
          issuer: issuer.state.issuer,
          audience: issuer.configuration.audience,
          algorithms: ['RS256'],
        });
        if (
          token.payload.sub !== issuer.state.subject ||
          token.payload.scp !== 'notes.access'
        )
          return error(response, 'unauthorized', 401);
      } catch {
        return error(response, 'unauthorized', 401);
      }
      if (!state.active)
        return error(response, 'identity_not_provisioned', 403);
      if (path === '/v1/me') return send(response, { id: user });
      if (path === '/v1/workspaces')
        return send(response, { workspaces: state.workspaces });
      if (path === '/v1/sync/snapshot') {
        const id = url.searchParams.get('workspace_id');
        return send(response, {
          documents: [...documents.values()].filter(
            (document) => document.workspace_id === id,
          ),
          cursor: `fixture${changes.length}`,
          next_after: null,
          has_more: false,
        });
      }
      if (path === '/v1/sync/changes') {
        const after = Number(
          url.searchParams.get('cursor')?.replace(/^fixture/u, ''),
        );
        return send(response, {
          changes: changes
            .filter(
              (change) =>
                change.workspace === url.searchParams.get('workspace_id') &&
                Number(change.value.seq) > after,
            )
            .map((change) => change.value),
          cursor: `fixture${changes.length}`,
          has_more: false,
        });
      }
      const parts = path.split('/');
      const id = parts[3] ?? '';
      const existing = documents.get(id);
      if (request.method === 'GET' && parts[2] === 'documents') {
        if (!existing) return error(response, 'document_not_found', 404);
        if (parts[4] === 'jobs') return send(response, { jobs: [] });
        if (parts[4] === 'transcript') {
          const transcript = transcripts.get(
            `${id}:${url.searchParams.get('revision')}`,
          );
          return transcript
            ? send(response, transcript)
            : error(response, 'transcript_not_found', 404);
        }
        return send(response, existing);
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > 1024 * 1024)
          throw new Error('Synthetic request exceeded its bound.');
        chunks.push(bytes);
      }
      const body: unknown = length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : null;
      const key = `${request.method}:${path}:${request.headers['idempotency-key']}`;
      const hash = canonicalJson(body);
      const replay = replays.get(key);
      if (replay) {
        if (hash !== replay.hash)
          return error(response, 'idempotency_conflict', 409);
        return send(response, replay.value, replay.value ? 200 : 204);
      }
      let next: Document | null;
      if (request.method === 'POST' && path === '/v1/documents') {
        const value = createDocumentSchema.parse(body);
        if (!state.workspaces.some((item) => item.id === value.workspace_id))
          return error(response, 'workspace_not_found', 404);
        if (value.id && (documents.has(value.id) || tombstones.has(value.id)))
          return error(response, 'document_id_conflict', 409);
        next = documentSchema.parse({
          ...value,
          id: value.id ?? randomUUID(),
          owner_id: user,
          revision: 1,
          transcript_revision: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      } else {
        if (!existing) return error(response, 'document_not_found', 404);
        if (request.method === 'DELETE') {
          remove(id);
          next = null;
        } else if (request.method === 'PUT' && parts[4] === 'notes') {
          const value = updateNotesSchema.parse(body);
          if (value.base_revision !== existing.revision)
            return error(response, 'revision_conflict', 409);
          next = {
            ...existing,
            notes: value.notes,
            content: value.content,
            revision: existing.revision + 1,
            updated_at: new Date().toISOString(),
          };
        } else if (request.method === 'PATCH' && parts.length === 4) {
          const value = updateDocumentSchema.parse(body);
          if (value.base_revision !== existing.revision)
            return error(response, 'revision_conflict', 409);
          next = {
            ...existing,
            title: value.title ?? existing.title,
            tags: value.tags ?? existing.tags,
            revision: existing.revision + 1,
            updated_at: new Date().toISOString(),
          };
        } else throw new Error('Unexpected synthetic API request.');
      }
      if (next) {
        documents.set(next.id, next);
        record(next);
      }
      replays.set(key, { hash, value: next });
      send(response, next, next ? 200 : 204);
    })().catch((failure: unknown) => {
      state.failures.push(failure instanceof Error ? failure.name : 'unknown');
      if (!response.headersSent) error(response, 'fixture_failure', 500);
      else response.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No synthetic API port.');
  return {
    issuer,
    state,
    seed,
    change,
    remove,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
      await issuer.close();
    },
  };
}
