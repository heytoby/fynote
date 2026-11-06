import { sanitizeNoteHtml } from './note-html';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char] || char));

function inlineMarkdown(value: string) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g, '<img src="$2" alt="$1">');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return html;
}

export function markdownToHtml(source = '') {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let inCode = false;
  let code: string[] = [];
  const closeList = () => { if (list) output.push(`</${list}>`); list = null; };

  for (const line of lines) {
    if (/^```/.test(line)) {
      closeList();
      if (inCode) { output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = []; }
      inCode = !inCode;
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { closeList(); const level = heading[1].length; output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { closeList(); output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`); continue; }
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (task) { if (list !== 'ul') { closeList(); list = 'ul'; output.push('<ul class="markdown-task-list">'); } output.push(`<li class="markdown-task${task[1] !== ' ' ? ' done' : ''}">${inlineMarkdown(task[2])}</li>`); continue; }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) { if (list !== 'ul') { closeList(); list = 'ul'; output.push('<ul>'); } output.push(`<li>${inlineMarkdown(unordered[1])}</li>`); continue; }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) { if (list !== 'ol') { closeList(); list = 'ol'; output.push('<ol>'); } output.push(`<li>${inlineMarkdown(ordered[1])}</li>`); continue; }
    closeList();
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) output.push('<hr>');
    else if (!line.trim()) output.push('<br>');
    else output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  if (inCode) output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return sanitizeNoteHtml(output.join(''));
}

export function htmlToMarkdown(html = '') {
  const document = new DOMParser().parseFromString(`<body>${sanitizeNoteHtml(html)}</body>`, 'text/html');
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node as HTMLElement;
    const content = Array.from(element.childNodes).map(walk).join('');
    switch (element.tagName.toLowerCase()) {
      case 'h1': return `# ${content}\n\n`; case 'h2': return `## ${content}\n\n`; case 'h3': return `### ${content}\n\n`;
      case 'h4': return `#### ${content}\n\n`; case 'h5': return `##### ${content}\n\n`; case 'h6': return `###### ${content}\n\n`;
      case 'strong': case 'b': return `**${content}**`; case 'em': case 'i': return `*${content}*`; case 's': case 'del': return `~~${content}~~`;
      case 'code': return element.parentElement?.tagName.toLowerCase() === 'pre' ? content : `\`${content}\``;
      case 'pre': return `\`\`\`\n${content}\n\`\`\`\n\n`;
      case 'a': return `[${content || element.getAttribute('href') || ''}](${element.getAttribute('href') || ''})`;
      case 'img': return `![${element.getAttribute('alt') || ''}](${element.getAttribute('src') || ''})`;
      case 'blockquote': return content.split('\n').filter(Boolean).map(line => `> ${line}`).join('\n') + '\n\n';
      case 'li': return `- ${content.trim()}\n`; case 'br': return '\n'; case 'hr': return '\n---\n';
      case 'p': case 'div': return `${content.trim()}\n\n`; default: return content;
    }
  };
  return Array.from(document.body.childNodes).map(walk).join('').replace(/\n{3,}/g, '\n\n').trim();
}
