const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { uploadFile, downloadFile } = require('@huggingface/hub');

const app = express();
const PORT = process.env.PORT || 3000;

const HF_TOKEN = process.env.HF_TOKEN;
const HF_REPO = process.env.HF_REPO;

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '500mb' }));

// Ensure a local temp folder exists inside the container for compression processing
const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
}

function generateVideoId() {
    return crypto.randomBytes(8).toString('base64url').substring(0, 11);
}

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
        return { idList: [], mappings: {} };
    }
}

// Helper function to handle background FFmpeg compression tasks asynchronously
function compressVideo(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        // FFmpeg settings explained:
        // -vcodec libx264: Uses modern industry-standard compression encoding
        // -crf 28: Controls quality (higher number = smaller file size, 28 balances file size with clarity)
        // -preset veryfast: Keeps Render from timing out by processing the encoding rapidly
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

// POST UPLOAD (With Compression)
app.post('/upload', async (req, res) => {
    const { videoData, thumbnailData } = req.body;

    if (!videoData) return res.status(400).send('Missing videoData payload.');
    if (!HF_TOKEN || !HF_REPO) return res.status(500).send('Environment variables unconfigured.');

    // Create unique workspace paths inside the container RAM
    const runId = Date.now();
    const inputPath = path.join(tmpDir, `input-${runId}.tmp`);
    const compressedPath = path.join(tmpDir, `compressed-${runId}.mp4`);

    try {
        const videoMatches = videoData.match(/^data:video\/([a-zA-Z0-9]+);base64,(.+)$/);
        if (!videoMatches || videoMatches.length !== 3) return res.status(400).send('Invalid video DataURI.');

        const videoExt = videoMatches[1];
        const base64VideoData = videoMatches[2];
        const videoBuffer = Buffer.from(base64VideoData, 'base64');
        
        // 1. Write the raw upload directly to disk temporarily
        fs.writeFileSync(inputPath, videoBuffer);

        // 2. Trigger FFmpeg Compression Engine
        console.log("Compressing video payload...");
        await compressVideo(inputPath, compressedPath);

        // 3. Read the newly shrunken compressed file back into RAM
        const compressedBuffer = fs.readFileSync(compressedPath);

        const videoId = generateVideoId();
        const videoFilename = `video-${runId}.mp4`; // Locked to standard .mp4 extension for web reliability
        
        // 4. Push Compressed Video to Hugging Face
        await uploadFile({
            repo: { type: 'dataset', id: HF_REPO },
            credentials: { token: HF_TOKEN },
            path: `videos/${videoFilename}`,
            file: new Blob([compressedBuffer])
        });

        // 5. Parse and Push Optional Thumbnail
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

        // 6. Update central mapping JSON directory
        const db = await getHFDatabase();
        if (!db.idList.includes(videoId)) db.idList.push(videoId);
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
        console.error("Compression/Upload pipeline failed: ", error);
        res.status(500).send('Server failed to compress and save video.');
    } finally {
        // CRITICAL ON RENDER: Clean up container temp memory to prevent crashing from full storage space
        [inputPath, compressedPath].forEach(filePath => {
            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (e) { console.error("Cleanup error:", e); }
            }
        });
    }
});

// GET ROUTES (Kept identical from previous code step)
app.get('/videos/list', async (req, res) => {
    try { const db = await getHFDatabase(); res.status(200).json({ ids: db.idList || [] }); } 
    catch (e) { res.status(500).send("Error reading database."); }
});

app.get('/video/:id/datauri', async (req, res) => {
    const videoId = req.params.id;
    try {
        const db = await getHFDatabase();
        const meta = db.mappings[videoId];
        if (!meta || !meta.video) return res.status(404).send('Video ID not found.');
        const response = await downloadFile({
            repo: { type: 'dataset', id: HF_REPO }, path: `videos/${meta.video}`, credentials: { token: HF_TOKEN }
        });
        const arrayBuffer = await response.arrayBuffer();
        const fileBuffer = Buffer.from(arrayBuffer);
        res.status(200).json({ dataURI: `data:video/mp4;base64,${fileBuffer.toString('base64')}` });
    } catch (e) { res.status(500).send('Error streaming file.'); }
});

app.listen(PORT, () => { console.log(`Compression backend initialized on port ${PORT}`); });
