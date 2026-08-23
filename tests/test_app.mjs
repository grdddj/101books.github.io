import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const appSource = await readFile(new URL("../reader/static/app.js", import.meta.url), "utf8");

function createElement() {
  return {
    addEventListener() {},
    append() {},
    classList: { toggle() {} },
    contains() {
      return false;
    },
    replaceChildren() {},
    setAttribute() {},
    textContent: "",
  };
}

function loadApp({ promptResult, savedName = null }) {
  const elements = new Map();
  const localStorage = new Map(savedName === null ? [] : [["static-go-reader-user", savedName]]);
  const context = {
    Date,
    Error,
    Map,
    Array,
    Object,
    String,
    clearTimeout() {},
    document: {
      addEventListener() {},
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, createElement());
        return elements.get(selector);
      },
    },
    encodeURIComponent,
    localStorage: {
      getItem(key) {
        return localStorage.get(key) ?? null;
      },
      removeItem(key) {
        localStorage.delete(key);
      },
      setItem(key, value) {
        localStorage.set(key, value);
      },
    },
    setTimeout() {
      return 0;
    },
    window: {
      clearTimeout() {},
      prompt() {
        return promptResult;
      },
      setTimeout() {
        return 0;
      },
    },
  };
  context.globalThis = context;
  const sourceWithoutStartup = appSource.replace(
    /\nstartReader\(\);\s*$/,
    "\nglobalThis.readerTestApi = { getOrPromptUser, startReader };",
  );
  vm.runInNewContext(sourceWithoutStartup, context, { filename: "app.js" });
  return { context, elements, localStorage };
}

test("invalid saved name is discarded before a normalized replacement is stored", () => {
  const { context, localStorage } = loadApp({ promptResult: "  Ada  ", savedName: " ".repeat(81) });

  assert.equal(context.readerTestApi.getOrPromptUser(), "Ada");
  assert.equal(localStorage.get("static-go-reader-user"), "Ada");
});

test("cancelled replacement leaves no invalid name and displays recoverable feedback", async () => {
  const { context, elements, localStorage } = loadApp({ promptResult: null, savedName: " " });

  await context.readerTestApi.startReader();

  assert.equal(localStorage.has("static-go-reader-user"), false);
  assert.match(elements.get("#status-feedback").textContent, /valid name is required/i);
});
