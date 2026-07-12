const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// PURE HARDCODED STRINGS (Bypasses all SDKs)
// ==========================================
const HF_TOKEN = "YOUR_ACTUAL_HUGGING_FACE_TOKEN_HERE"; 
const HF_REPO = "YOUR_USERNAME/YOUR_DATASET_NAME_HERE";
// ==========================================

console.log("=========================================");
console.log("SERVER INITIALIZING WITH PURE WEB FETCH INTERFACE...");
console.log("TARGET REPO PATH:", HF_REPO);
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

// Manual Fetch implementation to pull down database.json using hardcoded text URL
async function getHFDatabaseManual() {
    const url = `https://huggingface.co{HF_REPO}/raw/main/database.json`;
    try {
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${HF_TOKEN}` }
        });
        
        if (response.status === 404) {
            console.log("No remote database tracking file found. Starting fresh.");
            return { idList: [], mappings: {} };
        }
        
        if (!response.ok) {
            throw new Error(`API returned error status: ${response.status}`);
        }
        
        return await response.json();
    } catch (e) {
        console.error("Direct fetch retrieval error:", e.message);
        throw e;
    }
}

// Manual Fetch implementation to push files up to Hugging Face
async function uploadToHFManual(filePath, fileBuffer, contentType = 'application/octet-stream') {
    const url = `https://huggingface.co{HF_REPO}/upload/main/${filePath}`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${HF_TOKEN}`,
            'Content-Type': contentType
        },
        body: fileBuffer
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Hugging Face upload failed for ${filePath}: ${errText}`);
    }
    return true;
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
    const videoId = req.params.id;
    try {
        const db = await getHFDatabaseManual();
        const meta = db.mappings[videoId];
        if (!meta || !meta.video) return res.status(404).send('Video ID not found.');
        
        const fileUrl = `https://huggingface.co{HF_REPO}/raw/main/videos/${meta.video}`;
        const fileResponse = await fetch(fileUrl, {
            headers: { 'Authorization': `Bearer ${HF_TOKEN}` }
        });

        if (!fileResponse.ok) return res.status(404).send('Physical file missing from storage.');

        const arrayBuffer = await fileResponse.arrayBuffer();
        const fileBuffer = Buffer.from(arrayBuffer);
        res.status(200).json({ dataURI: `data:video/mp4;base64,${fileBuffer.toString('base64')}` });
    } catch (e) { 
        res.status(500).send('Error streaming tracking binary: ' + e.message); 
    }
});

// 3. POST UPLOAD
app.post('/upload', async (req, res) => {
    const { videoData, thumbnailData } = req.body;
    if (!videoData) return res.status(400).send('Missing videoData payload.');

    const runId = Date.now();
    const inputPath = path.join(tmpDir, `input-${runId}.tmp`);
    const compressedPath = path.join(tmpDir, `compressed-${runId}.mp4`);

    try {
        const db = await getHFDatabaseManual();

        const videoMatches = videoData.match(/^data:video\/([a-zA-Z0-9]+);base64,(.+)$/);
        if (!videoMatches || videoMatches.length !== 3) return res.status(400).send('Invalid video DataURI.');

        const videoExt = videoMatches;
        const base64VideoData = videoMatches;
        const videoBuffer = Buffer.from(base64VideoData, 'base64');
        
        fs.writeFileSync(inputPath, videoBuffer);

        return new Promise((resolve, reject) => {
            const command = `ffmpeg -i "${inputPath}" -vcodec libx264 -crf 28 -preset veryfast -acodec aac -strict -2 "${compressedPath}" -y`;
            exec(command, async (error) => {
                if (error) return reject(error);
                try {
                    const compressedBuffer = fs.readFileSync(compressedPath);
                    const videoId = generateVideoId();
                    const videoFilename = `video-${runId}.mp4`;
                    
                    // Upload Compressed Video
                    await uploadToHFManual(`videos/${videoFilename}`, compressedBuffer);

                    // Upload Optional Thumbnail
                    let thumbnailFilename = null;
                    if (thumbnailData) {
                        const thumbMatches = thumbnailData.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
                        if (thumbMatches && thumbMatches.length === 3) {
                            const thumbExt = thumbMatches;
                            const thumbBuffer = Buffer.from(thumbMatches, 'base64');
                            thumbnailFilename = `thumb-${runId}.${thumbExt}`;
                            await uploadToHFManual(`thumbnails/${thumbnailFilename}`, thumbBuffer);
                        }
                    }

                    // Save tracking details
                    if (!db.idList.includes(videoId)) db.idList.push(videoId);
                    if (!db.mappings) db.mappings = {};
                    db.mappings[videoId] = { video: videoFilename, thumbnail: thumbnailFilename };
                    
                    const dbBuffer = Buffer.from(JSON.stringify(db, null, 2), 'utf8');
                    await uploadToHFManual('database.json', dbBuffer, 'application/json');

                    res.status(200).json({ message: 'Success!', id: videoId });
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        });

    } catch (error) {
        res.status(500).send('Server processing error: ' + error.message);
    } finally {
        [inputPath, compressedPath].forEach(filePath => {
            if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch (e) {} }
        });
    }
});

app.listen(PORT, () => { console.log(`Pure Web REST integration running on port ${PORT}`); });
