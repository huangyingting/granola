import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import {
  providerContextSchema,
  providerEventSchema,
  type ProviderEvent,
} from '@windows-ai-notes/contracts/observability';
import { createAzureProviders } from './index.js';
import {
  currentProviderCall,
  observedProvider,
  registerProviderTelemetry,
  withProviderContext,
} from './observability.js';
import { makeSilentWav } from './wav.js';

const secret = 'private-provider-configuration-payload-error';
const config = {
  AZURE_OPENAI_ENDPOINT: 'https://fixture.openai.azure.com/',
  AZURE_OPENAI_API_KEY: secret,
  AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
  AZURE_OPENAI_DEPLOYMENT: secret,
  AZURE_SPEECH_KEY: secret,
  AZURE_SPEECH_REGION: 'westus',
};
const snapshot = {
  document_id: randomUUID(),
  note_revision: 1,
  transcript_revision: 0,
  notes: secret,
  language: 'en' as const,
  segments: [],
};
const summary = {
  overview: {
    text: secret,
    citations: [{ source: 'note', id: snapshot.document_id, revision: 1 }],
  },
  topics: [],
  decisions: [],
  action_items: [],
  open_questions: [],
};
const json = () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: JSON.stringify(summary) },
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
function stream() {
  const wire = (content: string, finish: string | null = null) => ({
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  });
  const values = [
    wire(''),
    wire('{'),
    wire(JSON.stringify(summary).slice(1), 'stop'),
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } },
  ];
  return new Response(
    values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
async function capture(run: (rows: ProviderEvent[]) => Promise<void>) {
  const rows: ProviderEvent[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      rows.push(providerEventSchema.parse(JSON.parse(String(chunk))));
      done();
    },
  });
  const close = registerProviderTelemetry(output);
  try {
    await run(rows);
  } finally {
    close();
  }
}
afterEach(() => vi.restoreAllMocks());

it('isolates concurrent reserved-call contexts and generates a distinct actual outbound client ID for each request', async () => {
  await capture(async (rows) => {
    const sent: string[] = [];
    const providerId = randomUUID();
    const providers = createAzureProviders(config, async (_url, init) => {
      sent.push(new Headers(init?.headers).get('x-ms-client-request-id')!);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const response = json();
      response.headers.set('apim-request-id', providerId);
      return response;
    });
    const contexts = Array.from({ length: 2 }, () =>
      providerContextSchema.parse({
        source: 'worker',
        usage_call_id: randomUUID(),
        origin_request_id: randomUUID(),
        job_id: randomUUID(),
      }),
    );
    await Promise.all(
      contexts.map((context) =>
        withProviderContext(context, () =>
          providers.summarize(snapshot, new AbortController().signal),
        ),
      ),
    );
    expect(new Set(sent).size).toBe(2);
    expect(rows).toHaveLength(4);
    for (const context of contexts) {
      const events = rows.filter(
        (row) => row.usage_call_id === context.usage_call_id,
      );
      expect(events).toHaveLength(2);
      expect(new Set(events.map((row) => row.client_request_id)).size).toBe(1);
      for (const row of events) {
        expect(row).toMatchObject(context);
        expect(sent).toContain(row.client_request_id);
      }
      expect(events[1]).toMatchObject({
        code: 'provider_call_completed',
        outcome: 'returned',
        response_headers_ms: expect.any(Number),
        response_body_ms: expect.any(Number),
        first_content_ms: null,
        provider_response_id: providerId.replaceAll('-', ''),
        provider_response_id_status: 'accepted',
      });
    }
    await providers.summarize(snapshot, new AbortController().signal);
    expect(rows.at(-1)).toMatchObject({
      source: 'system',
      usage_call_id: null,
      job_id: null,
      origin_request_id: null,
    });
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain(snapshot.document_id);
  });
});

it('measures first content before projected preview and receipt persistence, not after their backpressure', async () => {
  await capture(async (rows) => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const providers = createAzureProviders(config, async () => {
      clock = 10;
      return stream();
    });
    await providers.summarize(
      snapshot,
      new AbortController().signal,
      async () => {
        clock = 200;
      },
      async () => {
        clock = 100;
      },
    );
    expect(rows.at(-1)).toMatchObject({
      outcome: 'returned',
      response_headers_ms: 10,
      first_content_ms: 10,
      response_body_ms: 200,
      duration_ms: 200,
    });
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
});

it.each(['malformed', 'refusal', 'transport'] as const)(
  'preserves failed %s outcomes without leaking bodies, provider header values or exception names',
  async (mode) => {
    await capture(async (rows) => {
      const providers = createAzureProviders(config, async () => {
        if (mode === 'transport')
          throw Object.assign(new Error(secret), { name: secret });
        const response =
          mode === 'malformed'
            ? new Response(secret, {
                headers: { 'content-type': 'application/json' },
              })
            : new Response(
                JSON.stringify({
                  choices: [
                    {
                      finish_reason: 'stop',
                      message: { content: null, refusal: secret },
                    },
                  ],
                  usage: { prompt_tokens: 2, completion_tokens: 3 },
                }),
                { headers: { 'content-type': 'application/json' } },
              );
        response.headers.set('apim-request-id', secret);
        return response;
      });
      await expect(
        providers.summarize(snapshot, new AbortController().signal),
      ).rejects.toThrow();
      expect(rows.at(-1)).toMatchObject({
        outcome: 'failed',
        dispatched: true,
        provider_response_id: null,
        provider_response_id_status:
          mode === 'transport' ? 'missing' : 'rejected',
        first_content_ms: null,
      });
      expect(JSON.stringify(rows)).not.toContain(secret);
    });
  },
);

it('does not dispatch invalid or already cancelled operations and does not invent latency for absent data', async () => {
  await capture(async (rows) => {
    const transport = vi.fn<typeof fetch>(async () => json());
    const providers = createAzureProviders(config, transport);
    await expect(
      providers.summarize(
        { ...snapshot, notes: '' },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      providers.summarize(snapshot, cancelled.signal),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ outcome: 'failed', dispatched: false });
    expect(rows[1]).toMatchObject({
      outcome: 'cancelled',
      dispatched: false,
      http_status: null,
      response_headers_ms: null,
      response_body_ms: null,
      first_content_ms: null,
    });
    expect(() =>
      withProviderContext({ job_id: secret }, () => undefined),
    ).toThrow();
    expect(() => currentProviderCall()).toThrow('context is missing');
  });
});

it('distinguishes a bounded transport timeout from caller cancellation without logging abort reasons', async () => {
  await capture(async (rows) => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const providers = createAzureProviders(config, async (_url, init) => {
      timeout.abort(new Error(secret));
      throw init?.signal?.reason;
    });
    await expect(
      providers.summarize(snapshot, new AbortController().signal),
    ).rejects.toThrow();
    expect(rows.at(-1)).toMatchObject({
      dispatched: true,
      outcome: 'timed_out',
      http_status: null,
    });
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
});

it('covers batch Speech with the same reserved-call scope without fabricating a streamed first-content time', async () => {
  await capture(async (rows) => {
    const providers = createAzureProviders(config, async (_url, init) => {
      expect(new Headers(init?.headers).get('x-ms-client-request-id')).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      return new Response(
        JSON.stringify({
          durationMilliseconds: 1000,
          phrases: [
            { offsetMilliseconds: 0, durationMilliseconds: 500, text: secret },
          ],
          combinedPhrases: [{ text: secret }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    await providers.transcribe(
      makeSilentWav(1000),
      'en-US',
      new AbortController().signal,
    );
    expect(rows.at(-1)).toMatchObject({
      operation: 'transcribe',
      outcome: 'returned',
      first_content_ms: null,
    });
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
});

it('bounds subscriber output, reports exact dropped events and rejects unexpected diagnostic fields without content', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const lines: Record<string, unknown>[] = [];
  const callbacks: (() => void)[] = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(String(chunk)));
      callbacks.push(done);
    },
  });
  const close = registerProviderTelemetry(output);
  try {
    for (let index = 0; index < 3; index++)
      await observedProvider(
        'summarize',
        new AbortController().signal,
        async () => {
          currentProviderCall().dispatch();
        },
      );
    expect(lines).toHaveLength(1);
    expect(output.writableLength).toBeLessThan(1024);
    callbacks.shift()!();
    await vi.waitFor(() => expect(lines).toHaveLength(2));
    expect(lines[1]).toMatchObject({
      code: 'provider_telemetry_dropped',
      count: '5',
    });
    channel('windows-ai-notes.provider-calls').publish({ notes: secret });
    expect(errors).toHaveBeenCalledWith(
      JSON.stringify({ code: 'provider_telemetry_invalid_event' }),
    );
    expect(JSON.stringify(errors.mock.calls)).not.toContain(secret);
  } finally {
    for (const done of callbacks) done();
    close();
  }
  expect(output.listenerCount('error')).toBe(0);
});

it('reports synchronous sink failure without allowing a diagnostics subscriber to change provider results', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const output = new Writable({
    write() {
      throw new Error(secret);
    },
  });
  const close = registerProviderTelemetry(output);
  try {
    await expect(
      observedProvider('answer', new AbortController().signal, async () => {
        currentProviderCall().dispatch();
        return 7;
      }),
    ).resolves.toBe(7);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('provider_telemetry_unavailable'),
    );
    expect(JSON.stringify(errors.mock.calls)).not.toContain(secret);
  } finally {
    close();
  }
});
