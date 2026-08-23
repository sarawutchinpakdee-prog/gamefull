const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const CARDS_PATH = path.join(__dirname, '..', 'data', 'cards.json');
const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'game_history.json');
const MAX_HISTORY_ENTRIES = 300;
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');

function readDB() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function readCards() {
  const raw = fs.readFileSync(CARDS_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeCards(data) {
  fs.writeFileSync(CARDS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// การ์ดเหตุการณ์ (EVENT) ของเกม: 'quiz' = การ์ดทำโทษ (ควิซความรู้ร้อยเอ็ด), 'angel' = การ์ดนางฟ้า
// อ่านจากไฟล์ทุกครั้งเหมือน getCells() เพื่อให้แอดมินแก้ไขแล้วมีผลกับเกมที่กำลังเล่นอยู่ทันที
function getQuizCards() {
  return readCards().quiz;
}

function getAngelCards() {
  return readCards().angel;
}

function addCard(kind, card) {
  const data = readCards();
  const list = data[kind];
  if (!list) return null;
  const withId = { id: `${kind}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, ...card };
  list.push(withId);
  writeCards(data);
  return withId;
}

function updateCard(kind, id, patch) {
  const data = readCards();
  const list = data[kind];
  if (!list) return null;
  const idx = list.findIndex(c => c.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch, id };
  writeCards(data);
  return list[idx];
}

function deleteCard(kind, id) {
  const data = readCards();
  const list = data[kind];
  if (!list) return false;
  const idx = list.findIndex(c => c.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  writeCards(data);
  return true;
}

function getAdminByUsername(username) {
  const db = readDB();
  return db.admins.find(a => a.username === username) || null;
}

// รายชื่อบัญชีแอดมินทั้งหมด (ไม่คืน password_hash ออกไปนอกไฟล์นี้)
function getAdmins() {
  const db = readDB();
  return db.admins.map(a => ({ username: a.username }));
}

function createAdmin(username, passwordHash) {
  const db = readDB();
  if (db.admins.some(a => a.username === username)) return null;
  const admin = { username, password_hash: passwordHash };
  db.admins.push(admin);
  writeDB(db);
  return { username };
}

// กันไม่ให้ลบแอดมินคนสุดท้าย ไม่งั้นจะไม่มีใครล็อกอินเข้าระบบได้อีก
function deleteAdmin(username) {
  const db = readDB();
  const idx = db.admins.findIndex(a => a.username === username);
  if (idx === -1) return { error: 'ไม่พบบัญชีนี้', status: 404 };
  if (db.admins.length <= 1) return { error: 'ต้องมีบัญชีแอดมินเหลืออย่างน้อย 1 บัญชี', status: 400 };
  db.admins.splice(idx, 1);
  writeDB(db);
  return { ok: true };
}

function updateAdminPassword(username, passwordHash) {
  const db = readDB();
  const admin = db.admins.find(a => a.username === username);
  if (!admin) return false;
  admin.password_hash = passwordHash;
  writeDB(db);
  return true;
}

function getCellTypes() {
  const db = readDB();
  return db.cellTypes;
}

function getCells(boardId) {
  const db = readDB();
  return db.cells.filter(c => c.board_id === boardId);
}

function getCellById(id) {
  const db = readDB();
  return db.cells.find(c => c.id === id) || null;
}

// เฉพาะฟิลด์ที่แอดมินแก้ไขได้ — กันไม่ให้ patch เผลอทับ id/board_id/position
const EDITABLE_FIELDS = [
  'name', 'type', 'image_url', 'model_3d_url', 'description',
  'price', 'rent_base', 'effect_value', 'effect_steps', 'attractions',
  'phone', 'facebook', 'line_id', 'website'
];

function updateCell(id, patch) {
  const db = readDB();
  const idx = db.cells.findIndex(c => c.id === id);
  if (idx === -1) return null;

  const cell = db.cells[idx];
  for (const key of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      cell[key] = patch[key];
    }
  }
  cell.updated_at = new Date().toISOString();
  db.cells[idx] = cell;
  writeDB(db);
  return cell;
}

// เพิ่มช่องใหม่ต่อท้ายกระดานเสมอ (position = ตำแหน่งสูงสุด + 1) — ไม่แทรกกลางบอร์ด เพื่อไม่ให้
// ตำแหน่ง START (position 1, ที่ผู้เล่นใหม่ทุกคนเริ่มยืนอยู่) ขยับเปลี่ยนไปโดยไม่ตั้งใจ
// row/column เป็นค่าที่คำนวณจาก position ฝั่ง client ตอน render (ดู rowCol() ใน admin.html/play.html)
// จึงไม่จำเป็นต้องคำนวณให้ถูกต้องที่นี่ เก็บไว้เป็น 0 พอ (ฟิลด์เดิมไม่ได้ใช้ render จริงแล้ว)
function addCell(boardId, patch) {
  const db = readDB();
  const boardCells = db.cells.filter(c => c.board_id === boardId);
  const maxPosition = boardCells.reduce((max, c) => Math.max(max, Number(c.position) || 0), 0);

  const cell = {
    id: `cell-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    board_id: boardId,
    position: maxPosition + 1,
    row: 0,
    column: 0,
    image_url: '',
    model_3d_url: '',
    updated_at: new Date().toISOString(),
    type: patch.type,
    name: patch.name || '',
    description: patch.description || '',
    price: patch.price ?? null,
    rent_base: patch.rent_base ?? null,
    effect_value: patch.effect_value ?? null,
    effect_steps: patch.effect_steps ?? null,
    attractions: Array.isArray(patch.attractions) ? patch.attractions : [],
  };
  for (const key of EDITABLE_FIELDS) {
    if (key === 'type') continue; // ตั้งค่าไว้แล้วด้านบน กันถูกเขียนทับด้วย undefined
    if (Object.prototype.hasOwnProperty.call(patch, key)) cell[key] = patch[key];
  }

  db.cells.push(cell);
  writeDB(db);
  return cell;
}

// ลบช่อง แล้วเลื่อนตำแหน่งช่องที่อยู่หลังช่องที่ลบทั้งหมดขึ้นมา 1 เพื่อให้ position ยังคงต่อเนื่อง
// 1..N เสมอ (ระบบเดิน/วนรอบ START ในเกมพึ่งพาความต่อเนื่องนี้) ห้ามลบช่อง START เพราะผู้เล่นใหม่
// ทุกคนเริ่มที่ position 1 เสมอ (ดู addPlayer/addBot ใน game.js)
function deleteCell(id) {
  const db = readDB();
  const idx = db.cells.findIndex(c => c.id === id);
  if (idx === -1) return { error: 'ไม่พบช่องนี้', status: 404 };

  const target = db.cells[idx];
  if (target.type === 'START') return { error: 'ไม่สามารถลบช่อง START ได้', status: 400 };

  const boardCells = db.cells.filter(c => c.board_id === target.board_id);
  if (boardCells.length <= 4) return { error: 'ต้องมีช่องเหลืออย่างน้อย 4 ช่อง', status: 400 };

  db.cells.splice(idx, 1);
  for (const c of db.cells) {
    if (c.board_id === target.board_id && Number(c.position) > Number(target.position)) {
      c.position = Number(c.position) - 1;
    }
  }
  writeDB(db);
  return { ok: true };
}

// กติกาเกมส่วนกลาง (เงินเริ่มต้น, โบนัสผ่าน START ฯลฯ) แก้ได้จากหน้าแอดมิน — ถ้าไฟล์ยังไม่มี/พังจะ
// fallback มาใช้ค่าเริ่มต้นเหล่านี้แทน กันไม่ให้เกมพังเพราะไฟล์ตั้งค่าหาย
const DEFAULT_SETTINGS = {
  startMoney: 20000,
  // เดิมโบนัสผ่าน START เท่ากับทุนตั้งต้นพอดี (20,000) ทำให้ผ่าน START ทุก ~7 ตาก็ได้ทุนคืนเกือบเต็ม
  // แทบไม่มีใครล้มละลาย เศรษฐกิจในเกมจึงไม่มีความหมาย — ค่าเริ่มต้นจึงลดสัดส่วนลงเหลือ ~15% ของทุนเริ่มเกม
  startBonus: 3000,
  // จำกัดจำนวนรอบทั้งโต๊ะ กันเกมค้างไม่จบเมื่อไม่มีใครล้มละลาย — ครบแล้วให้ผู้เล่นทรัพย์สินรวมมากสุดชนะ
  maxRounds: 16,
  // เวลาที่ผู้เล่นจริงมีก่อนระบบทอย/ตอบ/ตัดสินใจแทนอัตโนมัติ (กันโต๊ะค้างเมื่อ AFK)
  turnTimeoutSeconds: 45,
  // ระยะเวลาการประมูลทรัพย์สินที่ถูกปฏิเสธซื้อ
  auctionDurationSeconds: 5,
  // ค่าใช้จ่ายอัปเกรดที่ดิน = ราคาที่ดิน x (เปอร์เซ็นต์นี้ / 100)
  upgradeCostPercent: 50,
  // ราคาขายที่ดินคืนธนาคาร = ราคาที่ดิน x (เปอร์เซ็นต์นี้ / 100)
  sellBackPercent: 50,
  // ตัวคูณค่าเช่าตามระดับอัปเกรด (Lv.0 คูณ 1 เสมอ ไม่ให้แก้ได้ เพราะเป็นค่าเช่าฐาน)
  rentMultiplierLv1Percent: 150,
  rentMultiplierLv2Percent: 225,
  rentMultiplierLv3Percent: 300,
  // ราคาประมูลขั้นต่ำ/ราคาเพิ่มขั้นต่ำ = ราคาที่ดิน x (เปอร์เซ็นต์นี้ / 100)
  auctionMinBidPercent: 10,
  auctionMinIncrementPercent: 5,
  // AI จะตัดสินใจซื้อที่ดินก็ต่อเมื่อเหลือเงินหลังซื้ออย่างน้อยเงินเริ่มต้น x (เปอร์เซ็นต์นี้ / 100)
  aiReservePercent: 25,
};

const SETTINGS_FIELDS = Object.keys(DEFAULT_SETTINGS);

function getGameSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (err) {
    return { ...DEFAULT_SETTINGS };
  }
}

function updateGameSettings(patch) {
  const current = getGameSettings();
  for (const key of SETTINGS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) current[key] = patch[key];
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(current, null, 2), 'utf-8');
  return current;
}

// ดูรูปที่อัปโหลดและลบที่ไม่ใช้แล้ว
function getUploadedImages() {
  const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
  if (!fs.existsSync(uploadDir)) return [];
  return fs.readdirSync(uploadDir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .map(filename => ({
      filename,
      url: `/uploads/${filename}`,
      size: fs.statSync(path.join(uploadDir, filename)).size,
    }));
}

function deleteImage(filename) {
  // ประเมินความปลอดภัย: อนุญาตแค่ชื่อไฟล์ที่ถูกต้อง (timestamp-hex.ext)
  if (!/^\d+-[0-9a-f]+\.(png|jpg|jpeg|webp)$/i.test(filename)) return false;
  const filepath = path.join(__dirname, '..', 'public', 'uploads', filename);
  if (!fs.existsSync(filepath)) return false;
  fs.unlinkSync(filepath);
  return true;
}

// ดูว่ารูปไฟล์ไหนถูกใช้ในตารางช่องบอร์ด (หลังจากลบต้องทำให้ปลอดภัย)
function getReferencedImages() {
  const db = readDB();
  const urls = new Set();
  db.cells.forEach(cell => {
    if (cell.image_url && cell.image_url.startsWith('/uploads/')) {
      urls.add(cell.image_url);
    }
  });
  return urls;
}

// ประวัติเกมที่จบแล้ว (ทั้งจบตามธรรมชาติและถูกแอดมินปิด) — เก็บล่าสุดไว้ไม่เกิน
// MAX_HISTORY_ENTRIES รายการ กันไฟล์โตไม่มีที่สิ้นสุด
function addGameHistory(record) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch (err) {
    list = [];
  }
  list.unshift(record);
  if (list.length > MAX_HISTORY_ENTRIES) list = list.slice(0, MAX_HISTORY_ENTRIES);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(list, null, 2), 'utf-8');
  return record;
}

function getGameHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch (err) {
    return [];
  }
}

// ส่งออกข้อมูลตั้งค่าทั้งหมด (บอร์ด, บัญชีแอดมิน, การ์ด, กติกาเกม) เป็นไฟล์เดียวเพื่อสำรอง/ย้ายเซิร์ฟเวอร์
function exportConfig() {
  return {
    exportedAt: new Date().toISOString(),
    db: readDB(),
    cards: readCards(),
    settings: getGameSettings(),
  };
}

// สำรองไฟล์ปัจจุบันไว้ก่อนเขียนทับทุกครั้งที่กู้คืน กันพลาดกู้คืนไฟล์ที่ผิดแล้วข้อมูลเดิมหายถาวร
function backupCurrentFiles() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_DIR, stamp);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, srcPath] of [['db.json', DB_PATH], ['cards.json', CARDS_PATH], ['settings.json', SETTINGS_PATH]]) {
    try {
      fs.copyFileSync(srcPath, path.join(dir, name));
    } catch (err) {
      // ไฟล์อาจยังไม่เคยถูกสร้าง (เช่น settings.json ก่อนตั้งค่าครั้งแรก) ข้ามไปได้
    }
  }
  return stamp;
}

function importConfig(bundle) {
  if (!bundle || typeof bundle !== 'object') return { error: 'ไฟล์ไม่ถูกต้อง' };
  const { db, cards, settings } = bundle;
  if (!db || !Array.isArray(db.cells) || !Array.isArray(db.admins) || typeof db.cellTypes !== 'object') {
    return { error: 'โครงสร้างข้อมูลกระดาน/บัญชีไม่ถูกต้อง' };
  }
  if (db.admins.length < 1) return { error: 'ต้องมีบัญชีแอดมินอย่างน้อย 1 บัญชีในไฟล์ที่กู้คืน' };
  if (!cards || !Array.isArray(cards.quiz) || !Array.isArray(cards.angel)) {
    return { error: 'โครงสร้างข้อมูลการ์ดไม่ถูกต้อง' };
  }
  if (!settings || typeof settings !== 'object') {
    return { error: 'โครงสร้างข้อมูลตั้งค่าไม่ถูกต้อง' };
  }

  const backupStamp = backupCurrentFiles();
  writeDB(db);
  writeCards(cards);
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  return { ok: true, backupStamp };
}

module.exports = {
  readDB, writeDB, getAdminByUsername, getAdmins, createAdmin, deleteAdmin, updateAdminPassword, getCellTypes,
  getCells, getCellById, updateCell, addCell, deleteCell, EDITABLE_FIELDS,
  getQuizCards, getAngelCards, addCard, updateCard, deleteCard,
  getGameSettings, updateGameSettings, SETTINGS_FIELDS,
  getUploadedImages, deleteImage, getReferencedImages,
  addGameHistory, getGameHistory,
  exportConfig, importConfig,
};
