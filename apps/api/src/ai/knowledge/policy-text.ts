import { extractText, getDocumentProxy } from 'unpdf';

/** Bodies longer than this are refused, like a typed text (data-model.md `ai_policy_versions.body`). */
export const MAX_POLICY_CHARS = 200_000;

export type PolicyFileKind = 'text' | 'pdf';

/** What the indexer can read, by the content type the upload was validated against. */
export function fileKindOf(contentType: string): PolicyFileKind | undefined {
  if (contentType === 'text/plain' || contentType === 'text/markdown') return 'text';
  if (contentType === 'application/pdf') return 'pdf';
  return undefined;
}

/** Postgres text cannot hold NUL, and a byte-order mark is not part of the policy. */
const NUL = String.fromCharCode(0);
const BOM = String.fromCharCode(0xfeff);

function clean(text: string): string {
  const withoutBom = text.startsWith(BOM) ? text.slice(1) : text;
  return withoutBom.replaceAll(NUL, '');
}

/**
 * The text of a stored file: `.txt` and `.md` as they are, PDF through `unpdf`. A PDF that cannot be
 * parsed (corrupt, encrypted, scanned images) yields an empty text, which the caller reports as
 * `no_extractable_text`; retrying would not change that.
 */
export async function extractPolicyText(kind: PolicyFileKind, bytes: Buffer): Promise<string> {
  if (kind === 'text') return clean(bytes.toString('utf8'));
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return clean(text);
  } catch {
    return '';
  }
}
