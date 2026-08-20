const timelineElement = document.querySelector("#timeline");
const statusElement = document.querySelector("#status");
const yearsElement = document.querySelector("#years");
const sentinel = document.querySelector("#sentinel");
const batchSize = 14;

let groups = [];
let rendered = 0;

function mediaUrl(path, thumbnail = false) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/gallery/raw/${encoded}${thumbnail ? "?th=j" : "?v"}`;
}

function heading(date, count) {
  const value = new Date(`${date}T12:00:00Z`);
  const time = document.createElement("time");
  time.dateTime = date;
  time.textContent = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
  const total = document.createElement("span");
  total.textContent = `${count} ${count === 1 ? "item" : "items"}`;
  const element = document.createElement("h2");
  element.className = "day-heading";
  element.append(time, total);
  return element;
}

function renderGroup(group) {
  const section = document.createElement("section");
  section.className = "day";
  section.id = `date-${group.date}`;
  section.dataset.year = group.date.slice(0, 4);
  section.append(heading(group.date, group.items.length));

  const grid = document.createElement("div");
  grid.className = "grid";
  for (const item of group.items) {
    const link = document.createElement("a");
    link.className = "photo";
    link.href = mediaUrl(item.path);
    link.title = item.name;
    link.setAttribute("aria-label", `open ${item.name}`);

    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.src = mediaUrl(item.path, true);
    image.addEventListener("load", () => image.classList.add("loaded"), { once: true });
    link.append(image);

    if (item.type === "video") {
      const badge = document.createElement("span");
      badge.className = "video-badge";
      badge.setAttribute("aria-hidden", "true");
      badge.textContent = "▶";
      link.append(badge);
    }
    grid.append(link);
  }
  section.append(grid);
  timelineElement.append(section);
}

function renderThrough(index = rendered + batchSize) {
  const target = Math.min(index, groups.length);
  while (rendered < target) renderGroup(groups[rendered++]);
}

function renderYears() {
  const firstByYear = new Map();
  groups.forEach((group, index) => {
    const year = group.date.slice(0, 4);
    if (!firstByYear.has(year)) firstByYear.set(year, index);
  });
  for (const [year, index] of firstByYear) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = year;
    button.addEventListener("click", () => {
      renderThrough(index + 1);
      document.querySelector(`#date-${groups[index].date}`).scrollIntoView();
    });
    yearsElement.append(button);
  }
}

const observer = new IntersectionObserver(
  (entries) => {
    if (entries.some((entry) => entry.isIntersecting)) renderThrough();
  },
  { rootMargin: "800px" }
);
observer.observe(sentinel);

fetch("/gallery/api/timeline")
  .then((response) => {
    if (!response.ok) throw new Error(`gallery returned http ${response.status}`);
    return response.json();
  })
  .then((timeline) => {
    groups = timeline.groups;
    statusElement.textContent = `${timeline.itemCount.toLocaleString()} photos and videos`;
    timelineElement.setAttribute("aria-busy", "false");
    renderYears();
    renderThrough();
  })
  .catch((error) => {
    timelineElement.setAttribute("aria-busy", "false");
    const message = document.createElement("p");
    message.className = "error";
    message.textContent = `could not load the archive. ${error.message}`;
    timelineElement.replaceChildren(message);
    statusElement.textContent = "archive unavailable";
  });
