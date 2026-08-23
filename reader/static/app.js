const board = document.querySelector("#board");
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
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const name = window.prompt("Your name for local progress:", "")?.trim();
  if (!name) throw new Error("A name is required to track progress.");
  localStorage.setItem(key, name);
  return name;
}

function firstPendingIndex(problems, statuses) {
  const index = problems.findIndex(
    ({ id }) => !statuses[id] || statuses[id].status === "revisit",
  );
  return index === -1 ? 0 : index;
}

function renderBoard(problem) {
  board.replaceChildren();
  for (const [color, coordinates] of [
    ["black", problem.black],
    ["white", problem.white],
  ]) {
    for (const coordinate of coordinates) {
      const stone = document.createElement("span");
      stone.className = `stone ${color}`;
      stone.style.gridColumn = coordinate.charCodeAt(0) - 96;
      stone.style.gridRow = coordinate.charCodeAt(1) - 96;
      board.append(stone);
    }
  }
}

function renderReader() {
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
  previousButton.disabled = currentIndex === 0;
  nextButton.disabled = currentIndex === collection.problems.length - 1;
  setSelectedStatus(solvedButton, currentStatus === "solved");
  setSelectedStatus(revisitButton, currentStatus === "revisit");
  renderBoard(problem);
}

function setSelectedStatus(button, selected) {
  button.classList.toggle("is-selected", selected);
  button.setAttribute("aria-pressed", String(selected));
}

async function setCurrentStatus(status) {
  try {
    const problem = collection.problems[currentIndex];
    const savedProgress = await fetchJson("/api/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, problem_id: problem.id, status }),
    });
    statuses = savedProgress.problems;
    renderReader();
    statusFeedback.textContent = `Problem ${problem.number} marked ${status}.`;
  } catch (error) {
    statusFeedback.textContent = error.message;
  }
}

function navigate(delta) {
  currentIndex = Math.max(
    0,
    Math.min(collection.problems.length - 1, currentIndex + delta),
  );
  renderReader();
}

function handleWheel(event) {
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

async function startReader() {
  try {
    user = getOrPromptUser();
    collection = await fetchJson("/api/collection");
    const progress = await fetchJson(`/api/progress?user=${encodeURIComponent(user)}`);
    statuses = progress.problems;
    currentIndex = firstPendingIndex(collection.problems, statuses);
    renderReader();
    statusFeedback.textContent = `Tracking progress for ${user}.`;
  } catch (error) {
    statusFeedback.textContent = error.message;
  }
}

previousButton.addEventListener("click", () => navigate(-1));
nextButton.addEventListener("click", () => navigate(1));
solvedButton.addEventListener("click", () => setCurrentStatus("solved"));
revisitButton.addEventListener("click", () => setCurrentStatus("revisit"));
document.addEventListener("keydown", (event) => {
  if (["ArrowLeft", "ArrowUp"].includes(event.key)) navigate(-1);
  if (["ArrowRight", "ArrowDown"].includes(event.key)) navigate(1);
});
document.addEventListener("wheel", handleWheel, { passive: true });

startReader();
