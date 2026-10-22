import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './http.js';
const id = randomUUID();
const event = (seq = 1) => ({
  job_id: id,
  seq,
  event_type: 'job.progress',
  schema_version: 1,
  created_at: new Date().toISOString(),
  payload: {
    stage: 'summary_preview',
    version: 1,
    attempt: 1,
    text: 'Unverified text.',
  },
});
const encode = (
  value: ReturnType<typeof event>,
  frameId = String(value.seq),
  type = value.event_type,
) => `id: ${frameId}\nevent: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
const api = () =>
  new ApiClient('https://fixture.example', async () => ({
    Authorization: 'Bearer synthetic-token',
  }));
afterEach(() => vi.unstubAllGlobals());
describe('Main-owned authenticated generation events', () => {
  it('rotates bounded replay connections without dropping the next event', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          Array.from({ length: 513 }, (_, index) =>
            encode(event(index + 1)),
          ).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const received = vi.fn(async (_value: unknown) => {});
    expect(
      await api().events(id, 0, received, new AbortController().signal),
    ).toBe(512);
    expect(received).toHaveBeenCalledTimes(512);
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(encode(event(513)), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    expect(
      await api().events(id, 512, received, new AbortController().signal),
    ).toBe(513);
    expect(received).toHaveBeenCalledTimes(513);
  });

  describe('distinct authenticated chat event envelopes', () => {
    const value = (seq = 1) => ({
      turn_id: id,
      seq,
      event_type: 'turn.progress',
      schema_version: 1,
      created_at: new Date().toISOString(),
      payload: { version: 1, attempt: 1, text: '未完成的回答。' },
    });
    const frame = (
      entry: ReturnType<typeof value>,
      frameId = String(entry.seq),
      type = entry.event_type,
    ) => `id: ${frameId}\nevent: ${type}\ndata: ${JSON.stringify(entry)}\n\n`;
    it('pins refreshed Main authorization, the chat route and exact cursor while decoding split UTF-8', async () => {
      const entry = value(5);
      const bytes = new TextEncoder().encode(frame(entry));
      const authorization = `fixture-${randomUUID()}`;
      const client = new ApiClient('https://fixture.example', async () => ({
        Authorization: authorization,
      }));
      const fetcher = vi.fn<typeof fetch>(async (url, options) => {
        expect(String(url)).toBe(
          `https://fixture.example/v1/chat-turns/${id}/events`,
        );
        expect(options).toMatchObject({
          redirect: 'manual',
          cache: 'no-store',
        });
        expect(new Headers(options?.headers).get('authorization')).toBe(
          authorization,
        );
        expect(new Headers(options?.headers).get('last-event-id')).toBe('4');
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      });
      vi.stubGlobal('fetch', fetcher);
      const received = vi.fn(async (_entry: unknown) => {});
      expect(
        await client.chatEvents(id, 4, received, new AbortController().signal),
      ).toBe(5);
      expect(received).toHaveBeenCalledExactlyOnceWith(entry);
    });
    it.each([
      'turn',
      'gap',
      'duplicate',
      'id',
      'type',
      'version',
      'legacy',
    ] as const)(
      'rejects a mismatched %s without coercing chat into legacy jobs',
      async (failure) => {
        const entry = value();
        if (failure === 'turn') entry.turn_id = randomUUID();
        if (failure === 'gap') entry.seq = 2;
        if (failure === 'version') entry.schema_version = 2;
        let wire = frame(
          entry,
          failure === 'id' ? '9' : String(entry.seq),
          failure === 'type' ? 'turn.failed' : entry.event_type,
        );
        if (failure === 'legacy') wire = encode(event());
        vi.stubGlobal(
          'fetch',
          async () =>
            new Response(
              (failure === 'duplicate' ? frame(value()) : '') + wire,
              { headers: { 'content-type': 'text/event-stream' } },
            ),
        );
        await expect(
          api().chatEvents(id, 0, async () => {}, new AbortController().signal),
        ).rejects.toMatchObject({ code: 'invalid_event_stream' });
      },
    );
    it('keeps the last complete chat cursor after a torn frame and rotates a full terminal batch', async () => {
      const received = vi.fn(async (_entry: unknown) => {});
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(
            frame(value()) + 'id: 2\nevent: turn.progress\ndata: {"turn_id":',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      );
      await expect(
        api().chatEvents(id, 0, received, new AbortController().signal),
      ).rejects.toMatchObject({
        code: 'event_stream_interrupted',
        retryable: true,
      });
      expect(received).toHaveBeenCalledTimes(1);
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(
            Array.from({ length: 513 }, (_, index) =>
              frame(value(index + 2)),
            ).join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      );
      expect(
        await api().chatEvents(id, 1, received, new AbortController().signal),
      ).toBe(513);
      expect(received).toHaveBeenCalledTimes(513);
    });
  });
  it('discards a torn frame and permits replay from the last completely accepted event', async () => {
    const received = vi.fn(async (_value: unknown) => {});
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          encode(event()) + 'id: 2\nevent: job.progress\ndata: {"job_id":',
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        ),
    );
    await expect(
      api().events(id, 0, received, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'event_stream_interrupted',
      retryable: true,
    });
    expect(received).toHaveBeenCalledTimes(1);
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(encode(event(2)), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    expect(
      await api().events(id, 1, received, new AbortController().signal),
    ).toBe(2);
    expect(received).toHaveBeenCalledTimes(2);
  });
  it('sends refreshed authorization and an exact cursor without redirects or renderer EventSource', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      expect(options).toMatchObject({ redirect: 'manual', cache: 'no-store' });
      expect(new Headers(options?.headers).get('authorization')).toBe(
        'Bearer synthetic-token',
      );
      expect(new Headers(options?.headers).get('last-event-id')).toBe('4');
      return new Response(encode(event(5)), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const received = vi.fn(async (_value: unknown) => {});
    expect(
      await api().events(id, 4, received, new AbortController().signal),
    ).toBe(5);
    expect(received).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        job_id: id,
        seq: 5,
        event_type: 'job.progress',
      }),
    );
  });
  it.each(['job', 'gap', 'duplicate', 'id', 'type', 'version'] as const)(
    'rejects a mismatched %s before committing a cursor',
    async (failure) => {
      const value = event();
      if (failure === 'job') value.job_id = randomUUID();
      if (failure === 'gap') value.seq = 2;
      if (failure === 'version') value.schema_version = 2;
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(
            (failure === 'duplicate' ? encode(event()) : '') +
              encode(
                value,
                failure === 'id' ? '9' : String(value.seq),
                failure === 'type' ? 'job.failed' : value.event_type,
              ),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      );
      await expect(
        api().events(id, 0, async () => {}, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'invalid_event_stream' });
    },
  );
  it('rejects redirects before forwarding credentials or parsing another origin', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: 'https://other.example' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      api().events(id, 0, async () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'service_redirect_rejected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves explicit expired-cursor errors for snapshot recovery', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            code: 'event_cursor_expired',
            message: 'Fetch the authorized snapshot.',
            retryable: false,
            request_id: 'synthetic-request',
          }),
          { status: 410 },
        ),
    );
    await expect(
      api().events(id, 7, async () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'event_cursor_expired', status: 410 });
  });
});
