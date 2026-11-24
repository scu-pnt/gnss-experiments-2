const express = require("express");
const fs = require("node:fs/promises");

let dataFile = null;

const app = express();
app.use(express.static("static"));

const SAMPLES_PER_CHUNK = 2400;

const buf = Buffer.alloc(SAMPLES_PER_CHUNK * 4 * 2);
const samples = new Float32Array(buf.buffer);

const I = new Float32Array(SAMPLES_PER_CHUNK);
const Q = new Float32Array(SAMPLES_PER_CHUNK);

app.get("/samples", async (req, res) => {

    const num_read = Number(req.query.n);
    if(num_read == 0) {
        if(dataFile) {
            dataFile.close();
        }
        dataFile = await fs.open(process.argv[2]);
    }

    const {bytesRead} = await dataFile.read(buf, 0, null, num_read == 0 ? 0 : -1);
    if(bytesRead == 0) {
        res.json(null);
        return;
    }

    const numSamples = Math.floor(bytesRead / 8);
    for(let i = 0; i < numSamples; i++) {
        I[i] = samples[i*2];
        Q[i] = samples[i*2+1];
    }

    res.json([Array.from(I), Array.from(Q)]);
    
});

app.listen(80, () => console.log("Listening!"));