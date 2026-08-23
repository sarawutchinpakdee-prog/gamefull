const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const CARDS_PATH = path.join(__dirname, '..', 'data', 'cards.json');

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

module.exports = {
  readDB, writeDB, getAdminByUsername, getCellTypes,
  getCells, getCellById, updateCell, EDITABLE_FIELDS,
  getQuizCards, getAngelCards, addCard, updateCard, deleteCard,
};
