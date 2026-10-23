import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Database } from '@windows-ai-notes/db';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import { createServer } from './server.js';

afterEach(() => vi.restoreAllMocks());

it.each(['authentication', 'route'] as const)(
  'returns a sanitized retryable 503 for a connection loss during %s',
  async (phase) => {
    const log = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const db = new Database(
      'postgresql://synthetic:synthetic@127.0.0.1:1/unused',
    );
    vi.spyOn(db, 'assertReady').mockResolvedValue(undefined);
    const failed = Object.assign(new Error('private-database-error-marker'), {
      name: 'private-error-name-marker',
      code: 'ECONNREFUSED',
    });
    const identify = vi.spyOn(db, 'identify').mockResolvedValue(randomUUID());
    const usage = vi.spyOn(db.usage, 'snapshot').mockRejectedValue(failed);
    if (phase === 'authentication') identify.mockRejectedValue(failed);
    const app = await createServer(db, {
      mode: 'development',
      host: '127.0.0.1',
    });
    try {
      const response = await app.inject({
        url: '/v1/usage?secret=private-query-marker',
        headers: { 'x-dev-subject': randomUUID() },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: 'database_unavailable',
        message: 'The database is temporarily unavailable. Retry this request.',
        retryable: true,
        request_id: response.headers['x-request-id'],
      });
      expect(error).toHaveBeenCalledWith(
        JSON.stringify({
          code: 'database_unavailable',
          request_id: response.json().request_id,
        }),
      );
      expect(
        JSON.stringify([...log.mock.calls, ...error.mock.calls, response.body]),
      ).not.toContain('private-');
      if (phase === 'authentication') expect(usage).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await db.close();
    }
  },
);

it('preserves explicitly classified service errors ahead of raw connection-error normalization', async () => {
  const db = new Database(
    'postgresql://synthetic:synthetic@127.0.0.1:1/unused',
  );
  vi.spyOn(db, 'assertReady').mockResolvedValue(undefined);
  vi.spyOn(db, 'identify').mockResolvedValue(randomUUID());
  vi.spyOn(db.usage, 'snapshot').mockRejectedValue(
    new ServiceError(
      'ECONNREFUSED',
      'Explicitly classified domain failure.',
      409,
      false,
    ),
  );
  const app = await createServer(db, {
    mode: 'development',
    host: '127.0.0.1',
  });
  try {
    const response = await app.inject({
      url: '/v1/usage',
      headers: { 'x-dev-subject': randomUUID() },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'ECONNREFUSED',
      retryable: false,
    });
  } finally {
    await app.close();
    await db.close();
  }
});
