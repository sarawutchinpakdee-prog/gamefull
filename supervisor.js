// รัน server.js เป็น child process และรีสตาร์ทให้อัตโนมัติเมื่อ server.js
// exit ด้วยโค้ด 75 (คำขอรีสตาร์ทจากหน้า admin ผ่าน POST /api/admin/restart)
const { spawn } = require('child_process');

const RESTART_EXIT_CODE = 75;

function startServer() {
  const child = spawn(process.execPath, ['server.js'], { stdio: 'inherit' });

  child.on('exit', (code) => {
    if (code === RESTART_EXIT_CODE) {
      console.log('[supervisor] กำลังรีสตาร์ทเซิร์ฟเวอร์...');
      startServer();
    } else {
      process.exit(code ?? 0);
    }
  });
}

startServer();
