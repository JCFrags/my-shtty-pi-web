import { spawn } from "node:child_process";

export function openLink(href: string) {
  if (!/^https?:\/\//i.test(href)) return;
  spawn("open", [href], { stdio: "ignore", detached: true }).unref();
}
