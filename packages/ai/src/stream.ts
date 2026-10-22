import { z } from 'zod';
import { SseDecoder } from '@windows-ai-notes/contracts/sse';
import { ServiceError, type Usage } from '@windows-ai-notes/contracts/server';

export type PreviewReporter = (text: string) => Promise<void>;
const receipt = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
});
const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        delta: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
        }),
        finish_reason: z.string().nullable(),
      }),
    )
    .max(1),
  usage: receipt.nullish(),
});
const invalid = () =>
  new ServiceError(
    'invalid_model_output',
    'Azure returned an incomplete or invalid generation stream.',
    502,
  );

// Decode only the known leading overview string, never unfinished JSON or citations.
export function overviewPreview(content: string): string | null {
  return leadingText(content, 'overview');
}
export function answerPreview(content: string): string | null {
  return leadingText(content, 'answer');
}
function leadingText(
  content: string,
  field: 'overview' | 'answer',
): string | null {
  const match = new RegExp(
    `^\\s*\\{\\s*"${field}"\\s*:\\s*\\{\\s*"text"\\s*:\\s*"`,
    'u',
  ).exec(content);
  if (!match) return null;
  let result = '';
  for (
    let index = match[0].length;
    index < content.length && result.length < 4000;
    index++
  ) {
    const char = content[index]!;
    if (char === '"') break;
    if (char.charCodeAt(0) < 32) return null;
    if (char !== '\\') result += char;
    else {
      const escaped = content[++index];
      if (escaped === undefined) break;
      if (escaped === 'u') {
        const hex = content.slice(index + 1, index + 5);
        if (hex.length < 4) break;
        if (!/^[\da-f]{4}$/iu.test(hex)) return null;
        result += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
      } else {
        const escapes: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
        if (!(escaped in escapes)) return null;
        result += escapes[escaped];
      }
    }
  }
  if (result.includes('\0')) return null;
  return result.replace(/[\uD800-\uDBFF]$/u, '');
}

export async function readAzureStream(
  response: Response,
  signal: AbortSignal,
  preview: PreviewReporter,
  reportUsage?: (usage: Usage) => Promise<void>,
  project: (content: string) => string | null = overviewPreview,
  firstContent?: () => void,
) {
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('text/event-stream') ||
    !response.body
  )
    throw invalid();
  const reader = response.body.getReader();
  const decoder = new SseDecoder();
  let bytes = 0,
    content = '',
    finish: string | null = null,
    done = false,
    refused = false;
  let contentObserved = false;
  let usage: z.infer<typeof receipt> | null = null;
  let previousPreview: string | null = null;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      const frames = part.done ? decoder.finish() : decoder.push(part.value);
      if (!part.done) bytes += part.value.length;
      if (bytes > 4 * 1024 * 1024)
        throw new ServiceError(
          'provider_response_too_large',
          'The generation stream exceeds its transport budget.',
          502,
        );
      for (const frame of frames) {
        if (done) throw invalid();
        if (frame.data === '[DONE]') {
          done = true;
          continue;
        }
        const parsed = chunkSchema.safeParse(JSON.parse(frame.data) as unknown);
        if (!parsed.success) throw invalid();
        if (parsed.data.usage) {
          if (usage) throw invalid();
          usage = parsed.data.usage;
          await reportUsage?.({
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            audio_ms: 0,
          });
        }
        for (const choice of parsed.data.choices) {
          if (finish !== null) throw invalid();
          refused ||= Boolean(choice.delta.refusal);
          if (!contentObserved && choice.delta.content) {
            contentObserved = true;
            firstContent?.();
          }
          content += choice.delta.content ?? '';
          if (Buffer.byteLength(content) > 512 * 1024)
            throw new ServiceError(
              'provider_response_too_large',
              'The generated content exceeds its byte budget.',
              502,
            );
          const text = project(content);
          if (text !== null && text !== previousPreview) {
            await preview(text);
            previousPreview = text;
          }
          if (choice.finish_reason !== null) finish = choice.finish_reason;
        }
      }
      if (part.done) break;
    }
    if (!done || finish !== 'stop' || !usage || refused) throw invalid();
    return {
      choices: [{ finish_reason: finish, message: { content } }],
      usage,
    };
  } catch (error) {
    if (error instanceof ServiceError || signal.aborted) throw error;
    throw invalid();
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
