import { describe, expect, it } from 'vitest';
import {
  exportMeeting,
  richTextSchema,
  richTextFromPlainText,
  richTextToPlainText,
  richTextToMarkdown,
  tagsSchema,
} from './content.js';
import { createDocumentSchema, updateNotesSchema } from './server.js';

describe('meeting content', () => {
  it('round-trips existing plain text without duplicating line breaks', () => {
    for (const text of [
      '',
      '中文 and English',
      'One\nTwo\n\nThree\n',
      '<script>not HTML</script>',
    ]) {
      const content = richTextSchema.parse(richTextFromPlainText(text));
      expect(richTextToPlainText(content)).toBe(text);
    }
  });
  it('supports bounded basic formatting and derives canonical evidence text', () => {
    const content = richTextSchema.parse({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Decision' }],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'Ship it',
                      marks: [{ type: 'bold' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const parsed = createDocumentSchema.parse({
      workspace_id: '00000000-0000-4000-8000-000000000001',
      title: 'Meeting',
      content,
    });
    expect(parsed.notes).toBe('Decision\n\nShip it');
    expect(richTextToMarkdown(content)).toBe('## Decision\n\n- **Ship it**');
    expect(
      updateNotesSchema.safeParse({
        base_revision: 1,
        content,
        notes: 'Different evidence',
      }).success,
    ).toBe(false);
    expect(updateNotesSchema.safeParse({ base_revision: 1 }).success).toBe(
      false,
    );
    expect(
      updateNotesSchema.parse({ base_revision: 1, notes: '' }).content,
    ).toBeNull();
  });
  it('rejects active content, unsupported structures and database-incompatible strings', () => {
    for (const content of [
      {
        type: 'doc',
        content: [{ type: 'image', attrs: { src: 'file:///secret' } }],
      },
      { type: 'doc', content: [{ type: 'text', text: 'Not a block' }] },
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Nul\0' }] },
        ],
      },
      {
        type: 'doc',
        content: [{ type: 'heading', attrs: { level: 99 }, content: [] }],
      },
      {
        type: 'doc',
        content: [
          { type: 'bulletList', content: [{ type: 'paragraph', content: [] }] },
        ],
      },
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Click',
                marks: [
                  { type: 'link', attrs: { href: 'javascript:alert(1)' } },
                ],
              },
            ],
          },
        ],
      },
    ])
      expect(richTextSchema.safeParse(content).success).toBe(false);
    expect(
      updateNotesSchema.safeParse({ base_revision: 1, notes: 'Nul\0' }).success,
    ).toBe(false);
  });
  it('rejects deeply nested content without recursive parser exhaustion', () => {
    let nested: unknown = { type: 'paragraph', content: [] };
    for (let depth = 0; depth < 2000; depth++)
      nested = { type: 'blockquote', content: [nested] };
    expect(
      richTextSchema.safeParse({ type: 'doc', content: [nested] }).success,
    ).toBe(false);
    expect(
      richTextSchema.safeParse(richTextFromPlainText('x'.repeat(40_001)))
        .success,
    ).toBe(false);
    expect(
      richTextSchema.safeParse({
        type: 'doc',
        content: Array.from({ length: 5001 }, () => ({
          type: 'paragraph',
          content: [],
        })),
      }).success,
    ).toBe(false);
  });
  it('normalizes tags and rejects duplicate or control-character values', () => {
    expect(tagsSchema.parse([' Planning ', '中文'])).toEqual([
      'Planning',
      '中文',
    ]);
    expect(tagsSchema.safeParse(['Planning', 'planning']).success).toBe(false);
    expect(tagsSchema.safeParse(['hidden\nvalue']).success).toBe(false);
  });
  it('exports plain text and safe Markdown with optional transcript clocks', () => {
    const meeting = {
      title: '<Meeting>',
      notes: 'One *item*',
      content: null,
      tags: ['Planning'],
      segments: [{ start_ms: 3_661_500, text: 'A <b>tag</b> &lt; literal.' }],
    };
    expect(exportMeeting(meeting, 'text')).toContain(
      '[01:01:01] A <b>tag</b> &lt; literal.',
    );
    const markdown = exportMeeting(meeting, 'markdown');
    expect(markdown).toContain('# &lt;Meeting&gt;');
    expect(markdown).toContain('One \\*item\\*');
    expect(markdown).toContain('&lt;b&gt;tag&lt;/b&gt; &amp;lt; literal');
    expect(exportMeeting(meeting, 'text', false)).not.toContain('[01:01:01]');
    expect(
      richTextToMarkdown(
        richTextSchema.parse({
          type: 'doc',
          content: [
            {
              type: 'codeBlock',
              attrs: { language: null },
              content: [{ type: 'text', text: '```\nnot an escaped fence' }],
            },
          ],
        }),
      ),
    ).toBe('````\n```\nnot an escaped fence\n````');
  });
});
