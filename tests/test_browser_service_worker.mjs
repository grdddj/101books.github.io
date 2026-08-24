// The service worker has twice shipped a bug that no unit test could see: once
// serving a blank page offline, once pinning a stale app.css forever. Both are
// only observable in a real browser with a real Cache Storage, so these tests
// drive one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const cssPath = join(repositoryRoot, "reader/static/app.css");

async function findPlaywright() {
  const require = createRequire(import.meta.url);
  for (const base of [import.meta.url, `file://${process.env.HOME}/package.json`]) {
    try {
      return createRequire(base)("playwright");
    } catch {
      // Fall through to the next resolution root.
    }
  }
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

const playwright = await findPlaywright();
const skip = playwright ? false : "playwright is not installed";

async function waitForHealth(base) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${base}healthz`)).ok) return;
    } catch {
      // The reader scans every booklet before it listens.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("reader never became healthy");
}

// Runs the reader from a throwaway directory so a test may rewrite app.css
// without touching the checkout, which is also the live deployment.
async function withReader(port, run) {
  const root = await mkdtemp(join(tmpdir(), "reader-sw-"));
  await writeFile(join(root, ".keep"), "");
  const { symlink, cp } = await import("node:fs/promises");
  await cp(join(repositoryRoot, "reader"), join(root, "reader"), { recursive: true });
  await symlink(join(repositoryRoot, "books"), join(root, "books"));
  await symlink(join(repositoryRoot, "problems"), join(root, "problems"));

  const base = `http://127.0.0.1:${port}/tsumego/`;
  const server = spawn(
    "python3",
    ["-m", "reader.server", "--host", "127.0.0.1", "--port", String(port),
     "--base-path", "/tsumego", "--data-dir", join(root, "data")],
    { cwd: root, stdio: "ignore" },
  );
  try {
    await waitForHealth(base);
    const browser = await playwright.chromium.launch();
    try {
      await run({ base, root, browser, server });
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

async function openReader(browser, base) {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 30000 });

  // A first visit signs in through the reader's own dialog. Creating the
  // profile is a deliberate second step, so the create button appears first.
  await page.waitForSelector("#profile-panel", { state: "visible" });
  await page.fill("#profile-name", "swtester");
  await page.fill("#profile-password", "correct horse battery");
  await page.click("#profile-save");
  await page.waitForSelector("#profile-create", { state: "visible" });
  await page.click("#profile-create");

  await page.waitForFunction(
    () => document.querySelector("#problem-ordinal")?.textContent?.includes("Problem"),
    { timeout: 30000 },
  );
  return { context, page };
}

test("a deployed stylesheet reaches a browser that already installed the worker", { skip }, async () => {
  await withReader(8211, async ({ base, root, browser }) => {
    const deployedCss = await readFile(cssPath, "utf8");
    // replaceAll, not replace: the green is used by more than one rule now, and
    // swapping only the first left #solved untouched.
    const olderCss = deployedCss.replaceAll("#1f7a4d", "#abcdef");
    const servedCss = join(root, "reader/static/app.css");
    await writeFile(servedCss, olderCss);

    const { context, page } = await openReader(browser, base);
    const before = await page.evaluate(() => getComputedStyle(document.querySelector("#solved")).backgroundColor);
    assert.equal(before, "rgb(171, 205, 239)", "the older stylesheet should be in force first");

    await writeFile(servedCss, deployedCss);
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(2000);

    const after = await page.evaluate(() => getComputedStyle(document.querySelector("#solved")).backgroundColor);
    assert.equal(after, "rgb(31, 122, 77)", "the worker must not keep serving the superseded stylesheet");
    await context.close();
  });
});

test("the reader still works with the server unreachable", { skip }, async () => {
  await withReader(8212, async ({ base, browser, server }) => {
    const { context, page } = await openReader(browser, base);
    // Collection data only reaches the cache once the worker controls the page,
    // which is from the second visit onwards.
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(
      () => document.querySelector("#problem-ordinal")?.textContent?.includes("Problem"),
      { timeout: 30000 },
    );

    server.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(3000);

    const state = await page.evaluate(() => ({
      ordinal: document.querySelector("#problem-ordinal").textContent,
      stones: document.querySelectorAll("#board *").length,
    }));
    assert.match(state.ordinal, /^Problem \d+ of \d+$/);
    assert.ok(state.stones > 0, "the cached board should still render offline");

    await page.evaluate(() => document.querySelector("#solved").click());
    await page.waitForTimeout(1500);
    const feedback = await page.evaluate(() => document.querySelector("#status-feedback").textContent);
    assert.match(feedback, /Progress was not saved/);
    await context.close();
  });
});

test("one visit is enough to keep working offline", { skip }, async () => {
  await withReader(8213, async ({ base, browser, server }) => {
    // Signing in takes several requests, by which point the worker controls the
    // page, so the booklet is already cached without needing a second visit.
    const { context, page } = await openReader(browser, base);

    server.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(3000);

    const state = await page.evaluate(() => ({
      ordinal: document.querySelector("#problem-ordinal").textContent,
      stones: document.querySelectorAll("#board *").length,
    }));
    assert.match(state.ordinal, /^Problem \d+ of \d+$/);
    assert.ok(state.stones > 0, "the cached board should still render offline");
    await context.close();
  });
});

test("the worker does not strip the session token from API requests", { skip }, async () => {
  await withReader(8214, async ({ base, browser }) => {
    const { context, page } = await openReader(browser, base);

    const result = await page.evaluate(async () => {
      const login = await fetch(new URL("api/session", location.href), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: "swauth", password: "correct horse battery", create: true }),
      });
      const { token } = await login.json();
      // This request goes through the worker, which rebuilds it to force
      // revalidation; rebuilding without the headers made every call 401.
      const progress = await fetch(new URL("api/progress", location.href), {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { login: login.status, progress: progress.status };
    });

    assert.equal(result.login, 200);
    assert.equal(result.progress, 200);
    await context.close();
  });
});
