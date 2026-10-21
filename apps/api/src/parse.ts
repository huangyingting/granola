import type { z } from 'zod';
import { ServiceError } from '@windows-ai-notes/contracts/server';

export function parse<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ServiceError(
      'invalid_request',
      'The request does not match the documented contract.',
      400,
    );
  return result.data;
}
