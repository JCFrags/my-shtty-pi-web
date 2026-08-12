chrome.runtime.onInstalled.addListener(() => chrome.storage.local.set({ installedAt: Date.now(), enabled: true }));

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "fill-test-identity") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const input = document.querySelector('input[autocomplete="username"]');
      if (!input) return;
      input.value = "pi";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.documentElement.dataset.piWebFixtureShortcut = "invoked";
    },
  });
});
