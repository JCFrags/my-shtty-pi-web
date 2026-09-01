/** Minimal non-rendering Text surface for the headless installed Pi worker. */
export class Text {
  #text: string;
  constructor(text: string, x: number, y: number) { this.#text = text; void x; void y; }
  setText(text: string): void { this.#text = text; }
  toString(): string { return this.#text; }
}
