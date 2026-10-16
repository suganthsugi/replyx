import { getUploadAttachmentUrl } from '../api/generated/tickets/tickets';

import { uploadWithProgress } from './attachments';

import type { AttachmentSummary } from '../api/generated/model';

/**
 * Staff uploads (replies, notes, policy files). Kept apart from attachments.ts so the customer chat,
 * which imports that module, never pulls the staff API client into its bundle (T266).
 */
export function uploadAttachmentWithProgress(file: File, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<AttachmentSummary> {
  return uploadWithProgress(getUploadAttachmentUrl(), file, onProgress, signal);
}
