// HIGH-COMPATIBILITY VIDEO STREAMING ROUTE
app.get("/:id/video", async (req, res) => {
  try {
    const db = await getDB();
    const entry = db.videos[req.params.id];
    if (!entry) {
      return res.status(404).json({ error: "Video metadata entry missing." });
    }

    const localFilePath = path.join(TEMP_DIR, entry.folder, entry.videoFile);

    if (!fs.existsSync(localFilePath)) {
      return res.status(404).json({ error: "Video file missing on local server clone directory." });
    }

    const stat = fs.statSync(localFilePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // 1. Force absolute CORS and content type visibility properties globally across all chunks
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Content-Type", "video/mp4"); // Crucial: forces browser to stay in video rendering mode

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize) {
        return res.status(416).send(`Requested range not satisfiable\n${start} >= ${fileSize}`);
      }

      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(localFilePath, { start, end });
      
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": "video/mp4", // Double enforcement for range responses
      });
      
      return file.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes"
      });
      return fs.createReadStream(localFilePath).pipe(res);
    }
  } catch (err) {
    console.error("Local Video Streaming Error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message });
    }
  }
});
