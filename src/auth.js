const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// ใน production ควรเซ็ตผ่าน environment variable เสมอ — ถ้าไม่เซ็ตจะสุ่มค่าใหม่ทุกครั้งที่
// เซิร์ฟเวอร์เริ่มทำงาน (ทำให้ token เก่าใช้ไม่ได้หลัง restart แต่ปลอดภัยกว่าค่า default ที่ทายได้)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET ไม่ได้ตั้งค่า — สุ่มค่าชั่วคราวให้ (โทเค็นทั้งหมดจะหมดอายุเมื่อรีสตาร์ทเซิร์ฟเวอร์) ใน production ควรตั้ง JWT_SECRET ใน environment variable');
}
const TOKEN_TTL = '8h';

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function signToken(admin) {
  return jwt.sign(
    { sub: admin.username, role: 'admin' },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'ต้องเข้าสู่ระบบก่อนใช้งานส่วนนี้' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
  }
}

module.exports = { hashPassword, verifyPassword, signToken, requireAuth };
