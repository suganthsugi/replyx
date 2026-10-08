/**
 * Splits a policy text into passages for retrieval (specs/002-ai-assist research R4): by Markdown
 * heading first, then by paragraph, packing paragraphs up to about 3 200 characters. A passage
 * that continues the same section starts with the last 400 characters of the one before it, so a
 * sentence on the boundary is found from either side. Each passage keeps the heading it sits under.
 */

export const CHUNK_TARGET = 3200;
export const CHUNK_OVERLAP = 400;
/** A text that splits into more passages than this is refused (`too_large`). */
export const MAX_CHUNKS = 500;

export interface PolicyChunk {
  heading: string | null;
  content: string;
}

interface Section {
  heading: string | null;
  lines: string[];
}

const HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;
const MAX_HEADING = 200;

/** Lines grouped under their nearest heading; `#` lines inside code fences are text. */
function sections(text: string): Section[] {
  const result: Section[] = [{ heading: null, lines: [] }];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line)?.[1];
    if (heading === null || heading === undefined) {
      result[result.length - 1]!.lines.push(line);
    } else {
      result.push({ heading: heading.trim().slice(0, MAX_HEADING), lines: [] });
    }
  }
  return result;
}

/** Cuts text longer than the target at the last sentence end, else whitespace, else the limit. */
function splitLong(paragraph: string): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > CHUNK_TARGET) {
    const window = rest.slice(0, CHUNK_TARGET);
    const floor = Math.floor(CHUNK_TARGET * 0.6);
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('\n'));
    const space = window.search(/\s\S*$/);
    const cut = sentence >= floor ? sentence + 1 : space >= floor ? space : CHUNK_TARGET;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/** The last `CHUNK_OVERLAP` characters of a passage, starting at a word boundary. */
function tail(text: string): string {
  if (text.length <= CHUNK_OVERLAP) return text;
  const slice = text.slice(-CHUNK_OVERLAP);
  const boundary = slice.search(/\s/);
  return (boundary < 0 ? slice : slice.slice(boundary)).trim();
}

function chunkSection(section: Section): PolicyChunk[] {
  const body = section.lines.join('\n').trim();
  // A heading with nothing under it is still worth finding by its words.
  if (body.length === 0) return section.heading === null ? [] : [{ heading: section.heading, content: section.heading }];
  const pieces = body
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .flatMap((paragraph) => (paragraph.length > CHUNK_TARGET ? splitLong(paragraph) : [paragraph]));

  const chunks: PolicyChunk[] = [];
  let current = '';
  let carry = '';
  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ heading: section.heading, content: carry.length === 0 ? current : `${carry}\n\n${current}` });
    carry = tail(current);
    current = '';
  };
  for (const piece of pieces) {
    if (current.length > 0 && current.length + 2 + piece.length > CHUNK_TARGET) flush();
    current = current.length === 0 ? piece : `${current}\n\n${piece}`;
  }
  flush();
  return chunks;
}

/** Passages in document order; empty when the text has no words. */
export function chunkPolicyText(text: string): PolicyChunk[] {
  return sections(text.replace(/\r\n?/g, '\n')).flatMap(chunkSection);
}
