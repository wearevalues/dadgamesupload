import { upload as blobUpload } from "https://esm.sh/@vercel/blob@2.3.1/client";

const dropzone = document.getElementById("dropzone");
const mediaInput = document.getElementById("mediaInput");
const addMoreMediaBtn = document.getElementById("addMoreMediaBtn");
const clearMediaBtn = document.getElementById("clearMediaBtn");
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
const nameInput = document.getElementById("nameInput");

const customProjectValue = "__custom__";

let selectedFiles = [];
let settingsCache = null;
/** Next native picker session should append to selection (Add more). */
let appendNextPick = false;

function fileSignature(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

const MEDIA_EXT = /\.(heic|heif|avif|jpg|jpeg|png|gif|webp|bmp|tif|tiff|mov|mp4|m4v|webm)$/i;
const isSupportedMedia = (file) => {
  const mime = (file.type || "").toLowerCase();
  if (mime.startsWith("image/") || mime.startsWith("video/")) return true;
  // Some devices send photos as application/octet-stream or an empty type; the file input's
  // accept= check can still fail on those — we only validate name/project below, not the file field.
  if ((mime === "application/octet-stream" || mime === "") && MEDIA_EXT.test(file.name || "")) return true;
  return false;
};

const MIME_MAP_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  mov: "video/quicktime",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm"
};

function inferMimeForFile(file) {
  const mime = (file.type || "").toLowerCase();
  if (mime.startsWith("image/") || mime.startsWith("video/")) return file.type;
  const m = /\.([^.]+)$/i.exec(file.name || "");
  const ext = m ? m[1].toLowerCase() : "";
  return MIME_MAP_EXT[ext] || file.type || "application/octet-stream";
}

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

function upsertMeta(selector, attribute, value) {
  if (!value) return;
  let el = document.head.querySelector(selector);
  if (!el) {
    el = document.createElement("meta");
    if (selector.includes("property=")) {
      el.setAttribute("property", selector.match(/property=\"([^\"]+)\"/)?.[1] || "");
    } else if (selector.includes("name=")) {
      el.setAttribute("name", selector.match(/name=\"([^\"]+)\"/)?.[1] || "");
    }
    document.head.appendChild(el);
  }
  el.setAttribute(attribute, value);
}

function applySiteMeta(settings) {
  const site = settings?.site || {};
  const title = site.title || settings?.branding?.title || "Share Your Media";
  const description = site.description || settings?.branding?.subtitle || "Capture your moments and share it with us.";
  const faviconUrl = site.faviconUrl || "";
  const ogImage = site.ogImage || "";

  document.title = title;
  upsertMeta('meta[name="description"]', "content", description);
  upsertMeta('meta[property="og:title"]', "content", title);
  upsertMeta('meta[property="og:description"]', "content", description);
  if (ogImage) upsertMeta('meta[property="og:image"]', "content", ogImage);

  if (faviconUrl) {
    let icon = document.head.querySelector('link[rel="icon"]');
    if (!icon) {
      icon = document.createElement("link");
      icon.setAttribute("rel", "icon");
      document.head.appendChild(icon);
    }
    icon.setAttribute("href", faviconUrl);
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
    settingsCache = settings;
    applyBranding(settings);
    applySiteMeta(settings);
    renderProjects(settings.projects);
  } catch {
    settingsCache = null;
  }
}

async function fetchSettingsFresh() {
  const res = await fetch("/api/settings");
  const settings = await res.json();
  settingsCache = settings;
  return settings;
}

async function parseApiJson(res) {
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    let hint = res.ok
      ? "The server returned an unreadable response."
      : "Server error. Please try again.";
    if (res.status === 413) {
      hint = "Request too large for this host. Try again, or contact support if this persists.";
    } else if (res.status === 504 || res.status === 502) {
      hint = "Service timed out or was busy. Please try again.";
    } else if (!res.ok) {
      hint = `Request failed (HTTP ${res.status}). Please try again.`;
    }
    throw new Error(hint);
  }
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

/** Vercel (and similar) limit for one multipart request — stay under with encoding overhead. */
const MAX_PROXY_UPLOAD_BYTES = 3.4 * 1024 * 1024;

/** Fewer files per request avoids serverless timeouts (especially Drive + Blob commit). Must stay ≤ server limit of 10. */
const MAX_FILES_PER_UPLOAD_BATCH = 5;

/** True for iPhone/iPod, iPad (including iPadOS “desktop” Safari UA), and similar. */
function isIosDevice() {
  const ua = navigator.userAgent || "";
  if (/iP(hone|ad|od)/.test(ua)) return true;
  // iPadOS 13+ often reports Macintosh + touch; “Request Desktop Website” on iPhone can look like Mac too.
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  return false;
}

function totalFileBytes(files) {
  return files.reduce((s, f) => s + f.size, 0);
}

function chunkFiles(files, chunkSize) {
  const out = [];
  for (let i = 0; i < files.length; i += chunkSize) {
    out.push(files.slice(i, i + chunkSize));
  }
  return out;
}

async function uploadOneBatch(name, project, files, destSettings) {
  const provider = destSettings?.destination?.provider;
  if (provider === "google-drive") {
    return uploadToGoogleDrive(name, project, files, destSettings);
  }
  const formData = new FormData();
  files.forEach((file) => formData.append("media", file));
  formData.append("name", name);
  formData.append("project", project);
  const res = await fetch("/api/upload", { method: "POST", body: formData });
  const data = await parseApiJson(res);
  return { fileCount: data.fileCount, destination: data.destination };
}

async function compressImageFileForUpload(file, maxEdge, jpegQuality) {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      let w = bitmap.width;
      let h = bitmap.height;
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", jpegQuality));
      if (!blob) return file;
      const base = (file.name || "photo").replace(/\.[^.]+$/i, "") || "photo";
      return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}

async function shrinkImagesToFitVercelLimit(files, maxTotal) {
  let list = files.slice();
  if (totalFileBytes(list) <= maxTotal) return list;

  list = await Promise.all(
    list.map((f) => (f.type.startsWith("image/") ? compressImageFileForUpload(f, 3200, 0.86) : f))
  );
  if (totalFileBytes(list) <= maxTotal) return list;

  list = await Promise.all(
    list.map((f) => (f.type.startsWith("image/") ? compressImageFileForUpload(f, 2200, 0.8) : f))
  );
  if (totalFileBytes(list) <= maxTotal) return list;

  list = await Promise.all(
    list.map((f) => (f.type.startsWith("image/") ? compressImageFileForUpload(f, 1600, 0.74) : f))
  );
  return list;
}

async function uploadGoogleDriveViaServer(name, project, files) {
  const formData = new FormData();
  files.forEach((file) => formData.append("media", file));
  formData.append("name", name);
  formData.append("project", project);
  const res = await fetch("/api/upload", { method: "POST", body: formData });
  const data = await parseApiJson(res);
  return { fileCount: data.fileCount, destination: data.destination };
}

/** Browser → Google resumable PUT (works on many desktops; often blocked on iOS Safari). */
async function uploadDriveResumableDirect(name, project, files) {
  const uploadBatchId = `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  const uploadedMeta = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const origName = file.name || `upload_${i + 1}`;
    const sessRes = await fetch("/api/upload/drive-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        project,
        originalFilename: origName,
        mimeType: file.type || "",
        uploadBatchId,
        fileIndex: i + 1
      })
    });
    const sess = await parseApiJson(sessRes);
    const contentType = sess.contentType || inferMimeForFile(file);

    let putRes;
    try {
      putRes = await fetch(sess.sessionUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file
      });
    } catch (netErr) {
      const msg = netErr instanceof Error ? netErr.message : String(netErr);
      const err = new Error(
        `Could not upload directly to Google from this browser (${msg}). We'll retry through the site if the file is small enough.`
      );
      err.code = "DIRECT_UPLOAD_NETWORK";
      throw err;
    }

    const putRaw = await putRes.text();
    if (!putRes.ok) {
      throw new Error(
        `Google Drive rejected the file (${putRes.status}). ${putRaw.slice(0, 200)}`.trim()
      );
    }

    let fileMeta;
    try {
      fileMeta = putRaw ? JSON.parse(putRaw) : {};
    } catch {
      throw new Error("Google Drive upload finished but returned an unexpected response.");
    }
    if (!fileMeta.id) {
      throw new Error("Google Drive did not return a file id for the upload.");
    }
    uploadedMeta.push({ id: fileMeta.id, name: fileMeta.name || sess.targetName });
  }

  const logRes = await fetch("/api/upload/drive-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, project, files: uploadedMeta })
  });
  await parseApiJson(logRes);
  return { fileCount: uploadedMeta.length, destination: "google-drive" };
}

async function uploadGoogleDriveViaBlob(name, project, files) {
  const uploadBatchId = `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  const prefix = "media-uploader/incoming";
  let uploadedCount = 0;
  let destination = "google-drive";

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const orig = file.name || `upload_${i + 1}`;
    const safeSeg = orig.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
    const pathname = `${prefix}/${uploadBatchId}/${i + 1}-${safeSeg}`;
    const useMultipart = file.size > 6 * 1024 * 1024;
    const newBlob = await blobUpload(pathname, file, {
      access: "public",
      handleUploadUrl: "/api/media/blob-client",
      clientPayload: JSON.stringify({
        name,
        project,
        originalFilename: orig,
        fileIndex: i + 1
      }),
      multipart: useMultipart
    });

    // Commit each file individually to keep each serverless invocation short.
    const res = await fetch("/api/media/blob-commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        project,
        uploadBatchId,
        files: [{ url: newBlob.url, originalFilename: orig }]
      })
    });
    const data = await parseApiJson(res);
    uploadedCount += data.fileCount || 1;
    destination = data.destination || destination;
  }

  return { fileCount: uploadedCount, destination };
}

async function uploadToGoogleDrive(name, project, files, settingsForUpload) {
  const blobOk =
    settingsForUpload?.client?.blobDriveUpload ?? settingsCache?.client?.blobDriveUpload;
  if (blobOk) {
    return uploadGoogleDriveViaBlob(name, project, files);
  }

  if (isIosDevice()) {
    const prepared = await shrinkImagesToFitVercelLimit(files, MAX_PROXY_UPLOAD_BYTES);
    if (totalFileBytes(prepared) > MAX_PROXY_UPLOAD_BYTES) {
      throw new Error(
        "This upload is too large for Safari (about a 3.4 MB limit per submit on this host). Try a shorter video, fewer files, or open the site on a computer. For photos, we tried shrinking JPEGs automatically — HEIC or originals may need exporting as a smaller JPEG from Photos."
      );
    }
    return uploadGoogleDriveViaServer(name, project, prepared);
  }

  try {
    return await uploadDriveResumableDirect(name, project, files);
  } catch (e) {
    if (totalFileBytes(files) <= MAX_PROXY_UPLOAD_BYTES) {
      return uploadGoogleDriveViaServer(name, project, files);
    }
    throw e instanceof Error
      ? e
      : new Error("Upload failed. Try a smaller file or use a different browser.");
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
  const previewMime = inferMimeForFile(firstFile);

  if (previewMime.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = objectUrl;
    img.alt = "Selected image preview";
    img.onload = () => URL.revokeObjectURL(objectUrl);
    preview.appendChild(img);
  } else if (previewMime.startsWith("video/")) {
    const video = document.createElement("video");
    video.src = objectUrl;
    video.controls = true;
    video.onloadeddata = () => URL.revokeObjectURL(objectUrl);
    preview.appendChild(video);
  } else {
    preview.innerHTML = `<p>Selected: ${firstFile.name} (${formatBytes(firstFile.size)})</p>`;
    URL.revokeObjectURL(objectUrl);
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
    selectedFiles = [];
    renderPreview();
    mediaInput.value = "";
    return;
  }
  selectedFiles = validFiles;
  errorEl.textContent = "";
  renderPreview();
  mediaInput.value = "";
}

function appendFiles(fileList) {
  const incoming = Array.from(fileList);
  const validNew = incoming.filter(isSupportedMedia);
  if (!validNew.length) {
    errorEl.textContent = "Only image and video files are allowed.";
    renderPreview();
    mediaInput.value = "";
    return;
  }
  const existing = new Set(selectedFiles.map(fileSignature));
  const merged = [...selectedFiles];
  for (const f of validNew) {
    if (!existing.has(fileSignature(f))) {
      merged.push(f);
      existing.add(fileSignature(f));
    }
  }
  selectedFiles = merged;
  errorEl.textContent = "";
  renderPreview();
  mediaInput.value = "";
}

dropzone.addEventListener("click", () => {
  appendNextPick = false;
  mediaInput.click();
});
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    appendNextPick = false;
    mediaInput.click();
  }
});

if (addMoreMediaBtn) {
  addMoreMediaBtn.addEventListener("click", () => {
    appendNextPick = true;
    mediaInput.click();
  });
}

if (clearMediaBtn) {
  clearMediaBtn.addEventListener("click", () => {
    appendNextPick = false;
    selectedFiles = [];
    errorEl.textContent = "";
    mediaInput.value = "";
    renderPreview();
  });
}

mediaInput.addEventListener("change", (event) => {
  const list = event.target.files;
  const shouldAppend = appendNextPick;
  appendNextPick = false;
  if (!list || !list.length) {
    mediaInput.value = "";
    return;
  }
  if (shouldAppend) {
    appendFiles(list);
  } else {
    setFiles(list);
  }
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
  errorEl.textContent = "";

  if (!selectedFiles.length) {
    errorEl.textContent = "Please add at least one photo or video.";
    return;
  }

  const name = nameInput.value.trim();
  const projectChoice = projectSelect.value;
  const project = projectChoice === customProjectValue ? projectCustomInput.value.trim() : projectChoice;

  if (!name) {
    errorEl.textContent = "Your Name is required.";
    nameInput.focus();
    return;
  }

  if (!project) {
    errorEl.textContent = "Please choose a project (or Other and type a name).";
    projectSelect.focus();
    return;
  }

  setLoading(true);
  statusEl.textContent = "Uploading...";
  errorEl.textContent = "";

  try {
    const destSettings = await fetchSettingsFresh();
    const batches = chunkFiles(selectedFiles, MAX_FILES_PER_UPLOAD_BATCH);
    let uploadedTotal = 0;
    let lastDestination = "";

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      statusEl.textContent =
        batches.length > 1
          ? `Uploading batch ${i + 1} of ${batches.length} (${batch.length} file${batch.length === 1 ? "" : "s"})…`
          : "Uploading…";

      const data = await uploadOneBatch(name, project, batch, destSettings);
      uploadedTotal += data.fileCount;
      lastDestination = data.destination;
    }

    statusEl.textContent = `Uploaded ${uploadedTotal} file(s) to ${lastDestination}.`;
  } catch (error) {
    errorEl.textContent = error instanceof Error ? error.message : "Upload failed.";
    statusEl.textContent = "";
  } finally {
    setLoading(false);
  }
});

projectSelect.addEventListener("change", syncProjectUI);
loadSettings();
