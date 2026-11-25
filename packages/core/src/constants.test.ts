import { describe, it, expect } from 'vitest';
import {
  BLOB_STORAGE_REQUEST_KIND,
  BLOB_STORAGE_RESULT_KIND,
} from './constants.js';

describe('Blob storage kind constants', () => {
  it('should define the request kind as 5094', () => {
    expect(BLOB_STORAGE_REQUEST_KIND).toBe(5094);
  });

  it('should define the result kind as request kind + 1000', () => {
    expect(BLOB_STORAGE_RESULT_KIND).toBe(6094);
    expect(BLOB_STORAGE_RESULT_KIND).toBe(BLOB_STORAGE_REQUEST_KIND + 1000);
  });
});
