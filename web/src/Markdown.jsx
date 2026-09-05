import React, { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true, gfm: true });

/** Renders finished markdown text (assistant messages, run summaries) as sanitized HTML. */
export default function Markdown({ text, className = '' }) {
  const html = useMemo(() => {
    if (!text) return '';
    return DOMPurify.sanitize(marked.parse(text));
  }, [text]);

  if (!text) return null;

  return <div className={`prose ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
}
