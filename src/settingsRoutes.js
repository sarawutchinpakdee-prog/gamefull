const express = require('express');
const { getGameSettings, updateGameSettings, exportConfig, importConfig } = require('./store');
const { requireAuth } = require('./auth');

const router = express.Router();

const LIMITS = {
  startMoney: { min: 1000, max: 200000, label: 'เงินเริ่มต้น' },
  startBonus: { min: 0, max: 50000, label: 'โบนัสผ่าน START' },
  maxRounds: { min: 4, max: 60, label: 'จำนวนตาสูงสุด' },
  turnTimeoutSeconds: { min: 10, max: 300, label: 'เวลาต่อตา (วินาที)' },
  auctionDurationSeconds: { min: 3, max: 60, label: 'ระยะเวลาประมูล (วินาที)' },
  upgradeCostPercent: { min: 10, max: 200, label: 'ค่าใช้จ่ายอัปเกรด (% ของราคาที่ดิน)' },
  sellBackPercent: { min: 10, max: 100, label: 'ราคาขายคืน (% ของราคาที่ดิน)' },
  rentMultiplierLv1Percent: { min: 100, max: 500, label: 'ตัวคูณค่าเช่า Lv.1 (%)' },
  rentMultiplierLv2Percent: { min: 100, max: 500, label: 'ตัวคูณค่าเช่า Lv.2 (%)' },
  rentMultiplierLv3Percent: { min: 100, max: 500, label: 'ตัวคูณค่าเช่า Lv.3 (%)' },
  auctionMinBidPercent: { min: 1, max: 100, label: 'ราคาประมูลขั้นต่ำ (% ของราคาที่ดิน)' },
  auctionMinIncrementPercent: { min: 1, max: 100, label: 'ราคาเพิ่มขั้นต่ำในการประมูล (%)' },
  aiReservePercent: { min: 0, max: 100, label: 'เงินสำรองขั้นต่ำก่อน AI จะซื้อ (%)' },
};

// อนุญาตแก้บางฟิลด์ (partial patch) — ฟิลด์ที่ไม่ได้ส่งมาคงค่าเดิมไว้
function validateSettingsPatch(body) {
  const patch = {};
  for (const [key, { min, max, label }] of Object.entries(LIMITS)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = Number(body[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      return { error: `${label} ต้องเป็นจำนวนเต็มระหว่าง ${min.toLocaleString()} ถึง ${max.toLocaleString()}` };
    }
    patch[key] = value;
  }
  return { patch };
}

// GET/PUT /api/settings -> กติกาเกมส่วนกลาง แก้แล้วมีผลกับเกมที่กำลังเล่นอยู่ทันที (อ่านจากไฟล์สดทุกครั้งใน game.js)
router.get('/settings', requireAuth, (req, res) => {
  res.json(getGameSettings());
});

router.put('/settings', requireAuth, (req, res) => {
  const { error, patch } = validateSettingsPatch(req.body || {});
  if (error) return res.status(400).json({ error });
  res.json(updateGameSettings(patch));
});

// GET /api/admin/backup -> ไฟล์รวมข้อมูลกระดาน/บัญชี/การ์ด/กติกาเกม สำหรับดาวน์โหลดเก็บสำรอง
router.get('/admin/backup', requireAuth, (req, res) => {
  res.json(exportConfig());
});

// POST /api/admin/restore -> กู้คืนจากไฟล์สำรอง (สำรองไฟล์ปัจจุบันไว้ก่อนเขียนทับเสมอ)
router.post('/admin/restore', requireAuth, (req, res) => {
  const result = importConfig(req.body);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

module.exports = router;
