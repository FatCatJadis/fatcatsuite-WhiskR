// Force Node to prefer standard IPv4 routing to prevent Render container network dropouts
require('dns').setDefaultResultOrder('ipv4first');

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// SECURE LOOKUPS: Pulls directly from Render's hidden dashboard memory at runtime
const HF_TOKEN = process.env.HF_TOKEN; 
const HF_REPO  = process.env.HF_REPO;  

console.log("=========================================");
console.log("SERVER INITIALIZING IN SECURE RUNTIME MODE...");
console.log("TARGET REPO FROM ENVIRONMENT:", HF_REPO || "NOT CONFIGURED YET");
console.log("=========================================");

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '500mb' }));

const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
}

function generateVideoId() {
    return crypto.randomBytes(8).toString('base64url').substring(0, 11);
}

// Dynamically creates the database download link on the fly at runtime using dashboard strings
async function getHFDatabaseManual() {
    if (!HF_TOKEN || !HF_REPO) throw new Error("Server environment missing keys on Render dashboard.");
    
    const dbUrl = `https://huggingface.co{HF_REPO}/raw/main/database.json`;
    try {
        const response = await fetch(dbUrl, {
            headers: { 'Authorization': `Bearer ${HF_TOKEN}` }
        });
        if (response.status === 404) return { idList: [], mappings: {} };
        if (!response.ok) throw new Error("Status code error: " + response.status);
        return await response.json();
    } catch (e) {
        throw new Error(e.message);
    }
}

// 1. GET ALL IDS
app.get('/videos/list', async (req, res) => {
    try { 
        const db = await getHFDatabaseManual(); 
        res.status(200).json({ ids: db.idList || [] }); 
    } catch (e) { 
        res.status(500).send("Error reading tracking registry: " + e.message); 
    }
});

// 2. GET FILE AS DATAURI
app.get('/video/:id/datauri', async (req, res) => {
    try {
        const db = await getHFDatabaseManual();
        const meta = db.mappings[req.params.id];
        if (!meta || !meta.video) return res.status(404).send('Video ID not found.');
        
        const dlUrl = `https://huggingface.co{HF_REPO}/raw/main/videos/${meta.video}`;
        const fileResponse = await fetch(dlUrl, {
            headers: { 'Authorization': `Bearer ${HF_TOKEN}` }
        });
        if (!fileResponse.ok) return res.status(404).send('File missing from dataset.');

        const arrayBuffer = await fileResponse.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        res.status(200).json({ dataURI: "data:video/mp4;base64," + base64 });
    } catch (e) { 
        res.status(500).send(e.message); 
    }
});

// 3. POST UPLOAD WITH FIXED RAW DATA STRIPPING
app.post('/upload', async (req, res) => {
    const { videoData, thumbnailData } = req.body;
    if (!videoData) return res.status(400).send('Missing videoData.');
    if (!HF_TOKEN || !HF_REPO) return res.status(500).send('Server configuration missing keys.');

    const runId = Date.now();
    const inputPath = path.join(tmpDir, `input-${runId}.tmp`);
    const compressedPath = path.join(tmpDir, `compressed-${runId}.mp4`);

    try {
        const db = await getHFDatabaseManual();

        // FIXED: Extract explicitly index element [1] from the split operation array 
        // to pass raw text instead of passing a whole array object block down to the Buffer
        const videoParts = videoData.split(',');
        const videoRawBase64 = videoParts.length > 1 ? videoParts[1] : videoParts[0];
        fs.writeFileSync(inputPath, Buffer.from(videoRawBase64, 'base64'));

        // Run background video compression task sequentially using FFmpeg
        await new Promise((resolve, reject) => {
            const cmd = `ffmpeg -i "${inputPath}" -vcodec libx264 -crf 28 -preset veryfast -acodec aac -strict -2 "${compressedPath}" -y`;
            exec(cmd, (err) => err ? reject(err) : resolve());
        });

        const videoId = generateVideoId();
        const videoFilename = `video-${runId}.mp4`;
        
        // Upload Compressed Video
        const upUrl = `https://huggingface.co{HF_REPO}/upload/main/videos/${videoFilename}`;
        const videoUploadResponse = await fetch(upUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/octet-stream' },
            body: fs.readFileSync(compressedPath)
        });
        if (!videoUploadResponse.ok) throw new Error("Video binary upload rejected.");

        // Upload Thumbnail optionally if provided
        let thumbnailFilename = null;
        if (thumbnailData) {
            const thumbParts = thumbnailData.split(',');
            const thumbRawBase64 = thumbParts.length > 1 ? thumbParts[1] : thumbParts[0];
            thumbnailFilename = `thumb-${runId}.png`;
            const thumbUrl = `https://huggingface.co{HF_REPO}/upload/main/thumbnails/${thumbnailFilename}`;
            
            await fetch(thumbUrl, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/octet-stream' },
                body: Buffer.from(thumbRawBase64, 'base64')
            });
        }

        // Merge tracking indices
        if (!db.idList.includes(videoId)) db.idList.push(videoId);
        if (!db.mappings) db.mappings = {};
        db.mappings[videoId] = { video: videoFilename, thumbnail: thumbnailFilename };
        
        // Sync central tracking JSON back up to Hugging Face
        const dbUrl = `https://huggingface.co{HF_REPO}/upload/main/database.json`;
        const dbUploadResponse = await fetch(dbUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify(db, null, 2), 'utf8')
        });
        if (!dbUploadResponse.ok) throw new Error("Registry database sync failed.");

        res.status(200).json({ message: 'Success!', id: videoId });

    } catch (error) {
        console.error("Pipeline failure event log:", error.message);
        res.status(500).send('Pipeline Error: ' + error.message);
    } finally {
        // Always execute clean up tasks safely to prevent storage memory leakage inside Render container
        [inputPath, compressedPath].forEach(p => { if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch(e){} } });
    }
});

app.listen(PORT, () => { console.log("Server online."); });
