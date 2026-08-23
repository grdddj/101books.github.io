import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const appSource = await readFile(new URL("../reader/static/app.js", import.meta.url), "utf8");
const appCss = await readFile(new URL("../reader/static/app.css", import.meta.url), "utf8");

function createElement() {
  return {
    addEventListener() {},
    appended: [],
    append(child) {
      this.appended.push(child);
    },
    classList: { toggle() {} },
    contains() {
      return false;
    },
    replaceChildren() {},
    setAttribute() {},
    style: {
      setProperty(name, value) {
        this[name] = value;
      },
    },
    textContent: "",
  };
}

function loadApp({ fetchImpl, promptResult, savedName = null }) {
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
      createElement() {
        return createElement();
      },
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, createElement());
        return elements.get(selector);
      },
    },
    encodeURIComponent,
    fetch: fetchImpl,
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
    `
globalThis.readerTestApi = {
  getBoardCrop: typeof getBoardCrop === "function" ? getBoardCrop : undefined,
  getCurrentIndex: () => currentIndex,
  getOrPromptUser,
  navigate,
  renderBoard,
  setCurrentStatus,
  startReader,
};`,
  );
  vm.runInNewContext(sourceWithoutStartup, context, { filename: "app.js" });
  return { context, elements, localStorage };
}

function response(body) {
  return {
    ok: true,
    async json() {
      return body;
    },
  };
}

function createProblems() {
  return Array.from({ length: 6 }, (_, index) => ({
    id: `problem-${index + 1}`,
    number: index + 1,
    black: ["aa"],
    white: [],
  }));
}

function createFetch({ rejectPut = false } = {}) {
  const problems = createProblems();
  return async (path, options = {}) => {
    if (path === "/api/collection") return response({ title: "Test collection", problems });
    if (path.startsWith("/api/progress?") && options.method === undefined) {
      return response({ problems: {} });
    }
    if (path === "/api/progress" && options.method === "PUT") {
      if (rejectPut) throw new Error("save failed");
      return response({ problems: {} });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
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

test("board crops include a one-line margin around the initial stones", () => {
  const { context } = loadApp({ promptResult: "Ada" });
  const cropFor = context.readerTestApi.getBoardCrop
    ? (problem) => JSON.parse(JSON.stringify(context.readerTestApi.getBoardCrop(problem)))
    : () => null;

  assert.deepEqual(
    cropFor({ black: ["aa"], white: ["bb"] }),
    { minColumn: 0, maxColumn: 2, minRow: 0, maxRow: 2, columns: 3, rows: 3 },
  );
  assert.deepEqual(
    cropFor({ black: ["jr"], white: ["ks"] }),
    { minColumn: 8, maxColumn: 11, minRow: 16, maxRow: 18, columns: 4, rows: 3 },
  );
});

test("board stones use grid positions relative to the crop", () => {
  const { context, elements } = loadApp({ promptResult: "Ada" });

  context.readerTestApi.renderBoard({ black: ["dq"], white: [] });

  const board = elements.get("#board");
  const blackStone = board.appended.find((stone) => stone.className === "stone black");
  assert.equal(board.style["--board-columns"], 3);
  assert.equal(board.style["--board-rows"], 3);
  assert.equal(blackStone.style.gridColumn, 2);
  assert.equal(blackStone.style.gridRow, 2);
});

test("rectangular crops set matching dimensions and keep grid intervals square", () => {
  const { context, elements } = loadApp({ promptResult: "Ada" });

  context.readerTestApi.renderBoard({ black: ["be", "hh"], white: [] });

  const board = elements.get("#board");
  assert.equal(board.style["--board-columns"], 9);
  assert.equal(board.style["--board-rows"], 6);
  assert.match(
    appCss,
    /aspect-ratio:\s*var\(--board-columns\)\s*\/\s*var\(--board-rows\);/,
  );
});

test("successful status saves advance one problem without passing the final problem", async () => {
  const { context } = loadApp({ fetchImpl: createFetch(), promptResult: "Ada" });
  await context.readerTestApi.startReader();
  context.readerTestApi.navigate(4);

  await context.readerTestApi.setCurrentStatus("solved");
  assert.equal(context.readerTestApi.getCurrentIndex(), 5);

  await context.readerTestApi.setCurrentStatus("revisit");
  assert.equal(context.readerTestApi.getCurrentIndex(), 5);
});

test("failed status saves do not change the current problem", async () => {
  const { context } = loadApp({
    fetchImpl: createFetch({ rejectPut: true }),
    promptResult: "Ada",
  });
  await context.readerTestApi.startReader();
  context.readerTestApi.navigate(4);

  await context.readerTestApi.setCurrentStatus("solved");

  assert.equal(context.readerTestApi.getCurrentIndex(), 4);
});
