import { describe, expect, it } from 'vitest';

import { chunkPolicyText, CHUNK_OVERLAP, CHUNK_TARGET } from '../../../src/ai/knowledge/policy-chunker.js';

/** Passage splitting for policy search (specs/002-ai-assist research R4, T016). */

const sentence = (n: number) => `Sentence number ${n} explains one detail of the returns policy.`;
const paragraph = (n: number, length: number) => `P${n} ${'word '.repeat(Math.ceil(length / 5))}`.slice(0, length).trim();

describe('chunkPolicyText', () => {
  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunkPolicyText('')).toEqual([]);
    expect(chunkPolicyText('  \n\n \t\n')).toEqual([]);
    expect(chunkPolicyText('# Only a heading\n')).toEqual([]);
  });

  it('keeps a short text as one passage without a heading', () => {
    expect(chunkPolicyText('Returns are accepted for 30 days.')).toEqual([{ heading: null, content: 'Returns are accepted for 30 days.' }]);
  });

  it('splits by Markdown heading and keeps the heading on each passage', () => {
    const chunks = chunkPolicyText('Intro text.\n\n# Returns\nThirty days.\n\n## Refunds ##\nWithin 14 days.\n\n### Shipping\nFree over 50.');
    expect(chunks).toEqual([
      { heading: null, content: 'Intro text.' },
      { heading: 'Returns', content: 'Thirty days.' },
      { heading: 'Refunds', content: 'Within 14 days.' },
      { heading: 'Shipping', content: 'Free over 50.' },
    ]);
  });

  it('normalises CRLF line endings', () => {
    const chunks = chunkPolicyText('# Returns\r\nThirty days.\r\n\r\nSecond paragraph.');
    expect(chunks).toEqual([{ heading: 'Returns', content: 'Thirty days.\n\nSecond paragraph.' }]);
  });

  it('packs paragraphs up to the target size, then starts a new passage', () => {
    const paragraphs = [1, 2, 3, 4].map((n) => paragraph(n, 1500));
    const chunks = chunkPolicyText(paragraphs.join('\n\n'));
    expect(chunks.length).toBeGreaterThan(1);
    // Two 1 500 character paragraphs fit in 3 200; a third does not.
    expect(chunks[0]!.content).toBe(`${paragraphs[0]}\n\n${paragraphs[1]}`);
    expect(chunks[0]!.content.length).toBeLessThanOrEqual(CHUNK_TARGET);
  });

  it('starts a continuing passage with the last ~400 characters of the previous one', () => {
    const paragraphs = [1, 2, 3, 4].map((n) => paragraph(n, 1500));
    const [first, second] = chunkPolicyText(paragraphs.join('\n\n'));
    const carried = second!.content.split('\n\n')[0]!;
    expect(carried.length).toBeLessThanOrEqual(CHUNK_OVERLAP);
    expect(carried.length).toBeGreaterThan(CHUNK_OVERLAP - 20);
    expect(first!.content.endsWith(carried)).toBe(true);
    expect(second!.content).toContain(paragraphs[2]);
  });

  it('does not carry overlap across a heading', () => {
    const text = `# One\n${[1, 2, 3].map((n) => paragraph(n, 1500)).join('\n\n')}\n\n# Two\nFresh start.`;
    const chunks = chunkPolicyText(text);
    const last = chunks[chunks.length - 1]!;
    expect(last).toEqual({ heading: 'Two', content: 'Fresh start.' });
  });

  it('cuts a paragraph longer than the target at sentence ends', () => {
    const long = Array.from({ length: 200 }, (_, i) => sentence(i)).join(' ');
    const chunks = chunkPolicyText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // The target plus the carried overlap and the separator.
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_TARGET + CHUNK_OVERLAP + 2);
    }
    expect(chunks[0]!.content.endsWith('.')).toBe(true);
  });

  it('cuts text without any whitespace at the limit instead of looping', () => {
    const chunks = chunkPolicyText('x'.repeat(CHUNK_TARGET * 2 + 10));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]!.content).toHaveLength(CHUNK_TARGET);
  });

  it('treats # lines inside code fences as text, not headings', () => {
    const text = '# Setup\nRun this:\n\n```sh\n# not a heading\necho hi\n```\n\n~~~\n# also text\n~~~\n\n# Next\nDone.';
    const chunks = chunkPolicyText(text);
    expect(chunks.map((chunk) => chunk.heading)).toEqual(['Setup', 'Next']);
    expect(chunks[0]!.content).toContain('# not a heading');
    expect(chunks[0]!.content).toContain('# also text');
  });

  it('does not treat a hash without a following space, or indented code, as a heading', () => {
    const chunks = chunkPolicyText('#hashtag is text\n\n    # indented code');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBeNull();
  });

  it('truncates very long headings to 200 characters', () => {
    const [chunk] = chunkPolicyText(`# ${'H'.repeat(300)}\nBody.`);
    expect(chunk!.heading).toHaveLength(200);
  });
});
