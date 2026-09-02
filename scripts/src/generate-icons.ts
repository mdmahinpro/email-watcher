/**
 * Rasterize the SVG marks in artifacts/web/public into the PNG and ICO files
 * browsers and mobile launchers actually ask for.
 *
 * Run with: pnpm --filter @workspace/scripts run icons
 *
 * SVG favicons are ignored by Safari and by every Windows shell surface, so the
 * raster set is not optional. Outputs are committed so a plain `pnpm build` does
 * not need sharp (a native dependency) installed.
 */
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "..", "artifacts", "web", "public");

/** Sizes packed into favicon.ico. 16/32 are used by browser chrome, 48 by Windows. */
const ICO_SIZES = [16, 32, 48];

interface Target {
  source: string;
  out: string;
  size: number;
}

const TARGETS: Target[] = [
  // iOS home screen. iOS ignores transparency and any manifest, so this must be
  // a fully opaque square PNG at exactly this name/size.
  { source: "favicon.svg", out: "apple-touch-icon.png", size: 180 },
  // Standard PWA manifest icons.
  { source: "logo.svg", out: "icon-192.png", size: 192 },
  { source: "logo.svg", out: "icon-512.png", size: 512 },
  // Android adaptive icon; safe-zone aware artwork.
  { source: "icon-maskable.svg", out: "icon-maskable-512.png", size: 512 },
  // Fallback for anything that wants a plain PNG favicon.
  { source: "favicon.svg", out: "favicon-32.png", size: 32 },
];

async function renderPng(source: string, size: number): Promise<Buffer> {
  const svg = await readFile(path.join(publicDir, source));
  return sharp(svg, { density: 512 })
    .resize(size, size, { fit: "contain" })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Build an ICO container by hand.
 *
 * sharp cannot write ICO, and the format is simple enough not to warrant another
 * native dependency: a 6-byte header, one 16-byte directory entry per image, then
 * the PNG payloads. PNG-in-ICO is supported by every browser in use.
 */
function buildIco(images: Array<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  // Payloads start after the header and the whole directory.
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const entry = 16 * index;
    // 256px is encoded as 0 in this field; our sizes are all smaller.
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 0);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette size
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // color planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

async function main(): Promise<void> {
  await mkdir(publicDir, { recursive: true });

  for (const target of TARGETS) {
    const png = await renderPng(target.source, target.size);
    await writeFile(path.join(publicDir, target.out), png);
    console.log(`wrote ${target.out} (${target.size}px, ${png.length} bytes)`);
  }

  const icoImages = [];
  for (const size of ICO_SIZES) {
    icoImages.push({ size, data: await renderPng("favicon.svg", size) });
  }
  const ico = buildIco(icoImages);
  await writeFile(path.join(publicDir, "favicon.ico"), ico);
  console.log(`wrote favicon.ico (${ICO_SIZES.join("/")}px, ${ico.length} bytes)`);
}

await main();
