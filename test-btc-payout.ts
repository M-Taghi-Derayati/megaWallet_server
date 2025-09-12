import dotenv from 'dotenv';
dotenv.config();

import { BitcoinPayoutService } from './src/services/BitcoinPayoutService';
import { BlockchainRegistry } from './src/config/BlockchainRegistry';

// --- پارامترهای تست را اینجا تنظیم کنید ---
const RECIPIENT_ADDRESS = "tb1q4hmfxjy9zkm7rxwklskqfeqe6k5qgnkc7tm8vc"; // <<<--- آدرس بیت‌کوین تست‌نت گیرنده را اینجا وارد کنید
const AMOUNT_TO_SEND_BTC = 0.0001;     // <<<--- مقداری که می‌خواهید ارسال کنید
// -----------------------------------------

/**
 * این تابع اصلی اسکریپت است که فرآیند را "دور می‌زند".
 */
async function testPayout() {
    console.log("--- Bitcoin Payout Test Script ---");

    if ( !RECIPIENT_ADDRESS) {
        console.error("❌ ERROR: Please set a valid RECIPIENT_ADDRESS in the script.");
        return;
    }

    console.log(`Attempting to send ${AMOUNT_TO_SEND_BTC} BTC to ${RECIPIENT_ADDRESS}`);
    console.log("Initializing services...");

    try {
        // ۱. راه‌اندازی سرویس‌های لازم
        const registry = new BlockchainRegistry();
        const payoutService = new BitcoinPayoutService(registry);

        // ۲. فراخوانی مستقیم تابع sendBitcoin
        console.log("Calling sendBitcoin service...");
        const txId = await payoutService.sendBitcoin(RECIPIENT_ADDRESS, AMOUNT_TO_SEND_BTC);

        // ۳. نمایش نتیجه موفقیت‌آمیز
        console.log("\n✅✅✅ PAYOUT SUCCESSFUL! ✅✅✅");
        console.log("-------------------------------------");
        console.log(`Transaction ID (TxID): ${txId}`);
        console.log(`View on Mempool: https://mempool.space/testnet/tx/${txId}`);
        console.log("-------------------------------------");

    } catch (error: any) {
        // ۴. نمایش خطای دقیق در صورت شکست
        console.error("\n❌❌❌ PAYOUT FAILED! ❌❌❌");
        console.error("-------------------------------------");
        console.error("Error Message:", error.message);
        console.error("-------------------------------------");
    }
}

testPayout();