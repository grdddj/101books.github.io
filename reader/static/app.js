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
const showSolutionButton = document.querySelector("#show-solution");
const solutionNote = document.querySelector("#solution-note");
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
const collectionFilters = document.querySelector("#collection-filters");
const activityButton = document.querySelector("#show-activity");
const activityPanel = document.querySelector("#activity-panel");
const closeActivityPanelButton = document.querySelector("#close-activity-panel");
const activityList = document.querySelector("#activity-list");
const activityEmpty = document.querySelector("#activity-empty");
const statsButton = document.querySelector("#show-stats");
const statsPanel = document.querySelector("#stats-panel");
const closeStatsPanelButton = document.querySelector("#close-stats-panel");
const statsWindows = document.querySelector("#stats-windows");
const statsStatus = document.querySelector("#stats-status");
const statsContent = document.querySelector("#stats-content");
const modalBackdrop = document.querySelector("#modal-backdrop");
const basePath = window.READER_BASE_PATH || "";

let collection;
let catalog = [];
let currentIndex = 0;
let isSolutionShown = false;
let statuses = {};
let user;
let wheelDelta = 0;
let wheelTimer;
let lastWheelNavigation = 0;
let isSaving = false;
let isLoadingCollection = false;
let isLoadingActivity = false;
let isLoadingStats = false;
let isAdmin = false;
let statsDays = 7;
let statsWindowButtons = [];
let collectionButtons = [];
let categoryButtons = [];
let collectionPanelInvoker;
let activityPanelInvoker;
let statsPanelInvoker;
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
const CATEGORY_STORAGE_KEY = "static-go-reader-categories";
const USER_STORAGE_KEY = "static-go-reader-user";
const TOKEN_STORAGE_KEY = "static-go-reader-token";
const WHEEL_THRESHOLD = 70;
const WHEEL_IDLE_MS = 140;
const WHEEL_COOLDOWN_MS = 500;
const MAX_PROBLEM_DURATION_SECONDS = 3600;
// Two windows, because a week says what is happening now and a month says
// whether it kept happening.
const STATS_WINDOWS = [7, 30];
const STATS_LISTED_COLLECTIONS = 10;

// An empty selection means every type rather than none: the panel opens showing
// the whole shelf, and clearing the filter has to get back to exactly that.
let selectedCategories = new Set(readStoredCategories());

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
  applyRole(attempt.body.admin);
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
  // Tell the server before discarding the token, so the sign-out is recorded;
  // failing to reach it must not stop the sign-out itself.
  if (sessionToken) {
    fetch(readerPath("/api/session"), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${sessionToken}` },
    }).catch(() => undefined);
  }
  clearSession();
  user = undefined;
  applyRole(false);
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
    statusFeedback.textContent = "";
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

// Never backwards. A flagged problem used to count as pending, so flagging one
// cost you your place in the booklet and the flag went unused. Flags are the
// drill list for after the pass instead: they only decide where you land once
// nothing in the booklet is unseen.
function firstPendingIndex(problems, statuses) {
  const unseen = problems.findIndex(({ id }) => !statuses[id]);
  if (unseen !== -1) return unseen;
  const flagged = problems.findIndex(({ id }) => statuses[id].status === "revisit");
  return flagged === -1 ? 0 : flagged;
}

function getSavedCollection(collectionCatalog) {
  const saved = localStorage.getItem(COLLECTION_STORAGE_KEY);
  return collectionCatalog.some(({ slug }) => slug === saved)
    ? saved
    : collectionCatalog[0].slug;
}

function collectionPath(slug, number) {
  const path = `/collections/${encodeURIComponent(slug)}`;
  return readerPath(number === undefined ? path : `${path}/${number}`);
}

function currentProblemPath() {
  return collectionPath(collection.slug, collection.problems[currentIndex].number);
}

function getCollectionPath(pathname = window.location.pathname) {
  const internalPathname = stripBasePath(pathname);
  if (internalPathname === null) return { kind: "invalid" };
  if (internalPathname === "/") return { kind: "root" };
  const match = /^\/collections\/([^/]+)(?:\/(\d+))?$/.exec(internalPathname);
  if (!match) return { kind: "invalid" };
  try {
    const slug = decodeURIComponent(match[1]);
    if (!slug || slug.includes("/")) return { kind: "invalid" };
    return { kind: "collection", slug, number: match[2] && Number(match[2]) };
  } catch {
    return { kind: "invalid" };
  }
}

// Problem numbers are one-based and dense, so this is really an index lookup;
// searching by number keeps the URL honest if that ever stops being true.
function problemIndexForNumber(problems, number) {
  const index = problems.findIndex((problem) => problem.number === number);
  if (index === -1) throw new Error(`Problem ${number} is not in this collection.`);
  return index;
}

function stripBasePath(pathname) {
  if (!basePath) return pathname;
  if (pathname === basePath || pathname === `${basePath}/`) return "/";
  if (!pathname.startsWith(`${basePath}/`)) return null;
  return pathname.slice(basePath.length);
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

function readStoredCategories() {
  const stored = localStorage.getItem(CATEGORY_STORAGE_KEY);
  return stored ? stored.split(",").filter(Boolean) : [];
}

function filteredCatalog() {
  if (selectedCategories.size === 0) return catalog;
  return catalog.filter((item) => selectedCategories.has(item.category));
}

function renderCollectionFilters() {
  if (!collectionFilters || catalog.length === 0) return;
  const categories = [...new Set(catalog.map((item) => item.category))].sort();
  // A stored type the catalog no longer offers would hide collections with no
  // pressed button on screen to explain why.
  selectedCategories = new Set(
    [...selectedCategories].filter((category) => categories.includes(category)),
  );
  categoryButtons = [
    createCategoryButton(undefined, "All types", catalog.length),
    ...categories.map((category) =>
      createCategoryButton(
        category,
        category,
        catalog.filter((item) => item.category === category).length,
      ),
    ),
  ];
  collectionFilters.replaceChildren(...categoryButtons.map(({ button }) => button));
}

function createCategoryButton(category, label, count) {
  const isPressed =
    category === undefined ? selectedCategories.size === 0 : selectedCategories.has(category);
  const button = document.createElement("button");
  button.type = "button";
  button.className = ["collection-filter", isPressed ? "is-active" : ""].filter(Boolean).join(" ");
  button.textContent = `${label} (${count})`;
  button.setAttribute("aria-pressed", String(isPressed));
  if (category !== undefined) button.setAttribute("data-collection-category", category);
  button.addEventListener("click", () => toggleCategoryFilter(category));
  return { category, button };
}

// "All types" clears the selection rather than adding a fourth filter, so the
// way back to the full shelf is one press however many types are on.
function toggleCategoryFilter(category) {
  if (category === undefined) selectedCategories.clear();
  else if (selectedCategories.has(category)) selectedCategories.delete(category);
  else selectedCategories.add(category);
  localStorage.setItem(CATEGORY_STORAGE_KEY, [...selectedCategories].join(","));
  renderCollectionList();
  // Rendering replaced the button that was just pressed, and losing focus to
  // the document would drop a keyboard user out of the dialog.
  categoryButtons.find((entry) => entry.category === category)?.button.focus();
}

function renderCollectionList() {
  if (!collectionList) return;
  renderCollectionFilters();
  collectionButtons = filteredCatalog().map((item) => {
    const totals = getCatalogStatusTotals(item.slug);
    const isComplete = totals.solved === item.problem_count;
    // A finished booklet is a full bar even if the count is unusable for a ratio.
    const solvedPercentage = isComplete ? 100 : (totals.solved / item.problem_count) * 100;
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

// Nothing marks the outermost line of a crop as the board's edge, so a crop
// that stops just short of one reads as a corner that isn't there - the wall in
// capturing races 33 looked like it stood on the first line when two more lines
// were hidden, which changes every liberty count. A side whose nearest stone is
// within this many lines of the edge is therefore shown flush with it. The
// stones themselves sit either against an edge or well away from one, so the
// pull-out only ever costs a line or two.
const BOARD_EDGE_REACH = 3;
const LAST_LINE = 18;
// A side that is *not* the board's edge stops this far past the last stone. One
// line was not enough: across the whole shelf a real edge shows nought to three
// free lines, so a cut showing one was pixel-identical to the 21,774 edges that
// also show one - tesuji 4 problems 7 and 13 read as if the position spanned
// the full width of the board. Two lines is the breathing room; the lines
// running off the diagram (see renderBoard) are what actually settle it.
const BOARD_CUT_MARGIN = 2;

// Where one axis of the crop stops, and whether each end is the board's own
// edge or a cut. The renderer draws the two differently, so the caller needs
// the answer, not just the numbers.
function cropSide(lowest, highest) {
  const startAtEdge = lowest <= BOARD_EDGE_REACH;
  const endAtEdge = LAST_LINE - highest <= BOARD_EDGE_REACH;
  return {
    start: startAtEdge ? 0 : lowest - BOARD_CUT_MARGIN,
    end: endAtEdge ? LAST_LINE : highest + BOARD_CUT_MARGIN,
    startAtEdge,
    endAtEdge,
  };
}

// The crop widens only once the solution is on screen. Sizing it for the moves
// from the start would tell you which way they run before you have read it out.
function getBoardCrop(problem, showSolution = false) {
  const stones = [...problem.black, ...problem.white];
  if (showSolution) stones.push(...solutionMoves(problem).map((move) => move.at));
  const columns = stones.map((coordinate) => getCoordinatePosition(coordinate).column);
  const rows = stones.map((coordinate) => getCoordinatePosition(coordinate).row);
  const horizontal = cropSide(Math.min(...columns), Math.max(...columns));
  const vertical = cropSide(Math.min(...rows), Math.max(...rows));
  return {
    minColumn: horizontal.start,
    maxColumn: horizontal.end,
    minRow: vertical.start,
    maxRow: vertical.end,
    columns: horizontal.end - horizontal.start + 1,
    rows: vertical.end - vertical.start + 1,
    leftAtEdge: horizontal.startAtEdge,
    rightAtEdge: horizontal.endAtEdge,
    topAtEdge: vertical.startAtEdge,
    bottomAtEdge: vertical.endAtEdge,
  };
}

function solutionMoves(problem) {
  return Array.isArray(problem.solution) ? problem.solution : [];
}

// The first stone played at a point is the one drawn; a later move on the same
// point captured it first, and Go diagrams caption those rather than hiding a
// number under another. Captures are not replayed, so the diagram is the moves
// laid over the opening position, which is what the sequence is for.
function placeSolution(problem) {
  const numbered = new Map();
  const repeats = [];
  solutionMoves(problem).forEach((move, index) => {
    const number = index + 1;
    const existing = numbered.get(move.at);
    if (existing) {
      repeats.push({ number, at: existing.number });
      return;
    }
    numbered.set(move.at, { color: move.color, number });
  });
  return { numbered, repeats };
}

function renderBoard(problem, showSolution = false) {
  const crop = getBoardCrop(problem, showSolution);
  board.replaceChildren();
  board.style.setProperty("--board-columns", crop.columns);
  board.style.setProperty("--board-rows", crop.rows);
  const grid = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  grid.setAttribute("aria-hidden", "true");
  grid.setAttribute("class", "goban-grid");
  grid.setAttribute("viewBox", `0 0 ${crop.columns} ${crop.rows}`);
  // The stones are placed by the CSS grid, which always fills the board box.
  // Letting the SVG letterbox itself instead would offset every line from the
  // intersection its stone sits on the moment the box is not exactly
  // columns:rows.
  grid.setAttribute("preserveAspectRatio", "none");
  // A real edge stops flush at the last intersection; a cut runs off the
  // diagram, which is how a Go book says "the board continues here" and is the
  // only thing that distinguishes the two - the same crop can be either.
  const top = crop.topAtEdge ? 0.5 : 0;
  const bottom = crop.rows - (crop.bottomAtEdge ? 0.5 : 0);
  const left = crop.leftAtEdge ? 0.5 : 0;
  const right = crop.columns - (crop.rightAtEdge ? 0.5 : 0);
  for (let column = 0; column < crop.columns; column += 1) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const position = column + 0.5;
    line.setAttribute("class", "goban-grid-line goban-grid-line--vertical");
    line.setAttribute("x1", position);
    line.setAttribute("x2", position);
    line.setAttribute("y1", top);
    line.setAttribute("y2", bottom);
    grid.append(line);
  }
  for (let row = 0; row < crop.rows; row += 1) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const position = row + 0.5;
    line.setAttribute("class", "goban-grid-line goban-grid-line--horizontal");
    line.setAttribute("x1", left);
    line.setAttribute("x2", right);
    line.setAttribute("y1", position);
    line.setAttribute("y2", position);
    grid.append(line);
  }
  board.append(grid);

  const { numbered, repeats } = showSolution ? placeSolution(problem) : { numbered: new Map(), repeats: [] };
  const placeStone = (coordinate, color, number) => {
    const position = getCoordinatePosition(coordinate);
    const stone = document.createElement("span");
    stone.className = `stone ${color}${number ? " stone--numbered" : ""}`;
    stone.style.gridColumn = position.column - crop.minColumn + 1;
    stone.style.gridRow = position.row - crop.minRow + 1;
    if (number) stone.textContent = String(number);
    board.append(stone);
  };

  for (const [color, coordinates] of [
    ["black", problem.black],
    ["white", problem.white],
  ]) {
    for (const coordinate of coordinates) {
      // A numbered stone on this point means the opening stone was captured on
      // the way there, so the move is what the board ends up holding.
      if (numbered.has(coordinate)) continue;
      placeStone(coordinate, color);
    }
  }
  for (const [coordinate, { color, number }] of numbered) {
    placeStone(coordinate, color, number);
  }
  renderSolutionNote(showSolution ? repeats : []);
  return crop;
}

function renderSolutionNote(repeats) {
  if (!solutionNote) return;
  solutionNote.textContent = repeats
    .map(({ number, at }) => `${number} at ${at}`)
    .join(" · ");
  solutionNote.hidden = repeats.length === 0;
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
    // A solved problem has nothing left to record, so Solved stops being an
    // action and becomes a label.
    const isSolved = currentStatus === "solved";
    solvedButton.textContent = isSolved ? "Already solved" : "Solved";
    solvedButton.disabled = controlsDisabled || isSolved;
    revisitButton.disabled = controlsDisabled;
    setCollectionControlsDisabled(controlsDisabled);
    setSelectedStatus(solvedButton, isSolved);
    setSelectedStatus(revisitButton, currentStatus === "revisit");
    renderSolutionControl(problem, controlsDisabled);
    renderBoard(problem, isSolutionShown);
    return true;
  } catch (error) {
    setControlsDisabled(true);
    showError(error);
    return false;
  }
}

function renderSolutionControl(problem, controlsDisabled) {
  if (!showSolutionButton) return;
  const hasSolution = solutionMoves(problem).length > 0;
  showSolutionButton.textContent = isSolutionShown ? "Hide solution" : "Show solution";
  showSolutionButton.disabled = controlsDisabled || !hasSolution;
  showSolutionButton.setAttribute("aria-expanded", String(isSolutionShown));
  showSolutionButton.title = hasSolution ? "" : "No solution is recorded for this problem.";
  showSolutionButton.classList.toggle("is-showing", isSolutionShown);
}

function toggleSolution() {
  if (!hasCollection() || isSaving || isLoadingCollection || isDialogOpen()) return;
  if (solutionMoves(collection.problems[currentIndex]).length === 0) return;
  isSolutionShown = !isSolutionShown;
  renderReader();
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
  // The button is disabled in this state, but the guard keeps a keyboard or
  // programmatic path from re-recording a solve that is already stored.
  if (status === "solved" && statuses[problem.id]?.status === "solved") return;
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
    statusFeedback.textContent = "";
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
  const nextIndex = Math.max(
    0,
    Math.min(collection.problems.length - 1, currentIndex + delta),
  );
  if (nextIndex !== currentIndex) isSolutionShown = false;
  currentIndex = nextIndex;
  renderReader();
  syncProblemPath();
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
  if (isStatsPanelOpen()) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeStatsPanel();
      return;
    }
    if (event.key === "Tab") {
      trapStatsPanelFocus(event);
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
  if (statsButton) statsButton.disabled = disabled;
  // The profile stays reachable even when the catalog failed to load: that is
  // exactly when a wrong name most needs correcting.
  if (profileButton) profileButton.disabled = false;
  for (const { option } of collectionButtons) {
    option.disabled = disabled;
  }
  for (const { button } of categoryButtons) {
    button.disabled = disabled;
  }
}

function showError(error) {
  statusFeedback.textContent = error instanceof Error ? error.message : String(error);
  if (error?.name === "SessionExpiredError") {
    clearSession();
    user = undefined;
    applyRole(false);
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
  return (
    isCollectionPanelOpen() ||
    isActivityPanelOpen() ||
    isStatsPanelOpen() ||
    isProfilePanelOpen()
  );
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
    ...categoryButtons.map(({ button }) => button),
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
  if (
    isSaving ||
    isLoadingCollection ||
    isLoadingActivity ||
    isLoadingStats ||
    isActivityPanelOpen() ||
    isStatsPanelOpen() ||
    !collectionPanel
  ) {
    return;
  }
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
    isLoadingStats ||
    isCollectionPanelOpen() ||
    isStatsPanelOpen() ||
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

// -- usage panel (admins only) --------------------------------------------

// The role belongs to the session, not to the browser: remembering it locally
// would either hide the panel from somebody just granted it, or leave a button
// that answers nothing but 403.
function applyRole(admin) {
  isAdmin = Boolean(admin);
  if (!statsButton) return;
  statsButton.hidden = !isAdmin;
  if (!isAdmin && isStatsPanelOpen()) closeStatsPanel({ restoreFocus: false });
}

async function refreshRole() {
  if (!sessionToken) {
    applyRole(false);
    return;
  }
  try {
    applyRole((await fetchJson("/api/session")).admin);
  } catch (error) {
    // Losing the button is the safe direction, and every other request will
    // report a broken session in its own right.
    applyRole(false);
  }
}

function isStatsPanelOpen() {
  return Boolean(statsPanel && !statsPanel.hidden);
}

function getStatsPanelFocusables() {
  return [closeStatsPanelButton, ...statsWindowButtons.map(({ button }) => button)].filter(
    (button) => button && !button.disabled,
  );
}

function focusStatsPanel() {
  closeStatsPanelButton?.focus();
}

function restoreStatsPanelFocus() {
  const invoker = statsPanelInvoker;
  statsPanelInvoker = undefined;
  invoker?.focus();
}

function trapStatsPanelFocus(event) {
  const focusables = getStatsPanelFocusables();
  if (focusables.length === 0) return;
  const activeIndex = focusables.indexOf(document.activeElement);
  const nextIndex = event.shiftKey
    ? (activeIndex <= 0 ? focusables.length : activeIndex) - 1
    : (activeIndex + 1) % focusables.length;
  event.preventDefault();
  focusables[nextIndex].focus();
}

function closeStatsPanel({ restoreFocus = true } = {}) {
  if (!statsPanel) return;
  statsPanel.hidden = true;
  statsButton?.setAttribute("aria-expanded", "false");
  hideModalBackdrop();
  if (restoreFocus) restoreStatsPanelFocus();
}

async function openStatsPanel(event) {
  if (
    !isAdmin ||
    isSaving ||
    isLoadingCollection ||
    isLoadingActivity ||
    isLoadingStats ||
    isCollectionPanelOpen() ||
    isActivityPanelOpen() ||
    !statsPanel
  ) {
    return;
  }
  statsPanelInvoker = event?.currentTarget ?? document.activeElement;
  statsPanel.hidden = false;
  statsButton?.setAttribute("aria-expanded", "true");
  showModalBackdrop();
  renderStatsWindows();
  focusStatsPanel();
  await loadStats(statsDays);
}

function renderStatsWindows() {
  if (!statsWindows) return;
  statsWindowButtons = STATS_WINDOWS.map((days) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = days === statsDays ? "stats-window is-active" : "stats-window";
    button.textContent = `${days} days`;
    button.setAttribute("aria-pressed", days === statsDays ? "true" : "false");
    button.disabled = isLoadingStats;
    button.addEventListener("click", () => loadStats(days));
    return { days, button };
  });
  statsWindows.replaceChildren(...statsWindowButtons.map(({ button }) => button));
}

async function loadStats(days) {
  if (isLoadingStats) return;
  statsDays = days;
  isLoadingStats = true;
  renderStatsWindows();
  setStatsStatus("Loading usage…");
  statsContent?.replaceChildren();
  try {
    renderStats(await fetchJson(`/api/stats?days=${days}`));
    setStatsStatus("");
  } catch (error) {
    statsContent?.replaceChildren();
    setStatsStatus("Usage could not be loaded.");
    showError(error);
  } finally {
    isLoadingStats = false;
    renderStatsWindows();
  }
}

function setStatsStatus(message) {
  if (!statsStatus) return;
  statsStatus.textContent = message;
  statsStatus.hidden = !message;
}

function renderStats(report) {
  if (!statsContent) return;
  const sections = [statsSummary(report)];
  const marked = report.totals.solved + report.totals.revisit;
  if (marked > 0) {
    sections.push(
      statsProfiles(report),
      statsDaysChart(report),
      statsCollections(report),
      statsHours(report),
    );
  }
  if (report.lifetime.length > 0) sections.push(statsLifetime(report));
  statsContent.replaceChildren(...sections.filter(Boolean));
}

function statsSummary(report) {
  const section = document.createElement("section");
  section.className = "stats-summary";
  const window = document.createElement("p");
  window.className = "stats-summary__window";
  window.textContent = `${report.window.start} to ${report.window.end} (${report.window.zone})`;
  const headline = document.createElement("p");
  headline.className = "stats-summary__headline";
  const marked = report.totals.solved + report.totals.revisit;
  headline.textContent = marked
    ? `${countOf(report.totals.profiles, "profile")} active · ` +
      `${marked} marked (${report.totals.solved} solved, ${report.totals.revisit} revisit) · ` +
      `${report.totals.duration} recorded`
    : "No problems marked in this window.";
  section.append(window);
  section.append(headline);
  return section;
}

function statsProfiles(report) {
  const rows = report.profiles.map((profile) => [
    profile.user,
    profile.solved,
    profile.revisit,
    profile.duration,
    profile.active_days,
    profile.median,
    profile.last_mark,
  ]);
  return statsSection(
    "Profiles",
    statsTable(["Profile", "Solved", "Revisit", "Time", "Days", "Median", "Last mark"], rows),
  );
}

function statsDaysChart(report) {
  const busiest = Math.max(...report.days.map((day) => day.count), 0);
  const chart = document.createElement("div");
  chart.className = "stats-days";
  for (const day of report.days) {
    const row = document.createElement("div");
    row.className = "stats-day";
    row.append(statsCell("stats-day__label", day.label));
    row.append(statsCell("stats-day__count", String(day.count)));
    row.append(statsBar(day.count, busiest));
    row.append(
      statsCell(
        "stats-day__who",
        day.by_user
          .slice(0, 3)
          .map(({ user: name, count }) => `${name} ${count}`)
          .join(", "),
      ),
    );
    chart.append(row);
  }
  return statsSection("By day", chart);
}

function statsCollections(report) {
  const listed = report.collections.slice(0, STATS_LISTED_COLLECTIONS);
  const section = statsSection(
    "Collections",
    statsTable(
      ["Collection", "Marked"],
      listed.map((entry) => [entry.slug, entry.count]),
    ),
  );
  const hidden = report.collections.length - listed.length;
  if (hidden > 0) {
    section.append(statsCell("stats-note", `… and ${countOf(hidden, "collection")} more`));
  }
  return section;
}

function statsHours(report) {
  const busiest = Math.max(...report.hours, 0);
  const chart = document.createElement("div");
  chart.className = "stats-hours";
  chart.setAttribute("role", "img");
  chart.setAttribute(
    "aria-label",
    `Problems marked by hour of the day, in ${report.window.zone}: ` +
      report.hours
        .map((count, hour) => (count ? `${hour}:00 ${count}` : ""))
        .filter(Boolean)
        .join(", "),
  );
  report.hours.forEach((count, hour) => {
    const column = document.createElement("div");
    column.className = "stats-hour";
    const fill = document.createElement("div");
    fill.className = "stats-hour__bar";
    fill.style.height = `${busiest > 0 ? Math.round((100 * count) / busiest) : 0}%`;
    column.append(fill);
    // Every sixth hour only: 24 labels side by side are unreadable on a phone.
    column.append(statsCell("stats-hour__label", hour % 6 === 0 ? String(hour) : ""));
    chart.append(column);
  });
  return statsSection(`Time of day (${report.window.zone})`, chart);
}

function statsLifetime(report) {
  return statsSection(
    "All time",
    statsTable(
      ["Profile", "Solved", "Revisit", "Collections", "Since"],
      report.lifetime.map((profile) => [
        profile.user,
        profile.solved,
        profile.revisit,
        profile.collections,
        profile.since,
      ]),
    ),
  );
}

function statsSection(title, body) {
  const section = document.createElement("section");
  section.className = "stats-section";
  const heading = document.createElement("h3");
  heading.className = "stats-section__title";
  heading.textContent = title;
  section.append(heading);
  section.append(body);
  return section;
}

function statsTable(headers, rows) {
  const table = document.createElement("table");
  table.className = "stats-table";
  const head = document.createElement("thead");
  head.append(statsTableRow(headers, "th"));
  const body = document.createElement("tbody");
  for (const cells of rows) body.append(statsTableRow(cells, "td"));
  table.append(head);
  table.append(body);
  return table;
}

function statsTableRow(cells, tag) {
  const row = document.createElement("tr");
  cells.forEach((value, index) => {
    const cell = document.createElement(tag);
    cell.textContent = String(value);
    // Everything but the name is a number or a stamp, and reads better trailing
    // the column it belongs to.
    if (index > 0) cell.className = "stats-number";
    row.append(cell);
  });
  return row;
}

function statsBar(count, busiest) {
  const track = document.createElement("div");
  track.className = "stats-bar";
  const fill = document.createElement("div");
  fill.className = "stats-bar__fill";
  fill.style.width = `${busiest > 0 ? Math.round((100 * count) / busiest) : 0}%`;
  track.append(fill);
  return track;
}

function statsCell(className, text) {
  const cell = document.createElement("span");
  cell.className = className;
  cell.textContent = text;
  return cell;
}

function countOf(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

async function loadActiveCollection(
  slug,
  historyMode = "none",
  shouldApply = () => true,
  number = undefined,
) {
  const nextCollection = await fetchJson(`/api/collections/${encodeURIComponent(slug)}`);
  if (!shouldApply()) return false;
  const nextStatuses = (await fetchJson("/api/progress")).problems;
  if (!shouldApply()) return false;
  const nextIndex =
    number === undefined
      ? firstPendingIndex(nextCollection.problems, nextStatuses)
      : problemIndexForNumber(nextCollection.problems, number);
  collection = nextCollection;
  statuses = nextStatuses;
  currentIndex = nextIndex;
  isSolutionShown = false;
  renderCollectionList();
  renderReader();
  syncProblemPath(historyMode);
  return true;
}

// The displayed problem is part of the URL, so every path into a new problem -
// startup, the chooser, Back, Next - ends here to keep the address bar honest.
function syncProblemPath(historyMode = "replace") {
  const path = currentProblemPath();
  if (historyMode === "push") {
    window.history.pushState({}, "", path);
  } else if (window.location.pathname !== path) {
    window.history.replaceState({}, "", path);
  }
  displayedPathname = path;
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

function getHistoryTarget(pathname) {
  const path = getCollectionPath(pathname);
  if (path.kind === "invalid") {
    throw new Error("Invalid collection URL.");
  }
  const slug = path.kind === "root" ? getSavedCollection(catalog) : path.slug;
  if (!catalog.some((item) => item.slug === slug)) {
    throw new Error("Unknown collection in URL.");
  }
  return { slug, number: path.number };
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
      const { slug, number } = getHistoryTarget(pathname);
      const loaded = await loadActiveCollection(
        slug,
        "none",
        () => requestId === historyRequestId,
        number,
      );
      if (!loaded) continue;
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
    refreshRole();
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
    startupStage = "collection";
    const loaded = await loadActiveCollection(
      slug,
      "none",
      () => startingHistoryRequestId === historyRequestId,
      path.number,
    );
    if (!loaded) return;
    localStorage.setItem(COLLECTION_STORAGE_KEY, slug);
    statusFeedback.textContent = "";
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
showSolutionButton?.addEventListener("click", toggleSolution);
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
statsButton?.addEventListener("click", openStatsPanel);
closeStatsPanelButton?.addEventListener("click", () => closeStatsPanel());
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
