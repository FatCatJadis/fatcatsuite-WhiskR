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

// Job tracking: upload_job_<timestamp> -> { status, error, result }
const uploadJobs = {};

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

// Install git-lfs globally at boot, BEFORE any clone happens. If "git lfs install" runs after
// a clone, that clone happens without the LFS smudge filter registered, so any LFS-tracked
// files (our .mp4s) get checked out as tiny pointer text files instead of actual video data --
// a silent data-loss bug that would only surface when someone tried to play a video after a
// fresh container start. This is awaited (not fire-and-forget) so initGitRepo can guarantee
// it has completed before the first clone.
const lfsInstallPromise = execAsync("git lfs install --skip-repo", { timeout: 10000 })
  .then(() => console.log("✓ Git LFS installed globally"))
  .catch((err) => console.warn("Warning: could not install git-lfs globally:", err.message));

// ── Git + HuggingFace + LFS Environment Systems ──────────────────────────────

async function initGitRepo() {
  if (isGitRepoInitialized) return;

  // Make sure git-lfs is installed globally before touching any repo -- otherwise clones/fetches
  // check out LFS pointer files instead of actual video/thumbnail bytes.
  await lfsInstallPromise;

  if (fs.existsSync(TEMP_DIR)) {
    try {
      await execAsync(`cd ${TEMP_DIR} && git config user.email "bot@render.com"`, { timeout: 10000 });
      await execAsync(`cd ${TEMP_DIR} && git config user.name "Video Upload Bot"`, { timeout: 10000 });
      await execAsync(`cd ${TEMP_DIR} && git remote get-url origin`, { timeout: 5000 });
      await execAsync(`cd ${TEMP_DIR} && git fetch origin 2>&1`, { timeout: 20000 });
      // "git fetch" alone does not materialize LFS object content into the working tree --
      // pull it explicitly so any existing files are real binaries, not pointer stubs.
      try {
        await execAsync(`cd ${TEMP_DIR} && git lfs pull origin main 2>&1`, { timeout: 60000 });
      } catch (lfsPullErr) {
        console.warn("git lfs pull (existing dir) notice:", lfsPullErr.message);
      }
      isGitRepoInitialized = true;
    } catch (err) {
      console.warn("Warm directory initialization notice:", err.message);
    }
    return;
  }

  const cloneUrl = `https://x-access-token:${HF_TOKEN}@huggingface.co/datasets/${HF_REPO}`;
  try {
    await execAsync(`git clone ${cloneUrl} ${TEMP_DIR}`, { timeout: 30000 });
    // Defensive: even though LFS was installed globally before this clone (so smudge filters
    // should have applied automatically), explicitly pull to guarantee real content landed.
    try {
      await execAsync(`cd ${TEMP_DIR} && git lfs pull origin main 2>&1`, { timeout: 60000 });
    } catch (lfsPullErr) {
      console.warn("git lfs pull (fresh clone) notice:", lfsPullErr.message);
    }
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

// Background worker: does actual ffmpeg transcoding + git push (can take minutes)
async function processUploadJob(jobId, videoData, thumbnailData, title) {
  try {
    uploadJobs[jobId].status = "processing";
    uploadJobs[jobId].progress = "Initializing...";

    await initGitRepo();

    // Extract timestamp from jobId
    const timestamp = parseInt(jobId.replace("upload_job_", ""));
    const videoId = `video-${timestamp}`;
    const folder = `media/${videoId}`;

    uploadJobs[jobId].progress = "Parsing files...";
    
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
    uploadJobs[jobId].progress = "Writing files...";
    fs.writeFileSync(rawInputVideoPath, Buffer.from(videoBase64, "base64"));
    fs.writeFileSync(thumbPath, Buffer.from(thumbBase64, "base64"));

    uploadJobs[jobId].progress = "Transcoding video (this may take a few minutes)...";
    console.log(`🎬 Commencing FFmpeg normalization for ${videoId}...`);
    
    const ffmpegCommand = `ffmpeg -y -i "${rawInputVideoPath}" -map 0:v:0 -map 0:a:0? -c:v libx264 -pix_fmt yuv420p -profile:v high -c:a aac -ac 2 -b:a 128k -movflags +faststart "${finalNormalizedVideoPath}"`;
    
    await execAsync(ffmpegCommand, { timeout: 300000 }); // 5 min timeout for ffmpeg
    console.log(`✅ FFmpeg Transcoding complete for ${videoId}!`);

    // Validate output has video stream
    const { stdout: probeOut } = await execAsync(
      `ffprobe -v error -select_streams v -show_entries stream=codec_type -of csv=p=0 "${finalNormalizedVideoPath}"`,
      { timeout: 15000 }
    );
    if (!probeOut.includes("video")) {
      throw new Error("Transcoded output has no video stream.");
    }
    
    // Clean up raw input
    if (fs.existsSync(rawInputVideoPath)) {
      fs.unlinkSync(rawInputVideoPath);
    }

    uploadJobs[jobId].progress = "Uploading to storage...";
    // Ship to HuggingFace
    await gitCommitAndPush(`${folder}/video.mp4`, `Upload video ${videoId}`);
    await gitCommitAndPush(`${folder}/${thumbnailFilename}`, `Upload thumbnail ${videoId}`);

    uploadJobs[jobId].progress = "Updating database...";
    // Update database
    const db = await getDB();
    db.ids.push(videoId);
    db.videos[videoId] = { 
      folder, 
      videoFile: "video.mp4", 
      thumbnailFile: thumbnailFilename, 
      title: title, 
      uploadedAt: timestamp 
    };
    await saveDB(db);

    uploadJobs[jobId].status = "complete";
    uploadJobs[jobId].result = { id: videoId, title, folder };
    console.log(`✅ Upload job ${jobId} complete!`);
  } catch (err) {
    console.error(`❌ Upload job ${jobId} failed:`, err);
    uploadJobs[jobId].status = "error";
    uploadJobs[jobId].error = err.message;
  }
}

// POST /upload -> Queue the upload and return immediately with jobId
app.post("/upload", async (req, res) => {
  try {
    const { videoData, thumbnailData, title } = req.body;
    if (!videoData || !thumbnailData || !title) {
      return res.status(400).json({ error: "videoData, thumbnailData, and title are required." });
    }

    const jobId = `upload_job_${Date.now()}`;
    uploadJobs[jobId] = { status: "queued", progress: "Queued..." };

    // Start the background job without waiting for it
    processUploadJob(jobId, videoData, thumbnailData, title).catch(err => {
      console.error(`Background job ${jobId} crashed:`, err);
    });

    // Return immediately with the job ID so the browser doesn't hang
    res.json({ jobId, status: "queued", message: "Upload queued. Poll /upload/status/:jobId to check progress." });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// GET /upload/status/:jobId -> Check upload progress
app.get("/upload/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = uploadJobs[jobId];
  
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }
  
  res.json({
    jobId,
    status: job.status,
    progress: job.progress,
    error: job.error || null,
    result: job.result || null
  });
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
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// The /upload endpoint does file writes + ffmpeg transcoding (up to 3 min) + several git
// operations synchronously in a single request, which can easily take past a minute for real
// videos. Node's default keepAliveTimeout (5s) and headersTimeout (60s) are too short for that
// and can cause the connection to be dropped mid-request -- which shows up in the browser as a
// bare "Failed to fetch" with no HTTP response at all. Raise both to give slow uploads room.
server.keepAliveTimeout = 10 * 60 * 1000; // 10 minutes
server.headersTimeout = 10 * 60 * 1000 + 1000; // must be greater than keepAliveTimeout
server.requestTimeout = 0; // disable Node's per-request timeout entirely; ffmpeg/git steps govern their own timeouts
