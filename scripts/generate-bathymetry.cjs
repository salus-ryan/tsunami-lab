/* Rebuild the bundled one-degree grid from public Mapzen Terrarium tiles. */
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const tileDir = path.join(root, 'tmp-tiles');
const output = path.join(root, 'public/data/bathymetry.bin');
const zoom = 2;
const tileCount = 2 ** zoom;
const width = 360;
const height = 160;
const latMin = -80;
const latMax = 80;
const worldSize = tileCount * 256;

async function main() {
  fs.mkdirSync(tileDir, { recursive: true });
  const tiles = new Map();
  for (let y = 0; y < tileCount; y++) {
    for (let x = 0; x < tileCount; x++) {
      const name = `${x}-${y}`;
      const file = path.join(tileDir, `${name}.png`);
      if (!fs.existsSync(file)) {
        const response = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`);
        if (!response.ok) throw new Error(`Tile ${name} failed: HTTP ${response.status}`);
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      }
      tiles.set(name, PNG.sync.read(fs.readFileSync(file)));
    }
  }

  function elevationAt(lon, lat) {
    const sin = Math.sin(lat * Math.PI / 180);
    const px = Math.max(0, Math.min(worldSize - 1, Math.floor((lon + 180) / 360 * worldSize)));
    const py = Math.max(0, Math.min(worldSize - 1, Math.floor((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize)));
    const tile = tiles.get(`${Math.floor(px / 256)}-${Math.floor(py / 256)}`);
    const index = ((py % 256) * 256 + (px % 256)) * 4;
    return tile.data[index] * 256 + tile.data[index + 1] + tile.data[index + 2] / 256 - 32768;
  }

  const result = Buffer.alloc(width * height * 2);
  let ocean = 0;
  for (let row = 0; row < height; row++) {
    const lat = latMax - (row + 0.5) / height * (latMax - latMin);
    for (let col = 0; col < width; col++) {
      const lon = -180 + (col + 0.5) / width * 360;
      const elevation = elevationAt(lon, lat);
      const value = elevation >= -15 ? 65535 : Math.round(Math.max(25, Math.min(8000, -elevation)));
      if (value !== 65535) ocean++;
      result.writeUInt16LE(value, (row * width + col) * 2);
    }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, result);
  fs.rmSync(tileDir, { recursive: true, force: true });
  console.log(`Wrote ${width}x${height}, ${ocean} ocean cells (${result.length} bytes)`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
