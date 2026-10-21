import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const azureNames = [
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_SPEECH_KEY',
  'AZURE_SPEECH_REGION',
] as const;
const configSchema = z.object({
  AZURE_OPENAI_ENDPOINT: z.url(),
  AZURE_OPENAI_API_KEY: z.string().min(16),
  AZURE_OPENAI_API_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}(-preview)?$/),
  AZURE_OPENAI_DEPLOYMENT: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_.-]+$/),
  AZURE_SPEECH_KEY: z.string().min(16),
  AZURE_SPEECH_REGION: z.string().regex(/^[a-z0-9]{2,32}$/),
});
export type AzureConfig = z.infer<typeof configSchema>;

export function loadAzureConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AzureConfig {
  const selected: Record<string, string | undefined> = {};
  if (environment.AZURE_ENV_FILE) {
    let imported: Record<string, string | undefined>;
    try {
      imported = parseEnv(readFileSync(environment.AZURE_ENV_FILE, 'utf8'));
    } catch {
      throw new Error(
        'AZURE_ENV_FILE could not be read. Its contents were not logged.',
      );
    }
    for (const key of azureNames) selected[key] = imported[key];
  }
  for (const key of azureNames) {
    if (environment[key] !== undefined) selected[key] = environment[key];
  }
  const parsed = configSchema.safeParse(selected);
  if (!parsed.success) {
    throw new Error(
      `Invalid Azure configuration fields: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  const endpoint = new URL(parsed.data.AZURE_OPENAI_ENDPOINT);
  if (
    endpoint.protocol !== 'https:' ||
    !endpoint.hostname.endsWith('.openai.azure.com') ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.port ||
    endpoint.pathname !== '/'
  ) {
    throw new Error(
      'AZURE_OPENAI_ENDPOINT must be an HTTPS Azure OpenAI resource origin.',
    );
  }
  return parsed.data;
}
