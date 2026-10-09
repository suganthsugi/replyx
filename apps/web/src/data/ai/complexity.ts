import { useQueryClient } from '@tanstack/react-query';

import { useGetComplexityConfig, usePutComplexityConfig } from '../../api/generated/ai/ai';
import { mapError } from '../errors';

import type { ComplexityConfig, ComplexityFactor, ComplexityFactorKind } from '../../api/generated/model';

/**
 * Complexity factors and thresholds (specs/002-ai-assist US4, FR-025/026, `ai_settings.manage`).
 * A save replaces the whole set; the saved set comes back and replaces the cache. Field errors keep
 * the API's paths (`factors.2.weight`, `thresholds.advanced`), which the page's `Form` puts on
 * the matching field.
 */

export const complexityKeys = {
  all: ['ai-complexity'] as const,
  config: () => [...complexityKeys.all, 'config'] as const,
};

export function useComplexity(enabled = true) {
  const query = useGetComplexityConfig<ComplexityConfig>({ query: { queryKey: complexityKeys.config(), enabled } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export function useSaveComplexity() {
  const queryClient = useQueryClient();
  const mutation = usePutComplexityConfig({ mutation: { onSuccess: (saved) => queryClient.setQueryData(complexityKeys.config(), saved) } });
  return {
    ...mutation,
    error: mutation.error ? mapError(mutation.error) : undefined,
    mutateAsync: (data: ComplexityConfig) => mutation.mutateAsync({ data }),
  };
}

export type { ComplexityConfig, ComplexityFactor, ComplexityFactorKind };
