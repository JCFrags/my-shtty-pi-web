---
name: terminal-browser
description: Use for interactive websites or local HTML in a terminal companion. In Pi, use the five native browser tools for owner-scoped observation and AgentCursor input. Outside Pi, the supported terminal-browser CLI remains available.
---

## Pi workflow

Use `browser_open`, `browser_observe`, `browser_act`, `browser_tabs`, and
`browser_control`. If these tools are hidden, discover them through the installed
tool search. Do not substitute shell commands because a native tool is hidden.

Open or reuse this Pi pane's companion with `browser_open`. Observe before acting.
Use `browser_act` for slow-natural AgentCursor input, `browser_tabs` for contexts
and downloads, and `browser_control` for pause or explicit resume. Use one action
per call. Keep observations bounded. Pi manages owner routing, observation IDs,
and control epochs internally. Never resume human control automatically or repeat
an action whose side effect may already have been delivered.

## CLI workflow outside Pi

The upstream CLI and agent-browser compatibility remain supported. They are not
the replacement for Pi's native browser tools.

`terminal-browser open <url>` puts a browser in a terminal pane. On its own it
takes over the current pane. `--split right` (or `down`, `left`, `up`) opens a
new pane beside the human, which is how you show a page next to the
conversation. A path to a local html file works the same as a url, so writing a
page and opening it is a way to show something you built.

`terminal-browser ls` shows the browsers and tabs in this terminal tab, with the
tab ids the other commands take.

`terminal-browser action -- <command>` is an agent-browser compatible CLI for a
tab that is already open. It targets this terminal tab's browser and its active
tab unless you select another one.

When you use the terminal-browser action sub command, the user will visually
see in the browser tab an indication that you are acting on the browser tab. This
will automatically hide after a preset duration, where the countdown resets
everytime terminal-browser action is used. But its a much better experience
for the user if after the last time you plan to use terminal-browser action you
run terminal-browser action done, which immediately clears the indication
that you are using the browser tab

## Command reference
