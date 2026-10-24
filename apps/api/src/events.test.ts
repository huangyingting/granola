import { randomUUID } from 'node:crypto';
import { request, type ClientRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '@windows-ai-notes/db';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import { createServer } from './server.js';

type Read = (
  user: string,
  id: string,
  cursor: number,
) => Promise<{ terminal: boolean; events: never[] }>;

describe(
  'real HTTP replay admission and disconnect lifecycle',
  { timeout: 10_000 },
  () => {
    let db: Database;
    let app: Awaited<ReturnType<typeof createServer>>;
    let base: string;
    let read: ReturnType<typeof vi.fn<Read>>;
    const user = randomUUID();
    const headers = { 'x-dev-subject': randomUUID() };
    let releases: Array<() => void>;
    let clients: ClientRequest[];
    let errors: Error[];
    let closed: Map<string, ReturnType<typeof gate>>;
    let stopping: ReturnType<typeof gate>;

    function gate() {
      let resolve!: () => void;
      const promise = new Promise<void>((complete) => {
        resolve = complete;
      });
      releases.push(resolve);
      return { promise, resolve };
    }
    const route = (id: string, kind: 'job' | 'question' = 'job') =>
      `/v1/${kind === 'job' ? 'jobs' : 'chat-turns'}/${id}/events`;
    function connect(path: string) {
      const serverClosed = gate();
      closed.set(path, serverClosed);
      const client = request(`${base}${path}`, { headers });
      clients.push(client);
      client.on('error', (error) => errors.push(error));
      client.end();
      return { client, serverClosed };
    }
    const get = (id = randomUUID()) =>
      fetch(`${base}${route(id)}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });

    beforeEach(async () => {
      releases = [];
      clients = [];
      errors = [];
      closed = new Map();
      stopping = gate();
      db = new Database('postgres://unused:unused@127.0.0.1:1/unused');
      vi.spyOn(db, 'assertReady').mockResolvedValue(undefined);
      vi.spyOn(db, 'identify').mockResolvedValue(user);
      read = vi.fn<Read>(async () => ({ terminal: true, events: [] }));
      vi.spyOn(db, 'events').mockImplementation(read);
      vi.spyOn(db.chat, 'events').mockImplementation(read);
      app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
      app.addHook('preClose', async () => stopping.resolve());
      app.server.on('request', (incoming, response) => {
        const observation = closed.get(incoming.url ?? '');
        if (observation) response.once('close', observation.resolve);
      });
      base = await app.listen({ host: '127.0.0.1', port: 0 });
    });
    afterEach(async () => {
      for (const release of releases) release();
      for (const client of clients) client.destroy();
      try {
        await app?.close();
      } finally {
        try {
          await db?.close();
        } finally {
          vi.restoreAllMocks();
        }
      }
      for (const error of errors)
        expect(error).toMatchObject({ code: 'ECONNRESET' });
    });

    it('does not let disconnected preflight reads occupy the shared job/question stream quota', async () => {
      const first = randomUUID();
      const second = randomUUID();
      const firstRead = gate();
      const secondRead = gate();
      const resume = gate();
      read.mockImplementation(async (_user, id) => {
        if (id === first || id === second) {
          (id === first ? firstRead : secondRead).resolve();
          await resume.promise;
          return { terminal: false, events: [] };
        }
        return { terminal: true, events: [] };
      });
      const one = connect(route(first));
      const two = connect(route(second, 'question'));
      await Promise.all([firstRead.promise, secondRead.promise]);
      one.client.destroy();
      two.client.destroy();
      await Promise.all([one.serverClosed.promise, two.serverClosed.promise]);
      resume.resolve();
      const response = await get();
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
      for (const id of [first, second])
        expect(read.mock.calls.filter((call) => call[1] === id)).toHaveLength(
          1,
        );
    });

    it('does not start replay when the client disconnected during authentication', async () => {
      const id = randomUUID();
      const authenticating = gate();
      const resume = gate();
      vi.mocked(db.identify).mockImplementationOnce(async () => {
        authenticating.resolve();
        await resume.promise;
        return user;
      });
      const connection = connect(route(id));
      await authenticating.promise;
      connection.client.destroy();
      await connection.serverClosed.promise;
      resume.resolve();
      const response = await get();
      expect(response.status).toBe(200);
      await response.text();
      expect(read.mock.calls.some((call) => call[1] === id)).toBe(false);
    });

    it('rejects shutdown before replay validation without starting another database read', async () => {
      const authenticating = gate();
      const resume = gate();
      vi.mocked(db.identify).mockImplementationOnce(async () => {
        authenticating.resolve();
        await resume.promise;
        return user;
      });
      const pending = get();
      await authenticating.promise;
      const closing = app.close();
      await stopping.promise;
      resume.resolve();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'service_unavailable',
        retryable: true,
      });
      expect(response.headers.get('connection')).toBe('close');
      expect(read).not.toHaveBeenCalled();
      await closing;
    });

    it('rejects shutdown during preflight before sending successful stream headers', async () => {
      const entered = gate();
      const resume = gate();
      read.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        return { terminal: true, events: [] };
      });
      const pending = get();
      await entered.promise;
      const closing = app.close();
      await stopping.promise;
      resume.resolve();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'service_unavailable',
        retryable: true,
      });
      expect(read).toHaveBeenCalledTimes(1);
      await closing;
    });

    it('rejects authentication expiry during preflight before opening the stream', async () => {
      const entered = gate();
      const resume = gate();
      read.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        return { terminal: true, events: [] };
      });
      const pending = get();
      await entered.promise;
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001);
      resume.resolve();
      const response = await pending;
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(await response.json()).toMatchObject({ code: 'unauthorized' });
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('preserves preflight cursor errors without consuming a subscription', async () => {
      read.mockRejectedValueOnce(
        new ServiceError(
          'event_cursor_expired',
          'Synthetic expired cursor.',
          410,
        ),
      );
      const rejected = await get();
      expect(rejected.status).toBe(410);
      expect(await rejected.json()).toMatchObject({
        code: 'event_cursor_expired',
      });
      const accepted = await get();
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toBe('');
    });

    it('still enforces the live subscription limit and releases it after real disconnects', async () => {
      const active = new Map<string, ReturnType<typeof gate>>([
        [randomUUID(), gate()],
        [randomUUID(), gate()],
      ]);
      const expired = randomUUID();
      const calls = new Map<string, number>();
      read.mockImplementation(async (_user, id) => {
        if (id === expired)
          throw new ServiceError(
            'event_cursor_expired',
            'Synthetic expired cursor.',
            410,
          );
        const admitted = active.get(id);
        if (admitted) {
          const count = (calls.get(id) ?? 0) + 1;
          calls.set(id, count);
          if (count === 2) admitted.resolve();
          return { terminal: false, events: [] };
        }
        return { terminal: true, events: [] };
      });
      const connections = [...active.keys()].map((id) => connect(route(id)));
      await Promise.all(
        [...active.values()].map((observation) => observation.promise),
      );
      const expiredResponse = await get(expired);
      expect(expiredResponse.status).toBe(410);
      await expiredResponse.json();
      for (let attempt = 0; attempt < 2; attempt++) {
        const rejected = await get();
        expect(rejected.status).toBe(429);
        expect(await rejected.json()).toMatchObject({ code: 'quota_exceeded' });
      }
      for (const connection of connections) connection.client.destroy();
      await Promise.all(
        connections.map((connection) => connection.serverClosed.promise),
      );
      const accepted = await get();
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toBe('');
    });
  },
);
