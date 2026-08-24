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
const profileButton = document.querySelector("#profile");
const profilePanel = document.querySelector("#profile-panel");
const profileForm = document.querySelector("#profile-form");
const profileNameInput = document.querySelector("#profile-name");
const profilePasswordInput = document.querySelector("#profile-password");
const profileCreateButton = document.querySelector("#profile-create");
const profileError = document.querySelector("#profile-error");
const profileSaveButton = document.querySelector("#profile-save");
const profileSignOutButton = document.querySelector("#profile-signout");
const closeProfilePanelButton = document.querySelector("#close-profile-panel");
const changeCollectionButton = document.querySelector("#change-collection");
const collectionPanel = document.querySelector("#collection-panel");
const closeCollectionPanelButton = document.querySelector("#close-collection-panel");
const collectionList = document.querySelector("#collection-list");
const activityButton = document.querySelector("#show-activity");
const activityPanel = document.querySelector("#activity-panel");
const closeActivityPanelButton = document.querySelector("#close-activity-panel");
const activityList = document.querySelector("#activity-list");
const activityEmpty = document.querySelector("#activity-empty");
const modalBackdrop = document.querySelector("#modal-backdrop");
const basePath = window.READER_BASE_PATH || "";

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
let isLoadingActivity = false;
let collectionButtons = [];
let collectionPanelInvoker;
let activityPanelInvoker;
let displayedPathname;
let pendingHistoryPathname;
let historyRequestId = 0;
let historyReconciliationPromise;
let resolveHistoryReconciliation;
let isReconcilingHistory = false;
let timedProblemId;
let activeMillisecondsBeforePause = 0;
let visibleSince;
let profilePanelInvoker;
let resolvePendingSignIn;
let sessionToken;
let offerCreateFor;

const COLLECTION_STORAGE_KEY = "static-go-reader-collection";
const USER_STORAGE_KEY = "static-go-reader-user";
const TOKEN_STORAGE_KEY = "static-go-reader-token";
const WHEEL_THRESHOLD = 70;
const WHEEL_IDLE_MS = 140;
const WHEEL_COOLDOWN_MS = 500;
const MAX_PROBLEM_DURATION_SECONDS = 3600;

async function fetchJson(path, options = {}) {
  let response;
  const headers = { ...options.headers };
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  try {
    response = await fetch(readerPath(path), { ...options, headers });
  } catch (error) {
    // fetch rejects with a TypeError only when the request never completed;
    // server-side failures arrive as a normal response and keep their message.
    if (error.name !== "TypeError") throw error;
    throw new Error(connectionErrorMessage(options.method));
  }
  const body = await response.json();
  if (response.status === 401 && sessionToken) throw new SessionExpiredError();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

class SessionExpiredError extends Error {
  constructor() {
    super("Your session has expired. Sign in again.");
    this.name = "SessionExpiredError";
  }
}

// Reads are usually satisfied from the service worker cache, so a failed
// request is either a write or a genuinely cold start.
function connectionErrorMessage(method) {
  const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  const reason = isOffline ? "You appear to be offline." : "Could not reach the server.";
  return method && method !== "GET" ? `${reason} Progress was not saved.` : reason;
}

function readerPath(path) {
  return `${basePath}${path}`;
}

function startProblemTimer(problemId) {
  if (timedProblemId === problemId) return;
  timedProblemId = problemId;
  activeMillisecondsBeforePause = 0;
  visibleSince = isPageVisible() ? Date.now() : undefined;
}

function elapsedProblemSeconds() {
  if (timedProblemId === undefined) return undefined;
  const running = visibleSince === undefined ? 0 : Date.now() - visibleSince;
  const seconds = Math.round((activeMillisecondsBeforePause + running) / 1000);
  // The server rejects anything above an hour; a longer sitting says nothing
  // useful about the problem, so it is reported as unmeasured.
  return seconds >= 0 && seconds <= MAX_PROBLEM_DURATION_SECONDS ? seconds : undefined;
}

function isPageVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function handleVisibilityChange() {
  if (isPageVisible()) {
    if (visibleSince === undefined) visibleSince = Date.now();
    return;
  }
  if (visibleSince !== undefined) {
    activeMillisecondsBeforePause += Date.now() - visibleSince;
    visibleSince = undefined;
  }
}

function getStoredUser() {
  const existing = normalizeUserName(localStorage.getItem(USER_STORAGE_KEY));
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  // A name without a token is no longer a session; both are needed.
  if (!existing || !token) {
    clearSession();
    return null;
  }
  sessionToken = token;
  localStorage.setItem(USER_STORAGE_KEY, existing);
  return existing;
}

function clearSession() {
  sessionToken = undefined;
  localStorage.removeItem(USER_STORAGE_KEY);
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

function storeSession(name, token) {
  user = name;
  sessionToken = token;
  localStorage.setItem(USER_STORAGE_KEY, name);
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

async function requestSession(name, password, create) {
  const response = await fetch(readerPath("/api/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: name, password, create }),
  });
  let body = {};
  try {
    body = await response.json();
  } catch (error) {
    body = {};
  }
  return { status: response.status, body };
}

function renderProfile() {
  if (!profileButton) return;
  profileButton.textContent = user || "Sign in";
  profileButton.setAttribute(
    "aria-label",
    user ? `Signed in as ${user}. Change name or sign out.` : "Sign in",
  );
  // Always reachable: it is the only way back in after signing out, and the
  // only way to fix a name typed wrongly on the first visit.
  profileButton.disabled = false;
}

function isProfilePanelOpen() {
  return Boolean(profilePanel && !profilePanel.hidden);
}

function setProfileError(message) {
  if (!profileError) return;
  profileError.textContent = message;
  profileError.hidden = !message;
}

function openProfilePanel(event) {
  if (!profilePanel || isSaving || isLoadingCollection || isDialogOpen()) return;
  showProfilePanel(event?.currentTarget ?? document.activeElement);
}

// Sign-in at startup bypasses the guards above on purpose: the reader is
// mid-load and has no name yet, which is precisely when it must ask for one.
function showProfilePanel(invoker) {
  if (!profilePanel) return;
  profilePanelInvoker = invoker;
  profilePanel.hidden = false;
  profileButton?.setAttribute("aria-expanded", "true");
  showModalBackdrop();
  if (profileNameInput) profileNameInput.value = user || "";
  if (profilePasswordInput) profilePasswordInput.value = "";
  setCreateOffer(null);
  setProfileBusy(false);
  setProfileError("");
  // Signing out is only meaningful when somebody is signed in.
  if (profileSignOutButton) profileSignOutButton.hidden = !user;
  profileNameInput?.focus();
}

function closeProfilePanel({ restoreFocus = true } = {}) {
  if (!profilePanel) return;
  profilePanel.hidden = true;
  profileButton?.setAttribute("aria-expanded", "false");
  hideModalBackdrop();
  setProfileError("");
  if (restoreFocus) {
    const target = profilePanelInvoker ?? profileButton;
    profilePanelInvoker = undefined;
    target?.focus();
  }
  // Closing without a name leaves the reader unusable, so say so rather than
  // showing an empty board.
  if (!user) settleSignIn(null);
}

function settleSignIn(name) {
  if (!resolvePendingSignIn) return;
  const resolve = resolvePendingSignIn;
  resolvePendingSignIn = undefined;
  resolve(name);
}

function requestSignIn() {
  return new Promise((resolve) => {
    resolvePendingSignIn = resolve;
    showProfilePanel(profileButton);
  });
}

// A create offer refers to one exact spelling; changing the name withdraws it.
function handleProfileNameInput() {
  if (offerCreateFor && normalizeUserName(profileNameInput?.value) !== offerCreateFor) {
    setCreateOffer(null);
    setProfileError("");
  }
}

function setCreateOffer(name) {
  offerCreateFor = name;
  if (profileCreateButton) profileCreateButton.hidden = !name;
}

function readProfileForm() {
  return {
    name: normalizeUserName(profileNameInput?.value),
    password: profilePasswordInput?.value ?? "",
  };
}

async function submitProfile(event, { create = false } = {}) {
  event?.preventDefault?.();
  const { name, password } = readProfileForm();
  if (!name) {
    setProfileError("Enter a name of 1 to 80 characters.");
    profileNameInput?.focus();
    return;
  }
  if (!password) {
    setProfileError("Enter your password.");
    profilePasswordInput?.focus();
    return;
  }

  setProfileBusy(true);
  let attempt;
  try {
    attempt = await requestSession(name, password, create);
  } catch (error) {
    setProfileBusy(false);
    setProfileError(connectionErrorMessage());
    return;
  }
  setProfileBusy(false);

  if (attempt.status === 404) {
    // A mistyped name would otherwise open an empty profile that looks exactly
    // like lost progress, so creating one is a separate, deliberate step.
    setProfileError(`No profile called “${name}”. Create it?`);
    setCreateOffer(name);
    return;
  }
  if (attempt.status !== 200) {
    setProfileError(attempt.body.error || "Sign in failed.");
    setCreateOffer(null);
    return;
  }

  const previous = user;
  setCreateOffer(null);
  storeSession(attempt.body.user, attempt.body.token);
  if (profilePasswordInput) profilePasswordInput.value = "";
  renderProfile();
  closeProfilePanel();
  if (resolvePendingSignIn) {
    settleSignIn(user);
    return;
  }
  if (user !== previous) await reloadForCurrentUser();
}

function setProfileBusy(busy) {
  for (const button of [profileSaveButton, profileCreateButton, profileSignOutButton]) {
    if (button) button.disabled = busy;
  }
  if (profileNameInput) profileNameInput.disabled = busy;
  if (profilePasswordInput) profilePasswordInput.disabled = busy;
}

// Signing out keeps the dialog open in its signed-out state instead of leaving
// the reader with no name and no way to enter one.
function signOutProfile() {
  clearSession();
  user = undefined;
  renderProfile();
  if (profileNameInput) profileNameInput.value = "";
  if (profilePasswordInput) profilePasswordInput.value = "";
  setCreateOffer(null);
  if (profileSignOutButton) profileSignOutButton.hidden = true;
  setProfileError("");
  setControlsDisabled(true);
  profileNameInput?.focus();
}

async function reloadForCurrentUser() {
  if (!hasCollection()) return;
  isLoadingCollection = true;
  setControlsDisabled(true);
  try {
    await loadActiveCollection(collection.slug);
    statusFeedback.textContent = `Tracking progress for ${user}.`;
  } catch (error) {
    showError(error);
  } finally {
    isLoadingCollection = false;
    restoreControlsAfterCollectionOperation();
  }
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
  return readerPath(`/collections/${encodeURIComponent(slug)}`);
}

function getCollectionPath(pathname = window.location.pathname) {
  const internalPathname = stripBasePath(pathname);
  if (internalPathname === null) return { kind: "invalid" };
  if (internalPathname === "/") return { kind: "root" };
  const match = /^\/collections\/([^/]+)$/.exec(internalPathname);
  if (!match) return { kind: "invalid" };
  try {
    const slug = decodeURIComponent(match[1]);
    if (!slug || slug.includes("/")) return { kind: "invalid" };
    return { kind: "collection", slug };
  } catch {
    return { kind: "invalid" };
  }
}

function stripBasePath(pathname) {
  if (!basePath) return pathname;
  if (pathname === basePath || pathname === `${basePath}/`) return "/";
  if (!pathname.startsWith(`${basePath}/`)) return null;
  return pathname.slice(basePath.length);
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
    const isComplete = totals.solved === item.problem_count;
    const solvedPercentageLabel = isComplete ? 100 : Math.min(99, Math.round(solvedPercentage));
    const stateClass =
      isComplete
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
    startProblemTimer(problem.id);
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
  if (isDialogOpen() || isSaving || isLoadingCollection) return;

  const submittedIndex = currentIndex;
  const problem = collection.problems[submittedIndex];
  isSaving = true;
  setControlsDisabled(true);
  try {
    const durationSeconds = elapsedProblemSeconds();
    const savedProgress = await fetchJson("/api/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        problem_id: problem.id,
        status,
        ...(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
      }),
    });
    statuses = savedProgress.problems;
    isSaving = false;
    if (pendingHistoryPathname !== undefined) {
      startHistoryReconciliation();
      return;
    }
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
    showError(error);
    if (pendingHistoryPathname !== undefined) {
      startHistoryReconciliation();
      return;
    }
    renderReader();
  }
}

function navigate(delta) {
  if (!hasCollection() || isSaving || isLoadingCollection || isDialogOpen()) return;
  currentIndex = Math.max(
    0,
    Math.min(collection.problems.length - 1, currentIndex + delta),
  );
  renderReader();
}

function handleWheel(event) {
  if (
    isDialogOpen() ||
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
  if (isProfilePanelOpen()) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeProfilePanel();
      return;
    }
    if (event.key === "Tab") trapProfilePanelFocus(event);
    // Everything else belongs to the text field.
    return;
  }
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
  if (isActivityPanelOpen()) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeActivityPanel();
      return;
    }
    if (event.key === "Tab") {
      trapActivityPanelFocus(event);
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
  if (activityButton) activityButton.disabled = disabled;
  // The profile stays reachable even when the catalog failed to load: that is
  // exactly when a wrong name most needs correcting.
  if (profileButton) profileButton.disabled = false;
  for (const { option } of collectionButtons) {
    option.disabled = disabled;
  }
}

function showError(error) {
  statusFeedback.textContent = error instanceof Error ? error.message : String(error);
  if (error?.name === "SessionExpiredError") {
    clearSession();
    user = undefined;
    renderProfile();
    setControlsDisabled(true);
    openProfilePanel();
  }
}

function isCollectionPanelOpen() {
  return Boolean(collectionPanel && !collectionPanel.hidden);
}

function isActivityPanelOpen() {
  return Boolean(activityPanel && !activityPanel.hidden);
}

function isDialogOpen() {
  return isCollectionPanelOpen() || isActivityPanelOpen() || isProfilePanelOpen();
}

function showModalBackdrop() {
  if (modalBackdrop) modalBackdrop.hidden = false;
}

function hideModalBackdrop() {
  if (!isDialogOpen() && modalBackdrop) modalBackdrop.hidden = true;
}

function getProfilePanelFocusables() {
  return [
    profileNameInput,
    profilePasswordInput,
    profileSaveButton,
    profileCreateButton,
    profileSignOutButton,
    closeProfilePanelButton,
  ].filter(
    (element) => element && !element.disabled && !element.hidden,
  );
}

function trapProfilePanelFocus(event) {
  const focusables = getProfilePanelFocusables();
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
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
  hideModalBackdrop();
  if (restoreFocus) restoreCollectionPanelFocus();
}

function openCollectionPanel(event) {
  if (isSaving || isLoadingCollection || isLoadingActivity || isActivityPanelOpen() || !collectionPanel) return;
  window.clearTimeout(wheelTimer);
  wheelTimer = undefined;
  wheelDelta = 0;
  collectionPanelInvoker = event?.currentTarget ?? document.activeElement;
  collectionPanel.hidden = false;
  changeCollectionButton?.setAttribute("aria-expanded", "true");
  showModalBackdrop();
  focusCollectionPanel();
}

function getActivityPanelFocusables() {
  return [closeActivityPanelButton].filter((button) => button && !button.disabled);
}

function focusActivityPanel() {
  closeActivityPanelButton?.focus();
}

function restoreActivityPanelFocus() {
  const invoker = activityPanelInvoker;
  activityPanelInvoker = undefined;
  invoker?.focus();
}

function trapActivityPanelFocus(event) {
  const focusables = getActivityPanelFocusables();
  if (focusables.length === 0) return;
  event.preventDefault();
  focusables[0].focus();
}

function closeActivityPanel({ restoreFocus = true } = {}) {
  if (!activityPanel) return;
  activityPanel.hidden = true;
  activityButton?.setAttribute("aria-expanded", "false");
  hideModalBackdrop();
  if (restoreFocus) restoreActivityPanelFocus();
}

function formatActivityTimestamp(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? timestamp : date.toLocaleString();
}

function renderActivity(events) {
  if (!activityList || !activityEmpty) return;
  if (events.length === 0) {
    activityList.replaceChildren();
    activityEmpty.textContent = "No activity yet.";
    activityEmpty.hidden = false;
    return;
  }
  activityEmpty.hidden = true;
  activityList.replaceChildren(
    ...events.map((event) => {
      const item = document.createElement("li");
      item.className = "activity-entry";
      const action = event.status === "solved" ? "Solved" : "Revisit";
      const duration = formatDuration(event.duration_seconds);
      item.textContent = [
        action,
        event.collection_title,
        `Problem ${event.problem_number}`,
        formatActivityTimestamp(event.timestamp),
        duration,
      ]
        .filter(Boolean)
        .join(" · ");
      return item;
    }),
  );
}

// Events recorded before timing existed carry no duration and simply omit the
// field rather than showing a misleading zero.
function formatDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

async function openActivityPanel(event) {
  if (
    isSaving ||
    isLoadingCollection ||
    isLoadingActivity ||
    isCollectionPanelOpen() ||
    !activityPanel
  ) {
    return;
  }
  activityPanelInvoker = event?.currentTarget ?? document.activeElement;
  activityPanel.hidden = false;
  activityButton?.setAttribute("aria-expanded", "true");
  showModalBackdrop();
  activityEmpty.hidden = false;
  activityEmpty.textContent = "Loading activity…";
  activityList?.replaceChildren();
  focusActivityPanel();
  isLoadingActivity = true;
  if (activityButton) activityButton.disabled = true;
  try {
    const { events } = await fetchJson("/api/activity?limit=50");
    renderActivity(events);
  } catch (error) {
    activityList?.replaceChildren();
    if (activityEmpty) {
      activityEmpty.textContent = "Activity could not be loaded.";
      activityEmpty.hidden = false;
    }
    showError(error);
  } finally {
    isLoadingActivity = false;
    if (activityButton) activityButton.disabled = isSaving || isLoadingCollection;
  }
}

async function loadActiveCollection(slug, historyMode = "none", shouldApply = () => true) {
  const nextCollection = await fetchJson(`/api/collections/${encodeURIComponent(slug)}`);
  if (!shouldApply()) return false;
  const nextStatuses = (await fetchJson("/api/progress")).problems;
  if (!shouldApply()) return false;
  collection = nextCollection;
  statuses = nextStatuses;
  currentIndex = firstPendingIndex(collection.problems, statuses);
  renderCollectionList();
  renderReader();
  if (historyMode === "push") {
    window.history.pushState({}, "", collectionPath(slug));
  }
  return true;
}

function restoreControlsAfterCollectionOperation() {
  if (hasCollection()) {
    renderReader();
    return;
  }
  setControlsDisabled(true);
  setCollectionControlsDisabled(catalog.length === 0);
}

async function selectCollection(slug) {
  if (isSaving || isLoadingCollection) return;
  const startingHistoryRequestId = historyRequestId;
  closeCollectionPanel({ restoreFocus: false });
  isLoadingCollection = true;
  setControlsDisabled(true);
  try {
    const loaded = await loadActiveCollection(
      slug,
      "push",
      () => startingHistoryRequestId === historyRequestId,
    );
    if (!loaded) return;
    displayedPathname = collectionPath(slug);
    localStorage.setItem(COLLECTION_STORAGE_KEY, slug);
    statusFeedback.textContent = `Selected ${collection.title}.`;
  } catch (error) {
    if (startingHistoryRequestId === historyRequestId) showError(error);
  } finally {
    isLoadingCollection = false;
    restoreControlsAfterCollectionOperation();
    if (hasCollection()) restoreCollectionPanelFocus();
    startHistoryReconciliation();
  }
}

function getHistoryCollectionSlug(pathname) {
  const path = getCollectionPath(pathname);
  if (path.kind === "invalid") {
    throw new Error("Invalid collection URL.");
  }
  const slug = path.kind === "root" ? getSavedCollection(catalog) : path.slug;
  if (!catalog.some((item) => item.slug === slug)) {
    throw new Error("Unknown collection in URL.");
  }
  return slug;
}

function restoreDisplayedPath(error) {
  if (displayedPathname && window.location.pathname !== displayedPathname) {
    window.history.replaceState({}, "", displayedPathname);
  }
  showError(error);
}

async function reconcileHistory() {
  while (pendingHistoryPathname !== undefined) {
    const pathname = pendingHistoryPathname;
    const requestId = historyRequestId;
    try {
      const slug = getHistoryCollectionSlug(pathname);
      const loaded = await loadActiveCollection(
        slug,
        "none",
        () => requestId === historyRequestId,
      );
      if (!loaded) continue;
      displayedPathname = pathname;
      localStorage.setItem(COLLECTION_STORAGE_KEY, slug);
      pendingHistoryPathname = undefined;
    } catch (error) {
      if (requestId !== historyRequestId) continue;
      pendingHistoryPathname = undefined;
      restoreDisplayedPath(error);
    }
  }
}

function finishHistoryReconciliation() {
  isReconcilingHistory = false;
  isLoadingCollection = false;
  restoreControlsAfterCollectionOperation();
  settleHistoryReconciliation();
}

function settleHistoryReconciliation() {
  const resolve = resolveHistoryReconciliation;
  historyReconciliationPromise = undefined;
  resolveHistoryReconciliation = undefined;
  resolve?.();
}

function startHistoryReconciliation() {
  if (
    !historyReconciliationPromise ||
    isReconcilingHistory ||
    isSaving ||
    isLoadingCollection ||
    catalog.length === 0
  ) {
    return;
  }
  isReconcilingHistory = true;
  isLoadingCollection = true;
  setControlsDisabled(true);
  void reconcileHistory().finally(finishHistoryReconciliation);
}

function loadCollectionFromHistory() {
  pendingHistoryPathname = window.location.pathname;
  historyRequestId += 1;
  if (!historyReconciliationPromise) {
    historyReconciliationPromise = new Promise((resolve) => {
      resolveHistoryReconciliation = resolve;
    });
  }
  startHistoryReconciliation();
  return historyReconciliationPromise;
}

async function startReader() {
  const startingHistoryRequestId = historyRequestId;
  let startupStage = "catalog";
  isLoadingCollection = true;
  try {
    setControlsDisabled(true);
    user = getStoredUser() ?? (await requestSignIn());
    renderProfile();
    if (!user) throw new Error("A valid name is required to track progress.");
    catalog = await fetchJson("/api/collections");
    renderCollectionList();
    const path = getCollectionPath();
    if (path.kind === "invalid") {
      throw new Error("Invalid collection URL.");
    }
    if (path.kind === "collection" && !catalog.some((item) => item.slug === path.slug)) {
      throw new Error("Unknown collection in URL.");
    }
    const slug = path.kind === "collection" ? path.slug : getSavedCollection(catalog);
    const pathname = window.location.pathname;
    startupStage = "collection";
    const loaded = await loadActiveCollection(
      slug,
      "none",
      () => startingHistoryRequestId === historyRequestId,
    );
    if (!loaded) return;
    displayedPathname = pathname;
    localStorage.setItem(COLLECTION_STORAGE_KEY, slug);
    statusFeedback.textContent = `Tracking progress for ${user}.`;
  } catch (error) {
    if (startupStage === "catalog") {
      pendingHistoryPathname = undefined;
      settleHistoryReconciliation();
      showError(error);
    } else if (startingHistoryRequestId === historyRequestId) {
      showError(error);
    }
  } finally {
    isLoadingCollection = false;
    restoreControlsAfterCollectionOperation();
    startHistoryReconciliation();
  }
}

previousButton.addEventListener("click", () => navigate(-1));
nextButton.addEventListener("click", () => navigate(1));
solvedButton.addEventListener("click", () => setCurrentStatus("solved"));
revisitButton.addEventListener("click", () => setCurrentStatus("revisit"));
profileButton?.addEventListener("click", openProfilePanel);
profileForm?.addEventListener("submit", submitProfile);
profileNameInput?.addEventListener("input", handleProfileNameInput);
profileCreateButton?.addEventListener("click", () => submitProfile(undefined, { create: true }));
profileSignOutButton?.addEventListener("click", signOutProfile);
closeProfilePanelButton?.addEventListener("click", () => closeProfilePanel());
changeCollectionButton?.addEventListener("click", openCollectionPanel);
closeCollectionPanelButton?.addEventListener("click", closeCollectionPanel);
activityButton?.addEventListener("click", openActivityPanel);
closeActivityPanelButton?.addEventListener("click", closeActivityPanel);
window.addEventListener("popstate", loadCollectionFromHistory);
document.addEventListener("keydown", handleKeydown);
document.addEventListener("wheel", handleWheel, { passive: true });
document.addEventListener("visibilitychange", handleVisibilityChange);

// Registration is best effort: it needs a secure context, so plain-HTTP
// deployments simply run without offline support instead of failing.
async function registerServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
  try {
    return await navigator.serviceWorker.register(readerPath("/sw.js"), {
      scope: readerPath("/"),
    });
  } catch (error) {
    return undefined;
  }
}

registerServiceWorker();
startReader();
