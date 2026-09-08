const MIN_BLOCK_CHARS = 20;

/** Select one deterministic contiguous passage from canonical normalized text. */
export function selectCanonicalPassage(content: string, query: string, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("passage limit must be a positive integer");
  const points = [...content];
  if (points.length <= limit) return content;

  const terms = queryTerms(query);
  const exact = query.trim().toLowerCase();
  const blocks = passageBlocks(content);
  let selected = blocks[0] ?? { text: content, start: 0 };
  let selectedScore = -1;
  for (const block of blocks) {
    const lower = block.text.toLowerCase();
    const termScore = terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
    const score = termScore * 10 + (exact.length > 0 && lower.includes(exact) ? 1000 : 0);
    if (score > selectedScore) {
      selected = block;
      selectedScore = score;
    }
  }

  const lowerContent = content.toLowerCase();
  const exactPosition = exact.length > 0 ? lowerContent.indexOf(exact) : -1;
  const termPositions = terms.map((term) => lowerContent.indexOf(term, selected.start)).filter((position) => position >= 0);
  const anchor = exactPosition >= 0 ? exactPosition : termPositions.length > 0 ? Math.min(...termPositions) : selected.start;
  const selectedPoint = [...content.slice(0, anchor)].length;
  const start = Math.max(0, Math.min(selectedPoint - Math.floor(limit / 5), points.length - limit));
  return points.slice(start, start + limit).join("").trim();
}

function queryTerms(query: string): readonly string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9.+-]{1,}/gu) ?? [])];
}

function passageBlocks(content: string): Array<{ text: string; start: number }> {
  const blocks: Array<{ text: string; start: number }> = [];
  const pattern = /[^\n]+(?:\n(?!\n)[^\n]+)*|[^.!?\n]+[.!?](?=\s|$)/gu;
  for (const match of content.matchAll(pattern)) {
    const text = match[0].trim();
    if (text.length >= MIN_BLOCK_CHARS) blocks.push({ text, start: match.index ?? 0 });
  }
  return blocks;
}
