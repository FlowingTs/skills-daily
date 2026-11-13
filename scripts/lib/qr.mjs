// 纯 Node 零依赖 QR 码生成器（byte mode + 纠错级别 M）。
// 输出布尔矩阵（true = 深色模块）。

// ── Galois Field (2^8)，本原多项式 0x11d ──
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  // 输出高次在前（与 rsEncode 长除法一致）
  return poly.reverse();
}

// [version, ecCodewordsPerBlock, blocks(group1), dataCodewords(group1), blocks(group2), dataCodewords(group2)]
// 纠错级别 M
const ECC = [
  [1, 10, 1, 16, 0, 0], [2, 16, 1, 28, 0, 0], [3, 26, 1, 44, 0, 0],
  [4, 18, 2, 32, 0, 0], [5, 24, 2, 43, 0, 0], [6, 16, 4, 27, 0, 0],
  [7, 18, 4, 31, 0, 0], [8, 22, 2, 38, 2, 39], [9, 22, 3, 36, 2, 37],
  [10, 26, 4, 43, 1, 44], [11, 30, 1, 50, 4, 51], [12, 22, 6, 36, 2, 37],
  [13, 22, 8, 37, 1, 38], [14, 24, 4, 40, 5, 41], [15, 24, 5, 41, 5, 42],
  [16, 28, 7, 45, 3, 46], [17, 28, 10, 46, 1, 47], [18, 26, 9, 43, 4, 44],
  [19, 26, 3, 44, 11, 45], [20, 26, 3, 41, 13, 42], [21, 26, 17, 42, 0, 0],
  [22, 28, 17, 46, 0, 0], [23, 28, 4, 47, 14, 48], [24, 28, 6, 45, 14, 46],
  [25, 28, 8, 47, 13, 48], [26, 28, 19, 46, 4, 47], [27, 28, 22, 45, 3, 46],
  [28, 28, 3, 45, 23, 46], [29, 28, 21, 45, 7, 46], [30, 28, 19, 47, 10, 48],
  [31, 28, 2, 46, 29, 47], [32, 28, 10, 46, 23, 47], [33, 28, 14, 46, 21, 47],
  [34, 28, 14, 46, 23, 47], [35, 28, 12, 47, 26, 48], [36, 28, 6, 47, 34, 48],
  [37, 28, 29, 46, 14, 47], [38, 28, 13, 46, 32, 47], [39, 28, 40, 47, 7, 48],
  [40, 28, 18, 47, 31, 48],
];

function dataCodewords(version) {
  const [, , b1, dc1, b2, dc2] = ECC[version - 1];
  return b1 * dc1 + b2 * dc2;
}

function chooseVersion(dataLen) {
  for (let v = 1; v <= 40; v++) {
    const cap = dataCodewords(v);
    const countBits = v <= 9 ? 8 : 16;
    const headerBytes = Math.ceil((4 + countBits) / 8);
    if (headerBytes + dataLen <= cap) return v;
  }
  throw new Error('数据过长，超出 QR 容量');
}

function rsEncode(data, ecLen) {
  const gen = generatorPoly(ecLen);
  const res = new Array(data.length + ecLen).fill(0);
  for (let i = 0; i < data.length; i++) res[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gMul(gen[j], coef);
  }
  for (let i = 0; i < data.length; i++) res[i] = data[i];
  return res.slice(data.length);
}

function interleave(version, dataBytes) {
  const [, ec, b1, dc1, b2, dc2] = ECC[version - 1];
  const blocks = [];
  let offset = 0;
  const add = (count, dc) => {
    for (let i = 0; i < count; i++) {
      blocks.push({ data: dataBytes.slice(offset, offset + dc) });
      offset += dc;
    }
  };
  add(b1, dc1);
  add(b2, dc2);
  for (const b of blocks) b.ec = rsEncode(b.data, ec);

  const out = [];
  const maxData = Math.max(dc1, dc2);
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// 纠错级别 M 的 8 个格式信息（15 bit，含 BCH 纠错）
const FORMAT_M = [
  0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011,
  0b100010111111001, 0b100000011001110, 0b100111110010111, 0b100101010100000,
];

const VERSION_BITS = [
  0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847, 0x0e60d,
  0x0f928, 0x10b78, 0x1145d, 0x12a17, 0x13532, 0x149a6, 0x15683, 0x168c9,
  0x177ec, 0x18ec4, 0x191e1, 0x1afab, 0x1b08e, 0x1cc1a, 0x1d33f, 0x1ed75,
  0x1f250, 0x209d5, 0x216f0, 0x228ba, 0x2379f, 0x24b0b, 0x2542e, 0x26a64,
  0x27541, 0x28c69,
];

function alignmentPositions(version) {
  if (version === 1) return [];
  const num = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (num * 2 - 2)) * 2;
  const positions = [6];
  let pos = version * 4 + 10;
  for (let i = 0; i < num - 1; i++) {
    positions.splice(1, 0, pos);
    pos -= step;
  }
  return positions;
}

/**
 * 构建模板矩阵。
 * 功能模块填 0/1，数据模块填 null。
 */
function buildTemplate(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));

  const placeFinder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
          const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          m[rr][cc] = border || core ? 1 : 0;
        } else {
          m[rr][cc] = 0; // 分隔带（浅色）
        }
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // 对齐（在时序之前，与 qrcode 库顺序一致：定位 → 对齐 → 时序）
  const pos = alignmentPositions(version);
  for (const r of pos) {
    for (const c of pos) {
      if (m[r][c] !== null) continue; // 与定位图形重叠处跳过
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const v = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
          m[r + dr][c + dc] = v;
        }
      }
    }
  }

  // 时序
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // 暗模块
  m[size - 8][8] = 1;

  // 格式信息区占位（先填 0，applyFormat 会覆盖真实值）。
  // 占位后这些位置不再算数据位，数据位 = 所有 null 位置。
  for (let i = 0; i < 6; i++) { m[i][8] = 0; m[8][i] = 0; }
  m[7][8] = 0; m[8][8] = 0; m[8][7] = 0;
  for (let i = 0; i < 7; i++) { m[size - 1 - i][8] = 0; m[8][size - 1 - i] = 0; }
  m[8][size - 8] = 0;

  // 版本信息（仅 version >= 7）
  if (version >= 7) {
    const bits = VERSION_BITS[version - 7];
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m[a][b] = bit;
      m[b][a] = bit;
    }
  }

  return m;
}

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(m) {
  const size = m.length;
  let s = 0;

  // Level 1：连续同色段，长度 L>=5 贡献 (L-2) 分
  const container = new Array(size + 1).fill(0);
  const tally = (row) => {
    let prev = row[0], len = 0;
    for (let i = 0; i < size; i++) {
      if (row[i] === prev) len++;
      else { if (len >= 5) container[len]++; len = 1; prev = row[i]; }
    }
    if (len >= 5) container[len]++;
  };
  for (let r = 0; r < size; r++) tally(m[r]);
  for (let c = 0; c < size; c++) tally(m.map((row) => row[c]));
  for (let L = 5; L <= size; L++) s += container[L] * (L - 2);

  // Level 2：2x2 同色块
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) s += 3;
    }

  // Level 3：1:1:3:1:1 图案（1011101）前后带 4 宽亮区
  const checkLine = (arr) => {
    for (let i = 0; i + 10 < arr.length; i++) {
      if (
        !arr[i + 1] && arr[i + 4] && !arr[i + 5] && arr[i + 6] && !arr[i + 9] &&
        ((arr[i] && arr[i + 2] && arr[i + 3] && !arr[i + 7] && !arr[i + 8] && !arr[i + 10]) ||
          (!arr[i] && !arr[i + 2] && !arr[i + 3] && arr[i + 7] && arr[i + 8] && arr[i + 10]))
      ) {
        s += 40;
      }
      // horspool 优化：与 python 一致，命中与否都按 col+10 决定是否跳
      if (arr[i + 10]) i += 1;
    }
  };
  for (let r = 0; r < size; r++) checkLine(m[r]);
  for (let c = 0; c < size; c++) checkLine(m.map((row) => row[c]));

  // Level 4：深色比例，每偏离 50% 5 个百分点加 10 分
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const percent = (dark * 100) / (size * size);
  s += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return s;
}

function applyFormat(m, maskId) {
  const size = m.length;
  const bits = FORMAT_M[maskId];
  // 完全对齐 qrcode 库 setup_type_info 的放置逻辑，bit0 是 LSB
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    // vertical
    if (i < 6) m[i][8] = bit;
    else if (i < 8) m[i + 1][8] = bit;
    else m[size - 15 + i][8] = bit;
    // horizontal
    if (i < 8) m[8][size - i - 1] = bit;
    else if (i < 9) m[8][15 - i - 1 + 1] = bit;
    else m[8][15 - i - 1] = bit;
  }
}

/**
 * 生成 QR 码布尔矩阵。
 * @param {string} text 文本
 * @returns {{matrix: boolean[][], size: number}}
 */
export function encodeQR(text) {
  const data = new TextEncoder().encode(text);
  const version = chooseVersion(data.length);
  const countBits = version <= 9 ? 8 : 16;

  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(data.length, countBits);
  for (const b of data) push(b, 8);

  const capBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [0xec, 0x11];
  let pi = 0;
  while (bits.length < capBits) { push(pads[pi % 2], 8); pi++; }

  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataBytes.push(b);
  }

  const cws = interleave(version, dataBytes);
  const totalBits = (dataCodewords(version) + (ECC[version - 1][2] + ECC[version - 1][4]) * ECC[version - 1][1]) * 8;
  const fullBits = [];
  for (const cw of cws) for (let j = 7; j >= 0; j--) fullBits.push((cw >> j) & 1);
  while (fullBits.length < totalBits) fullBits.push(0);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const tpl = buildTemplate(version);
    // 选掩码时用 test 状态（格式信息位/暗模块归零），与 qrcode 库 best_mask_pattern 一致
    const m = placeData(tpl, fullBits, mask, false);
    const sc = penalty(m);
    if (!best || sc < best.score) best = { m, score: sc, mask };
  }

  // 选中最优掩码后，重新填充并写入真实格式信息与暗模块
  const finalM = placeData(buildTemplate(version), fullBits, best.mask, true);

  const size = finalM.length;
  const matrix = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(finalM[r][c] === 1);
    matrix.push(row);
  }
  return { matrix, size };
}

/**
 * 按标准蛇形顺序把数据位填进模板（含掩码应用与格式信息）。
 * 完全对齐 qrcode 库 map_data 的遍历顺序。
 */
function placeData(tpl, fullBits, mask, applyFmt = true) {
  const size = tpl.length;
  const m = tpl.map((row) => row.slice());

  let row = size - 1;
  let inc = -1;
  let bitIdx = 0;
  const maskFn = MASK_FNS[mask];

  // 精确复刻 qrcode 库：col 从 size-1 到 1，步长 -2；col<=6 时再减 1 跳过时序列
  for (let col = size - 1; col > 0; col -= 2) {
    let cc = col;
    if (cc <= 6) cc -= 1;
    const colRange = [cc, cc - 1];
    while (true) {
      for (const c of colRange) {
        if (m[row][c] === null) {
          let bit = bitIdx < fullBits.length ? fullBits[bitIdx] : 0;
          if (maskFn(row, c)) bit ^= 1;
          m[row][c] = bit;
          bitIdx++;
        }
      }
      row += inc;
      if (row < 0 || size <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }

  if (applyFmt) {
    applyFormat(m, mask);
  } else {
    // 复刻 qrcode 库 makeImpl(True) 的 test 状态：暗模块归零，格式信息位保持占位 0
    m[size - 8][8] = 0;
  }
  // 残留 null（理论上格式区已占位，这里兜底）
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c] === null) m[r][c] = 0;
  return m;
}

/**
 * 调试用：指定 version 和 mask 生成矩阵（与参考实现逐位对比）。
 */
export function encodeQRDebug(text, version, mask) {
  const data = new TextEncoder().encode(text);
  const countBits = version <= 9 ? 8 : 16;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(data.length, countBits);
  for (const b of data) push(b, 8);
  const capBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [0xec, 0x11];
  let pi = 0;
  while (bits.length < capBits) { push(pads[pi % 2], 8); pi++; }
  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataBytes.push(b);
  }
  const cws = interleave(version, dataBytes);
  const totalBits = (dataCodewords(version) + (ECC[version - 1][2] + ECC[version - 1][4]) * ECC[version - 1][1]) * 8;
  const fullBits = [];
  for (const cw of cws) for (let j = 7; j >= 0; j--) fullBits.push((cw >> j) & 1);
  while (fullBits.length < totalBits) fullBits.push(0);

  const tpl = buildTemplate(version);
  const m = placeData(tpl, fullBits, mask);

  const size = m.length;
  const matrix = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(m[r][c] === 1);
    matrix.push(row);
  }
  return { matrix, size };
}
