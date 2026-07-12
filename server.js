const express = require("express");
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
const HF_API = `https://huggingface.co/api/datasets/${HF_REPO}`;
const HF_RAW = `https://huggingface.co/datasets/${HF_REPO}/resolve/main`;

// ── HuggingFace helpers ──────────────────────────────────────────────────────

async function hfUpload(filePath, content, isBase64 = false) {
  // filePath: path inside the repo, e.g. "database.json" or "media/video-123/video.mp4"
  // content: string (for JSON) or base64 string (for binary)
  const body = isBase64 ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");

  const res = await fetch(
    `https://huggingface.co/api/datasets/${HF_REPO}/upload/${encodeURIComponent(filePath)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/octet-stream",
      },
      body,
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HF upload failed for ${filePath}: ${res.status} ${text}`);
  }
  return res.json();
}

async function hfDownload(filePath) {
  // Returns the raw Response; caller decides how to parse
  const res = await fetch(`${HF_RAW}/${filePath}?raw=true`, {
    headers: { Authorization: `Bearer ${HF_TOKEN}` },
  });
  return res;
}

async function getDB() {
  const res = await hfDownload("database.json");
  if (res.status === 404) return { ids: [], videos: {} };
  if (!res.ok) throw new Error(`Failed to fetch database.json: ${res.status}`);
  return res.json();
}

async function saveDB(db) {
  await hfUpload("database.json", JSON.stringify(db, null, 2));
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

    const timestamp = Date.now();
    const id = `video-${timestamp}`;
    const folder = `media/${id}`;

    // Strip data URI prefix and extract base64 payload
    const videoBase64 = videoData.replace(/^data:[^;]+;base64,/, "");
    const thumbBase64 = thumbnailData.replace(/^data:[^;]+;base64,/, "");

    // Upload files to HuggingFace
    await hfUpload(`${folder}/video.mp4`, videoBase64, true);
    await hfUpload(`${folder}/thumbnail.png`, thumbBase64, true);

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
