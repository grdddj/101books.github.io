const board = document.querySelector("#board");
const reader = document.querySelector("#app");
const collectionTitle = document.querySelector("#collection-title");
const progressSummary = document.querySelector("#progress-summary");
const problemOrdinal = document.querySelector("#problem-ordinal");
const statusFeedback = document.querySelector("#status-feedback");
const previousButton = document.querySelector("#previous");
const solvedButton = document.querySelector("#solved");
const revisitButton = document.querySelector("#revisit");
const nextButton = document.querySelector("#next");

let collection;
let currentIndex = 0;
let statuses = {};
let user;
let wheelDelta = 0;
let wheelTimer;
let lastWheelNavigation = 0;
let isSaving = false;

const WHEEL_THRESHOLD = 70;
const WHEEL_IDLE_MS = 140;
const WHEEL_COOLDOWN_MS = 500;

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function getOrPromptUser() {
  const key = "static-go-reader-user";
  const existing = normalizeUserName(localStorage.getItem(key));
  if (existing) {
    localStorage.setItem(key, existing);
    return existing;
  }

  localStorage.removeItem(key);
  const name = normalizeUserName(window.prompt("Your name for local progress:", ""));
  if (!name) throw new Error("A valid name is required to track progress.");
  localStorage.setItem(key, name);
  return name;
}

function normalizeUserName(name) {
  if (typeof name !== "string") return null;
  const normalized = name.trim();
  return normalized && normalized.length <= 80 ? normalized : null;
}

function firstPendingIndex(problems, statuses) {
  const index = problems.findIndex(
    ({ id }) => !statuses[id] || statuses[id].status === "revisit",
  );
  return index === -1 ? 0 : index;
}

function getCoordinatePosition(coordinate) {
  return {
    column: coordinate.charCodeAt(0) - 97,
    row: coordinate.charCodeAt(1) - 97,
  };
}

function getBoardCrop(problem) {
  const stones = [...problem.black, ...problem.white];
  const columns = stones.map((coordinate) => getCoordinatePosition(coordinate).column);
  const rows = stones.map((coordinate) => getCoordinatePosition(coordinate).row);
  const minColumn = Math.max(0, Math.min(...columns) - 1);
  const maxColumn = Math.min(18, Math.max(...columns) + 1);
  const minRow = Math.max(0, Math.min(...rows) - 1);
  const maxRow = Math.min(18, Math.max(...rows) + 1);
  return {
    minColumn,
    maxColumn,
    minRow,
    maxRow,
    columns: maxColumn - minColumn + 1,
    rows: maxRow - minRow + 1,
  };
}

function renderBoard(problem) {
  const crop = getBoardCrop(problem);
  board.replaceChildren();
  board.style.setProperty("--board-columns", crop.columns);
  board.style.setProperty("--board-rows", crop.rows);
  const grid = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  grid.setAttribute("aria-hidden", "true");
  grid.setAttribute("class", "goban-grid");
  grid.setAttribute("viewBox", `0 0 ${crop.columns} ${crop.rows}`);
  for (let column = 0; column < crop.columns; column += 1) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const position = column + 0.5;
    line.setAttribute("class", "goban-grid-line goban-grid-line--vertical");
    line.setAttribute("x1", position);
    line.setAttribute("x2", position);
    line.setAttribute("y1", 0.5);
    line.setAttribute("y2", crop.rows - 0.5);
    grid.append(line);
  }
  for (let row = 0; row < crop.rows; row += 1) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const position = row + 0.5;
    line.setAttribute("class", "goban-grid-line goban-grid-line--horizontal");
    line.setAttribute("x1", 0.5);
    line.setAttribute("x2", crop.columns - 0.5);
    line.setAttribute("y1", position);
    line.setAttribute("y2", position);
    grid.append(line);
  }
  board.append(grid);
  for (const [color, coordinates] of [
    ["black", problem.black],
    ["white", problem.white],
  ]) {
    for (const coordinate of coordinates) {
      const position = getCoordinatePosition(coordinate);
      const stone = document.createElement("span");
      stone.className = `stone ${color}`;
      stone.style.gridColumn = position.column - crop.minColumn + 1;
      stone.style.gridRow = position.row - crop.minRow + 1;
      board.append(stone);
    }
  }
  return crop;
}

function renderReader() {
  try {
    const problem = collection.problems[currentIndex];
    const currentStatus = statuses[problem.id]?.status || "unseen";
    const solvedCount = Object.values(statuses).filter(
      ({ status }) => status === "solved",
    ).length;
    const revisitCount = Object.values(statuses).filter(
      ({ status }) => status === "revisit",
    ).length;

    collectionTitle.textContent = collection.title;
    problemOrdinal.textContent = `Problem ${problem.number} of ${collection.problems.length}`;
    progressSummary.textContent = `Solved: ${solvedCount} · Revisit: ${revisitCount} · Total: ${collection.problems.length}`;
    previousButton.disabled = isSaving || currentIndex === 0;
    nextButton.disabled = isSaving || collection.problems.length === currentIndex + 1;
    solvedButton.disabled = isSaving;
    revisitButton.disabled = isSaving;
    setSelectedStatus(solvedButton, currentStatus === "solved");
    setSelectedStatus(revisitButton, currentStatus === "revisit");
    renderBoard(problem);
    return true;
  } catch (error) {
    setControlsDisabled(true);
    showError(error);
    return false;
  }
}

function setSelectedStatus(button, selected) {
  button.classList.toggle("is-selected", selected);
  button.setAttribute("aria-pressed", String(selected));
}

async function setCurrentStatus(status) {
  if (!hasCollection()) {
    showError(new Error("Reader is still loading."));
    return;
  }
  if (isSaving) return;

  const submittedIndex = currentIndex;
  const problem = collection.problems[submittedIndex];
  isSaving = true;
  setControlsDisabled(true);
  try {
    const savedProgress = await fetchJson("/api/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, problem_id: problem.id, status }),
    });
    statuses = savedProgress.problems;
    isSaving = false;
    const submittedProblemIsCurrent = collection.problems[currentIndex]?.id === problem.id;
    if (submittedProblemIsCurrent && submittedIndex < collection.problems.length - 1) {
      navigate(1);
    } else {
      renderReader();
    }
    statusFeedback.textContent = `Problem ${problem.number} marked ${status}.`;
  } catch (error) {
    isSaving = false;
    renderReader();
    statusFeedback.textContent = error.message;
  }
}

function navigate(delta) {
  if (!hasCollection() || isSaving) return;
  currentIndex = Math.max(
    0,
    Math.min(collection.problems.length - 1, currentIndex + delta),
  );
  renderReader();
}

function handleWheel(event) {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !isReaderTarget(event.target) ||
    !hasCollection()
  ) {
    return;
  }
  wheelDelta += event.deltaY;
  window.clearTimeout(wheelTimer);
  wheelTimer = window.setTimeout(() => {
    if (
      Math.abs(wheelDelta) >= WHEEL_THRESHOLD &&
      Date.now() - lastWheelNavigation >= WHEEL_COOLDOWN_MS
    ) {
      navigate(Math.sign(wheelDelta));
      lastWheelNavigation = Date.now();
    }
    wheelDelta = 0;
  }, WHEEL_IDLE_MS);
}

function handleKeydown(event) {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !hasCollection()
  ) {
    return;
  }

  const delta = ["ArrowLeft", "ArrowUp"].includes(event.key)
    ? -1
    : ["ArrowRight", "ArrowDown"].includes(event.key)
      ? 1
      : 0;
  if (!delta) return;
  event.preventDefault();
  navigate(delta);
}

function hasCollection() {
  return Array.isArray(collection?.problems) && collection.problems.length > 0;
}

function isReaderTarget(target) {
  return target === reader || reader.contains(target);
}

function setControlsDisabled(disabled) {
  for (const button of [
    previousButton,
    solvedButton,
    revisitButton,
    nextButton,
  ]) {
    button.disabled = disabled;
  }
}

function showError(error) {
  statusFeedback.textContent = error instanceof Error ? error.message : String(error);
}

async function startReader() {
  try {
    setControlsDisabled(true);
    user = getOrPromptUser();
    collection = await fetchJson("/api/collection");
    const progress = await fetchJson(`/api/progress?user=${encodeURIComponent(user)}`);
    statuses = progress.problems;
    currentIndex = firstPendingIndex(collection.problems, statuses);
    if (renderReader()) {
      statusFeedback.textContent = `Tracking progress for ${user}.`;
    }
  } catch (error) {
    showError(error);
  }
}

previousButton.addEventListener("click", () => navigate(-1));
nextButton.addEventListener("click", () => navigate(1));
solvedButton.addEventListener("click", () => setCurrentStatus("solved"));
revisitButton.addEventListener("click", () => setCurrentStatus("revisit"));
document.addEventListener("keydown", handleKeydown);
document.addEventListener("wheel", handleWheel, { passive: true });

startReader();
