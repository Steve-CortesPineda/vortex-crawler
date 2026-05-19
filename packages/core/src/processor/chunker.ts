import type { ContentChunk } from '../types/result.js';
import { TokenEstimator } from './token-estimator.js';

/**
 * Splits markdown into context-window-sized chunks.
 * Respects document structure: headings > paragraphs > sentences.
 */
export class Chunker {
  private estimator: TokenEstimator;

  constructor() {
    this.estimator = new TokenEstimator();
  }

  chunk(markdown: string, maxTokens: number, overlap = 0): ContentChunk[] {
    if (!markdown) return [];

    const totalTokens = this.estimator.estimate(markdown);
    if (totalTokens <= maxTokens) {
      return [{
        index: 0,
        content: markdown,
        tokens: totalTokens,
        metadata: { startOffset: 0, endOffset: markdown.length },
      }];
    }

    // Split by headings first, then paragraphs
    const sections = this.splitByHeadings(markdown);
    const chunks: ContentChunk[] = [];
    let currentContent = '';
    let currentTokens = 0;
    let startOffset = 0;

    for (const section of sections) {
      const sectionTokens = this.estimator.estimate(section);

      if (sectionTokens > maxTokens) {
        // Section too big — split by paragraphs
        if (currentContent) {
          chunks.push(this.makeChunk(chunks.length, currentContent, currentTokens, startOffset));
          startOffset += currentContent.length;
          currentContent = '';
          currentTokens = 0;
        }

        const paraChunks = this.splitByParagraphs(section, maxTokens);
        for (const pc of paraChunks) {
          chunks.push(this.makeChunk(chunks.length, pc, this.estimator.estimate(pc), startOffset));
          startOffset += pc.length;
        }
        continue;
      }

      if (currentTokens + sectionTokens > maxTokens) {
        // Flush current chunk
        chunks.push(this.makeChunk(chunks.length, currentContent, currentTokens, startOffset));
        startOffset += currentContent.length;

        // Add overlap from end of previous chunk
        if (overlap > 0 && currentContent) {
          const overlapText = this.getOverlapText(currentContent, overlap);
          currentContent = overlapText + '\n\n' + section;
          currentTokens = this.estimator.estimate(currentContent);
        } else {
          currentContent = section;
          currentTokens = sectionTokens;
        }
      } else {
        currentContent += (currentContent ? '\n\n' : '') + section;
        currentTokens += sectionTokens;
      }
    }

    if (currentContent) {
      chunks.push(this.makeChunk(chunks.length, currentContent, currentTokens, startOffset));
    }

    return chunks;
  }

  private splitByHeadings(markdown: string): string[] {
    // Split on heading lines (# ... ##, etc)
    const parts = markdown.split(/(?=^#{1,6}\s)/m);
    return parts.filter(p => p.trim().length > 0);
  }

  private splitByParagraphs(text: string, maxTokens: number): string[] {
    const paragraphs = text.split(/\n\n+/);
    const result: string[] = [];
    let current = '';
    let currentTokens = 0;

    for (const para of paragraphs) {
      const paraTokens = this.estimator.estimate(para);

      if (currentTokens + paraTokens > maxTokens && current) {
        result.push(current);
        current = para;
        currentTokens = paraTokens;
      } else {
        current += (current ? '\n\n' : '') + para;
        currentTokens += paraTokens;
      }
    }

    if (current) result.push(current);
    return result;
  }

  private getOverlapText(text: string, overlapTokens: number): string {
    const words = text.split(/\s+/);
    const approxWords = Math.ceil(overlapTokens / 1.33);
    return words.slice(-approxWords).join(' ');
  }

  private makeChunk(index: number, content: string, tokens: number, startOffset: number): ContentChunk {
    return {
      index,
      content,
      tokens,
      metadata: { startOffset, endOffset: startOffset + content.length },
    };
  }
}
