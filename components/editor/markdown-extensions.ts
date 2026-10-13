/**
 * Markdown editing extensions.
 *
 * Deliberately small — no custom widgets, no live preview decorations.
 * Just: syntax highlight + sensible keybindings. Live preview rendering
 * is the responsibility of a separate preview pane, not the editor.
 */

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";

export function createMarkdownExtensions(): Extension[] {
  return [
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      // Render front-matter + common GFM constructs
      addKeymap: true,
    }),
  ];
}

export function createHtmlExtensions(): Extension[] {
  return [html()];
}
