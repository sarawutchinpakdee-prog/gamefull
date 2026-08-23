const { getCells, getCellTypes, getQuizCards, getAngelCards, getGameSettings, addGameHistory } = require('./store');

const BOARD_ID = 'default';
const PLAYER_COLORS = ['#3B82F6', '#EF4444', '#22C55E', '#F5B841', '#A855F7', '#EC4899'];
const STEP_DELAY_MS = 200;
const MAX_CELL_CHAIN = 24;
// เงินเริ่มต้น, โบนัสผ่าน START, จำนวนตาสูงสุด และเวลาประมูล แก้ได้จากหน้าแอดมิน
// (data/settings.json ผ่าน getGameSettings()) ไม่ใช่ค่าคงที่ในโค้ดอีกต่อไป

// sessionId -> session state (ทั้งหมดอยู่ใน memory — เหมาะกับโต๊ะเกมสั้นๆ)
const sessions = new Map();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function createSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      boardId: BOARD_ID,
      createdAt: Date.now(),
      // { playerKey, socketId, name, color, money, pos, connected }
      players: [],
      turnIndex: 0,
      isMoving: false,
      logs: [],
      // cellId -> playerKey ของเจ้าของที่ดินในห้องนี้
      properties: {},
      propertyUpgrades: {},
      pendingPurchase: null,
      pendingQuestion: null,
      pendingAuction: null,
      auctionQueue: [],
      turnCount: 0,
      gameStarted: false,
      winnerKey: null,
      winnerName: null,
      gameOver: false,
      mode: 'human',
      aiCount: 0,
      aiRunning: false,
    });
  }
  return sessions.get(sessionId);
}

function getOrCreateSession(sessionId) {
  return getSession(sessionId) || createSession(sessionId);
}

function listSessions() {
  return Array.from(sessions.values());
}

function deleteSession(sessionId) {
  return sessions.delete(sessionId);
}

// ใช้โดยแอดมินเพื่อไล่ผู้เล่น/บอทออกจากห้องแบบถาวร (ต่างจาก removePlayerBySocket
// ที่แค่ทำเครื่องหมายว่าหลุดการเชื่อมต่อ เพื่อรอง reconnect กลับมาเล่นต่อได้)
function kickPlayer(session, socketId) {
  const index = session.players.findIndex(p => p.socketId === socketId);
  if (index === -1) return null;
  const wasCurrentTurn = index === session.turnIndex;
  const [removed] = session.players.splice(index, 1);

  if (session.pendingPurchase?.playerKey === removed.playerKey) session.pendingPurchase = null;
  if (session.pendingQuestion?.playerKey === removed.playerKey) session.pendingQuestion = null;
  for (const [cellId, ownerKey] of Object.entries(session.properties)) {
    if (ownerKey === removed.playerKey) {
      delete session.properties[cellId];
      delete session.propertyUpgrades[cellId];
    }
  }

  if (index < session.turnIndex) session.turnIndex -= 1;
  if (session.turnIndex >= session.players.length) session.turnIndex = 0;
  if (wasCurrentTurn && !session.gameOver && session.players.length) {
    const cur = session.players[session.turnIndex];
    if (!cur || !cur.connected || cur.bankrupt) advanceTurn(session);
  }
  session.aiCount = session.players.filter(p => p.isBot).length;
  return removed;
}

// ใช้โดยแอดมินเพื่อปรับเงินผู้เล่นกลางเกม (เช่น แก้บั๊ก/ชดเชยปัญหาเทคนิค) — ไม่แตะสถานะ
// ล้มละลาย เพราะนั่นผูกกับ flow การเล่น (จ่ายหนี้ไม่ไหว) ไม่ใช่แค่จำนวนเงินในกระเป๋า
function adjustPlayerMoney(session, socketId, delta) {
  const player = session.players.find(p => p.socketId === socketId);
  if (!player) return null;
  player.money = Math.max(0, (Number(player.money) || 0) + Number(delta));
  return player;
}

function publicState(session) {
  const turn = currentPlayer(session);
  const { maxRounds } = getGameSettings();
  return {
    sessionId: session.id,
    boardId: session.boardId,
    players: session.players.map(p => ({
      id: p.socketId,
      playerKey: p.playerKey,
      name: p.name,
      color: p.color,
      money: p.money,
      pos: p.pos,
      connected: p.connected,
      bankrupt: !!p.bankrupt,
      properties: Object.entries(session.properties)
        .filter(([, ownerKey]) => ownerKey === p.playerKey)
        .map(([cellId]) => cellId),
    })),
    scoreboard: session.players.map(p => {
      const total = netWorth(session, p);
      const money = Number(p.money) || 0;
      return { id: p.socketId, name: p.name, color: p.color, money, propertyValue: Math.max(0, total - money), total };
    }).sort((a, b) => b.total - a.total),
    turnPlayerId: turn ? turn.socketId : null,
    turnCount: session.turnCount,
    round: Math.min(maxRounds, Math.floor(session.turnCount / Math.max(session.players.filter(p => p.connected && !p.bankrupt).length, 1)) + 1),
    maxRounds,
    isMoving: session.isMoving,
    gameOver: session.gameOver,
    winnerId: session.winnerKey ? (session.players.find(p => p.playerKey === session.winnerKey)?.socketId || null) : null,
    winnerName: session.winnerName,

    pendingPurchase: session.pendingPurchase ? (() => {
      const cell = getCells(session.boardId).find(c => c.id === session.pendingPurchase.cellId);
      const buyer = session.players.find(p => p.playerKey === session.pendingPurchase.playerKey);
      if (!cell || !buyer) return null;
      return {
        cellId: cell.id,
        position: cell.position,
        name: cell.name,
        price: Number(cell.price) || 0,
        rent: Number(cell.rent_base) || 0,
        playerId: buyer.socketId,
      };
    })() : null,
    pendingAuction: publicAuction(session),
    currentQuestion: session.pendingQuestion ? (() => {
      const foundPlayer = session.players.find(p => p.playerKey === session.pendingQuestion.playerKey);
      console.log('📋 Quiz Player Lookup:', { playerKey: session.pendingQuestion.playerKey, foundPlayer: foundPlayer?.socketId, allPlayers: session.players.map(p => ({ playerKey: p.playerKey, socketId: p.socketId })) });
      return {
        id: session.pendingQuestion.id,
        question: session.pendingQuestion.question,
        choices: session.pendingQuestion.choices,
        playerId: foundPlayer?.socketId || null,
        penalty: session.pendingQuestion.penalty,
      };
    })() : null,
    properties: Object.entries(session.properties).map(([cellId, ownerKey]) => {
      const owner = session.players.find(p => p.playerKey === ownerKey);
      const cell = getCells(session.boardId).find(c => c.id === cellId);
      const level = Math.max(0, Math.min(1, Number(session.propertyUpgrades[cellId]) || 0));
      const baseRent = cell ? Math.max(0, Number(cell.rent_base) || 0) : 0;
      const rentMultiplier = [1, 1.5][level];
      return {
        cellId,
        position: cell ? cell.position : null,
        name: cell ? cell.name : null,
        price: cell ? Number(cell.price) || 0 : 0,
        baseRent,
        rent: Math.round(baseRent * rentMultiplier),
        level,
        maxLevel: 1,
        upgradeCost: level < 1 && cell ? Math.floor((Number(cell.price) || 0) * 0.5) : 0,
        ownerId: owner ? owner.socketId : null,
        ownerName: owner ? owner.name : null
      };
    }),
    logs: session.logs.slice(0, 20),
  };
}

function addLog(session, text) {
  session.logs.unshift({ text, at: Date.now() });
  session.logs = session.logs.slice(0, 30);
}

function addPlayer(session, socketId, name, playerKey) {
  // Join ซ้ำจาก socket เดิม: อย่าสร้างผู้เล่นเพิ่ม
  const sameSocket = session.players.find(p => p.socketId === socketId);
  if (sameSocket) {
    sameSocket.connected = true;
    if (name && name.trim()) sameSocket.name = name.trim().slice(0, 20);
    return sameSocket;
  }

  // Reconnect: ใช้ playerKey เดิมเพื่อเอาสถานะเดิมกลับมา ไม่สร้างผู้เล่นซ้ำ
  if (playerKey) {
    const existing = session.players.find(p => p.playerKey === playerKey);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      if (name && name.trim()) existing.name = name.trim().slice(0, 20);
      return existing;
    }
  }

  const color = PLAYER_COLORS[session.players.length % PLAYER_COLORS.length];
  const player = {
    playerKey: playerKey || `player-${socketId}`,
    socketId,
    name: (name || `ผู้เล่น ${session.players.length + 1}`).trim().slice(0, 20),
    color,
    money: getGameSettings().startMoney,
    pos: 1,
    connected: true,
    bankrupt: false,
    lastRoll: null,
    comboRolls: 0,
  };
  session.players.push(player);
  return player;
}

function addBot(session, name) {
  const botIndex = session.players.filter(p => p.isBot).length + 1;
  const color = PLAYER_COLORS[session.players.length % PLAYER_COLORS.length];
  const player = {
    playerKey: `bot-${session.id}-${botIndex}`,
    socketId: `bot-${session.id}-${botIndex}`,
    name: name || `AI ${botIndex}`,
    color,
    money: getGameSettings().startMoney,
    pos: 1,
    connected: true,
    bankrupt: false,
    isBot: true,
    lastRoll: null,
    comboRolls: 0,
  };
  session.players.push(player);
  session.aiCount = session.players.filter(p => p.isBot).length;
  return player;
}

function isBotPlayer(player) {
  return !!player?.isBot;
}

function chooseBotPurchase(session, player) {
  const pending = session.pendingPurchase;
  if (!pending || pending.playerKey !== player.playerKey) return false;
  const cell = getCells(session.boardId).find(c => c.id === pending.cellId);
  if (!cell) return false;
  const price = Math.max(0, Number(cell.price) || 0);
  // AI ซื้อเมื่อยังเหลือเงินอย่างน้อย 25% ของเงินตั้งต้นหลังซื้อ
  return price > 0 && player.money - price >= getGameSettings().startMoney * 0.25;
}

function botShouldPlay(session) {
  const p = currentPlayer(session);
  return !!(p && p.isBot && !session.gameOver && !session.isMoving);
}

function removePlayerBySocket(session, socketId) {
  const index = session.players.findIndex(pl => pl.socketId === socketId);
  if (index === -1) return null;

  const p = session.players[index];
  p.connected = false;

  if (session.pendingPurchase && session.pendingPurchase.playerKey === p.playerKey) {
    session.pendingPurchase = null;
  }
  if (session.pendingQuestion && session.pendingQuestion.playerKey === p.playerKey) {
    session.pendingQuestion = null;
  }

  // ถ้าคนที่หลุดเป็นเจ้าของเทิร์น ให้ข้ามไปหาคนที่ยังออนไลน์ทันที
  if (session.turnIndex === index && !session.isMoving && !session.gameOver) {
    advanceTurn(session);
  }
  return p;
}

function currentPlayer(session) {
  if (!session.players.length) return null;
  const indexed = session.players[session.turnIndex];
  if (indexed && indexed.connected && !indexed.bankrupt) return indexed;

  const activeIndex = session.players.findIndex(p => p.connected && !p.bankrupt);
  if (activeIndex === -1) return null;
  session.turnIndex = activeIndex;
  return session.players[activeIndex];
}

function advanceTurn(session) {
  if (!session.players.length) return;
  let next = session.turnIndex;
  for (let i = 0; i < session.players.length; i++) {
    next = (next + 1) % session.players.length;
    if (session.players[next].connected && !session.players[next].bankrupt) {
      session.turnIndex = next;
      return;
    }
  }
  // ไม่มีผู้เล่นที่ยังออนไลน์และยังเล่นอยู่: คง index เดิมไว้
}

// ใช้แทน advanceTurn() ตรงๆ ทุกจุดที่จบการตัดสินใจของผู้เล่นแล้วจะสลับตา (ซื้อ/ไม่ซื้อที่ดิน,
// ตอบคำถาม) — ถ้าผู้เล่นเพิ่งได้ "ตาพิเศษ" จากการทอยเลขซ้ำกับตาที่แล้ว (ดู handleRollDice)
// จะใช้ตาพิเศษนั้นแทนการสลับตาไปผู้เล่นคนถัดไป
function advanceTurnOrConsumeBonus(session, player) {
  if (player?.pendingBonusRoll) {
    player.pendingBonusRoll = false;
    return;
  }
  advanceTurn(session);
}

function getPropertyOwner(session, cellId) {
  const ownerKey = session.properties[cellId];
  return ownerKey ? session.players.find(p => p.playerKey === ownerKey) || null : null;
}

function endTurn(session) {
  session.pendingPurchase = null;
  advanceTurn(session);
}


function getActivePlayers(session) {
  return session.players.filter(p => p.connected && !p.bankrupt);
}

function netWorth(session, player) {
  const cells = getCells(session.boardId);
  const propertyValue = Object.entries(session.properties)
    .filter(([, ownerKey]) => ownerKey === player.playerKey)
    .reduce((sum, [cellId]) => {
      const cell = cells.find(c => c.id === cellId);
      return sum + (cell ? Math.max(0, Number(cell.price) || 0) : 0);
    }, 0);
  return (Number(player.money) || 0) + propertyValue;
}

// สร้างบันทึกประวัติเกม (ใช้ทั้งตอนจบเกมตามธรรมชาติ และตอนแอดมินสั่งปิดห้องกลางเกม)
function buildHistoryRecord(session, reason) {
  return {
    id: `${session.id}-${Date.now()}`,
    sessionId: session.id,
    startedAt: session.createdAt || null,
    endedAt: Date.now(),
    turnCount: session.turnCount || 0,
    reason,
    winnerName: session.winnerName || null,
    players: session.players.map(p => ({
      name: p.name,
      money: Number(p.money) || 0,
      total: netWorth(session, p),
      bankrupt: !!p.bankrupt,
      isBot: !!p.isBot,
    })),
  };
}

function checkWinCondition(io, session) {
  if (session.gameOver) return true;
  const active = getActivePlayers(session);
  // การ Disconnect เพียงอย่างเดียวไม่ทำให้เกมจบทันที
  // ต้องเหลือผู้เล่นที่ยังเล่นอยู่ 1 คน และผู้เล่นคนอื่นต้องล้มละลายทั้งหมด
  if (session.players.length < 2 || active.length !== 1) return false;

  const winner = active[0];
  const eliminated = session.players.filter(p => p.playerKey !== winner.playerKey);
  if (!eliminated.every(p => p.bankrupt)) return false;
  session.gameOver = true;
  session.winnerKey = winner.playerKey;
  session.winnerName = winner.name;
  session.pendingPurchase = null;
  addLog(session, `🏆 ${winner.name} ชนะเกม! ผู้เล่นคนอื่นล้มละลายหรือออกจากเกมหมดแล้ว`);
  io.to(session.id).emit('game_over', {
    winnerId: winner.socketId,
    winnerName: winner.name,
    reason: 'last_player_standing'
  });
  io.to(session.id).emit('gm_log', session.logs[0]);
  addGameHistory(buildHistoryRecord(session, 'last_player_standing'));
  return true;
}

// เงื่อนไขจบเกมสำรอง: ถ้าครบจำนวนตาสูงสุดแล้วยังไม่มีใครล้มละลายจนเหลือคนเดียว
// (เช่น เศรษฐกิจสมดุลเกินไป) ให้ผู้เล่นที่มีทรัพย์สินรวม (เงิน + ราคาที่ดิน) มากที่สุดชนะแทน
function checkTurnLimit(io, session) {
  if (session.gameOver) return false;
  const { maxRounds } = getGameSettings();
  const activeCount = Math.max(getActivePlayers(session).length, 1);
  const maxTurns = maxRounds * activeCount;
  if ((session.turnCount || 0) < maxTurns) return false;

  const active = getActivePlayers(session);
  if (!active.length) return false;

  const winner = active.reduce((best, p) => (netWorth(session, p) > netWorth(session, best) ? p : best), active[0]);
  session.gameOver = true;
  session.winnerKey = winner.playerKey;
  session.winnerName = winner.name;
  session.pendingPurchase = null;
  addLog(session, `🏆 ครบ ${maxRounds} รอบแล้ว — ${winner.name} ชนะเกมด้วยคะแนนรวม ฿${netWorth(session, winner).toLocaleString()}`);
  io.to(session.id).emit('game_over', {
    winnerId: winner.socketId,
    winnerName: winner.name,
    reason: 'turn_limit_richest'
  });
  io.to(session.id).emit('gm_log', session.logs[0]);
  addGameHistory(buildHistoryRecord(session, 'turn_limit_richest'));
  return true;
}

// creditorKey: ถ้าล้มละลายเพราะจ่ายค่าเช่าให้ผู้เล่นคนใดคนหนึ่งไม่ไหว ทรัพย์สินทั้งหมด
// จะตกเป็นของผู้เล่นคนนั้นแทนที่จะกลับเข้าธนาคารเฉยๆ (เหมือนเศรษฐีคลาสสิก) — ถ้าล้มละลาย
// จากภาษี/การ์ดทำโทษ/ไม่มีเจ้าหนี้เจาะจง ทรัพย์สินจะกลับเข้าธนาคารตามเดิม
function declareBankrupt(io, session, player, reason, creditorKey) {
  if (!player || player.bankrupt) return false;
  player.bankrupt = true;
  player.money = 0;

  const released = Object.entries(session.properties)
    .filter(([, ownerKey]) => ownerKey === player.playerKey)
    .map(([cellId]) => cellId);

  const creditor = creditorKey
    ? session.players.find(p => p.playerKey === creditorKey && p.connected && !p.bankrupt)
    : null;

  released.forEach(cellId => {
    if (creditor) {
      session.properties[cellId] = creditor.playerKey; // ระดับอัปเกรดเดิมยังคงอยู่
    } else {
      delete session.properties[cellId];
      delete session.propertyUpgrades[cellId];
    }
  });

  if (session.pendingPurchase?.playerKey === player.playerKey) {
    session.pendingPurchase = null;
  }

  const transferNote = creditor
    ? ` ทรัพย์สินทั้งหมดตกเป็นของ ${creditor.name} (เจ้าหนี้)`
    : ' ทรัพย์สินทั้งหมดกลับสู่ธนาคาร';
  addLog(session, `💥 ${player.name} ล้มละลาย${reason ? ` — ${reason}` : ''}${transferNote}`);
  io.to(session.id).emit('bankruptcy', {
    playerId: player.socketId,
    playerName: player.name,
    releasedProperties: released,
    creditorId: creditor ? creditor.socketId : null,
    creditorName: creditor ? creditor.name : null,
  });

  if (currentPlayer(session)?.playerKey === player.playerKey) {
    advanceTurn(session);
  }
  checkWinCondition(io, session);
  return true;
}

function checkBankruptcy(io, session, player, reason, creditorKey) {
  if (player && player.money <= 0) {
    return declareBankrupt(io, session, player, reason, creditorKey);
  }
  return false;
}

function sellProperty(io, session, socketId, cellId) {
  if (session.gameOver) return { error: 'เกมจบแล้ว' };
  const player = session.players.find(p => p.socketId === socketId);
  if (!player || player.bankrupt) return { error: 'ไม่พบผู้เล่นที่ยังเล่นอยู่' };

  const cell = getCells(session.boardId).find(c => c.id === cellId && c.type === 'PROPERTY');
  if (!cell) return { error: 'ไม่พบทรัพย์สินนี้' };
  if (session.properties[cell.id] !== player.playerKey) return { error: 'ทรัพย์สินนี้ไม่ใช่ของคุณ' };

  const originalPrice = Math.max(0, Number(cell.price) || 0);
  const sellPrice = Math.floor(originalPrice * 0.5);
  delete session.properties[cell.id];
  delete session.propertyUpgrades[cell.id];
  player.money += sellPrice;

  addLog(session, `🏷️ ${player.name} ขาย "${cell.name}" คืนธนาคาร ได้เงิน ${sellPrice.toLocaleString()} บาท`);
  io.to(session.id).emit('gm_log', session.logs[0]);
  io.to(session.id).emit('state_update', publicState(session));
  return { ok: true, amount: sellPrice };
}

function upgradeProperty(io, session, socketId, cellId) {
  if (session.gameOver) return { error: 'เกมจบแล้ว' };
  const player = session.players.find(p => p.socketId === socketId);
  if (!player || player.bankrupt) return { error: 'ไม่พบผู้เล่นที่ยังเล่นอยู่' };

  const cell = getCells(session.boardId).find(c => c.id === cellId && c.type === 'PROPERTY');
  if (!cell) return { error: 'ไม่พบทรัพย์สินนี้' };
  if (session.properties[cell.id] !== player.playerKey) return { error: 'ทรัพย์สินนี้ไม่ใช่ของคุณ' };

  const currentLevel = Math.max(0, Math.min(1, Number(session.propertyUpgrades[cell.id]) || 0));
  if (currentLevel >= 1) return { error: 'ทรัพย์สินนี้อัปเกรดถึงระดับสูงสุดแล้ว' };

  const basePrice = Math.max(0, Number(cell.price) || 0);
  const cost = Math.floor(basePrice * 0.5);
  if (player.money < cost) return { error: `เงินไม่พออัปเกรด ต้องใช้ ${cost.toLocaleString()} บาท` };

  const nextLevel = currentLevel + 1;
  player.money -= cost;
  session.propertyUpgrades[cell.id] = nextLevel;
  const baseRent = Math.max(0, Number(cell.rent_base) || 0);
  const rent = Math.round(baseRent * 1.5);

  addLog(session, `🏗️ ${player.name} อัปเกรด "${cell.name}" เป็น Lv.${nextLevel} ค่าใช้จ่าย ${cost.toLocaleString()} บาท — ค่าเช่าใหม่ ${rent.toLocaleString()} บาท`);
  io.to(session.id).emit('property_upgraded', {
    playerId: player.socketId,
    playerName: player.name,
    cellId: cell.id,
    level: nextLevel,
    cost,
    rent,
  });
  io.to(session.id).emit('gm_log', session.logs[0]);
  io.to(session.id).emit('state_update', publicState(session));
  return { ok: true, level: nextLevel, cost, rent };
}

function transferProperty(io, session, socketId, cellId, targetSocketId) {
  if (session.gameOver) return { error: 'เกมจบแล้ว' };
  const player = session.players.find(p => p.socketId === socketId);
  const target = session.players.find(p => p.socketId === targetSocketId);
  if (!player || player.bankrupt) return { error: 'ไม่พบผู้โอนหรือผู้โอนล้มละลายแล้ว' };
  if (!target || target.bankrupt || !target.connected) return { error: 'ผู้รับต้องเป็นผู้เล่นที่ยังออนไลน์และไม่ล้มละลาย' };
  if (player.playerKey === target.playerKey) return { error: 'ไม่สามารถโอนให้ตัวเองได้' };

  const cell = getCells(session.boardId).find(c => c.id === cellId && c.type === 'PROPERTY');
  if (!cell) return { error: 'ไม่พบทรัพย์สินนี้' };
  if (session.properties[cell.id] !== player.playerKey) return { error: 'ทรัพย์สินนี้ไม่ใช่ของคุณ' };

  session.properties[cell.id] = target.playerKey;
  addLog(session, `🤝 ${player.name} โอน "${cell.name}" ให้ ${target.name} ฟรี`);
  io.to(session.id).emit('gm_log', session.logs[0]);
  io.to(session.id).emit('state_update', publicState(session));
  return { ok: true };
}

function handlePropertyLanding(io, session, player, cell) {
  const isUnderAuction = session.pendingAuction?.cellId === cell.id
    || session.auctionQueue.some(q => q.cellId === cell.id);
  if (isUnderAuction) {
    addLog(session, `🔨 "${cell.name}" กำลังอยู่ระหว่างการประมูล กรุณารอผลก่อน`);
    return { action: 'end' };
  }

  const price = Math.max(0, Number(cell.price) || 0);
  const baseRent = Math.max(0, Number(cell.rent_base) || 0);
  const level = Math.max(0, Math.min(3, Number(session.propertyUpgrades[cell.id]) || 0));
  const rentMultiplier = [1, 1.5, 2.25, 3][level];
  const rent = Math.round(baseRent * rentMultiplier);
  const owner = getPropertyOwner(session, cell.id);

  if (owner && owner.playerKey === player.playerKey) {
    addLog(session, `🏠 ${player.name} มาถึง "${cell.name}" — เป็นทรัพย์สินของคุณ`);
    return { action: 'end' };
  }

  if (owner) {
    const actualRent = Math.min(rent, Math.max(0, player.money));
    player.money -= actualRent;
    owner.money += actualRent;
    addLog(session, `💸 ${player.name} จ่ายค่าเช่า ${actualRent.toLocaleString()} บาท ให้ ${owner.name} ที่ "${cell.name}"`);
    if (player.money <= 0) {
      checkBankruptcy(io, session, player, `ไม่มีเงินจ่ายค่าเช่าให้ ${owner.name} ที่ "${cell.name}"`, owner.playerKey);
      return { action: 'bankrupt' };
    }
    return { action: 'end' };
  }

  if (price <= 0) {
    addLog(session, `🏘️ "${cell.name}" ยังไม่มีราคา จึงซื้อไม่ได้`);
    return { action: 'end' };
  }

  if (player.money < price) {
    addLog(session, `💰 ${player.name} มีเงินไม่พอซื้อ "${cell.name}" (ต้องใช้ ${price.toLocaleString()} บาท) — จบตา`);
    return { action: 'end' };
  }

  session.pendingPurchase = { playerKey: player.playerKey, cellId: cell.id };
  io.to(session.id).emit('property_offer', {
    playerId: player.socketId,
    cellId: cell.id,
    position: cell.position,
    name: cell.name,
    price,
    rent,
  });
  addLog(session, `🏠 ${player.name} มาถึง "${cell.name}" — เลือกว่าจะซื้อในราคา ${price.toLocaleString()} บาทหรือไม่`);
  return { action: 'pending' };
}

function buyProperty(io, session, socketId) {
  const pending = session.pendingPurchase;
  if (!pending) return { error: 'ตอนนี้ไม่มีทรัพย์สินที่รอการซื้อ' };

  const player = session.players.find(p => p.socketId === socketId && p.playerKey === pending.playerKey);
  if (!player || !player.connected) return { error: 'ไม่พบผู้เล่นหรือผู้เล่นหลุดการเชื่อมต่อ' };
  if (currentPlayer(session)?.socketId !== socketId) return { error: 'ยังไม่ถึงตาของคุณ' };

  const cell = getCells(session.boardId).find(c => c.id === pending.cellId && c.type === 'PROPERTY');
  if (!cell) {
    session.pendingPurchase = null;
    advanceTurn(session);
    return { error: 'ไม่พบทรัพย์สินนี้' };
  }

  if (getPropertyOwner(session, cell.id)) {
    session.pendingPurchase = null;
    advanceTurn(session);
    return { error: 'ทรัพย์สินนี้มีเจ้าของแล้ว' };
  }

  const price = Math.max(0, Number(cell.price) || 0);
  if (player.money < price) return { error: 'เงินของคุณไม่พอซื้อทรัพย์สินนี้' };

  player.money -= price;
  session.properties[cell.id] = player.playerKey;
  session.pendingPurchase = null;
  addLog(session, `🛒 ${player.name} ซื้อ "${cell.name}" สำเร็จในราคา ${price.toLocaleString()} บาท`);
  advanceTurnOrConsumeBonus(session, player);
  io.to(session.id).emit('gm_log', session.logs[0]);
  io.to(session.id).emit('state_update', publicState(session));
  return { ok: true };
}

function skipPropertyPurchase(io, session, socketId) {
  const pending = session.pendingPurchase;
  if (!pending) return { error: 'ตอนนี้ไม่มีคำขอซื้อทรัพย์สิน' };
  if (pending.playerKey !== session.players.find(p => p.socketId === socketId)?.playerKey) return { error: 'ไม่ใช่คำขอซื้อของคุณ' };

  const player = session.players.find(p => p.socketId === socketId);
  session.pendingPurchase = null;
  addLog(session, `➡️ ${player.name} เลือกไม่ซื้อทรัพย์สิน — จบตา`);
  advanceTurnOrConsumeBonus(session, player);
  io.to(session.id).emit('gm_log', session.logs[0]);
  io.to(session.id).emit('state_update', publicState(session));
  return { ok: true };
}

// ---------- ระบบประมูลทรัพย์สินที่ถูกปฏิเสธซื้อ ----------

function publicAuction(session) {
  const auction = session.pendingAuction;
  if (!auction) return null;
  const bidder = auction.currentBidderKey
    ? session.players.find(p => p.playerKey === auction.currentBidderKey)
    : null;
  return {
    cellId: auction.cellId,
    cellName: auction.cellName,
    price: auction.price,
    minBid: auction.minBid,
    minIncrement: auction.minIncrement,
    currentBid: auction.currentBid,
    currentBidderId: bidder ? bidder.socketId : null,
    currentBidderName: bidder ? bidder.name : null,
    endsAt: auction.endsAt,
  };
}

// ถ้ามีการประมูลอื่นดำเนินอยู่แล้ว ให้ต่อคิวแทนที่จะประมูลพร้อมกัน (คงสถานะเดียวให้ง่าย)
function startAuction(io, session, cellId) {
  if (session.gameOver) return;
  if (session.pendingAuction) {
    if (session.pendingAuction.cellId !== cellId && !session.auctionQueue.some(q => q.cellId === cellId)) {
      session.auctionQueue.push({ cellId });
    }
    return;
  }

  const cell = getCells(session.boardId).find(c => c.id === cellId && c.type === 'PROPERTY');
  if (!cell) return;
  const price = Math.max(0, Number(cell.price) || 0);
  if (price <= 0) return;

  const auctionDurationMs = getGameSettings().auctionDurationSeconds * 1000;
  const minBid = Math.max(50, Math.floor(price * 0.1));
  const minIncrement = Math.max(50, Math.floor(price * 0.05));
  session.pendingAuction = {
    cellId: cell.id,
    cellName: cell.name,
    price,
    minBid,
    minIncrement,
    currentBid: 0,
    currentBidderKey: null,
    endsAt: Date.now() + auctionDurationMs,
  };

  addLog(session, `🔨 เปิดประมูล "${cell.name}" เริ่มต้นที่ ฿${minBid.toLocaleString()} (${Math.round(auctionDurationMs / 1000)} วินาที)`);
  io.to(session.id).emit('auction_start', publicAuction(session));
  io.to(session.id).emit('gm_log', session.logs[0]);

  setTimeout(() => resolveAuction(io, session, cell.id), auctionDurationMs);
}

function placeBid(io, session, socketId, amount) {
  const auction = session.pendingAuction;
  if (!auction) return { error: 'ตอนนี้ไม่มีการประมูล' };

  const player = session.players.find(p => p.socketId === socketId);
  if (!player || !player.connected || player.bankrupt) return { error: 'ไม่พบผู้เล่นที่ยังเล่นอยู่' };

  const bid = Math.floor(Number(amount));
  if (!Number.isFinite(bid)) return { error: 'จำนวนเงินไม่ถูกต้อง' };

  const minNext = auction.currentBid > 0 ? auction.currentBid + auction.minIncrement : auction.minBid;
  if (bid < minNext) return { error: `ต้องประมูลอย่างน้อย ฿${minNext.toLocaleString()}` };
  if (bid > player.money) return { error: 'เงินของคุณไม่พอสำหรับการประมูลนี้' };

  auction.currentBid = bid;
  auction.currentBidderKey = player.playerKey;
  addLog(session, `🔨 ${player.name} ประมูล "${auction.cellName}" ที่ ฿${bid.toLocaleString()}`);
  io.to(session.id).emit('auction_update', publicAuction(session));
  io.to(session.id).emit('gm_log', session.logs[0]);
  return { ok: true };
}

function resolveAuction(io, session, cellId) {
  const auction = session.pendingAuction;
  if (!auction || auction.cellId !== cellId) return; // ถูกจัดการไปแล้วหรือไม่ตรงกัน

  session.pendingAuction = null;

  if (session.gameOver) {
    // เกมจบไปก่อนที่จะประมูลเสร็จ — ไม่ต้องประมวลผลต่อ แต่ยังต้องเคลียร์คิวเพื่อไม่ให้ค้าง
    session.auctionQueue = [];
    return;
  }

  const cell = getCells(session.boardId).find(c => c.id === cellId);
  const winner = auction.currentBidderKey
    ? session.players.find(p => p.playerKey === auction.currentBidderKey)
    : null;

  if (cell && winner && winner.connected && !winner.bankrupt && winner.money >= auction.currentBid) {
    winner.money -= auction.currentBid;
    session.properties[cell.id] = winner.playerKey;
    addLog(session, `🔨 ${winner.name} ชนะประมูล "${cell.name}" ที่ ฿${auction.currentBid.toLocaleString()}`);
    io.to(session.id).emit('auction_end', {
      cellId: cell.id,
      winnerId: winner.socketId,
      winnerName: winner.name,
      amount: auction.currentBid,
    });
  } else {
    addLog(session, `📦 ไม่มีผู้เสนอราคาซื้อ "${cell ? cell.name : cellId}" ทรัพย์สินยังคงเป็นของธนาคาร`);
    io.to(session.id).emit('auction_end', { cellId, winnerId: null, amount: 0 });
  }

  io.to(session.id).emit('gm_log', session.logs[0]);
  io.to(session.id).emit('state_update', publicState(session));

  if (session.auctionQueue.length) {
    const next = session.auctionQueue.shift();
    startAuction(io, session, next.cellId);
  }
}

const EVENT_LINES = [
  { text: 'พบกระเป๋าเงินตกอยู่ริมทาง รับไป 500 บาท', amount: 500 },
  { text: 'รถติดหนักมาก แต่ไม่มีผลอะไรเป็นพิเศษ', amount: 0 },
  { text: 'ได้รับของขวัญวันเกิดจากเพื่อนบ้าน รับไป 1,200 บาท', amount: 1200 },
  { text: 'ทำของหายระหว่างทาง เสียเงิน 600 บาท', amount: -600 },
];

// การ์ดทำโทษ: คำถามความรู้ทั่วไปเกี่ยวกับจังหวัดร้อยเอ็ด
// คำถามระดับง่าย — ตอบผิดเสีย 500 บาท, ตอบถูกได้ 300 บาท

// การ์ดนางฟ้า: รางวัลเล็ก ๆ เน้นความสนุก ไม่ทำให้เกมเสียสมดุล
/**
 * เดินทีละช่อง — server เป็นผู้กำหนดตำแหน่งปลายทางทั้งหมด
 * คืนค่า true เมื่อผ่าน START เพื่อป้องกันการให้โบนัสซ้ำใน resolveCell
 */
async function moveSteps(io, session, player, steps) {
  const dir = steps > 0 ? 1 : -1;
  const total = Math.abs(steps);
  const { startBonus } = getGameSettings();
  let passedStart = false;

  for (let i = 0; i < total; i++) {
    let next = player.pos + dir;
    if (next > 24) {
      next = 1;
      passedStart = true;
      player.money += startBonus;
      addLog(session, `🎉 ${player.name} ผ่านจุด START! รับโบนัส ${startBonus.toLocaleString()} บาท`);
    }
    if (next < 1) {
      next = 24;
      passedStart = true;
      player.money += startBonus;
      addLog(session, `🎉 ${player.name} ผ่านจุด START ย้อนกลับ! รับโบนัส ${startBonus.toLocaleString()} บาท`);
    }

    player.pos = next;
    io.to(session.id).emit('player_moving', { playerId: player.socketId, pos: player.pos });
    io.to(session.id).emit('gm_log', session.logs[0] || null);
    await sleep(STEP_DELAY_MS);
  }
  return passedStart;
}

async function resolveCell(io, session, player, context = {}) {
  const cells = getCells(session.boardId);
  const cellTypes = getCellTypes();
  const visited = context.visited || new Set();
  const chainDepth = context.chainDepth || 0;

  if (chainDepth >= MAX_CELL_CHAIN) {
    addLog(session, `⚠️ หยุดเอฟเฟกต์ต่อเนื่องของ ${player.name} เพื่อป้องกันเกมวนไม่จบ`);
    io.to(session.id).emit('gm_log', session.logs[0]);
    return;
  }

  const cell = cells.find(c => c.position === player.pos);
  if (!cell) return;

  // ป้องกัน FORWARD/BACKWARD/TELEPORT วนกลับมาที่ช่องเดิม
  if (visited.has(cell.position)) {
    addLog(session, `⚠️ เอฟเฟกต์ของช่อง "${cell.name}" วนซ้ำ จึงหยุดการประมวลผลเพื่อป้องกันเกมค้าง`);
    io.to(session.id).emit('gm_log', session.logs[0]);
    return;
  }
  visited.add(cell.position);

  const meta = cellTypes[cell.type] || {};

  switch (cell.type) {
    case 'START':
      // โบนัสถูกจ่ายใน moveSteps ตอนผ่านจาก 24 -> 1 แล้ว
      // ไม่จ่ายซ้ำที่นี่อีก
      addLog(session, `${player.name} หยุดที่ START`);
      break;

    case 'PROPERTY': {
      const result = handlePropertyLanding(io, session, player, cell);
      if (result.action === 'pending') {
        io.to(session.id).emit('gm_log', session.logs[0]);
        return;
      }
      break;
    }

    case 'EVENT': {
      // ช่องเหตุการณ์สุ่มได้ทั้งการ์ดทำโทษและการ์ดนางฟ้า — คลังการ์ดแก้ไขได้จากหน้าแอดมิน (data/cards.json)
      const quizCards = getQuizCards();
      const angelCards = getAngelCards();
      let drawAngel;
      if (angelCards.length && quizCards.length) drawAngel = Math.random() < 0.5;
      else if (angelCards.length) drawAngel = true;
      else if (quizCards.length) drawAngel = false;
      else {
        // แอดมินลบการ์ดออกจนหมด: ข้ามเอฟเฟกต์แทนที่จะให้เกมพัง
        addLog(session, `${player.name} หยุดที่ช่องเหตุการณ์ แต่ยังไม่มีการ์ดในระบบให้จั่ว`);
        io.to(session.id).emit('gm_log', session.logs[0]);
        break;
      }

      if (drawAngel) {
        const card = angelCards[Math.floor(Math.random() * angelCards.length)];
        player.money += Number(card.money || 0);
        let moved = 0;
        if (card.steps) {
          moved = Math.abs(Number(card.steps) || 0);
          await moveSteps(io, session, player, moved);
        }
        addLog(session, `😇 ${player.name} ได้การ์ดนางฟ้า “${card.title}” — ${card.text}${card.money ? ` รับเงิน ${Number(card.money).toLocaleString()} บาท` : ''}`);
        io.to(session.id).emit('angel_card', {
          playerId: player.socketId,
          playerName: player.name,
          title: card.title,
          text: card.text,
          icon: card.icon,
          money: Number(card.money || 0),
          steps: moved,
        });
      } else {
        const card = quizCards[Math.floor(Math.random() * quizCards.length)];
        session.pendingQuestion = {
          id: `roiet-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          playerKey: player.playerKey,
          question: card.q,
          choices: card.choices,
          answer: card.answer,
          penalty: 500,
        };
        addLog(session, `🃏 ${player.name} จั่วการ์ดทำโทษ — ตอบคำถามเกี่ยวกับจังหวัดร้อยเอ็ดให้ถูก!`);
        io.to(session.id).emit('quiz_card', {
          id: session.pendingQuestion.id,
          playerId: player.socketId,
          playerName: player.name,
          question: card.q,
          choices: card.choices,
          penalty: 500,
        });
      }
      break;
    }

    case 'TAX':
    case 'PENALTY':
      player.money += (cell.effect_value || 0);
      addLog(session, `${meta.icon || ''} ${player.name} ${cell.effect_value < 0 ? 'เสีย' : 'ได้'} ${Math.abs(cell.effect_value || 0).toLocaleString()} บาท ที่ "${cell.name}"`);
      break;

    case 'BONUS':
      player.money += (cell.effect_value || 0);
      addLog(session, `🎁 ${player.name} ได้รับโบนัส ${(cell.effect_value || 0).toLocaleString()} บาท`);
      break;

    case 'BANK':
      addLog(session, `🏦 ${player.name} แวะธนาคาร "${cell.name}"`);
      break;

    case 'INVESTMENT':
      addLog(session, `📈 ${player.name} ลงทุนที่ "${cell.name}"`);
      break;

    case 'JAIL':
      addLog(session, `🔒 ${player.name} แวะเยี่ยมชมคุก (ไม่ถูกจับ)`);
      break;

    case 'SPECIAL':
      addLog(session, `🅿️ ${player.name} จอดพักที่ "${cell.name}"`);
      break;

    case 'TELEPORT': {
      const others = cells.filter(c => c.position !== player.pos);
      if (!others.length) break;
      const target = others[Math.floor(Math.random() * others.length)];
      addLog(session, `🌀 ${player.name} วาร์ปจาก "${cell.name}" ไปยัง "${target.name}"!`);
      player.pos = target.position;
      io.to(session.id).emit('player_moving', { playerId: player.socketId, pos: player.pos });
      io.to(session.id).emit('gm_log', session.logs[0]);
      await sleep(STEP_DELAY_MS);
      await resolveCell(io, session, player, { visited, chainDepth: chainDepth + 1 });
      return;
    }

    case 'FORWARD':
    case 'BACKWARD': {
      const steps = Number(cell.effect_steps) || 0;
      const label = cell.type === 'FORWARD' ? '⏩' : '⏪';
      const description = cell.type === 'FORWARD'
        ? `ได้เดินหน้าเพิ่ม ${Math.abs(steps)} ช่อง!`
        : `ต้องถอยหลัง ${Math.abs(steps)} ช่อง`;
      addLog(session, `${label} ${player.name} ${description}`);
      io.to(session.id).emit('gm_log', session.logs[0]);
      const passedStart = await moveSteps(io, session, player, cell.type === 'FORWARD' ? Math.abs(steps) : -Math.abs(steps));
      await resolveCell(io, session, player, { visited, chainDepth: chainDepth + 1, passedStart });
      return;
    }
  }
  checkBankruptcy(io, session, player, `เงินคงเหลือหมดหลังเหตุการณ์ที่ "${cell.name}"`);
  io.to(session.id).emit('gm_log', session.logs[0]);
}

function answerQuestion(io, session, socketId, choiceIndex) {
  const pending = session.pendingQuestion;
  if (!pending) return { error: 'ตอนนี้ไม่มีการ์ดคำถาม' };
  const player = session.players.find(p => p.socketId === socketId && p.playerKey === pending.playerKey);
  if (!player || !player.connected || player.bankrupt) return { error: 'ไม่พบผู้เล่นที่กำลังตอบคำถาม' };
  if (currentPlayer(session)?.playerKey !== player.playerKey) return { error: 'ยังไม่ถึงตาของคุณ' };

  const choice = Number(choiceIndex);
  if (!Number.isInteger(choice) || choice < 0 || choice >= pending.choices.length) {
    return { error: 'คำตอบไม่ถูกต้อง' };
  }

  const correct = choice === pending.answer;
  if (correct) {
    const reward = 300;
    player.money += reward;
    addLog(session, `🎓 ${player.name} ตอบถูก! ได้รับรางวัล ${reward.toLocaleString()} บาท`);
  } else {
    const penalty = Math.min(pending.penalty, Math.max(0, player.money));
    player.money -= penalty;
    addLog(session, `🃏 ${player.name} ตอบผิด — การ์ดทำโทษหักเงิน ${penalty.toLocaleString()} บาท`);
  }

  session.pendingQuestion = null;
  io.to(session.id).emit('quiz_result', {
    playerId: player.socketId,
    playerName: player.name,
    correct,
    correctIndex: pending.answer,
    reward: correct ? 300 : 0,
    penalty: correct ? 0 : pending.penalty,
  });

  checkBankruptcy(io, session, player, 'ตอบการ์ดทำโทษผิดและเงินคงเหลือไม่พอ');
  if (!session.gameOver && !player.bankrupt && currentPlayer(session)?.playerKey === player.playerKey) {
    advanceTurnOrConsumeBonus(session, player);
  }
  checkWinCondition(io, session);
  io.to(session.id).emit('gm_log', session.logs[0]);
  io.to(session.id).emit('state_update', publicState(session));
  return { ok: true, correct };
}

async function handleRollDice(io, session, socketId) {
  const player = currentPlayer(session);
  if (!player) return { error: 'ยังไม่มีผู้เล่นในโต๊ะนี้' };
  if (session.gameOver) return { error: 'เกมจบแล้ว' };
  if (player.bankrupt) { advanceTurn(session); return { error: 'คุณล้มละลายแล้ว' }; }
  if (player.money <= 0) {
    declareBankrupt(io, session, player, 'เงินเริ่มต้น/คงเหลือเป็นศูนย์ก่อนเริ่มตา');
    io.to(session.id).emit('state_update', publicState(session));
    return { error: 'คุณล้มละลายแล้ว' };
  }
  if (!player.connected) {
    advanceTurn(session);
    return { error: 'ผู้เล่นเดิมหลุดการเชื่อมต่อ ระบบข้ามตาให้แล้ว' };
  }
  if (player.socketId !== socketId) return { error: 'ยังไม่ถึงตาของคุณ' };
  if (session.isMoving) return { error: 'กำลังประมวลผลตาก่อนหน้าอยู่ กรุณารอสักครู่' };
  if (session.pendingQuestion?.playerKey === player.playerKey) return { error: 'กรุณาตอบการ์ดคำถามก่อนจบตา' };
  // ห้องผู้เล่นจริงล้วนต้องมีอย่างน้อย 2 คนถึงจะเริ่มเกมได้ (เงื่อนไขชนะต้องมีคู่แข่ง)
  // ห้อง AI ไม่ติดเงื่อนไขนี้เพราะมีบอทเข้าร่วมอยู่แล้วตั้งแต่สร้างโต๊ะ
  const minPlayers = session.mode === 'human' ? 2 : 1;
  if (session.players.filter(p => p.connected).length < minPlayers) {
    return { error: minPlayers > 1 ? 'ต้องมีผู้เล่นอย่างน้อย 2 คนก่อนเริ่มเกม กรุณารอเพื่อนเข้าร่วมห้อง' : 'ต้องมีผู้เล่นอย่างน้อย 1 คน' };
  }

  session.isMoving = true;
  session.gameStarted = true;
  session.turnCount = (session.turnCount || 0) + 1;
  try {
    const previousRoll = player.lastRoll;
    const diceOne = 1 + Math.floor(Math.random() * 6);
    const diceTwo = 1 + Math.floor(Math.random() * 6);
    const result = diceOne + diceTwo;
    player.lastRoll = result;
    io.to(session.id).emit('dice_result', { playerId: player.socketId, value: result, diceValues: [diceOne, diceTwo] });
    addLog(session, `🎲 ${player.name} ทอยได้ ${diceOne} + ${diceTwo} = ${result} แต้ม`);
    io.to(session.id).emit('gm_log', session.logs[0]);
    io.to(session.id).emit('state_update', publicState(session));

    await sleep(250);
    await moveSteps(io, session, player, result);
    await resolveCell(io, session, player);

    // ทอยได้เลขซ้ำกับตาที่แล้วของตัวเอง (เช่นเดียวกับผู้เล่นอื่นสลับกันทอย โอกาสน้อยกว่า
    // "ทอยเบิ้ล" ของเศรษฐีต้นฉบับที่ใช้ 2 ลูกเต๋า) ให้ทอยพิเศษอีกครั้งทันทีโดยไม่สลับตา
    // จำกัดไว้ไม่เกิน 3 ตาติดกันกันเทิร์นค้างนาน (เกมนี้ใช้ลูกเต๋าเดียว จึงไม่ใช่กฎ doubles แท้)
    const isRepeatRoll = previousRoll !== null && previousRoll === result;
    player.comboRolls = isRepeatRoll ? (player.comboRolls || 0) + 1 : 0;
    const grantsBonusTurn = false;
    // เก็บสถานะ "ตาพิเศษ" ไว้ที่ตัวผู้เล่นเอง เพราะจุดที่จบเทิร์นจริงๆ อาจไม่ใช่ตรงนี้
    // (เช่น ยังรอซื้อที่ดินหรือตอบการ์ดคำถามอยู่ ต้องรอ buyProperty/skipPropertyPurchase/
    // answerQuestion เป็นผู้ตัดสินใจสลับตาแทน — ดู advanceTurnOrConsumeBonus)
    player.pendingBonusRoll = grantsBonusTurn;
    if (grantsBonusTurn) {
      addLog(session, `🎯 ${player.name} ทอยได้ ${result} แต้มซ้ำกับตาที่แล้ว! ได้ทอยพิเศษอีกครั้ง`);
      io.to(session.id).emit('gm_log', session.logs[0]);
    }

    // PROPERTY ที่ยังรอการตัดสินใจซื้อ หรือการ์ดคำถามที่ยังไม่ตอบ จะค้างเทิร์นไว้จนกว่าจะจบ
    // ถ้าผู้เล่นล้มละลาย resolveCell/declareBankrupt จะเลื่อนเทิร์นให้แล้ว
    // จึงเลื่อนเทิร์นซ้ำเฉพาะกรณีที่ผู้เล่นคนเดิมยังเป็นเจ้าของเทิร์นอยู่ และไม่มีอะไรค้างให้ตัดสินใจ
    if (!session.pendingPurchase && !session.pendingQuestion && !session.gameOver && currentPlayer(session)?.playerKey === player.playerKey && !player.bankrupt) {
      advanceTurnOrConsumeBonus(session, player);
    }
    checkWinCondition(io, session);
    checkTurnLimit(io, session);
    return { ok: true };
  } finally {
    session.isMoving = false;
    io.to(session.id).emit('state_update', publicState(session));
  }
}

module.exports = {
  getSession, createSession, getOrCreateSession, listSessions, deleteSession, kickPlayer, publicState, addPlayer, removePlayerBySocket,
  buildHistoryRecord, adjustPlayerMoney,
  handleRollDice, answerQuestion, buyProperty, skipPropertyPurchase, sellProperty, upgradeProperty, transferProperty,
  addLog, currentPlayer, advanceTurn, addBot, isBotPlayer, chooseBotPurchase, botShouldPlay, placeBid,
};
