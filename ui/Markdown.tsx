import MarkdownIt from 'markdown-it';

const renderer = new MarkdownIt({ html: false, linkify: true, breaks: false });
const defaultLink = renderer.renderer.rules.link_open;
renderer.renderer.rules.link_open = (tokens, index, options, environment, self) => {
  if (/^(?:https?:)?\/\//i.test(tokens[index].attrGet('href') ?? '')) {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLink ? defaultLink(tokens, index, options, environment, self) : self.renderToken(tokens, index, options);
};

export function markdownFileTarget(href: string, sourcePath = ''): string | undefined {
  if (!href || href.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return undefined;
  try {
    const base = `https://ensemble.invalid/${sourcePath}`;
    const target = decodeURIComponent(new URL(href, base).pathname.slice(1));
    if (!target || target.split('/').includes('..')) return undefined;
    return target;
  } catch { return undefined; }
}

/** Raw HTML is escaped and markdown-it rejects unsafe URL protocols. */
export function Markdown({ content, sourcePath, onFile }: { content: string; sourcePath?: string; onFile?: (path: string) => void }) {
  return <div className="markdown" onClick={event => {
    if (!onFile || !(event.target instanceof Element)) return;
    const anchor = event.target.closest('a');
    if (!anchor) return;
    const target = markdownFileTarget(anchor.getAttribute('href') ?? '', sourcePath);
    if (target) { event.preventDefault(); onFile(target); }
  }} dangerouslySetInnerHTML={{ __html: renderer.render(content) }} />;
}
export default Markdown;
