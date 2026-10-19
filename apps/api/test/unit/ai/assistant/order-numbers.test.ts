import { describe, expect, it } from 'vitest';

import { orderNumbersIn } from '../../../../src/ai/assistant/assistant-brain.js';

describe('orderNumbersIn', () => {
  it('finds a bare order number', () => {
    expect(orderNumbersIn('R742300281')).toEqual(['R742300281']);
  });

  it('finds numbers inside a sentence, upper-cased and without punctuation', () => {
    expect(orderNumbersIn('Where is #r718671947? Also order 100200.')).toEqual(['R718671947', '100200']);
  });

  it('ignores words and short numbers', () => {
    expect(orderNumbersIn('hello, I ordered 2 tags on Sep 10')).toEqual([]);
  });

  it('looks up at most two distinct numbers', () => {
    expect(orderNumbersIn('R1234567 r1234567 R2345678 R3456789')).toEqual(['R1234567', 'R2345678']);
  });
});
