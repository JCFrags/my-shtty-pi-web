#!/usr/bin/env node
import { Readability } from "@mozilla/readability";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const identities = new Set(["defuddle", "readability-turndown"]);
const identity = process.argv[2];
if (!identities.has(identity)) process.exit(2);

let input = "";
for await (const chunk of process.stdin) input += chunk;
let request;
try {
  request = JSON.parse(input);
} catch {
  process.exit(2);
}

const { document } = parseHTML(String(request.html));
const title = document.querySelector("title")?.textContent?.trim() ?? "";
const sourceParagraphs = document.querySelectorAll("p").length;

function toMarkdown(content = "") {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    linkStyle: "inlined",
  });
  turndown.addRule("table", {
    filter: "table",
    /** @param {string} _content @param {any} node */
    replacement(_content, node) {
      const rows = [...node.querySelectorAll("tr")].map((row) =>
        [...row.querySelectorAll("th,td")].map((cell) =>
          cell.textContent.replaceAll("|", "\\|").replace(/\s+/g, " ").trim()
        )
      ).filter((row) => row.length);
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
      const header = normalized[0];
      const body = normalized.slice(1);
      return `\n\n| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |${
        body.length ? `\n${body.map((row) => `| ${row.join(" | ")} |`).join("\n")}` : ""
      }\n\n`;
    },
  });
  return turndown.turndown(content ?? "");
}

/** @type {{content:string,title:string,extractor:string,metadata:Record<string,unknown>}} */
let result;
if (request.view === "raw") {
  result = {
    content: String(request.html), title, extractor: `${identity}:raw-html`,
    metadata: { extractor: `${identity}:raw-html`, sourceParagraphs },
  };
} else if (identity === "defuddle") {
  const parsed = await Defuddle(document, String(request.url), { markdown: true });
  result = {
    content: String(parsed.content ?? ""),
    title: String(parsed.title ?? title),
    extractor: identity,
    metadata: { candidateRuntime: "node", markdown: true, extractor: identity, sourceParagraphs },
  };
} else {
  const article = new Readability(document, {
    charThreshold: 0,
    maxElemsToParse: 10000,
  }).parse();
  result = {
    content: article ? toMarkdown(article.content ?? "") : "",
    title: String(article?.title ?? title),
    extractor: identity,
    metadata: { candidateRuntime: "node", markdownConverter: "turndown", extractor: identity, sourceParagraphs },
  };
}
if (request.view === "outline") {
  result.content = result.content.split("\n").filter((line) => /^#{1,6}\s+\S/.test(line.trim())).join("\n");
}
process.stdout.write(JSON.stringify(result));
