const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const app = express();

// 1. CORS Global Configuration Policy Layer
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// 2. Base64 Parse Cap Layer
app.use(express.json({ limit: "1gb" }));

// Catch-all payload verification
app.use((err, req, res, next) => {
  if (err) {
    console.error("Body parse error:", err.message);
    return res.status(400).json({ error: `Bad request body: ${err.message}` });
  }
  next();
});

// Health Probe
app.get("/health", (req, res) => res.json({ status: "ok" }));

const HF_TOKEN = process.env.HF_TOKEN;
const HF_REPO = process.env.HF_DATASET_REPO; 
const TEMP_DIR = "/tmp/hf-video-repo";

if (!HF_TOKEN || !HF_REPO) {
  console.error("FATAL: HF_TOKEN and/or HF_DATASET_REPO environment variables are not set.");
  process.exit(1);
}

// ── Git + HuggingFace + LFS Environment Systems ──────────────────────────────

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

  // Inject Git LFS patterns to make pushing scalable behind the scenes
  try {
    await execAsync(`cd ${TEMP_DIR} && git lfs install`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git lfs track "*.mp4"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git lfs track "*.png"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git add .gitattributes`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git commit -m "Initialize Git LFS tracking rules"`, { timeout: 10000 });
  } catch (lfsErr) {
    console.warn("LFS baseline track update skipped:", lfsErr.message);
  }
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
    
    // 120 second extended window for LFS byte processing
    await execAsync(`cd ${TEMP_DIR} && git push -u origin main 2>&1`, { timeout: 120000 });
  } catch (err) {
    const errMsg = (err.message || "") + (err.stdout || "") + (err.stderr || "");
    if (errMsg.includes("nothing to commit") || errMsg.includes("no changes added")) return;
    throw err;
  }
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

// ── Production Interface Routes ──────────────────────────────────────────────

// POST /upload -> Reverted workflow accepting pure Base64 strings
app.post("/upload", async (req, res) => {
  try {
    // 1. Accept title right along with the media data streams
    const { videoData, thumbnailData, title } = req.body;
    if (!videoData || !thumbnailData || !title) {
      return res.status(400).json({ error: "videoData, thumbnailData, and title are all required." });
    }

    await initGitRepo();

    const timestamp = Date.now();
    const id = `video-${timestamp}`;
    const folder = `media/${id}`;

    // 2. Figure out the extension of the thumbnail dynamically (png, jpg, jpeg, webp, etc)
    const matches = thumbnailData.match(/^data:image\/([a-zA-Z0-9+.#]+);base64,/);
    const extension = matches && matches[1] ? matches[1] : "png"; // fallback to png
    const thumbnailFilename = `thumbnail.${extension}`;

    // Clean data headers off base64 strings
    const videoBase64 = videoData.replace(/^data:[^;]+;base64,/, "");
    const thumbBase64 = thumbnailData.replace(/^data:[^;]+;base64,/, "");

    const videoPath = path.join(TEMP_DIR, folder, "video.mp4");
    const thumbPath = path.join(TEMP_DIR, folder, thumbnailFilename);
    
    fs.mkdirSync(path.dirname(videoPath), { recursive: true });
    fs.writeFileSync(videoPath, Buffer.from(videoBase64, "base64"));
    fs.writeFileSync(thumbPath, Buffer.from(thumbBase64, "base64"));

    await gitCommitAndPush(`${folder}/video.mp4`, `Upload video ${id}`);
    await gitCommitAndPush(`${folder}/${thumbnailFilename}`, `Upload thumbnail ${id}`);

    // 3. Save title directly to database dictionary object matching your required format
    const db = await getDB();
    db.ids.push(id);
    db.videos[id] = { 
      folder, 
      videoFile: "video.mp4", 
      thumbnailFile: thumbnailFilename, 
      title: title, // Appends custom title tracking metadata 
      uploadedAt: timestamp 
    };
    await saveDB(db);

    res.json({ id, title, folder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
// GET /ids -> Pull database directory indices
app.get("/ids", async (req, res) => {
  try {
    const db = await getDB();
    res.json({ ids: db.ids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/video -> High Performance local disk streaming bypasses HF download walls
app.get("/:id/video", async (req, res) => {
  try {
    const db = await getDB();
    const entry = db.videos[req.params.id];
    if (!entry) return res.status(404).json({ error: "Video metadata entry missing." });

    const localFilePath = path.join(TEMP_DIR, entry.folder, entry.videoFile);

    if (!fs.existsSync(localFilePath)) {
      return res.status(404).json({ error: "Video file missing on local server clone directory." });
    }

    const stat = fs.statSync(localFilePath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);

    fs.createReadStream(localFilePath).pipe(res);
  } catch (err) {
    console.error("Local Video Streaming Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/thumbnail -> High Performance local image disk streaming
app.get("/:id/thumbnail", async (req, res) => {
  try {
    const db = await getDB();
    const entry = db.videos[req.params.id];
    if (!entry) return res.status(404).json({ error: "Thumbnail metadata entry missing." });

    const localFilePath = path.join(TEMP_DIR, entry.folder, entry.thumbnailFile);

    if (!fs.existsSync(localFilePath)) {
      return res.status(404).json({ error: "Thumbnail file missing on local server clone directory." });
    }

    const stat = fs.statSync(localFilePath);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", stat.size);

    fs.createReadStream(localFilePath).pipe(res);
  } catch (err) {
    console.error("Local Thumbnail Streaming Error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
