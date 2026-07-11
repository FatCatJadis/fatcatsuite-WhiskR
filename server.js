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

// Large payload limit for videos
app.use(express.json({ limit: '500mb' }));

const baseUploadDir = path.join(__dirname, 'uploads');
const videoDir = path.join(baseUploadDir, 'videos');
const thumbnailDir = path.join(baseUploadDir, 'thumbnails');
const databasePath = path.join(baseUploadDir, 'database.json');

// Ensure all subdirectories exist
[baseUploadDir, videoDir, thumbnailDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

function generateVideoId() {
    return crypto.randomBytes(8).toString('base64url').substring(0, 11);
}

// Fixed database writing logic to prevent corruption and handle existing files safely
function saveToDatabase(videoId, videoFilename, thumbnailFilename = null) {
    let db = { idList: [], mappings: {} };

    if (fs.existsSync(databasePath)) {
        try {
            const rawData = fs.readFileSync(databasePath, 'utf8').trim();
            // Only parse if the file actually has content
            if (rawData.length > 0) {
                const parsed = JSON.parse(rawData);
                if (parsed.idList) db.idList = parsed.idList;
                if (parsed.mappings) db.mappings = parsed.mappings;
            }
        } catch (e) {
            console.error("database.json was corrupted. Rebuilding it safely.", e);
            // If the file was broken/corrupted text, we reset it to prevent subsequent crashes
        }
    }

    // Add unique ID to the randomizable array
    if (!db.idList.includes(videoId)) {
        db.idList.push(videoId);
    }

    // Assign mapping data
    db.mappings[videoId] = {
        video: videoFilename,
        thumbnail: thumbnailFilename
    };

    // Write back to disk atomic-style
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

// 2. GET FILE BY ID
app.get('/video/:id', (req, res) => {
    const videoId = req.params.id;
    if (!fs.existsSync(databasePath)) return res.status(404).send('No database found.');

    try {
        const db = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
        const meta = db.mappings[videoId];
        if (!meta || !meta.video) return res.status(404).send('Video ID not found.');

        const filePath = path.join(videoDir, meta.video);
        if (!fs.existsSync(filePath)) return res.status(404).send('Physical file missing.');
        res.sendFile(filePath);
    } catch (e) {
        res.status(500).send('Error accessing database.');
    }
});

// 3. POST UPLOAD
app.post('/upload', (req, res) => {
    const { videoData, thumbnailData } = req.body;

    if (!videoData) {
        return res.status(400).send('Missing videoData payload.');
    }

    try {
        // Process Video
        const videoMatches = videoData.match(/^data:video\/([a-zA-Z0-9]+);base64,(.+)$/);
        if (!videoMatches || videoMatches.length !== 3) {
            return res.status(400).send('Invalid video DataURI format.');
        }

        const videoExt = videoMatches[1];
        const videoBuffer = Buffer.from(videoMatches[2], 'base64');
        const videoId = generateVideoId();
        const videoFilename = `video-${Date.now()}.${videoExt}`;
        
        fs.writeFileSync(path.join(videoDir, videoFilename), videoBuffer);

        // Process Optional Thumbnail
        let thumbnailFilename = null;
        if (thumbnailData) {
            const thumbMatches = thumbnailData.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
            if (thumbMatches && thumbMatches.length === 3) {
                const thumbExt = thumbMatches[1];
                const thumbBuffer = Buffer.from(thumbMatches[2], 'base64');
                thumbnailFilename = `thumb-${Date.now()}.${thumbExt}`;
                fs.writeFileSync(path.join(thumbnailDir, thumbnailFilename), thumbBuffer);
            }
        }

        // Save metadata safely
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
