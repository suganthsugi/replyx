import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createBusinessHours,
  createSlaPolicy,
  deleteBusinessHours,
  deleteSlaPolicy,
  listBusinessHours,
  listSlaPolicies,
  updateBusinessHours,
  updateSlaPolicy,
} from '../api/generated/operations/operations';

import { mapError } from './errors';
import { ticketKeys } from './tickets';

import type {
  BusinessHours,
  BusinessHoursInput,
  ListBusinessHours200,
  ListSlaPolicies200,
  SlaPolicy,
  SlaPolicyInput,
} from '../api/generated/model';
import type { QueryClient } from '@tanstack/react-query';

/**
 * SLA policies and business-hours calendars (US12, FR-085): admin lists and their mutations. Not
 * realtime. The server re-applies SLA to open tickets after any change, so every mutation also
 * invalidates the ticket queries (their `sla` summary). Mutations throw the raw error so forms can
 * map `VALIDATION_FAILED` details and `409` conflicts with `mapError`.
 */

export const slaKeys = {
  all: ['sla'] as const,
  policies: () => [...slaKeys.all, 'policies'] as const,
  businessHours: () => [...slaKeys.all, 'business-hours'] as const,
};

export function useSlaPolicies() {
  const query = useQuery<ListSlaPolicies200>({
    queryKey: slaKeys.policies(),
    queryFn: ({ signal }) => listSlaPolicies({ signal }),
    select: (data) => ({ ...data, items: [...data.items].sort((a, b) => a.position - b.position) }),
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export function useBusinessHoursList() {
  const query = useQuery<ListBusinessHours200>({
    queryKey: slaKeys.businessHours(),
    queryFn: ({ signal }) => listBusinessHours({ signal }),
    select: (data) => ({ ...data, items: [...data.items].sort((a, b) => a.name.localeCompare(b.name)) }),
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

/** Policies and calendars reference each other (and the branding message), and tickets carry `sla`. */
function invalidateSla(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: slaKeys.all });
  void queryClient.invalidateQueries({ queryKey: ticketKeys.all });
}

function useOnSuccess() {
  const queryClient = useQueryClient();
  return () => invalidateSla(queryClient);
}

export function useCreateSlaPolicy() {
  const onSuccess = useOnSuccess();
  return useMutation<SlaPolicy, unknown, SlaPolicyInput>({ mutationFn: (body) => createSlaPolicy(body), onSuccess });
}

export function useUpdateSlaPolicy() {
  const onSuccess = useOnSuccess();
  return useMutation<SlaPolicy, unknown, { id: string; body: SlaPolicyInput }>({
    mutationFn: ({ id, body }) => updateSlaPolicy(id, body),
    onSuccess,
  });
}

export function useDeleteSlaPolicy() {
  const onSuccess = useOnSuccess();
  return useMutation<void, unknown, string>({ mutationFn: (id) => deleteSlaPolicy(id), onSuccess });
}

export function useCreateBusinessHours() {
  const onSuccess = useOnSuccess();
  return useMutation<BusinessHours, unknown, BusinessHoursInput>({ mutationFn: (body) => createBusinessHours(body), onSuccess });
}

export function useUpdateBusinessHours() {
  const onSuccess = useOnSuccess();
  return useMutation<BusinessHours, unknown, { id: string; body: BusinessHoursInput }>({
    mutationFn: ({ id, body }) => updateBusinessHours(id, body),
    onSuccess,
  });
}

export function useDeleteBusinessHours() {
  const onSuccess = useOnSuccess();
  return useMutation<void, unknown, string>({ mutationFn: (id) => deleteBusinessHours(id), onSuccess });
}

export type { BusinessHours, BusinessHoursInput, SlaPolicy, SlaPolicyInput };
