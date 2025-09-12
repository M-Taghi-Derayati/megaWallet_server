import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { initializeWebSocket } from './websocket/WebSocketManager';
import swapRoutes from './api/v1/swap.routes';
import { DepositMonitorWorker } from './worker/DepositMonitorWorker';


const app = express();
const port =  3000;

// --- ۱. تعریف Middlewares و Routes ---
app.use(express.json());
app.use('/api/v1/swap', swapRoutes);

// یک مسیر ریشه ساده برای تست سلامت سرور HTTP
app.get('/', (req, res) => {
    res.send('MegaWallet Server is running!');
});

// --- ۲. ساخت سرور HTTP از اپلیکیشن Express ---
const server = createServer(app);

// --- ۳. راه‌اندازی و اتصال سرور WebSocket به سرور HTTP ---
// این کار باید "قبل" از server.listen() انجام شود.
initializeWebSocket(server);

// --- ۴. راه‌اندازی سرور برای گوش دادن به درخواست‌ها ---
server.listen(port,"0.0.0.0",undefined,() => {
    console.log(`🚀 Server (HTTP & WS) is running at http://localhost:${port}`);

    // --- ۵. شروع Worker ها "بعد" از اینکه سرور با موفقیت راه‌اندازی شد ---
    try {
        const monitorWorker = new DepositMonitorWorker();
        monitorWorker.start();

        // const consolidationWorker = new ConsolidationWorker();
        // consolidationWorker.start();
    } catch(error) {
        console.error("❌ Failed to start background workers:", error);
    }
});