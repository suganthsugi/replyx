import { useCallback, useEffect, useRef, useState } from 'react';

import { getUploadCustomerAttachmentUrl } from '../api/generated/customer/customer';

import { mapError } from './errors';
import { CSRF_COOKIE, CSRF_HEADER, HttpError, readCookie, resolveUrl, type ApiErrorBody } from './http';

import type { AttachmentSummary } from '../api/generated/model';
import type { ComposerAttachment } from '../components/chat/types';

/**
 * Customer attachment uploads (`POST /customer/attachments`) with progress for the composer.
 * This is the one request that doesn't go through the `http` mutator: `fetch` can't report
 * upload progress, so it uses XMLHttpRequest with the same contract (same-origin path under
 * `/api/v1`, cookies, the CSRF header, and an `HttpError` carrying the error envelope, so
 * `mapError` treats 413 `ATTACHMENT_TOO_LARGE` and 415 `ATTACHMENT_TYPE_NOT_ALLOWED` like any
 * other API error).
 */

export function uploadCustomerAttachmentWithProgress(
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<AttachmentSummary> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', resolveUrl(getUploadCustomerAttachmentUrl()));
    request.withCredentials = true;
    request.setRequestHeader('Accept', 'application/json');
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf !== undefined) request.setRequestHeader(CSRF_HEADER, csrf);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      let body: unknown;
      try {
        body = request.responseText === '' ? undefined : JSON.parse(request.responseText);
      } catch {
        body = undefined;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve(body as AttachmentSummary);
        return;
      }
      const error = (body as { error?: ApiErrorBody } | undefined)?.error;
      reject(
        new HttpError(
          request.status,
          error !== undefined && typeof error.code === 'string'
            ? error
            : { code: request.status >= 500 ? 'INTERNAL' : 'HTTP_ERROR', message: 'Something went wrong' },
        ),
      );
    };
    // Not an API answer at all (offline, connection dropped): `mapError` makes it NETWORK_ERROR.
    request.onerror = () => reject(new TypeError('Network request failed'));
    request.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => request.abort());

    const form = new FormData();
    form.append('file', file);
    request.send(form);
  });
}

interface Upload extends ComposerAttachment {
  summary?: AttachmentSummary;
  controller: AbortController;
}

/**
 * The composer's pending attachments: `add` starts uploading each file, `remove` cancels or
 * drops one, `ready` lists what can go with the next message, `clearReady` takes those out of the
 * tray after a send.
 */
export function useAttachmentUploads() {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const live = useRef(uploads);
  live.current = uploads;

  const update = useCallback((localId: string, patch: Partial<Upload>) => {
    setUploads((current) => current.map((upload) => (upload.localId === localId ? { ...upload, ...patch } : upload)));
  }, []);

  const add = useCallback(
    (files: File[]) => {
      const started = files.map<Upload>((file) => ({
        localId: crypto.randomUUID(),
        fileName: file.name,
        status: 'uploading',
        progress: 0,
        controller: new AbortController(),
      }));
      setUploads((current) => [...current, ...started]);
      started.forEach((upload, index) => {
        const file = files[index] as File;
        uploadCustomerAttachmentWithProgress(file, (progress) => update(upload.localId, { progress }), upload.controller.signal)
          .then((summary) => update(upload.localId, { status: 'ready', progress: 100, summary }))
          .catch((error: unknown) => {
            if (upload.controller.signal.aborted) return;
            update(upload.localId, { status: 'failed', error: mapError(error).message });
          });
      });
    },
    [update],
  );

  const remove = useCallback((localId: string) => {
    live.current.find((upload) => upload.localId === localId)?.controller.abort();
    setUploads((current) => current.filter((upload) => upload.localId !== localId));
  }, []);

  // What went with the message leaves the tray; failed and still-uploading files stay visible.
  const clearReady = useCallback(() => setUploads((current) => current.filter((upload) => upload.status !== 'ready')), []);

  // Leaving the page cancels whatever is still uploading.
  useEffect(() => () => live.current.forEach((upload) => upload.controller.abort()), []);

  return {
    attachments: uploads.map<ComposerAttachment>(({ localId, fileName, status, progress, error }) => ({
      localId,
      fileName,
      status,
      progress,
      ...(error === undefined ? {} : { error }),
    })),
    ready: uploads.flatMap((upload) => (upload.status === 'ready' && upload.summary !== undefined ? [upload.summary] : [])),
    add,
    remove,
    clearReady,
  };
}
