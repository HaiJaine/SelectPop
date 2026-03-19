import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeMathjax from 'rehype-mathjax/svg';
import rehypeStringify from 'rehype-stringify';

const MATH_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'aligned',
  'aligned*',
  'alignat',
  'alignat*',
  'gather',
  'gather*',
  'gathered',
  'multline',
  'multline*',
  'split',
  'cases',
  'dcases',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix'
]);

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkMath, {
    singleDollarTextMath: true
  })
  .use(remarkRehype, {
    allowDangerousHtml: true
  })
  .use(rehypeRaw)
  .use(rehypeMathjax, {
    tex: {
      inlineMath: [
        ['$', '$'],
        ['\\(', '\\)']
      ],
      displayMath: [
        ['$$', '$$'],
        ['\\[', '\\]']
      ],
      processEscapes: true,
      processEnvironments: true,
      packages: {
        '[+]': ['ams', 'noerrors', 'noundefined']
      }
    }
  })
  .use(rehypeStringify, {
    allowDangerousHtml: true
  });

function createPlaceholder(index) {
  return `@@SELECTPOP_SEGMENT_${index}@@`;
}

function protectSegments(markdown) {
  const segments = [];
  let text = String(markdown || '');

  text = text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (match) => {
    const token = createPlaceholder(segments.length);
    segments.push(match);
    return token;
  });

  text = text.replace(/(`+)([\s\S]*?)\1/g, (match) => {
    const token = createPlaceholder(segments.length);
    segments.push(match);
    return token;
  });

  return { text, segments };
}

function restoreSegments(text, segments) {
  return segments.reduce(
    (output, segment, index) => output.split(createPlaceholder(index)).join(segment),
    text
  );
}

function isWrappedByDisplayMath(input, startIndex, endIndex) {
  const before = input.slice(0, startIndex);
  const after = input.slice(endIndex);
  return /\$\$\s*$/.test(before) && /^\s*\$\$/.test(after);
}

function normalizeMathDelimiters(markdown) {
  const { text: protectedText, segments } = protectSegments(markdown);

  let normalized = protectedText.replace(/\\\[((?:[\s\S]*?))\\\]/g, (_match, content) => {
    const body = String(content || '').trim();
    return body ? `\n\n$$\n${body}\n$$\n\n` : _match;
  });

  normalized = normalized.replace(/\\\(((?:[\s\S]*?))\\\)/g, (_match, content) => {
    const body = String(content || '').trim();
    return body ? `$${body}$` : _match;
  });

  normalized = normalized.replace(
    /\\begin\{([a-zA-Z*]+)\}([\s\S]*?)\\end\{\1\}/g,
    (match, envName, body, offset, source) => {
      const environment = String(envName || '').trim();

      if (!MATH_ENVIRONMENTS.has(environment)) {
        return match;
      }

      if (isWrappedByDisplayMath(source, offset, offset + match.length)) {
        return match;
      }

      const block = `\\begin{${environment}}${String(body || '')}\\end{${environment}}`;
      return `\n\n$$\n${block}\n$$\n\n`;
    }
  );

  return restoreSegments(normalized, segments);
}

export async function renderMarkdownToHtml(markdown) {
  return String(await markdownProcessor.process(normalizeMathDelimiters(markdown)));
}
