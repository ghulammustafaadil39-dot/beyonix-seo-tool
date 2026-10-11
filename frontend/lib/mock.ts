/**
 * Mock-data adapter framework (Wave 2, Frontend Lead).
 *
 * Several Phase-3 feature UIs are being built BEFORE their backend
 * endpoints exist (Backend Lead owns those endpoints; LA relays shapes
 * via follow-up messages). To keep every page renderable and reviewable
 * in the meantime, each feature gets a clearly-marked adapter file under
 * lib/mock/<feature>.ts. Every adapter:
 *   - returns TYPED data matching the intended contract,
 *   - marks the result as mock so the UI must show <MockBanner/>,
 *   - is replaced by a real fetch the moment the endpoint lands.
 *
 * RULE: never render mock data without MockBanner, and never present
 * mock data as real. See components/MockBanner.tsx.
 */
import { ApiError } from './api';

export interface Mocked<T> {
  data: T;
  mock: true;
}

/** Statuses where falling back is acceptable (endpoint not landed yet). */
export function isBackendPending(err: unknown): boolean {
  if (err instanceof ApiError) {
    // 404 = route not registered yet, 501 = stubbed route, 0 = no API reachable in dev.
    return err.status === 404 || err.status === 501 || err.status === 0;
  }
  return false;
}

/**
 * Try the real API first; on a "not there yet" failure, fall back to the
 * mock supplier. Returns [data, isMock] so the caller can banner it.
 */
export async function withMockFallback<T>(
  real: () => Promise<T>,
  mock: () => Promise<T>,
): Promise<{ data: T; mock: boolean }> {
  try {
    return { data: await real(), mock: false };
  } catch (e) {
    if (isBackendPending(e)) {
      return { data: await mock(), mock: true };
    }
    throw e;
  }
}
