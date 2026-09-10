import { app } from "electron";

import { claimProfile } from "../src/profile";

const profile = claimProfile();
const mode = process.argv.at(-1);

setTimeout(() => {
  if (mode === "exit") {
    process.stderr.write("fixture handled startup failure\n");
    profile.release();
    app.exit(21);
  } else if (mode === "quit") {
    app.quit();
  } else {
    process.stdout.write(`READY ${process.pid}\n`);
    setInterval(() => {}, 1000);
  }
}, 100);
