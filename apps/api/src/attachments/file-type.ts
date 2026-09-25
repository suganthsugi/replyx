import { extname } from 'node:path';

import { fileTypeFromBuffer } from 'file-type';

/**
 * The attachment type allow-list (FR-045, research D17). The type comes from the file's bytes
 * (`file-type` magic numbers), never from its name or the client's `Content-Type`; the name only
 * narrows ambiguous containers. Allowed: images, PDF, office documents, plain text and archives.
 * Refused: executables, scripts, HTML/SVG/XML, macro-enabled office files and anything unknown.
 */

const DETECTED: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  heic: 'image/heic',
  avif: 'image/avif',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  zip: 'application/zip',
  gz: 'application/gzip',
  'tar.gz': 'application/gzip',
  tar: 'application/x-tar',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  zst: 'application/zstd',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
};

/** Legacy Office files share the OLE container with installers (`.msi`): the name decides. */
const LEGACY_OFFICE: Readonly<Record<string, string>> = {
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
};

/** Undetectable by magic bytes, so accepted by name only when the bytes look like text. */
const TEXT: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

/** Browsers may show these inline; every other type downloads. */
export const INLINE_SAFE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

const TEXT_SAMPLE_BYTES = 64 * 1024;

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, TEXT_SAMPLE_BYTES);
  if (sample.includes(0)) return false;
  // A shebang makes it a script, whatever it is called.
  if (sample.subarray(0, 2).toString('latin1') === '#!') return false;
  try {
    // `stream`: a character cut in half at the end of the sample is held back, not an error.
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: sample.length === TEXT_SAMPLE_BYTES });
    return true;
  } catch {
    return false;
  }
}

/** The content type to store, or undefined when the file is not allowed. */
export async function allowedContentType(buffer: Buffer, fileName: string): Promise<string | undefined> {
  const extension = extname(fileName).toLowerCase();
  const detected = await fileTypeFromBuffer(buffer);
  if (detected === undefined) return looksLikeText(buffer) ? TEXT[extension] : undefined;
  if (detected.ext === 'cfb') return LEGACY_OFFICE[extension];
  return DETECTED[detected.ext];
}

/** A display name without paths or control characters, at most 255 characters. */
export function safeFileName(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const name = cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
  return name.length <= 255 ? name : name.slice(0, 255);
}
