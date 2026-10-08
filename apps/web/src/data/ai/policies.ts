import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import {
  useCreatePolicyDocument as useCreatePolicyDocumentMutation,
  useCreatePolicyVersion as useCreatePolicyVersionMutation,
  useDeletePolicyDocument as useDeletePolicyDocumentMutation,
  useGetPolicyDocument,
  useListPolicyDocuments,
  useRenamePolicyDocument as useRenamePolicyDocumentMutation,
} from '../../api/generated/ai/ai';
import { useAttachmentUploads } from '../attachments';
import { mapError, type UiError } from '../errors';

import type {
  ListPolicyDocuments200,
  PolicyDocument,
  PolicyDocumentDetail,
  PolicyDocumentInput,
  PolicyStatus,
  PolicyVersion,
  PolicyVersionInput,
  PolicyVersionStatus,
} from '../../api/generated/model';
import type { RealtimeClient } from '../socket';

/**
 * Policy documents (specs/002-ai-assist US2): the knowledge the assistant answers from. Needs
 * `ai_knowledge.manage`; pass `enabled = false` without it. Components never import
 * `api/generated/ai` directly.
 *
 * Real time: `usePolicyEvents` applies `ai.policy_version_updated` (`{ documentId, versionId,
 * status }`, sent to holders of `ai_knowledge.manage`) so status chips change without a reload.
 *
 * Files: upload with `usePolicyFileUpload` (the staff attachment uploader), then pass the ready
 * attachment's `id` as `attachmentId` to create/new-version. Send `text` or `attachmentId`, not both.
 */

export const policyKeys = {
  all: ['ai-policies'] as const,
  list: () => [...policyKeys.all, 'list'] as const,
  detail: (id: string) => [...policyKeys.all, 'detail', id] as const,
};

export type { PolicyDocument, PolicyDocumentDetail, PolicyDocumentInput, PolicyStatus, PolicyVersion, PolicyVersionInput, PolicyVersionStatus };

export function usePolicyDocuments(enabled = true) {
  const query = useListPolicyDocuments<ListPolicyDocuments200>({ query: { queryKey: policyKeys.list(), enabled } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export function usePolicyDocument(id: string | undefined, enabled = true) {
  const query = useGetPolicyDocument<PolicyDocumentDetail>(id ?? '', { query: { queryKey: policyKeys.detail(id ?? ''), enabled: enabled && id !== undefined } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

/** Field errors and a message for the policy forms, from a thrown mutation error. */
export interface PolicyFormError {
  /** Shown on the title field (`POLICY_TITLE_TAKEN` or a 400 on `title`). */
  title?: string;
  /** Shown on the file/attachment field (`ATTACHMENT_BLOCKED` or a 400 on `attachmentId`). */
  attachmentId?: string;
  /** Shown on the text field (`PAYLOAD_TOO_LARGE`). */
  text?: string;
  /** Anything not tied to a field; show as a form-level alert. */
  message?: string;
  code: string;
}

const TITLE_TAKEN_MESSAGE = 'A policy with this title already exists. Choose a different title.';
const ATTACHMENT_BLOCKED_MESSAGE = 'This file was blocked by the security scan. Upload a different file.';

const TOO_LONG_MESSAGE = 'This policy is too long. Split it into smaller policies.';

const POLICY_ERROR_MESSAGES: Record<string, string> = {
  no_extractable_text: "We couldn't find any text in this file. Upload a text-based PDF, or paste the text instead.",
  blocked_by_scan: 'The file was blocked by the virus scan.',
  embedding_failed: 'The AI provider could not process this policy. Check the AI key in AI settings, then save again.',
  too_large: TOO_LONG_MESSAGE,
  unsupported_type: "This file type isn't supported. Use a .txt, .md or .pdf file.",
};

/** Plain-language text for a document or version `error` code, with a generic fallback. */
export function policyErrorMessage(code: string | null | undefined): string {
  return (code === null || code === undefined ? undefined : POLICY_ERROR_MESSAGES[code]) ?? 'This policy could not be processed. Try uploading it again.';
}

export function mapPolicyError(raw: unknown): PolicyFormError {
  const error: UiError = mapError(raw);
  if (error.code === 'PAYLOAD_TOO_LARGE') return { code: error.code, text: TOO_LONG_MESSAGE };
  if (error.code === 'POLICY_TITLE_TAKEN') return { code: error.code, title: TITLE_TAKEN_MESSAGE };
  if (error.code === 'ATTACHMENT_BLOCKED') return { code: error.code, attachmentId: ATTACHMENT_BLOCKED_MESSAGE };
  const title = error.fieldErrors?.['title'];
  const attachmentId = error.fieldErrors?.['attachmentId'];
  if (title !== undefined || attachmentId !== undefined) {
    return { code: error.code, ...(title === undefined ? {} : { title }), ...(attachmentId === undefined ? {} : { attachmentId }) };
  }
  return { code: error.code, message: error.message };
}

/** Uploads a policy file through the staff attachment uploader; `ready[0]?.id` is the `attachmentId`. */
export function usePolicyFileUpload() {
  return useAttachmentUploads({ audience: 'staff' });
}

export function useCreatePolicyDocument() {
  const queryClient = useQueryClient();
  const mutation = useCreatePolicyDocumentMutation({ mutation: { onSuccess: () => void queryClient.invalidateQueries({ queryKey: policyKeys.all }) } });
  return {
    ...mutation,
    error: mutation.error ? mapPolicyError(mutation.error) : undefined,
    mutateAsync: (data: PolicyDocumentInput) => mutation.mutateAsync({ data }),
  };
}

export function useRenamePolicyDocument() {
  const queryClient = useQueryClient();
  const mutation = useRenamePolicyDocumentMutation({
    mutation: {
      onSuccess: (document) => {
        queryClient.setQueryData<PolicyDocumentDetail>(policyKeys.detail(document.id), (detail) => (detail === undefined ? detail : { ...detail, ...document }));
        void queryClient.invalidateQueries({ queryKey: policyKeys.list() });
      },
    },
  });
  return {
    ...mutation,
    error: mutation.error ? mapPolicyError(mutation.error) : undefined,
    mutateAsync: (id: string, title: string) => mutation.mutateAsync({ id, data: { title } }),
  };
}

export function useDeletePolicyDocument() {
  const queryClient = useQueryClient();
  const mutation = useDeletePolicyDocumentMutation({
    mutation: {
      onSuccess: (_result, { id }) => {
        queryClient.removeQueries({ queryKey: policyKeys.detail(id) });
        void queryClient.invalidateQueries({ queryKey: policyKeys.list() });
      },
    },
  });
  return { ...mutation, error: mutation.error ? mapError(mutation.error) : undefined, mutateAsync: (id: string) => mutation.mutateAsync({ id }) };
}

/** Adds a version (new text or file); the document goes back to processing until it is ready. */
export function useCreatePolicyVersion() {
  const queryClient = useQueryClient();
  const mutation = useCreatePolicyVersionMutation({
    mutation: {
      onSuccess: (_version, { id }) => {
        void queryClient.invalidateQueries({ queryKey: policyKeys.detail(id) });
        void queryClient.invalidateQueries({ queryKey: policyKeys.list() });
      },
    },
  });
  return {
    ...mutation,
    error: mutation.error ? mapPolicyError(mutation.error) : undefined,
    mutateAsync: (id: string, data: PolicyVersionInput) => mutation.mutateAsync({ id, data }),
  };
}

/**
 * `ai.policy_version_updated` on the `user` stream: patches the version's status in the cached
 * detail and refetches the list and detail (the document status, error and active text may have
 * changed too). Mount where the policies are shown.
 */
export function usePolicyEvents(client: RealtimeClient | undefined): void {
  useEffect(() => {
    if (!client) return undefined;
    const off = client.onEvent('ai.policy_version_updated', (envelope, queryClient) => {
      const { documentId, versionId, status } = envelope.data as { documentId: string; versionId: string; status: PolicyVersionStatus };
      queryClient.setQueryData<PolicyDocumentDetail>(policyKeys.detail(documentId), (detail) =>
        detail === undefined || detail.versions === undefined
          ? detail
          : { ...detail, versions: detail.versions.map((version) => (version.id === versionId ? { ...version, status } : version)) },
      );
      void queryClient.invalidateQueries({ queryKey: policyKeys.list() });
      void queryClient.invalidateQueries({ queryKey: policyKeys.detail(documentId) });
    });
    const offCreated = client.onEvent('ai.policy_version_created', (_envelope, queryClient) => {
      void queryClient.invalidateQueries({ queryKey: policyKeys.list() });
    });
    return () => {
      off();
      offCreated();
    };
  }, [client]);
}
