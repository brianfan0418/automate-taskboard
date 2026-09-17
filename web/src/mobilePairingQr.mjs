const VERSION = 6;
const SIZE = 17 + VERSION * 4;
const DATA_CODEWORDS = 136;
const DATA_PER_BLOCK = 68;
const ECC_PER_BLOCK = 18;
const BLOCK_COUNT = 2;
const REMAINDER_BITS = 7;
const QUIET_ZONE = 4;

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < GF_EXP.length; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function polynomialMultiply(a, b) {
  const result = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) result[i + j] ^= gfMultiply(a[i], b[j]);
  }
  return result;
}

function reedSolomonDivisor(degree) {
  let result = [1];
  for (let i = 0; i < degree; i += 1) result = polynomialMultiply(result, [1, GF_EXP[i]]);
  return result;
}

const ECC_DIVISOR = reedSolomonDivisor(ECC_PER_BLOCK);

function reedSolomonRemainder(data) {
  const result = new Array(ECC_PER_BLOCK).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i += 1) result[i] ^= gfMultiply(ECC_DIVISOR[i + 1], factor);
  }
  return result;
}

function appendBits(target, value, count) {
  for (let i = count - 1; i >= 0; i -= 1) target.push((value >>> i) & 1);
}

function encodeData(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  if (bytes.length > 134) throw new RangeError("Pairing URL is too long for the local QR code");

  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);
  const capacity = DATA_CODEWORDS * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    data.push(value);
  }
  for (let pad = 0; data.length < DATA_CODEWORDS; pad += 1) data.push(pad % 2 === 0 ? 0xec : 0x11);
  return data;
}

function interleaveWithErrorCorrection(data) {
  const blocks = [];
  const eccBlocks = [];
  for (let block = 0; block < BLOCK_COUNT; block += 1) {
    const part = data.slice(block * DATA_PER_BLOCK, (block + 1) * DATA_PER_BLOCK);
    blocks.push(part);
    eccBlocks.push(reedSolomonRemainder(part));
  }
  const result = [];
  for (let i = 0; i < DATA_PER_BLOCK; i += 1) {
    for (let block = 0; block < BLOCK_COUNT; block += 1) result.push(blocks[block][i]);
  }
  for (let i = 0; i < ECC_PER_BLOCK; i += 1) {
    for (let block = 0; block < BLOCK_COUNT; block += 1) result.push(eccBlocks[block][i]);
  }
  return result;
}

function formatBits(mask) {
  const data = (0b01 << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

function makeMatrix() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(false));
}

function drawFunctionPatterns(matrix, reserved, mask) {
  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    matrix[y][x] = dark;
    reserved[y][x] = true;
  };
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  };
  const drawAlignment = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  };

  for (let i = 0; i < SIZE; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  drawFinder(3, 3);
  drawFinder(SIZE - 4, 3);
  drawFinder(3, SIZE - 4);
  drawAlignment(34, 34);

  const bits = formatBits(mask);
  const bit = (index) => ((bits >>> index) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) set(SIZE - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, SIZE - 15 + i, bit(i));
  set(8, SIZE - 8, true);
}

function drawCodewords(matrix, reserved, codewords, mask) {
  const bits = [];
  for (const codeword of codewords) appendBits(bits, codeword, 8);
  for (let i = 0; i < REMAINDER_BITS; i += 1) bits.push(0);
  let bitIndex = 0;
  let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < SIZE; vert += 1) {
      const y = upward ? SIZE - 1 - vert : vert;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (reserved[y][x]) continue;
        const raw = bits[bitIndex] === 1;
        const masked = mask === 0 && (x + y) % 2 === 0 ? !raw : raw;
        matrix[y][x] = masked;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
  if (bitIndex !== bits.length) throw new Error(`QR placement mismatch: ${bitIndex}/${bits.length}`);
}

export function createPairingQrMatrix(text) {
  const matrix = makeMatrix();
  const reserved = makeMatrix();
  const mask = 0;
  drawFunctionPatterns(matrix, reserved, mask);
  drawCodewords(matrix, reserved, interleaveWithErrorCorrection(encodeData(text)), mask);
  return matrix;
}

export function createPairingQrSvg(text) {
  const matrix = createPairingQrMatrix(text);
  const outerSize = SIZE + QUIET_ZONE * 2;
  const modules = [];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) if (matrix[y][x]) modules.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outerSize} ${outerSize}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${modules.join("")}" fill="black"/></svg>`;
}

export function createPairingQrDataUrl(text) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createPairingQrSvg(text))}`;
}
