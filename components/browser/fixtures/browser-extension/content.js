document.documentElement.dataset.piWebFixtureExtension = "loaded";
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "l") {
    const input = document.querySelector('input[autocomplete="username"]');
    if (input) { input.value = "pi"; input.dispatchEvent(new Event("input", { bubbles: true })); }
  }
});
