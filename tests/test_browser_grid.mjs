import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const appSource = await readFile(new URL("../reader/static/app.js", import.meta.url), "utf8");
const appCss = await readFile(new URL("../reader/static/app.css", import.meta.url), "utf8");

async function findChromium() {
  for (const candidate of [
    process.env.CHROMIUM_BINARY,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ]) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue looking for a supported local Chromium binary.
    }
  }
  return null;
}

const chromium = await findChromium();

function browserHarnessSource() {
  const sourceWithoutStartup = appSource.replace(
    /\nstartReader\(\);\s*$/,
    `
globalThis.readerTestApi = { renderBoard };`,
  );
  return `<!doctype html>
<style>${appCss}</style>
<main id="app"><div id="board" class="goban"></div><span id="collection-title"></span><span id="progress-summary"></span><span id="problem-ordinal"></span><span id="status-feedback"></span><button id="previous"></button><button id="solved"></button><button id="revisit"></button><button id="next"></button></main><pre id="browser-grid-result"></pre>
<script>window.addEventListener("error", (event) => { document.querySelector("#browser-grid-result").textContent = JSON.stringify({ error: event.message }); }); window.prompt = () => "Ada"; window.fetch = () => Promise.reject(new Error("not used"));</script>
<script>${sourceWithoutStartup}</script>
<script>
  const gridBoard = document.querySelector("#board");
  const cases = [
    { name: "ten-by-five", problem: { black: ["cb", "jd"], white: [] }, columns: 10, rows: 5 },
    { name: "nine-by-six", problem: { black: ["be", "hh"], white: [] }, columns: 9, rows: 6 },
  ];
  const results = cases.map(({ name, problem, columns, rows }) => {
    readerTestApi.renderBoard(problem);
    const svg = gridBoard.querySelector(".goban-grid");
    const vertical = [...gridBoard.querySelectorAll(".goban-grid-line--vertical")];
    const horizontal = [...gridBoard.querySelectorAll(".goban-grid-line--horizontal")];
    const project = (line, axis) => {
      const point = svg.createSVGPoint();
      point[axis] = Number(line.getAttribute(axis + "1"));
      return point.matrixTransform(line.getScreenCTM())[axis];
    };
    const verticalPositions = vertical.map((line) => project(line, "x"));
    const horizontalPositions = horizontal.map((line) => project(line, "y"));
    const stonesAligned = [...gridBoard.querySelectorAll(".stone")].every((stone) => {
      const rect = stone.getBoundingClientRect();
      const stoneX = rect.left + rect.width / 2;
      const stoneY = rect.top + rect.height / 2;
      return verticalPositions.some((position) => Math.abs(position - stoneX) < 0.05)
        && horizontalPositions.some((position) => Math.abs(position - stoneY) < 0.05);
    });
    const spacing = (positions) => positions.slice(1).map((position, index) => position - positions[index]);
    const within = (values, expected) => values.every((value) => Math.abs(value - expected) < 0.05);
    const verticalSpacing = spacing(verticalPositions);
    const horizontalSpacing = spacing(horizontalPositions);
    return {
      name,
      vertical: vertical.length,
      horizontal: horizontal.length,
      squareCells: within(verticalSpacing, verticalSpacing[0])
        && within(horizontalSpacing, horizontalSpacing[0])
        && Math.abs(verticalSpacing[0] - horizontalSpacing[0]) < 0.05,
      stonesAligned,
    };
  });
  document.querySelector("#browser-grid-result").textContent = JSON.stringify(results);
</script>`;
}

test("Chromium renders every explicit grid line at square-cell spacing", { skip: !chromium }, async () => {
  const directory = await mkdtemp(join(process.cwd(), ".go-reader-grid-"));
  const htmlPath = join(directory, "grid.html");
  try {
    await writeFile(htmlPath, browserHarnessSource());
    const { stdout } = await execFileAsync(chromium, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      "--virtual-time-budget=1000",
      pathToFileURL(htmlPath).href,
    ]);
    const match = stdout.match(/<pre id="browser-grid-result">([^<]*)<\/pre>/);
    assert.ok(match, "Chromium did not return the grid measurement result");
    const results = JSON.parse(match[1]);
    assert.deepEqual(results, [
      { name: "ten-by-five", vertical: 10, horizontal: 5, squareCells: true, stonesAligned: true },
      { name: "nine-by-six", vertical: 9, horizontal: 6, squareCells: true, stonesAligned: true },
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
