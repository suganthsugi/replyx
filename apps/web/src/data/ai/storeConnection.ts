import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getStoreConnection,
  useDeleteStoreConnection,
  usePutStoreConnection,
  useTestStoreConnection as useTestStoreConnectionMutation,
} from '../../api/generated/ai/ai';
import { mapError, type UiError } from '../errors';
import { HttpError } from '../http';

import type { ConnectionTest, PutStoreConnectionBody, StoreConnection } from '../../api/generated/model';

/**
 * The store connection for order lookups (specs/002-ai-assist US3). Needs `ai_settings.manage`;
 * pass `enabled = false` without it. The key is write-only: only its last four characters come back.
 * Components never import `api/generated/ai` directly.
 */

export const storeConnectionKeys = {
  all: ['ai-store-connection'] as const,
  detail: () => [...storeConnectionKeys.all, 'detail'] as const,
};

export function isApiCode(error: unknown, status: number, code: string): boolean {
  return error instanceof HttpError && error.status === status && error.error.code === code;
}

/** `data` is `null` when no store is connected (404 `STORE_CONNECTION_NOT_FOUND`), not an error. */
export function useStoreConnection(enabled = true) {
  const query = useQuery<StoreConnection | null, Error>({
    queryKey: storeConnectionKeys.detail(),
    queryFn: async ({ signal }) => {
      try {
        return await getStoreConnection({ signal });
      } catch (error) {
        if (isApiCode(error, 404, 'STORE_CONNECTION_NOT_FOUND')) return null;
        throw error;
      }
    },
    enabled,
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export interface StoreConnectionFormError {
  /** Shown on the store address field. */
  baseUrl?: string;
  /** Shown on the key field (required when the store address changes). */
  apiKey?: string;
  /** Not tied to a field; show as a form-level alert. */
  message?: string;
  code: string;
}

const URL_REASONS: Record<string, string> = {
  invalid_url: 'Enter the full store address, for example https://shop.example.com',
  not_https: 'The store address must start with https://',
  private_address: 'This address points to a private network and cannot be used.',
  unresolvable: 'This address could not be found. Check it for typos.',
};
const URL_FALLBACK = 'ReplyX cannot connect to this address. Use the public https address of your store.';
const KEY_REQUIRED = 'Enter the store key. It is needed when the store address changes.';

export function mapStoreConnectionError(raw: unknown): StoreConnectionFormError {
  const error: UiError = mapError(raw);
  if (error.code === 'STORE_URL_NOT_ALLOWED') {
    return { code: error.code, baseUrl: URL_REASONS[error.fieldErrors?.['baseUrl'] ?? ''] ?? URL_FALLBACK };
  }
  const baseUrl = error.fieldErrors?.['baseUrl'];
  const apiKey = error.fieldErrors?.['apiKey'];
  if (apiKey !== undefined || baseUrl !== undefined) {
    return {
      code: error.code,
      ...(baseUrl === undefined ? {} : { baseUrl: URL_REASONS[baseUrl] ?? 'Check the store address.' }),
      ...(apiKey === undefined ? {} : { apiKey: KEY_REQUIRED }),
    };
  }
  return { code: error.code, message: error.message };
}

/**
 * Creates or replaces the connection. `apiKey` is optional when replacing at the same store
 * address, required when the address changes (the error then lands on `error.apiKey`).
 */
export function useSaveStoreConnection() {
  const queryClient = useQueryClient();
  const mutation = usePutStoreConnection({ mutation: { onSuccess: (connection) => queryClient.setQueryData(storeConnectionKeys.detail(), connection) } });
  return {
    ...mutation,
    error: mutation.error ? mapStoreConnectionError(mutation.error) : undefined,
    mutateAsync: (data: PutStoreConnectionBody) => mutation.mutateAsync({ data }),
  };
}

export function useRemoveStoreConnection() {
  const queryClient = useQueryClient();
  const mutation = useDeleteStoreConnection({ mutation: { onSuccess: () => queryClient.setQueryData(storeConnectionKeys.detail(), null) } });
  return { ...mutation, error: mutation.error ? mapError(mutation.error) : undefined, mutateAsync: () => mutation.mutateAsync() };
}

/** Tests the saved connection; 429 shows as `error.code === 'RATE_LIMITED'` with `retryAfter`. */
export function useTestStoreConnection() {
  const queryClient = useQueryClient();
  const mutation = useTestStoreConnectionMutation({ mutation: { onSettled: () => void queryClient.invalidateQueries({ queryKey: storeConnectionKeys.detail() }) } });
  return { ...mutation, error: mutation.error ? mapError(mutation.error) : undefined, mutateAsync: () => mutation.mutateAsync() };
}

export type { ConnectionTest, PutStoreConnectionBody, StoreConnection };

const STORE_TEST_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_key: 'The store did not accept the key. Check that you copied all of it and that it can read orders.',
  auth: 'The store did not accept the key. Check that you copied all of it and that it can read orders.',
  not_allowed: 'ReplyX is not allowed to connect to this address. Use the public https address of your store.',
  rate_limit: 'The store is busy right now. Try again in a minute.',
  unreachable: "Couldn't reach the store. Check the address and try again.",
  unavailable: "Couldn't reach the store. Check the address and try again.",
  timeout: 'The store did not answer in time. Try again in a minute.',
  unexpected_response: 'The address answered, but not like a Spree store. Check the store address and that Spree is version 5.5 or later.',
  bad_response: 'The address answered, but not like a Spree store. Check the store address and that Spree is version 5.5 or later.',
};

/** Plain-language text for a store connection test error code (`lastTest.error`, `ConnectionTest.error`). */
export function storeTestErrorMessage(code: string | null | undefined): string {
  return (code === null || code === undefined ? undefined : STORE_TEST_ERROR_MESSAGES[code]) ?? "The last test didn't work. Check the address and the key, then test again.";
}
