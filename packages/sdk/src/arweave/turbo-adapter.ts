/**
 * Arweave upload adapter wrapping @ardrive/turbo-sdk.
 *
 * This is the ONLY file that imports @ardrive/turbo-sdk, isolating the
 * external dependency behind an interface (risk E8-R002).
 */

import { Readable } from 'node:stream';

/**
 * Interface for uploading data to Arweave.
 * Implementations wrap a specific Arweave upload SDK.
 */
export interface ArweaveUploadAdapter {
  upload(
    data: Buffer,
    tags?: Record<string, string>
  ): Promise<{ txId: string }>;
}

/**
 * Turbo SDK upload adapter using @ardrive/turbo-sdk.
 *
 * - Dev/free tier (<=100KB): pass no turboClient, uses TurboFactory.unauthenticated()
 * - Prod (paid, uncapped): pass a TurboAuthenticatedClient from TurboFactory.authenticated()
 *
 * The turboClient is typed as `unknown` to avoid importing @ardrive/turbo-sdk types
 * in this interface. The actual TurboAuthenticatedClient or TurboUnauthenticatedClient
 * is duck-typed at runtime.
 */
export class TurboUploadAdapter implements ArweaveUploadAdapter {
  private turboClient: unknown;
  private initialized = false;

  constructor(turboClient?: unknown) {
    if (turboClient) {
      this.turboClient = turboClient;
      this.initialized = true;
    }
  }

  private async getClient(): Promise<unknown> {
    if (!this.initialized) {
      // Lazy-import to avoid loading @ardrive/turbo-sdk unless actually used
      const { TurboFactory } = await import('@ardrive/turbo-sdk/node');
      this.turboClient = TurboFactory.unauthenticated();
      this.initialized = true;
    }
    return this.turboClient;
  }

  async upload(
    data: Buffer,
    tags?: Record<string, string>
  ): Promise<{ txId: string }> {
    const client = (await this.getClient()) as {
      uploadFile(params: {
        fileStreamFactory: () => Readable;
        fileSizeFactory: () => number;
        dataItemOpts?: { tags: { name: string; value: string }[] };
      }): Promise<{ id: string }>;
    };

    // Convert Record<string, string> to tag array format
    const tagArray: { name: string; value: string }[] = [];
    if (tags) {
      for (const [name, value] of Object.entries(tags)) {
        tagArray.push({ name, value });
      }
    }

    const result = await client.uploadFile({
      fileStreamFactory: () => Readable.from(data),
      fileSizeFactory: () => data.length,
      ...(tagArray.length > 0 ? { dataItemOpts: { tags: tagArray } } : {}),
    });

    return { txId: result.id };
  }
}
