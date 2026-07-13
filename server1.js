const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// Global tracking variables to stop duplicate executions
let isGitRepoInitialized = false;
let repoInitPromise = null;

// Job tracking: upload_job_<timestamp> -> { status, error, result }
const uploadJobs = {};
const uploadAttempts = new Map();
const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const MAX_UPLOADS_PER_WINDOW = 3;
const MAX_UPLOAD_JSON_BYTES = 700 * 1024 * 1024;

// 1. CORS Global Configuration Policy Layer
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Range,X-Whiskr-Client-ID");
  res.header("Access-Control-Expose-Headers", "Content-Range,Accept-Ranges,Content-Length");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// 2. Base64 Parse Cap Layer
app.use((req, res, next) => {
  if (req.method !== "POST" || req.path !== "/upload") return next();
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_UPLOAD_JSON_BYTES) {
    return res.status(413).json({ error: "Upload payload must be smaller than 700 MB." });
  }
  const now = Date.now();
  const attempts = (uploadAttempts.get(req.ip) || []).filter(timestamp => now - timestamp < UPLOAD_WINDOW_MS);
  if (attempts.length >= MAX_UPLOADS_PER_WINDOW) {
    res.setHeader("Retry-After", String(Math.ceil((UPLOAD_WINDOW_MS - (now - attempts[0])) / 1000)));
    return res.status(429).json({ error: "Too many uploads. Try again in a few minutes." });
  }
  attempts.push(now);
  uploadAttempts.set(req.ip, attempts);
  next();
});
app.use("/upload", express.json({ limit: "700mb" }));
app.use(express.json({ limit: "1mb" }));

// Catch-all payload verification
app.use((err, req, res, next) => {
  if (err) {
    console.error("Body parse error:", err.message);
    return res.status(400).json({ error: `Bad request body: ${err.message}` });
  }
  next();
});

const PUBLIC_DIR = __dirname;
function sendUiFile(res, name, fallbackName) {
  const preferred = path.join(PUBLIC_DIR, name);
  const fallback = fallbackName ? path.join(PUBLIC_DIR, fallbackName) : null;
  const filePath = fs.existsSync(preferred) ? preferred : fallback;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: `${name} is not available.` });
  return res.sendFile(filePath);
}

app.get("/", (req, res) => sendUiFile(res, "index.html", "index(2).html"));
app.get("/index.html", (req, res) => sendUiFile(res, "index.html", "index(2).html"));
app.get("/styles.css", (req, res) => sendUiFile(res, "styles.css"));
app.get("/app.js", (req, res) => sendUiFile(res, "app.js"));

// Health Probe
app.get("/health", (req, res) => res.json({ status: "ok" }));

const HF_TOKEN = process.env.HF_TOKEN;
const HF_REPO = process.env.HF_DATASET_REPO;
const TEMP_DIR = process.env.MEDIA_REPO_DIR || "/tmp/hf-video-repo";
const VIEW_DEDUPE_MS = 15 * 60 * 1000;
const recentViews = new Map();

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

function clearRepositoryLock() {
  const lockPath = path.join(TEMP_DIR, ".git", "index.lock");
  if (!fs.existsSync(lockPath)) return;
  fs.unlinkSync(lockPath);
  console.warn("Removed stale Git index lock from the media repository.");
}

async function initializeGitRepo() {
  await lfsInstallPromise;
  const cloneUrl = `https://x-access-token:${HF_TOKEN}@huggingface.co/datasets/${HF_REPO}`;
  const gitDir = path.join(TEMP_DIR, ".git");

  if (fs.existsSync(gitDir)) {
    clearRepositoryLock();
    await execAsync(`git -C "${TEMP_DIR}" config user.email "bot@render.com"`, { timeout: 10000 });
    await execAsync(`git -C "${TEMP_DIR}" config user.name "Video Upload Bot"`, { timeout: 10000 });
    await execAsync(`git -C "${TEMP_DIR}" remote set-url origin "${cloneUrl}"`, { timeout: 10000 });
    await execAsync(`git -C "${TEMP_DIR}" fetch origin main --prune 2>&1`, { timeout: 60000 });
    // Fetching updates refs only. Reset the working tree so database.json and its
    // referenced media always come from the same remote revision.
    await execAsync(`git -C "${TEMP_DIR}" checkout -B main origin/main --force 2>&1`, { timeout: 30000 });
    await execAsync(`git -C "${TEMP_DIR}" reset --hard origin/main 2>&1`, { timeout: 30000 });
    await execAsync(`git -C "${TEMP_DIR}" lfs pull origin main 2>&1`, { timeout: 180000 });
    await execAsync(`git -C "${TEMP_DIR}" lfs checkout 2>&1`, { timeout: 120000 });
    isGitRepoInitialized = true;
    return;
  }

  if (fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  try {
    await execAsync(`git clone "${cloneUrl}" "${TEMP_DIR}"`, { timeout: 120000 });
  } catch (cloneErr) {
    // An empty dataset has no branch to clone yet; initialize it in place.
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    await execAsync(`git -C "${TEMP_DIR}" init`, { timeout: 10000 });
    await execAsync(`git -C "${TEMP_DIR}" remote add origin "${cloneUrl}"`, { timeout: 10000 });
  }

  await execAsync(`git -C "${TEMP_DIR}" config user.email "bot@render.com"`, { timeout: 10000 });
  await execAsync(`git -C "${TEMP_DIR}" config user.name "Video Upload Bot"`, { timeout: 10000 });
  await execAsync(`git -C "${TEMP_DIR}" lfs install`, { timeout: 10000 });
  await execAsync(`git -C "${TEMP_DIR}" lfs pull origin main 2>&1`, { timeout: 180000 }).catch(err => {
    console.warn("Initial LFS pull notice:", err.message);
  });
  try {
    await execAsync(`git -C "${TEMP_DIR}" lfs track "*.mp4" "*.png" "*.jpg" "*.jpeg" "*.webp"`, { timeout: 10000 });
    await execAsync(`git -C "${TEMP_DIR}" add .gitattributes`, { timeout: 10000 });
    await execAsync(`git -C "${TEMP_DIR}" commit -m "Initialize Git LFS tracking rules"`, { timeout: 10000 });
  } catch (lfsErr) {
    const details = `${lfsErr.message || ""}${lfsErr.stdout || ""}${lfsErr.stderr || ""}`;
    if (!details.includes("nothing to commit")) console.warn("LFS baseline track update skipped:", lfsErr.message);
  }
  isGitRepoInitialized = true;
}

function initGitRepo() {
  if (isGitRepoInitialized) return Promise.resolve();
  if (!repoInitPromise) {
    repoInitPromise = initializeGitRepo().catch(err => {
      repoInitPromise = null;
      throw err;
    });
  }
  return repoInitPromise;
}

let repositoryOperationQueue = Promise.resolve();
function enqueueRepositoryOperation(work) {
  const current = repositoryOperationQueue.then(work);
  repositoryOperationQueue = current.then(() => undefined, () => undefined);
  return current;
}

function gitCommitAndPush(filePath, message) {
  return enqueueRepositoryOperation(() => performGitCommitAndPush(filePath, message));
}

async function performGitCommitAndPush(filePath, message) {
  const fullPath = path.join(TEMP_DIR, filePath);
  const dirPath = path.dirname(fullPath);
  fs.mkdirSync(dirPath, { recursive: true });
  clearRepositoryLock();

  try {
    await execAsync(`git -C "${TEMP_DIR}" add "${filePath}"`, { timeout: 10000 });
    await execAsync(`git -C "${TEMP_DIR}" commit -m "${message}"`, { timeout: 10000 });
    try {
      await execAsync(`git -C "${TEMP_DIR}" pull --rebase origin main 2>&1`, { timeout: 60000 });
    } catch (pullErr) {
      console.warn("Remote rebase notice:", pullErr.message);
    }
    await execAsync(`git -C "${TEMP_DIR}" push -u origin main 2>&1`, { timeout: 180000 });
  } catch (err) {
    const errMsg = (err.message || "") + (err.stdout || "") + (err.stderr || "");
    if (errMsg.includes("nothing to commit") || errMsg.includes("no changes added")) return;
    throw err;
  }
}

function opaqueLegacyKey(value) {
  const existing = String(value || "").trim();
  if (!existing) return null;
  if (existing.startsWith("anon:") || existing.startsWith("legacy:")) return existing;
  return `legacy:${crypto.createHash("sha256").update(existing).digest("hex")}`;
}

function emptyDB() {
  return { ids: [], videos: {}, likes: {}, comments: {} };
}

function normalizeDB(value) {
  const db = value && typeof value === "object" ? value : emptyDB();
  const legacyUsers = db.users && typeof db.users === "object" ? db.users : {};
  db.ids = Array.isArray(db.ids) ? db.ids.filter(id => typeof id === "string") : [];
  db.videos = db.videos && typeof db.videos === "object" ? db.videos : {};
  db.likes = db.likes && typeof db.likes === "object" ? db.likes : {};
  db.comments = db.comments && typeof db.comments === "object" ? db.comments : {};

  for (const id of Object.keys(db.videos)) {
    const video = db.videos[id] || {};
    video.type = video.type === "short" || video.kind === "short" ? "short" : "long";
    video.title = typeof video.title === "string" && video.title.trim() ? video.title.trim() : id;
    video.description = typeof video.description === "string" ? video.description : "";
    video.uploadedAt = Number.isFinite(Number(video.uploadedAt)) ? Number(video.uploadedAt) : 0;
    video.viewCount = Math.max(0, Number(video.viewCount) || 0);
    delete video.creatorId;
    delete video.authorId;
    delete video.creator;
    delete video.author;
    db.videos[id] = video;
    if (!db.ids.includes(id)) db.ids.push(id);

    const oldLikes = Array.isArray(db.likes[id]) ? db.likes[id] : [];
    db.likes[id] = [...new Set(oldLikes.map(opaqueLegacyKey).filter(Boolean))];
    const oldComments = Array.isArray(db.comments[id]) ? db.comments[id] : [];
    db.comments[id] = oldComments.map((comment, index) => {
      const legacyUser = comment?.userId ? legacyUsers[comment.userId] : null;
      const nickname = String(
        comment?.nickname || legacyUser?.displayName || legacyUser?.username || "Guest"
      ).trim().slice(0, 24) || "Guest";
      return {
        id: String(comment?.id || `comment-legacy-${id}-${index}`),
        clientKey: opaqueLegacyKey(comment?.clientKey || comment?.userId || `comment:${id}:${index}`),
        nickname,
        text: String(comment?.text || "").trim().slice(0, 500),
        createdAt: Number(comment?.createdAt) || 0
      };
    }).filter(comment => comment.text);
  }

  db.ids = [...new Set(db.ids)].filter(id => db.videos[id]);
  // Identity-era fields are intentionally discarded on the next write.
  delete db.users;
  delete db.usernameIndex;
  delete db.emailIndex;
  delete db.follows;
  return db;
}

async function getDB() {
  await initGitRepo();
  const dbPath = path.join(TEMP_DIR, "database.json");
  if (!fs.existsSync(dbPath)) return emptyDB();
  return normalizeDB(JSON.parse(fs.readFileSync(dbPath, "utf-8")));
}

async function saveDB(value) {
  await initGitRepo();
  const db = normalizeDB(value);
  const dbPath = path.join(TEMP_DIR, "database.json");
  const tempPath = `${dbPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(db, null, 2), "utf-8");
  fs.renameSync(tempPath, dbPath);
  await gitCommitAndPush("database.json", `Update database: ${new Date().toISOString()}`);
}

let mutationQueue = Promise.resolve();
function enqueueMutation(work) {
  const current = mutationQueue.then(work);
  mutationQueue = current.then(() => undefined, () => undefined);
  return current;
}

function mutateDB(mutator) {
  return enqueueMutation(async () => {
    const db = await getDB();
    const result = await mutator(db);
    await saveDB(db);
    return result;
  });
}

function apiError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || "Internal server error." });
    }
  };
}

function anonymousClientKey(req, required = false) {
  const candidates = [
    req.headers["x-whiskr-client-id"],
    req.query?.clientId,
    req.body?.clientId
  ];
  const supplied = candidates.find(value => typeof value === "string" && value.trim());
  const raw = String(supplied || "").trim().toLowerCase();
  if (!raw) {
    if (required) throw apiError(400, "Anonymous client ID is required in X-Whiskr-Client-ID, clientId query, or clientId body.");
    return null;
  }
  if (raw.length < 8 || raw.length > 128 || /[\u0000-\u001f\u007f]/.test(raw)) {
    if (required) throw apiError(400, "Anonymous client ID must be 8-128 printable characters.");
    return null;
  }
  return `anon:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

function serializeVideo(db, id, clientKey = null) {
  const video = db.videos[id];
  const likes = db.likes[id] || [];
  const comments = db.comments[id] || [];
  return {
    id,
    title: video.title,
    description: video.description || "",
    type: video.type,
    uploadedAt: video.uploadedAt,
    stats: { likes: likes.length, comments: comments.length, views: video.viewCount || 0 },
    liked: Boolean(clientKey && likes.includes(clientKey)),
    videoUrl: `/${encodeURIComponent(id)}/video`,
    thumbnailUrl: `/${encodeURIComponent(id)}/thumbnail`
  };
}

function serializeComment(comment, clientKey = null) {
  return {
    id: comment.id,
    text: comment.text,
    createdAt: comment.createdAt,
    author: { id: null, username: comment.nickname, displayName: comment.nickname, avatarUrl: "" },
    isOwn: Boolean(clientKey && comment.clientKey === clientKey)
  };
}

// ── Production Interface Routes ──────────────────────────────────────────────

// Background worker: does actual ffmpeg transcoding + git push (can take minutes)
async function processUploadJob(jobId, videoData, thumbnailData, title, description, type) {
  try {
    uploadJobs[jobId].status = "processing";
    uploadJobs[jobId].progress = "Initializing...";

    await initGitRepo();

    const timestamp = uploadJobs[jobId].createdAt;
    const videoId = uploadJobs[jobId].videoId;
    const folder = `media/${videoId}`;

    uploadJobs[jobId].progress = "Parsing files...";
    
    // Setup base extensions and filenames
    const matches = thumbnailData.match(/^data:image\/(png|jpe?g|webp|gif|bmp|avif|tiff?);base64,/i);
    if (!matches) throw apiError(400, "thumbnailData must be a supported image data URI.");
    const subtype = matches[1].toLowerCase();
    const extension = subtype === "jpeg" ? "jpg" : subtype;
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

    uploadJobs[jobId].progress = "Normalizing video container (this should take seconds)...";
    console.log(`🎬 Commencing FFmpeg container normalization for ${videoId}...`);
    
    // Stream-copy mode: copy video/audio streams as-is without re-encoding, just fix container
    // metadata and move it to the front for fast playback. This takes ~2-10 seconds instead of
    // 10+ minutes and fixes the "audio-only" playback issue that was caused by malformed
    // container headers that browsers couldn't parse.
    const ffmpegCommand = `ffmpeg -y -i "${rawInputVideoPath}" -c:v copy -c:a copy -movflags +faststart "${finalNormalizedVideoPath}"`;
    
    await execAsync(ffmpegCommand, { timeout: 60000 }); // 60 sec timeout (should finish in <10 sec)
    console.log(`✅ FFmpeg normalization complete for ${videoId}!`);

    // Diagnostic: inspect the actual streams in the output file
    uploadJobs[jobId].progress = "Validating output...";
    let hasVideoStream = false;
    try {
      const { stdout: probeOut } = await execAsync(
        `ffprobe -v error -show_entries stream=codec_type,codec_name -of csv=p=0 "${finalNormalizedVideoPath}"`,
        { timeout: 15000 }
      );
      console.log(`FFprobe output for ${videoId}:`, probeOut);
      uploadJobs[jobId].progress = `Streams detected: ${probeOut.trim()}`;
      hasVideoStream = probeOut.includes("video");
    } catch (probeErr) {
      console.warn("ffprobe failed (non-fatal):", probeErr.message);
    }

    // If stream-copy left us with no video stream, the original file was probably audio-only
    // or had codec issues. Fall back to actual H.264 re-encoding to fix it.
    if (!hasVideoStream) {
      console.warn(`❌ Stream-copy produced no video stream for ${videoId}. Falling back to H.264 re-encoding...`);
      uploadJobs[jobId].progress = "Re-encoding to H.264 (this will take a few minutes)...";
      
      const fallbackCommand = `ffmpeg -y -i "${rawInputVideoPath}" -c:v libx264 -pix_fmt yuv420p -profile:v high -preset fast -c:a aac -ac 2 -b:a 128k -movflags +faststart "${finalNormalizedVideoPath}"`;
      await execAsync(fallbackCommand, { timeout: 600000 }); // 10 min timeout
      console.log(`✅ H.264 re-encoding complete for ${videoId}!`);
      
      // Re-check after re-encoding
      try {
        const { stdout: probeOut2 } = await execAsync(
          `ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "${finalNormalizedVideoPath}"`,
          { timeout: 15000 }
        );
        if (!probeOut2.includes("video")) {
          throw new Error("Re-encoded output still has no video stream. Source file may be corrupted or audio-only.");
        }
      } catch (err) {
        throw err;
      }
    }

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
    await enqueueMutation(async () => {
      await gitCommitAndPush(`${folder}/video.mp4`, `Upload video ${videoId}`);
      await gitCommitAndPush(`${folder}/${thumbnailFilename}`, `Upload thumbnail ${videoId}`);
      uploadJobs[jobId].progress = "Updating database...";
      const db = await getDB();
      db.ids.push(videoId);
      db.videos[videoId] = {
        folder,
        videoFile: "video.mp4",
        thumbnailFile: thumbnailFilename,
        title,
        description,
        type,
        uploadedAt: timestamp,
        viewCount: 0
      };
      db.likes[videoId] = [];
      db.comments[videoId] = [];
      await saveDB(db);
    });

    uploadJobs[jobId].status = "complete";
    uploadJobs[jobId].result = { id: videoId, title, description, type, folder };
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
    const { videoData, thumbnailData } = req.body;
    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim();
    const type = req.body?.type === undefined ? "long" : String(req.body.type).toLowerCase();
    if (!videoData || !thumbnailData || !title) {
      return res.status(400).json({ error: "videoData, thumbnailData, and title are required." });
    }
    if (!['long', 'short'].includes(type)) return res.status(400).json({ error: "type must be either long or short." });
    if (title.length > 150) return res.status(400).json({ error: "Title must be 150 characters or fewer." });
    if (description.length > 2000) return res.status(400).json({ error: "Description must be 2000 characters or fewer." });
    if (!/^data:video\/mp4;base64,/i.test(String(videoData))) {
      return res.status(400).json({ error: "videoData must be an MP4 data URI." });
    }

    const createdAt = Date.now();
    const suffix = crypto.randomBytes(3).toString("hex");
    const jobId = `upload_job_${createdAt}_${suffix}`;
    const videoId = `video-${createdAt}-${suffix}`;
    uploadJobs[jobId] = { status: "queued", progress: "Queued...", createdAt, videoId };

    // Start the background job without waiting for it
    processUploadJob(jobId, videoData, thumbnailData, title, description, type).catch(err => {
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
app.get("/ids", route(async (req, res) => {
  const db = await getDB();
  res.json({ ids: db.ids });
}));

app.get("/feed", route(async (req, res) => {
  const type = req.query.type ? String(req.query.type).toLowerCase() : null;
  if (type && !['long', 'short'].includes(type)) throw apiError(400, "type must be either long or short.");
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(100, Math.floor(requestedLimit)) : 100;
  const clientKey = anonymousClientKey(req, false);
  const db = await getDB();
  const ids = db.ids
    .filter(id => !type || db.videos[id]?.type === type)
    .sort((a, b) => db.videos[b].uploadedAt - db.videos[a].uploadedAt)
    .slice(0, limit);
  res.json({ feed: ids.map(id => serializeVideo(db, id, clientKey)) });
}));

app.post("/videos/:id/like", route(async (req, res) => {
  const clientKey = anonymousClientKey(req, true);
  const shouldLike = req.body?.liked !== false;
  const result = await mutateDB(db => {
    if (!db.videos[req.params.id]) throw apiError(404, "Video not found.");
    const likes = db.likes[req.params.id] || (db.likes[req.params.id] = []);
    if (shouldLike) {
      if (!likes.includes(clientKey)) likes.push(clientKey);
    } else {
      db.likes[req.params.id] = likes.filter(key => key !== clientKey);
    }
    return { liked: shouldLike, likeCount: db.likes[req.params.id].length };
  });
  res.json(result);
}));

app.delete("/videos/:id/like", route(async (req, res) => {
  const clientKey = anonymousClientKey(req, true);
  const result = await mutateDB(db => {
    if (!db.videos[req.params.id]) throw apiError(404, "Video not found.");
    const likes = db.likes[req.params.id] || (db.likes[req.params.id] = []);
    db.likes[req.params.id] = likes.filter(key => key !== clientKey);
    return { liked: false, likeCount: db.likes[req.params.id].length };
  });
  res.json(result);
}));

app.get("/videos/:id/comments", route(async (req, res) => {
  const clientKey = anonymousClientKey(req, false);
  const db = await getDB();
  if (!db.videos[req.params.id]) throw apiError(404, "Video not found.");
  const comments = [...(db.comments[req.params.id] || [])]
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
    .map(comment => serializeComment(comment, clientKey));
  res.json({ comments, count: comments.length });
}));

app.post("/videos/:id/comments", route(async (req, res) => {
  const clientKey = anonymousClientKey(req, true);
  const text = String(req.body?.text || "").trim();
  const nickname = String(req.body?.nickname || "").trim();
  if (!text || text.length > 500) throw apiError(400, "Comment must be 1-500 characters.");
  if (nickname.length < 2 || nickname.length > 24 || /[\u0000-\u001f\u007f]/.test(nickname)) {
    throw apiError(400, "Nickname must be 2-24 printable characters.");
  }
  const result = await mutateDB(db => {
    if (!db.videos[req.params.id]) throw apiError(404, "Video not found.");
    const comments = db.comments[req.params.id] || (db.comments[req.params.id] = []);
    const comment = {
      id: `comment-${crypto.randomUUID()}`,
      clientKey,
      nickname,
      text,
      createdAt: Date.now()
    };
    comments.push(comment);
    return { comment: serializeComment(comment, clientKey), count: comments.length };
  });
  res.status(201).json(result);
}));

app.post("/videos/:id/view", route(async (req, res) => {
  const suppliedClientKey = anonymousClientKey(req, false);
  const result = await enqueueMutation(async () => {
    const db = await getDB();
    const video = db.videos[req.params.id];
    if (!video) throw apiError(404, "Video not found.");
    const fallbackKey = crypto.createHash("sha256")
      .update(`${req.ip}|${req.headers['user-agent'] || ""}`)
      .digest("hex");
    const viewerKey = suppliedClientKey || `request:${fallbackKey}`;
    const dedupeKey = `${req.params.id}:${viewerKey}`;
    const now = Date.now();
    const lastSeen = recentViews.get(dedupeKey) || 0;
    let counted = false;
    if (now - lastSeen >= VIEW_DEDUPE_MS) {
      recentViews.set(dedupeKey, now);
      video.viewCount = (Number(video.viewCount) || 0) + 1;
      await saveDB(db);
      counted = true;
    }
    if (recentViews.size > 10000) {
      for (const [key, timestamp] of recentViews) {
        if (now - timestamp > VIEW_DEDUPE_MS) recentViews.delete(key);
      }
    }
    return { counted, viewCount: video.viewCount };
  });
  res.json(result);
}));

app.get("/:id/video", route(async (req, res) => {
  const db = await getDB();
  const entry = db.videos[req.params.id];
  if (!entry) throw apiError(404, "Video metadata entry missing.");
  const localFilePath = path.join(TEMP_DIR, entry.folder, entry.videoFile);
  if (!fs.existsSync(localFilePath)) throw apiError(404, "Video file missing on local server clone directory.");
  const fileSize = fs.statSync(localFilePath).size;
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { "Content-Length": fileSize, "Content-Type": "video/mp4", "Accept-Ranges": "bytes" });
    fs.createReadStream(localFilePath).pipe(res);
    return;
  }

  const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) {
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    return res.status(416).end();
  }
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      return res.status(416).end();
    }
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : fileSize - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= fileSize || end < start) {
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    return res.status(416).end();
  }
  end = Math.min(end, fileSize - 1);
  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Type": "video/mp4"
  });
  fs.createReadStream(localFilePath, { start, end }).pipe(res);
}));

app.get("/:id/thumbnail", route(async (req, res) => {
  const db = await getDB();
  const entry = db.videos[req.params.id];
  if (!entry) throw apiError(404, "Thumbnail metadata entry missing.");
  const localFilePath = path.join(TEMP_DIR, entry.folder, entry.thumbnailFile);
  if (!fs.existsSync(localFilePath)) throw apiError(404, "Thumbnail file missing on local server clone directory.");
  const mimeTypes = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".bmp": "image/bmp", ".avif": "image/avif", ".tif": "image/tiff", ".tiff": "image/tiff"
  };
  const fileSize = fs.statSync(localFilePath).size;
  res.setHeader("Content-Type", mimeTypes[path.extname(localFilePath).toLowerCase()] || "application/octet-stream");
  res.setHeader("Content-Length", fileSize);
  fs.createReadStream(localFilePath).pipe(res);
}));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  server.keepAliveTimeout = 10 * 60 * 1000;
  server.headersTimeout = 10 * 60 * 1000 + 1000;
  server.requestTimeout = 0;
}

module.exports = { app, normalizeDB, anonymousClientKey };
