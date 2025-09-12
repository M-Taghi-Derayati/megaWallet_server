import {PrismaClient} from '@prisma/client';
import axios from 'axios';
import {BlockchainRegistry} from '../config/BlockchainRegistry';
import {UtxoTradeExecutionService} from '../services/UtxoTradeExecutionService';
import { getWebSocketManager } from '../websocket/WebSocketManager';

const prisma = new PrismaClient();

// یک نمونه از سرویس اجرا می‌سازیم تا Worker بتواند آن را فراخوانی کند
const utxoTradeExecutionService = new UtxoTradeExecutionService();

export class DepositMonitorWorker {
    private blockchainRegistry: BlockchainRegistry;
    private intervalId: NodeJS.Timeout | null = null;
    private isChecking: boolean = false; // یک قفل ساده برای جلوگیری از اجرای همزمان
    private readonly CHECK_INTERVAL_MS = 60 * 1000; // هر ۶۰ ثانیه
    private readonly REQUIRED_CONFIRMATIONS = 1; // تعداد تاییدهای لازم

    constructor() {
        this.blockchainRegistry = new BlockchainRegistry();
    }


    /**
     * Worker را شروع می‌کند.
     */
    public start(): void {
        console.log(`✅ Bitcoin Deposit Monitor Worker started. Checking every ${this.CHECK_INTERVAL_MS / 1000} seconds.`);
        // برای اینکه در همان ابتدای راه‌اندازی، یک بار چک کند
        this.checkPendingDeposits();

        this.intervalId = setInterval(() => {
            this.checkPendingDeposits();
        }, this.CHECK_INTERVAL_MS);
    }

    /**
     * Worker را متوقف می‌کند.
     */
    public stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            console.log('⏹️ Bitcoin Deposit Monitor Worker stopped.');
        }
    }

    /**
     * تابع اصلی که به صورت دوره‌ای اجرا می‌شود.
     */
    private async checkPendingDeposits(): Promise<void> {
        if (this.isChecking) {
            console.log('[Monitor] A check is already in progress. Skipping this run.');
            return;
        }
        this.isChecking = true;
        console.log('[Monitor] Checking for pending Bitcoin deposits...');

        try {
            const pendingAddresses = await prisma.bitcoinDepositAddress.findMany({
                where: {status: 'PENDING_DEPOSIT'},
                include: {quote: true} // اطلاعات Quote را هم می‌گیریم
            });

            if (pendingAddresses.length === 0) {
                console.log('[Monitor] No pending addresses found.');
                return;
            }

            console.log(`[Monitor] Found ${pendingAddresses.length} pending addresses to check.`);

            // آدرس‌ها را بر اساس شبکه گروه‌بندی می‌کنیم تا از اکسپلورر صحیح استفاده کنیم
            const addressesByNetwork = this.groupAddressesByNetwork(pendingAddresses);

            for (const [networkId, addresses] of Object.entries(addressesByNetwork)) {
                for (const addr of addresses) {
                    await this.processAddress(addr);
                }
            }

        } catch (dbError) {
            console.error('[Monitor] Database error while fetching pending addresses:', dbError);
        } finally {
            this.isChecking = false; // در هر صورت، قفل را باز می‌کنیم
        }
    }

    /**
     * یک آدرس خاص را برای یافتن واریز پردازش می‌کند.
     */
    private async processAddress(addr: any): Promise<void> {
        try {
            const networkConfig = this.blockchainRegistry.getNetworkById(addr.quote.fromNetworkId);
            const explorerUrl = networkConfig?.explorers[0];
            if (!explorerUrl) return;

            const {data: transactions} = await axios.get(`${explorerUrl}address/${addr.address}/txs`);

            if (transactions && transactions.length > 0) {
                for (const tx of transactions) {
                    // چک می‌کنیم که تراکنش حداقل تعداد تاییدهای لازم را داشته باشد
                    if (tx.status.confirmed && (tx.confirmations || 1) >= this.REQUIRED_CONFIRMATIONS) {

                        const receivedAmountSatoshi = this.calculateReceivedAmount(tx, addr.address);

                        if (receivedAmountSatoshi > 0) {
                            console.log(`[Monitor] ✅ CONFIRMED deposit of ${receivedAmountSatoshi} sats found for address ${addr.address}! TxHash: ${tx.txid}`);

                            getWebSocketManager().broadcast({
                                type: 'DEPOSIT_CONFIRMED',
                                quoteId: addr.quoteId,
                                txHash: tx.txid,
                                amount: receivedAmountSatoshi
                            });


                            // وضعیت را در دیتابیس آپدیت می‌کنیم
                            await prisma.bitcoinDepositAddress.update({
                                where: {id: addr.id},
                                data: {
                                    status: 'CONFIRMED',
                                    receivedTxHash: tx.txid,
                                    receivedAmount: receivedAmountSatoshi / 1e8, // تبدیل به BTC
                                },
                            });

                            // سرویس اجرای معامله را فراخوانی می‌کنیم
                            // اینجا دیگر نیازی به await نیست، چون می‌خواهیم Worker به کار خود ادامه دهد
                            await utxoTradeExecutionService.initiateSwap(addr.quoteId, receivedAmountSatoshi / 1e8);

                            return; // از پردازش بیشتر این آدرس خارج می‌شویم
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`[Monitor] Error checking address ${addr.address}:`, (error as any).message);
        }
    }

    /**
     * آدرس‌ها را بر اساس شناسه شبکه مبدا گروه‌بندی می‌کند.
     */
    private groupAddressesByNetwork(addresses: any[]): { [key: string]: any[] } {
        return addresses.reduce((acc, addr) => {
            const networkId = addr.quote.fromNetworkId;
            if (!acc[networkId]) {
                acc[networkId] = [];
            }
            acc[networkId].push(addr);
            return acc;
        }, {});
    }

    /**
     * مقدار دقیق دریافت شده به یک آدرس خاص را در یک تراکنش محاسبه می‌کند.
     */
    private calculateReceivedAmount(tx: any, myAddress: string): number {
        let totalValue = 0;
        for (const output of tx.vout) {
            if (output.scriptpubkey_address === myAddress) {
                totalValue += output.value;
            }
        }
        return totalValue;
    }
}