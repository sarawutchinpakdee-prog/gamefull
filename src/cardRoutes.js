const express = require('express');
const { getQuizCards, getAngelCards, addCard, updateCard, deleteCard } = require('./store');
const { requireAuth } = require('./auth');

const router = express.Router();

const QUIZ_CHOICES_MIN = 2;
const QUIZ_CHOICES_MAX = 6;

// การ์ดคำถาม/นางฟ้าเป็นเนื้อหาที่มีผลต่อผลลัพธ์เกมโดยตรง (เช่นคำตอบที่ถูก) จึงให้แก้/ดูได้เฉพาะแอดมินที่ล็อกอินแล้ว

function validateQuizBody(body) {
  const q = String(body.q || '').trim();
  if (!q || q.length > 300) return 'คำถามต้องมีความยาว 1-300 ตัวอักษร';

  if (!Array.isArray(body.choices) || body.choices.length < QUIZ_CHOICES_MIN || body.choices.length > QUIZ_CHOICES_MAX) {
    return `ตัวเลือกต้องมี ${QUIZ_CHOICES_MIN}-${QUIZ_CHOICES_MAX} ข้อ`;
  }
  const choices = body.choices.map(c => String(c).trim());
  if (choices.some(c => !c || c.length > 150)) return 'แต่ละตัวเลือกต้องมีความยาว 1-150 ตัวอักษร';

  const answer = Number(body.answer);
  if (!Number.isInteger(answer) || answer < 0 || answer >= choices.length) {
    return 'ต้องระบุคำตอบที่ถูกต้องให้ตรงกับลำดับตัวเลือก';
  }
  return null;
}

function normalizeQuizBody(body) {
  return {
    q: String(body.q).trim(),
    choices: body.choices.map(c => String(c).trim()),
    answer: Number(body.answer),
  };
}

function validateAngelBody(body) {
  const title = String(body.title || '').trim();
  if (!title || title.length > 60) return 'ชื่อการ์ดต้องมีความยาว 1-60 ตัวอักษร';

  const text = String(body.text || '').trim();
  if (!text || text.length > 200) return 'คำอธิบายต้องมีความยาว 1-200 ตัวอักษร';

  const money = body.money == null || body.money === '' ? 0 : Number(body.money);
  if (!Number.isFinite(money) || Math.abs(money) > 20000) return 'จำนวนเงินต้องเป็นตัวเลขไม่เกิน 20,000';

  const steps = body.steps == null || body.steps === '' ? 0 : Number(body.steps);
  if (!Number.isInteger(steps) || Math.abs(steps) > 12) return 'จำนวนช่องเดินต้องเป็นจำนวนเต็มไม่เกิน 12 ช่อง';

  const icon = String(body.icon || '').trim();
  if (icon.length > 8) return 'ไอคอนยาวเกินไป';

  return null;
}

function normalizeAngelBody(body) {
  return {
    title: String(body.title).trim(),
    text: String(body.text).trim(),
    money: body.money == null || body.money === '' ? 0 : Number(body.money),
    steps: body.steps == null || body.steps === '' ? 0 : Number(body.steps),
    icon: String(body.icon || '').trim() || '😇',
  };
}

// GET /api/cards -> คลังการ์ดทั้งหมด (สำหรับหน้าแอดมิน)
router.get('/cards', requireAuth, (req, res) => {
  res.json({ quiz: getQuizCards(), angel: getAngelCards() });
});

// ---------- การ์ดคำถาม (quiz) ----------
router.post('/cards/quiz', requireAuth, (req, res) => {
  const err = validateQuizBody(req.body || {});
  if (err) return res.status(400).json({ error: err });
  res.status(201).json(addCard('quiz', normalizeQuizBody(req.body)));
});

router.put('/cards/quiz/:id', requireAuth, (req, res) => {
  const err = validateQuizBody(req.body || {});
  if (err) return res.status(400).json({ error: err });
  const card = updateCard('quiz', req.params.id, normalizeQuizBody(req.body));
  if (!card) return res.status(404).json({ error: 'ไม่พบการ์ดนี้' });
  res.json(card);
});

router.delete('/cards/quiz/:id', requireAuth, (req, res) => {
  if (!deleteCard('quiz', req.params.id)) return res.status(404).json({ error: 'ไม่พบการ์ดนี้' });
  res.json({ ok: true });
});

// ---------- การ์ดนางฟ้า (angel) ----------
router.post('/cards/angel', requireAuth, (req, res) => {
  const err = validateAngelBody(req.body || {});
  if (err) return res.status(400).json({ error: err });
  res.status(201).json(addCard('angel', normalizeAngelBody(req.body)));
});

router.put('/cards/angel/:id', requireAuth, (req, res) => {
  const err = validateAngelBody(req.body || {});
  if (err) return res.status(400).json({ error: err });
  const card = updateCard('angel', req.params.id, normalizeAngelBody(req.body));
  if (!card) return res.status(404).json({ error: 'ไม่พบการ์ดนี้' });
  res.json(card);
});

router.delete('/cards/angel/:id', requireAuth, (req, res) => {
  if (!deleteCard('angel', req.params.id)) return res.status(404).json({ error: 'ไม่พบการ์ดนี้' });
  res.json({ ok: true });
});

module.exports = router;
