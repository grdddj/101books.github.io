import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const appSource = await readFile(new URL("../reader/static/app.js", import.meta.url), "utf8");
const appCss = await readFile(new URL("../reader/static/app.css", import.meta.url), "utf8");

function createElement(documentState) {
  const listeners = new Map();
  return {
    addEventListener(event, listener) {
      listeners.set(event, listener);
    },
    appended: [],
    append(child) {
      this.appended.push(child);
    },
    attributes: {},
    classList: { toggle() {} },
    click() {
      listeners.get("click")?.({ currentTarget: this });
    },
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
  savedName = null,
  savedCollection = null,
  savedCategories = null,
  savedToken = "test-session-token",
  pathname = "/",
  serviceWorkerSupported = true,
  serviceWorkerFails = false,
  onLine = true,
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
  // A stored name without a token is no longer a session, so a signed-in
  // fixture needs both.
  const localStorage = new Map(
    [
      ["static-go-reader-user", savedName],
      ["static-go-reader-token", savedName === null ? null : savedToken],
      ["static-go-reader-collection", savedCollection],
      ["static-go-reader-categories", savedCategories],
    ].filter(([, value]) => value !== null),
  );
  const location = { pathname };
  const serviceWorkerRegistrations = [];
  const navigator = serviceWorkerSupported
    ? {
        onLine,
        serviceWorker: {
          async register(url, options) {
            if (serviceWorkerFails) throw new Error("registration blocked");
            serviceWorkerRegistrations.push({ url, options });
            return { scope: options?.scope };
          },
        },
      }
    : { onLine };
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
          if (
            selector === "#collection-panel" ||
            selector === "#activity-panel" ||
            selector === "#profile-panel" ||
            selector === "#modal-backdrop"
          ) {
            element.hidden = true;
          }
          elements.set(selector, element);
        }
        return elements.get(selector);
      },
    },
    encodeURIComponent,
    fetch: fetchImpl,
    navigator,
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
  getCurrentIndex: () => currentIndex,
  getSavedCollection: typeof getSavedCollection === "function" ? getSavedCollection : undefined,
  loadActiveCollection: typeof loadActiveCollection === "function" ? loadActiveCollection : undefined,
  navigate,
  openActivityPanel: typeof openActivityPanel === "function" ? openActivityPanel : undefined,
  openCollectionPanel: typeof openCollectionPanel === "function" ? openCollectionPanel : undefined,
  queueReaderWheel: () => handleWheel({ deltaY: 100, target: reader }),
  formatDuration: typeof formatDuration === "function" ? formatDuration : undefined,
  registerServiceWorker: typeof registerServiceWorker === "function" ? registerServiceWorker : undefined,
  openProfilePanel: typeof openProfilePanel === "function" ? openProfilePanel : undefined,
  closeProfilePanel: typeof closeProfilePanel === "function" ? closeProfilePanel : undefined,
  submitProfile: typeof submitProfile === "function" ? submitProfile : undefined,
  signOutProfile: typeof signOutProfile === "function" ? signOutProfile : undefined,
  getStoredUser: typeof getStoredUser === "function" ? getStoredUser : undefined,
  handleProfileNameInput: typeof handleProfileNameInput === "function" ? handleProfileNameInput : undefined,
  renderBoard,
  renderSolutionControl: typeof renderSolutionControl === "function" ? renderSolutionControl : undefined,
  toggleSolution: typeof toggleSolution === "function" ? toggleSolution : undefined,
  isSolutionShown: () => isSolutionShown,
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
    serviceWorkerRegistrations,
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

// Signing in is an HTTP call now, so every fixture that starts the reader needs
// to answer it.
function sessionResponse(path, options = {}, { known = ["Ada", "Grace"] } = {}) {
  if (!path.endsWith("/api/session") || options.method !== "POST") return null;
  const payload = JSON.parse(options.body);
  if (!known.includes(payload.user) && !payload.create) {
    return response({ error: "No profile with that name" }, 404);
  }
  if (payload.password === "wrong password") {
    return response({ error: "Incorrect password" }, 401);
  }
  return response({
    user: payload.user,
    token: `token-for-${payload.user}`,
    created: !known.includes(payload.user),
  });
}

function createProblems() {
  return Array.from({ length: 6 }, (_, index) => ({
    id: `problem-${index + 1}`,
    number: index + 1,
    black: ["aa"],
    white: [],
    solution: [{ color: "black", at: "bb" }],
  }));
}

function createFetch({ rejectPut = false, putNetworkError = false } = {}) {
  const problems = createProblems();
  return async (path, options = {}) => {
    const session = sessionResponse(path, options);
    if (session) return session;
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
    if (path === "/api/progress" && options.method === undefined) {
      return response({ problems: {} });
    }
    if (path === "/api/progress" && options.method === "PUT") {
      if (putNetworkError) throw networkError();
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
      if (path === "/api/progress") return response({ problems });
      throw new Error(`Unexpected request: ${path}`);
    },
  };
}

test("a collection URL selects its catalog entry on startup", async () => {
  const fetchImpl = createFetch();
  const { context, elements } = loadApp({
    fetchImpl,
    pathname: "/collections/test-collection",
    savedName: "Ada",
  });

  await context.readerTestApi.startReader();

  assert.equal(context.readerTestApi.getCollectionPath().slug, "test-collection");
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
    if (path === "/tsumego/api/progress") return response({ problems: {} });
    if (path === "/tsumego/api/progress" && options.method === "PUT") {
      return response({ problems: { "advanced:1@1": { status: "solved" } } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, historyCalls } = loadApp({
    basePath: "/tsumego",
    fetchImpl,
    pathname: "/tsumego/collections/basic",
    savedName: "Ada",
  });

  await context.readerTestApi.startReader();
  await context.readerTestApi.selectCollection("advanced");
  await context.readerTestApi.setCurrentStatus("solved");

  assert.deepEqual(calls, [
    ["/tsumego/api/collections", "GET"],
    ["/tsumego/api/collections/basic", "GET"],
    ["/tsumego/api/progress", "GET"],
    ["/tsumego/api/collections/advanced", "GET"],
    ["/tsumego/api/progress", "GET"],
    ["/tsumego/api/progress", "PUT"],
  ]);
  assert.deepEqual(historyCalls, ["/tsumego/collections/advanced/1"]);
  assert.equal(context.window.location.pathname, "/tsumego/collections/advanced/1");
});

test("the activity dialog loads base-prefixed recent events and restores keyboard focus", async () => {
  const calls = [];
  const activityResponse = Promise.withResolvers();
  const fetchImpl = async (path) => {
    calls.push(path);
    if (path === "/tsumego/api/collections") {
      return response([
        {
          slug: "basic",
          title: "Basic shapes",
          category: "tsumego",
          level: "20 kyu",
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
    if (path === "/tsumego/api/progress") return response({ problems: {} });
    if (path === "/tsumego/api/activity?limit=50") {
      return activityResponse.promise;
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const activityEvents = {
        events: [
          {
            timestamp: "2026-08-23T12:34:56Z",
            status: "solved",
            collection_title: "Basic shapes",
            problem_number: 1,
          },
          {
            timestamp: "2026-08-23T12:30:00Z",
            status: "revisit",
            collection_title: "Basic shapes",
            problem_number: 1,
          },
        ],
  };
  const { context, documentState, elements } = loadApp({
    basePath: "/tsumego",
    fetchImpl,
    pathname: "/tsumego/collections/basic",
    savedName: "Ada",
  });

  await context.readerTestApi.startReader();
  const activityButton = elements.get("#show-activity");
  activityButton.focus();
  const activityOpen = context.readerTestApi.openActivityPanel({ currentTarget: activityButton });

  const panel = elements.get("#activity-panel");
  const closeButton = elements.get("#close-activity-panel");
  assert.equal(elements.get("#modal-backdrop").hidden, false);
  assert.equal(panel.hidden, false);
  assert.equal(activityButton.attributes["aria-expanded"], "true");
  assert.equal(documentState.activeElement, closeButton);
  assert.equal(activityButton.disabled, true);
  assert.equal(elements.get("#activity-empty").textContent, "Loading activity…");
  assert.deepEqual(calls.at(-1), "/tsumego/api/activity?limit=50");
  activityResponse.resolve(response(activityEvents));
  await activityOpen;
  assert.deepEqual(
    elements.get("#activity-list").appended.map((item) => item.textContent),
    [
      `Solved · Basic shapes · Problem 1 · ${new Date("2026-08-23T12:34:56Z").toLocaleString()}`,
      `Revisit · Basic shapes · Problem 1 · ${new Date("2026-08-23T12:30:00Z").toLocaleString()}`,
    ],
  );

  const tab = { key: "Tab", preventDefault() { this.prevented = true; } };
  context.readerTestApi.handleKeydown(tab);
  assert.equal(tab.prevented, true);
  assert.equal(documentState.activeElement, closeButton);
  context.readerTestApi.handleKeydown({ key: "ArrowRight", preventDefault() {} });
  assert.equal(context.readerTestApi.getCurrentIndex(), 0);
  context.readerTestApi.handleKeydown({ key: "Escape", preventDefault() {} });
  assert.equal(panel.hidden, true);
  assert.equal(elements.get("#modal-backdrop").hidden, true);
  assert.equal(documentState.activeElement, activityButton);

  await context.readerTestApi.openActivityPanel({ currentTarget: activityButton });
  closeButton.click();
  assert.equal(panel.hidden, true);
  assert.equal(elements.get("#modal-backdrop").hidden, true);
  assert.equal(documentState.activeElement, activityButton);
});

test("an unknown collection URL reports an error without loading the first catalog entry", async () => {
  const { fetchImpl, calls } = createCollectionFetch();
  const { context, elements } = loadApp({
    fetchImpl,
    pathname: "/collections/missing",
    savedName: "Ada",
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
  assert.equal(context.window.location.pathname, "/collections/basic/1");
});

test("only the root and one collection segment are valid reader paths", () => {
  const root = loadApp({ pathname: "/", savedName: "Ada" });
  assert.equal(root.context.readerTestApi.getCollectionPath().kind, "root");

  const collection = loadApp({ pathname: "/collections/test-collection", savedName: "Ada" });
  assert.equal(collection.context.readerTestApi.getCollectionPath().kind, "collection");
  assert.equal(collection.context.readerTestApi.getCollectionPath().slug, "test-collection");
  assert.equal(collection.context.readerTestApi.getCollectionPath().number, undefined);

  const numbered = loadApp({ pathname: "/collections/test-collection/130", savedName: "Ada" });
  assert.equal(numbered.context.readerTestApi.getCollectionPath().kind, "collection");
  assert.equal(numbered.context.readerTestApi.getCollectionPath().slug, "test-collection");
  assert.equal(numbered.context.readerTestApi.getCollectionPath().number, 130);

  const invalidPaths = [
    "/collections/missing/",
    "/collections/",
    "/anything",
    "/collections/%E0%A4",
    "/collections/basic/1/2",
    "/collections/basic/last",
    "/collections/basic/-1",
    "/collections/basic/",
  ];
  for (const pathname of invalidPaths) {
    const { context } = loadApp({ pathname, savedName: "Ada" });
    assert.equal(context.readerTestApi.getCollectionPath().kind, "invalid", pathname);
  }
});

test("an invalid initial path reports an error without loading the saved collection", async () => {
  const invalidPaths = [
    "/collections/missing/",
    "/collections/",
    "/anything",
    "/collections/%E0%A4",
    "/collections/basic/last",
  ];
  for (const pathname of invalidPaths) {
    const { fetchImpl, calls } = createCollectionFetch();
    const { context, elements } = loadApp({
      fetchImpl,
      pathname,
      savedName: "Ada",
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
      assert.equal(context.window.location.pathname, "/collections/basic/1");
    }
  }
});

test("a problem number in the URL opens that problem instead of the first pending one", async () => {
  const { fetchImpl } = createCollectionFetch();
  const { context, elements, historyReplaceCalls } = loadApp({
    fetchImpl,
    pathname: "/collections/advanced/3",
    savedName: "Ada",
  });

  await context.readerTestApi.startReader();

  assert.equal(elements.get("#collection-title").textContent, "Advanced shapes");
  assert.equal(context.readerTestApi.getCurrentIndex(), 2);
  assert.equal(elements.get("#problem-ordinal").textContent, "Problem 3 of 3");
  // The URL already names the problem, so startup has nothing to normalise.
  assert.deepEqual(historyReplaceCalls, []);
});

test("a problem number outside the collection reports an error and loads nothing", async () => {
  const { fetchImpl } = createCollectionFetch();
  const { context, elements } = loadApp({
    fetchImpl,
    pathname: "/collections/advanced/4",
    savedName: "Ada",
  });

  await context.readerTestApi.startReader();

  assert.equal(elements.get("#collection-title").textContent, "");
  assert.match(elements.get("#status-feedback").textContent, /problem 4 is not in this collection/i);
  assert.equal(elements.get("#change-collection").disabled, false);
});

test("navigating rewrites the URL in place so the current problem can be shared", async () => {
  const { fetchImpl } = createCollectionFetch();
  const { context, historyCalls, historyReplaceCalls } = loadApp({
    fetchImpl,
    pathname: "/collections/advanced/1",
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();

  context.readerTestApi.navigate(1);
  context.readerTestApi.navigate(1);
  context.readerTestApi.navigate(1);

  assert.equal(context.window.location.pathname, "/collections/advanced/3");
  assert.deepEqual(historyReplaceCalls, ["/collections/advanced/2", "/collections/advanced/3"]);
  assert.deepEqual(historyCalls, []);
});

test("Back returns to the problem the URL named, not the first pending one", async () => {
  const { fetchImpl } = createCollectionFetch();
  const { context, elements, firePopstate } = loadApp({
    fetchImpl,
    pathname: "/collections/advanced/3",
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();
  await context.readerTestApi.selectCollection("basic");

  context.window.location.pathname = "/collections/advanced/3";
  await firePopstate();

  assert.equal(elements.get("#collection-title").textContent, "Advanced shapes");
  assert.equal(context.readerTestApi.getCurrentIndex(), 2);
});

test("a valid saved collection is loaded after the catalog and resumes at the first unseen problem", async () => {
  // Flagging problem 2 must not drag the resume position back to it: that cost
  // is the reason Revisit went unused.
  const { fetchImpl, calls } = createCollectionFetch({
    problems: {
      "advanced:1@1": { status: "solved" },
      "advanced:2@1": { status: "revisit" },
    },
  });
  const { context, elements, localStorage } = loadApp({
    fetchImpl,
    savedName: "Ada",
    savedCollection: "advanced",
  });

  await context.readerTestApi.startReader();

  assert.deepEqual(calls, [
    "/api/collections",
    "/api/collections/advanced",
    "/api/progress",
  ]);
  assert.equal(localStorage.get("static-go-reader-collection"), "advanced");
  assert.equal(elements.get("#collection-title").textContent, "Advanced shapes");
  assert.equal(context.readerTestApi.getCurrentIndex(), 2);
});

test("a booklet with nothing left unseen resumes at the first flagged problem", async () => {
  // Once the pass is over, the flags become the drill list.
  const { fetchImpl } = createCollectionFetch({
    problems: {
      "advanced:1@1": { status: "solved" },
      "advanced:2@1": { status: "revisit" },
      "advanced:3@1": { status: "solved" },
    },
  });
  const { context } = loadApp({ fetchImpl, savedName: "Ada", savedCollection: "advanced" });

  await context.readerTestApi.startReader();

  assert.equal(context.readerTestApi.getCurrentIndex(), 1);
});

test("a fully solved booklet reopens at its first problem", async () => {
  const { fetchImpl } = createCollectionFetch({
    problems: {
      "advanced:1@1": { status: "solved" },
      "advanced:2@1": { status: "solved" },
      "advanced:3@1": { status: "solved" },
    },
  });
  const { context } = loadApp({ fetchImpl, savedName: "Ada", savedCollection: "advanced" });

  await context.readerTestApi.startReader();

  assert.equal(context.readerTestApi.getCurrentIndex(), 0);
});

test("an invalid saved collection falls back to the first API-sorted catalog entry", async () => {
  const { fetchImpl, catalog } = createCollectionFetch();
  const { context, elements, localStorage } = loadApp({
    fetchImpl,
    savedName: "Ada",
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

function collectionFetchWithThreeTypes() {
  const fetch = createCollectionFetch();
  fetch.catalog.push({
    slug: "endgame",
    title: "Endgame shapes",
    category: "endgame",
    level: "5 kyu",
    problem_count: 4,
  });
  return fetch;
}

function collectionTitles(elements) {
  return elements
    .get("#collection-list")
    .appended.map((item) => item.appended[0].appended[0].textContent.split(" \u00b7 ")[0]);
}

function filterButtons(elements) {
  return elements.get("#collection-filters").appended;
}

test("the collection panel offers one filter per type, counted", async () => {
  const { fetchImpl } = collectionFetchWithThreeTypes();
  const { context, elements } = loadApp({
    fetchImpl,
    savedName: "Ada",
    savedCollection: "basic",
  });

  await context.readerTestApi.startReader();

  assert.deepEqual(
    filterButtons(elements).map((button) => button.textContent),
    ["All types (3)", "endgame (1)", "life and death (1)", "tsumego (1)"],
  );
  // Nothing chosen is the whole shelf, which is what "All types" reports.
  assert.deepEqual(
    filterButtons(elements).map((button) => button.attributes["aria-pressed"]),
    ["true", "false", "false", "false"],
  );
  assert.deepEqual(collectionTitles(elements), [
    "Basic shapes",
    "Advanced shapes",
    "Endgame shapes",
  ]);
});

test("chosen types narrow the collection list and combine", async () => {
  const { fetchImpl } = collectionFetchWithThreeTypes();
  const { context, elements, localStorage } = loadApp({
    fetchImpl,
    savedName: "Ada",
    savedCollection: "basic",
  });

  await context.readerTestApi.startReader();
  filterButtons(elements)[3].click();

  assert.deepEqual(collectionTitles(elements), ["Basic shapes"]);
  assert.equal(localStorage.get("static-go-reader-categories"), "tsumego");

  filterButtons(elements)[1].click();

  assert.deepEqual(collectionTitles(elements), ["Basic shapes", "Endgame shapes"]);
  assert.deepEqual(
    filterButtons(elements).map((button) => button.attributes["aria-pressed"]),
    ["false", "true", "false", "true"],
  );

  filterButtons(elements)[3].click();

  assert.deepEqual(collectionTitles(elements), ["Endgame shapes"]);
});

test("All types clears every chosen type in one press", async () => {
  const { fetchImpl } = collectionFetchWithThreeTypes();
  const { context, elements, localStorage } = loadApp({
    fetchImpl,
    savedName: "Ada",
    savedCollection: "basic",
    savedCategories: "endgame,tsumego",
  });

  await context.readerTestApi.startReader();

  assert.deepEqual(collectionTitles(elements), ["Basic shapes", "Endgame shapes"]);

  filterButtons(elements)[0].click();

  assert.deepEqual(collectionTitles(elements), [
    "Basic shapes",
    "Advanced shapes",
    "Endgame shapes",
  ]);
  assert.equal(localStorage.get("static-go-reader-categories"), "");
});

test("a stored type the catalog no longer offers is dropped", async () => {
  const { fetchImpl } = createCollectionFetch();
  const { context, elements } = loadApp({
    fetchImpl,
    savedName: "Ada",
    savedCollection: "basic",
    savedCategories: "joseki",
  });

  await context.readerTestApi.startReader();

  assert.deepEqual(collectionTitles(elements), ["Basic shapes", "Advanced shapes"]);
  assert.equal(filterButtons(elements)[0].attributes["aria-pressed"], "true");
});

test("pressing a filter keeps focus on it and reaches the panel focus trap", async () => {
  const { fetchImpl } = collectionFetchWithThreeTypes();
  const { context, elements, documentState } = loadApp({
    fetchImpl,
    savedName: "Ada",
    savedCollection: "basic",
  });

  await context.readerTestApi.startReader();
  context.readerTestApi.openCollectionPanel();
  filterButtons(elements)[3].click();

  assert.equal(documentState.activeElement.attributes["data-collection-category"], "tsumego");

  context.readerTestApi.handleKeydown({ key: "Tab", preventDefault() {} });

  assert.notEqual(documentState.activeElement, null);
});

test("the collection list shows progress states and solved percentages", async () => {
  const problems = {
    "advanced:1@1": { status: "revisit" },
    "partial:1@1": { status: "solved" },
    "thirds:1@1": { status: "solved" },
    "complete:1@1": { status: "solved" },
    "complete:2@1": { status: "solved" },
  };
  const { fetchImpl, catalog } = createCollectionFetch({ problems });
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
    {
      slug: "almost-complete",
      title: "Almost complete shapes",
      category: "tesuji",
      level: "4 kyu",
      problem_count: 200,
    },
  );
  for (let problem = 1; problem <= 199; problem += 1) {
    problems[`almost-complete:${problem}@1`] = { status: "solved" };
  }
  const { context, elements } = loadApp({
    fetchImpl,
    savedName: "Ada",
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
  assert.equal(options[5].className, "collection-option collection-option--partial");
  assert.equal(options[0].style["--collection-progress"], "0%");
  assert.equal(options[1].style["--collection-progress"], "0%");
  assert.equal(options[2].style["--collection-progress"], "25%");
  assert.equal(options[3].style["--collection-progress"], "33.33333333333333%");
  assert.equal(options[4].style["--collection-progress"], "100%");
  assert.equal(options[5].style["--collection-progress"], "99.5%");
  assert.match(options[0].appended[0].textContent, /Solved: 0 \(0%\)/);
  assert.match(options[1].appended[0].textContent, /Solved: 0 \(0%\)/);
  assert.match(options[2].appended[0].textContent, /Solved: 1 \(25%\)/);
  assert.match(options[3].appended[0].textContent, /Solved: 1 \(33%\)/);
  assert.match(options[4].appended[0].textContent, /Solved: 2 \(100%\)/);
  assert.match(options[5].appended[0].textContent, /Solved: 199 \(99%\)/);
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
    savedName: "Ada",
    savedCollection: "basic",
  });
  await context.readerTestApi.startReader();
  elements.get("#collection-panel").hidden = false;

  await context.readerTestApi.selectCollection("advanced");

  assert.equal(localStorage.get("static-go-reader-collection"), "advanced");
  // Problem 2 is flagged and problem 3 has never been seen, so the booklet
  // opens at 3: the flag waits until the pass is finished.
  assert.deepEqual(historyCalls, ["/collections/advanced/3"]);
  assert.equal(elements.get("#collection-panel").hidden, true);
  assert.equal(elements.get("#collection-title").textContent, "Advanced shapes");
  assert.equal(elements.get("#progress-summary").textContent, "Solved: 1 · Revisit: 1 · Total: 3");
  assert.equal(context.readerTestApi.getCurrentIndex(), 2);
});

test("popstate loads the current collection URL without adding a history entry", async () => {
  const { fetchImpl } = createCollectionFetch();
  const { context, elements, firePopstate, historyCalls } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();
  await context.readerTestApi.selectCollection("advanced");

  context.window.location.pathname = "/collections/basic";
  await firePopstate();

  assert.equal(elements.get("#collection-title").textContent, "Basic shapes");
  assert.deepEqual(historyCalls, ["/collections/advanced/1"]);
});

test("popstate rejects an invalid collection path without loading a saved collection", async () => {
  const { fetchImpl, calls } = createCollectionFetch();
  const { context, elements, firePopstate, historyCalls } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    savedName: "Ada",
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
    if (path === "/api/progress" && options.method === undefined) {
      return response({ problems: {} });
    }
    if (path === "/api/progress" && options.method === "PUT") {
      return pendingSave.promise;
    }
    if (path === "/api/progress") return response({ problems: {} });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements, firePopstate } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();

  const save = context.readerTestApi.setCurrentStatus("solved");
  context.window.location.pathname = "/collections/advanced";
  const historyLoad = firePopstate();

  assert.equal(calls.filter((path) => path === "/api/collections/advanced").length, 0);
  pendingSave.resolve(response({ problems: { "basic:1@1": { status: "solved" } } }));
  await Promise.all([save, historyLoad]);

  assert.equal(elements.get("#collection-title").textContent, "Advanced shapes");
  assert.equal(context.window.location.pathname, "/collections/advanced/1");
});

test("rapid popstate events discard a stale collection load and reconcile the latest URL", async () => {
  const pendingAdvanced = Promise.withResolvers();
  const { catalog, collections } = createCollectionFixture();
  const fetchImpl = async (path) => {
    if (path === "/api/collections") return response(catalog);
    if (path === "/api/collections/advanced") return pendingAdvanced.promise;
    if (path === "/api/collections/basic") return response(collections.basic);
    if (path === "/api/progress") return response({ problems: {} });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements, firePopstate, localStorage } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();

  context.window.location.pathname = "/collections/advanced";
  const back = firePopstate();
  context.window.location.pathname = "/collections/basic";
  const forward = firePopstate();
  pendingAdvanced.resolve(response(collections.advanced));
  await Promise.all([back, forward]);

  assert.equal(elements.get("#collection-title").textContent, "Basic shapes");
  assert.equal(context.window.location.pathname, "/collections/basic/1");
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
    if (path === "/api/progress") return response({ problems: {} });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements, firePopstate } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    savedName: "Ada",
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
    if (path === "/api/progress") return response({ problems: {} });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements, firePopstate } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    savedName: "Ada",
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
    savedName: "Ada",
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
    if (path === "/api/progress") return response({ problems: {} });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements, firePopstate, historyReplaceCalls } = loadApp({
    fetchImpl,
    pathname: "/collections/basic",
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();

  context.window.location.pathname = "/collections/advanced";
  await firePopstate();

  assert.equal(elements.get("#collection-title").textContent, "Basic shapes");
  assert.equal(context.window.location.pathname, "/collections/basic/1");
  // The first replace is startup normalising the URL to a problem, the second
  // is the failed Back being rolled back to it.
  assert.deepEqual(historyReplaceCalls, ["/collections/basic/1", "/collections/basic/1"]);
  assert.match(elements.get("#status-feedback").textContent, /history load failed/i);
});

test("the collection dialog traps focus, restores its invoker, and blocks reader arrows", async () => {
  const { fetchImpl } = createCollectionFetch();
  const { context, documentState, elements } = loadApp({
    fetchImpl,
    savedName: "Ada",
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
    savedName: "Ada",
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
  const { context, elements } = loadApp({ fetchImpl, savedName: "Ada" });
  await context.readerTestApi.startReader();
  context.readerTestApi.openCollectionPanel({
    currentTarget: elements.get("#change-collection"),
  });

  await context.readerTestApi.setCurrentStatus("solved");

  assert.equal(putCalls, 0);
  assert.equal(context.readerTestApi.getCurrentIndex(), 0);
});

test("an invalid stored name is discarded rather than used", () => {
  const { context, localStorage } = loadApp({ savedName: " ".repeat(81) });

  assert.equal(context.readerTestApi.getStoredUser(), null);
  assert.equal(localStorage.has("static-go-reader-user"), false);
});

test("a name entered in the dialog is normalized before it is stored", async () => {
  const { context, elements, localStorage } = loadApp({ fetchImpl: createFetch() });
  const started = context.readerTestApi.startReader();

  // The reader is mid-load at this point, which must not stop it asking.
  assert.equal(elements.get("#profile-panel").hidden, false);
  assert.equal(elements.get("#profile-signout").hidden, true);

  elements.get("#profile-name").value = "  Ada  ";
  elements.get("#profile-password").value = "correct horse battery";
  await context.readerTestApi.submitProfile();
  await started;

  assert.equal(localStorage.get("static-go-reader-user"), "Ada");
  assert.equal(localStorage.get("static-go-reader-token"), "token-for-Ada");
  assert.equal(elements.get("#profile").textContent, "Ada");
});

test("signing in without a password is refused before any request", async () => {
  const requests = [];
  const inner = createFetch();
  const { context, elements } = loadApp({
    fetchImpl: async (path, options = {}) => {
      requests.push(path);
      return inner(path, options);
    },
  });
  context.readerTestApi.startReader();

  elements.get("#profile-name").value = "Ada";
  await context.readerTestApi.submitProfile();

  assert.equal(elements.get("#profile-panel").hidden, false);
  assert.match(elements.get("#profile-error").textContent, /password/i);
  assert.equal(requests.filter((path) => path.endsWith("/api/session")).length, 0);
});

test("closing the sign-in dialog without a name explains why nothing loads", async () => {
  const { context, elements, localStorage } = loadApp({ fetchImpl: createFetch(), savedName: " " });
  const started = context.readerTestApi.startReader();

  context.readerTestApi.closeProfilePanel();
  await started;

  assert.equal(localStorage.has("static-go-reader-user"), false);
  assert.match(elements.get("#status-feedback").textContent, /valid name is required/i);
});

test("a crop that is not the board's edge keeps two free lines", () => {
  const { context } = loadApp({ savedName: "Ada" });
  const cropFor = (problem) =>
    JSON.parse(JSON.stringify(context.readerTestApi.getBoardCrop(problem)));

  // One free line was indistinguishable from a stone on the second line of a
  // real edge, so a cut stops two lines past the last stone.
  assert.deepEqual(cropFor({ black: ["ii"], white: ["jj"] }), {
    minColumn: 6,
    maxColumn: 11,
    minRow: 6,
    maxRow: 11,
    columns: 6,
    rows: 6,
    leftAtEdge: false,
    rightAtEdge: false,
    topAtEdge: false,
    bottomAtEdge: false,
  });
});

test("specialized training in tesuji 4 problem 7 does not claim the board's width", () => {
  const { context } = loadApp({ savedName: "Ada" });
  // The reported bug: the position sits in the bottom-left corner, but the crop
  // stopped one column past the rightmost stone, so the right-hand side read as
  // the board's edge and the shape looked hemmed in with nowhere to run.
  const crop = context.readerTestApi.getBoardCrop({
    black: ["cr", "dr", "er", "es", "fq", "gq", "gr", "is", "hp", "go", "io", "cp", "cq"],
    white: ["br", "bq", "bp", "co", "do", "dp", "dq", "eq", "fr", "fs", "gs", "hs", "hr", "hq", "ir"],
  });

  assert.equal(crop.leftAtEdge, true);
  assert.equal(crop.bottomAtEdge, true);
  assert.equal(crop.rightAtEdge, false);
  assert.equal(crop.topAtEdge, false);
  // Rightmost stone is on column i (8); the crop reaches k (10).
  assert.equal(crop.maxColumn, 10);
  assert.equal(crop.maxColumn - 8, 2);
});

test("specialized training in tesuji 4 problem 13 does not claim the board's width", () => {
  const { context } = loadApp({ savedName: "Ada" });
  const crop = context.readerTestApi.getBoardCrop({
    black: ["cq", "cr", "ep", "fp", "fq", "fo", "do", "bo", "bq", "dq"],
    white: ["dr", "fr", "er", "eq", "gp", "gq", "eo", "co", "cp", "dp", "bp"],
  });

  assert.equal(crop.leftAtEdge, true);
  assert.equal(crop.bottomAtEdge, true);
  assert.equal(crop.rightAtEdge, false);
  // Rightmost stone is on column g (6); the crop reaches i (8).
  assert.equal(crop.maxColumn, 8);
  // The top is a cut too, and gets the same two lines.
  assert.equal(crop.topAtEdge, false);
  assert.equal(14 - crop.minRow, 2);
});

test("a crop that stops within three lines of a side is pulled out to it", () => {
  const { context } = loadApp({ savedName: "Ada" });
  const cropFor = (problem) =>
    JSON.parse(JSON.stringify(context.readerTestApi.getBoardCrop(problem)));

  // Specialized training in capturing races, problem 33: the wall stands on
  // column d, so the margin used to stop at column c and the group read as if
  // it were already against the left side. Two lines were missing.
  const capturingRace = {
    black: ["dp", "do", "dn", "em", "fm", "dl", "eq", "fq", "gq", "fp", "gp", "hp", "fr", "fs", "gs"],
    white: ["dq", "ep", "eo", "fo", "go", "ho", "ip", "hq", "hr", "gr", "hs", "ir"],
  };
  const race = cropFor(capturingRace);
  assert.equal(race.minColumn, 0);
  assert.equal(race.leftAtEdge, true);
  assert.equal(race.maxRow, 18);
  assert.equal(race.bottomAtEdge, true);

  // Every side is decided on its own, so a lone corner stone shows both edges
  // and two free lines on each of the two sides that are cuts.
  assert.deepEqual(cropFor({ black: ["cc"], white: [] }), {
    minColumn: 0,
    maxColumn: 4,
    minRow: 0,
    maxRow: 4,
    columns: 5,
    rows: 5,
    leftAtEdge: true,
    rightAtEdge: false,
    topAtEdge: true,
    bottomAtEdge: false,
  });
  assert.deepEqual(cropFor({ black: ["qq"], white: [] }), {
    minColumn: 14,
    maxColumn: 18,
    minRow: 14,
    maxRow: 18,
    columns: 5,
    rows: 5,
    leftAtEdge: false,
    rightAtEdge: true,
    topAtEdge: false,
    bottomAtEdge: true,
  });
});

test("a crop far from every side is cut on all four", () => {
  const { context } = loadApp({ savedName: "Ada" });

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.readerTestApi.getBoardCrop({ black: ["ee"], white: [] }))),
    {
      minColumn: 2,
      maxColumn: 6,
      minRow: 2,
      maxRow: 6,
      columns: 5,
      rows: 5,
      leftAtEdge: false,
      rightAtEdge: false,
      topAtEdge: false,
      bottomAtEdge: false,
    },
  );
});

test("grid lines stop at a real edge and run off a cut", () => {
  const { context, elements } = loadApp({ savedName: "Ada" });
  const extents = (problem) => {
    context.readerTestApi.renderBoard(problem);
    const lines = elements
      .get("#board")
      .appended.find((element) => element.className === "goban-grid").appended;
    const first = (kind) => lines.find((line) => line.className.includes(kind)).attributes;
    const vertical = first("vertical");
    const horizontal = first("horizontal");
    return {
      top: Number(vertical.y1),
      bottom: Number(vertical.y2),
      left: Number(horizontal.x1),
      right: Number(horizontal.x2),
    };
  };

  // A stone in the top-left corner: both edges are real, both far sides are cut.
  const corner = extents({ black: ["aa"], white: [] });
  assert.equal(corner.top, 0.5);
  assert.equal(corner.left, 0.5);
  const crop = context.readerTestApi.getBoardCrop({ black: ["aa"], white: [] });
  assert.equal(corner.bottom, crop.rows);
  assert.equal(corner.right, crop.columns);

  // Clear of every side, every line runs off.
  const floating = extents({ black: ["jj"], white: [] });
  assert.equal(floating.top, 0);
  assert.equal(floating.left, 0);
});

test("board stones use grid positions relative to the crop", () => {
  const { context, elements } = loadApp({ savedName: "Ada" });

  context.readerTestApi.renderBoard({ black: ["jj"], white: [] });

  const board = elements.get("#board");
  const blackStone = board.appended.find((stone) => stone.className === "stone black");
  assert.equal(board.style["--board-columns"], 5);
  assert.equal(board.style["--board-rows"], 5);
  assert.equal(blackStone.style.gridColumn, 3);
  assert.equal(blackStone.style.gridRow, 3);
});

test("rectangular crops set matching dimensions and keep grid intervals square", () => {
  const { context, elements } = loadApp({ savedName: "Ada" });

  context.readerTestApi.renderBoard({ black: ["be", "hh"], white: [] });

  const board = elements.get("#board");
  assert.equal(board.style["--board-columns"], 10);
  assert.equal(board.style["--board-rows"], 8);
  assert.match(
    appCss,
    /aspect-ratio:\s*var\(--board-columns\)\s*\/\s*var\(--board-rows\);/,
  );
});

test("board creates one explicit grid line for every crop row and column", () => {
  const { context, elements } = loadApp({ savedName: "Ada" });

  context.readerTestApi.renderBoard({ black: ["be", "hh"], white: [] });

  const grid = elements
    .get("#board")
    .appended.find((element) => element.className === "goban-grid");
  const gridLines = grid.appended;
  assert.equal(
    gridLines.filter((line) => line.className.includes("vertical")).length,
    10,
  );
  assert.equal(
    gridLines.filter((line) => line.className.includes("horizontal")).length,
    8,
  );
});

test("the solution crop widens only once the solution is on screen", () => {
  const { context } = loadApp({ savedName: "Ada" });
  // Away from every side, so the crop is the margin alone and the widening is
  // the only thing this measures.
  const problem = {
    black: ["jj"],
    white: [],
    solution: [{ color: "black", at: "jn" }],
  };
  const crop = (showSolution) =>
    JSON.parse(JSON.stringify(context.readerTestApi.getBoardCrop(problem, showSolution)));

  // Sizing the board for the moves up front would say which way they run.
  assert.equal(crop(false).rows, 5);
  assert.equal(crop(true).rows, 9);
});

test("the solution numbers its moves in order and alternates the colours", () => {
  const { context, elements } = loadApp({ savedName: "Ada" });

  context.readerTestApi.renderBoard(
    {
      black: ["dd"],
      white: [],
      solution: [
        { color: "black", at: "ed" },
        { color: "white", at: "fd" },
        { color: "black", at: "gd" },
      ],
    },
    true,
  );

  const numbered = elements
    .get("#board")
    .appended.filter((element) => String(element.className).includes("stone--numbered"));
  assert.deepEqual(
    numbered.map((stone) => [stone.className, stone.textContent]),
    [
      ["stone black stone--numbered", "1"],
      ["stone white stone--numbered", "2"],
      ["stone black stone--numbered", "3"],
    ],
  );
});

test("a move replayed on an earlier point is captioned rather than hidden", () => {
  const { context, elements } = loadApp({ savedName: "Ada" });

  context.readerTestApi.renderBoard(
    {
      black: ["dd"],
      white: [],
      // Move 3 recaptures at the point of move 1.
      solution: [
        { color: "black", at: "ed" },
        { color: "white", at: "fd" },
        { color: "black", at: "ed" },
      ],
    },
    true,
  );

  const numbered = elements
    .get("#board")
    .appended.filter((element) => String(element.className).includes("stone--numbered"));
  assert.deepEqual(numbered.map((stone) => stone.textContent), ["1", "2"]);
  assert.equal(elements.get("#solution-note").textContent, "3 at 1");
  assert.equal(elements.get("#solution-note").hidden, false);
});

test("a solution move takes over the point of an opening stone it captured", () => {
  const { context, elements } = loadApp({ savedName: "Ada" });

  context.readerTestApi.renderBoard(
    { black: [], white: ["ed"], solution: [{ color: "black", at: "ed" }] },
    true,
  );

  const stones = elements
    .get("#board")
    .appended.filter((element) => String(element.className).startsWith("stone"));
  assert.deepEqual(
    stones.map((stone) => [stone.className, stone.textContent]),
    [["stone black stone--numbered", "1"]],
  );
});

test("hiding the solution leaves the opening position exactly as it was", () => {
  const { context, elements } = loadApp({ savedName: "Ada" });
  const problem = {
    black: ["dd"],
    white: [],
    solution: [{ color: "white", at: "ed" }],
  };

  context.readerTestApi.renderBoard(problem, false);

  const board = elements.get("#board");
  assert.deepEqual(
    board.appended
      .filter((element) => String(element.className).startsWith("stone"))
      .map((stone) => stone.className),
    ["stone black"],
  );
  assert.equal(elements.get("#solution-note").hidden, true);
});

test("the solution is put away again when the problem changes", async () => {
  const { context, elements } = loadApp({ fetchImpl: createFetch(), savedName: "Ada" });
  await context.readerTestApi.startReader();

  context.readerTestApi.toggleSolution();
  assert.equal(context.readerTestApi.isSolutionShown(), true);
  assert.equal(elements.get("#show-solution").textContent, "Hide solution");

  context.readerTestApi.navigate(1);

  assert.equal(context.readerTestApi.isSolutionShown(), false);
  assert.equal(elements.get("#show-solution").textContent, "Show solution");
});

test("a problem with no recorded solution cannot be revealed", async () => {
  const problems = createProblems().map((problem) => ({ ...problem, solution: [] }));
  const fetchImpl = async (path, options = {}) => {
    const session = sessionResponse(path, options);
    if (session) return session;
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
    if (path === "/api/progress") return response({ problems: {} });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements } = loadApp({ fetchImpl, savedName: "Ada" });
  await context.readerTestApi.startReader();

  assert.equal(elements.get("#show-solution").disabled, true);
  context.readerTestApi.toggleSolution();
  assert.equal(context.readerTestApi.isSolutionShown(), false);
});

test("successful status saves advance one problem without passing the final problem", async () => {
  const { context, elements } = loadApp({ fetchImpl: createFetch(), savedName: "Ada" });
  await context.readerTestApi.startReader();
  context.readerTestApi.navigate(4);

  await context.readerTestApi.setCurrentStatus("solved");
  assert.equal(context.readerTestApi.getCurrentIndex(), 5);

  await context.readerTestApi.setCurrentStatus("revisit");
  assert.equal(context.readerTestApi.getCurrentIndex(), 5);
  // A successful save clears the line rather than narrating itself; it exists
  // to carry problems, and a stale error must not outlive the save that fixed it.
  assert.equal(elements.get("#status-feedback").textContent, "");
  assert.equal(elements.get("#revisit").attributes["aria-pressed"], "true");
});

test("an already-solved problem shows an inert Already solved button", async () => {
  const { context, elements } = loadApp({ fetchImpl: createFetch(), savedName: "Ada" });
  await context.readerTestApi.startReader();

  const solved = elements.get("#solved");
  assert.equal(solved.textContent, "Solved");
  assert.equal(solved.disabled, false);

  await context.readerTestApi.setCurrentStatus("solved");
  context.readerTestApi.navigate(-1);

  assert.equal(context.readerTestApi.getCurrentIndex(), 0);
  assert.equal(solved.textContent, "Already solved");
  assert.equal(solved.disabled, true);
  assert.equal(solved.attributes["aria-pressed"], "true");

  // Orange, and at full opacity: the disabled treatment would fade it into
  // looking broken rather than settled.
  assert.match(appCss, /#solved\.is-selected[^{]*{[^}]*background:\s*#e08a1e;/);
  assert.match(appCss, /#solved\.is-selected:disabled[^{]*{[^}]*opacity:\s*1;/);

  context.readerTestApi.navigate(1);
  assert.equal(solved.textContent, "Solved");
  assert.equal(solved.disabled, false);
});

test("marking an already-solved problem again is ignored", async () => {
  const calls = [];
  const inner = createFetch();
  const fetchImpl = async (path, options = {}) => {
    calls.push([path, options.method ?? "GET"]);
    return inner(path, options);
  };
  const { context } = loadApp({ fetchImpl, savedName: "Ada" });
  await context.readerTestApi.startReader();

  await context.readerTestApi.setCurrentStatus("solved");
  context.readerTestApi.navigate(-1);
  const before = calls.length;
  await context.readerTestApi.setCurrentStatus("solved");

  assert.equal(calls.length, before);
  assert.equal(context.readerTestApi.getCurrentIndex(), 0);
});

test("a successful save clears an error left by the previous one", async () => {
  let failNext = true;
  const inner = createFetch();
  const fetchImpl = async (path, options = {}) => {
    if (path === "/api/progress" && options.method === "PUT" && failNext) {
      failNext = false;
      throw new Error("save failed");
    }
    return inner(path, options);
  };
  const { context, elements } = loadApp({ fetchImpl, savedName: "Ada" });
  await context.readerTestApi.startReader();

  await context.readerTestApi.setCurrentStatus("revisit");
  assert.equal(elements.get("#status-feedback").textContent, "save failed");

  await context.readerTestApi.setCurrentStatus("revisit");
  assert.equal(elements.get("#status-feedback").textContent, "");
});

test("failed status saves do not change the current problem", async () => {
  const { context } = loadApp({
    fetchImpl: createFetch({ rejectPut: true }),
    savedName: "Ada",
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
    const session = sessionResponse(path, options);
    if (session) return session;
    if (path === "/api/collections") {
      return response([{ slug: "test-collection", title: "Test collection", category: "tsumego", level: "20 kyu", problem_count: problems.length }]);
    }
    if (path === "/api/collections/test-collection") {
      return response({ slug: "test-collection", title: "Test collection", problems });
    }
    if (path === "/api/progress" && options.method === "PUT") {
      putCalls += 1;
      return pendingSave.promise;
    }
    if (path === "/api/progress") return response({ problems: {} });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements } = loadApp({ fetchImpl, savedName: "Ada" });
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
    const session = sessionResponse(path, options);
    if (session) return session;
    if (path === "/api/collections") {
      return response([{ slug: "test-collection", title: "Test collection", category: "tsumego", level: "20 kyu", problem_count: problems.length }]);
    }
    if (path === "/api/collections/test-collection") {
      return response({ slug: "test-collection", title: "Test collection", problems });
    }
    if (path === "/api/progress" && options.method === "PUT") return pendingSave.promise;
    if (path === "/api/progress") return response({ problems: {} });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements } = loadApp({ fetchImpl, savedName: "Ada" });
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

test("registers the service worker below the configured base path", () => {
  const { serviceWorkerRegistrations } = loadApp({
    basePath: "/tsumego",
    fetchImpl: createFetch(),
    savedName: "tester",
  });

  assert.equal(serviceWorkerRegistrations.length, 1);
  assert.equal(serviceWorkerRegistrations[0].url, "/tsumego/sw.js");
  assert.equal(serviceWorkerRegistrations[0].options.scope, "/tsumego/");
});

test("registers the service worker at the root when no base path is configured", () => {
  const { serviceWorkerRegistrations } = loadApp({
    fetchImpl: createFetch(),
    savedName: "tester",
  });

  assert.equal(serviceWorkerRegistrations.length, 1);
  assert.equal(serviceWorkerRegistrations[0].url, "/sw.js");
  assert.equal(serviceWorkerRegistrations[0].options.scope, "/");
});

test("starts without a service worker when the browser does not support one", () => {
  const { serviceWorkerRegistrations } = loadApp({
    fetchImpl: createFetch(),
    savedName: "tester",
    serviceWorkerSupported: false,
  });

  assert.deepEqual(serviceWorkerRegistrations, []);
});

test("keeps running when service worker registration is rejected", async () => {
  const { context, serviceWorkerRegistrations } = loadApp({
    fetchImpl: createFetch(),
    savedName: "tester",
    serviceWorkerFails: true,
  });

  assert.equal(await context.readerTestApi.registerServiceWorker(), undefined);
  assert.deepEqual(serviceWorkerRegistrations, []);
});

function networkError() {
  const error = new Error("Failed to fetch");
  error.name = "TypeError";
  return error;
}

test("reports an offline message when the catalog cannot be loaded", async () => {
  const { context, elements } = loadApp({
    fetchImpl: async () => {
      throw networkError();
    },
    savedName: "Ada",
    onLine: false,
  });

  await context.readerTestApi.startReader();

  assert.equal(elements.get("#status-feedback").textContent, "You appear to be offline.");
});

test("reports an offline message when a save cannot reach the server", async () => {
  const { context, elements } = loadApp({
    fetchImpl: createFetch({ putNetworkError: true }),
    savedName: "Ada",
    onLine: false,
  });
  await context.readerTestApi.startReader();

  await context.readerTestApi.setCurrentStatus("solved");

  assert.equal(
    elements.get("#status-feedback").textContent,
    "You appear to be offline. Progress was not saved.",
  );
});

test("distinguishes an unreachable server from a disconnected device", async () => {
  const { context, elements } = loadApp({
    fetchImpl: createFetch({ putNetworkError: true }),
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();

  await context.readerTestApi.setCurrentStatus("solved");

  assert.equal(
    elements.get("#status-feedback").textContent,
    "Could not reach the server. Progress was not saved.",
  );
});

test("keeps server-side error messages instead of reporting a connection problem", async () => {
  const { context, elements } = loadApp({
    fetchImpl: createFetch({ rejectPut: true }),
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();

  await context.readerTestApi.setCurrentStatus("solved");

  assert.equal(elements.get("#status-feedback").textContent, "save failed");
});

test("formats durations as seconds, and as minutes past a minute", () => {
  const { context } = loadApp({ fetchImpl: createFetch(), savedName: "tester" });
  const { formatDuration } = context.readerTestApi;

  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(7), "7s");
  assert.equal(formatDuration(59), "59s");
  assert.equal(formatDuration(60), "1m 00s");
  assert.equal(formatDuration(125), "2m 05s");
  // Events recorded before timing existed carry no duration at all.
  assert.equal(formatDuration(undefined), "");
  assert.equal(formatDuration(-1), "");
});

test("sends the time spent on a problem with the status change", async () => {
  const requests = [];
  const inner = createFetch();
  const { context } = loadApp({
    fetchImpl: async (path, options = {}) => {
      if (options.method === "PUT") requests.push(JSON.parse(options.body));
      return inner(path, options);
    },
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();

  await context.readerTestApi.setCurrentStatus("solved");

  assert.equal(requests.length, 1);
  assert.equal(typeof requests[0].duration_seconds, "number");
  assert.ok(requests[0].duration_seconds >= 0);
});

test("shows the recorded duration in the activity list", async () => {
  const events = [
    {
      timestamp: "2026-08-23T12:34:56Z",
      status: "solved",
      collection_title: "Basic shapes",
      problem_number: 1,
      duration_seconds: 93,
    },
    // Recorded before timing existed, so it carries no duration.
    {
      timestamp: "2026-08-23T12:30:00Z",
      status: "revisit",
      collection_title: "Basic shapes",
      problem_number: 1,
    },
  ];
  const fetchImpl = async (path) => {
    if (path === "/api/collections") {
      return response([
        { slug: "basic", title: "Basic shapes", category: "tsumego", level: "20 kyu", problem_count: 1 },
      ]);
    }
    if (path === "/api/collections/basic") {
      return response({
        slug: "basic",
        title: "Basic shapes",
        problems: [{ id: "basic:1@1", number: 1, black: ["aa"], white: [] }],
      });
    }
    if (path === "/api/progress") return response({ problems: {} });
    if (path === "/api/activity?limit=50") return response({ events });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { context, elements } = loadApp({ fetchImpl, savedName: "Ada" });
  await context.readerTestApi.startReader();

  await context.readerTestApi.openActivityPanel();

  assert.deepEqual(
    elements.get("#activity-list").appended.map((item) => item.textContent),
    [
      `Solved · Basic shapes · Problem 1 · ${new Date("2026-08-23T12:34:56Z").toLocaleString()} · 1m 33s`,
      `Revisit · Basic shapes · Problem 1 · ${new Date("2026-08-23T12:30:00Z").toLocaleString()}`,
    ],
  );
});

test("shows the signed-in name in the header", async () => {
  const { context, elements } = loadApp({ fetchImpl: createFetch(), savedName: "Ada" });

  await context.readerTestApi.startReader();

  assert.equal(elements.get("#profile").textContent, "Ada");
  assert.match(elements.get("#profile").attributes["aria-label"], /Signed in as Ada/);
});

test("the dialog opens with the current name and an escape route", async () => {
  const { context, elements } = loadApp({ fetchImpl: createFetch(), savedName: "Ada" });
  await context.readerTestApi.startReader();

  context.readerTestApi.openProfilePanel();

  assert.equal(elements.get("#profile-panel").hidden, false);
  assert.equal(elements.get("#profile-name").value, "Ada");
  assert.equal(elements.get("#profile-signout").hidden, false);
  assert.equal(elements.get("#modal-backdrop").hidden, false);
});

test("saving another name reloads that profile's progress", async () => {
  const requested = [];
  const inner = createFetch();
  const { context, elements, localStorage } = loadApp({
    fetchImpl: async (path, options = {}) => {
      if (path === "/api/progress" && options.method === undefined) requested.push(path);
      return inner(path, options);
    },
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();
  requested.length = 0;

  context.readerTestApi.openProfilePanel();
  elements.get("#profile-name").value = "Grace";
  elements.get("#profile-password").value = "correct horse battery";
  await context.readerTestApi.submitProfile();

  assert.equal(elements.get("#profile").textContent, "Grace");
  assert.equal(localStorage.get("static-go-reader-user"), "Grace");
  assert.deepEqual(requested, ["/api/progress"]);
  assert.equal(elements.get("#profile-panel").hidden, true);
});

test("an empty name is refused without closing the dialog", async () => {
  const { context, elements, localStorage } = loadApp({
    fetchImpl: createFetch(),
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();

  context.readerTestApi.openProfilePanel();
  elements.get("#profile-name").value = "   ";
  await context.readerTestApi.submitProfile();

  assert.equal(elements.get("#profile-panel").hidden, false);
  assert.equal(elements.get("#profile-error").hidden, false);
  assert.match(elements.get("#profile-error").textContent, /1 to 80/);
  assert.equal(localStorage.get("static-go-reader-user"), "Ada");
});

test("signing out clears the name and keeps the dialog open to sign in again", async () => {
  const { context, elements, localStorage } = loadApp({
    fetchImpl: createFetch(),
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();

  context.readerTestApi.openProfilePanel();
  context.readerTestApi.signOutProfile();

  assert.equal(localStorage.has("static-go-reader-user"), false);
  assert.equal(elements.get("#profile-panel").hidden, false);
  assert.equal(elements.get("#profile-name").value, "");
  assert.equal(elements.get("#profile-signout").hidden, true);
  assert.equal(elements.get("#profile").textContent, "Sign in");

  elements.get("#profile-name").value = "Grace";
  elements.get("#profile-password").value = "correct horse battery";
  await context.readerTestApi.submitProfile();

  assert.equal(localStorage.get("static-go-reader-user"), "Grace");
  assert.equal(elements.get("#profile").textContent, "Grace");
  assert.equal(elements.get("#profile-panel").hidden, true);
});

test("a mistyped name offers to create rather than creating silently", async () => {
  const attempts = [];
  const inner = createFetch();
  const { context, elements, localStorage } = loadApp({
    fetchImpl: async (path, options = {}) => {
      if (path.endsWith("/api/session")) attempts.push(JSON.parse(options.body));
      return inner(path, options);
    },
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();

  context.readerTestApi.openProfilePanel();
  elements.get("#profile-name").value = "Grase";
  elements.get("#profile-password").value = "correct horse battery";
  await context.readerTestApi.submitProfile();

  // Nothing was created; the reader asks first.
  assert.deepEqual(attempts.map((attempt) => attempt.create), [false]);
  assert.equal(elements.get("#profile-panel").hidden, false);
  assert.equal(elements.get("#profile-create").hidden, false);
  assert.match(elements.get("#profile-error").textContent, /No profile called/);
  assert.equal(localStorage.get("static-go-reader-user"), "Ada");

  await context.readerTestApi.submitProfile(undefined, { create: true });

  assert.deepEqual(attempts.map((attempt) => attempt.create), [false, true]);
  assert.equal(localStorage.get("static-go-reader-user"), "Grase");
});

test("correcting the name withdraws the offer to create the mistyped one", async () => {
  const { context, elements } = loadApp({ fetchImpl: createFetch(), savedName: "Ada" });
  await context.readerTestApi.startReader();

  context.readerTestApi.openProfilePanel();
  elements.get("#profile-name").value = "Grase";
  elements.get("#profile-password").value = "correct horse battery";
  await context.readerTestApi.submitProfile();
  assert.equal(elements.get("#profile-create").hidden, false);

  elements.get("#profile-name").value = "Grace";
  context.readerTestApi.handleProfileNameInput();

  assert.equal(elements.get("#profile-create").hidden, true);
});

test("a wrong password is reported without signing anyone out", async () => {
  const { context, elements, localStorage } = loadApp({
    fetchImpl: createFetch(),
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();

  context.readerTestApi.openProfilePanel();
  elements.get("#profile-name").value = "Grace";
  elements.get("#profile-password").value = "wrong password";
  await context.readerTestApi.submitProfile();

  assert.equal(elements.get("#profile-panel").hidden, false);
  assert.match(elements.get("#profile-error").textContent, /Incorrect password/);
  assert.equal(localStorage.get("static-go-reader-user"), "Ada");
});

test("requests carry the session token", async () => {
  const seen = [];
  const inner = createFetch();
  const { context } = loadApp({
    fetchImpl: async (path, options = {}) => {
      if (path === "/api/progress") seen.push(options.headers?.Authorization);
      return inner(path, options);
    },
    savedName: "Ada",
    savedToken: "token-for-Ada",
  });

  await context.readerTestApi.startReader();

  assert.deepEqual(seen, ["Bearer token-for-Ada"]);
});

test("signing out discards the token as well as the name", async () => {
  const { context, localStorage } = loadApp({ fetchImpl: createFetch(), savedName: "Ada" });
  await context.readerTestApi.startReader();

  context.readerTestApi.openProfilePanel();
  context.readerTestApi.signOutProfile();

  assert.equal(localStorage.has("static-go-reader-user"), false);
  assert.equal(localStorage.has("static-go-reader-token"), false);
});

test("signing out tells the server before discarding the token", async () => {
  const calls = [];
  const inner = createFetch();
  const { context } = loadApp({
    fetchImpl: async (path, options = {}) => {
      if (path.endsWith("/api/session") && options.method === "DELETE") {
        calls.push(options.headers?.Authorization);
        return response({ signed_out: true });
      }
      return inner(path, options);
    },
    savedName: "Ada",
    savedToken: "token-for-Ada",
  });
  await context.readerTestApi.startReader();

  context.readerTestApi.openProfilePanel();
  context.readerTestApi.signOutProfile();

  assert.deepEqual(calls, ["Bearer token-for-Ada"]);
});

test("an unreachable server does not block signing out", async () => {
  const inner = createFetch();
  const { context, localStorage } = loadApp({
    fetchImpl: async (path, options = {}) => {
      if (path.endsWith("/api/session") && options.method === "DELETE") {
        throw new TypeError("Failed to fetch");
      }
      return inner(path, options);
    },
    savedName: "Ada",
  });
  await context.readerTestApi.startReader();

  context.readerTestApi.openProfilePanel();
  context.readerTestApi.signOutProfile();

  assert.equal(localStorage.has("static-go-reader-token"), false);
  assert.equal(localStorage.has("static-go-reader-user"), false);
});
