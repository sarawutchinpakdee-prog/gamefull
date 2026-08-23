const express = require('express');
const { getAdmins, createAdmin, deleteAdmin, updateAdminPassword, getAdminByUsername } = require('./store');
const { hashPassword, verifyPassword, requireAuth } = require('./auth');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;

function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'ชื่อผู้ใช้ต้องมีความยาว 3-30 ตัวอักษร ใช้ได้เฉพาะ a-z, 0-9, . _ -';
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 100) {
    return 'รหัสผ่านต้องมีความยาว 8-100 ตัวอักษร';
  }
  return null;
}

// บัญชีแอดมินทุกบัญชีมีสิทธิ์เท่ากันหมด (ไม่มี super-admin) — เหมาะกับทีมเล็กที่ไว้ใจกัน
// ทุก endpoint ด้านล่างจึงแค่ต้อง login อยู่ ไม่ต้องเช็ค role เพิ่ม

router.get('/admin/accounts', requireAuth, (req, res) => {
  res.json(getAdmins());
});

router.post('/admin/accounts', requireAuth, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  const usernameErr = validateUsername(username);
  if (usernameErr) return res.status(400).json({ error: usernameErr });
  const passwordErr = validatePassword(password);
  if (passwordErr) return res.status(400).json({ error: passwordErr });

  const created = createAdmin(username, hashPassword(password));
  if (!created) return res.status(409).json({ error: 'มีชื่อผู้ใช้นี้อยู่แล้ว' });
  res.status(201).json(created);
});

router.delete('/admin/accounts/:username', requireAuth, (req, res) => {
  const result = deleteAdmin(req.params.username);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.json({ ok: true });
});

// เปลี่ยนรหัสผ่านของ "ตัวเอง" ต้องยืนยันด้วยรหัสผ่านเดิมก่อน — แต่ถ้าเป็นการรีเซ็ตรหัสผ่าน
// ให้บัญชีอื่น (แอดมินคนอื่นลืมรหัสผ่าน) ไม่ต้องใช้รหัสผ่านเดิม เพราะผู้ทำรายการล็อกอินอยู่แล้ว
router.put('/admin/accounts/:username/password', requireAuth, (req, res) => {
  const targetUsername = req.params.username;
  const newPassword = String(req.body?.newPassword || '');

  const passwordErr = validatePassword(newPassword);
  if (passwordErr) return res.status(400).json({ error: passwordErr });

  const admin = getAdminByUsername(targetUsername);
  if (!admin) return res.status(404).json({ error: 'ไม่พบบัญชีนี้' });

  if (targetUsername === req.admin.sub) {
    const currentPassword = String(req.body?.currentPassword || '');
    if (!currentPassword || !verifyPassword(currentPassword, admin.password_hash)) {
      return res.status(401).json({ error: 'รหัสผ่านเดิมไม่ถูกต้อง' });
    }
  }

  updateAdminPassword(targetUsername, hashPassword(newPassword));
  res.json({ ok: true });
});

module.exports = router;
