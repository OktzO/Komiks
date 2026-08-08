// Self-check: provisionAccount flow. Fake token → graceful throw on verify.
import { provisionAccount, checkProvisionStatus } from '../provision.ts';

const mockEnv = {
  LB_ENCRYPTION_KEY: 'test-key-32-bytes-long-aaaaaaaaa',
  CACHE_KV: {
    put: async () => {},
    get: async (k) => k.includes('done') ? JSON.stringify({ status: 'completed', step: 'done', workerUrl: 'https://manga-api-1.xxx.workers.dev' }) : null,
  },
  DB: {
    prepare: () => ({
      bind: () => ({ run: async () => {}, first: async () => null, all: async () => ({ results: [] }) }),
    }),
  },
};

const mockInput = { label: 'test', cfApiToken: 'fake-token', workerName: 'manga-api-test' };

try {
  const result = await provisionAccount(mockEnv, mockInput);
  if (typeof result.jobId !== 'string') throw new Error('jobId should be string');
  // Fake token → job should be 'failed' but function returns gracefully
  const status = await checkProvisionStatus(mockEnv, result.jobId);
  if (!status) throw new Error('status should exist');
  if (status.status !== 'failed' && status.status !== 'pending' && status.status !== 'verifying') {
    throw new Error(`unexpected status: ${status.status}`);
  }
  console.log('provision.test passed — jobId:', result.jobId, 'status:', status.status);
} catch (e) {
  console.error('provision.test FAILED:', String(e));
  process.exit(1);
}
