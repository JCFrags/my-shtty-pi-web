export interface InlineSpan {
  start: number;
  end: number;
  bold: boolean;
  code: boolean;
}

export interface InlineMarkdown {
  text: string;
  spans: InlineSpan[];
}

// a little hacky but fine for now
export function parseInline(source: string): InlineMarkdown {
  let text = "";
  let bytes = 0;
  const spans: InlineSpan[] = [];
  const push = (chunk: string) => {
    text += chunk;
    bytes += Buffer.byteLength(chunk);
  };
  let i = 0;
  while (i < source.length) {
    if (source[i] === "`") {
      const close = source.indexOf("`", i + 1);
      if (close > i + 1) {
        const start = bytes;
        push(source.slice(i + 1, close));
        spans.push({ start, end: bytes, bold: false, code: true });
        i = close + 1;
        continue;
      }
    }
    if (source.startsWith("**", i)) {
      const close = source.indexOf("**", i + 2);
      if (close > i + 2) {
        const inner = parseInline(source.slice(i + 2, close));
        const base = bytes;
        push(inner.text);
        let at = base;
        for (const span of inner.spans) {
          if (base + span.start > at) {
            spans.push({ start: at, end: base + span.start, bold: true, code: false });
          }
          spans.push({ start: base + span.start, end: base + span.end, bold: true, code: span.code });
          at = base + span.end;
        }
        if (at < bytes) spans.push({ start: at, end: bytes, bold: true, code: false });
        i = close + 2;
        continue;
      }
    }
    const chunk = String.fromCodePoint(source.codePointAt(i)!);
    push(chunk);
    i += chunk.length;
  }
  return { text, spans };
}
