const loginForm = document.getElementById("loginForm");
const settingsForm = document.getElementById("settingsForm");
const adminStatus = document.getElementById("adminStatus");
const logoDropzone = document.getElementById("logoDropzone");
const logoFileInput = document.getElementById("logoFileInput");
const logoUploadStatus = document.getElementById("logoUploadStatus");
let currentLogoUrl = "";

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

async function fetchAdminSettings() {
  const res = await fetch("/api/admin/settings");
  if (!res.ok) throw new Error("Please unlock the control panel.");
  return res.json();
}

async function showSettingsIfAuthenticated() {
  try {
    const settings = await fetchAdminSettings();
    hydrateForm(settings);
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
