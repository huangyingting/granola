export class ClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly retryable = false,
    readonly retryAfterSeconds = 0,
    readonly purgeWorkspaceId?: string,
  ) {
    super(message);
  }
}
