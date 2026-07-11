// Regenerate app icons from logo.png.
// Trims the transparent margin, re-pads to a tight square, then writes:
//   resources/icon.png  (256px, runtime window icon)
//   resources/icon.ico  (multi-size, runtime)
//   build/icon.ico      (multi-size, electron-builder installer + exe)
// ICO is written by hand with PNG-compressed frames (Windows Vista+): sharp
// can't emit .ico and we avoid adding a dep. ponytail: hand-rolled ICO, swap
// for png-to-ico only if a frame ever needs BMP for < Vista support.
import sharp from 'sharp'
import { writeFileSync, mkdirSync } from 'fs'

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const SRC = 'logo.png'

// Trim transparent border, then center on a square canvas (long side) so the
// mark keeps its aspect but carries no extra margin.
const trimmed = await sharp(SRC).trim({ threshold: 10 }).toBuffer({ resolveWithObject: true })
const side = Math.max(trimmed.info.width, trimmed.info.height)
const square = await sharp(trimmed.data)
  .extend({
    top: Math.floor((side - trimmed.info.height) / 2),
    bottom: Math.ceil((side - trimmed.info.height) / 2),
    left: Math.floor((side - trimmed.info.width) / 2),
    right: Math.ceil((side - trimmed.info.width) / 2),
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  })
  .png()
  .toBuffer()

const frames = await Promise.all(
  SIZES.map((s) => sharp(square).resize(s, s).png({ compressionLevel: 9 }).toBuffer())
)

function buildIco(pngs) {
  const count = pngs.length
  const header = Buffer.alloc(6 + count * 16)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)
  let offset = header.length
  pngs.forEach((png, i) => {
    const s = SIZES[i]
    const o = 6 + i * 16
    header[o] = s >= 256 ? 0 : s // width (0 == 256)
    header[o + 1] = s >= 256 ? 0 : s // height
    header[o + 2] = 0 // palette
    header[o + 3] = 0 // reserved
    header.writeUInt16LE(1, o + 4) // color planes
    header.writeUInt16LE(32, o + 6) // bits per pixel
    header.writeUInt32LE(png.length, o + 8)
    header.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...pngs])
}

const ico = buildIco(frames)
// electron-builder requires the mac/linux source png to be >= 512x512.
const png512 = await sharp(square).resize(512, 512).png({ compressionLevel: 9 }).toBuffer()
mkdirSync('build', { recursive: true })
mkdirSync('resources', { recursive: true })
writeFileSync('resources/icon.ico', ico)
writeFileSync('build/icon.ico', ico)
writeFileSync('resources/icon.png', png512)
console.log('wrote icon.ico (' + SIZES.join(',') + ') + icon.png 512')
