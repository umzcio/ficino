import { describe, expect, it } from 'vitest';
import { chunkEmbedText } from '../../src/ingest/embedText.js';

describe('chunkEmbedText', () => {
  it('is the content when there is no prefix', () => {
    expect(chunkEmbedText({ content: ' Body ', contextual_prefix: '' })).toBe(' Body ');
    expect(chunkEmbedText({ content: ' Body ', contextual_prefix: null })).toBe(' Body ');
    expect(chunkEmbedText({ content: ' Body ' })).toBe(' Body ');
  });

  it('joins prefix and content and strips like Python', () => {
    expect(chunkEmbedText({ content: 'Body \n', contextual_prefix: ' Ctx' })).toBe('Ctx\n\nBody');
  });
});
