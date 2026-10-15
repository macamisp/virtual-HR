/**
 * S3-compatible object storage (MinIO locally, S3 in production). The bucket is private;
 * browsers only ever receive 5-minute presigned UploadPart URLs (SRS 10.3). Every key starts
 * with the org id (SRS 3.4):
 *   {org}/_staging/{document}/{version}     plaintext as uploaded, until the scan finishes
 *   {org}/{document}/{version}              AES-256-GCM ciphertext (the stored version)
 *   {org}/_quarantine/{document}/{version}  infected uploads, never served
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';

export const OBJECT_STORE = Symbol('OBJECT_STORE');
export const PRESIGN_SECONDS = 300;

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface ObjectStore {
  createMultipart(key: string): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number): Promise<string>;
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  size(key: string): Promise<number>;
  range(key: string, start: number, endInclusive: number): Promise<Buffer>;
  stream(key: string): Promise<Readable>;
  put(key: string, body: Readable, length: number): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const keys = {
  staging: (org: string, doc: string, version: string) => `${org}/_staging/${doc}/${version}`,
  stored: (org: string, doc: string, version: string) => `${org}/${doc}/${version}`,
  quarantine: (org: string, doc: string, version: string) => `${org}/_quarantine/${doc}/${version}`,
};

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  /** Signs URLs for the host the browser can reach (may differ from the API's view). */
  private readonly signer: S3Client;
  private bucketReady: Promise<void> | null = null;

  constructor(private readonly bucket: string, env: Record<string, string | undefined> = process.env) {
    const base = {
      region: env.S3_REGION || 'us-east-1',
      forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
      // Read from the environment, never hard-coded (gitleaks matches the property name).
      credentials: env.S3_ACCESS_KEY && env.S3_SECRET_KEY ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } : undefined, // gitleaks:allow
      // Presigned part URLs are signed before the browser has the bytes, so no checksum can be
      // baked into them (the SDK default would sign one for an empty body). Integrity comes from
      // the part ETags at completion and the SHA-256 computed at encryption.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.client = new S3Client({ ...base, endpoint: env.S3_ENDPOINT || undefined });
    this.signer = new S3Client({ ...base, endpoint: env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT || undefined });
  }

  /** Local/dev convenience: create the bucket on first use (S3_CREATE_BUCKET=true). */
  private async ready(): Promise<void> {
    if (process.env.S3_CREATE_BUCKET !== 'true') return;
    this.bucketReady ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      }
    })();
    await this.bucketReady;
  }

  async createMultipart(key: string): Promise<string> {
    await this.ready();
    const res = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: 'application/octet-stream' }));
    if (!res.UploadId) throw new Error('Storage did not start the upload');
    return res.UploadId;
  }

  async presignPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return await getSignedUrl(this.signer, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: PRESIGN_SECONDS });
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const out: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const res = await this.client.send(new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
      for (const p of res.Parts ?? []) out.push({ partNumber: p.PartNumber ?? 0, etag: p.ETag ?? '', size: p.Size ?? 0 });
      marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
    } while (marker);
    return out;
  }

  async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<void> {
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }));
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
  }

  async size(key: string): Promise<number> {
    const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.ContentLength ?? 0;
  }

  async range(key: string, start: number, endInclusive: number): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${endInclusive}` }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async stream(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }

  async put(key: string, body: Readable, length: number): Promise<void> {
    await this.ready();
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentLength: length, ContentType: 'application/octet-stream' }));
  }

  async copy(from: string, to: string): Promise<void> {
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: `${this.bucket}/${encodeURI(from)}` }));
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function objectStoreFromEnv(env: Record<string, string | undefined> = process.env): ObjectStore {
  return new S3ObjectStore(env.S3_BUCKET || 'hrvo-documents', env);
}
