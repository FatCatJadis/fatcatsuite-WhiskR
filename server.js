const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// CORS configuration for PenguinMod
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '500mb' }));

const baseUploadDir = path.join(__dirname, 'uploads');
const videoDir = path.join(baseUploadDir, 'videos');
const thumbnailDir = path.join(baseUploadDir, 'thumbnails');
const databasePath = path.join(baseUploadDir, 'database.json');

// Ensure subdirectories exist
[baseUploadDir, videoDir, thumbnailDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

function generateVideoId() {
    return crypto.randomBytes(8).toString('base64url').substring(0, 11);
}

function saveToDatabase(videoId, videoFilename, thumbnailFilename = null) {
    let db = { idList: [], mappings: {} };
    if (fs.existsSync(databasePath)) {
        try {
            const rawData = fs.readFileSync(databasePath, 'utf8').trim();
            if (rawData.length > 0) {
                const parsed = JSON.parse(rawData);
                if (parsed.idList) db.idList = parsed.idList;
                if (parsed.mappings) db.mappings = parsed.mappings;
            }
        } catch (e) {
            console.error("Database read error:", e);
        }
    }
    if (!db.idList.includes(videoId)) db.idList.push(videoId);
    db.mappings[videoId] = { video: videoFilename, thumbnail: thumbnailFilename };
    fs.writeFileSync(databasePath, JSON.stringify(db, null, 2), 'utf8');
}

// 1. GET ALL IDS
app.get('/videos/list', (req, res) => {
    if (!fs.existsSync(databasePath)) return res.json({ ids: [] });
    try {
        const rawData = fs.readFileSync(databasePath, 'utf8').trim();
        if (rawData.length === 0) return res.json({ ids: [] });
        const db = JSON.parse(rawData);
        res.status(200).json({ ids: db.idList || [] });
    } catch (error) {
        res.status(500).send("Error reading video array.");
    }
});

// 2. FIXED: GET AS DATAURI
app.get('/video/:id/datauri', (req, res) => {
    const videoId = req.params.id;
    if (!fs.existsSync(databasePath)) return res.status(404).send('No database found.');

    try {
        const db = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
        const meta = db.mappings[videoId];
        if (!meta || !meta.video) return res.status(404).send('Video ID not found.');

        const filePath = path.join(videoDir, meta.video);
        if (!fs.existsSync(filePath)) return res.status(404).send('Physical file missing.');
        
        // Read file extension cleanly
        const ext = path.extname(filePath).replace('.', '');
        const fileBuffer = fs.readFileSync(filePath);
        const base64 = fileBuffer.toString('base64');
        
        // Return JSON with the reconstructed DataURI
        res.status(200).json({ dataURI: `data:video/${ext};base64,${base64}` });
    } catch (e) {
        console.error("DataURI Endpoint Error: ", e);
        res.status(500).send('Error converting file to DataURI.');
    }
});

// 3. POST UPLOAD WITH FIXES
app.post('/upload', (req, res) => {
    const { videoData, thumbnailData } = req.body;

    if (!videoData) {
        return res.status(400).send('Missing videoData payload.');
    }

    try {
        const videoMatches = videoData.match(/^data:video\/([a-zA-Z0-9]+);base64,(.+)$/);
        if (!videoMatches || videoMatches.length !== 3) {
            return res.status(400).send('Invalid video DataURI format.');
        }

        // FIXED: Explicitly grab index 1 for extension, index 2 for base64 data
        const videoExt = videoMatches[1];
        const base64VideoData = videoMatches[2];
        const videoBuffer = Buffer.from(base64VideoData, 'base64');
        
        const videoId = generateVideoId();
        const videoFilename = `video-${Date.now()}.${videoExt}`;
        
        fs.writeFileSync(path.join(videoDir, videoFilename), videoBuffer);

        let thumbnailFilename = null;
        if (thumbnailData) {
            const thumbMatches = thumbnailData.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
            if (thumbMatches && thumbMatches.length === 3) {
                // FIXED: Explicitly grab correct match indexes
                const thumbExt = thumbMatches[1];
                const base64ThumbData = thumbMatches[2];
                const thumbBuffer = Buffer.from(base64ThumbData, 'base64');
                thumbnailFilename = `thumb-${Date.now()}.${thumbExt}`;
                fs.writeFileSync(path.join(thumbnailDir, thumbnailFilename), thumbBuffer);
            }
        }

        saveToDatabase(videoId, videoFilename, thumbnailFilename);

        res.status(200).json({
            message: 'Upload successful!',
            id: videoId,
            video: videoFilename,
            thumbnail: thumbnailFilename
        });

    } catch (error) {
        console.error("Upload handler crash: ", error);
        res.status(500).send('Server error processing uploads.');
    }
});

app.listen(PORT, () => {
    console.log(`Server organizing videos & thumbnails at http://localhost:${PORT}`);
});
