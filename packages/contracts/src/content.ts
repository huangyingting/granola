import { z } from 'zod';

const nodeTypes = [
  'doc',
  'text',
  'hardBreak',
  'horizontalRule',
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
] as const;
export type RichTextNodeType = (typeof nodeTypes)[number];
export interface RichTextNode {
  type: Exclude<RichTextNodeType, 'doc'>;
  text?: string;
  content?: RichTextNode[];
  marks?: { type: 'bold' | 'italic' | 'strike' | 'code' | 'underline' }[];
  attrs?: {
    level?: number;
    start?: number;
    language?: string | null;
    type?: 'a' | 'A' | 'i' | 'I' | null;
  };
}
export interface RichTextDocument {
  type: 'doc';
  content: RichTextNode[];
}
const plainText = z
  .string()
  .max(40_000)
  .refine((text) => !text.includes('\0'));
export const notesTextSchema = plainText;
const atomSchema = z.strictObject({
  type: z.enum(nodeTypes),
  text: plainText.min(1).optional(),
  content: z.array(z.unknown()).max(5000).optional(),
  marks: z
    .array(
      z.strictObject({
        type: z.enum(['bold', 'italic', 'strike', 'code', 'underline']),
      }),
    )
    .max(5)
    .optional(),
  attrs: z
    .strictObject({
      level: z.number().int().min(1).max(6).optional(),
      start: z.number().int().min(1).max(100_000).optional(),
      language: z
        .string()
        .regex(/^[a-zA-Z0-9_+-]{0,40}$/)
        .nullable()
        .optional(),
      type: z.enum(['a', 'A', 'i', 'I']).nullable().optional(),
    })
    .optional(),
});
const inline = new Set(['text', 'hardBreak']);
const blocks = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'codeBlock',
  'horizontalRule',
]);

function isRichText(value: unknown): value is RichTextDocument {
  const pending: {
    value: unknown;
    depth: number;
    parent: RichTextNodeType | null;
    index: number;
  }[] = [{ value, depth: 0, parent: null, index: 0 }];
  let count = 0;
  let characters = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (++count > 5000 || current.depth > 16) return false;
    const parsed = atomSchema.safeParse(current.value);
    if (!parsed.success) return false;
    const node = parsed.data;
    if ((current.parent === null) !== (node.type === 'doc')) return false;
    if (
      ((current.parent === 'doc' || current.parent === 'blockquote') &&
        !blocks.has(node.type)) ||
      ((current.parent === 'paragraph' || current.parent === 'heading') &&
        !inline.has(node.type)) ||
      ((current.parent === 'bulletList' || current.parent === 'orderedList') &&
        node.type !== 'listItem') ||
      (current.parent === 'listItem' &&
        (current.index === 0
          ? node.type !== 'paragraph'
          : !blocks.has(node.type))) ||
      (current.parent === 'codeBlock' &&
        (node.type !== 'text' || node.marks !== undefined))
    )
      return false;
    const leaf = ['text', 'hardBreak', 'horizontalRule'].includes(node.type);
    if (leaf ? node.content !== undefined : !node.content) return false;
    if ((node.type === 'text') !== (node.text !== undefined)) return false;
    if (
      node.marks &&
      (node.type !== 'text' ||
        new Set(node.marks.map((mark) => mark.type)).size !== node.marks.length)
    )
      return false;
    const attrs = Object.keys(node.attrs ?? {});
    if (node.type === 'heading') {
      if (
        node.attrs?.level === undefined ||
        attrs.some((key) => key !== 'level')
      )
        return false;
    } else if (node.type === 'orderedList') {
      if (attrs.some((key) => key !== 'start' && key !== 'type')) return false;
    } else if (node.type === 'codeBlock') {
      if (attrs.some((key) => key !== 'language')) return false;
    } else if (attrs.length > 0) return false;
    if (
      ['listItem', 'bulletList', 'orderedList', 'blockquote'].includes(
        node.type,
      ) &&
      !node.content?.length
    )
      return false;
    characters += node.text?.length ?? 0;
    if (characters > 40_000) return false;
    node.content?.forEach((child, index) =>
      pending.push({
        value: child,
        depth: current.depth + 1,
        parent: node.type,
        index,
      }),
    );
  }
  return richTextToPlainText(value as RichTextDocument).length <= 40_000;
}

export const richTextSchema = z.custom<RichTextDocument>(
  isRichText,
  'Notes must use the supported rich-text structure, at most 5,000 nodes, 16 levels and 40,000 characters.',
);
export const tagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
  )
  .max(16)
  .refine(
    (tags) =>
      new Set(tags.map((tag) => tag.toLowerCase())).size === tags.length,
    'Tags must be unique.',
  );

export function richTextFromPlainText(text: string): RichTextDocument {
  return {
    type: 'doc',
    content: text
      .replace(/\r\n/g, '\n')
      .split('\n\n')
      .map((paragraph) => ({
        type: 'paragraph',
        content: paragraph
          .split('\n')
          .flatMap((line, index): RichTextNode[] => [
            ...(index ? [{ type: 'hardBreak' as const }] : []),
            ...(line ? [{ type: 'text' as const, text: line }] : []),
          ]),
      })),
  };
}
export function richTextToPlainText(document: RichTextDocument): string {
  function render(node: RichTextNode): string {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    const separator = ['paragraph', 'heading', 'codeBlock'].includes(node.type)
      ? ''
      : node.type === 'blockquote'
        ? '\n\n'
        : '\n';
    return (node.content ?? []).map(render).join(separator);
  }
  return document.content.map(render).join('\n\n');
}
function escapeMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
export function richTextToMarkdown(document: RichTextDocument): string {
  function render(node: RichTextNode): string {
    if (node.type === 'text') {
      let text = escapeMarkdown(node.text ?? '');
      for (const mark of node.marks ?? []) {
        if (mark.type === 'code') {
          const raw = node.text ?? '';
          const fence = '`'.repeat(
            Math.max(0, ...(raw.match(/`+/g) ?? []).map((run) => run.length)) +
              1,
          );
          text = `${fence} ${raw} ${fence}`;
        } else if (mark.type === 'bold') text = `**${text}**`;
        else if (mark.type === 'italic') text = `_${text}_`;
        else if (mark.type === 'strike') text = `~~${text}~~`;
      }
      return text;
    }
    if (node.type === 'hardBreak') return '  \n';
    if (node.type === 'horizontalRule') return '---';
    if (node.type === 'codeBlock') {
      const text = (node.content ?? [])
        .map((child) => child.text ?? '')
        .join('');
      const fence = '`'.repeat(
        Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1,
      );
      return `${fence}${node.attrs?.language ?? ''}\n${text}\n${fence}`;
    }
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      return (node.content ?? [])
        .map((child, index) => {
          const prefix =
            node.type === 'bulletList'
              ? '- '
              : `${(node.attrs?.start ?? 1) + index}. `;
          return (
            prefix +
            render(child).replace(/\n/g, `\n${' '.repeat(prefix.length)}`)
          );
        })
        .join('\n');
    }
    const text = (node.content ?? [])
      .map(render)
      .join(['paragraph', 'heading'].includes(node.type) ? '' : '\n\n');
    if (node.type === 'heading')
      return `${'#'.repeat(node.attrs?.level ?? 1)} ${text}`;
    if (node.type === 'blockquote')
      return text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    return text;
  }
  return document.content.map(render).join('\n\n');
}

export interface MeetingExport {
  title: string;
  notes: string;
  content?: RichTextDocument | null;
  tags: string[];
  segments?: { start_ms: number; text: string }[];
}
export function exportMeeting(
  meeting: MeetingExport,
  format: 'markdown' | 'text',
  timestamps = true,
): string {
  const markdown = format === 'markdown';
  const heading = (text: string, level = 2) =>
    markdown ? `${'#'.repeat(level)} ${escapeMarkdown(text)}` : text;
  const notes = meeting.content
    ? markdown
      ? richTextToMarkdown(meeting.content)
      : richTextToPlainText(meeting.content)
    : markdown
      ? escapeMarkdown(meeting.notes)
      : meeting.notes;
  const sections = [heading(meeting.title, 1)];
  if (meeting.tags.length)
    sections.push(
      `Tags: ${meeting.tags.map((tag) => (markdown ? escapeMarkdown(tag) : tag)).join(', ')}`,
    );
  sections.push(heading('Notes'), notes);
  if (meeting.segments?.length) {
    sections.push(
      heading('Transcript'),
      meeting.segments
        .map((segment) => {
          const seconds = Math.floor(segment.start_ms / 1000);
          const clock = `${Math.floor(seconds / 3600)
            .toString()
            .padStart(2, '0')}:${Math.floor((seconds / 60) % 60)
            .toString()
            .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
          const text = markdown ? escapeMarkdown(segment.text) : segment.text;
          return `${timestamps ? `[${clock}] ` : ''}${text}`;
        })
        .join('\n\n'),
    );
  }
  return sections.join('\n\n').trimEnd() + '\n';
}
