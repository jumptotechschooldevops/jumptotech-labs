/**
 * Lab prose, rendered safely.
 *
 * Lab YAML uses Markdown-style backticks for commands and paths
 * (`ls -R ~/project`). Showing the backticks literally made a beginner guess
 * which characters to type. This renders only that one construct, and renders
 * it as React text nodes — there is no HTML parsing and no
 * `dangerouslySetInnerHTML`, so lab content can never inject markup.
 */
import { Fragment } from 'react';

export function InlineText({ text }: { text: string }) {
  const parts = text.split('`');
  // An unbalanced backtick leaves an even number of parts; render that last
  // stray tick literally rather than swallowing the rest of the sentence.
  const balanced = parts.length % 2 === 1;
  return (
    <>
      {parts.map((part, index) => {
        const isCode = index % 2 === 1 && (balanced || index < parts.length - 1);
        if (isCode) return <code key={index}>{part}</code>;
        const prefix = !balanced && index === parts.length - 1 && index > 0 ? '`' : '';
        return <Fragment key={index}>{prefix + part}</Fragment>;
      })}
    </>
  );
}

/** Split a YAML block scalar into paragraphs on blank lines. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function Paragraphs({ text, className }: { text: string; className?: string }) {
  return (
    <>
      {paragraphs(text).map((paragraph, index) => (
        <p key={index} className={className}>
          <InlineText text={paragraph} />
        </p>
      ))}
    </>
  );
}
