const express = require('express');
const crypto = require('crypto');
const { uploadFile, downloadFile } = require('@huggingface/hub');

const app = express();
const PORT = process.env.PORT || 3000;

const HF_TOKEN = process.env.HF_TOKEN;
const HF_REPO = process.env.HF_REPO; // e.g., "username/dataset-name"

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '500mb' }));

function generateVideoId() {
    return crypto.randomBytes(8).toString('base64url').substring(0, 11);
}

// Safely downloads the database.json using the official SDK wrapper
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
        // Fallback cleanly if file doesn't exist yet
        return { idList: [], mappings: {} };
    }
}

// 1. GET ALL IDS
app.get('/videos/list', async (req, res) => {
    try {
        const db = await getHFDatabase();
        res.status(200).json({ ids: db.idList || [] });
    } catch (error) {
        res.status(500).send("Error reading database array.");
    }
});

// 2. GET FILE AS DATAURI
app.get('/video/:id/datauri', async (req, res) => {
    const videoId = req.params.id;
    try {
        const db = await getHFDatabase();
        const meta = db.mappings[videoId];
        if (!meta || !meta.video) return res.status(404).send('Video ID not found.');

        // Stream raw data down from Hugging Face LFS
        const response = await downloadFile({
            repo: { type: 'dataset', id: HF_REPO },
            path: `videos/${meta.video}`,
            credentials: { token: HF_TOKEN }
        });

        const arrayBuffer = await response.arrayBuffer();
        const fileBuffer = Buffer.from(arrayBuffer);
        const base64 = fileBuffer.toString('base64');
        const ext = meta.video.split('.').pop();
        
        res.status(200).json({ dataURI: `data:video/${ext};base64,${base64}` });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error streaming DataURI file.');
    }
});

// 3. POST UPLOAD (Directly to SDK pipeline)
app.post('/upload', async (req, res) => {
    const { videoData, thumbnailData } = req.body;

    if (!videoData) return res.status(400).send('Missing videoData payload.');
    if (!HF_TOKEN || !HF_REPO) return res.status(500).send('Environment variables unconfigured.');

    try {
        // Parse Video
        const videoMatches = videoData.match(/^data:video\/([a-zA-Z0-9]+);base64,(.+)$/);
        if (!videoMatches || videoMatches.length !== 3) return res.status(400).send('Invalid video DataURI.');

        const videoExt = videoMatches[1];
        const videoBuffer = Buffer.from(videoMatches[2], 'base64');
        const videoId = generateVideoId();
        const videoFilename = `video-${Date.now()}.${videoExt}`;
        
        // Push Video using verified SDK parameters
        await uploadFile({
            repo: { type: 'dataset', id: HF_REPO },
            credentials: { token: HF_TOKEN },
            path: `videos/${videoFilename}`,
            file: new Blob([videoBuffer])
        });

        // Parse and Push Optional Thumbnail
        let thumbnailFilename = null;
        if (thumbnailData) {
            const thumbMatches = thumbnailData.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
            if (thumbMatches && thumbMatches.length === 3) {
                const thumbExt = thumbMatches[1];
                const thumbBuffer = Buffer.from(thumbMatches[2], 'base64');
                thumbnailFilename = `thumb-${Date.now()}.${thumbExt}`;

                await uploadFile({
                    repo: { type: 'dataset', id: HF_REPO },
                    credentials: { token: HF_TOKEN },
                    path: `thumbnails/${thumbnailFilename}`,
                    file: new Blob([thumbBuffer])
                });
            }
        }

        // Pull tracking dictionary, merge new key data, commit back to repository root
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
            message: 'Upload synchronized successfully!',
            id: videoId
        });

    } catch (error) {
        console.error("Hugging Face Sync Error: ", error);
        res.status(500).send('Server failed to commit changes to remote repository.');
    }
});

app.listen(PORT, () => {
    console.log(`SDK Storage pipeline initialized on port ${PORT}`);
});
