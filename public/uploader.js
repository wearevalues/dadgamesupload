const dropzone = document.getElementById("dropzone");
const mediaInput = document.getElementById("mediaInput");
const preview = document.getElementById("preview");
const selectedList = document.getElementById("selectedList");
const errorEl = document.getElementById("error");
const statusEl = document.getElementById("status");
const submitBtn = document.getElementById("submitBtn");
const form = document.getElementById("uploadForm");
const spinner = submitBtn.querySelector(".spinner");
const titleEl = document.getElementById("title");
const subtitleEl = document.getElementById("subtitle");
const logoEl = document.getElementById("brandLogoTop");
const projectSelect = document.getElementById("projectSelect");
const projectCustomInput = document.getElementById("projectCustomInput");

const customProjectValue = "__custom__";

let selectedFiles = [];

const isSupportedMedia = (file) => file.type.startsWith("image/") || file.type.startsWith("video/");

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading || !selectedFiles.length;
  submitBtn.classList.toggle("is-loading", isLoading);
  spinner.classList.toggle("hidden", !isLoading);
}

function applyBranding(settings) {
  if (!settings || !settings.branding) return;
  const { branding } = settings;
  document.documentElement.style.setProperty("--bg", branding.backgroundColor || "#e8e8e8");
  document.documentElement.style.setProperty("--panel", branding.cardColor || "#f1f1f1");
  document.documentElement.style.setProperty("--input-bg", branding.surfaceColor || "#ebebeb");
  document.documentElement.style.setProperty("--text", branding.textColor || "#323232");
  titleEl.textContent = branding.title || "Share Your Media";
  subtitleEl.textContent = branding.subtitle || "Capture your moments and share it with us.";
  if (branding.logoUrl) {
    logoEl.src = branding.logoUrl;
    logoEl.classList.remove("hidden");
  } else {
    logoEl.classList.add("hidden");
  }
}

function renderProjects(projects) {
  const list = Array.isArray(projects) ? projects : [];

  projectSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = "Select a project";
  projectSelect.appendChild(placeholder);

  list.forEach((p) => {
    const name = String(p || "").trim();
    if (!name) return;
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    projectSelect.appendChild(opt);
  });

  const other = document.createElement("option");
  other.value = customProjectValue;
  other.textContent = "Other (type below)";
  projectSelect.appendChild(other);

  syncProjectUI();
}

function syncProjectUI() {
  if (projectSelect.value === customProjectValue) {
    projectCustomInput.classList.remove("hidden");
    projectCustomInput.disabled = false;
  } else {
    projectCustomInput.classList.add("hidden");
    projectCustomInput.disabled = true;
    projectCustomInput.value = "";
  }
}

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    const settings = await res.json();
    applyBranding(settings);
    renderProjects(settings.projects);
  } catch {
    // keep defaults if settings load fails
  }
}

function renderPreview() {
  preview.innerHTML = "";
  selectedList.innerHTML = "";
  errorEl.textContent = "";

  if (!selectedFiles.length) {
    preview.innerHTML = "<p>No media selected yet.</p>";
    submitBtn.disabled = true;
    return;
  }

  submitBtn.disabled = false;
  const firstFile = selectedFiles[0];
  const objectUrl = URL.createObjectURL(firstFile);

  if (firstFile.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = objectUrl;
    img.alt = "Selected image preview";
    img.onload = () => URL.revokeObjectURL(objectUrl);
    preview.appendChild(img);
  } else {
    const video = document.createElement("video");
    video.src = objectUrl;
    video.controls = true;
    video.onloadeddata = () => URL.revokeObjectURL(objectUrl);
    preview.appendChild(video);
  }

  selectedFiles.forEach((file) => {
    const item = document.createElement("li");
    item.textContent = `${file.name} (${formatBytes(file.size)})`;
    selectedList.appendChild(item);
  });
}

function setFiles(fileList) {
  const incoming = Array.from(fileList);
  const validFiles = incoming.filter(isSupportedMedia);
  if (!validFiles.length) {
    errorEl.textContent = "Only image and video files are allowed.";
    return;
  }
  selectedFiles = validFiles;
  renderPreview();
}

dropzone.addEventListener("click", () => mediaInput.click());
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    mediaInput.click();
  }
});

mediaInput.addEventListener("change", (event) => {
  if (event.target.files) setFiles(event.target.files);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
  });
});

dropzone.addEventListener("drop", (event) => {
  if (event.dataTransfer?.files) setFiles(event.dataTransfer.files);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  if (!selectedFiles.length) {
    errorEl.textContent = "Please add at least one photo or video.";
    return;
  }

  const formData = new FormData();
  const name = document.getElementById("nameInput").value.trim();
  const projectChoice = projectSelect.value;
  const project = projectChoice === customProjectValue ? projectCustomInput.value.trim() : projectChoice;

  if (!name) {
    errorEl.textContent = "Your Name is required.";
    return;
  }

  if (!project) {
    errorEl.textContent = "Project is required.";
    return;
  }

  selectedFiles.forEach((file) => formData.append("media", file));
  formData.append("name", name);
  formData.append("project", project);

  setLoading(true);
  statusEl.textContent = "Uploading...";
  errorEl.textContent = "";

  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Upload failed.");
    }
    statusEl.textContent = `Uploaded ${data.fileCount} file(s) to ${data.destination}.`;
  } catch (error) {
    errorEl.textContent = error.message || "Upload failed.";
    statusEl.textContent = "";
  } finally {
    setLoading(false);
  }
});

projectSelect.addEventListener("change", syncProjectUI);
loadSettings();
