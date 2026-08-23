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
    attributes: {},
    classList: { toggle() {} },
    contains() {
      return false;
    },
    replaceChildren(...children) {
      this.appended = children;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
      if (name === "class") this.className = value;
    },
    style: {
      setProperty(name, value) {
        this[name] = value;
      },
    },
    textContent: "",
  };
}

function loadApp({ fetchImpl, promptResult, savedName = null, savedCollection = null }) {
  const elements = new Map();
  const localStorage = new Map(
    [
      ["static-go-reader-user", savedName],
      ["static-go-reader-collection", savedCollection],
    ].filter(([, value]) => value !== null),
  );
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
      createElementNS() {
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
  getSavedCollection: typeof getSavedCollection === "function" ? getSavedCollection : undefined,
  loadActiveCollection: typeof loadActiveCollection === "function" ? loadActiveCollection : undefined,
  navigate,
  renderBoard,
  selectCollection: typeof selectCollection === "function" ? selectCollection : undefined,
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
    if (path === "/api/collections") {
      return response([
        {
          slug: "test-collection",
          title: "Test collection",
          category: "tsumego",
          level: "20 kyu",
          problem_count: problems.length,
        },
      ]);
    }
    if (path === "/api/collections/test-collection") {
      return response({ slug: "test-collection", title: "Test collection", problems });
    }
    if (path.startsWith("/api/progress?") && options.method === undefined) {
      return response({ problems: {} });
    }
    if (path === "/api/progress" && options.method === "PUT") {
      if (rejectPut) throw new Error("save failed");
      const { problem_id: problemId, status } = JSON.parse(options.body);
      return response({ problems: { [problemId]: { status } } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
}

function createCollectionFixture() {
  const catalog = [
    {
      slug: "basic",
      title: "Basic shapes",
      category: "tsumego",
      level: "20 kyu",
      problem_count: 2,
    },
    {
      slug: "advanced",
      title: "Advanced shapes",
      category: "life and death",
      level: "1 dan",
      problem_count: 3,
    },
  ];
  const collections = {
    basic: {
      slug: "basic",
      title: "Basic shapes",
      problems: [
        { id: "basic:1@1", number: 1, black: ["aa"], white: [] },
        { id: "basic:2@1", number: 2, black: ["bb"], white: [] },
      ],
    },
    advanced: {
      slug: "advanced",
      title: "Advanced shapes",
      problems: [
        { id: "advanced:1@1", number: 1, black: ["cc"], white: [] },
        { id: "advanced:2@1", number: 2, black: ["dd"], white: [] },
        { id: "advanced:3@1", number: 3, black: ["ee"], white: [] },
      ],
    },
  };
  return { catalog, collections };
}

function createCollectionFetch({ problems = {} } = {}) {
  const { catalog, collections } = createCollectionFixture();
  const calls = [];
  return {
    calls,
    catalog,
    fetchImpl: async (path) => {
      calls.push(path);
      if (path === "/api/collections") return response(catalog);
      if (path.startsWith("/api/collections/")) {
        return response(collections[decodeURIComponent(path.slice("/api/collections/".length))]);
      }
      if (path.startsWith("/api/progress?")) return response({ problems });
      throw new Error(`Unexpected request: ${path}`);
    },
  };
}

test("a valid saved collection is loaded after the catalog and starts at its first revisit", async () => {
  const { fetchImpl, calls } = createCollectionFetch({
    problems: {
      "advanced:1@1": { status: "solved" },
      "advanced:2@1": { status: "revisit" },
    },
  });
  const { context, elements, localStorage } = loadApp({
    fetchImpl,
    promptResult: "Ada",
    savedCollection: "advanced",
  });

  await context.readerTestApi.startReader();

  assert.deepEqual(calls, [
    "/api/collections",
    "/api/collections/advanced",
    "/api/progress?user=Ada",
  ]);
  assert.equal(localStorage.get("static-go-reader-collection"), "advanced");
  assert.equal(elements.get("#collection-title").textContent, "Advanced shapes");
  assert.equal(context.readerTestApi.getCurrentIndex(), 1);
});

test("an invalid saved collection falls back to the first API-sorted catalog entry", async () => {
  const { fetchImpl, catalog } = createCollectionFetch();
  const { context, elements, localStorage } = loadApp({
    fetchImpl,
    promptResult: "Ada",
    savedCollection: "missing",
  });

  await context.readerTestApi.startReader();

  assert.equal(context.readerTestApi.getSavedCollection(catalog), "basic");
  assert.equal(localStorage.get("static-go-reader-collection"), "basic");
  assert.deepEqual(
    elements
      .get("#collection-list")
      .appended.map((item) => item.appended[0].textContent),
    [
      "Basic shapes · 20 kyu · tsumego · 2 problems · Solved: 0 · Revisit: 0",
      "Advanced shapes · 1 dan · life and death · 3 problems · Solved: 0 · Revisit: 0",
    ],
  );
  assert.ok(catalog.every((item) => !("problems" in item) && !("moves" in item)));
});

test("selecting a collection persists it, closes the panel, and scopes progress to its namespace", async () => {
  const { fetchImpl } = createCollectionFetch({
    problems: {
      "basic:1@1": { status: "solved" },
      "advanced:1@1": { status: "solved" },
      "advanced:2@1": { status: "revisit" },
    },
  });
  const { context, elements, localStorage } = loadApp({
    fetchImpl,
    promptResult: "Ada",
    savedCollection: "basic",
  });
  await context.readerTestApi.startReader();
  elements.get("#collection-panel").hidden = false;

  await context.readerTestApi.selectCollection("advanced");

  assert.equal(localStorage.get("static-go-reader-collection"), "advanced");
  assert.equal(elements.get("#collection-panel").hidden, true);
  assert.equal(elements.get("#collection-title").textContent, "Advanced shapes");
  assert.equal(elements.get("#progress-summary").textContent, "Solved: 1 · Revisit: 1 · Total: 3");
  assert.equal(context.readerTestApi.getCurrentIndex(), 1);
});

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
  assert.deepEqual(
    cropFor({ black: ["ii"], white: ["jj"] }),
    { minColumn: 7, maxColumn: 10, minRow: 7, maxRow: 10, columns: 4, rows: 4 },
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

test("board creates one explicit grid line for every crop row and column", () => {
  const { context, elements } = loadApp({ promptResult: "Ada" });

  context.readerTestApi.renderBoard({ black: ["be", "hh"], white: [] });

  const grid = elements
    .get("#board")
    .appended.find((element) => element.className === "goban-grid");
  const gridLines = grid.appended;
  assert.equal(
    gridLines.filter((line) => line.className.includes("vertical")).length,
    9,
  );
  assert.equal(
    gridLines.filter((line) => line.className.includes("horizontal")).length,
    6,
  );
});

test("successful status saves advance one problem without passing the final problem", async () => {
  const { context, elements } = loadApp({ fetchImpl: createFetch(), promptResult: "Ada" });
  await context.readerTestApi.startReader();
  context.readerTestApi.navigate(4);

  await context.readerTestApi.setCurrentStatus("solved");
  assert.equal(context.readerTestApi.getCurrentIndex(), 5);

  await context.readerTestApi.setCurrentStatus("revisit");
  assert.equal(context.readerTestApi.getCurrentIndex(), 5);
  assert.equal(elements.get("#status-feedback").textContent, "Problem 6 marked revisit.");
  assert.equal(elements.get("#revisit").attributes["aria-pressed"], "true");
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

test("duplicate status actions and navigation are ignored while a save is pending", async () => {
  const pendingSave = Promise.withResolvers();
  const problems = createProblems();
  let putCalls = 0;
  const fetchImpl = async (path, options = {}) => {
    if (path === "/api/collections") {
      return response([{ slug: "test-collection", title: "Test collection", category: "tsumego", level: "20 kyu", problem_count: problems.length }]);
    }
    if (path === "/api/collections/test-collection") {
      return response({ slug: "test-collection", title: "Test collection", problems });
    }
    if (path.startsWith("/api/progress?")) return response({ problems: {} });
    if (path === "/api/progress" && options.method === "PUT") {
      putCalls += 1;
      return pendingSave.promise;
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements } = loadApp({ fetchImpl, promptResult: "Ada" });
  await context.readerTestApi.startReader();
  context.readerTestApi.navigate(4);

  const firstSave = context.readerTestApi.setCurrentStatus("solved");
  const duplicateSave = context.readerTestApi.setCurrentStatus("revisit");
  context.readerTestApi.navigate(1);

  assert.equal(putCalls, 1);
  assert.equal(context.readerTestApi.getCurrentIndex(), 4);
  for (const selector of ["#previous", "#solved", "#revisit", "#next"]) {
    assert.equal(elements.get(selector).disabled, true);
  }

  pendingSave.resolve(response({ problems: { "problem-5": { status: "solved" } } }));
  await Promise.all([firstSave, duplicateSave]);

  assert.equal(context.readerTestApi.getCurrentIndex(), 5);
});

test("a failed pending save retains the visible problem and restores controls", async () => {
  const pendingSave = Promise.withResolvers();
  const problems = createProblems();
  const fetchImpl = async (path, options = {}) => {
    if (path === "/api/collections") {
      return response([{ slug: "test-collection", title: "Test collection", category: "tsumego", level: "20 kyu", problem_count: problems.length }]);
    }
    if (path === "/api/collections/test-collection") {
      return response({ slug: "test-collection", title: "Test collection", problems });
    }
    if (path.startsWith("/api/progress?")) return response({ problems: {} });
    if (path === "/api/progress" && options.method === "PUT") return pendingSave.promise;
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements } = loadApp({ fetchImpl, promptResult: "Ada" });
  await context.readerTestApi.startReader();
  context.readerTestApi.navigate(4);

  const save = context.readerTestApi.setCurrentStatus("solved");
  pendingSave.reject(new Error("save failed"));
  await save;

  assert.equal(context.readerTestApi.getCurrentIndex(), 4);
  for (const selector of ["#previous", "#solved", "#revisit", "#next"]) {
    assert.equal(elements.get(selector).disabled, false);
  }
  assert.equal(elements.get("#status-feedback").textContent, "save failed");
});
