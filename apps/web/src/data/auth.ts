import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import {
  useAcceptInvitation as useAcceptInvitationMutation,
  useChangePassword as useChangePasswordMutation,
  useConfirmPasswordReset as useConfirmPasswordResetMutation,
  getMe,
  useGetInvitation,
  useGetMe,
  useRequestPasswordReset as useRequestPasswordResetMutation,
  useSignIn as useSignInMutation,
  useSignOut as useSignOutMutation,
  useSignOutAll as useSignOutAllMutation,
  useUpdateMe as useUpdateMeMutation,
} from '../api/generated/identity/identity';

import { mapError } from './errors';

import type { RealtimeClient } from './socket';
import type { GetInvitation200, Me, UpdateMeBody } from '../api/generated/model';

/**
 * Staff auth and profile hooks (data-hooks rule 6): components never import
 * `api/generated/identity` directly. `useMe` treats an unauthenticated session as a mapped error
 * rather than retrying (there is no point retrying a 401).
 */

export const meKeys = {
  all: ['me'] as const,
};

export function useMe() {
  const query = useGetMe({
    query: {
      queryKey: meKeys.all,
      retry: false,
    },
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

/**
 * The signed-in staff member as far as this page already knows (sign-in, or a page that loaded
 * `/me`), without fetching: the workspace area uses it to decide whether to open a socket.
 */
export function useKnownMe(): Me | undefined {
  // The queryFn is never called here (disabled), but the query keeps the options of its latest
  // observer, so it has to be the real one for other observers' refetches.
  return useQuery({ queryKey: meKeys.all, queryFn: ({ signal }) => getMe({ signal }), enabled: false }).data;
}

export function useSignIn() {
  const queryClient = useQueryClient();
  const mutation = useSignInMutation({
    mutation: {
      onSuccess: (me) => {
        queryClient.setQueryData(meKeys.all, me);
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (data: { email: string; password: string }) => mutation.mutateAsync({ data }),
  };
}

export function useSignOut() {
  const queryClient = useQueryClient();
  const mutation = useSignOutMutation({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
      },
    },
  });
  return { ...mutation, mutateAsync: () => mutation.mutateAsync(undefined) };
}

export function useSignOutAll() {
  const queryClient = useQueryClient();
  const mutation = useSignOutAllMutation({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
      },
    },
  });
  return { ...mutation, mutateAsync: () => mutation.mutateAsync(undefined) };
}

export function useRequestPasswordReset() {
  const mutation = useRequestPasswordResetMutation();
  return {
    ...mutation,
    mutateAsync: (data: { email: string }) => mutation.mutateAsync({ data }),
  };
}

export function useConfirmPasswordReset() {
  const mutation = useConfirmPasswordResetMutation();
  return {
    ...mutation,
    mutateAsync: (data: { token: string; password: string }) => mutation.mutateAsync({ data }),
  };
}

export function useInvitation(token: string) {
  const query = useGetInvitation<GetInvitation200>(token, {
    query: { queryKey: ['invitation', token] },
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export function useAcceptInvitation(token: string) {
  const queryClient = useQueryClient();
  const mutation = useAcceptInvitationMutation({
    mutation: {
      onSuccess: (me) => {
        queryClient.setQueryData(meKeys.all, me);
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (data: { name: string; password: string }) => mutation.mutateAsync({ token, data }),
  };
}

export function useUpdateMe() {
  const queryClient = useQueryClient();
  const mutation = useUpdateMeMutation({
    mutation: {
      onSuccess: (me: Me) => {
        queryClient.setQueryData(meKeys.all, me);
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (data: UpdateMeBody) => mutation.mutateAsync({ data }),
  };
}

export function useChangePassword() {
  const mutation = useChangePasswordMutation();
  return {
    ...mutation,
    mutateAsync: (data: { currentPassword: string; newPassword: string }) => mutation.mutateAsync({ data }),
  };
}

/**
 * Refetches `/me` whenever access changes (role/group updates elsewhere invalidate this user's
 * effective permissions); `accessVersion` on `Me` is the signal the server bumps.
 */
export function useAccessChangeRefetch(client: RealtimeClient | undefined): void {
  useEffect(() => {
    if (!client) return undefined;
    return client.onEvent('access.changed', (_envelope, queryClient) => {
      void queryClient.invalidateQueries({ queryKey: meKeys.all });
    });
  }, [client]);
}
