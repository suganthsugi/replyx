import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import {
  useApplyMacro as useApplyMacroMutation,
  useCreateMacro as useCreateMacroMutation,
  useDeleteMacro as useDeleteMacroMutation,
  useListMacros,
  useUpdateMacro as useUpdateMacroMutation,
} from '../api/generated/tickets/tickets';

import { mapError, type UiError } from './errors';
import { messageKeys } from './messages';
import { ticketKeys } from './tickets';

import type { ListMacros200, Macro, MacroActions, MacroInput, Ticket } from '../api/generated/model';

/**
 * Macros (US14): canned replies with optional ticket actions. The list is already limited by the
 * API to the macros visible to the caller (own, all staff, shared with their roles or groups).
 * Components never import `api/generated/tickets` directly (data-hooks rule 6). The API emits no
 * `macro.*` realtime events, so there is no socket wiring: mutations patch the cache instead.
 */

export const macroKeys = {
  all: ['macros'] as const,
  list: () => [...macroKeys.all, 'list'] as const,
};

/** Macros visible to the current user (needs `macro.view`). */
export function useMacros() {
  const query = useListMacros<ListMacros200>({ query: { queryKey: macroKeys.list() } });
  return { ...query, data: query.data?.items, error: query.error ? mapError(query.error) : undefined };
}

function patchList(queryClient: ReturnType<typeof useQueryClient>, update: (items: Macro[]) => Macro[]): void {
  queryClient.setQueryData<ListMacros200>(macroKeys.list(), (data) => (data === undefined ? data : { ...data, items: update(data.items) }));
}

export function useCreateMacro() {
  const queryClient = useQueryClient();
  const mutation = useCreateMacroMutation({
    mutation: {
      onSuccess: (macro) => {
        patchList(queryClient, (items) => [...items.filter((item) => item.id !== macro.id), macro]);
        void queryClient.invalidateQueries({ queryKey: macroKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: (data: MacroInput) => mutation.mutateAsync({ data }) };
}

export function useUpdateMacro() {
  const queryClient = useQueryClient();
  const mutation = useUpdateMacroMutation({
    mutation: {
      onSuccess: (macro) => {
        patchList(queryClient, (items) => items.map((item) => (item.id === macro.id ? macro : item)));
        void queryClient.invalidateQueries({ queryKey: macroKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: ({ id, ...data }: { id: string } & MacroInput) => mutation.mutateAsync({ id, data }) };
}

export function useDeleteMacro() {
  const queryClient = useQueryClient();
  const mutation = useDeleteMacroMutation({
    mutation: {
      onSuccess: (_void, { id }) => {
        patchList(queryClient, (items) => items.filter((item) => item.id !== id));
        void queryClient.invalidateQueries({ queryKey: macroKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: ({ id }: { id: string }) => mutation.mutateAsync({ id }) };
}

/** UI message for the apply failures the composer needs to distinguish; other codes keep `mapError`'s text. */
const APPLY_MESSAGES: Record<string, string> = {
  INVALID_TRANSITION: "This macro can't change the ticket to that state from its current one.",
  MACRO_NOT_FOUND: 'This macro no longer exists or is no longer shared with you.',
  PERMISSION_DENIED: "You don't have permission to apply this macro.",
};

export function mapMacroApplyError(raw: unknown): UiError {
  const error = mapError(raw);
  const message = APPLY_MESSAGES[error.code];
  return message === undefined ? error : { ...error, message };
}

export interface ApplyMacroInput {
  macroId: string;
  /** Edited reply text; the server falls back to the macro body when omitted. */
  bodyOverride?: string;
}

/**
 * Apply a macro to a ticket: posts its reply and runs its actions in one call. Each logical apply
 * gets a `clientMessageId` that is kept for retries after a failure (a repeat returns the ticket
 * without applying twice) and renewed after a success.
 */
export function useApplyMacro(ticketId: string) {
  const queryClient = useQueryClient();
  const pendingId = useRef<string | null>(null);
  const mutation = useApplyMacroMutation({
    mutation: {
      onSuccess: (ticket: Ticket) => {
        pendingId.current = null;
        queryClient.setQueryData(ticketKeys.detail(ticketId), ticket);
        void queryClient.invalidateQueries({ queryKey: [...messageKeys.all, ticketId] });
        void queryClient.invalidateQueries({ queryKey: ticketKeys.history(ticketId) });
        void queryClient.invalidateQueries({ queryKey: [...ticketKeys.all, 'list'] });
      },
    },
  });
  const { mutateAsync: run } = mutation;
  const apply = useCallback(
    ({ macroId, bodyOverride }: ApplyMacroInput) => {
      pendingId.current ??= crypto.randomUUID();
      return run({ id: ticketId, data: { macroId, clientMessageId: pendingId.current, ...(bodyOverride === undefined ? {} : { bodyOverride }) } });
    },
    [run, ticketId],
  );
  return { ...mutation, mutateAsync: apply, error: mutation.error ? mapMacroApplyError(mutation.error) : undefined };
}

/** Case-insensitive match on name then body for the composer's `/` picker; name matches first. Empty query returns all. */
export function filterMacros(macros: readonly Macro[], query: string): Macro[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...macros];
  const byName: Macro[] = [];
  const byBody: Macro[] = [];
  for (const macro of macros) {
    const name = macro.name.toLowerCase();
    if (name.startsWith(needle)) byName.unshift(macro);
    else if (name.includes(needle)) byName.push(macro);
    else if (macro.body.toLowerCase().includes(needle)) byBody.push(macro);
  }
  return [...byName, ...byBody];
}

export type { Macro, MacroActions, MacroInput };
