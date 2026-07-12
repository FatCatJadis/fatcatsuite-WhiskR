const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const app = express();

// Allow requests from any origin (needed if you're calling this from a browser page)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "500mb" }));

// Surface JSON body-parse errors (e.g. payload too large, malformed JSON) as JSON instead of hanging/crashing
app.use((err, req, res, next) => {
  if (err) {
    console.error("Body parse error:", err.message);
    return res.status(400).json({ error: `Bad request body: ${err.message}` });
  }
  next();
});

// Simple health check — useful to confirm the server is actually reachable
app.get("/health", (req, res) => res.json({ status: "ok" }));

const HF_TOKEN = process.env.HF_TOKEN;
const HF_REPO = process.env.HF_DATASET_REPO; // e.g. "username/my-videos"
const HF_RAW = `https://huggingface.co/datasets/${HF_REPO}/resolve/main`;
const TEMP_DIR = "/tmp/hf-video-repo";

if (!HF_TOKEN || !HF_REPO) {
  console.error(
    "FATAL: HF_TOKEN and/or HF_DATASET_REPO environment variables are not set. " +
    "Set them before starting the server (e.g. in Render's dashboard under Environment)."
  );
  process.exit(1);
}

// ── Git + HuggingFace helpers ────────────────────────────────────────────────

async function initGitRepo() {
  // Clone or initialize the HF dataset repo
  if (fs.existsSync(TEMP_DIR)) return; // Already initialized

  const cloneUrl = `https://x-access-token:${HF_TOKEN}@huggingface.co/datasets/${HF_REPO}`;
  try {
    await execAsync(`git clone ${cloneUrl} ${TEMP_DIR}`, { timeout: 30000 });
    console.log("Cloned HF dataset repo");
  } catch (err) {
    console.warn("Could not clone repo (might be empty):", err.message);
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    await execAsync(`cd ${TEMP_DIR} && git init`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git config user.email "bot@render.com"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git config user.name "Video Upload Bot"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git remote add origin ${cloneUrl}`, { timeout: 10000 });
  }
}

async function gitCommitAndPush(filePath, message) {
  // Write and push a file to HF using git
  const fullPath = path.join(TEMP_DIR, filePath);
  const dirPath = path.dirname(fullPath);
  
  fs.mkdirSync(dirPath, { recursive: true });

  try {
    await execAsync(`cd ${TEMP_DIR} && git add "${filePath}"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git commit -m "${message}"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git push -u origin main 2>&1`, { timeout: 60000 });
    console.log(`✓ Pushed ${filePath} to HF`);
  } catch (err) {
    // "nothing to commit" is fine; some other errors are not
    if (!err.message.includes("nothing to commit") && !err.message.includes("no changes added")) {
      throw err;
    }
  }
}

async function hfDownload(filePath) {
  // Returns the raw Response; caller decides how to parse
  const res = await fetch(`${HF_RAW}/${filePath}?raw=true`, {
    headers: { Authorization: `Bearer ${HF_TOKEN}` },
  });
  return res;
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
// Body: { videoData: "data:video/mp4;base64,...", thumbnailData: "data:image/png;base64,..." }
app.post("/upload", async (req, res) => {
  try {
    const { videoData, thumbnailData } = req.body;
    if (!videoData || !thumbnailData) {
      return res.status(400).json({ error: "videoData and thumbnailData are required" });
    }

    await initGitRepo();

    const timestamp = Date.now();
    const id = `video-${timestamp}`;
    const folder = `media/${id}`;

    // Strip data URI prefix and extract base64 payload
    const videoBase64 = videoData.replace(/^data:[^;]+;base64,/, "");
    const thumbBase64 = thumbnailData.replace(/^data:[^;]+;base64,/, "");

    // Write files to temp repo
    const videoPath = path.join(TEMP_DIR, folder, "video.mp4");
    const thumbPath = path.join(TEMP_DIR, folder, "thumbnail.png");
    
    fs.mkdirSync(path.dirname(videoPath), { recursive: true });
    fs.writeFileSync(videoPath, Buffer.from(videoBase64, "base64"));
    fs.writeFileSync(thumbPath, Buffer.from(thumbBase64, "base64"));

    // Push files to HuggingFace
    await gitCommitAndPush(`${folder}/video.mp4`, `Upload video ${id}`);
    await gitCommitAndPush(`${folder}/thumbnail.png`, `Upload thumbnail ${id}`);

    // Update database
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

// GET /ids
app.get("/ids", async (req, res) => {
  try {
    const db = await getDB();
    res.json({ ids: db.ids });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/video/datauri
app.get("/:id/video/datauri", async (req, res) => {
  try {
    const db = await getDB();
    const entry = db.videos[req.params.id];
    if (!entry) return res.status(404).json({ error: "Video not found" });

    const hfRes = await hfDownload(`${entry.folder}/${entry.videoFile}`);
    if (!hfRes.ok) return res.status(404).json({ error: "File not found in storage" });

    const buffer = await hfRes.buffer();
    const base64 = buffer.toString("base64");
    res.json({ datauri: `data:video/mp4;base64,${base64}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/thumbnail/datauri
app.get("/:id/thumbnail/datauri", async (req, res) => {
  try {
    const db = await getDB();
    const entry = db.videos[req.params.id];
    if (!entry) return res.status(404).json({ error: "Video not found" });

    const hfRes = await hfDownload(`${entry.folder}/${entry.thumbnailFile}`);
    if (!hfRes.ok) return res.status(404).json({ error: "File not found in storage" });

    const buffer = await hfRes.buffer();
    const base64 = buffer.toString("base64");
    res.json({ datauri: `data:image/png;base64,${base64}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
