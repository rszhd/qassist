// jsdom implements no layout, so it ships no ResizeObserver. Components that
// measure themselves (RunDetail's goal clamp) construct one on mount and would
// throw before rendering anything. This stub is deliberately inert: it never
// fires, so a test sees the pre-measurement state, which for the goal clamp is
// "not clamped" — jsdom reports every height as 0 and would answer that anyway.
// A test that needs the measured state should assert against a real browser.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
