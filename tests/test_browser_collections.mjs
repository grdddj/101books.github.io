import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { findChromium } from "./chromium.mjs";

const execFileAsync = promisify(execFile);
const indexSource = await readFile(new URL("../reader/static/index.html", import.meta.url), "utf8");
const appSource = await readFile(new URL("../reader/static/app.js", import.meta.url), "utf8");
const appCss = await readFile(new URL("../reader/static/app.css", import.meta.url), "utf8");

const chromium = await findChromium();

// A profile without a session token lands on the sign-in dialog and the reader
// never starts, so every page these tests drive has to look already signed in.
function signedInSeed() {
  return `localStorage.setItem("static-go-reader-user", "Ada");
    localStorage.setItem("static-go-reader-token", "test-session-token");`;
}

function response(reply, statusCode, body, contentType = "application/json; charset=utf-8") {
  reply.writeHead(statusCode, { "Content-Type": contentType });
  reply.end(body);
}

function browserPage(basePath = "") {
  const seed = `<script>${signedInSeed()}</script>`;
  const probe = `
    <pre id="browser-collections-result"></pre>
    <script>
      async function waitFor(condition) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Timed out waiting for reader state");
      }

      window.addEventListener("load", async () => {
        const result = document.querySelector("#browser-collections-result");
        try {
          await waitFor(() => document.querySelector("#collection-title").textContent === "200 Basic Go Problems");
          const changeButton = document.querySelector("#change-collection");
          const reader = document.querySelector("#app");
          const ordinalBeforeQueuedWheel = document.querySelector("#problem-ordinal").textContent;
          reader.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
          changeButton.focus();
          changeButton.click();
          await new Promise((resolve) => setTimeout(resolve, 200));
          const queuedWheelBlocked = document.querySelector("#problem-ordinal").textContent === ordinalBeforeQueuedWheel;
          const panel = document.querySelector("#collection-panel");
          const options = [...document.querySelectorAll("[data-collection-slug]")];
          const visibleCatalog = options.map((option) => option.textContent);
          const panelOpened = !panel.hidden;
          const dispatchKey = (key, shiftKey = false) => document.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, shiftKey }),
          );
          const focusEntered = document.activeElement === options[0];
          dispatchKey("Tab");
          const forwardTabTrapped = document.activeElement === options[1];
          dispatchKey("Tab");
          const forwardWrapTrapped = document.activeElement === document.querySelector("#close-collection-panel");
          dispatchKey("Tab", true);
          const backwardTabTrapped = document.activeElement === options[1];
          const ordinalBeforeArrow = document.querySelector("#problem-ordinal").textContent;
          dispatchKey("ArrowRight");
          const readerBlocked = document.querySelector("#problem-ordinal").textContent === ordinalBeforeArrow;
          reader.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, deltaY: 100 }),
          );
          await new Promise((resolve) => setTimeout(resolve, 200));
          const wheelBlocked = document.querySelector("#problem-ordinal").textContent === ordinalBeforeArrow;
          dispatchKey("Escape");
          const escapeRestoredFocus = panel.hidden && document.activeElement === changeButton;
          changeButton.click();
          document.querySelector("#close-collection-panel").click();
          const closeRestoredFocus = panel.hidden && document.activeElement === changeButton;
          changeButton.click();
          options[1].click();
          await waitFor(() => document.querySelector("#collection-title").textContent === "Advanced shapes");
          const selectedPathname = window.location.pathname;
          const selectedCollection = localStorage.getItem("static-go-reader-collection");
          const selectedProgress = document.querySelector("#progress-summary").textContent;
          const selectionRestoredFocus = document.activeElement === changeButton;
          history.back();
          await waitFor(() => document.querySelector("#collection-title").textContent === "200 Basic Go Problems");
          const restoredTitle = document.querySelector("#collection-title").textContent;
          const restoredPathname = window.location.pathname;
          await waitFor(() => !document.querySelector("#next").disabled);
          document.querySelector("#next").click();
          result.textContent = JSON.stringify({
            panelOpened,
            visibleCatalog,
            queuedWheelBlocked,
            focusEntered,
            forwardTabTrapped,
            forwardWrapTrapped,
            backwardTabTrapped,
            readerBlocked,
            wheelBlocked,
            escapeRestoredFocus,
            closeRestoredFocus,
            selectedPathname,
            restoredTitle,
            restoredPathname,
            selectedCollection,
            progress: selectedProgress,
            selectionRestoredFocus,
            nextOrdinal: document.querySelector("#problem-ordinal").textContent,
            nextPathname: window.location.pathname,
          });
        } catch (error) {
          result.textContent = JSON.stringify({ error: error.message });
        }
      });
    </script>`;
  return indexSource
    .replaceAll("__READER_BASE_PATH__", basePath)
    .replace(
      `<script>window.READER_BASE_PATH = "${basePath}";</script>`,
      `${seed}<script>window.READER_BASE_PATH = "${basePath}";</script>`,
    )
    .replace("</body>", `${probe}</body>`);
}

function invalidCollectionBrowserPage() {
  const seed = `<script>
    ${signedInSeed()}
    localStorage.setItem("static-go-reader-collection", "advanced");
  </script>`;
  const probe = `
    <pre id="browser-invalid-collection-result"></pre>
    <script>
      async function waitFor(condition) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Timed out waiting for reader state");
      }

      window.addEventListener("load", async () => {
        const result = document.querySelector("#browser-invalid-collection-result");
        try {
          await waitFor(() => /invalid collection url/i.test(
            document.querySelector("#status-feedback").textContent,
          ));
          const initialTitle = document.querySelector("#collection-title").textContent;
          const changeButton = document.querySelector("#change-collection");
          const options = [...document.querySelectorAll("[data-collection-slug]")];
          const chooserEnabled = !changeButton.disabled && options.every((option) => !option.disabled);
          changeButton.click();
          options[0].click();
          await waitFor(() => document.querySelector("#collection-title").textContent === "200 Basic Go Problems");
          result.textContent = JSON.stringify({
            initialTitle,
            chooserEnabled,
            optionCount: options.length,
            recoveredTitle: document.querySelector("#collection-title").textContent,
            recoveredPathname: window.location.pathname,
          });
        } catch (error) {
          result.textContent = JSON.stringify({ error: error.message });
        }
      });
    </script>`;
  return indexSource
    .replaceAll("__READER_BASE_PATH__", "")
    .replace(
      '<script>window.READER_BASE_PATH = "";</script>',
      `${seed}<script>window.READER_BASE_PATH = "";</script>`,
    )
    .replace("</body>", `${probe}</body>`);
}

function activityBrowserPage(basePath = "") {
  const seed = `<script>${signedInSeed()}</script>`;
  const probe = `
    <pre id="browser-activity-result"></pre>
    <script>
      async function waitFor(condition) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Timed out waiting for reader state");
      }

      window.addEventListener("load", async () => {
        const result = document.querySelector("#browser-activity-result");
        try {
          await waitFor(() => document.querySelector("#collection-title").textContent === "200 Basic Go Problems");
          const activityButton = document.querySelector("#show-activity");
          const ordinalBeforeArrow = document.querySelector("#problem-ordinal").textContent;
          activityButton.focus();
          activityButton.click();
          await waitFor(() => document.querySelector("#activity-list").children.length === 2);
          const panel = document.querySelector("#activity-panel");
          const backdrop = document.querySelector("#modal-backdrop");
          const closeButton = document.querySelector("#close-activity-panel");
          const activityEntries = [...document.querySelectorAll("#activity-list li")].map((item) => item.textContent);
          const panelOpened = !panel.hidden && activityButton.getAttribute("aria-expanded") === "true";
          const backdropVisible = !backdrop.hidden;
          const focusEntered = document.activeElement === closeButton;
          document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" }));
          const tabTrapped = document.activeElement === closeButton;
          document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }));
          const readerBlocked = document.querySelector("#problem-ordinal").textContent === ordinalBeforeArrow;
          closeButton.click();
          result.textContent = JSON.stringify({
            panelOpened,
            backdropVisible,
            focusEntered,
            tabTrapped,
            readerBlocked,
            closeRestoredFocus: panel.hidden && backdrop.hidden && document.activeElement === activityButton,
            activityHasTimestamp: activityEntries[0].includes(new Date("2026-08-23T12:34:56Z").toLocaleString()),
            activityEntries,
            readOnly: document.querySelectorAll("#activity-panel button").length === 1,
          });
        } catch (error) {
          result.textContent = JSON.stringify({ error: error.message });
        }
      });
    </script>`;
  return indexSource
    .replaceAll("__READER_BASE_PATH__", basePath)
    .replace(
      `<script>window.READER_BASE_PATH = "${basePath}";</script>`,
      `${seed}<script>window.READER_BASE_PATH = "${basePath}";</script>`,
    )
    .replace("</body>", `${probe}</body>`);
}

async function startReaderServer(progressPath, basePath = "") {
  const path = (suffix) => `${basePath}${suffix}`;
  const activityRequests = [];
  const files = {
    [path("/")]: [browserPage(basePath), "text/html; charset=utf-8"],
    [path("/collections/")]: [invalidCollectionBrowserPage(), "text/html; charset=utf-8"],
    [path("/collections/200-basic-go-problems")]: [
      browserPage(basePath),
      "text/html; charset=utf-8",
    ],
    [path("/app.js")]: [appSource, "text/javascript; charset=utf-8"],
    [path("/app.css")]: [appCss, "text/css; charset=utf-8"],
  };
  const catalog = [
    {
      slug: "200-basic-go-problems",
      title: "200 Basic Go Problems",
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
    "200-basic-go-problems": {
      slug: "200-basic-go-problems",
      title: "200 Basic Go Problems",
      problems: [
        { id: "200-basic-go-problems:1@1", number: 1, black: ["aa"], white: [] },
        { id: "200-basic-go-problems:2@1", number: 2, black: ["bb"], white: [] },
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
  const server = createServer(async (request, reply) => {
    const requestUrl = request.url;
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (
      pathname === path("/collections/200-basic-go-problems") &&
      new URL(request.url, "http://127.0.0.1").searchParams.has("activity")
    ) {
      response(reply, 200, activityBrowserPage(basePath), "text/html; charset=utf-8");
      return;
    }
    if (files[pathname]) {
      const [body, contentType] = files[pathname];
      response(reply, 200, body, contentType);
      return;
    }
    if (pathname === path("/api/collections")) {
      response(reply, 200, JSON.stringify(catalog));
      return;
    }
    if (pathname.startsWith(path("/api/collections/"))) {
      const collection = collections[decodeURIComponent(pathname.slice(path("/api/collections/").length))];
      response(reply, collection ? 200 : 404, JSON.stringify(collection ?? { error: "Unknown collection" }));
      return;
    }
    if (pathname === path("/api/progress")) {
      response(reply, 200, await readFile(progressPath, "utf8"));
      return;
    }
    if (pathname === path("/api/activity")) {
      activityRequests.push(requestUrl);
      response(
        reply,
        200,
        JSON.stringify({
          events: [
            {
              timestamp: "2026-08-23T12:34:56Z",
              status: "solved",
              collection_title: "200 Basic Go Problems",
              problem_number: 1,
            },
            {
              timestamp: "2026-08-23T12:30:00Z",
              status: "revisit",
              collection_title: "Advanced shapes",
              problem_number: 2,
            },
          ],
        }),
      );
      return;
    }
    response(reply, 404, "Not found", "text/plain; charset=utf-8");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    server,
    activityRequests,
    activityUrl: `http://127.0.0.1:${port}${path("/collections/200-basic-go-problems")}?activity`,
    url: `http://127.0.0.1:${port}${path("/collections/200-basic-go-problems")}`,
    invalidUrl: `http://127.0.0.1:${port}${path("/collections/")}`,
  };
}

test("Chromium loads a collection URL and restores it with browser Back", { skip: !chromium }, async () => {
  const directory = await mkdtemp(join(process.cwd(), ".go-reader-collections-"));
  const progressPath = join(directory, "progress.json");
  await writeFile(
    progressPath,
    JSON.stringify({
      problems: {
        "200-basic-go-problems:2@1": { status: "solved" },
        "advanced:1@1": { status: "solved" },
        "advanced:2@1": { status: "revisit" },
      },
    }),
  );
  const { server, url } = await startReaderServer(progressPath);
  try {
    const { stdout } = await execFileAsync(chromium, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      "--virtual-time-budget=4000",
      url,
    ]);
    const match = stdout.match(/<pre id="browser-collections-result">([^<]*)<\/pre>/);
    assert.ok(match, "Chromium did not return the collection test result");
    assert.deepEqual(JSON.parse(match[1]), {
      panelOpened: true,
      visibleCatalog: [
        "200 Basic Go Problems · 20 kyu · tsumego · 2 problems · Solved: 1 (50%) · Revisit: 0",
        "Advanced shapes · 1 dan · life and death · 3 problems · Solved: 1 (33%) · Revisit: 1",
      ],
      queuedWheelBlocked: true,
      focusEntered: true,
      forwardTabTrapped: true,
      forwardWrapTrapped: true,
      backwardTabTrapped: true,
      readerBlocked: true,
      wheelBlocked: true,
      escapeRestoredFocus: true,
      closeRestoredFocus: true,
      selectedPathname: "/collections/advanced/2",
      restoredTitle: "200 Basic Go Problems",
      restoredPathname: "/collections/200-basic-go-problems/1",
      selectedCollection: "advanced",
      progress: "Solved: 1 · Revisit: 1 · Total: 3",
      selectionRestoredFocus: true,
      nextOrdinal: "Problem 2 of 2",
      nextPathname: "/collections/200-basic-go-problems/2",
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { force: true, recursive: true });
  }
});

test("Chromium keeps collection navigation inside a configured base path", { skip: !chromium }, async () => {
  const directory = await mkdtemp(join(process.cwd(), ".go-reader-base-path-"));
  const progressPath = join(directory, "progress.json");
  await writeFile(progressPath, JSON.stringify({ problems: {} }));
  const { server, url } = await startReaderServer(progressPath, "/tsumego");
  try {
    const { stdout } = await execFileAsync(chromium, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      "--virtual-time-budget=4000",
      url,
    ]);
    const match = stdout.match(/<pre id="browser-collections-result">([^<]*)<\/pre>/);
    assert.ok(match, "Chromium did not return the base-path test result");
    const result = JSON.parse(match[1]);
    assert.equal(result.selectedPathname, "/tsumego/collections/advanced/1");
    assert.equal(
      result.restoredPathname,
      "/tsumego/collections/200-basic-go-problems/1",
    );
    assert.equal(result.nextPathname, "/tsumego/collections/200-basic-go-problems/2");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { force: true, recursive: true });
  }
});

test("Chromium opens and closes the read-only activity dialog below a base path", { skip: !chromium }, async () => {
  const directory = await mkdtemp(join(process.cwd(), ".go-reader-activity-"));
  const progressPath = join(directory, "progress.json");
  await writeFile(progressPath, JSON.stringify({ problems: {} }));
  const { activityRequests, activityUrl, server } = await startReaderServer(
    progressPath,
    "/tsumego",
  );
  try {
    const { stdout } = await execFileAsync(chromium, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      "--virtual-time-budget=4000",
      activityUrl,
    ]);
    const match = stdout.match(/<pre id="browser-activity-result">([^<]*)<\/pre>/);
    assert.ok(match, "Chromium did not return the activity test result");
    const result = JSON.parse(match[1]);
    assert.deepEqual(activityRequests, ["/tsumego/api/activity?limit=50"]);
    assert.equal(result.panelOpened, true);
    assert.equal(result.backdropVisible, true);
    assert.equal(result.focusEntered, true);
    assert.equal(result.tabTrapped, true);
    assert.equal(result.readerBlocked, true);
    assert.equal(result.closeRestoredFocus, true);
    assert.equal(result.activityHasTimestamp, true);
    assert.equal(result.readOnly, true);
    assert.equal(result.activityEntries.length, 2);
    assert.match(result.activityEntries[0], /^Solved · 200 Basic Go Problems · Problem 1 · /);
    assert.match(result.activityEntries[1], /^Revisit · Advanced shapes · Problem 2 · /);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { force: true, recursive: true });
  }
});

test("Chromium recovers from the direct invalid collection route", { skip: !chromium }, async () => {
  const directory = await mkdtemp(join(process.cwd(), ".go-reader-invalid-collection-"));
  const progressPath = join(directory, "progress.json");
  await writeFile(progressPath, JSON.stringify({ problems: {} }));
  const { server, invalidUrl } = await startReaderServer(progressPath);
  try {
    const { stdout } = await execFileAsync(chromium, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      "--virtual-time-budget=4000",
      invalidUrl,
    ]);
    const match = stdout.match(
      /<pre id="browser-invalid-collection-result">([^<]*)<\/pre>/,
    );
    assert.ok(match, "Chromium did not return the invalid-route recovery result");
    assert.deepEqual(JSON.parse(match[1]), {
      initialTitle: "Go problem reader",
      chooserEnabled: true,
      optionCount: 2,
      recoveredTitle: "200 Basic Go Problems",
      recoveredPathname: "/collections/200-basic-go-problems/1",
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { force: true, recursive: true });
  }
});
