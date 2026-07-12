const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const multer = require("multer"); // CRITICAL: Added to handle binary file fields

const execAsync = promisify(exec);
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const app = express();

// Safe storage allocation that captures chunks directly onto disk
const upload = multer({ dest: "/tmp/uploads/" });

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Reduced down to 10mb because large files stream through multer, not JSON
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

// ── Git + HuggingFace helpers ────────────────────────────────────────────────

async function initGitRepo() {
  if (fs.existsSync(TEMP_DIR)) {
    await execAsync(`cd ${TEMP_DIR} && git config user.email "bot@render.com"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git config user.name "Video Upload Bot"`, { timeout: 10000 });
    
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
  } catch (err) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    await execAsync(`cd ${TEMP_DIR} && git init`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git remote add origin ${cloneUrl}`, { timeout: 10000 });
  }

  await execAsync(`cd ${TEMP_DIR} && git config user.email "bot@render.com"`, { timeout: 10000 });
  await execAsync(`cd ${TEMP_DIR} && git config user.name "Video Upload Bot"`, { timeout: 10000 });
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
    } catch (pullErr) {}
    
    await execAsync(`cd ${TEMP_DIR} && git push -u origin main 2>&1`, { timeout: 90000 });
  } catch (err) {
    const errMsg = (err.message || "") + (err.stdout || "") + (err.stderr || "");
    if (errMsg.includes("nothing to commit") || errMsg.includes("no changes added")) return;
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

// POST /upload -> Processes multipart files independently
app.post("/upload", upload.fields([{ name: "video", maxCount: 1 }, { name: "thumbnail", maxCount: 1 }]), async (req, res) => {
  try {
    const hasVideo = req.files && req.files.video && req.files.video[0];
    const hasThumbnail = req.files && req.files.thumbnail && req.files.thumbnail[0];

    if (!hasVideo && !hasThumbnail) {
      return res.status(400).json({ error: "Payload empty. Provide a 'video', a 'thumbnail', or both." });
    }

    await initGitRepo();

    const timestamp = Date.now();
    const id = `video-${timestamp}`;
    const folder = `media/${id}`;

    const videoFile = hasVideo ? "video.mp4" : null;
    const thumbnailFile = hasThumbnail ? "thumbnail.png" : null;

    if (hasVideo) {
      const rawVideo = req.files.video[0];
      const videoPath = path.join(TEMP_DIR, folder, "video.mp4");
      fs.mkdirSync(path.dirname(videoPath), { recursive: true });
      fs.renameSync(rawVideo.path, videoPath); // Relocates file chunk stream safely
      await gitCommitAndPush(`${folder}/video.mp4`, `Upload video ${id}`);
    }

    if (hasThumbnail) {
      const rawThumbnail = req.files.thumbnail[0];
      const thumbPath = path.join(TEMP_DIR, folder, "thumbnail.png");
      fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
      fs.renameSync(rawThumbnail.path, thumbPath);
      await gitCommitAndPush(`${folder}/thumbnail.png`, `Upload thumbnail ${id}`);
    }

    const db = await getDB();
    db.ids.push(id);
    db.videos[id] = { folder, videoFile, thumbnailFile, uploadedAt: timestamp };
    await saveDB(db);

    res.json({ id, folder, videoUploaded: !!hasVideo, thumbnailUploaded: !!hasThumbnail });
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
    res.status(500).json({ error: err.message });
  }
});

// GET endpoints now stream binary directly back rather than converting to heavy dataURIs
app.get("/:id/video", async (req, res) => {
  try {
    const db = await getDB();
    const entry = db.videos[req.params.id];
    if (!entry || !entry.videoFile) return res.status(404).json({ error: "No video file found for this entry." });

    const hfRes = await hfDownload(`${entry.folder}/${entry.videoFile}`);
    if (!hfRes.ok) return res.status(404).json({ error: "File not found in storage" });

    res.setHeader("Content-Type", "video/mp4");
    if (hfRes.headers.get("content-length")) {
      res.setHeader("Content-Length", hfRes.headers.get("content-length"));
    }
    hfRes.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/:id/thumbnail", async (req, res) => {
  try {
    const db = await getDB();
    const entry = db.videos[req.params.id];
    if (!entry || !entry.thumbnailFile) return res.status(404).json({ error: "No thumbnail file found for this entry." });

    const hfRes = await hfDownload(`${entry.folder}/${entry.thumbnailFile}`);
    if (!hfRes.ok) return res.status(404).json({ error: "File not found in storage" });

    res.setHeader("Content-Type", "image/png");
    hfRes.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
