const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const net = require("node:net");
const test = require("node:test");
const { daemonRequest } = require("../dist/daemon-status.js");

test("daemon status preserves missing and inaccessible socket error codes without private messages", async t => {
  for (const code of ["ENOENT", "EACCES", "ECONNREFUSED"]) {
    const connection = new EventEmitter();
    connection.destroy = () => {};
    connection.write = () => {};
    t.mock.method(net, "connect", () => {
      queueMicrotask(() => connection.emit("error", Object.assign(new Error("private socket details"), { code })));
      return connection;
    });
    await assert.rejects(daemonRequest({ cmd: "status" }), error => {
      assert.equal(error.code, code);
      assert.equal(error.message, "daemon status unavailable");
      return true;
    });
    t.mock.restoreAll();
  }
});
