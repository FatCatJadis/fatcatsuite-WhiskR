const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const multer = require("multer"); // Added for multi-part form streaming

const execAsync = promisify(exec);
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const app = express();

// Configure multer to temporarily store chunks on disk instead of memory
const upload = multer({ dest: "/tmp/uploads/" });

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Standard JSON parser for small metadata payloads (keep limit reasonable)
app.use(express.json({ limit: "10mb" }));

app.use((err, req, res, next) => {
  if (err) {
    console.error("Body parse error:", err.message);
    return res.status(400).json({ error: `Bad request body: ${err.message}` });
  }
  next();
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const HF_TOKEN = process.env.HF_TOKEN;
const HF_REPO = process.env.HF_DATASET_REPO; 
const HF_RAW = `https://huggingface.co/datasets/${HF_REPO}/resolve/main`;
const TEMP_DIR = "/tmp/hf-video-repo";

if (!HF_TOKEN || !HF_REPO) {
  console.error("FATAL: HF_TOKEN and/or HF_DATASET_REPO environment variables are not set.");
  process.exit(1);
}

// Validate HF credentials at startup
(async () => {
  try {
    console.log(`Testing HuggingFace access to ${HF_REPO}...`);
    const res = await fetch(`https://huggingface.co/api/datasets/${HF_REPO}`, {
      headers: { Authorization: `Bearer ${HF_TOKEN}` },
    });
    if (!res.ok) {
      console.warn(`Warning: Could not verify HuggingFace repo access (${res.status}).`);
    } else {
      console.log("✓ HuggingFace credentials verified");
    }
  } catch (err) {
    console.warn("Warning: Could not verify HuggingFace connection:", err.message);
  }
})();

// ── Git + HuggingFace helpers ────────────────────────────────────────────────

async function initGitRepo() {
  if (fs.existsSync(TEMP_DIR)) {
    await execAsync(`cd ${TEMP_DIR} && git config user.email "bot@render.com"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git config user.name "Video Upload Bot"`, { timeout: 10000 });
    
    // Ensure Git LFS is active in this runtime instance
    await execAsync(`cd ${TEMP_DIR} && git lfs install`, { timeout: 10000 });
    
    try {
      await execAsync(`cd ${TEMP_DIR} && git remote get-url origin`, { timeout: 5000 });
    } catch {
      const cloneUrl = `https://x-access-token:${HF_TOKEN}@huggingface.co/datasets/${HF_REPO}`;
      await execAsync(`cd ${TEMP_DIR} && git remote add origin ${cloneUrl}`, { timeout: 10000 });
    }
    
    try {
      await execAsync(`cd ${TEMP_DIR} && git fetch origin 2>&1`, { timeout: 20000 });
    } catch (err) {
      console.warn("Could not fetch from remote:", err.message);
    }
    return;
  }

  const cloneUrl = `https://x-access-token:${HF_TOKEN}@huggingface.co/datasets/${HF_REPO}`;
  try {
    await execAsync(`git clone ${cloneUrl} ${TEMP_DIR}`, { timeout: 30000 });
    console.log("Cloned HF dataset repo");
  } catch (err) {
    console.warn("Could not clone repo (creating new):", err.message);
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    await execAsync(`cd ${TEMP_DIR} && git init`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git remote add origin ${cloneUrl}`, { timeout: 10000 });
  }

  // Setup identities and Git LFS tracking
  await execAsync(`cd ${TEMP_DIR} && git config user.email "bot@render.com"`, { timeout: 10000 });
  await execAsync(`cd ${TEMP_DIR} && git config user.name "Video Upload Bot"`, { timeout: 10000 });
  
  console.log("Initializing Git LFS attributes...");
  await execAsync(`cd ${TEMP_DIR} && git lfs install`, { timeout: 10000 });
  await execAsync(`cd ${TEMP_DIR} && git lfs track "*.mp4"`, { timeout: 10000 });
  await execAsync(`cd ${TEMP_DIR} && git add .gitattributes`, { timeout: 10000 });
  try {
    await execAsync(`cd ${TEMP_DIR} && git commit -m "Track MP4 files via Git LFS"`, { timeout: 10000 });
  } catch (_) {}
}

async function gitCommitAndPush(filePath, message) {
  const fullPath = path.join(TEMP_DIR, filePath);
  const dirPath = path.dirname(fullPath);
  fs.mkdirSync(dirPath, { recursive: true });

  try {
    await execAsync(`cd ${TEMP_DIR} && git add "${filePath}"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git commit -m "${message}"`, { timeout: 10000 });
    
    try {
      await execAsync(`cd ${TEMP_DIR} && git pull --rebase origin main 2>&1`, { timeout: 30000 });
    } catch (pullErr) {
      console.log("Pull skipped (remote may be new)");
    }
    
    // Extended timeout to 15 minutes to allow large LFS uploads over the network
    await execAsync(`cd ${TEMP_DIR} && git push -u origin main 2>&1`, { timeout: 900000 });
    console.log(`✓ Pushed ${filePath} to HF via Git LFS`);
    
  } catch (err) {
    const errMsg = (err.message || "") + (err.stdout || "") + (err.stderr || "");
    if (errMsg.includes("nothing to commit") || errMsg.includes("no changes added") || errMsg.includes("up to date")) {
      console.log(`No updates needed for ${filePath}`);
      return;
    }
    console.error(`Git error for ${filePath}:`, err.message);
    throw err;
  }
}

async function hfDownload(filePath) {
  return await fetch(`${HF_RAW}/${filePath}?raw=true`, {
    headers: { Authorization: `Bearer ${HF_TOKEN}` },
  });
}

async function getDB() {
  await initGitRepo();
  const dbPath = path.join(TEMP_DIR, "database.json");
  if (!fs.existsSync(dbPath)) return { ids: [], videos: {} };
  return JSON.parse(fs.readFileSync(dbPath, "utf-8"));
}

async function saveDB(db) {
  await initGitRepo();
  const dbPath = path.join(TEMP_DIR, "database.json");
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf-8");
  await gitCommitAndPush("database.json", `Update database: ${new Date().toISOString()}`);
}

// ── Endpoints ────────────────────────────────────────────────────────────────

// POST /upload
// Expects multipart/form-data: fields named "video" and "thumbnail" containing actual binary files
app.post("/upload", upload.fields([{ name: "video", maxCount: 1 }, { name: "thumbnail", maxCount: 1 }]), async (req, res) => {
  try {
    if (!req.files || !req.files.video || !req.files.thumbnail) {
      return res.status(400).json({ error: "Both video and thumbnail files are required." });
    }

    await initGitRepo();

    const timestamp = Date.now();
    const id = `video-${timestamp}`;
    const folder = `media/${id}`;

    const rawVideo = req.files.video[0];
    const rawThumbnail = req.files.thumbnail[0];

    const videoPath = path.join(TEMP_DIR, folder, "video.mp4");
    const thumbPath = path.join(TEMP_DIR, folder, "thumbnail.png");
    
    fs.mkdirSync(path.dirname(videoPath), { recursive: true });

    // Safely move files from temporary storage to the git repository
    fs.renameSync(rawVideo.path, videoPath);
    fs.renameSync(rawThumbnail.path, thumbPath);

    // Push files sequentially to avoid staging conflicts
    await gitCommitAndPush(`${folder}/video.mp4`, `Upload video ${id}`);
    await gitCommitAndPush(`${folder}/thumbnail.png`, `Upload thumbnail ${id}`);

    const db = await getDB();
    db.ids.push(id);
    db.videos[id] = { folder, videoFile: "video.mp4", thumbnailFile: "thumbnail.png", uploadedAt: timestamp };
    await saveDB(db);

    res.json({ id, folder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/ids", async (req, res) => {
  try {
    const db = await getDB();
    res.json({ ids: db.ids });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/video
// Streams the binary file directly to the client instead of compiling a data URI
app.get("/:id/video", async (req, res) => {
  try {
    const db = await getDB();
    const entry = db.videos[req.params.id];
    if (!entry) return res.status(404).json({ error: "Video not found" });

    const hfRes = await hfDownload(`${entry.folder}/${entry.videoFile}`);
    if (!hfRes.ok) return res.status(404).json({ error: "File not found in storage" });

    res.setHeader("Content-Type", "video/mp4");
    if (hfRes.headers.get("content-length")) {
      res.setHeader("Content-Length", hfRes.headers.get("content-length"));
    }

    // Pipe the network stream straight to the client response object
    hfRes.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/thumbnail
app.get("/:id/thumbnail", async (req, res) => {
  try {
    const db = await getDB();
    const entry = db.videos[req.params.id];
    if (!entry) return res.status(404).json({ error: "Video not found" });

    const hfRes = await hfDownload(`${entry.folder}/${entry.thumbnailFile}`);
    if (!hfRes.ok) return res.status(404).json({ error: "File not found in storage" });

    res.setHeader("Content-Type", "image/png");
    hfRes.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
