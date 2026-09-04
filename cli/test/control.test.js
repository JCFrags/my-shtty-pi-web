const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { control } = require("../dist/control.js");

test("control keeps visual bytes in the binary socket payload", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-control-"));
  const socketPath = path.join(directory, "control.sock");
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  let headerText = "";
  const server = net.createServer((connection) => {
    let request = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      request += chunk;
      const newline = request.indexOf("\n");
      if (newline < 0) return;
      const parsed = JSON.parse(request.slice(0, newline));
      const header = {
        id: parsed.id,
        ok: true,
        data: {
          observationId: "obs",
          visual: { mimeType: "image/png", width: 2, height: 2, bytes: image.byteLength },
        },
        binaryBytes: image.byteLength,
      };
      headerText = JSON.stringify(header);
      connection.write(`${headerText}\n`);
      connection.end(image);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const result = await control(socketPath, { cmd: "agent.observe" });
    assert.deepEqual(result.visual.data, image);
    assert.equal(headerText.includes(image.toString("base64")), false);
    assert.equal(headerText.includes('"data":{"type":"Buffer"'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
