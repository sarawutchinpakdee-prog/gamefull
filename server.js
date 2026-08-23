const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const authRoutes = require('./src/authRoutes');
const cellRoutes = require('./src/cellRoutes');
const cardRoutes = require('./src/cardRoutes');
const settingsRoutes = require('./src/settingsRoutes');
const accountRoutes = require('./src/accountRoutes');
const game = require('./src/game');
const { requireAuth } = require('./src/auth');
const { getGameSettings, addGameHistory, getGameHistory } = require('./src/store');

// จำกัด origin ที่เรียก API/Socket.IO ข้ามโดเมนได้ ผ่าน env var ALLOWED_ORIGINS (คั่นด้วยจุลภาค)
// เช่น "https://board.example.com,https://admin.example.com" — ถ้าไม่ตั้งค่าจะปิด cross-origin
// ทั้งหมด (ปลอดภัยสุด และใช้ได้ปกติเพราะหน้าเว็บกับ API อยู่ origin เดียวกันอยู่แล้วโดย default)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const corsOrigin = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin } });

const PORT = process.env.PORT || 4000;

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '5mb' })); // เผื่อกู้คืนไฟล์สำรอง (db+cards+settings รวมกัน) ที่ใหญ่กว่า default 100kb
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api', cellRoutes);
app.use('/api', cardRoutes);
app.use('/api', settingsRoutes);
app.use('/api', accountRoutes);
app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ============================================================
   ADMIN — มองเห็น/จัดการห้องเกมที่กำลังเล่นอยู่จริง (in-memory sessions)
   ============================================================ */
app.get('/api/admin/rooms', requireAuth, (req, res) => {
  const rooms = game.listSessions()
    .map(session => ({
      id: session.id,
      mode: session.mode,
      createdAt: session.createdAt || null,
      gameOver: session.gameOver,
      winnerName: session.winnerName || null,
      turnCount: session.turnCount,
      playerCount: session.players.length,
      connectedCount: session.players.filter(p => p.connected && !p.isBot).length,
      players: session.players.map(p => ({
        id: p.socketId,
        name: p.name,
        color: p.color,
        money: p.money,
        connected: !!p.connected,
        bankrupt: !!p.bankrupt,
        isBot: !!p.isBot,
      })),
    }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json(rooms);
});

app.get('/api/admin/rooms/:id', requireAuth, (req, res) => {
  const session = game.getSession(normalizeRoomId(req.params.id));
  if (!session) return res.status(404).json({ error: 'ไม่พบห้องนี้' });
  res.json(game.publicState(session));
});

app.post('/api/admin/rooms/:id/close', requireAuth, (req, res) => {
  const sid = normalizeRoomId(req.params.id);
  const session = game.getSession(sid);
  if (!session) return res.status(404).json({ error: 'ไม่พบห้องนี้' });

  io.to(sid).emit('error_msg', 'ห้องนี้ถูกปิดโดยแอดมิน');
  const socketIds = io.sockets.adapter.rooms.get(sid);
  if (socketIds) {
    for (const socketId of Array.from(socketIds)) {
      const sock = io.sockets.sockets.get(socketId);
      if (sock) sock.disconnect(true);
    }
  }
  clearTurnWatchdog(session);
  if (session.gameStarted && !session.gameOver) {
    addGameHistory(game.buildHistoryRecord(session, 'admin_closed'));
  }
  game.deleteSession(sid);
  res.json({ ok: true });
});

app.get('/api/admin/history', requireAuth, (req, res) => {
  res.json(getGameHistory());
});

app.post('/api/admin/rooms/:id/kick', requireAuth, (req, res) => {
  const sid = normalizeRoomId(req.params.id);
  const session = game.getSession(sid);
  if (!session) return res.status(404).json({ error: 'ไม่พบห้องนี้' });

  const playerId = String(req.body?.playerId || '');
  const player = session.players.find(p => p.socketId === playerId);
  if (!player) return res.status(404).json({ error: 'ไม่พบผู้เล่นนี้ในห้อง' });

  const sock = io.sockets.sockets.get(playerId);
  if (sock) sock.emit('error_msg', 'คุณถูกเตะออกจากห้องโดยแอดมิน');
  game.kickPlayer(session, playerId);
  game.addLog(session, `👑 แอดมินนำ ${player.name} ออกจากห้อง`);
  if (sock) sock.disconnect(true);

  if (session.players.length) {
    io.to(sid).emit('state_update', game.publicState(session));
    io.to(sid).emit('gm_log', session.logs[0]);
    scheduleTurnWatchdog(session);
  } else {
    if (session.gameStarted && !session.gameOver) {
      addGameHistory(game.buildHistoryRecord(session, 'admin_closed'));
    }
    game.deleteSession(sid);
  }
  res.json({ ok: true });
});

// ปรับเงินผู้เล่นกลางเกม — ใช้แก้บั๊ก/ชดเชยปัญหาเทคนิคโดยไม่ต้องปิดทั้งห้อง
app.post('/api/admin/rooms/:id/adjust-money', requireAuth, (req, res) => {
  const sid = normalizeRoomId(req.params.id);
  const session = game.getSession(sid);
  if (!session) return res.status(404).json({ error: 'ไม่พบห้องนี้' });

  const playerId = String(req.body?.playerId || '');
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'จำนวนเงินต้องเป็นตัวเลขไม่เท่ากับ 0' });
  }
  if (Math.abs(amount) > 100000000) {
    return res.status(400).json({ error: 'จำนวนเงินต้องไม่เกิน 100,000,000' });
  }

  const player = game.adjustPlayerMoney(session, playerId, amount);
  if (!player) return res.status(404).json({ error: 'ไม่พบผู้เล่นนี้ในห้อง' });

  game.addLog(session, `👑 แอดมินปรับเงินให้ ${player.name} ${amount >= 0 ? '+' : ''}${amount.toLocaleString()}`);
  io.to(sid).emit('state_update', game.publicState(session));
  io.to(sid).emit('gm_log', session.logs[0]);
  res.json({ ok: true, money: player.money });
});

// บังคับข้ามตาที่ค้าง (เหมือนกับที่ turn watchdog ทำอัตโนมัติเมื่อ AFK แต่แอดมินสั่งได้ทันที)
app.post('/api/admin/rooms/:id/force-skip', requireAuth, async (req, res) => {
  const sid = normalizeRoomId(req.params.id);
  const session = game.getSession(sid);
  if (!session) return res.status(404).json({ error: 'ไม่พบห้องนี้' });
  if (session.gameOver) return res.status(400).json({ error: 'เกมจบแล้ว' });

  clearTurnWatchdog(session);
  await handleTurnTimeout(session);
  res.json({ ok: true });
});

/* ============================================================
   SOCKET.IO — เลเยอร์เกม real-time (คนละส่วนกับ REST admin API
   แต่ใช้ store.js/cells ชุดเดียวกัน — แอดมินแก้ช่องแล้วมีผลกับ
   เกมที่กำลังเล่นอยู่ทันที เพราะอ่านจากไฟล์เดียวกันทุกครั้ง)
   ============================================================ */
function chooseAiAnswer(q, player) {
  if (!q || !Array.isArray(q.choices) || !q.choices.length) return 0;
  // บุคลิก AI จากเวอร์ชันก่อนหน้า: นักวางแผนแม่นที่สุด
  const name = String(player?.name || '').toLowerCase();
  let accuracy = 0.8;
  if (name.includes('วางแผน') || name.includes('planner')) accuracy = 0.92;
  else if (name.includes('เสี่ยง') || name.includes('risk')) accuracy = 0.68;
  else if (name.includes('ธุรกิจ') || name.includes('business')) accuracy = 0.82;
  else if (name.includes('ฉวย') || name.includes('opportun')) accuracy = 0.86;
  if (Math.random() < accuracy) return Number(q.answer) || 0;
  let wrong = Math.floor(Math.random() * q.choices.length);
  if (wrong === Number(q.answer) && q.choices.length > 1) wrong = (wrong + 1) % q.choices.length;
  return wrong;
}

function scheduleAiTurn(session, delay = 900) {
  if (!session || session.aiRunning || session.gameOver || !game.botShouldPlay(session)) return;
  session.aiRunning = true;
  setTimeout(async () => {
    try {
      const player = game.currentPlayer(session);
      if (!player || !player.isBot || session.gameOver) return;
      await new Promise(r => setTimeout(r, 350));
      if (session.pendingQuestion?.playerKey === player.playerKey && !session.gameOver) {
        const q = session.pendingQuestion;
        const answer = chooseAiAnswer(q, player);
        game.answerQuestion(io, session, player.socketId, answer);
      } else {
        const result = await game.handleRollDice(io, session, player.socketId);
        if (result?.error) {
          if (session.pendingPurchase?.playerKey === player.playerKey) {
            game.skipPropertyPurchase(io, session, player.socketId);
          }
        }

        // การ์ดคำถามอาจถูกสร้างขึ้นระหว่าง handleRollDice() หลังจาก AI เดินตก EVENT
        // ต้องตอบทันทีในรอบเดียวกัน ไม่ปล่อยให้เทิร์นค้างรอผู้เล่นจริง
        if (session.pendingQuestion?.playerKey === player.playerKey && !session.gameOver) {
          const q2 = session.pendingQuestion;
          const answer2 = chooseAiAnswer(q2, player);
          const answerResult = game.answerQuestion(io, session, player.socketId, answer2);
          if (answerResult?.error) {
            console.warn('AI quiz answer failed:', answerResult.error);
            // กันเทิร์นค้างจากข้อผิดพลาดของ AI: ข้ามการ์ดและไปเทิร์นถัดไป
            if (session.pendingQuestion?.playerKey === player.playerKey) {
              session.pendingQuestion = null;
              if (!session.gameOver && game.currentPlayer(session)?.playerKey === player.playerKey) {
                game.advanceTurn(session);
              }
            }
          }
        }
      }
      // ถ้าตก PROPERTY จะค้าง pendingPurchase; ให้ AI ตัดสินใจซื้อ/ไม่ซื้อ
      if (session.pendingPurchase?.playerKey === player.playerKey && !session.gameOver) {
        if (game.chooseBotPurchase(session, player)) {
          game.buyProperty(io, session, player.socketId);
        } else {
          game.skipPropertyPurchase(io, session, player.socketId);
        }
      }
      io.to(session.id).emit('state_update', game.publicState(session));
    } catch (err) {
      console.error('AI turn error:', err);
    } finally {
      session.aiRunning = false;
      if (!session.gameOver && game.botShouldPlay(session)) scheduleAiTurn(session, 800);
      if (session.pendingAuction) scheduleAuctionBotBidding(session);
      scheduleTurnWatchdog(session);
    }
  }, delay);
}

/* ============================================================
   TURN WATCHDOG — กันโต๊ะค้างเมื่อผู้เล่นจริงออนไลน์อยู่แต่เฉย (AFK)
   บอทมี scheduleAiTurn เดินให้อัตโนมัติอยู่แล้ว แต่ผู้เล่นจริงไม่มี
   ระบบใดคอยเตือน ถ้าไม่ทอย/ไม่ตอบ/ไม่ตัดสินใจซื้อภายในเวลาที่กำหนด
   จะให้ระบบจัดการแทนโดยอัตโนมัติ เพื่อไม่ให้ทั้งโต๊ะรอเก้อ
   ============================================================ */
function clearTurnWatchdog(session) {
  if (session?.turnWatchdog) {
    clearTimeout(session.turnWatchdog);
    session.turnWatchdog = null;
  }
}

function scheduleTurnWatchdog(session) {
  if (!session) return;
  clearTurnWatchdog(session);
  if (session.gameOver) return;
  const player = game.currentPlayer(session);
  if (!player || player.isBot || !player.connected) return;
  const timeoutMs = getGameSettings().turnTimeoutSeconds * 1000;
  session.turnWatchdog = setTimeout(() => handleTurnTimeout(session), timeoutMs);
}

async function handleTurnTimeout(session) {
  session.turnWatchdog = null;
  if (session.gameOver) return;
  const player = game.currentPlayer(session);
  if (!player || player.isBot || !player.connected) return;

  try {
    if (session.pendingQuestion?.playerKey === player.playerKey) {
      const pending = session.pendingQuestion;
      const wrongChoice = (Number(pending.answer) + 1) % pending.choices.length;
      game.addLog(session, `⏱️ ${player.name} ไม่ตอบการ์ดคำถามภายในเวลาที่กำหนด ระบบตอบแทนอัตโนมัติ`);
      game.answerQuestion(io, session, player.socketId, wrongChoice);
    } else if (session.pendingPurchase?.playerKey === player.playerKey) {
      game.addLog(session, `⏱️ ${player.name} ไม่ตัดสินใจซื้อภายในเวลาที่กำหนด ระบบข้ามให้อัตโนมัติ`);
      game.skipPropertyPurchase(io, session, player.socketId);
    } else if (!session.isMoving) {
      game.addLog(session, `⏱️ ${player.name} ไม่ทอยลูกเต๋าภายในเวลาที่กำหนด ระบบทอยแทนอัตโนมัติ`);
      const result = await game.handleRollDice(io, session, player.socketId);
      if (result?.error && session.pendingPurchase?.playerKey === player.playerKey) {
        game.skipPropertyPurchase(io, session, player.socketId);
      }
    }
    io.to(session.id).emit('gm_log', session.logs[0]);
    io.to(session.id).emit('state_update', game.publicState(session));
  } catch (err) {
    console.error('Turn watchdog error:', err);
  } finally {
    if (session.pendingAuction) scheduleAuctionBotBidding(session);
    scheduleTurnWatchdog(session);
    scheduleAiTurn(session, 700);
  }
}

/* ============================================================
   AUCTION BOT BIDDING — เมื่อทรัพย์สินเข้าสู่การประมูล ให้บอทในโต๊ะ
   สุ่มพิจารณาเสนอราคาเป็นระยะ เพื่อให้การประมูลในห้อง AI มีชีวิตชีวา
   ไม่ปล่อยให้ค้างเงียบจนหมดเวลาทุกครั้ง
   ============================================================ */
const AUCTION_BOT_TICK_MS = 1400;

function scheduleAuctionBotBidding(session) {
  if (!session || !session.pendingAuction || session.gameOver) return;
  const auctionCellId = session.pendingAuction.cellId;
  setTimeout(() => {
    const auction = session.pendingAuction;
    if (!auction || auction.cellId !== auctionCellId || session.gameOver) return;
    if (Date.now() >= auction.endsAt - 1200) return; // ปล่อยให้ปิดประมูลแบบไม่มีบอทแซงวินาทีสุดท้าย

    const bots = session.players.filter(p => p.isBot && p.connected && !p.bankrupt && p.playerKey !== auction.currentBidderKey);
    if (bots.length) {
      const bot = bots[Math.floor(Math.random() * bots.length)];
      const nextBid = auction.currentBid > 0 ? auction.currentBid + auction.minIncrement : auction.minBid;
      const budget = Math.floor(bot.money * 0.6);
      const priceCeiling = Math.floor(auction.price * 1.1);
      if (nextBid <= budget && nextBid <= priceCeiling && Math.random() < 0.55) {
        game.placeBid(io, session, bot.socketId, nextBid);
      }
    }
    scheduleAuctionBotBidding(session);
  }, AUCTION_BOT_TICK_MS + Math.random() * 900);
}

function normalizeRoomId(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
}

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  do {
    id = '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (game.getSession(id));
  return id;
}

function joinSession(socket, { sessionId, playerName, playerToken, mode, aiCount }) {
  const sid = normalizeRoomId(sessionId);
  if (!sid) return socket.emit('error_msg', 'กรุณาระบุรหัสห้อง');

  let session = game.getSession(sid);
  if (!session && mode === 'ai') {
    session = game.createSession(sid);
    // ตั้งโหมดทันทีตอนสร้างห้องใหม่ — ค่าเริ่มต้นของ createSession คือ 'human'
    // ถ้าไม่ตั้งก่อน เงื่อนไขตรวจโหมดด้านล่างจะเข้าใจผิดว่าห้องที่เพิ่งสร้างเป็นห้องผู้เล่น
    // แล้วปฏิเสธการสร้างห้อง AI ทุกครั้งที่เป็นห้องใหม่
    session.mode = 'ai';
  }
  if (!session) return socket.emit('error_msg', `ไม่พบห้อง ${sid} กรุณาตรวจสอบรหัสห้อง`);
  if (session.mode === 'ai' && mode !== 'ai') return socket.emit('error_msg', 'ห้องนี้เป็นห้อง AI ไม่สามารถเข้าร่วมแบบผู้เล่นได้');
  if (session.mode === 'human' && mode === 'ai') return socket.emit('error_msg', 'ห้องนี้เป็นห้องผู้เล่น ไม่สามารถเปลี่ยนเป็นห้อง AI ได้');
  if (session.gameOver) return socket.emit('error_msg', 'ห้องนี้จบเกมแล้ว กรุณาสร้างห้องใหม่');

  socket.join(sid);
  socket.data.sessionId = sid;
  session.mode = mode === 'ai' ? 'ai' : 'human';

  const playerKey = typeof playerToken === 'string' && playerToken.trim() ? playerToken.trim() : `player-${socket.id}`;
  const player = game.addPlayer(session, socket.id, playerName, playerKey);

  if (session.mode === 'ai' && session.aiCount === 0) {
    const count = Math.max(1, Math.min(3, Number(aiCount) || 3));
    for (let i = 1; i <= count; i++) game.addBot(session, `AI ${i}`);
    game.addLog(session, `${player.name} สร้างโต๊ะเล่นกับ AI ${count} คน`);
  } else {
    game.addLog(session, `${player.name} เข้าร่วมโต๊ะ`);
  }

  io.to(sid).emit('room_info', { roomId: sid, playerCount: session.players.length, mode: session.mode });
  io.to(sid).emit('state_update', game.publicState(session));
  io.to(sid).emit('gm_log', session.logs[0]);
  scheduleAiTurn(session, 1200);
  scheduleTurnWatchdog(session);
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ playerName, playerToken }) => {
    const sid = makeRoomId();
    const session = game.createSession(sid);
    session.mode = 'human';
    socket.emit('room_created', { roomId: sid });
    joinSession(socket, { sessionId: sid, playerName, playerToken, mode: 'human' });
  });

  socket.on('join', (payload = {}) => joinSession(socket, payload));

  socket.on('buy_property', () => {
    const sid = socket.data.sessionId;
    if (!sid) return socket.emit('error_msg', 'กรุณาเข้าร่วมเกมก่อน');
    const session = game.getOrCreateSession(sid);
    const result = game.buyProperty(io, session, socket.id);
    if (result.error) socket.emit('error_msg', result.error);
    scheduleAiTurn(session, 700);
    scheduleTurnWatchdog(session);
  });

  socket.on('sell_property', ({ cellId }) => {
    const sid = socket.data.sessionId;
    if (!sid) return socket.emit('error_msg', 'กรุณาเข้าร่วมเกมก่อน');
    const session = game.getOrCreateSession(sid);
    const result = game.sellProperty(io, session, socket.id, cellId);
    if (result.error) socket.emit('error_msg', result.error);
  });

  socket.on('upgrade_property', ({ cellId }) => {
    const sid = socket.data.sessionId;
    if (!sid) return socket.emit('error_msg', 'กรุณาเข้าร่วมเกมก่อน');
    const session = game.getOrCreateSession(sid);
    const result = game.upgradeProperty(io, session, socket.id, cellId);
    if (result.error) socket.emit('error_msg', result.error);
  });

  socket.on('transfer_property', ({ cellId, targetPlayerId }) => {
    const sid = socket.data.sessionId;
    if (!sid) return socket.emit('error_msg', 'กรุณาเข้าร่วมเกมก่อน');
    const session = game.getOrCreateSession(sid);
    const result = game.transferProperty(io, session, socket.id, cellId, targetPlayerId);
    if (result.error) socket.emit('error_msg', result.error);
  });

  socket.on('skip_property', () => {
    const sid = socket.data.sessionId;
    if (!sid) return socket.emit('error_msg', 'กรุณาเข้าร่วมเกมก่อน');
    const session = game.getOrCreateSession(sid);
    const result = game.skipPropertyPurchase(io, session, socket.id);
    if (result.error) socket.emit('error_msg', result.error);
    scheduleAiTurn(session, 700);
    if (session.pendingAuction) scheduleAuctionBotBidding(session);
    scheduleTurnWatchdog(session);
  });

  socket.on('auction_bid', ({ amount }) => {
    const sid = socket.data.sessionId;
    if (!sid) return socket.emit('error_msg', 'กรุณาเข้าร่วมเกมก่อน');
    const session = game.getOrCreateSession(sid);
    const result = game.placeBid(io, session, socket.id, amount);
    if (result.error) socket.emit('error_msg', result.error);
  });

  socket.on('roll_dice', async () => {
    const sid = socket.data.sessionId;
    if (!sid) return socket.emit('error_msg', 'กรุณา join ก่อนทอยลูกเต๋า');
    const session = game.getOrCreateSession(sid);
    const result = await game.handleRollDice(io, session, socket.id);
    if (result.error) socket.emit('error_msg', result.error);
    scheduleAiTurn(session, 700);
    if (session.pendingAuction) scheduleAuctionBotBidding(session);
    scheduleTurnWatchdog(session);
  });

  socket.on('answer_quiz', ({ choiceIndex }) => {
    const sid = socket.data.sessionId;
    if (!sid) return socket.emit('error_msg', 'กรุณาเข้าร่วมเกมก่อน');
    const session = game.getOrCreateSession(sid);
    const result = game.answerQuestion(io, session, socket.id, choiceIndex);
    if (result.error) socket.emit('error_msg', result.error);
    scheduleAiTurn(session, 700);
    scheduleTurnWatchdog(session);
  });

  socket.on('disconnect', () => {
    const sid = socket.data.sessionId;
    if (!sid) return;
    const session = game.getOrCreateSession(sid);
    game.removePlayerBySocket(session, socket.id);
    io.to(sid).emit('state_update', game.publicState(session));
    scheduleTurnWatchdog(session);
  });
});

server.listen(PORT, () => {
  console.log(`Board API + Realtime running: http://localhost:${PORT}`);
  console.log(`Admin panel:                  http://localhost:${PORT}/admin.html`);
  console.log(`Play (real-time game):        http://localhost:${PORT}/play.html`);
  console.log(`CORS cross-origin:            ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'ปิด (same-origin เท่านั้น)'}`);
});
