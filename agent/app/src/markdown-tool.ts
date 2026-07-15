import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const MARKDOWN_TOOL = "mcp__pixel__markdown";

export function markdownToolInput(input: Record<string, unknown>): {
  title: string;
  markdown: string;
} {
  return {
    title: typeof input.title === "string" ? input.title : "document",
    markdown: typeof input.markdown === "string" ? input.markdown : "",
  };
}

export const pixelMcpServer = createSdkMcpServer({
  name: "pixel",
  version: "1.0.0",
  tools: [
    tool(
      "markdown",
      "Write a markdown document for the user. It renders in a rich side panel " +
        "(headings, lists, tables of contents, syntax-highlighted code, images), so " +
        "prefer this over long markdown in chat whenever you produce a report, plan, " +
        "explanation, or any document-shaped answer.",
      {
        title: z.string().describe("Short document title shown on the tool call"),
        markdown: z.string().describe("The full markdown document"),
      },
      async () => ({
        content: [
          {
            type: "text",
            text: "Rendered. The user can read the document in the side panel.",
          },
        ],
      })
    ),
  ],
});
