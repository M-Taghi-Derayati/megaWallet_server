import { PrismaClient, Quote } from '@prisma/client';
import { ethers, Contract, JsonRpcProvider } from 'ethers';
import { BlockchainRegistry, NetworkConfig } from '../config/BlockchainRegistry';
import { TradeExecutionService } from '../services/TradeExecutionService';
import PhoenixContractAbi from '../abi/phoenixAbi.json';

const prisma = new PrismaClient();
const registry = new BlockchainRegistry();
const tradeExecutor = new TradeExecutionService();

interface EventData {
    user: string;
    amount: bigint;
    quoteId: string; // bytes32 hex
    blockNumber: number;
    txHash: string;
}

export class EvmPollingWorker {
    private isChecking: boolean = false;
    // <<<--- کاهش فاصله زمانی برای تست سریع ---
    private readonly CHECK_INTERVAL_MS = 15 * 1000; // هر ۱۵ ثانیه

    // برای هر شبکه، آخرین بلاکی که چک کرده‌ایم را ذخیره می‌کنیم
    private lastCheckedBlock: Map<number, number> = new Map();

    public start(): void {
        console.log(`✅ EVM Polling Worker started. Checking every ${this.CHECK_INTERVAL_MS / 1000} seconds.`);
        this.pollForAllNetworks();
        setInterval(() => this.pollForAllNetworks(), this.CHECK_INTERVAL_MS);
    }

    private async pollForAllNetworks(): Promise<void> {
        if (this.isChecking) return;
        this.isChecking = true;

        try {
            const networksToPoll = registry.getNetworksByType("EVM");
            for (const network of networksToPoll) {
                if (network.chainId && network.phoenixContractAddress && network.rpcUrls[0]) {
                    await this.pollNetworkForEvents(network);
                }
            }
        } catch (error) {
            console.error('[EVM Poller] ❌ Critical error during polling cycle:', error);
        } finally {
            this.isChecking = false;
        }
    }

    /**
     * یک شبکه خاص را برای یافتن رویدادهای جدید اسکن می‌کند.
     */
    private async pollNetworkForEvents(network: NetworkConfig): Promise<void> {
        console.log(`[EVM Poller] Polling for events on ${network.name}...`);
        try {
            const provider = new JsonRpcProvider(network.rpcUrls[0]);
            const contract = new Contract(network.phoenixContractAddress!, PhoenixContractAbi, provider);

            const currentBlock = await provider.getBlockNumber();
            let fromBlock = this.lastCheckedBlock.get(network.chainId!) || (currentBlock - 10); // برای اولین اجرا، ۱۰ بلاک آخر را چک کن

            if (fromBlock >= currentBlock) {
                console.log(`[EVM Poller] No new blocks to check on ${network.name}.`);
                return;
            }

            // برای جلوگیری از فشار زیاد، در هر بار اجرا حداکثر ۱۰۰۰ بلاک را چک می‌کنیم
            const toBlock = Math.min(currentBlock, fromBlock + 100);

            const events = await contract.queryFilter("NativeTradeInitiated", fromBlock + 1, toBlock);

            if (events.length > 0) {
                console.log(`[EVM Poller] ❗️ Found ${events.length} new event(s) on ${network.name}!`);
                for (const event of events) {
                    const args = (event as any).args;
                    const eventData: EventData = {
                        user: args.user,
                        amount: args.amount,
                        quoteId: args.quoteId,
                        blockNumber: event.blockNumber,
                        txHash: event.transactionHash
                    };

                    // فرآیند را برای هر رویداد آغاز می‌کنیم
                    await tradeExecutor.executeNativeSwapFromEvent({
                        ...eventData,
                        networkId: network.id
                    });
                }
            }

            // آخرین بلاک چک شده را برای اجرای بعدی آپدیت می‌کنیم
            this.lastCheckedBlock.set(network.chainId!, toBlock);

        } catch (error) {
            console.error(`[EVM Poller] ❌ Error polling events on ${network.name}:`, error);
        }
    }
}