const express = require('express');
const { getGameSettings, updateGameSettings } = require('./store');
const { requireAuth } = require('./auth');

const router = express.Router();

const LIMITS = {
  startMoney: { min: 1000, max: 200000, label: 'เงินเริ่มต้น' },
  startBonus: { min: 0, max: 50000, label: 'โบนัสผ่าน START' },
  maxRounds: { min: 4, max: 60, label: 'จำนวนตาสูงสุด' },
  turnTimeoutSeconds: { min: 10, max: 300, label: 'เวลาต่อตา (วินาที)' },
  auctionDurationSeconds: { min: 3, max: 60, label: 'ระยะเวลาประมูล (วินาที)' },
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

module.exports = router;
