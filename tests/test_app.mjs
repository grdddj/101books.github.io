import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const appSource = await readFile(new URL("../reader/static/app.js", import.meta.url), "utf8");
const appCss = await readFile(new URL("../reader/static/app.css", import.meta.url), "utf8");

function createElement(documentState) {
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
    focus() {
      documentState.activeElement = this;
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

function loadApp({
  basePath = "",
  fetchImpl,
  promptResult,
  savedName = null,
  savedCollection = null,
  pathname = "/",
}) {
  const elements = new Map();
  const documentState = { activeElement: null };
  const historyCalls = [];
  const historyReplaceCalls = [];
  const timers = new Map();
  const windowListeners = new Map();
  let nextTimerId = 0;
  const clearTimer = (timerId) => timers.delete(timerId);
  const setTimer = (callback) => {
    nextTimerId += 1;
    timers.set(nextTimerId, callback);
    return nextTimerId;
  };
  const localStorage = new Map(
    [
      ["static-go-reader-user", savedName],
      ["static-go-reader-collection", savedCollection],
    ].filter(([, value]) => value !== null),
  );
  const location = { pathname };
  const window = {
    READER_BASE_PATH: basePath,
    addEventListener(event, listener) {
      windowListeners.set(event, listener);
    },
    clearTimeout: clearTimer,
    history: {
      pushState(_state, _title, path) {
        historyCalls.push(path);
        location.pathname = path;
      },
      replaceState(_state, _title, path) {
        historyReplaceCalls.push(path);
        location.pathname = path;
      },
    },
    location,
    prompt() {
      return promptResult;
    },
    setTimeout: setTimer,
  };
  const context = {
    Date,
    Error,
    Map,
    Array,
    Object,
    String,
    clearTimeout: clearTimer,
    document: {
      get activeElement() {
        return documentState.activeElement;
      },
      addEventListener() {},
      createElement() {
        return createElement(documentState);
      },
      createElementNS() {
        return createElement(documentState);
      },
      querySelector(selector) {
        if (!elements.has(selector)) {
          const element = createElement(documentState);
          if (selector === "#collection-panel") element.hidden = true;
          elements.set(selector, element);
        }
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
    setTimeout: setTimer,
    window,
  };
  context.globalThis = context;
  const sourceWithoutStartup = appSource.replace(
    /\nstartReader\(\);\s*$/,
    `
globalThis.readerTestApi = {
  getBoardCrop: typeof getBoardCrop === "function" ? getBoardCrop : undefined,
  getCollectionPath: typeof getCollectionPath === "function" ? getCollectionPath : undefined,
  handleKeydown: typeof handleKeydown === "function" ? handleKeydown : undefined,
  handleWheel: typeof handleWheel === "function" ? handleWheel : undefined,
  getCollectionSlugFromPath: typeof getCollectionSlugFromPath === "function" ? getCollectionSlugFromPath : undefined,
  getCurrentIndex: () => currentIndex,
  getOrPromptUser,
  getSavedCollection: typeof getSavedCollection === "function" ? getSavedCollection : undefined,
  loadActiveCollection: typeof loadActiveCollection === "function" ? loadActiveCollection : undefined,
  navigate,
  openCollectionPanel: typeof openCollectionPanel === "function" ? openCollectionPanel : undefined,
  queueReaderWheel: () => handleWheel({ deltaY: 100, target: reader }),
  renderBoard,
  selectCollection: typeof selectCollection === "function" ? selectCollection : undefined,
  setCurrentStatus,
  startReader,
};`,
  );
  vm.runInNewContext(sourceWithoutStartup, context, { filename: "app.js" });
  const flushTimers = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
    return callbacks.length;
  };
  const firePopstate = async () => windowListeners.get("popstate")?.();
  return {
    context,
    documentState,
    elements,
    firePopstate,
    flushTimers,
    historyCalls,
    historyReplaceCalls,
    localStorage,
  };
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

test("a collection URL selects its catalog entry on startup", async () => {
  const fetchImpl = createFetch();
  const { context, elements } = loadApp({
    fetchImpl,
    pathname: "/collections/test-collection",
    promptResult: "Ada",
  });

  await context.readerTestApi.startReader();

  assert.equal(context.readerTestApi.getCollectionSlugFromPath(), "test-collection");
  assert.equal(elements.get("#collection-title").textContent, "Test collection");
});

test("a configured base path prefixes API calls and collection history", async () => {
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push([path, options.method ?? "GET"]);
    if (path === "/tsumego/api/collections") {
      return response([
        {
          slug: "basic",
          title: "Basic shapes",
          category: "tsumego",
          level: "20 kyu",
          problem_count: 1,
        },
        {
          slug: "advanced",
          title: "Advanced shapes",
          category: "tesuji",
          level: "1 dan",
          problem_count: 1,
        },
      ]);
    }
    if (path === "/tsumego/api/collections/basic") {
      return response({
        slug: "basic",
        title: "Basic shapes",
        problems: [{ id: "basic:1@1", number: 1, black: ["aa"], white: [] }],
      });
    }
    if (path === "/tsumego/api/collections/advanced") {
      return response({
        slug: "advanced",
        title: "Advanced shapes",
        problems: [{ id: "advanced:1@1", number: 1, black: ["bb"], white: [] }],
      });
    }
    if (path === "/tsumego/api/progress?user=Ada") return response({ problems: {} });
    if (path === "/tsumego/api/progress" && options.method === "PUT") {
      return response({ problems: { "advanced:1@1": { status: "solved" } } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, historyCalls } = loadApp({
    basePath: "/tsumego",
    fetchImpl,
    pathname: "/tsumego/collections/basic",
    promptResult: "Ada",
  });

  await context.readerTestApi.startReader();
  await context.readerTestApi.selectCollection("advanced");
  await context.readerTestApi.setCurrentStatus("solved");

  assert.deepEqual(calls, [
    ["/tsumego/api/collections", "GET"],
    ["/tsumego/api/collections/basic", "GET"],
    ["/tsumego/api/progress?user=Ada", "GET"],
    ["/tsumego/api/collections/advanced", "GET"],
    ["/tsumego/api/progress?user=Ada", "GET"],
    ["/tsumego/api/progress", "PUT"],
  ]);
  assert.deepEqual(historyCalls, ["/tsumego/collections/advanced"]);
  assert.equal(context.window.location.pathname, "/tsumego/collections/advanced");
});

test("an unknown collection URL reports an error without loading the first catalog entry", async () => {
  const { fetchImpl, calls } = createCollectionFetch();
  const { context, elements } = loadApp({
    fetchImpl,
    pathname: "/collections/missing",
    promptResult: "Ada",
    savedCollection: "basic",
  });

  await context.readerTestApi.startReader();

  assert.deepEqual(calls, ["/api/collections"]);
  assert.equal(elements.get("#collection-title").textContent, "");
  assert.match(elements.get("#status-feedback").textContent, /unknown collection/i);
  assert.equal(elements.get("#change-collection").disabled, false);
  assert.equal(elements.get("#collection-list").appended.length, 2);

  context.readerTestApi.openCollectionPanel({
    currentTarget: elements.get("#change-collection"),
  });
  await context.readerTestApi.selectCollection("basic");

  assert.equal(elements.get("#collection-title").textContent, "Basic shapes");
  assert.equal(context.window.location.pathname, "/collections/basic");
});

test("only the root and one collection segment are valid reader paths", () => {
  const root = loadApp({ pathname: "/", promptResult: "Ada" });
  assert.equal(root.context.readerTestApi.getCollectionPath().kind, "root");

  const collection = loadApp({ pathname: "/collections/test-collection", promptResult: "Ada" });
  assert.equal(collection.context.readerTestApi.getCollectionPath().kind, "collection");
  assert.equal(collection.context.readerTestApi.getCollectionPath().slug, "test-collection");

  const invalidPaths = [
    "/collections/missing/",
    "/collections/",
    "/anything",
    "/collections/%E0%A4",
  ];
  for (const pathname of invalidPaths) {
    const { context } = loadApp({ pathname, promptResult: "Ada" });
    assert.equal(context.readerTestApi.getCollectionPath().kind, "invalid", pathname);
  }
});

test("an invalid initial path reports an error without loading the saved collection", async () => {
  const invalidPaths = [
    "/collections/missing/",
    "/collections/",
    "/anything",
    "/collections/%E0%A4",
  ];
  for (const pathname of invalidPaths) {
    const { fetchImpl, calls } = createCollectionFetch();
    const { context, elements } = loadApp({
      fetchImpl,
      pathname,
      promptResult: "Ada",
      savedCollection: "basic",
    });

    await context.readerTestApi.startReader();

    assert.deepEqual(calls, ["/api/collections"], pathname);
    assert.equal(elements.get("#collection-title").textContent, "", pathname);
    assert.match(elements.get("#status-feedback").textContent, /invalid collection url/i, pathname);
    assert.equal(elements.get("#change-collection").disabled, false, pathname);
    assert.equal(elements.get("#collection-list").appended.length, 2, pathname);
    if (pathname === "/anything") {
      context.readerTestApi.openCollectionPanel({
        currentTarget: elements.get("#change-collection"),
      });
      await context.readerTestApi.selectCollection("basic");
      assert.equal(elements.get("#collection-title").textContent, "Basic shapes");
      assert.equal(context.window.location.pathname, "/collections/basic");
    }
  }
});

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
      .appended.map((item) => item.appended[0].appended[0].textContent),
    [
      "Basic shapes · 20 kyu · tsumego · 2 problems · Solved: 0 (0%) · Revisit: 0",
      "Advanced shapes · 1 dan · life and death · 3 problems · Solved: 0 (0%) · Revisit: 0",
    ],
  );
  assert.ok(catalog.every((item) => !("problems" in item) && !("moves" in item)));
});

test("the collection list shows progress states and solved percentages", async () => {
  const { fetchImpl, catalog } = createCollectionFetch({
    problems: {
      "advanced:1@1": { status: "revisit" },
      "partial:1@1": { status: "solved" },
      "thirds:1@1": { status: "solved" },
      "complete:1@1": { status: "solved" },
      "complete:2@1": { status: "solved" },
    },
  });
  catalog.push(
    {
      slug: "partial",
      title: "Partial shapes",
      category: "tesuji",
      level: "10 kyu",
      problem_count: 4,
    },
    {
      slug: "thirds",
      title: "Thirds shapes",
      category: "joseki",
      level: "8 kyu",
      problem_count: 3,
    },
    {
      slug: "complete",
      title: "Complete shapes",
      category: "fuseki",
      level: "5 kyu",
      problem_count: 2,
    },
  );
  const { context, elements } = loadApp({
    fetchImpl,
    promptResult: "Ada",
    savedCollection: "basic",
  });

  await context.readerTestApi.startReader();

  const options = elements
    .get("#collection-list")
    .appended.map((item) => item.appended[0]);
  assert.equal(options[0].className, "collection-option");
  assert.equal(options[1].className, "collection-option collection-option--started");
  assert.equal(options[2].className, "collection-option collection-option--partial");
  assert.equal(options[3].className, "collection-option collection-option--partial");
  assert.equal(options[4].className, "collection-option collection-option--complete");
  assert.equal(options[0].style["--collection-progress"], "0%");
  assert.equal(options[1].style["--collection-progress"], "0%");
  assert.equal(options[2].style["--collection-progress"], "25%");
  assert.equal(options[3].style["--collection-progress"], "33.33333333333333%");
  assert.equal(options[4].style["--collection-progress"], "100%");
  assert.match(options[0].appended[0].textContent, /Solved: 0 \(0%\)/);
  assert.match(options[1].appended[0].textContent, /Solved: 0 \(0%\)/);
  assert.match(options[2].appended[0].textContent, /Solved: 1 \(25%\)/);
  assert.match(options[3].appended[0].textContent, /Solved: 1 \(33%\)/);
  assert.match(options[4].appended[0].textContent, /Solved: 2 \(100%\)/);
  assert.match(appCss, /var\(--collection-progress\)/);
  assert.match(
    appCss,
    /\.collection-panel \.collection-option--complete:hover:not\(:disabled\)\s*{[^}]*background:\s*#d9f0e1;/,
  );
  for (const state of ["started", "partial", "complete"]) {
    assert.match(appCss, new RegExp(`\\.collection-option--${state}`));
  }
});

test("selecting a collection persists it, pushes a shareable URL, closes the panel, and scopes progress to its namespace", async () => {
  const { fetchImpl } = createCollectionFetch({
    problems: {
      "basic:1@1": { status: "solved" },
      "advanced:1@1": { status: "solved" },
      "advanced:2@1": { status: "revisit" },
    },
  });
  const { context, elements, historyCalls, localStorage } = loadApp({
    fetchImpl,
    promptResult: "Ada",
    savedCollection: "basic",
  });
  await context.readerTestApi.startReader();
  elements.get("#collection-panel").hidden = false;

  await context.readerTestApi.selectCollection("advanced");

  assert.equal(localStorage.get("static-go-reader-collection"), "advanced");
  assert.deepEqual(historyCalls, ["/collections/advanced"]);
  assert.equal(elements.get("#collection-panel").hidden, true);
  assert.equal(elements.get("#collection-title").textContent, "Advanced shapes");
  assert.equal(elements.get("#progress-summary").textContent, "Solved: 1 · Revisit: 1 · Total: 3");
  assert.equal(context.readerTestApi.getCurrentIndex(), 1);
});

test("popstate loads the current collection URL without adding a history entry", async () => {
  const { fetchImpl } = createCollectionFetch();
  const { context, elements, firePopstate, historyCalls } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    promptResult: "Ada",
  });
  await context.readerTestApi.startReader();
  await context.readerTestApi.selectCollection("advanced");

  context.window.location.pathname = "/collections/basic";
  await firePopstate();

  assert.equal(elements.get("#collection-title").textContent, "Basic shapes");
  assert.deepEqual(historyCalls, ["/collections/advanced"]);
});

test("popstate rejects an invalid collection path without loading a saved collection", async () => {
  const { fetchImpl, calls } = createCollectionFetch();
  const { context, elements, firePopstate, historyCalls } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    promptResult: "Ada",
  });
  await context.readerTestApi.startReader();
  calls.length = 0;

  context.window.location.pathname = "/anything";
  await firePopstate();

  assert.deepEqual(calls, []);
  assert.equal(elements.get("#collection-title").textContent, "Basic shapes");
  assert.match(elements.get("#status-feedback").textContent, /invalid collection url/i);
  assert.deepEqual(historyCalls, []);
});

test("popstate waits for a pending save and then reconciles to the latest URL", async () => {
  const pendingSave = Promise.withResolvers();
  const { catalog, collections } = createCollectionFixture();
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push(path);
    if (path === "/api/collections") return response(catalog);
    if (path.startsWith("/api/collections/")) {
      return response(collections[decodeURIComponent(path.slice("/api/collections/".length))]);
    }
    if (path.startsWith("/api/progress?") && options.method === undefined) {
      return response({ problems: {} });
    }
    if (path === "/api/progress" && options.method === "PUT") {
      return pendingSave.promise;
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements, firePopstate } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    promptResult: "Ada",
  });
  await context.readerTestApi.startReader();

  const save = context.readerTestApi.setCurrentStatus("solved");
  context.window.location.pathname = "/collections/advanced";
  const historyLoad = firePopstate();

  assert.equal(calls.filter((path) => path === "/api/collections/advanced").length, 0);
  pendingSave.resolve(response({ problems: { "basic:1@1": { status: "solved" } } }));
  await Promise.all([save, historyLoad]);

  assert.equal(elements.get("#collection-title").textContent, "Advanced shapes");
  assert.equal(context.window.location.pathname, "/collections/advanced");
});

test("rapid popstate events discard a stale collection load and reconcile the latest URL", async () => {
  const pendingAdvanced = Promise.withResolvers();
  const { catalog, collections } = createCollectionFixture();
  const fetchImpl = async (path) => {
    if (path === "/api/collections") return response(catalog);
    if (path === "/api/collections/advanced") return pendingAdvanced.promise;
    if (path === "/api/collections/basic") return response(collections.basic);
    if (path.startsWith("/api/progress?")) return response({ problems: {} });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements, firePopstate, localStorage } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    promptResult: "Ada",
  });
  await context.readerTestApi.startReader();

  context.window.location.pathname = "/collections/advanced";
  const back = firePopstate();
  context.window.location.pathname = "/collections/basic";
  const forward = firePopstate();
  pendingAdvanced.resolve(response(collections.advanced));
  await Promise.all([back, forward]);

  assert.equal(elements.get("#collection-title").textContent, "Basic shapes");
  assert.equal(context.window.location.pathname, "/collections/basic");
  assert.equal(localStorage.get("static-go-reader-collection"), "basic");
});

test("popstate suppresses a stale chooser-load failure after loading the requested URL", async () => {
  const pendingAdvanced = Promise.withResolvers();
  const advancedRequested = Promise.withResolvers();
  const { catalog, collections } = createCollectionFixture();
  const fetchImpl = async (path) => {
    if (path === "/api/collections") return response(catalog);
    if (path === "/api/collections/advanced") {
      advancedRequested.resolve();
      return pendingAdvanced.promise;
    }
    if (path === "/api/collections/basic") return response(collections.basic);
    if (path.startsWith("/api/progress?")) return response({ problems: {} });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements, firePopstate } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    promptResult: "Ada",
  });
  await context.readerTestApi.startReader();

  const selection = context.readerTestApi.selectCollection("advanced");
  await advancedRequested.promise;
  context.window.location.pathname = "/collections/basic";
  const historyLoad = firePopstate();
  pendingAdvanced.reject(new Error("stale chooser failure"));
  await Promise.all([selection, historyLoad]);

  assert.equal(elements.get("#collection-title").textContent, "Basic shapes");
  assert.doesNotMatch(elements.get("#status-feedback").textContent, /stale chooser failure/i);
});

test("popstate suppresses a stale startup-load failure after loading the requested URL", async () => {
  const pendingBasic = Promise.withResolvers();
  const basicRequested = Promise.withResolvers();
  const { catalog, collections } = createCollectionFixture();
  const fetchImpl = async (path) => {
    if (path === "/api/collections") return response(catalog);
    if (path === "/api/collections/basic") {
      basicRequested.resolve();
      return pendingBasic.promise;
    }
    if (path === "/api/collections/advanced") return response(collections.advanced);
    if (path.startsWith("/api/progress?")) return response({ problems: {} });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements, firePopstate } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    promptResult: "Ada",
  });

  const startup = context.readerTestApi.startReader();
  await basicRequested.promise;
  context.window.location.pathname = "/collections/advanced";
  const historyLoad = firePopstate();
  pendingBasic.reject(new Error("stale startup failure"));
  await Promise.all([startup, historyLoad]);

  assert.equal(elements.get("#collection-title").textContent, "Advanced shapes");
  assert.doesNotMatch(elements.get("#status-feedback").textContent, /stale startup failure/i);
});

test("a catalog failure during popstate reports the error and settles reconciliation", async () => {
  const pendingCatalog = Promise.withResolvers();
  const catalogRequested = Promise.withResolvers();
  const fetchImpl = async (path) => {
    if (path === "/api/collections") {
      catalogRequested.resolve();
      return pendingCatalog.promise;
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements, firePopstate } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    promptResult: "Ada",
  });

  const startup = context.readerTestApi.startReader();
  await catalogRequested.promise;
  context.window.location.pathname = "/collections/advanced";
  let historySettled = false;
  const historyLoad = firePopstate().then(() => {
    historySettled = true;
  });
  pendingCatalog.reject(new Error("catalog unavailable"));
  await startup;
  await Promise.resolve();

  assert.equal(historySettled, true);
  assert.match(elements.get("#status-feedback").textContent, /catalog unavailable/i);
  assert.equal(elements.get("#change-collection").disabled, true);
  await historyLoad;
});

test("a failed history load restores the URL of the still-visible collection", async () => {
  const { catalog, collections } = createCollectionFixture();
  const fetchImpl = async (path) => {
    if (path === "/api/collections") return response(catalog);
    if (path === "/api/collections/basic") return response(collections.basic);
    if (path === "/api/collections/advanced") throw new Error("history load failed");
    if (path.startsWith("/api/progress?")) return response({ problems: {} });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements, firePopstate, historyReplaceCalls } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    promptResult: "Ada",
  });
  await context.readerTestApi.startReader();

  context.window.location.pathname = "/collections/advanced";
  await firePopstate();

  assert.equal(elements.get("#collection-title").textContent, "Basic shapes");
  assert.equal(context.window.location.pathname, "/collections/basic");
  assert.deepEqual(historyReplaceCalls, ["/collections/basic"]);
  assert.match(elements.get("#status-feedback").textContent, /history load failed/i);
});

test("the collection dialog traps focus, restores its invoker, and blocks reader arrows", async () => {
  const { fetchImpl } = createCollectionFetch();
  const { context, documentState, elements } = loadApp({
    fetchImpl,
    promptResult: "Ada",
    savedCollection: "basic",
  });
  await context.readerTestApi.startReader();
  const changeButton = elements.get("#change-collection");
  const closeButton = elements.get("#close-collection-panel");
  const [firstOption, secondOption] = elements
    .get("#collection-list")
    .appended.map((item) => item.appended[0]);
  changeButton.focus();

  context.readerTestApi.openCollectionPanel({ currentTarget: changeButton });

  assert.equal(documentState.activeElement, firstOption);
  const forwardTab = { key: "Tab", preventDefault() { this.prevented = true; } };
  context.readerTestApi.handleKeydown(forwardTab);
  assert.equal(forwardTab.prevented, true);
  assert.equal(documentState.activeElement, secondOption);

  context.readerTestApi.handleKeydown({ key: "Tab", preventDefault() {} });
  assert.equal(documentState.activeElement, closeButton);

  const backwardTab = { key: "Tab", shiftKey: true, preventDefault() { this.prevented = true; } };
  context.readerTestApi.handleKeydown(backwardTab);
  assert.equal(backwardTab.prevented, true);
  assert.equal(documentState.activeElement, secondOption);

  context.readerTestApi.handleKeydown({ key: "ArrowRight", preventDefault() {} });
  assert.equal(context.readerTestApi.getCurrentIndex(), 0);
  context.readerTestApi.handleKeydown({ key: "Escape", preventDefault() {} });
  assert.equal(elements.get("#collection-panel").hidden, true);
  assert.equal(documentState.activeElement, changeButton);
});

test("opening the collection dialog cancels a queued reader wheel navigation", async () => {
  const { fetchImpl } = createCollectionFetch();
  const { context, elements, flushTimers } = loadApp({
    fetchImpl,
    promptResult: "Ada",
    savedCollection: "basic",
  });
  await context.readerTestApi.startReader();
  const changeButton = elements.get("#change-collection");

  context.readerTestApi.queueReaderWheel();
  context.readerTestApi.openCollectionPanel({ currentTarget: changeButton });
  assert.equal(flushTimers(), 0);
  context.readerTestApi.navigate(1);

  assert.equal(context.readerTestApi.getCurrentIndex(), 0);
});

test("status actions are ignored while the collection dialog is open", async () => {
  let putCalls = 0;
  const baseFetch = createFetch();
  const fetchImpl = async (path, options = {}) => {
    if (path === "/api/progress" && options.method === "PUT") putCalls += 1;
    return baseFetch(path, options);
  };
  const { context, elements } = loadApp({ fetchImpl, promptResult: "Ada" });
  await context.readerTestApi.startReader();
  context.readerTestApi.openCollectionPanel({
    currentTarget: elements.get("#change-collection"),
  });

  await context.readerTestApi.setCurrentStatus("solved");

  assert.equal(putCalls, 0);
  assert.equal(context.readerTestApi.getCurrentIndex(), 0);
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
