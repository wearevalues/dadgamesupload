const express = require("express");
const cookieSession = require("cookie-session");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { Readable } = require("stream");
const { google } = require("googleapis");
const { handleUpload } = require("@vercel/blob/client");
const { del } = require("@vercel/blob");

const app = express();
app.set("trust proxy", 1);
const port = process.env.PORT || 4173;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "password";
const SESSION_SECRET = process.env.SESSION_SECRET || "replace-this-secret";

const isVercel = Boolean(process.env.VERCEL);
const writableRoot = isVercel ? path.join(process.env.TMPDIR || "/tmp", "photo-uploader") : __dirname;
const dataDir = path.join(writableRoot, "data");
const uploadsDir = path.join(writableRoot, "uploads");
const publicUploadsDir = path.join(writableRoot, "uploads-public");
const settingsPath = path.join(dataDir, "settings.json");
const submissionsCsvPath = path.join(dataDir, "submissions.csv");

const defaultSettings = {
  site: {
    title: "Share Your Media",
    description: "Capture your moments and share it with us.",
    faviconUrl: "",
    ogImage: ""
  },
  branding: {
    title: "Share Your Media",
    subtitle: "Capture your moments and share it with us.",
    backgroundColor: "#e8e8e8",
    cardColor: "#f1f1f1",
    surfaceColor: "#ebebeb",
    textColor: "#323232",
    logoUrl: ""
  },
  destination: {
    provider: "local",
    driveFolderId: "",
    webhookUrl: "",
    note: "Use local while building. Add API integration credentials for cloud providers."
  },
  projects: []
};

async function ensureStorage() {
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(uploadsDir, { recursive: true });
  await fsp.mkdir(publicUploadsDir, { recursive: true });
  if (!fs.existsSync(settingsPath)) {
    await fsp.writeFile(settingsPath, JSON.stringify(defaultSettings, null, 2), "utf8");
  }
  if (!fs.existsSync(submissionsCsvPath)) {
    await fsp.writeFile(
      submissionsCsvPath,
      "timestamp,name,city,destination,file_count,file_names,file_refs\n",
      "utf8"
    );
  }
}

function mergeEnvIntoSettings(settings) {
  const out = {
    ...settings,
    site: { ...(settings.site || {}) },
    branding: { ...settings.branding },
    destination: { ...settings.destination }
  };
  const pick = (v) => (v != null && String(v).trim() !== "" ? String(v).trim() : null);
  if (pick(process.env.SITE_TITLE)) out.site.title = pick(process.env.SITE_TITLE);
  if (pick(process.env.SITE_DESCRIPTION)) out.site.description = pick(process.env.SITE_DESCRIPTION);
  if (pick(process.env.SITE_FAVICON_URL)) out.site.faviconUrl = pick(process.env.SITE_FAVICON_URL);
  if (pick(process.env.SITE_OG_IMAGE)) out.site.ogImage = pick(process.env.SITE_OG_IMAGE);
  if (pick(process.env.BRANDING_LOGO_URL)) out.branding.logoUrl = pick(process.env.BRANDING_LOGO_URL);
  if (pick(process.env.BRANDING_TITLE)) out.branding.title = pick(process.env.BRANDING_TITLE);
  if (pick(process.env.BRANDING_SUBTITLE)) out.branding.subtitle = pick(process.env.BRANDING_SUBTITLE);
  if (pick(process.env.BRANDING_BACKGROUND_COLOR)) out.branding.backgroundColor = pick(process.env.BRANDING_BACKGROUND_COLOR);
  if (pick(process.env.BRANDING_CARD_COLOR)) out.branding.cardColor = pick(process.env.BRANDING_CARD_COLOR);
  if (pick(process.env.BRANDING_SURFACE_COLOR)) out.branding.surfaceColor = pick(process.env.BRANDING_SURFACE_COLOR);
  if (pick(process.env.BRANDING_TEXT_COLOR)) out.branding.textColor = pick(process.env.BRANDING_TEXT_COLOR);
  const envFolder = pick(process.env.GOOGLE_DRIVE_FOLDER_ID);
  const savedFolder = pick(out.destination.driveFolderId);
  if (envFolder && !savedFolder) {
    out.destination.driveFolderId = envFolder;
  }
  const effectiveFolder = pick(out.destination.driveFolderId);
  if (effectiveFolder && out.destination.provider === "local") {
    out.destination.provider = "google-drive";
  }
  return out;
}

async function readSettingsBlob() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  try {
    const { list } = require("@vercel/blob");
    const { blobs } = await list({ prefix: "media-uploader/settings/", token });
    const jsonBlobs = blobs.filter((b) => b.pathname.endsWith(".json"));
    if (!jsonBlobs.length) return null;
    jsonBlobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const res = await fetch(jsonBlobs[0].url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function writeSettingsBlob(payload) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return;
  try {
    const { put, list, del } = require("@vercel/blob");
    const prefix = "media-uploader/settings/";
    const { blobs } = await list({ prefix, token });
    for (const b of blobs) {
      await del(b.url, { token });
    }
    await put(`${prefix}site-settings.json`, JSON.stringify(payload), {
      access: "public",
      addRandomSuffix: false,
      token
    });
  } catch (err) {
    console.error("writeSettingsBlob:", err.message);
  }
}

async function readSettings() {
  let parsed = null;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    parsed = await readSettingsBlob();
  }
  if (!parsed) {
    try {
      const raw = await fsp.readFile(settingsPath, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
  }
  const merged = {
    ...defaultSettings,
    ...parsed,
    site: { ...(defaultSettings.site || {}), ...((parsed && parsed.site) || {}) },
    branding: { ...defaultSettings.branding, ...(parsed.branding || {}) },
    destination: { ...defaultSettings.destination, ...(parsed.destination || {}) }
  };
  return mergeEnvIntoSettings(merged);
}

function escapeHtmlAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function buildUploaderHeadHtml(settings, canonicalUrl) {
  const site = settings.site || {};
  const branding = settings.branding || {};
  const title = (site.title || branding.title || defaultSettings.branding.title).trim();
  const description = (site.description || branding.subtitle || defaultSettings.site.description).trim();
  const faviconUrl = (site.faviconUrl || "").trim();
  const ogImage = (site.ogImage || "").trim();
  const iconHref = faviconUrl || "/favicon.ico";

  const lines = [
    `<title>${escapeHtmlAttr(title)}</title>`,
    `<meta name="description" content="${escapeHtmlAttr(description)}" />`,
    `<meta property="og:title" content="${escapeHtmlAttr(title)}" />`,
    `<meta property="og:description" content="${escapeHtmlAttr(description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeHtmlAttr(canonicalUrl)}" />`
  ];

  if (ogImage) {
    lines.push(`<meta property="og:image" content="${escapeHtmlAttr(ogImage)}" />`);
    lines.push(`<meta name="twitter:card" content="summary_large_image" />`);
    lines.push(`<meta name="twitter:image" content="${escapeHtmlAttr(ogImage)}" />`);
  } else {
    lines.push(`<meta name="twitter:card" content="summary" />`);
  }
  lines.push(`<meta name="twitter:title" content="${escapeHtmlAttr(title)}" />`);
  lines.push(`<meta name="twitter:description" content="${escapeHtmlAttr(description)}" />`);
  lines.push(`<link rel="icon" href="${escapeHtmlAttr(iconHref)}" sizes="any" />`);

  return `    ${lines.join("\n    ")}`;
}

let cachedUploaderIndexTemplate = null;
async function getUploaderIndexTemplate() {
  if (!cachedUploaderIndexTemplate) {
    cachedUploaderIndexTemplate = await fsp.readFile(path.join(__dirname, "views", "index.html"), "utf8");
  }
  return cachedUploaderIndexTemplate;
}

async function sendUploaderIndexHtml(req, res, next) {
  try {
    const settings = await readSettings();
    const proto = req.get("x-forwarded-proto") || req.protocol || "https";
    const host = req.get("host") || "";
    const pathPart = (req.originalUrl || "/").split("?")[0];
    const canonicalUrl = host ? `${proto}://${host}${pathPart}` : pathPart;
    const tpl = await getUploaderIndexTemplate();
    const marker = "<!-- __UPLOADER_HEAD__ -->";
    if (!tpl.includes(marker)) {
      return next();
    }
    const html = tpl.replace(marker, buildUploaderHeadHtml(settings, canonicalUrl));
    res.type("html").send(html);
  } catch (err) {
    next(err);
  }
}

async function writeSettings(next) {
  await fsp.writeFile(settingsPath, JSON.stringify(next, null, 2), "utf8");
  await writeSettingsBlob(next);
}

function sanitizePart(value) {
  return (value || "")
    .toString()
    .trim()
    .replace(/[^\w-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function csvEscape(value) {
  const str = value == null ? "" : String(value);
  return `"${str.replace(/"/g, "\"\"")}"`;
}

async function appendSubmissionCsv(entry) {
  const row = [
    entry.timestamp,
    entry.name,
    entry.city || "",
    entry.destination,
    entry.fileCount,
    entry.fileNames.join("|"),
    entry.fileRefs.join("|")
  ]
    .map(csvEscape)
    .join(",");

  await fsp.appendFile(submissionsCsvPath, `${row}\n`, "utf8");
}

function resolveServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  }

  if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    const fullPath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_FILE);
    const raw = fs.readFileSync(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  }

  throw new Error("Google service account credentials are not configured.");
}

function getDriveClient() {
  const serviceAccount = resolveServiceAccount();
  const auth = new google.auth.JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"]
  });
  return google.drive({ version: "v3", auth });
}

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm"
};

function inferMimeFromName(originalname, reportedMime) {
  const mime = (reportedMime || "").toLowerCase();
  if (mime.startsWith("image/") || mime.startsWith("video/")) return reportedMime;
  const ext = path.extname(originalname || "").toLowerCase();
  return MIME_BY_EXT[ext] || reportedMime || "application/octet-stream";
}

function inferMimeForDriveUpload(file) {
  return inferMimeFromName(file.originalname, file.mimetype);
}

async function createDriveResumableUploadSession(parentFolderId, driveFileName, mimeType) {
  const serviceAccount = resolveServiceAccount();
  const auth = new google.auth.JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"]
  });
  const access = await auth.getAccessToken();
  const token = typeof access === "string" ? access : access?.token;
  if (!token) throw new Error("Could not obtain Google access token.");

  const initRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType
      },
      body: JSON.stringify({
        name: driveFileName,
        parents: [parentFolderId]
      })
    }
  );

  if (!initRes.ok) {
    const fragment = (await initRes.text()).slice(0, 400);
    throw new Error(`Drive resumable session failed (${initRes.status}): ${fragment}`);
  }

  const sessionUrl = initRes.headers.get("Location") || initRes.headers.get("location");
  if (!sessionUrl) throw new Error("Drive did not return a resumable upload URL.");
  return sessionUrl;
}

async function uploadFileToGoogleDrive(file, folderId, targetName) {
  const drive = getDriveClient();
  const response = await drive.files.create({
    requestBody: {
      name: targetName,
      parents: [folderId]
    },
    media: {
      mimeType: inferMimeForDriveUpload(file),
      body: fs.createReadStream(file.path)
    },
    fields: "id,name,webViewLink,webContentLink,mimeType,size",
    supportsAllDrives: true
  });

  return response.data;
}

async function uploadReadableToGoogleDrive(nodeReadable, folderId, targetName, mimeType) {
  const drive = getDriveClient();
  const response = await drive.files.create({
    requestBody: {
      name: targetName,
      parents: [folderId]
    },
    media: {
      mimeType: mimeType || "application/octet-stream",
      body: nodeReadable
    },
    fields: "id,name,webViewLink,webContentLink,mimeType,size",
    supportsAllDrives: true
  });

  return response.data;
}

function isAllowedBlobHttpUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    return /(^|\.)blob\.vercel-storage\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function sanitizeDriveFolderName(value) {
  return (value || "")
    .toString()
    .trim()
    .replace(/[\/\\]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function escapeDriveQueryString(value) {
  // Drive query strings are wrapped in single quotes, so escape any single quotes.
  return (value || "").toString().replace(/'/g, "\\'");
}

async function getOrCreateDriveFolder(parentFolderId, folderName) {
  const drive = getDriveClient();
  const folderQuery = `name='${escapeDriveQueryString(folderName)}' and mimeType='application/vnd.google-apps.folder' and '${parentFolderId}' in parents and trashed=false`;

  const listRes = await drive.files.list({
    q: folderQuery,
    fields: "files(id,name)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  const existing = listRes.data.files && listRes.data.files[0];
  if (existing && existing.id) return existing.id;

  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId]
    },
    fields: "id",
    supportsAllDrives: true
  });

  return createRes.data.id;
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: "Not authenticated." });
}

const MEDIA_UPLOAD_EXT = /\.(heic|heif|avif|jpg|jpeg|png|gif|webp|bmp|tif|tiff|mov|mp4|m4v|webm)$/i;

function isAllowedUploadMedia(file) {
  const mime = (file.mimetype || "").toLowerCase();
  if (mime.startsWith("image/") || mime.startsWith("video/")) return true;
  if (mime === "application/octet-stream" || mime === "" || mime === "binary/octet-stream") {
    return MEDIA_UPLOAD_EXT.test(file.originalname || "");
  }
  return false;
}

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await fsp.mkdir(uploadsDir, { recursive: true });
      cb(null, uploadsDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedUploadMedia(file)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image/video files are allowed."));
  }
});

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fsp.mkdir(publicUploadsDir, { recursive: true });
        cb(null, publicUploadsDir);
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
      cb(null, `logo-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) return cb(null, true);
    return cb(new Error("Only image files allowed for logo."));
  }
});

app.use(express.json({ limit: "5mb" }));
app.use(
  cookieSession({
    name: "session",
    keys: [SESSION_SECRET],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: isVercel || process.env.NODE_ENV === "production",
    path: "/"
  })
);

const storageReady = ensureStorage();

app.use(async (_req, _res, next) => {
  try {
    await storageReady;
    next();
  } catch (error) {
    next(error);
  }
});

app.use("/uploads", express.static(publicUploadsDir));
app.get(["/", "/index.html"], sendUploaderIndexHtml);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/settings", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const settings = await readSettings();
  res.json({
    ...settings,
    client: {
      blobDriveUpload:
        Boolean(process.env.BLOB_READ_WRITE_TOKEN) &&
        settings.destination.provider === "google-drive"
    }
  });
});

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password." });
  }
  req.session.isAdmin = true;
  return res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  req.session = null;
  return res.json({ ok: true });
});

app.get("/api/admin/settings", requireAdmin, async (_req, res) => {
  const settings = await readSettings();
  res.json(settings);
});

app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const currentSettings = await readSettings();
  const nextSettings = {
    ...defaultSettings,
    ...payload,
    branding: { ...defaultSettings.branding, ...(payload.branding || {}) },
    destination: { ...defaultSettings.destination, ...(payload.destination || {}) },
    projects: Array.isArray(payload.projects) ? payload.projects : currentSettings.projects || defaultSettings.projects
  };
  await writeSettings(nextSettings);
  const settings = await readSettings();
  res.json({ ok: true, settings });
});

app.post("/api/admin/logo", requireAdmin, logoUpload.single("logo"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No logo file uploaded." });
  }
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    try {
      const { put } = require("@vercel/blob");
      const buffer = await fsp.readFile(req.file.path);
      await fsp.unlink(req.file.path).catch(() => {});
      const ext = path.extname(req.file.originalname || "").toLowerCase() || ".png";
      const { url } = await put(`media-uploader/brand/logo-${Date.now()}${ext}`, buffer, {
        access: "public",
        addRandomSuffix: false,
        token
      });
      return res.json({ ok: true, logoUrl: url });
    } catch (err) {
      return res.status(500).json({ error: `Logo upload failed: ${err.message}` });
    }
  }
  const logoUrl = `/uploads/${req.file.filename}`;
  return res.json({ ok: true, logoUrl });
});

app.post("/api/admin/projects/add", requireAdmin, async (req, res) => {
  const projectRaw = (req.body?.project || "").trim();
  if (!projectRaw) {
    return res.status(400).json({ error: "Project is required." });
  }

  const current = await readSettings();
  const existing = Array.isArray(current.projects) ? current.projects : [];

  const normalized = projectRaw.toLowerCase();
  const alreadyExists = existing.some((p) => String(p || "").toLowerCase() === normalized);
  if (alreadyExists) {
    return res.json({ ok: true, projects: existing });
  }

  const nextProjects = [...existing, projectRaw].slice(0, 200);
  const nextSettings = { ...current, projects: nextProjects };

  await writeSettings(nextSettings);
  const updated = await readSettings();
  return res.json({ ok: true, projects: updated.projects || [] });
});

app.post("/api/admin/projects/delete", requireAdmin, async (req, res) => {
  const projectRaw = (req.body?.project || "").trim();
  if (!projectRaw) {
    return res.status(400).json({ error: "Project is required." });
  }

  const current = await readSettings();
  const existing = Array.isArray(current.projects) ? current.projects : [];
  const normalized = projectRaw.toLowerCase();

  const nextProjects = existing.filter((p) => String(p || "").toLowerCase() !== normalized);
  const nextSettings = { ...current, projects: nextProjects.slice(0, 200) };

  await writeSettings(nextSettings);
  const updated = await readSettings();
  return res.json({ ok: true, projects: updated.projects || [] });
});

app.post("/api/upload/drive-session", express.json({ limit: "32kb" }), async (req, res) => {
  try {
    const settings = await readSettings();
    if (settings.destination.provider !== "google-drive") {
      return res.status(400).json({ error: "Destination is not Google Drive." });
    }

    const name = (req.body?.name || "").trim();
    const project = (req.body?.project || "").trim();
    const originalFilename = ((req.body?.originalFilename || "").trim() || "upload.bin").slice(0, 240);
    const reportedMime = (req.body?.mimeType || "").trim();
    const uploadBatchId = (req.body?.uploadBatchId || "").trim();
    const fileIndex = parseInt(req.body?.fileIndex, 10);

    if (!name) return res.status(400).json({ error: "Your Name is required." });
    if (!project) return res.status(400).json({ error: "Project is required." });
    if (!uploadBatchId || !/^[a-zA-Z0-9_-]{6,80}$/.test(uploadBatchId)) {
      return res.status(400).json({ error: "Invalid upload batch id." });
    }
    if (!Number.isFinite(fileIndex) || fileIndex < 1 || fileIndex > 20) {
      return res.status(400).json({ error: "Invalid file index." });
    }

    const pseudo = { originalname: originalFilename, mimetype: reportedMime };
    if (!isAllowedUploadMedia(pseudo)) {
      return res.status(400).json({ error: "Only image/video files are allowed." });
    }

    const folderId = settings.destination.driveFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID || "";
    if (!folderId) {
      return res.status(400).json({
        error: "Google Drive folder is not configured in admin or environment."
      });
    }

    const projectFolderName = sanitizeDriveFolderName(project);
    const projectFolderId = await getOrCreateDriveFolder(folderId, projectFolderName);
    const safeProjectPart = sanitizePart(projectFolderName) || "project";
    const safeName = sanitizePart(name) || "anon";
    const safeOriginal = originalFilename.replace(/[^\w.-]/g, "_");
    const targetName = `${safeProjectPart}_${safeName}_${uploadBatchId}_${fileIndex}_${safeOriginal}`;
    const mimeType = inferMimeFromName(originalFilename, reportedMime);
    const sessionUrl = await createDriveResumableUploadSession(projectFolderId, targetName, mimeType);

    return res.json({ sessionUrl, contentType: mimeType, targetName });
  } catch (e) {
    console.error("/api/upload/drive-session:", e);
    return res.status(500).json({ error: e.message || "Could not start Google Drive upload." });
  }
});

app.post("/api/media/blob-client", express.json({ limit: "4mb" }), async (req, res) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ error: "Blob storage is not configured." });
  }
  try {
    const jsonResponse = await handleUpload({
      token: process.env.BLOB_READ_WRITE_TOKEN,
      request: req,
      body: req.body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const settings = await readSettings();
        if (settings.destination.provider !== "google-drive") {
          throw new Error("Google Drive is not the active destination.");
        }
        let meta;
        try {
          meta = clientPayload ? JSON.parse(clientPayload) : null;
        } catch {
          throw new Error("Invalid upload payload.");
        }
        const uploaderName = (meta?.name || "").trim();
        const project = (meta?.project || "").trim();
        if (!uploaderName || !project) {
          throw new Error("Name and project are required.");
        }
        const prefix = "media-uploader/incoming/";
        if (!pathname || typeof pathname !== "string" || !pathname.startsWith(prefix)) {
          throw new Error("Invalid upload path.");
        }

        return {
          allowedContentTypes: ["image/*", "video/*", "application/octet-stream"],
          addRandomSuffix: true,
          maximumSizeInBytes: 100 * 1024 * 1024,
          tokenPayload: JSON.stringify(meta)
        };
      }
    });
    return res.status(200).json(jsonResponse);
  } catch (e) {
    console.error("/api/media/blob-client:", e);
    return res.status(400).json({ error: e.message || "Blob token error." });
  }
});

app.post("/api/media/blob-commit", express.json({ limit: "512kb" }), async (req, res) => {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return res.status(503).json({ error: "Blob storage is not configured." });
  }

  try {
    const settings = await readSettings();
    if (settings.destination.provider !== "google-drive") {
      return res.status(400).json({ error: "Destination is not Google Drive." });
    }

    const name = (req.body?.name || "").trim();
    const project = (req.body?.project || "").trim();
    const uploadBatchId = (req.body?.uploadBatchId || "").trim();
    const files = req.body?.files;

    if (!name || !project) {
      return res.status(400).json({ error: "Name and project are required." });
    }
    if (!uploadBatchId || !/^[a-zA-Z0-9_-]{6,80}$/.test(uploadBatchId)) {
      return res.status(400).json({ error: "Invalid upload batch id." });
    }
    if (!Array.isArray(files) || files.length < 1 || files.length > 10) {
      return res.status(400).json({ error: "Invalid files list." });
    }

    const folderId = settings.destination.driveFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID || "";
    if (!folderId) {
      return res.status(400).json({ error: "Google Drive folder is not configured." });
    }

    const projectFolderName = sanitizeDriveFolderName(project);
    const projectFolderId = await getOrCreateDriveFolder(folderId, projectFolderName);
    const safeProjectPart = sanitizePart(projectFolderName) || "project";
    const safeName = sanitizePart(name) || "anon";
    const uploadedDriveFiles = [];

    for (let i = 0; i < files.length; i++) {
      const entry = files[i];
      const url = (entry?.url || "").trim();
      const originalFilename = ((entry?.originalFilename || "").trim() || `file_${i + 1}`).slice(0, 240);

      if (!isAllowedBlobHttpUrl(url)) {
        return res.status(400).json({ error: "Invalid blob URL." });
      }
      if (!url.includes(uploadBatchId)) {
        return res.status(400).json({ error: "Upload batch does not match blob URL." });
      }

      const blobRes = await fetch(url);
      if (!blobRes.ok) {
        return res.status(400).json({ error: `Could not read file from Blob storage (${blobRes.status}).` });
      }

      const mimeType = blobRes.headers.get("content-type") || inferMimeFromName(originalFilename, "");
      const safeOriginal = originalFilename.replace(/[^\w.-]/g, "_");
      const targetName = `${safeProjectPart}_${safeName}_${uploadBatchId}_${i + 1}_${safeOriginal}`;

      let nodeStream;
      if (blobRes.body && typeof Readable.fromWeb === "function") {
        nodeStream = Readable.fromWeb(blobRes.body, { highWaterMark: 1024 * 1024 });
      } else {
        const buf = Buffer.from(await blobRes.arrayBuffer());
        nodeStream = Readable.from(buf);
      }

      let driveFile;
      try {
        driveFile = await uploadReadableToGoogleDrive(nodeStream, projectFolderId, targetName, mimeType);
      } catch (uploadErr) {
        return res.status(500).json({ error: `Google Drive upload failed: ${uploadErr.message}` });
      }

      uploadedDriveFiles.push({
        id: driveFile.id,
        name: driveFile.name || targetName
      });

      try {
        await del(url, { token });
      } catch (delErr) {
        console.error("blob-commit del:", delErr.message);
      }
    }

    const timestamp = new Date().toISOString();
    await appendSubmissionCsv({
      timestamp,
      name,
      city: "",
      destination: "google-drive",
      fileCount: uploadedDriveFiles.length,
      fileNames: uploadedDriveFiles.map((f) => f.name),
      fileRefs: uploadedDriveFiles.map((f) => f.id)
    });

    return res.json({
      ok: true,
      destination: "google-drive",
      fileCount: uploadedDriveFiles.length,
      project: projectFolderName
    });
  } catch (e) {
    console.error("/api/media/blob-commit:", e);
    return res.status(500).json({ error: e.message || "Commit failed." });
  }
});

app.post("/api/upload/drive-log", express.json({ limit: "256kb" }), async (req, res) => {
  try {
    const settings = await readSettings();
    if (settings.destination.provider !== "google-drive") {
      return res.status(400).json({ error: "Destination is not Google Drive." });
    }

    const name = (req.body?.name || "").trim();
    const project = (req.body?.project || "").trim();
    const files = req.body?.files;

    if (!name) return res.status(400).json({ error: "Your Name is required." });
    if (!project) return res.status(400).json({ error: "Project is required." });
    if (!Array.isArray(files) || files.length < 1 || files.length > 20) {
      return res.status(400).json({ error: "Invalid files list." });
    }

    for (const f of files) {
      if (!f || typeof f.id !== "string" || !f.name || typeof f.name !== "string") {
        return res.status(400).json({ error: "Invalid file entry in log." });
      }
    }

    const timestamp = new Date().toISOString();
    const projectFolderName = sanitizeDriveFolderName(project);

    await appendSubmissionCsv({
      timestamp,
      name,
      city: "",
      destination: "google-drive",
      fileCount: files.length,
      fileNames: files.map((f) => f.name),
      fileRefs: files.map((f) => f.id)
    });

    return res.json({
      ok: true,
      destination: "google-drive",
      fileCount: files.length,
      project: projectFolderName
    });
  } catch (e) {
    console.error("/api/upload/drive-log:", e);
    return res.status(500).json({ error: e.message || "Could not record submission." });
  }
});

app.post("/api/upload", upload.array("media", 10), async (req, res) => {
  try {
    const settings = await readSettings();
    const files = req.files || [];
    const name = (req.body?.name || "").trim();
    const project = (req.body?.project || "").trim();
    const timestamp = new Date().toISOString();
    const safeName = sanitizePart(name) || "anon";
    const uploadToken = Date.now();

    if (!files.length) {
      return res.status(400).json({ error: "No media files found." });
    }

    if (!name) {
      return res.status(400).json({ error: "Your Name is required." });
    }
    if (!project) {
      return res.status(400).json({ error: "Project is required." });
    }

    if (settings.destination.provider === "google-drive") {
      const folderId = settings.destination.driveFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID || "";
      if (!folderId) {
        return res.status(400).json({
          error: "Google Drive provider is selected but no folder ID is set in admin settings."
        });
      }

      try {
        const uploaded = [];
        const projectFolderName = sanitizeDriveFolderName(project);
        const projectFolderId = await getOrCreateDriveFolder(folderId, projectFolderName);
        const safeProjectPart = sanitizePart(projectFolderName) || "project";
        for (const [index, file] of files.entries()) {
          const safeOriginal = file.originalname.replace(/[^\w.-]/g, "_");
          const targetName = `${safeProjectPart}_${safeName}_${uploadToken}_${index + 1}_${safeOriginal}`;
          const driveFile = await uploadFileToGoogleDrive(file, projectFolderId, targetName);
          uploaded.push({
            id: driveFile.id,
            name: driveFile.name,
            mimeType: driveFile.mimeType,
            size: driveFile.size,
            webViewLink: driveFile.webViewLink || null,
            webContentLink: driveFile.webContentLink || null
          });
        }

        await appendSubmissionCsv({
          timestamp,
          name,
          city: "",
          destination: "google-drive",
          fileCount: uploaded.length,
          fileNames: uploaded.map((f) => f.name),
          fileRefs: uploaded.map((f) => f.id)
        });

        return res.json({
          ok: true,
          destination: "google-drive",
          fileCount: uploaded.length,
          project: projectFolderName,
          files: uploaded
        });
      } catch (error) {
        return res.status(500).json({
          error: `Google Drive upload failed: ${error.message}`
        });
      }
    }

    const projectFolderName = sanitizeDriveFolderName(project);
    const safeProjectPart = sanitizePart(projectFolderName) || "project";

    const localFiles = files.map((file, index) => {
      const safeOriginal = file.originalname.replace(/[^\w.-]/g, "_");
      const renamed = `${safeProjectPart}_${safeName}_${uploadToken}_${index + 1}_${safeOriginal}`;
      return {
        filename: file.filename,
        originalName: file.originalname,
        storedAs: renamed,
        size: file.size,
        mimeType: file.mimetype
      };
    });

    await appendSubmissionCsv({
      timestamp,
      name,
      city: "",
      destination: settings.destination.provider,
      fileCount: localFiles.length,
      fileNames: localFiles.map((f) => f.storedAs),
      fileRefs: localFiles.map((f) => f.filename)
    });

    return res.json({
      ok: true,
      destination: settings.destination.provider,
      fileCount: localFiles.length,
      project: projectFolderName,
      files: localFiles
    });
  } catch (error) {
    console.error("/api/upload:", error);
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message || "Upload failed on the server." });
    }
  }
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.use((err, req, res, next) => {
  console.error("express error:", req.method, req.path, err);
  if (res.headersSent) return next(err);
  if (err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error:
          "That file is too large for this deployment. Try a smaller photo or shorter video, or reduce quality in your camera settings."
      });
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ error: "Too many files in one upload." });
    }
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ error: "Unexpected upload field." });
    }
    return res.status(400).json({ error: err.message || "Upload could not be processed." });
  }
  const msg = err.message || "";
  if (msg.includes("Only image")) {
    return res.status(400).json({ error: msg });
  }
  const status =
    typeof err.status === "number" ? err.status : typeof err.statusCode === "number" ? err.statusCode : 500;
  const safe = status >= 400 && status < 600 ? status : 500;
  return res.status(safe).json({ error: msg || "Server error." });
});

if (isVercel) {
  module.exports = app;
} else {
  storageReady
    .then(() => {
      app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
      });
    })
    .catch((error) => {
      console.error("Failed to initialize storage:", error);
      process.exit(1);
    });
}
