"use client";

/**
 * Rendered markdown preview — Apple Notes-style, minimal chrome.
 * Kept separate so the editor bundle stays lean.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMemo } from "react";

interface Props {
  content: string;
  className?: string;
}

export default function MarkdownPreview({ content, className }: Props) {
  // Memoize — markdown render is expensive on every keystroke.
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Hairline borders + Apple tones
          h1: ({ children }) => (
            <h1 className="mb-4 mt-6 text-2xl font-semibold tracking-tight text-foreground">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-3 mt-5 text-xl font-semibold tracking-tight text-foreground">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-4 text-lg font-semibold text-foreground">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="mb-3 leading-7 text-foreground/90">{children}</p>
          ),
          code: ({ inline, className, children, ...props }: any) =>
            inline ? (
              <code
                className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground"
                {...props}
              >
                {children}
              </code>
            ) : (
              <code
                className="block overflow-auto rounded-md bg-muted/50 p-3 font-mono text-[12px] leading-6"
                {...props}
              >
                {children}
              </code>
            ),
          pre: ({ children }) => (
            <pre className="mb-3 overflow-auto rounded-md bg-muted/50">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-border/60 pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          ul: ({ children }) => (
            <ul className="mb-3 list-disc pl-5 text-foreground/90">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 list-decimal pl-5 text-foreground/90">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="mb-1 leading-7">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              className="text-primary underline-offset-2 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          hr: () => <hr className="my-6 border-t border-border/60" />,
          table: ({ children }) => (
            <div className="mb-3 overflow-auto">
              <table className="w-full border-collapse text-[13px]">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border bg-muted/30 px-3 py-1.5 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border/40 px-3 py-1.5">{children}</td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    ),
    [content]
  );

  return (
    <div className={className}>
      <article className="mx-auto max-w-3xl px-6 py-8">{rendered}</article>
    </div>
  );
}
