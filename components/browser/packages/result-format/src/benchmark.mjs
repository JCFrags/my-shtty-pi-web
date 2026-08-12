import { readFile } from "node:fs/promises";
import { encode } from "@toon-format/toon";

const corpusPath = new URL("../../../tests/observations/corpus.json", import.meta.url);
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
for (const entry of corpus) {
  const json = JSON.stringify(entry.value);
  const toon = encode(entry.value);
  console.log(JSON.stringify({ name: entry.name, jsonChars: json.length, toonChars: toon.length, savings: 1 - toon.length / json.length }));
}
