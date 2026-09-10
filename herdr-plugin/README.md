# terminal-browser herdr plugin
A real browser that runs inside your terminal



<video src="https://github.com/user-attachments/assets/abe2f43e-fc50-4866-b753-33388967945d" controls></video>

### Install (macOS & Linux)

```bash
herdr plugin install zenbu-labs/terminal-browser/herdr-plugin
```
### Herdr actions 
#### `open-split`

Open terminal-browser in a split to the right of your focused pane.

### Usage
```
terminal-browser # launches the browser
terminal-browser open <url> # opens the browser at a url
terminal-browser --split right # opens the browser in a split pane to the right
terminal-browser ls # lists open browsers
terminal-browser action # an agent-browser compatible cli for interacting with open terminal-browsers
```


### Packaged startup verification

Run the local acceptance test with an extracted package and the absolute path to a prepared Herdr 0.8.2 or newer binary:

```bash
node scripts/test/startup-dist.mjs /path/to/extracted/terminal-browser /absolute/path/to/herdr
```

The test uses a private Bubblewrap sandbox. It checks direct terminal, split, new-tab, companion, and loaded Pi extension failures. It also verifies that the isolated ownership lock and an unrelated pane do not change. The test needs prepared Pi host dependencies and does not run in CI when Herdr is unavailable.

Startup failures return bounded JSON with the original message, an attempt ID, the exact pane when known, process exit details, cleanup status, and `terminal-browser doctor --json` as the recovery command. Failed `exec` panes report `exited` after Herdr confirms their removal. A timed-out or uncertain pane is retained instead of being closed automatically.

### Use cases:
- You can have a coding agent and website scoped to the same terminal tab
- Your agent has full access to interact with open terminal-browsers, which gives your agent the capability to use the web
- You can ask an agent to make HTML plans and them open them inside terminal-browser, which will automatically open in a split pane next to your agent
- terminal-browser works over SSH, which allows you to preview websites running on remote machines easily

