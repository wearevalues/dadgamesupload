const loginForm = document.getElementById("loginForm");
const settingsForm = document.getElementById("settingsForm");
const adminStatus = document.getElementById("adminStatus");
const logoDropzone = document.getElementById("logoDropzone");
const logoFileInput = document.getElementById("logoFileInput");
const logoUploadStatus = document.getElementById("logoUploadStatus");
let currentLogoUrl = "";
const projectAddInput = document.getElementById("projectAddInput");
const addProjectBtn = document.getElementById("addProjectBtn");
const projectList = document.getElementById("projectList");

function setStatus(message, isError = false) {
  adminStatus.textContent = message;
  adminStatus.style.color = isError ? "#b12c2c" : "#2d6a37";
}

function buildSettingsPayload() {
  return {
    branding: {
      title: document.getElementById("titleInput").value.trim(),
      subtitle: document.getElementById("subtitleInput").value.trim(),
      logoUrl: currentLogoUrl,
      backgroundColor: document.getElementById("bgColorInput").value.trim(),
      cardColor: document.getElementById("cardColorInput").value.trim(),
      surfaceColor: document.getElementById("surfaceColorInput").value.trim(),
      textColor: document.getElementById("textColorInput").value.trim()
    },
    destination: {
      provider: "google-drive",
      driveFolderId: document.getElementById("driveFolderIdInput").value.trim(),
      webhookUrl: document.getElementById("webhookInput").value.trim()
    }
  };
}

function hydrateForm(settings) {
  const branding = settings.branding || {};
  const destination = settings.destination || {};
  document.getElementById("titleInput").value = branding.title || "";
  document.getElementById("subtitleInput").value = branding.subtitle || "";
  currentLogoUrl = branding.logoUrl || "";
  document.getElementById("bgColorInput").value = branding.backgroundColor || "#e8e8e8";
  document.getElementById("cardColorInput").value = branding.cardColor || "#f1f1f1";
  document.getElementById("surfaceColorInput").value = branding.surfaceColor || "#ebebeb";
  document.getElementById("textColorInput").value = branding.textColor || "#323232";
  document.getElementById("driveFolderIdInput").value = destination.driveFolderId || "";
  document.getElementById("webhookInput").value = destination.webhookUrl || "";
}

function renderProjects(projects) {
  const list = Array.isArray(projects) ? projects : [];
  projectList.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("li");
    empty.className = "project-empty";
    empty.textContent = "No projects yet.";
    projectList.appendChild(empty);
    return;
  }

  list.forEach((p) => {
    const name = String(p || "").trim();
    if (!name) return;
    const li = document.createElement("li");
    li.className = "project-pill";
    li.style.display = "flex";
    li.style.alignItems = "center";
    li.style.justifyContent = "space-between";
    li.style.gap = "12px";

    const span = document.createElement("span");
    span.textContent = name;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "project-delete-btn";
    btn.textContent = "Delete";
    btn.addEventListener("click", async () => {
      const ok = confirm(`Delete project "${name}"?`);
      if (!ok) return;

      try {
        setStatus("Deleting project...");
        const res = await fetch("/api/admin/projects/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project: name })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not delete project.");

        renderProjects(data.projects || []);
        setStatus("Project deleted.");
      } catch (error) {
        setStatus(error.message || "Could not delete project.", true);
      }
    });

    li.appendChild(span);
    li.appendChild(btn);
    projectList.appendChild(li);
  });
}

async function fetchAdminSettings() {
  const res = await fetch("/api/admin/settings");
  if (!res.ok) throw new Error("Please unlock the control panel.");
  return res.json();
}

async function showSettingsIfAuthenticated() {
  try {
    const settings = await fetchAdminSettings();
    hydrateForm(settings);
    renderProjects(settings.projects);
    loginForm.classList.add("hidden");
    settingsForm.classList.remove("hidden");
    setStatus("Panel unlocked.");
  } catch {
    loginForm.classList.remove("hidden");
    settingsForm.classList.add("hidden");
    setStatus("Could not load settings. Try signing in again.", true);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.getElementById("password").value;
  setStatus("Unlocking...");
  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed.");
    await showSettingsIfAuthenticated();
  } catch (error) {
    setStatus(error.message || "Unable to unlock panel.", true);
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Saving settings...");
  try {
    const payload = buildSettingsPayload();
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Save failed.");
    setStatus("Saved. Refresh the uploader tab to see updates.");
  } catch (error) {
    setStatus(error.message || "Could not save settings.", true);
  }
});

showSettingsIfAuthenticated();

async function uploadLogoFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    logoUploadStatus.textContent = "Please choose an image file.";
    logoUploadStatus.style.color = "#b12c2c";
    return;
  }

  const data = new FormData();
  data.append("logo", file);
  logoUploadStatus.textContent = "Uploading logo...";
  logoUploadStatus.style.color = "#2d6a37";

  try {
    const res = await fetch("/api/admin/logo", {
      method: "POST",
      body: data
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || "Logo upload failed.");

    currentLogoUrl = payload.logoUrl;
    logoUploadStatus.textContent = "Logo uploaded. Save settings to apply.";
  } catch (error) {
    logoUploadStatus.textContent = error.message || "Logo upload failed.";
    logoUploadStatus.style.color = "#b12c2c";
  }
}

logoDropzone.addEventListener("click", () => logoFileInput.click());
logoDropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    logoFileInput.click();
  }
});

logoFileInput.addEventListener("change", (event) => {
  if (event.target.files && event.target.files[0]) {
    uploadLogoFile(event.target.files[0]);
  }
});

["dragenter", "dragover"].forEach((name) => {
  logoDropzone.addEventListener(name, (event) => {
    event.preventDefault();
    logoDropzone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((name) => {
  logoDropzone.addEventListener(name, (event) => {
    event.preventDefault();
    logoDropzone.classList.remove("dragging");
  });
});

logoDropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) uploadLogoFile(file);
});

addProjectBtn.addEventListener("click", async () => {
  const value = (projectAddInput?.value || "").trim();
  if (!value) {
    setStatus("Enter a project name.", true);
    return;
  }

  setStatus("Adding project...");
  try {
    const res = await fetch("/api/admin/projects/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not add project.");

    renderProjects(data.projects);
    projectAddInput.value = "";
    setStatus("Project added.");
  } catch (error) {
    setStatus(error.message || "Could not add project.", true);
  }
});
