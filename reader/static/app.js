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
const changeCollectionButton = document.querySelector("#change-collection");
const collectionPanel = document.querySelector("#collection-panel");
const closeCollectionPanelButton = document.querySelector("#close-collection-panel");
const collectionList = document.querySelector("#collection-list");

let collection;
let catalog = [];
let currentIndex = 0;
let statuses = {};
let user;
let wheelDelta = 0;
let wheelTimer;
let lastWheelNavigation = 0;
let isSaving = false;
let isLoadingCollection = false;
let collectionButtons = [];
let collectionPanelInvoker;

const COLLECTION_STORAGE_KEY = "static-go-reader-collection";
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

function getSavedCollection(collectionCatalog) {
  const saved = localStorage.getItem(COLLECTION_STORAGE_KEY);
  return collectionCatalog.some(({ slug }) => slug === saved)
    ? saved
    : collectionCatalog[0].slug;
}

function collectionPath(slug) {
  return `/collections/${encodeURIComponent(slug)}`;
}

function getCollectionPath() {
  if (window.location.pathname === "/") return { kind: "root" };
  const match = /^\/collections\/([^/]+)$/.exec(window.location.pathname);
  if (!match) return { kind: "invalid" };
  try {
    const slug = decodeURIComponent(match[1]);
    if (!slug || slug.includes("/")) return { kind: "invalid" };
    return { kind: "collection", slug };
  } catch {
    return { kind: "invalid" };
  }
}

function getCollectionSlugFromPath() {
  const path = getCollectionPath();
  return path.kind === "collection" ? path.slug : null;
}

function getStatusTotals(problems) {
  return problems.reduce(
    (totals, { id }) => {
      const status = statuses[id]?.status;
      if (status === "solved") totals.solved += 1;
      if (status === "revisit") totals.revisit += 1;
      return totals;
    },
    { solved: 0, revisit: 0 },
  );
}

function getCatalogStatusTotals(slug) {
  const prefix = `${slug}:`;
  return Object.entries(statuses).reduce(
    (totals, [problemId, { status }]) => {
      if (!problemId.startsWith(prefix)) return totals;
      if (status === "solved") totals.solved += 1;
      if (status === "revisit") totals.revisit += 1;
      return totals;
    },
    { solved: 0, revisit: 0 },
  );
}

function renderCollectionList() {
  if (!collectionList) return;
  collectionButtons = catalog.map((item) => {
    const totals = getCatalogStatusTotals(item.slug);
    const solvedPercentage = (totals.solved / item.problem_count) * 100;
    const solvedPercentageLabel = Math.round(solvedPercentage);
    const stateClass =
      totals.solved === item.problem_count
        ? "collection-option--complete"
        : totals.solved > 0
          ? "collection-option--partial"
          : totals.revisit > 0
            ? "collection-option--started"
            : "";
    const option = document.createElement("button");
    option.type = "button";
    option.className = ["collection-option", stateClass].filter(Boolean).join(" ");
    option.style.setProperty("--collection-progress", `${solvedPercentage}%`);
    const label = document.createElement("span");
    label.className = "collection-option__label";
    label.textContent = `${item.title} · ${item.level} · ${item.category} · ${item.problem_count} problems · Solved: ${totals.solved} (${solvedPercentageLabel}%) · Revisit: ${totals.revisit}`;
    option.append(label);
    option.setAttribute("data-collection-slug", item.slug);
    option.addEventListener("click", () => selectCollection(item.slug));
    const listItem = document.createElement("li");
    listItem.append(option);
    return { listItem, option };
  });
  collectionList.replaceChildren(...collectionButtons.map(({ listItem }) => listItem));
  setCollectionControlsDisabled(isSaving || isLoadingCollection);
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
    const { solved: solvedCount, revisit: revisitCount } = getStatusTotals(
      collection.problems,
    );
    const controlsDisabled = isSaving || isLoadingCollection;

    collectionTitle.textContent = collection.title;
    problemOrdinal.textContent = `Problem ${problem.number} of ${collection.problems.length}`;
    progressSummary.textContent = `Solved: ${solvedCount} · Revisit: ${revisitCount} · Total: ${collection.problems.length}`;
    previousButton.disabled = controlsDisabled || currentIndex === 0;
    nextButton.disabled = controlsDisabled || collection.problems.length === currentIndex + 1;
    solvedButton.disabled = controlsDisabled;
    revisitButton.disabled = controlsDisabled;
    setCollectionControlsDisabled(controlsDisabled);
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
  if (isSaving || isLoadingCollection) return;

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
    renderCollectionList();
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
  if (!hasCollection() || isSaving || isLoadingCollection || isCollectionPanelOpen()) return;
  currentIndex = Math.max(
    0,
    Math.min(collection.problems.length - 1, currentIndex + delta),
  );
  renderReader();
}

function handleWheel(event) {
  if (
    isCollectionPanelOpen() ||
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
  if (isCollectionPanelOpen()) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCollectionPanel();
      return;
    }
    if (event.key === "Tab") {
      trapCollectionPanelFocus(event);
      return;
    }
    if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
    }
    return;
  }
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
  setCollectionControlsDisabled(disabled);
}

function setCollectionControlsDisabled(disabled) {
  if (changeCollectionButton) changeCollectionButton.disabled = disabled;
  for (const { option } of collectionButtons) {
    option.disabled = disabled;
  }
}

function showError(error) {
  statusFeedback.textContent = error instanceof Error ? error.message : String(error);
}

function isCollectionPanelOpen() {
  return Boolean(collectionPanel && !collectionPanel.hidden);
}

function getCollectionPanelFocusables() {
  return [
    closeCollectionPanelButton,
    ...collectionButtons.map(({ option }) => option),
  ].filter((button) => button && !button.disabled);
}

function focusCollectionPanel() {
  (collectionButtons[0]?.option ?? closeCollectionPanelButton)?.focus();
}

function restoreCollectionPanelFocus() {
  const invoker = collectionPanelInvoker;
  collectionPanelInvoker = undefined;
  invoker?.focus();
}

function trapCollectionPanelFocus(event) {
  const focusables = getCollectionPanelFocusables();
  if (focusables.length === 0) return;
  const activeIndex = focusables.indexOf(document.activeElement);
  const nextIndex = event.shiftKey
    ? (activeIndex <= 0 ? focusables.length : activeIndex) - 1
    : (activeIndex + 1) % focusables.length;
  event.preventDefault();
  focusables[nextIndex].focus();
}

function closeCollectionPanel({ restoreFocus = true } = {}) {
  if (!collectionPanel) return;
  collectionPanel.hidden = true;
  changeCollectionButton?.setAttribute("aria-expanded", "false");
  if (restoreFocus) restoreCollectionPanelFocus();
}

function openCollectionPanel(event) {
  if (isSaving || isLoadingCollection || !collectionPanel) return;
  window.clearTimeout(wheelTimer);
  wheelTimer = undefined;
  wheelDelta = 0;
  collectionPanelInvoker = event?.currentTarget ?? document.activeElement;
  collectionPanel.hidden = false;
  changeCollectionButton?.setAttribute("aria-expanded", "true");
  focusCollectionPanel();
}

async function loadActiveCollection(slug, historyMode = "none") {
  const nextCollection = await fetchJson(`/api/collections/${encodeURIComponent(slug)}`);
  const nextStatuses = (await fetchJson(`/api/progress?user=${encodeURIComponent(user)}`)).problems;
  collection = nextCollection;
  statuses = nextStatuses;
  currentIndex = firstPendingIndex(collection.problems, statuses);
  renderCollectionList();
  renderReader();
  if (historyMode === "push") {
    window.history.pushState({}, "", collectionPath(slug));
  }
}

async function selectCollection(slug) {
  if (isSaving || isLoadingCollection) return;
  closeCollectionPanel({ restoreFocus: false });
  isLoadingCollection = true;
  setControlsDisabled(true);
  try {
    await loadActiveCollection(slug, "push");
    localStorage.setItem(COLLECTION_STORAGE_KEY, slug);
    statusFeedback.textContent = `Selected ${collection.title}.`;
  } catch (error) {
    showError(error);
  } finally {
    isLoadingCollection = false;
    if (hasCollection()) {
      renderReader();
      restoreCollectionPanelFocus();
    }
  }
}

async function loadCollectionFromHistory() {
  if (isSaving || isLoadingCollection) return;
  const path = getCollectionPath();
  if (path.kind === "invalid") {
    showError(new Error("Invalid collection URL."));
    return;
  }
  const slug = path.kind === "root" ? getSavedCollection(catalog) : path.slug;
  if (!catalog.some((item) => item.slug === slug)) {
    showError(new Error("Unknown collection in URL."));
    return;
  }

  isLoadingCollection = true;
  setControlsDisabled(true);
  try {
    await loadActiveCollection(slug);
    localStorage.setItem(COLLECTION_STORAGE_KEY, slug);
  } catch (error) {
    showError(error);
  } finally {
    isLoadingCollection = false;
    if (hasCollection()) renderReader();
  }
}

async function startReader() {
  isLoadingCollection = true;
  try {
    setControlsDisabled(true);
    user = getOrPromptUser();
    catalog = await fetchJson("/api/collections");
    const path = getCollectionPath();
    if (path.kind === "invalid") {
      throw new Error("Invalid collection URL.");
    }
    if (path.kind === "collection" && !catalog.some((item) => item.slug === path.slug)) {
      throw new Error("Unknown collection in URL.");
    }
    const slug = path.kind === "collection" ? path.slug : getSavedCollection(catalog);
    localStorage.setItem(COLLECTION_STORAGE_KEY, slug);
    await loadActiveCollection(slug);
    statusFeedback.textContent = `Tracking progress for ${user}.`;
  } catch (error) {
    showError(error);
  } finally {
    isLoadingCollection = false;
    if (hasCollection()) renderReader();
  }
}

previousButton.addEventListener("click", () => navigate(-1));
nextButton.addEventListener("click", () => navigate(1));
solvedButton.addEventListener("click", () => setCurrentStatus("solved"));
revisitButton.addEventListener("click", () => setCurrentStatus("revisit"));
changeCollectionButton?.addEventListener("click", openCollectionPanel);
closeCollectionPanelButton?.addEventListener("click", closeCollectionPanel);
window.addEventListener("popstate", loadCollectionFromHistory);
document.addEventListener("keydown", handleKeydown);
document.addEventListener("wheel", handleWheel, { passive: true });

startReader();
