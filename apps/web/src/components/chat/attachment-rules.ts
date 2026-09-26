/**
 * The attachment limits the API enforces (T114: 25 MB, an allow-list of images, PDF, office
 * documents, text and archives), checked in the browser first so a customer hears about a
 * wrong file at once instead of after an upload. The API still checks the real bytes.
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const ALLOWED_EXTENSIONS = [
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic',
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  // Text
  'txt', 'csv', 'log', 'md', 'json',
  // Archives
  'zip', 'gz', 'tgz', '7z',
] as const;

/** For the file input's `accept`, so the picker offers the right files first. */
export const ATTACHMENT_ACCEPT = ALLOWED_EXTENSIONS.map((extension) => `.${extension}`).join(',');

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/** A customer-facing reason the file can't be attached, or `undefined` when it can. */
export function attachmentProblem(file: Pick<File, 'name' | 'size'>): string | undefined {
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extensionOf(file.name))) {
    return `${file.name} can't be sent. Try an image, PDF, document, text file or zip archive.`;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name} is larger than 25 MB.`;
  return undefined;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
