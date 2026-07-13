const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const app = express();

// Global tracking variables to stop duplicate executions
let isGitRepoInitialized = false;

// 1. CORS Global Configuration Policy Layer
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization,Range");
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
  if (isGitRepoInitialized) return;

  if (fs.existsSync(TEMP_DIR)) {
    try {
      await execAsync(`cd ${TEMP_DIR} && git config user.email "bot@render.com"`, { timeout: 10000 });
      await execAsync(`cd ${TEMP_DIR} && git config user.name "Video Upload Bot"`, { timeout: 10000 });
      await execAsync(`cd ${TEMP_DIR} && git remote get-url origin`, { timeout: 5000 });
      await execAsync(`cd ${TEMP_DIR} && git fetch origin 2>&1`, { timeout: 20000 });
      isGitRepoInitialized = true;
    } catch (err) {
      console.warn("Warm directory initialization notice:", err.message);
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

  try {
    await execAsync(`cd ${TEMP_DIR} && git config user.email "bot@render.com"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git config user.name "Video Upload Bot"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git lfs install`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git lfs track "*.mp4"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git lfs track "*.png"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git lfs track "*.jpg"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git lfs track "*.jpeg"`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git add .gitattributes`, { timeout: 10000 });
    await execAsync(`cd ${TEMP_DIR} && git commit -m "Initialize Git LFS tracking rules"`, { timeout: 10000 });
  } catch (lfsErr) {
    console.warn("LFS baseline track update skipped:", lfsErr.message);
  }

  isGitRepoInitialized = true;
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

// POST /upload -> Accepts payload, encodes to uniform H.264 web-standard via FFmpeg, and commits to HF
app.post("/upload", async (req, res) => {
  try {
    const { videoData, thumbnailData, title } = req.body;
    if (!videoData || !thumbnailData || !title) {
      return res.status(400).json({ error: "videoData, thumbnailData, and title are required." });
    }

    await initGitRepo();

    const timestamp = Date.now();
    const id = `video-${timestamp}`;
    const folder = `media/${id}`;

    // Setup base extensions and filenames
    const matches = thumbnailData.match(/^data:image\/([a-zA-Z0-9+.#]+);base64,/);
    const extension = matches && matches[1] ? matches[1] : "png";
    const thumbnailFilename = `thumbnail.${extension}`;

    // Clear headers off incoming raw base64 data packets
    const videoBase64 = videoData.replace(/^data:[^;]+;base64,/, "");
    const thumbBase64 = thumbnailData.replace(/^data:[^;]+;base64,/, "");

    // Path maps
    const folderPath = path.join(TEMP_DIR, folder);
    fs.mkdirSync(folderPath, { recursive: true });

    const rawInputVideoPath = path.join(folderPath, "input_raw.mp4");
    const finalNormalizedVideoPath = path.join(folderPath, "video.mp4");
    const thumbPath = path.join(folderPath, thumbnailFilename);
    
    // Save the raw incoming files to local scratch disk spaces
    fs.writeFileSync(rawInputVideoPath, Buffer.from(videoBase64, "base64"));
    fs.writeFileSync(thumbPath, Buffer.from(thumbBase64, "base64"));

    console.log(`🎬 Commencing server-side FFmpeg normalization for ${id}...`);
    
    // Core FFmpeg execution: normalizes codec profiling formats to web-standard baseline maps
    // -y overrides existing files, +faststart optimizes layout for fast scrubbing
    const ffmpegCommand = `ffmpeg -y -i "${rawInputVideoPath}" -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.0 -c:a aac -ac 2 -b:a 128k -movflags +faststart "${finalNormalizedVideoPath}"`;
    
    try {
      // Execute the transcoder compilation script (giving it up to 3 minutes for larger files)
      await execAsync(ffmpegCommand, { timeout: 180000 });
      console.log(`✅ FFmpeg Transcoding complete for ${id}! Clean layout saved.`);
      
      // Clean up the heavy raw input file so it doesn't get pushed to Hugging Face
      if (fs.existsSync(rawInputVideoPath)) {
        fs.unlinkSync(rawInputVideoPath);
      }
    } catch (ffmpegErr) {
      console.error("❌ FFmpeg Transcoding Crash Error:", ffmpegErr);
      return res.status(500).json({ 
        error: "Server-side video transcoding processing failed. Ensure FFmpeg binaries are installed on the application environment hosting layer.", 
        details: ffmpegErr.message 
      });
    }

    // Ship the normalized asset bundles to HuggingFace
    await gitCommitAndPush(`${folder}/video.mp4`, `Upload normalized video H.264 stream ${id}`);
    await gitCommitAndPush(`${folder}/${thumbnailFilename}`, `Upload thumbnail graphic ${id}`);

    // Update database pointer logs
    const db = await getDB();
    db.ids.push(id);
    db.videos[id] = { 
      folder, 
      videoFile: "video.mp4", 
      thumbnailFile: thumbnailFilename, 
      title: title, 
      uploadedAt: timestamp 
    };
    await saveDB(db);

    res.json({ id, title, folder });
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

app.get("/feed", async (req, res) => {
  try {
    const db = await getDB();
    const feed = db.ids.map(id => ({
      id: id,
      title: db.videos[id]?.title || id,
      uploadedAt: db.videos[id]?.uploadedAt || 0
    }));
    res.json({ feed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FIXED: Airtight chunk segment allocation ensures tracks do not drop down to audio mode
app.get("/:id/video", async (req, res) => {
  try {
    const db = await getDB();
    const entry = db.videos[req.params.id];
    if (!entry) return res.status(404).json({ error: "Video metadata entry missing." });

    const localFilePath = path.join(TEMP_DIR, entry.folder, entry.videoFile);
    if (!fs.existsSync(localFilePath)) return res.status(404).json({ error: "Video missing." });

    const stat = fs.statSync(localFilePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Content-Type", "video/mp4");

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize) {
        res.setHeader("Content-Range", `bytes */${fileSize}`);
        return res.status(416).send("Requested range not satisfiable");
      }

      const chunksize = (end - start) + 1;
      
      // Open direct file descriptor to force perfectly synchronized chunk reading
      fs.open(localFilePath, "r", (err, fd) => {
        if (err) return res.status(500).send(err.message);
        
        const buffer = Buffer.alloc(chunksize);
        fs.read(fd, buffer, 0, chunksize, start, (readErr, bytesRead) => {
          fs.close(fd, () => {}); // Safely clean up reference handles instantly
          
          if (readErr) return res.status(500).send(readErr.message);

          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": bytesRead,
            "Content-Type": "video/mp4",
          });
          res.end(buffer);
        });
      });
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes"
      });
      fs.createReadStream(localFilePath).pipe(res);
    }
  } catch (err) {
    console.error("Streaming Error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get("/:id/thumbnail", async (req, res) => {
  try {
    const db = await getDB();
    const entry = db.videos[req.params.id];
    if (!entry) return res.status(404).json({ error: "Thumbnail entry missing." });

    const localFilePath = path.join(TEMP_DIR, entry.folder, entry.thumbnailFile);
    if (!fs.existsSync(localFilePath)) return res.status(404).json({ error: "Thumbnail missing." });

    const ext = path.extname(localFilePath).toLowerCase().replace(".", "");
    const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;

    const stat = fs.statSync(localFilePath);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Access-Control-Allow-Origin", "*");

    fs.createReadStream(localFilePath).pipe(res);
  } catch (err) {
    console.error("Thumbnail error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
