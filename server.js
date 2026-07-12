const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { uploadFile, downloadFile } = require('@huggingface/hub');

const app = express();
const PORT = process.env.PORT || 3000;

const HF_TOKEN = "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";
const HF_REPO = "FatCatJadis/video-storage";

console.log("=========================================");
console.log("SERVER STARTING UP...");
console.log("READING HF_REPO VALUE:", HF_REPO);
console.log("IS HF_TOKEN DEFINED?:", HF_TOKEN ? "YES" : "NO");
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

// FIXED: Defensively reads the remote database without risk of accidentally wiping it
async function getHFDatabase() {
    try {
        const response = await downloadFile({
            repo: { type: 'dataset', id: HF_REPO },
            path: 'database.json',
            credentials: { token: HF_TOKEN }
        });
        const text = await response.text();
        return JSON.parse(text);
    } catch (e) {
        // CRITICAL FIX: Only return a blank template if Hugging Face explicitly responds with a 404 (Not Found).
        // If the error is a timeout, network hiccup, or restart issue, rethrow the error to prevent overwriting.
        if (e.status === 404 || (e.message && e.message.includes('404'))) {
            console.log("No database.json found on Hugging Face. Creating a brand new registry.");
            return { idList: [], mappings: {} };
        }
        console.error("Network error reading database.json from Hugging Face. Aborting to protect data.");
        throw new Error("Hugging Face database read failed: " + e.message);
    }
}

function compressVideo(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const command = `ffmpeg -i "${inputPath}" -vcodec libx264 -crf 28 -preset veryfast -acodec aac -strict -2 "${outputPath}" -y`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error("FFmpeg error:", stderr);
                return reject(error);
            }
            resolve(outputPath);
        });
    });
}

// 1. FIXED: GET ALL IDS (with proper inner try/catch)
app.get('/videos/list', async (req, res) => {
    try { 
        const db = await getHFDatabase(); 
        res.status(200).json({ ids: db.idList || [] }); 
    } catch (e) { 
        // If the error was a 404 (database doesn't exist yet), return an empty list instead of crashing!
        if (e.message && e.message.includes('404')) {
            return res.status(200).json({ ids: [] });
        }
        
        console.error("Endpoint crash reading list: ", e);
        res.status(500).send("Error reading database from cloud storage: " + e.message); 
    }
});


// 2. GET FILE AS DATAURI
app.get('/video/:id/datauri', async (req, res) => {
    const videoId = req.params.id;
    try {
        const db = await getHFDatabase();
        const meta = db.mappings[videoId];
        if (!meta || !meta.video) return res.status(404).send('Video ID not found.');
        
        const response = await downloadFile({
            repo: { type: 'dataset', id: HF_REPO }, 
            path: `videos/${meta.video}`, 
            credentials: { token: HF_TOKEN }
        });
        const arrayBuffer = await response.arrayBuffer();
        const fileBuffer = Buffer.from(arrayBuffer);
        res.status(200).json({ dataURI: `data:video/mp4;base64,${fileBuffer.toString('base64')}` });
    } catch (e) { 
        res.status(500).send('Error streaming file from cloud storage.'); 
    }
});

// 3. POST UPLOAD
app.post('/upload', async (req, res) => {
    const { videoData, thumbnailData } = req.body;

    if (!videoData) return res.status(400).send('Missing videoData payload.');
    if (!HF_TOKEN || !HF_REPO) return res.status(500).send('Environment variables unconfigured.');

    const runId = Date.now();
    const inputPath = path.join(tmpDir, `input-${runId}.tmp`);
    const compressedPath = path.join(tmpDir, `compressed-${runId}.mp4`);

    try {
        // Fetch the remote database BEFORE doing any heavy lifting.
        // If Hugging Face is unreachable, this throws an error and exits safely without wiping data.
        const db = await getHFDatabase();

        const videoMatches = videoData.match(/^data:video\/([a-zA-Z0-9]+);base64,(.+)$/);
        if (!videoMatches || videoMatches.length !== 3) return res.status(400).send('Invalid video DataURI.');

        const videoExt = videoMatches[1];
        const base64VideoData = videoMatches[2];
        const videoBuffer = Buffer.from(base64VideoData, 'base64');
        
        fs.writeFileSync(inputPath, videoBuffer);

        console.log("Compressing video payload...");
        await compressVideo(inputPath, compressedPath);

        const compressedBuffer = fs.readFileSync(compressedPath);
        const videoId = generateVideoId();
        const videoFilename = `video-${runId}.mp4`;
        
        await uploadFile({
            repo: { type: 'dataset', id: HF_REPO },
            credentials: { token: HF_TOKEN },
            path: `videos/${videoFilename}`,
            file: new Blob([compressedBuffer])
        });

        let thumbnailFilename = null;
        if (thumbnailData) {
            const thumbMatches = thumbnailData.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
            if (thumbMatches && thumbMatches.length === 3) {
                const thumbExt = thumbMatches[1];
                const thumbBuffer = Buffer.from(thumbMatches[2], 'base64');
                thumbnailFilename = `thumb-${runId}.${thumbExt}`;

                await uploadFile({
                    repo: { type: 'dataset', id: HF_REPO },
                    credentials: { token: HF_TOKEN },
                    path: `thumbnails/${thumbnailFilename}`,
                    file: new Blob([thumbBuffer])
                });
            }
        }

        // Safely append to the tracked object we retrieved earlier
        if (!db.idList.includes(videoId)) db.idList.push(videoId);
        if (!db.mappings) db.mappings = {};
        db.mappings[videoId] = { video: videoFilename, thumbnail: thumbnailFilename };
        
        const dbString = JSON.stringify(db, null, 2);
        await uploadFile({
            repo: { type: 'dataset', id: HF_REPO },
            credentials: { token: HF_TOKEN },
            path: 'database.json',
            file: new Blob([dbString], { type: 'application/json' })
        });

        res.status(200).json({
            message: 'Compressed and uploaded successfully!',
            id: videoId
        });

    } catch (error) {
        console.error("Pipeline failed: ", error);
        res.status(500).send('Server error processing upload: ' + error.message);
    } finally {
        [inputPath, compressedPath].forEach(filePath => {
            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (e) { console.error("Cleanup error:", e); }
            }
        });
    }
});

app.listen(PORT, () => { console.log(`Compression backend running on port ${PORT}`); });
