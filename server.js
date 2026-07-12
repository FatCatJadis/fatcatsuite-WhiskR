const express = require('express');
const fs = require('fs');
const path = require('path');
const { downloadFile, uploadFile } = require('@huggingface/hub');

const express = require('express');
const cors = require('cors'); // <-- Add this line
const { downloadFile, uploadFile } = require('@huggingface/hub');

const app = express();

// Increase JSON payload limits since DataURIs for video can be massive
app.use(express.json({ limit: '500mb' }));

const PORT = process.env.PORT || 3000;
const HF_TOKEN = process.env.HF_TOKEN; 
const HF_REPO = process.env.HF_REPO; // e.g., "username/my-video-dataset"

// Helper function to decode DataURIs into raw binary buffers
function decodeDataURI(dataURI) {
    const matches = dataURI.match(/^data:(.+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid DataURI format');
    return {
        mimeType: matches[1],
        buffer: Buffer.from(matches[2], 'base64')
    };
}

// Fetches the database.json file from your HF dataset repository
async function getDatabase() {
    try {
        const response = await downloadFile({
            repo: { type: "dataset", name: HF_REPO },
            path: "database.json",
            credentials: { token: HF_TOKEN }
        });
        const text = await response.text();
        return JSON.parse(text);
    } catch (error) {
        // If the file doesn't exist yet, return a fresh empty array template
        return [];
    }
}

// Commits a file buffer directly to your Hugging Face dataset repository
async function uploadToHF(repoPath, buffer) {
    await uploadFile({
        repo: { type: "dataset", name: HF_REPO },
        path: repoPath,
        file: new Blob([buffer]),
        credentials: { token: HF_TOKEN }
    });
}

app.post('/upload', async (req, res) => {
    try {
        const { videoData, thumbnailData } = req.body;
        if (!videoData || !thumbnailData) {
            return res.status(400).json({ error: "Missing videoData or thumbnailData" });
        }

        const timestamp = Date.now();
        const videoId = `vid-${timestamp}`;

        // 1. Decode DataURIs into raw binary buffers
        const videoDecoded = decodeDataURI(videoData);
        const thumbDecoded = decodeDataURI(thumbnailData);

        // 2. Define remote folder paths matching your structure
        const videoPath = `media/video-${timestamp}/video.mp4`;
        const thumbPath = `media/video-${timestamp}/thumbnail.png`;

        // 3. Directly stream the files to Hugging Face
        await uploadToHF(videoPath, videoDecoded.buffer);
        await uploadToHF(thumbPath, thumbDecoded.buffer);

        // 4. Download, update, and upload the synchronized database.json
        const db = await getDatabase();
        const newEntry = {
            id: videoId,
            filename: videoPath,
            thumbnailPath: thumbPath
        };
        db.push(newEntry);

        const updatedDbBuffer = Buffer.from(JSON.stringify(db, null, 2));
        await uploadToHF("database.json", updatedDbBuffer);

        res.status(201).json({ message: "Upload successful!", id: videoId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Upload failed", details: error.message });
    }
});

app.get('/ids', async (req, res) => {
    try {
        const db = await getDatabase();
        res.status(200).json(db);
    } catch (error) {
        res.status(500).json({ error: "Failed to retrieve IDs" });
    }
});

// GET Video DataURI
app.get('/:id/video/datauri', async (req, res) => {
    try {
        const db = await getDatabase();
        const record = db.find(item => item.id === req.params.id);
        
        if (!record) return res.status(404).json({ error: "Video ID not found" });

        const response = await downloadFile({
            repo: { type: "dataset", name: HF_REPO },
            path: record.filename,
            credentials: { token: HF_TOKEN }
        });
        
        const arrayBuffer = await response.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        
        res.status(200).json({ videoData: `data:video/mp4;base64,${base64}` });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch video data" });
    }
});

// GET Thumbnail DataURI
app.get('/:id/thumbnail/datauri', async (req, res) => {
    try {
        const db = await getDatabase();
        const record = db.find(item => item.id === req.params.id);
        
        if (!record) return res.status(404).json({ error: "Video ID not found" });

        const response = await downloadFile({
            repo: { type: "dataset", name: HF_REPO },
            path: record.thumbnailPath,
            credentials: { token: HF_TOKEN }
        });
        
        const arrayBuffer = await response.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        
        res.status(200).json({ thumbnailData: `data:image/png;base64,${base64}` });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch thumbnail data" });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server handling storage via HuggingFace running on port ${PORT}`);
});
