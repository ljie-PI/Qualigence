import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

/** S3-compatible object store configuration for the admin CLI. */
export interface S3Config {
  readonly region: string;
  readonly endpoint?: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

/** A stored object as seen during backup enumeration. */
export interface S3ObjectSummary {
  readonly key: string;
  readonly sizeBytes: number;
}

export function createS3Client(config: S3Config): S3Client {
  const clientConfig: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };
  if (config.endpoint !== undefined) {
    clientConfig.endpoint = config.endpoint;
  }
  return new S3Client(clientConfig);
}

/** Confirm the bucket exists and is reachable (used by `doctor`). */
export async function headBucket(client: S3Client, bucket: string): Promise<void> {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}

/** Ensure the configured restore bucket exists before empty-target validation. */
export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await headBucket(client, bucket);
    return;
  } catch (error) {
    if (!isMissingBucket(error)) throw error;
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!isBucketAlreadyExists(error)) throw error;
  }
  await headBucket(client, bucket);
}

function isMissingBucket(error: unknown): boolean {
  const candidate = error as { readonly name?: string; readonly Code?: string; readonly $metadata?: { readonly httpStatusCode?: number } };
  return candidate.name === "NotFound" || candidate.Code === "NoSuchBucket" || candidate.$metadata?.httpStatusCode === 404;
}

function isBucketAlreadyExists(error: unknown): boolean {
  const candidate = error as { readonly name?: string; readonly Code?: string };
  return candidate.name === "BucketAlreadyOwnedByYou" || candidate.name === "BucketAlreadyExists" || candidate.Code === "BucketAlreadyOwnedByYou" || candidate.Code === "BucketAlreadyExists";
}

/** Enumerate every object in the bucket, following continuation tokens. */
export async function enumerateObjects(
  client: S3Client,
  bucket: string,
): Promise<S3ObjectSummary[]> {
  const objects: S3ObjectSummary[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
      }),
    );
    for (const item of response.Contents ?? []) {
      if (item.Key !== undefined) {
        objects.push({ key: item.Key, sizeBytes: item.Size ?? 0 });
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken !== undefined);
  objects.sort((a, b) => a.key.localeCompare(b.key));
  return objects;
}

export async function getObjectBytes(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (response.Body === undefined) {
    throw new Error(`object ${key} returned an empty body`);
  }
  return response.Body.transformToByteArray();
}

export async function putObjectBytes(
  client: S3Client,
  bucket: string,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }),
  );
}

/** Delete every object in the bucket (used to prepare a clean restore target). */
export async function emptyBucket(client: S3Client, bucket: string): Promise<number> {
  const objects = await enumerateObjects(client, bucket);
  for (const object of objects) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.key }));
  }
  return objects.length;
}
