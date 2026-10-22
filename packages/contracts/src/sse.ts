export interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}
export class SseDecodeError extends Error {
  constructor(
    readonly code: 'incomplete' | 'too_large' | 'invalid_id',
    message: string,
  ) {
    super(message);
  }
}

export class SseDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = '';
  private lines: string[] = [];
  private size = 0;
  private id: string | null = null;
  private event: string | null = null;
  constructor(private readonly maximum = 65_536) {}

  push(bytes: Uint8Array, final = false): SseFrame[] {
    this.pending += this.decoder.decode(bytes, { stream: !final });
    const frames: SseFrame[] = [];
    while (this.pending.length) {
      const position = this.pending.search(/[\r\n]/u);
      if (
        position < 0 ||
        (!final &&
          position === this.pending.length - 1 &&
          this.pending[position] === '\r')
      )
        break;
      const line = this.pending.slice(0, position);
      const length =
        this.pending.slice(position, position + 2) === '\r\n' ? 2 : 1;
      this.pending = this.pending.slice(position + length);
      this.size += new TextEncoder().encode(line).length + length;
      if (this.size > this.maximum)
        throw new SseDecodeError(
          'too_large',
          'The event exceeds its byte budget.',
        );
      if (!line) {
        if (this.lines.length)
          frames.push({
            id: this.id,
            event: this.event,
            data: this.lines.join('\n'),
          });
        this.lines = [];
        this.id = this.event = null;
        this.size = 0;
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') this.lines.push(value);
        if (field === 'event') this.event = value;
        if (field === 'id') {
          if (value.includes('\0'))
            throw new SseDecodeError('invalid_id', 'Invalid event identifier.');
          this.id = value;
        }
      }
    }
    if (
      this.size + new TextEncoder().encode(this.pending).length >
      this.maximum
    )
      throw new SseDecodeError(
        'too_large',
        'The event exceeds its byte budget.',
      );
    if (
      final &&
      (this.pending.trim() ||
        this.lines.length ||
        this.id !== null ||
        this.event !== null)
    )
      throw new SseDecodeError(
        'incomplete',
        'The event stream ended with an incomplete frame.',
      );
    return frames;
  }
  finish() {
    return this.push(new Uint8Array(), true);
  }
}
