import {
  GetBucketAclCommand,
  GetBucketPolicyCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

export function objectStoreStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && '$metadata' in error) {
    const metadata = error.$metadata;
    if (
      metadata &&
      typeof metadata === 'object' &&
      'httpStatusCode' in metadata &&
      typeof metadata.httpStatusCode === 'number'
    )
      return metadata.httpStatusCode;
  }
}

export async function assertPrivateBucketAccess(
  client: S3Client,
  bucket: string,
  signal: AbortSignal,
) {
  const input = { Bucket: bucket };
  const acl = await client.send(new GetBucketAclCommand(input), {
    abortSignal: signal,
  });
  if (acl.Grants?.some((grant) => grant.Grantee?.Type === 'Group'))
    throw new Error(
      'Private object storage must not grant public or authenticated-group bucket access.',
    );
  try {
    const policy = await client.send(new GetBucketPolicyCommand(input), {
      abortSignal: signal,
    });
    if (policy.Policy) {
      const parsed: unknown = JSON.parse(policy.Policy);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('Statement' in parsed) ||
        !Array.isArray(parsed.Statement)
      )
        throw new Error('The private bucket policy could not be validated.');
      for (const statement of parsed.Statement) {
        if (
          statement &&
          typeof statement === 'object' &&
          statement.Effect === 'Allow'
        ) {
          const wildcard = (value: unknown): boolean =>
            typeof value === 'string'
              ? value.includes('*')
              : Array.isArray(value) &&
                value.some(
                  (item) => typeof item === 'string' && item.includes('*'),
                );
          const principal: unknown = statement.Principal;
          if (
            statement.NotPrincipal !== undefined ||
            wildcard(principal) ||
            (principal &&
              typeof principal === 'object' &&
              Object.values(principal).some(wildcard))
          )
            throw new Error(
              'Private object storage must not have a public allow policy.',
            );
        }
      }
    }
  } catch (error) {
    if (objectStoreStatus(error) !== 404) throw error;
  }
}
