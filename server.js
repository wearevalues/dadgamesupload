const express = require("express");
const session = require("express-session");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { google } = require("googleapis");

const app = express();
const port = process.env.PORT || 4173;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "password";
const SESSION_SECRET = process.env.SESSION_SECRET || "replace-this-secret";

const dataDir = path.join(__dirname, "data");
const uploadsDir = path.join(__dirname, "uploads");
const publicUploadsDir = path.join(__dirname, "public", "uploads");
const settingsPath = path.join(dataDir, "settings.json");
const submissionsCsvPath = path.join(dataDir, "submissions.csv");

const defaultSettings = {
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
  }
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

async function readSettings() {
  try {
    const raw = await fsp.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...defaultSettings,
      ...parsed,
      branding: { ...defaultSettings.branding, ...(parsed.branding || {}) },
      destination: { ...defaultSettings.destination, ...(parsed.destination || {}) }
    };
  } catch {
    return defaultSettings;
  }
}

async function writeSettings(next) {
  await fsp.writeFile(settingsPath, JSON.stringify(next, null, 2), "utf8");
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
    entry.city,
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

async function uploadFileToGoogleDrive(file, folderId, targetName) {
  const drive = getDriveClient();
  const response = await drive.files.create({
    requestBody: {
      name: targetName,
      parents: [folderId]
    },
    media: {
      mimeType: file.mimetype,
      body: fs.createReadStream(file.path)
    },
    fields: "id,name,webViewLink,webContentLink,mimeType,size",
    supportsAllDrives: true
  });

  return response.data;
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: "Not authenticated." });
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
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) {
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
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/settings", async (_req, res) => {
  const settings = await readSettings();
  res.json(settings);
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
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/admin/settings", requireAdmin, async (_req, res) => {
  const settings = await readSettings();
  res.json(settings);
});

app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const nextSettings = {
    ...defaultSettings,
    ...payload,
    branding: { ...defaultSettings.branding, ...(payload.branding || {}) },
    destination: { ...defaultSettings.destination, ...(payload.destination || {}) }
  };
  await writeSettings(nextSettings);
  res.json({ ok: true, settings: nextSettings });
});

app.post("/api/admin/logo", requireAdmin, logoUpload.single("logo"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No logo file uploaded." });
  }
  const logoUrl = `/uploads/${req.file.filename}`;
  return res.json({ ok: true, logoUrl });
});

app.post("/api/upload", upload.array("media", 10), async (req, res) => {
  const settings = await readSettings();
  const files = req.files || [];
  const name = (req.body?.name || "").trim();
  const city = (req.body?.city || "").trim();
  const timestamp = new Date().toISOString();
  const safeName = sanitizePart(name) || "anon";
  const safeCity = sanitizePart(city) || "unknown";
  const uploadToken = Date.now();

  if (!files.length) {
    return res.status(400).json({ error: "No media files found." });
  }

  if (!name || !city) {
    return res.status(400).json({ error: "Your Name and Your City are required." });
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
      for (const [index, file] of files.entries()) {
        const safeOriginal = file.originalname.replace(/[^\w.-]/g, "_");
        const targetName = `${safeCity}_${safeName}_${uploadToken}_${index + 1}_${safeOriginal}`;
        const driveFile = await uploadFileToGoogleDrive(file, folderId, targetName);
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
        city,
        destination: "google-drive",
        fileCount: uploaded.length,
        fileNames: uploaded.map((f) => f.name),
        fileRefs: uploaded.map((f) => f.id)
      });

      return res.json({
        ok: true,
        destination: "google-drive",
        fileCount: uploaded.length,
        files: uploaded
      });
    } catch (error) {
      return res.status(500).json({
        error: `Google Drive upload failed: ${error.message}`
      });
    }
  }

  const localFiles = files.map((file, index) => {
    const safeOriginal = file.originalname.replace(/[^\w.-]/g, "_");
    const renamed = `${safeCity}_${safeName}_${uploadToken}_${index + 1}_${safeOriginal}`;
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
    city,
    destination: settings.destination.provider,
    fileCount: localFiles.length,
    fileNames: localFiles.map((f) => f.storedAs),
    fileRefs: localFiles.map((f) => f.filename)
  });

  return res.json({
    ok: true,
    destination: settings.destination.provider,
    fileCount: localFiles.length,
    files: localFiles
  });
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

ensureStorage()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize storage:", error);
    process.exit(1);
  });
