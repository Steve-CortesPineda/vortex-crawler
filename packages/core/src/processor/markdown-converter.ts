import TurndownService from 'turndown';

export class MarkdownConverter {
  private turndown: TurndownService;

  constructor() {
    this.turndown = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
    });

    this.setupRules();
  }

  private setupRules(): void {
    // Remove empty links
    this.turndown.addRule('emptyLinks', {
      filter: (node: any) => {
        return node.nodeName === 'A' && !node.textContent?.trim();
      },
      replacement: () => '',
    });

    // Clean up images — keep only if they have meaningful alt text or src
    this.turndown.addRule('images', {
      filter: 'img',
      replacement: (_content: string, node: any) => {
        const alt = node.getAttribute?.('alt') || '';
        const src = node.getAttribute?.('src') || '';
        const width = parseInt(node.getAttribute?.('width') || '100', 10);
        const height = parseInt(node.getAttribute?.('height') || '100', 10);
        if (width <= 1 || height <= 1) return '';
        if (!src || src.startsWith('data:image/gif')) return '';
        return alt ? `![${alt}](${src})` : '';
      },
    });

    // Code blocks — preserve language hints
    this.turndown.addRule('codeBlocks', {
      filter: (node: any) => {
        return node.nodeName === 'PRE' && !!node.querySelector?.('code');
      },
      replacement: (_content: string, node: any) => {
        const code = node.querySelector?.('code');
        if (!code) return '';
        const className = code.getAttribute?.('class') || '';
        const langMatch = className.match(/(?:language|lang)-(\w+)/);
        const lang = langMatch ? langMatch[1] : '';
        const text = code.textContent || '';
        return `\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
      },
    });
  }

  convert(html: string): string {
    let markdown = this.turndown.turndown(html);

    // Post-processing cleanup
    markdown = markdown
      // Collapse 3+ newlines to 2
      .replace(/\n{3,}/g, '\n\n')
      // Remove trailing whitespace on lines
      .replace(/[ \t]+$/gm, '')
      // Remove leading/trailing whitespace
      .trim();

    return markdown;
  }
}
