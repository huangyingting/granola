import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import { principal } from './auth.js';
import { parse } from './parse.js';

export async function streamEvents<
  T extends { seq: number; event_type: string },
>(
  request: FastifyRequest,
  reply: FastifyReply,
  streams: Map<string, number>,
  shutdown: AbortSignal,
  read: (cursor: number) => Promise<{ terminal: boolean; events: T[] }>,
) {
  const identity = principal(request);
  const rawCursor = request.headers['last-event-id'];
  let cursor =
    rawCursor === undefined
      ? 0
      : Number(parse(z.string().regex(/^\d+$/).max(10), rawCursor));
  if (!Number.isSafeInteger(cursor) || cursor > 2_147_483_647)
    throw new ServiceError(
      'invalid_event_cursor',
      'Invalid event sequence.',
      400,
    );
  const closed = new AbortController();
  const onClose = () => closed.abort();
  const assertAdmission = () => {
    if (shutdown.aborted)
      throw new ServiceError(
        'service_unavailable',
        'The API is shutting down.',
        503,
        true,
      );
    if (Date.now() >= identity.expiresAt)
      throw new ServiceError(
        'unauthorized',
        'The access token expired before event streaming could start.',
        401,
      );
  };
  reply.raw.once('close', onClose);
  try {
    if (reply.raw.destroyed) {
      reply.hijack();
      return;
    }
    assertAdmission();
    await read(cursor);
    if (closed.signal.aborted || reply.raw.destroyed) {
      reply.hijack();
      return;
    }
    assertAdmission();
    if ((streams.get(identity.userId) ?? 0) >= 2)
      throw new ServiceError(
        'quota_exceeded',
        'At most two event subscriptions are allowed per user.',
        429,
        true,
      );
    streams.set(identity.userId, (streams.get(identity.userId) ?? 0) + 1);
    try {
      const signal = AbortSignal.any([
        closed.signal,
        shutdown,
        AbortSignal.timeout(
          Math.max(1, Math.min(60_000, identity.expiresAt - Date.now())),
        ),
      ]);
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-accel-buffering': 'no',
      });
      let heartbeat = Date.now();
      while (!signal.aborted && Date.now() < identity.expiresAt) {
        const batch = await read(cursor);
        for (const event of batch.events) {
          if (signal.aborted || Date.now() >= identity.expiresAt) break;
          if (
            !reply.raw.write(
              `id: ${event.seq}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
          )
            await once(reply.raw, 'drain', { signal });
          cursor = event.seq;
        }
        if (batch.terminal && batch.events.length < 50) break;
        if (Date.now() - heartbeat >= 5000) {
          if (!reply.raw.write(': heartbeat\n\n'))
            await once(reply.raw, 'drain', { signal });
          heartbeat = Date.now();
        }
        if (batch.events.length === 50) continue;
        await delay(500, undefined, { signal });
      }
    } catch (error) {
      if (
        !(
          error instanceof ServiceError &&
          [401, 403, 404].includes(error.status)
        ) &&
        !(error instanceof Error && error.name === 'AbortError')
      )
        console.error(
          JSON.stringify({
            code: 'event_stream_failed',
            request_id: request.id,
          }),
        );
    } finally {
      const remaining = (streams.get(identity.userId) ?? 1) - 1;
      if (remaining > 0) streams.set(identity.userId, remaining);
      else streams.delete(identity.userId);
      reply.raw.end();
    }
  } finally {
    reply.raw.off('close', onClose);
    closed.abort();
  }
}
