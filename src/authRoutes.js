const express = require('express');
const { getAdminByUsername } = require('./store');
const { verifyPassword, signToken, requireAuth } = require('./auth');

const router = express.Router();

// ป้องกัน brute-force: ล็อกบัญชีชั่วคราวหลังพยายามผิด 5 ครั้งติดต่อกัน (เก็บใน memory พอ เพราะ
// ข้อมูลนี้ไม่จำเป็นต้องอยู่รอด restart — ล็อกอินใหม่ก็เริ่มนับใหม่ได้)
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedAttempts = new Map(); // username(lowercase) -> { count, lockedUntil }

function getLockState(username) {
  return failedAttempts.get(username) || { count: 0, lockedUntil: 0 };
}

function registerFailure(username) {
  const state = getLockState(username);
  state.count += 1;
  if (state.count >= MAX_ATTEMPTS) {
    state.lockedUntil = Date.now() + LOCKOUT_MS;
    state.count = 0;
  }
  failedAttempts.set(username, state);
}

function clearFailures(username) {
  failedAttempts.delete(username);
}

// POST /api/auth/login  { username, password } -> { token, username }
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
  }

  const key = String(username).toLowerCase();
  const state = getLockState(key);
  if (state.lockedUntil > Date.now()) {
    const minutesLeft = Math.ceil((state.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `พยายามเข้าสู่ระบบผิดหลายครั้งเกินไป กรุณาลองใหม่ในอีก ${minutesLeft} นาที` });
  }

  const admin = getAdminByUsername(username);
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    registerFailure(key);
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }

  clearFailures(key);
  const token = signToken(admin);
  res.json({ token, username: admin.username });
});

// GET /api/auth/me -> ตรวจสอบว่า token ยังใช้ได้อยู่ไหม
router.get('/me', requireAuth, (req, res) => {
  res.json({ username: req.admin.sub, role: req.admin.role });
});

module.exports = router;
