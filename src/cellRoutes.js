const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getCells, getCellById, updateCell, addCell, deleteCell, getCellTypes, EDITABLE_FIELDS, getUploadedImages, deleteImage, getReferencedImages } = require('./store');
const tourism = require('../data/tourism.json');
const { requireAuth } = require('./auth');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGES = {
  'image/png': { ext: '.png', signature: buf => buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) },
  'image/jpeg': { ext: '.jpg', signature: buf => buf.length >= 3 && buf.subarray(0, 3).equals(Buffer.from([0xff,0xd8,0xff])) },
  'image/webp': { ext: '.webp', signature: buf => buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP' },
};

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// POST /api/upload-image -> อัปโหลดรูปภาพสำหรับช่อง (เฉพาะแอดมิน)
router.post('/upload-image', requireAuth, express.raw({
  type: Object.keys(ALLOWED_IMAGES),
  limit: MAX_IMAGE_BYTES,
}), (req, res) => {
  const contentType = req.headers['content-type'];
  const rule = ALLOWED_IMAGES[contentType];
  if (!rule) {
    return res.status(415).json({ error: 'รองรับเฉพาะ PNG, JPG/JPEG และ WebP' });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'ไม่พบไฟล์รูปภาพ' });
  }
  if (req.body.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: 'ไฟล์รูปภาพใหญ่เกิน 5 MB' });
  }
  if (!rule.signature(req.body)) {
    return res.status(400).json({ error: 'ไฟล์ไม่ตรงกับชนิดรูปภาพที่ส่งมา' });
  }

  try {
    ensureUploadDir();
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${rule.ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.body);
    return res.status(201).json({
      url: `/uploads/${filename}`,
      filename,
      size: req.body.length,
    });
  } catch (err) {
    console.error('Image upload failed:', err);
    return res.status(500).json({ error: 'ไม่สามารถบันทึกรูปภาพได้' });
  }
});

// GET /api/tourism -> ข้อมูลท่องเที่ยวครบ 20 อำเภอ
router.get('/tourism', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const category = String(req.query.category || '').trim();
  let districts = tourism.districts;
  if (category) districts = districts.filter(d => d.category === category);
  if (q) districts = districts.filter(d => [d.district, d.category, d.summary, ...d.attractions].join(' ').toLowerCase().includes(q));
  res.json({ province: tourism.province, updatedAt: tourism.updatedAt, total: districts.length, categories: [...new Set(tourism.districts.map(d => d.category))], districts });
});

// GET /api/cell-types -> lookup ประเภทช่อง (สำหรับ dropdown ในหน้าแอดมิน)
router.get('/cell-types', (req, res) => {
  res.json(getCellTypes());
});

// GET /api/board/:boardId/cells -> รายการช่องทั้งหมดของบอร์ด (ใช้ render กระดาน)
router.get('/board/:boardId/cells', (req, res) => {
  res.json(getCells(req.params.boardId));
});

// GET /api/cells/:id -> รายละเอียดช่องเดียว (แสดงเมื่อคลิกที่ช่อง)
router.get('/cells/:id', (req, res) => {
  const cell = getCellById(req.params.id);
  if (!cell) return res.status(404).json({ error: 'ไม่พบช่องนี้' });
  res.json(cell);
});

// ใช้ทั้งตอนแก้ไขช่องเดิม (PUT) และสร้างช่องใหม่ (POST) — คืน error string ถ้าไม่ผ่าน หรือ null ถ้าผ่าน
function validateCellPatch(patch, { requireType } = {}) {
  const unknownKeys = Object.keys(patch).filter(k => !EDITABLE_FIELDS.includes(k));
  if (unknownKeys.length) {
    return `ไม่อนุญาตให้แก้ไขฟิลด์: ${unknownKeys.join(', ')}`;
  }

  if (requireType && !patch.type) return 'กรุณาเลือกประเภทช่อง';
  if (patch.type != null && !Object.prototype.hasOwnProperty.call(getCellTypes(), patch.type)) {
    return 'ประเภทช่องไม่ถูกต้อง';
  }
  for (const field of ['price', 'rent_base']) {
    if (patch[field] != null && (!Number.isFinite(Number(patch[field])) || Number(patch[field]) < 0)) {
      return `${field === 'price' ? 'ราคา' : 'ค่าเช่า'}ต้องเป็นตัวเลขไม่ติดลบ`;
    }
  }
  if (patch.effect_value != null && !Number.isFinite(Number(patch.effect_value))) {
    return 'ค่าผลกระทบต้องเป็นตัวเลข';
  }
  if (patch.effect_steps != null && (!Number.isInteger(Number(patch.effect_steps)) || Math.abs(Number(patch.effect_steps)) > 24)) {
    return 'จำนวนช่องเดินต้องเป็นจำนวนเต็ม และไม่เกิน 24 ช่อง';
  }
  if (patch.attractions != null) {
    if (!Array.isArray(patch.attractions)) return 'สถานที่ท่องเที่ยวต้องเป็นรายการ (array)';
    if (patch.attractions.length > 20) return 'สถานที่ท่องเที่ยวมีได้ไม่เกิน 20 รายการ';
    if (patch.attractions.some(item => typeof item !== 'string' || item.trim().length === 0 || item.trim().length > 200)) {
      return 'ชื่อสถานที่ท่องเที่ยวต้องเป็นข้อความ 1-200 ตัวอักษร';
    }
  }
  if (patch.image_url != null) {
    const imageUrl = String(patch.image_url).trim();
    if (imageUrl && !(/^https?:\/\//i.test(imageUrl) || imageUrl.startsWith('/uploads/'))) {
      return 'URL รูปภาพต้องเป็น http/https หรือไฟล์ที่อัปโหลดใน /uploads/';
    }
    if (imageUrl.length > 1000) return 'URL รูปภาพยาวเกินไป';
  }
  for (const field of ['phone', 'facebook', 'line_id', 'website']) {
    if (patch[field] != null && String(patch[field]).length > 200) {
      return `${field} ยาวเกินไป (สูงสุด 200 ตัวอักษร)`;
    }
  }
  if (patch.website != null && patch.website.trim() && !/^https?:\/\//i.test(patch.website.trim())) {
    return 'website ต้องเป็น http/https URL';
  }
  return null;
}

// PUT /api/cells/:id -> แก้ไขช่อง (เฉพาะแอดมินที่ล็อกอินแล้วเท่านั้น)
router.put('/cells/:id', requireAuth, (req, res) => {
  const existing = getCellById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'ไม่พบช่องนี้' });

  const patch = req.body || {};
  const error = validateCellPatch(patch);
  if (error) return res.status(400).json({ error });

  const updated = updateCell(req.params.id, patch);
  res.json(updated);
});

// POST /api/cells -> เพิ่มช่องใหม่ต่อท้ายกระดาน (เฉพาะแอดมิน)
router.post('/cells', requireAuth, (req, res) => {
  const patch = req.body || {};
  const error = validateCellPatch(patch, { requireType: true });
  if (error) return res.status(400).json({ error });

  const boardId = String(req.body?.board_id || 'default');
  const created = addCell(boardId, patch);
  res.status(201).json(created);
});

// DELETE /api/cells/:id -> ลบช่อง (ห้ามลบ START, ต้องเหลืออย่างน้อย 4 ช่อง)
router.delete('/cells/:id', requireAuth, (req, res) => {
  const result = deleteCell(req.params.id);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.json({ ok: true });
});

// GET /api/admin/images -> รายการรูปที่อัปโหลด พร้อมสถานะว่าใช้งานอยู่รึเปล่า
router.get('/admin/images', requireAuth, (req, res) => {
  const uploaded = getUploadedImages();
  const referenced = getReferencedImages();
  const withStatus = uploaded.map(img => ({
    ...img,
    inUse: referenced.has(img.url),
  }));
  res.json(withStatus);
});

// DELETE /api/admin/images/:filename -> ลบรูปที่ไม่ใช้แล้ว
router.delete('/admin/images/:filename', requireAuth, (req, res) => {
  const filename = String(req.params.filename);
  if (!deleteImage(filename)) {
    return res.status(404).json({ error: 'ไม่พบไฟล์นี้ หรือชื่อไฟล์ไม่ถูกต้อง' });
  }
  res.json({ ok: true });
});

module.exports = router;
