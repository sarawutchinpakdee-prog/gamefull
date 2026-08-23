const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const CARDS_PATH = path.join(__dirname, '..', 'data', 'cards.json');
const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'game_history.json');
const MAX_HISTORY_ENTRIES = 300;

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

module.exports = {
  readDB, writeDB, getAdminByUsername, getAdmins, createAdmin, deleteAdmin, updateAdminPassword, getCellTypes,
  getCells, getCellById, updateCell, EDITABLE_FIELDS,
  getQuizCards, getAngelCards, addCard, updateCard, deleteCard,
  getGameSettings, updateGameSettings, SETTINGS_FIELDS,
  getUploadedImages, deleteImage, getReferencedImages,
  addGameHistory, getGameHistory,
};
